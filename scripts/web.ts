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

async function main(): Promise<void> {
  const { servicio, clinica, rag, dobles, modelo } = await montarNucleoDeDemostracion();

  const app = Fastify({ logger: false });

  // --- Estaticos. Lista blanca explicita: sin recorrido de rutas posible. ---
  const ESTATICOS = ['index.html', 'estilos.css', 'chat.js'] as const;
  for (const archivo of ESTATICOS) {
    const ruta = archivo === 'index.html' ? '/' : `/${archivo}`;
    const extension = archivo.slice(archivo.lastIndexOf('.'));
    app.get(ruta, async (_peticion, respuesta) => {
      const contenido = await readFile(join(DIR_WEB, archivo), 'utf8');
      return respuesta.type(TIPOS[extension] ?? 'text/plain').send(contenido);
    });
  }

  app.get('/api/estado', async () => ({
    clinica: clinica.nombre,
    modelo,
    fragmentos: rag.total,
    sedes: (clinica.config as Record<string, unknown>)['sedes_informativas'] ?? {},
  }));

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

        return {
          texto: turno.text,
          latenciaMs: turno.latencyMs,
          herramientas,
          escalamiento: turno.escalate
            ? { motivo: turno.escalate.reason, prioridad: turno.escalate.priority }
            : null,
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
