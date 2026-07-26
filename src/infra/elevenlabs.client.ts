/**
 * elevenlabs.client.ts
 *
 * Cliente REST minimo para la API de ElevenLabs, con `fetch` global (sin SDK:
 * el contrato de construccion prohibe instalar paquetes nuevos y el gateway
 * de voz solo necesita unas pocas llamadas HTTP).
 *
 * Cubre dos responsabilidades sin relacion entre si, agrupadas aqui porque
 * ambas son "hablar con la API/infra de ElevenLabs desde el servidor":
 *
 *   A) Verificar la firma del webhook post-llamada (docs/contrato-elevenlabs.md §7).
 *   B) Leer la configuracion del agente y actualizar `platform_settings.privacy.retention_days`.
 *
 * ============================================================================
 * ASUNCION SIN VERIFICAR #1 — composicion del string firmado del webhook
 * ============================================================================
 * `docs/contrato-elevenlabs.md` (verificado contra la documentacion oficial
 * para esta construccion) dice literalmente: "La composicion exacta del
 * string firmado no esta documentada — se delega al SDK oficial". No hay SDK
 * instalado aqui, asi que se ASUME el patron de Stripe (`${timestamp}.${rawBody}`),
 * aislado en `buildSignedPayload()`. Si en produccion la firma nunca valida,
 * este es el primer sospechoso: confirmar contra el SDK oficial de ElevenLabs
 * o con soporte antes de confiar en este verificador para rechazar trafico.
 * ============================================================================
 *
 * ============================================================================
 * ASUNCION SIN VERIFICAR #2 — endpoint de lectura/escritura de configuracion
 * ============================================================================
 * El contrato confirma el NOMBRE del campo (`platform_settings.privacy.retention_days`,
 * ver docs/contrato-elevenlabs.md §5) pero no la URL exacta del endpoint REST
 * (el documento advierte ademas, en su §8, que coexisten rutas
 * `eleven-agents/…`, `conversational-ai/…` y `agents-platform/…` por un
 * rebranding en curso). Se asume `GET/PATCH /v1/convai/agents/{agentId}`,
 * que es la ruta de la API de Conversational AI de ElevenLabs mas estable
 * conocida al momento de escribir esto. CONFIRMAR contra el panel o la
 * documentacion vigente antes de usar `updateRetentionDays` en produccion.
 * ============================================================================
 *
 * VACIO DE CONFIGURACION DETECTADO: `src/infra/config.ts` (de otra rama, no
 * tocado aqui) no define una variable de entorno para el secreto de firma del
 * webhook post-llamada (es un secreto DISTINTO de `VOICE_GATEWAY_SECRET`, que
 * protege el endpoint propio /v1/chat/completions — ver docs/contrato-elevenlabs.md
 * §2 vs §7). Este cliente recibe `webhookSecret` como parametro de
 * construccion en vez de leerlo de `Config`; falta anadir algo como
 * `ELEVENLABS_WEBHOOK_SECRET` al esquema de `config.ts` para que quien
 * instancie este cliente no tenga que inventarse de donde sacarlo.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Logger } from '../core/types/index.js';

// ---------------------------------------------------------------------------
// A) Verificacion de firma del webhook post-llamada
// ---------------------------------------------------------------------------

export interface WebhookVerificationOptions {
  /** Ventana de tolerancia en segundos para el timestamp del header. Por defecto 300 (5 min, igual que Stripe). */
  toleranceSeconds?: number;
  /** Reloj inyectable para tests deterministas. */
  now?: () => Date;
}

export interface WebhookVerificationResult {
  valid: boolean;
  /** Motivo legible cuando `valid` es false. Sirve para loguear el rechazo (nunca el secreto ni el body). */
  reason?: string;
}

/**
 * Composicion del string firmado. Aislada en su propia funcion (en vez de
 * inline en el verificador) para que quede claro que es una decision propia,
 * no un dato confirmado por ElevenLabs. Ver "ASUNCION SIN VERIFICAR #1" arriba.
 */
function buildSignedPayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

interface ParsedSignatureHeader {
  timestamp: string;
  hash: string;
}

/** El header trae la forma `t=<timestamp>,v0=<hash>`. */
function parseSignatureHeader(header: string): ParsedSignatureHeader | undefined {
  let timestamp: string | undefined;
  let hash: string | undefined;

  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v0') hash = value;
  }

  if (!timestamp || !hash) return undefined;
  return { timestamp, hash };
}

/**
 * Verifica la firma HMAC-SHA256 de un webhook post-llamada de ElevenLabs.
 *
 * Rechaza si:
 *  - falta el header o tiene formato invalido;
 *  - el timestamp cae fuera de la ventana de tolerancia (control de
 *    antiguedad: evita que un webhook capturado se reenvie mas tarde);
 *  - el hash no coincide (comparacion en tiempo constante con `timingSafeEqual`).
 */
export function verifyElevenLabsWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  webhookSecret: string,
  options: WebhookVerificationOptions = {},
): WebhookVerificationResult {
  if (!signatureHeader) {
    return { valid: false, reason: 'falta el header ElevenLabs-Signature' };
  }

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    return { valid: false, reason: 'header ElevenLabs-Signature con formato invalido (se esperaba t=...,v0=...)' };
  }

  const timestampSeconds = Number(parsed.timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { valid: false, reason: 'timestamp del header no es numerico' };
  }

  const toleranceSeconds = options.toleranceSeconds ?? 300;
  const now = options.now ? options.now() : new Date();
  const ageSeconds = now.getTime() / 1000 - timestampSeconds;

  // Se rechaza tanto un timestamp demasiado viejo (replay de un webhook
  // capturado) como uno demasiado en el futuro (reloj del emisor
  // desincronizado hacia adelante, o el mismo intento de replay con un
  // timestamp fabricado).
  if (Math.abs(ageSeconds) > toleranceSeconds) {
    return { valid: false, reason: `timestamp fuera de la ventana de tolerancia (${toleranceSeconds}s)` };
  }

  const expectedHash = createHmac('sha256', webhookSecret).update(buildSignedPayload(parsed.timestamp, rawBody)).digest('hex');

  const expectedBuffer = Buffer.from(expectedHash, 'hex');
  const receivedBuffer = Buffer.from(parsed.hash, 'hex');

  // timingSafeEqual exige buffers del mismo tamano: comparar la longitud
  // antes no filtra informacion util para forjar la firma (el atacante ya
  // conoce el tamano de un SHA-256 en hex), y evita que timingSafeEqual lance.
  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
    return { valid: false, reason: 'la firma HMAC no coincide' };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// B) Configuracion del agente y privacidad
// ---------------------------------------------------------------------------

const agentPrivacySettingsSchema = z
  .object({
    retention_days: z.number().int(),
  })
  .passthrough();

const agentPlatformSettingsSchema = z
  .object({
    privacy: agentPrivacySettingsSchema,
  })
  .passthrough();

const agentConfigSchema = z
  .object({
    agent_id: z.string(),
    name: z.string().optional(),
    platform_settings: agentPlatformSettingsSchema,
  })
  .passthrough();

export type ElevenLabsAgentConfig = z.infer<typeof agentConfigSchema>;

export interface ElevenLabsClientDeps {
  apiKey: string;
  /** Secreto de firma del webhook post-llamada. Ver "VACIO DE CONFIGURACION DETECTADO" arriba. */
  webhookSecret?: string;
  /** Por defecto `https://api.elevenlabs.io`. Ver "ASUNCION SIN VERIFICAR #2" sobre las rutas en rebranding. */
  baseUrl?: string;
  /** Punto de inyeccion para tests: sustituye `fetch` por un doble sin red. */
  fetchImpl?: typeof fetch;
  logger: Logger;
}

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';

/**
 * `-1` = retencion ilimitada, `0` = borrado inmediato (docs/contrato-elevenlabs.md §5).
 * Cualquier entero positivo es un numero de dias.
 */
function isValidRetentionDays(value: number): boolean {
  return Number.isInteger(value) && value >= -1;
}

export class ElevenLabsClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: ElevenLabsClientDeps) {
    this.baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** Atajo que usa el `webhookSecret` de este cliente. Ver `verifyElevenLabsWebhookSignature`. */
  verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string | undefined,
    options?: WebhookVerificationOptions,
  ): WebhookVerificationResult {
    if (!this.deps.webhookSecret) {
      return { valid: false, reason: 'este cliente no tiene webhookSecret configurado' };
    }
    return verifyElevenLabsWebhookSignature(rawBody, signatureHeader, this.deps.webhookSecret, options);
  }

  /** Lee la configuracion completa del agente. `xi-api-key` es el header de autenticacion estandar de la API de ElevenLabs. */
  async getAgentConfig(agentId: string): Promise<ElevenLabsAgentConfig> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/convai/agents/${encodeURIComponent(agentId)}`, {
      method: 'GET',
      headers: { 'xi-api-key': this.deps.apiKey },
    });

    if (!res.ok) {
      throw new Error(`ElevenLabs getAgentConfig fallo: HTTP ${res.status}`);
    }

    const body: unknown = await res.json();
    const parsed = agentConfigSchema.safeParse(body);
    if (!parsed.success) {
      const detalle = parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ');
      throw new Error(`respuesta de ElevenLabs con forma inesperada: ${detalle}`);
    }
    return parsed.data;
  }

  /**
   * Actualiza `platform_settings.privacy.retention_days`.
   *
   * ADVERTENCIA (docs/contrato-elevenlabs.md §5): esto NO es Zero Retention
   * Mode (funcionalidad distinta, exclusiva del plan Enterprise, que ademas
   * exige un BAA vigente para uso con datos de salud). Cambiar
   * `retention_days` no restringe el logging de audio/texto de STT/TTS ni de
   * la entrada/salida del agente: solo fija cuanto tiempo se conserva lo que
   * ya se registra. No sustituye la revision del panel (Agent Settings →
   * Advanced → Data Retention) antes de produccion.
   */
  async updateRetentionDays(agentId: string, retentionDays: number): Promise<void> {
    if (!isValidRetentionDays(retentionDays)) {
      throw new Error('retentionDays debe ser -1 (ilimitado), 0 (borrado inmediato) o un entero positivo de dias');
    }

    this.deps.logger.warn(
      { agentId, retentionDays },
      'actualizando retention_days de ElevenLabs: no es Zero Retention Mode (exclusivo Enterprise) ni sustituye la revision manual del panel',
    );

    const res = await this.fetchImpl(`${this.baseUrl}/v1/convai/agents/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      headers: {
        'xi-api-key': this.deps.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ platform_settings: { privacy: { retention_days: retentionDays } } }),
    });

    if (!res.ok) {
      throw new Error(`ElevenLabs updateRetentionDays fallo: HTTP ${res.status}`);
    }
  }
}
