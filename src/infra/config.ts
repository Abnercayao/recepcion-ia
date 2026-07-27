import { z } from 'zod';

/**
 * Configuracion del sistema.
 *
 * Criterio de aceptacion de la Fase 0: arrancar con el entorno incompleto FALLA
 * con un mensaje claro. Un sistema de salud que arranca a medias y descubre a
 * mitad de una llamada que le falta la lista blanca de transferencia es peor
 * que uno que no arranca.
 */

/** Acepta "true"/"1"/"yes"/"si" como verdadero. Vacio o ausente es falso. */
const booleanFromEnv = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined) return false;
    return ['true', '1', 'yes', 'si', 'sí'].includes(v.trim().toLowerCase());
  });

const intFromEnv = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : Number(v)))
    .pipe(z.number().int());

/** Lista separada por comas. Se descartan los vacios y se recorta el espacio. */
const csvFromEnv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: intFromEnv(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // --- Modelo (cerebro, comun a ambos canales) ---
    ANTHROPIC_API_KEY: z.string().min(1, 'requerida: el nucleo no funciona sin el modelo'),
    CLAUDE_MODEL_CONVERSACION: z.string().min(1),
    CLAUDE_MODEL_CLASIFICACION: z.string().min(1),
    CLAUDE_TEMPERATURE: z
      .string()
      .optional()
      .transform((v) => (v === undefined || v.trim() === '' ? 0.3 : Number(v)))
      .pipe(z.number().min(0).max(1)),
    CLAUDE_MAX_TOKENS: intFromEnv(1024),

    // --- Embeddings (no lo provee Anthropic; ver docs/decisiones.md) ---
    VOYAGE_API_KEY: z.string().optional(),
    EMBEDDING_MODEL: z.string().default('voyage-3'),
    EMBEDDING_DIMENSIONS: intFromEnv(1024),

    /** Similitud coseno minima del RAG. Calibrado a 0.5 midiendo con
     *  voyage-3 sobre la base aprobada; 0.75 apagaba la recuperacion entera. */
    RAG_UMBRAL_SIMILITUD: z
      .string()
      .optional()
      .transform((v) => (v === undefined || v.trim() === '' ? 0.5 : Number(v)))
      .pipe(z.number().min(0).max(1)),

    // --- Datos ---
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_KEY: z.string().min(1),
    /**
     * Cadena de conexion REAL de Postgres. No es lo mismo que SUPABASE_URL /
     * SUPABASE_SERVICE_KEY, que son credenciales de PostgREST y NO sirven para
     * ejecutar DDL. Solo la necesitan las migraciones, no el runtime.
     * La especificacion §14 no la contemplaba.
     */
    SUPABASE_DB_URL: z.string().optional(),
    RETENCION_TRANSCRIPCION_DIAS: intFromEnv(365),
    RETENCION_AUDIO_DIAS: intFromEnv(0),

    // --- Canal de voz (ElevenLabs) ---
    VOICE_ENABLED: booleanFromEnv,
    ELEVENLABS_API_KEY: z.string().optional(),
    ELEVENLABS_AGENT_ID: z.string().optional(),
    ELEVENLABS_VOICE_ID: z.string().optional(),
    ELEVENLABS_MODEL: z.string().optional(),
    ELEVENLABS_WS_URL: z.string().optional(),
    VOICE_GATEWAY_URL: z.string().optional(),
    /** Protege NUESTRO endpoint Custom LLM frente a peticiones no autorizadas. */
    VOICE_GATEWAY_SECRET: z.string().optional(),
    /**
     * Distinto del anterior: es el secreto con el que ElevenLabs FIRMA el
     * webhook post-llamada. Confundirlos deja el webhook sin verificar.
     */
    ELEVENLABS_WEBHOOK_SECRET: z.string().optional(),
    VOICE_LATENCIA_OBJETIVO_MS: intFromEnv(1200),
    /** Umbral tras el cual el gateway emite una expresion puente. Ver anti-patron 7. */
    VOICE_BUFFER_WORD_MS: intFromEnv(700),
    AUDIO_RETENTION: booleanFromEnv,

    // --- Telefonia ---
    SIP_PROVIDER: z.string().optional(),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_PHONE_NUMBER: z.string().optional(),
    TRANSFER_WHITELIST: csvFromEnv,

    // --- Canal de texto ---
    WHATSAPP_BSP_TOKEN: z.string().optional(),
    WHATSAPP_PHONE_ID: z.string().optional(),
    /** Token del challenge GET de verificacion del webhook (hub.verify_token). */
    WHATSAPP_WEBHOOK_SECRET: z.string().optional(),
    /**
     * App Secret de Meta: es la clave del HMAC de X-Hub-Signature-256, y es una
     * credencial DISTINTA del token de verificacion de arriba. Confundirlas deja
     * el webhook aceptando peticiones no firmadas por Meta.
     */
    WHATSAPP_APP_SECRET: z.string().optional(),
    WHATSAPP_ENABLED: booleanFromEnv,

    // --- Integraciones ---
    GOOGLE_CALENDAR_CREDENTIALS: z.string().optional(),
    N8N_WEBHOOK_URL: z.string().optional(),

    // --- Continuidad ---
    VENTANA_CONTINUIDAD_HORAS: intFromEnv(72),
    DEFAULT_PHONE_REGION: z.string().length(2).default('PE'),
  })
  .superRefine((env, ctx) => {
    // El canal de voz no arranca a medias: o esta completo o esta apagado.
    if (env.VOICE_ENABLED) {
      const requeridas = [
        'ELEVENLABS_API_KEY',
        'ELEVENLABS_AGENT_ID',
        'VOICE_GATEWAY_SECRET',
        // Sin el, el webhook post-llamada no puede verificar nada y rechaza
        // todo con 401: la transcripcion, la duracion y la evidencia de
        // revelacion no se consolidarian nunca, en silencio.
        'ELEVENLABS_WEBHOOK_SECRET',
      ] as const;
      for (const clave of requeridas) {
        if (!env[clave]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [clave],
            message: `requerida cuando VOICE_ENABLED=true`,
          });
        }
      }
      if (env.TRANSFER_WHITELIST.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TRANSFER_WHITELIST'],
          message:
            'requerida cuando VOICE_ENABLED=true: sin lista blanca no se puede escalar una urgencia por telefono',
        });
      }
    }

    if (env.WHATSAPP_ENABLED) {
      for (const clave of [
        'WHATSAPP_BSP_TOKEN',
        'WHATSAPP_PHONE_ID',
        'WHATSAPP_WEBHOOK_SECRET',
        'WHATSAPP_APP_SECRET',
      ] as const) {
        if (!env[clave]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [clave],
            message: `requerida cuando WHATSAPP_ENABLED=true`,
          });
        }
      }
    }

    // Coherencia con el control C8 y con la politica de privacidad declarada.
    if (env.AUDIO_RETENTION && env.RETENCION_AUDIO_DIAS === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUDIO_RETENTION'],
        message:
          'AUDIO_RETENTION=true con RETENCION_AUDIO_DIAS=0 es contradictorio. El audio es dato biometrico asociado a dato de salud: decide explicitamente.',
      });
    }
  });

export type Config = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    const detalle = issues
      .map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('\n');
    super(`Configuracion invalida. El sistema no arranca.\n${detalle}\n`);
    this.name = 'ConfigError';
  }
}

/**
 * Valida el entorno y devuelve la configuracion. Lanza ConfigError si falta algo.
 * Recibe el entorno por parametro para que los tests no dependan de process.env.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues);
  }
  return parsed.data;
}

let cached: Config | undefined;

/** Configuracion del proceso, memoizada. Falla al primer uso si el entorno es invalido. */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Solo para tests. */
export function resetConfigCache(): void {
  cached = undefined;
}
