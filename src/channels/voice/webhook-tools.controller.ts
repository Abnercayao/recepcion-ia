/**
 * Las cinco herramientas de negocio, expuestas como *webhook tools* para un
 * agente de ElevenLabs que razona con un modelo ALOJADO por el proveedor.
 *
 * ------------------------------------------------------------------------
 * LO QUE ESTE ARCHIVO IMPLICA, DICHO SIN ADORNOS
 *
 * En el modo Custom LLM, el turno entero pasa por `ConversationService`: capa
 * 1 sobre la entrada, capa 3 de urgencia en paralelo, RAG, prompt maestro,
 * modelo, y **capa 2 bloqueante sobre la salida** antes de que una sola
 * palabra llegue al sintetizador.
 *
 * Con un modelo alojado, el razonamiento ocurre dentro de ElevenLabs y su
 * texto va directo a voz. **No existe hook de salida**: verificado contra su
 * documentacion de webhook tools y de system tools. Por tanto, en este modo:
 *
 *   - NO hay capa 2. Las lineas rojas dejan de ser un control y vuelven a ser
 *     una instruccion del prompt, que el modelo cumple o no.
 *   - NO hay clasificador de urgencia propio corriendo en paralelo. El
 *     protocolo depende de que el modelo lo siga.
 *   - El historial autoritativo pasa a ser el de ElevenLabs, no esta base
 *     (anti-patron 6), y con el se pierde la continuidad multicanal.
 *
 * LO QUE SI SOBREVIVE, y es la razon de que este archivo exista en vez de
 * exponer la base directamente:
 *
 *   - La validacion defensiva con Zod de CADA argumento, antes de ejecutar.
 *   - Las invariantes de estado: colision de agenda (C7), lista blanca de
 *     transferencia leida de la clinica y nunca del request (anti-patron 4),
 *     aislamiento por `clinic_id` en el RAG (C9).
 *   - El registro auditable en `tool_calls`.
 *   - El tope de invocaciones por conversacion.
 *
 * Es decir: el modelo puede decir lo que quiera, pero no puede HACER lo que
 * quiera. Es un control mas debil que el del modo Custom LLM, y es
 * deliberadamente el que queda.
 * ------------------------------------------------------------------------
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

import type {
  AuditRepository,
  ClinicRepository,
  Logger,
  ToolRegistry,
  TurnContext,
} from '../../core/types/index.js';
import type { MessageRouter } from '../../core/conversation/message.router.js';
import { TRAZA_NULA, type RecolectorDeTraza } from '../../core/observabilidad/traza.js';
import { maskPII } from '../../infra/pii-masker.js';

export const RUTA_WEBHOOK_TOOLS = '/v1/g/:secret/c/:clinicId/tools/:herramienta';

export interface WebhookToolsDeps {
  router: MessageRouter;
  tools: ToolRegistry;
  clinics: ClinicRepository;
  audit: AuditRepository;
  logger: Logger;
  /** El mismo `VOICE_GATEWAY_SECRET`: misma frontera, misma direccion. */
  gatewaySecret: string;
  /**
   * Instrumentacion. OPCIONAL, pero aqui es donde mas falta hace: en modo
   * alojado esto es lo UNICO que nuestro codigo llega a ver de una llamada de
   * voz. El razonamiento pasa dentro del proveedor y no deja rastro nuestro;
   * sin esto, el canal de voz es un agujero negro y solo se sabe que algo fue
   * mal cuando el paciente lo cuenta.
   */
  traza?: RecolectorDeTraza;
  /**
   * Aviso de cita creada, para que la confirmacion llegue al paciente.
   *
   * El agente cierra la llamada diciendo que le mandara los detalles por
   * WhatsApp. Eso solo es verdad si alguien los manda: el canal de WhatsApp
   * esta DESACTIVADO y sin credenciales, asi que hoy quien puede hacerlo es el
   * flujo de n8n. Esto es lo que le entrega los datos.
   *
   * Es OPCIONAL y no bloquea el turno: si falla, la cita ya esta creada y el
   * paciente ya la oyo confirmar. Se registra y se sigue.
   */
  avisarCitaCreada?: (aviso: AvisoDeCitaCreada) => Promise<void>;
}

/** Lo justo para que recepcion pueda confirmar la cita al paciente. */
export interface AvisoDeCitaCreada {
  conversationId: string;
  clinicId: string;
  clinicaNombre: string;
  telefonoPaciente: string;
  pacienteNombre?: string;
  sede?: string;
  inicio: string;
  fin: string;
  motivo: string;
  canal: string;
  creadaEn: string;
}

function cabecera(valor: string | string[] | undefined): string | undefined {
  return Array.isArray(valor) ? valor[0] : valor;
}

function iguales(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Mismas tres vias que el gateway: el proveedor no documenta que header manda. */
function autenticado(request: FastifyRequest, secreto: string): boolean {
  if (secreto === '') return false;
  const p = (request.params as { secret?: string } | undefined)?.secret;
  if (typeof p === 'string' && iguales(p, secreto)) return true;
  const propio = cabecera(request.headers['x-gateway-secret']);
  if (typeof propio === 'string' && iguales(propio, secreto)) return true;
  const auth = cabecera(request.headers.authorization);
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    if (iguales(auth.slice(7).trim(), secreto)) return true;
  }
  return false;
}

/** Telefono sintetico estable, igual que en el gateway: la web no trae numero. */
function telefonoSintetico(semilla: string): string {
  let h = 2166136261;
  for (let i = 0; i < semilla.length; i += 1) {
    h ^= semilla.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `+519${String(Math.abs(h) % 100000000).padStart(8, '0')}`;
}

export const webhookToolsPlugin: FastifyPluginAsync<WebhookToolsDeps> = async (app, deps) => {
  app.post(RUTA_WEBHOOK_TOOLS, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!autenticado(request, deps.gatewaySecret)) {
      deps.logger.warn({ componente: 'webhook-tools' }, 'peticion sin secreto valido: 401');
      return reply.code(401).send({ error: 'no autorizado' });
    }

    const { clinicId, herramienta } = request.params as {
      clinicId: string;
      herramienta: string;
    };

    const cuerpo = (request.body ?? {}) as Record<string, unknown>;

    /**
     * Una traza por webhook.
     *
     * En modo Custom LLM la unidad natural es el turno; aqui no la hay: el
     * turno vive dentro del proveedor. Lo que si se puede acotar es cada
     * llamada que nos hace, y eso es justo lo que faltaba por ver --que
     * webhook, con que argumentos y cuanto tardo la ida y vuelta completa--.
     * La sesion las agrupa en la interfaz.
     */
    const sesionCruda =
      typeof cuerpo['session_id'] === 'string' ? cuerpo['session_id'].trim() : '';
    const traza = (deps.traza ?? TRAZA_NULA).abrir({
      canal: 'voz (modo alojado)',
      entrada: `${herramienta}(${Object.keys(cuerpo).join(', ')})`,
      ...(sesionCruda ? { sesion: sesionCruda } : {}),
    });
    traza.identificar({ clinicId });

    const tool = deps.tools.get(herramienta);
    if (!tool) {
      traza.marcar('webhook', `herramienta desconocida: ${herramienta}`, 'error', {
        pedidaPorElModelo: herramienta,
        disponibles: deps.tools.toClaudeToolDefinitions().map((d) => d.name),
      });
      traza.cerrar('herramienta desconocida');
      // Se responde 200 con un error legible: el modelo debe poder leerlo y
      // corregir, no recibir un fallo de transporte que no sabe interpretar.
      return reply.code(200).send({ ok: false, error: `herramienta desconocida: ${herramienta}` });
    }

    const sesion =
      typeof cuerpo['session_id'] === 'string' && cuerpo['session_id'].trim() !== ''
        ? cuerpo['session_id'].trim()
        : `el-${clinicId.slice(0, 8)}`;
    const telefono =
      typeof cuerpo['phone'] === 'string' && cuerpo['phone'].trim() !== ''
        ? cuerpo['phone'].trim()
        : telefonoSintetico(sesion);

    // Los tres campos de encaminamiento no son argumentos de la herramienta.
    const argumentos = { ...cuerpo };
    delete argumentos['session_id'];
    delete argumentos['phone'];
    delete argumentos['clinic_id'];

    try {
      // `route` da paciente y conversacion reales: aunque el historial
      // autoritativo sea el del proveedor, lo que la herramienta ESCRIBA
      // queda atado a un paciente de esta base y es auditable.
      const medidorRuta = traza.iniciar('enrutado', 'resolver paciente y conversacion', {
        sesionRecibida: sesionCruda === '' ? '(no la mando el proveedor)' : sesionCruda,
        telefonoSintetico: typeof cuerpo['phone'] !== 'string' || cuerpo['phone'].trim() === '',
      });
      const ctx: TurnContext = await deps.router.route({
        clinicId,
        patientPhoneE164: telefono,
        text: '',
        channel: 'voice',
        receivedAt: new Date(),
        sessionId: sesion,
      });
      medidorRuta.fin({ detalle: { conversationId: ctx.conversationId } });
      traza.identificar({ conversationId: ctx.conversationId, clinicId });

      // Zod ANTES de ejecutar. Es la garantia que sobrevive al cambio de modo.
      const validados = tool.input.safeParse(argumentos);
      if (!validados.success) {
        const detalle = validados.error.issues
          .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
          .join('; ');
        deps.logger.warn(
          { componente: 'webhook-tools', herramienta, detalle },
          'argumentos invalidos: la herramienta no se ejecuta',
        );
        // Sin capa 2, la validacion Zod es de los pocos controles que quedan
        // en pie en este modo. Que rechace algo es informacion de primera.
        traza.marcar('webhook', 'Zod RECHAZA los argumentos: no se ejecuta', 'error', {
          herramienta,
          argumentosRecibidos: argumentos,
          detalle,
        });
        traza.cerrar(`argumentos invalidos: ${detalle}`);
        return reply.code(200).send({ ok: false, error: `argumentos invalidos: ${detalle}` });
      }

      const medidorTool = traza.iniciar('herramienta', herramienta, { argumentos: validados.data });
      const resultado = await tool.execute(validados.data, ctx);
      medidorTool.fin({
        estado: resultado.status === 'ok' ? 'ok' : 'error',
        detalle: {
          estadoDevuelto: resultado.status,
          latenciaInternaMs: resultado.latencyMs,
          resultado: resultado.data ?? null,
          error: resultado.error ?? null,
        },
      });

      deps.logger.info(
        {
          componente: 'webhook-tools',
          herramienta,
          estado: resultado.status,
          latenciaMs: resultado.latencyMs,
        },
        'herramienta ejecutada por el modelo alojado',
      );

      /**
       * Cita creada -> aviso para que le llegue al paciente.
       *
       * Sin esto, el cierre de llamada («le mando los detalles por WhatsApp»)
       * seria una promesa que nadie cumple. No se espera (`void`) ni se deja
       * que un fallo aqui tumbe la respuesta: la cita YA existe y el paciente
       * la esta oyendo confirmar.
       */
      if (herramienta === 'crear_cita' && resultado.status === 'ok' && deps.avisarCitaCreada) {
        const evento = (resultado.data as { evento?: Record<string, unknown> } | undefined)?.evento;
        const args = validados.data as Record<string, unknown>;
        void deps
          .avisarCitaCreada({
            conversationId: ctx.conversationId,
            clinicId,
            clinicaNombre: ctx.clinic.nombre,
            telefonoPaciente: ctx.patient.telefonoE164,
            ...(ctx.patient.nombre ? { pacienteNombre: ctx.patient.nombre } : {}),
            ...(typeof args['sede'] === 'string' ? { sede: args['sede'] } : {}),
            inicio: String((evento?.['start'] as Date | undefined)?.toISOString() ?? args['inicio']),
            fin: String((evento?.['end'] as Date | undefined)?.toISOString() ?? ''),
            motivo: String(args['motivo'] ?? 'Cita'),
            canal: 'voice',
            creadaEn: new Date().toISOString(),
          })
          .catch((e: unknown) => {
            deps.logger.error(
              { componente: 'webhook-tools', error: e instanceof Error ? e.message : String(e) },
              'la cita se creo pero NO se pudo avisar para la confirmacion al paciente',
            );
          });
      }

      traza.cerrar(
        resultado.status === 'ok'
          ? `ok · ${JSON.stringify(resultado.data ?? {}).slice(0, 300)}`
          : `error · ${resultado.error ?? 'sin detalle'}`,
      );

      return reply.code(200).send(
        resultado.status === 'ok'
          ? { ok: true, data: resultado.data }
          : { ok: false, error: resultado.error ?? 'la herramienta no pudo completarse' },
      );
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      deps.logger.error({ componente: 'webhook-tools', herramienta, error: mensaje }, 'fallo la herramienta');
      traza.marcar('webhook', 'la herramienta lanzo', 'error', { herramienta, error: mensaje });
      traza.cerrar('no se pudo completar la operacion');
      await deps.audit
        .log('herramienta_webhook_fallida', { herramienta, error: maskPII({ mensaje }) }, clinicId)
        .catch(() => undefined);
      // 200 otra vez, con el error dentro: que el modelo lo diga y derive, en
      // vez de que la llamada se caiga sin que el paciente entienda nada.
      return reply.code(200).send({ ok: false, error: 'no se pudo completar la operacion' });
    }
  });

  // Descubrimiento: facilita configurar las herramientas en el panel sin
  // copiar esquemas a mano y sin que se desincronicen del codigo.
  app.get('/v1/g/:secret/c/:clinicId/tools', async (request, reply) => {
    if (!autenticado(request, deps.gatewaySecret)) return reply.code(401).send({ error: 'no autorizado' });
    const { clinicId } = request.params as { clinicId: string };
    return {
      clinicId,
      correlacion: randomUUID(),
      herramientas: deps.tools.toClaudeToolDefinitions(),
    };
  });
};
