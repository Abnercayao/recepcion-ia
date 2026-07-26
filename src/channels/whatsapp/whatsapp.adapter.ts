/**
 * whatsapp.adapter.ts
 *
 * Envio saliente a la WhatsApp Cloud API. Traduce un `OutboundMessage`
 * (texto puro del nucleo) en una o mas peticiones HTTP a Meta, aplicando el
 * formato del canal (whatsapp.formatter.ts) y emitiendo la revelacion
 * obligatoria (Encargo 3, §7 de la especificacion) al inicio de cada
 * conversacion nueva. No decide contenido de negocio: solo transporta y
 * dale forma a lo que el nucleo ya decidio.
 *
 * `fetch` global, sin SDK (contrato de construccion: no instalar paquetes
 * nuevos). Reintentos con `p-retry` solo para 429/5xx; un 4xx nunca se
 * reintenta (reintentar una peticion mal formada o sin autorizacion no la
 * arregla, solo demora el fallo) -- mismo patron que src/infra/calendar.client.ts.
 *
 * REVELACION (§7) -- COMO SE DETECTA "CONVERSACION NUEVA":
 * `OutboundMessage` (contrato congelado) NO trae ninguna senal de si la
 * conversacion es nueva; ese estado vive en `TurnContext.history` dentro del
 * nucleo, y el adaptador no tiene visibilidad de eso (ni deberia, por la
 * regla de dependencias: channels -> core, nunca al reves, y aqui ademas ni
 * siquiera se recibe el TurnContext). Lo unico estable que SI viaja en
 * OutboundMessage es `conversationId`, que es el mismo durante toda la
 * conversacion (incluso a traves de un cambio de canal, ver core/types/conversation.ts).
 * Por eso este adaptador recuerda localmente que conversationId ya recibieron
 * la revelacion (`DisclosureTracker`) y la antepone la PRIMERA vez que ve un
 * conversationId nuevo para el.
 *
 * LIMITACION ACEPTADA (documentar en el informe final): el tracker en
 * memoria no sobrevive un reinicio del proceso. Si el proceso se reinicia a
 * mitad de una conversacion ya revelada, el siguiente mensaje de esa misma
 * conversacion se trataria otra vez como "nueva" y repetiria la revelacion.
 * Es el modo de fallo SEGURO para una obligacion contractual bloqueante:
 * revelar de mas es inocuo, revelar de menos incumple el criterio de
 * aceptacion ("conversaciones con revelacion ejecutada = 100%"). La solucion
 * correcta a largo plazo es que el nucleo exponga una senal explicita de
 * "primer turno de la conversacion" (cambio de contrato, fuera de mi alcance:
 * ver informe final).
 */
import pRetry, { AbortError } from 'p-retry';
import type { Logger, OutboundMessage } from '../../core/types/index.js';
import { formatOutboundMessage } from './whatsapp.formatter.js';
import {
  whatsappSendResponseSchema,
  type WhatsappOutboundSender,
  type WhatsappSendTextRequest,
} from './whatsapp.types.js';

const CLOUD_API_BASE_URL = 'https://graph.facebook.com/v21.0';

// ---------------------------------------------------------------------------
// Reintentos (mismo patron que calendar.client.ts: solo transitorios)
// ---------------------------------------------------------------------------

export interface WhatsappRetryOptions {
  retries: number;
  minTimeout: number;
  factor: number;
}

const DEFAULT_RETRY_OPTIONS: WhatsappRetryOptions = {
  retries: 4,
  minTimeout: 300,
  factor: 2,
};

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

// ---------------------------------------------------------------------------
// Revelacion obligatoria (§7)
// ---------------------------------------------------------------------------

export interface DisclosureTracker {
  hasDisclosed(conversationId: string): boolean;
  markDisclosed(conversationId: string): void;
}

/** Ver "LIMITACION ACEPTADA" en el comentario de cabecera del archivo. */
export class InMemoryDisclosureTracker implements DisclosureTracker {
  private readonly disclosed = new Set<string>();

  hasDisclosed(conversationId: string): boolean {
    return this.disclosed.has(conversationId);
  }

  markDisclosed(conversationId: string): void {
    this.disclosed.add(conversationId);
  }
}

/**
 * Equivalente ESCRITO del guion de revelacion de voz (§7 de la
 * especificacion). No es una traduccion literal: el guion de voz menciona
 * grabacion de la LLAMADA ("esta llamada puede ser grabada..."), que no
 * aplica a un mensaje de texto, asi que esa clausula se omite aqui. Lo que
 * SI se preserva, porque es el nucleo de la obligacion (transparencia +
 * no afirmar ser humano + ofrecer transferencia a una persona) es identico
 * en espiritu al de voz.
 */
export function buildDisclosureMessage(clinicName: string): string {
  return (
    `Hola, le atiende el asistente virtual de ${clinicName}. Soy un asistente de ` +
    `inteligencia artificial, no una persona. Si en cualquier momento prefiere ` +
    `hablar con alguien de nuestro equipo, dígamelo y lo derivo. ¿En qué le puedo ayudar?`
  );
}

// ---------------------------------------------------------------------------
// Adaptador
// ---------------------------------------------------------------------------

export interface WhatsappAdapterDeps {
  /**
   * Un `phone_number_id` de Meta = un numero de WhatsApp Business = (en el
   * diseno actual, de una sola clinica por numero) una clinica. Por eso
   * `phoneNumberId`, `bspToken` y `clinicName` se fijan por INSTANCIA del
   * adaptador, no por llamada: si el despliegue tiene varias clinicas, Ola 4
   * instancia un WhatsappAdapter por clinica (ver whatsapp.types.ts,
   * ResolveWhatsappRouting).
   */
  phoneNumberId: string;
  bspToken: string;
  clinicName: string;
  logger: Logger;
  /** Punto de inyeccion para tests: sustituye `fetch` global por un doble sin red. */
  fetchImpl?: typeof fetch;
  retryOptions?: WhatsappRetryOptions;
  disclosureTracker?: DisclosureTracker;
  /** Solo para tests: cambia el host de la Cloud API. */
  baseUrl?: string;
}

export class WhatsappAdapter implements WhatsappOutboundSender {
  private readonly fetchImpl: typeof fetch;
  private readonly retryOptions: WhatsappRetryOptions;
  private readonly disclosureTracker: DisclosureTracker;
  private readonly baseUrl: string;

  constructor(private readonly deps: WhatsappAdapterDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.retryOptions = deps.retryOptions ?? DEFAULT_RETRY_OPTIONS;
    this.disclosureTracker = deps.disclosureTracker ?? new InMemoryDisclosureTracker();
    this.baseUrl = deps.baseUrl ?? CLOUD_API_BASE_URL;
  }

  /**
   * Envia el turno completo: antepone la revelacion si la conversacion es
   * nueva para este adaptador, formatea el texto del nucleo al formato del
   * canal, lo trocea si excede el limite, y envia cada trozo en orden.
   */
  async sendOutbound(patientPhoneE164: string, outbound: OutboundMessage): Promise<void> {
    if (!this.disclosureTracker.hasDisclosed(outbound.conversationId)) {
      // Misma ruta de formateo/troceado que el texto del turno: un solo
      // camino "enviar texto a WhatsApp" que siempre respeta el limite de
      // 4096, en vez de asumir que la revelacion "seguro" es corta.
      for (const chunk of formatOutboundMessage(buildDisclosureMessage(this.deps.clinicName))) {
        await this.sendText(patientPhoneE164, chunk);
      }
      this.disclosureTracker.markDisclosed(outbound.conversationId);
    }

    for (const chunk of formatOutboundMessage(outbound.text)) {
      await this.sendText(patientPhoneE164, chunk);
    }
  }

  private async sendText(to: string, body: string): Promise<void> {
    const url = `${this.baseUrl}/${encodeURIComponent(this.deps.phoneNumberId)}/messages`;
    const request: WhatsappSendTextRequest = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    };

    await pRetry(
      async () => {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.deps.bspToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(request),
        });

        if (res.ok) {
          const json: unknown = await res.json().catch(() => undefined);
          const parsed = whatsappSendResponseSchema.safeParse(json);
          if (!parsed.success) {
            this.deps.logger.warn(
              {},
              'whatsapp adapter: respuesta de envio con forma inesperada, se continua igual (no es motivo de reintento)',
            );
          }
          return;
        }

        if (isTransientStatus(res.status)) {
          // Transitorio (429/5xx): se deja pasar el error para que p-retry reintente.
          throw new Error(`whatsapp cloud api respondio HTTP ${res.status} (transitorio)`);
        }
        // 4xx (autorizacion, validacion, numero invalido, etc.): NUNCA reintentar.
        throw new AbortError(new Error(`whatsapp cloud api respondio HTTP ${res.status} (no transitorio)`));
      },
      {
        retries: this.retryOptions.retries,
        minTimeout: this.retryOptions.minTimeout,
        factor: this.retryOptions.factor,
        onFailedAttempt: (ctx) => {
          this.deps.logger.warn(
            { intento: ctx.attemptNumber, quedan: ctx.retriesLeft, error: ctx.error.message },
            'whatsapp adapter: reintento de envio',
          );
        },
      },
    );
  }
}
