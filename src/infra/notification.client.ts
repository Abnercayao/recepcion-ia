/**
 * Canal de notificacion hacia la recepcion humana.
 *
 * Es la ULTIMA linea del sistema. Se usa cuando hay que entregar un caso a una
 * persona y la transferencia telefonica no es posible: numero fuera de la lista
 * blanca, canal de texto, o fallo tecnico. El control O5 lo dice sin matices:
 * el modo de fallo del sistema es la reversion a la operacion manual de la
 * clinica, NUNCA el silencio.
 *
 * De ahi la regla de este archivo: si la notificacion falla, se registra en
 * nivel `fatal` y se propaga. Tragarse el error aqui convertiria un escalamiento
 * en un abandono silencioso, que es exactamente el peor resultado posible del
 * sistema: un paciente que pidio ayuda y nadie se entero.
 */
import pRetry, { AbortError } from 'p-retry';
import type {
  EscalationRequest,
  Logger,
  NotificationPort,
  TurnContext,
} from '../core/types/index.js';
import { maskPII } from './pii-masker.js';

export interface NotificationClientDeps {
  /** `config.N8N_WEBHOOK_URL`. Sin el, no hay canal de respaldo. */
  webhookUrl?: string;
  logger: Logger;
  /** Punto de inyeccion para tests. */
  fetchImpl?: typeof fetch;
  retries?: number;
  timeoutMs?: number;
}

const REINTENTOS_POR_DEFECTO = 3;
const TIMEOUT_POR_DEFECTO_MS = 10_000;

/**
 * Cuerpo que recibe la recepcion.
 *
 * Lleva lo justo para atender el caso: quien es, por que se escala y con que
 * urgencia. NO lleva el historial de la conversacion ni el contenido clinico
 * literal: el riesgo B.5 del informe etico es precisamente la filtracion por el
 * canal de escalamiento, que suele ser un canal de conveniencia (correo, chat
 * interno) con menos garantias que la propia base de datos.
 */
interface CargaDeEscalamiento {
  conversationId: string;
  clinicId: string;
  clinicaNombre: string;
  motivo: EscalationRequest['reason'];
  prioridad: EscalationRequest['priority'];
  resumenParaRecepcion: string;
  telefonoPaciente: string;
  pacienteNombre?: string;
  canal: string;
  ocurridoEn: string;
}

export class NotificationClient implements NotificationPort {
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: NotificationClientDeps) {
    this.logger = deps.logger.child({ componente: 'notification.client' });
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.retries = deps.retries ?? REINTENTOS_POR_DEFECTO;
    this.timeoutMs = deps.timeoutMs ?? TIMEOUT_POR_DEFECTO_MS;
  }

  async notifyEscalation(ctx: TurnContext, request: EscalationRequest): Promise<void> {
    const carga: CargaDeEscalamiento = {
      conversationId: ctx.conversationId,
      clinicId: ctx.clinic.id,
      clinicaNombre: ctx.clinic.nombre,
      motivo: request.reason,
      prioridad: request.priority,
      resumenParaRecepcion: request.summaryForAgent,
      telefonoPaciente: ctx.patient.telefonoE164,
      ...(ctx.patient.nombre ? { pacienteNombre: ctx.patient.nombre } : {}),
      canal: ctx.channel,
      ocurridoEn: ctx.now.toISOString(),
    };

    if (!this.deps.webhookUrl) {
      // Sin canal configurado no se puede avisar a nadie. Es un fallo de
      // configuracion, no de ejecucion, y hay que verlo en los registros: un
      // sistema que escala al vacio es peor que uno que no escala.
      this.logger.fatal(
        { escalamiento: maskPII(carga) },
        'N8N_WEBHOOK_URL no esta configurado: el escalamiento NO se ha notificado a nadie',
      );
      throw new Error('canal de notificacion no configurado: el escalamiento no llego a recepcion');
    }

    const url = this.deps.webhookUrl;

    try {
      await pRetry(
        async () => {
          const respuesta = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(carga),
            signal: AbortSignal.timeout(this.timeoutMs),
          });

          if (respuesta.ok) return;

          // 4xx es configuracion equivocada (URL mala, credencial mala):
          // reintentar no la arregla y solo retrasa el aviso a la persona.
          if (respuesta.status >= 400 && respuesta.status < 500) {
            throw new AbortError(
              `el canal de notificacion respondio ${respuesta.status}: no se reintenta`,
            );
          }

          throw new Error(`el canal de notificacion respondio ${respuesta.status}`);
        },
        { retries: this.retries },
      );

      this.logger.info(
        {
          conversationId: ctx.conversationId,
          motivo: request.reason,
          prioridad: request.priority,
        },
        'escalamiento notificado a recepcion',
      );
    } catch (error) {
      this.logger.fatal(
        {
          conversationId: ctx.conversationId,
          motivo: request.reason,
          prioridad: request.priority,
          error: error instanceof Error ? error.message : String(error),
        },
        'NO se pudo notificar el escalamiento: hay un paciente esperando y nadie avisado',
      );
      throw error;
    }
  }
}
