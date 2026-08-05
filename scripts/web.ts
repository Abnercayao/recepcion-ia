/**
 * Web local de la clinica, con el chat conectado al NUCLEO REAL.
 *
 * Sirve `web/` y expone un unico endpoint, `POST /api/chat`, que llama al mismo
 * `ConversationService` que usa la demo de terminal. El montaje esta en
 * `nucleo-demo.ts`: persistencia en memoria, RAG por coincidencia de palabras y
 * agenda simulada. El prompt, los tres controles y las cinco herramientas SI
 * son los reales.
 *
 * Esto NO es un tercer canal. `src/channels/` sigue teniendo dos —WhatsApp y
 * voz— y el nucleo no se entera de que existe esta pagina: el turno se envia
 * como canal `whatsapp`, que es el estilo de texto. Es un arnes de
 * demostracion, igual que `demo.ts`, no una superficie de produccion.
 *
 * La clave nunca llega al navegador: el modelo se invoca desde este proceso.
 *
 * Uso:  npm run demo:web
 */
import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';

import { formatearFechaHora } from '../src/core/claude/prompt.builder.js';
import { FaltaLaClaveError, montarNucleoDeDemostracion } from './nucleo-demo.js';

const RAIZ = resolve(import.meta.dirname, '..');
const DIR_WEB = join(RAIZ, 'web');
const PUERTO = Number(process.env['PUERTO_WEB'] ?? 4000);

/**
 * Cada pestana del navegador es un paciente distinto. El telefono se asigna
 * aqui y no lo elige el cliente: si lo eligiera, cualquiera podria leer la
 * conversacion de otro pasando su numero.
 */
const telefonoPorSesion = new Map<string, string>();
function telefonoDe(sesion: string): string {
  const existente = telefonoPorSesion.get(sesion);
  if (existente) return existente;
  // +51 9XXXXXXXX — movil peruano valido, dentro de un rango ficticio.
  const nuevo = `+5198${String(7000000 + telefonoPorSesion.size).slice(0, 7)}`;
  telefonoPorSesion.set(sesion, nuevo);
  return nuevo;
}

const TIPOS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Escalamientos recibidos, en memoria.
 *
 * El control O5 dice que el modo de fallo del sistema es la REVERSION A
 * OPERACION MANUAL, nunca el silencio. Eso exige que alguien reciba el aviso.
 * `NotificationClient` lo manda a `N8N_WEBHOOK_URL`, y sin esa variable la
 * herramienta `escalar_humano` devuelve error y nadie se entera.
 *
 * Esto es el destino de demostracion: recibe la carga, la guarda y la muestra
 * en /recepcion. NO sustituye a n8n en produccion —se pierde al reiniciar y no
 * avisa a ningun humano de verdad—, pero cierra el lazo y hace visible lo que
 * antes se perdia.
 */
const escalamientos: Array<Record<string, unknown> & { recibidoEn: string }> = [];
const MAX_ESCALAMIENTOS = 100;

/**
 * Trazas del canal de VOZ, que ocurren en OTRO proceso.
 *
 * La web corre en el puerto 4000 y el nucleo con el canal de voz en el 3000.
 * En modo alojado, ademas, la voz ni siquiera pasa por `ConversationService`:
 * el proveedor razona por su cuenta y lo unico que toca nuestro codigo son los
 * webhooks de las herramientas. Asi que sus trazas viven en el otro proceso.
 *
 * Se piden desde AQUI, por el servidor, y no desde el navegador: el endpoint
 * del 3000 esta protegido por `VOICE_GATEWAY_SECRET` y ese secreto no puede
 * bajar al cliente. De paso se evita el CORS entre los dos puertos.
 */
async function trazasDeVoz(): Promise<{ trazas: unknown[]; error?: string }> {
  const secreto = process.env['VOICE_GATEWAY_SECRET'];
  if (!secreto) return { trazas: [], error: 'sin VOICE_GATEWAY_SECRET: no se pueden pedir' };

  const base = process.env['URL_NUCLEO'] ?? 'http://127.0.0.1:3000';
  try {
    const r = await fetch(`${base}/v1/g/${secreto}/trazas`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return { trazas: [], error: `el nucleo respondio ${String(r.status)}` };
    const cuerpo = (await r.json()) as { trazas?: unknown[] };
    return { trazas: cuerpo.trazas ?? [] };
  } catch (e) {
    // Que el nucleo no este levantado es lo normal si solo se prueba el chat.
    // No es un error del turno: se dice y ya.
    return {
      trazas: [],
      error: `no responde ${base} (¿esta corriendo \`npm run dev\`?): ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function main(): Promise<void> {
  const { servicio, clinica, rag, dobles, modelo, trazas } = await montarNucleoDeDemostracion();

  const app = Fastify({ logger: false });

  // --- Estaticos. Lista blanca explicita: sin recorrido de rutas posible. ---
  const ESTATICOS = ['index.html', 'estilos.css', 'chat.js', 'recepcion.html'] as const;
  for (const archivo of ESTATICOS) {
    const ruta =
      archivo === 'index.html' ? '/' : archivo === 'recepcion.html' ? '/recepcion' : `/${archivo}`;
    const extension = archivo.slice(archivo.lastIndexOf('.'));
    app.get(ruta, async (_peticion, respuesta) => {
      const contenido = await readFile(join(DIR_WEB, archivo), 'utf8');
      return respuesta.type(TIPOS[extension] ?? 'text/plain').send(contenido);
    });
  }

  // --- Destino de las notificaciones de escalamiento (control O5) ----------
  app.post('/api/escalamientos', async (peticion, respuesta) => {
    const carga = (peticion.body ?? {}) as Record<string, unknown>;
    escalamientos.unshift({ ...carga, recibidoEn: new Date().toISOString() });
    if (escalamientos.length > MAX_ESCALAMIENTOS) escalamientos.length = MAX_ESCALAMIENTOS;

    console.log(
      `\n  [ESCALAMIENTO RECIBIDO] motivo=${String(carga['motivo'])} ` +
        `prioridad=${String(carga['prioridad'])} canal=${String(carga['canal'])}`,
    );
    return respuesta.code(200).send({ recibido: true });
  });

  app.get('/api/escalamientos', async () => ({ total: escalamientos.length, escalamientos }));

  app.get('/api/estado', async () => ({
    clinica: clinica.nombre,
    modelo,
    fragmentos: rag.total,
    sedes: (clinica.config as Record<string, unknown>)['sedes_informativas'] ?? {},
    /**
     * Fecha para el widget de voz.
     *
     * El agente alojado no sabe en que dia vive --su prompt se publica una vez
     * y no lleva fecha-- y la deducia de su entrenamiento: corria los dias.
     * El widget la manda como variable dinamica, y se calcula AQUI, en el
     * servidor y en la zona de la clinica, no con el reloj del visitante.
     */
    fechaYHora: formatearFechaHora(new Date(), clinica.timezone),
  }));

  /**
   * Todas las trazas: las de texto de este proceso y las de voz del nucleo.
   *
   * Es lo que hace que el panel sirva para diagnosticar de verdad. La voz es
   * el canal que peor se ve --corre en otro proceso y, en modo alojado, con
   * otro modelo-- y sin esto habria que leer dos consolas a la vez.
   */
  app.get('/api/trazas', async () => {
    const voz = await trazasDeVoz();
    return {
      texto: trazas.listar(40),
      voz: voz.trazas,
      // Se dice POR QUE no hay trazas de voz en vez de mostrar una lista
      // vacia, que se lee como "no ha pasado nada" cuando en realidad puede
      // ser que el nucleo no este levantado.
      vozError: voz.error ?? null,
    };
  });

  app.post<{ Body: { texto?: unknown; sesion?: unknown } }>(
    '/api/chat',
    async (peticion, respuesta) => {
      const texto = typeof peticion.body?.texto === 'string' ? peticion.body.texto.trim() : '';
      const sesion = typeof peticion.body?.sesion === 'string' ? peticion.body.sesion : '';

      if (texto.length === 0) return respuesta.code(400).send({ error: 'texto vacio' });
      if (sesion.length === 0) return respuesta.code(400).send({ error: 'falta la sesion' });
      if (texto.length > 2000) return respuesta.code(413).send({ error: 'mensaje demasiado largo' });

      // Las llamadas a herramientas se acumulan en el doble; para saber cuales
      // pertenecen a ESTE turno hay que marcar el corte antes de ejecutarlo.
      const antes = dobles.toolCalls.filas.length;

      try {
        const turno = await servicio.handleTurn({
          clinicId: clinica.id,
          patientPhoneE164: telefonoDe(sesion),
          text: texto,
          channel: 'whatsapp',
          receivedAt: new Date(),
        });

        const herramientas = dobles.toolCalls.filas
          .slice(antes)
          .map((l) => ({ nombre: l.herramienta, estado: l.estado }));

        // El arnes de la web usa dobles, asi que NO pasa por
        // `NotificationClient`: si no se notificase aqui, n8n solo veria los
        // escalamientos de voz y daria una impresion falsa de cobertura.
        if (turno.escalate) {
          const carga = {
            clinicaNombre: clinica.nombre,
            motivo: turno.escalate.reason,
            prioridad: turno.escalate.priority,
            resumenParaRecepcion: turno.escalate.summaryForAgent,
            telefonoPaciente: telefonoDe(sesion),
            canal: 'whatsapp',
            ocurridoEn: new Date().toISOString(),
          };

          escalamientos.unshift({ ...carga, recibidoEn: new Date().toISOString() });
          if (escalamientos.length > MAX_ESCALAMIENTOS) escalamientos.length = MAX_ESCALAMIENTOS;

          // Al mismo destino que usa el nucleo real. Sin await y sin romper el
          // turno: el paciente ya tiene su respuesta, y un fallo de la
          // notificacion no debe retrasarsela ni tumbarla.
          const destino = process.env['N8N_WEBHOOK_URL'];
          if (destino && !destino.includes('/api/escalamientos')) {
            void fetch(destino, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(carga),
              signal: AbortSignal.timeout(10_000),
            }).catch((e: unknown) => {
              console.error(
                '  [aviso] no se pudo notificar el escalamiento del chat:',
                e instanceof Error ? e.message : String(e),
              );
            });
          }
        }

        return {
          texto: turno.text,
          latenciaMs: turno.latencyMs,
          herramientas,
          escalamiento: turno.escalate
            ? { motivo: turno.escalate.reason, prioridad: turno.escalate.priority }
            : null,
          // La traza completa del turno: cada salto, su duracion y su detalle.
          // Se busca por conversacion, no "la ultima": con dos pestanas
          // abiertas la mas reciente puede ser la del otro paciente.
          traza: trazas.ultimaDe(turno.conversationId) ?? null,
        };
      } catch (error) {
        // Un fallo del turno no debe tumbar el servidor ni dejar la pagina en
        // blanco: el paciente tiene que ver algo y el motivo queda en consola.
        console.error('fallo el turno:', error instanceof Error ? error.message : String(error));
        return respuesta.code(502).send({
          error: 'No se pudo procesar el mensaje. Revisa la consola del servidor.',
        });
      }
    },
  );

  await app.listen({ port: PUERTO, host: '127.0.0.1' });

  console.log('\n' + '='.repeat(60));
  console.log(`  ${clinica.nombre} — web de demostracion`);
  console.log('='.repeat(60));
  console.log(`  http://localhost:${PUERTO}`);
  console.log(`  Modelo: ${modelo}`);
  console.log(`  Base de conocimiento: ${rag.total} fragmentos`);
  console.log('-'.repeat(60));
  console.log('  Datos FICTICIOS. Persistencia en memoria: al parar, se pierde.');
  console.log('  Ctrl+C para terminar.');
  console.log('='.repeat(60) + '\n');
}

main().catch((error: unknown) => {
  if (error instanceof FaltaLaClaveError) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
