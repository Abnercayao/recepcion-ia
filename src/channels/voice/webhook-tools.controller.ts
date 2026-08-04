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

    const tool = deps.tools.get(herramienta);
    if (!tool) {
      // Se responde 200 con un error legible: el modelo debe poder leerlo y
      // corregir, no recibir un fallo de transporte que no sabe interpretar.
      return reply.code(200).send({ ok: false, error: `herramienta desconocida: ${herramienta}` });
    }

    const cuerpo = (request.body ?? {}) as Record<string, unknown>;
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
      const ctx: TurnContext = await deps.router.route({
        clinicId,
        patientPhoneE164: telefono,
        text: '',
        channel: 'voice',
        receivedAt: new Date(),
        sessionId: sesion,
      });

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
        return reply.code(200).send({ ok: false, error: `argumentos invalidos: ${detalle}` });
      }

      const resultado = await tool.execute(validados.data, ctx);

      deps.logger.info(
        {
          componente: 'webhook-tools',
          herramienta,
          estado: resultado.status,
          latenciaMs: resultado.latencyMs,
        },
        'herramienta ejecutada por el modelo alojado',
      );

      return reply.code(200).send(
        resultado.status === 'ok'
          ? { ok: true, data: resultado.data }
          : { ok: false, error: resultado.error ?? 'la herramienta no pudo completarse' },
      );
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      deps.logger.error({ componente: 'webhook-tools', herramienta, error: mensaje }, 'fallo la herramienta');
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
