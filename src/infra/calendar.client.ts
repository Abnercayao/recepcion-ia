/**
 * calendar.client.ts
 *
 * Implementacion de `CalendarPort` (src/core/types/ports.ts) sobre la Google
 * Calendar API, usando `googleapis` con una cuenta de servicio y delegacion
 * de dominio (domain-wide delegation).
 *
 * Decisiones de diseno y por que:
 *
 * 1. ZONA HORARIA. `CalendarSlot`/`CalendarEvent` usan `Date`, que es siempre
 *    un instante absoluto (epoch ms): no hay ambiguedad de zona horaria en el
 *    tipo. La ambiguedad aparece al SERIALIZAR ese instante para Google. Aqui
 *    se serializa SIEMPRE con `.toISOString()` (UTC, con sufijo "Z", que es
 *    un offset explicito y valido en RFC3339) y se adjunta ademas
 *    `timeZone: clinic.timezone` (IANA) en cada `start`/`end`. La combinacion
 *    de offset explicito + IANA es la que evita el bug caro: una cita con la
 *    hora corrida es un criterio BLOQUEANTE (Tabla 14: "citas creadas con
 *    fecha, hora o profesional incorrectos = 0"). NUNCA se construye la
 *    fecha con el reloj/zona del servidor.
 *
 * 2. `findAvailableSlots` usa `freebusy.query`, no `events.list`. La API de
 *    freebusy SOLO devuelve intervalos ocupados (start/end), nunca titulo,
 *    asistentes ni descripcion. Es la eleccion que hace que "sin exponer
 *    NINGUN dato de otros pacientes" sea estructural y no una promesa de
 *    disciplina: el endpoint no tiene ese dato para filtrar.
 *
 * 3. `isSlotFree` llama a `freebusy.query` de forma fresca en cada invocacion.
 *    No hay cache de resultados de disponibilidad en ningun punto de este
 *    archivo (solo se cachea la conexion/autenticacion por clinica, nunca
 *    los datos de ocupacion). Es la doble verificacion previa a escribir
 *    (control C7).
 *
 * 4. CALENDARIO POR CLINICA. `clinic.config` es `Record<string, unknown>`
 *    generico (definido en core/types/conversation.ts). Este archivo es quien
 *    fija su forma para el dominio de agenda:
 *      - `googleCalendarId` (string, REQUERIDO): id o email del calendario de
 *        Google de esa clinica.
 *      - `googleImpersonateSubject` (string, OPCIONAL): cuenta de Google
 *        Workspace a impersonar via delegacion de dominio. Si se omite, la
 *        cuenta de servicio debe tener el calendario compartido
 *        directamente (sin impersonar a nadie). Se valida con Zod porque
 *        `clinic.config` llega como `unknown`.
 *
 * 5. IDEMPOTENCIA DE `createEvent`. El puerto (`ports.ts`, no modificable)
 *    NO tiene un parametro `requestId`. Para poder reintentar sin duplicar,
 *    el id del evento de Google se DERIVA deterministicamente de
 *    (clinicId, start, end, patientPhone) con SHA-256. Si `createEvent` se
 *    reintenta (p. ej. la respuesta de Google se perdio por un corte de red
 *    justo despues de que la escritura tuviera exito), el segundo intento
 *    manda el MISMO id de evento: Google responde 409 (ya existe) y aqui se
 *    interpreta como exito (se recupera el evento existente con `events.get`
 *    y se devuelve), en vez de crear una segunda cita. Esto es lo que hace
 *    seguro reintentar con `p-retry` errores transitorios (5xx/429/red):
 *    la propia idempotencia del id convierte un reintento ciego en inofensivo.
 *    Un error NO transitorio (400/401/403) aborta sin reintentar: reintentar
 *    una peticion mal formada o sin permisos no la arregla.
 */
import { createHash } from 'node:crypto';
import { google, type calendar_v3 } from 'googleapis';
import pRetry, { AbortError } from 'p-retry';
import { z } from 'zod';
import type {
  CalendarEvent,
  CalendarPort,
  CalendarSlot,
  Clinic,
  ClinicRepository,
  Logger,
} from '../core/types/index.js';
import type { Config } from './config.js';

/** Tipo del cliente autenticado de google-auth-library, obtenido sin importar el paquete directamente. */
type GoogleJwtClient = InstanceType<typeof google.auth.JWT>;

/**
 * Superficie minima que este cliente necesita de `calendar_v3.Calendar`.
 * Se define a mano, en vez de usar el tipo completo de la libreria (decenas
 * de recursos, sobrecargas con callbacks y streams que no usamos), para que
 * los tests puedan inyectar un doble simple sin reproducir esas sobrecargas.
 */
export interface CalendarApiSurface {
  freebusy: {
    query(params: {
      requestBody: calendar_v3.Schema$FreeBusyRequest;
    }): Promise<{ data: calendar_v3.Schema$FreeBusyResponse }>;
  };
  events: {
    insert(params: {
      calendarId: string;
      requestBody: calendar_v3.Schema$Event;
    }): Promise<{ data: calendar_v3.Schema$Event }>;
    get(params: { calendarId: string; eventId: string }): Promise<{ data: calendar_v3.Schema$Event }>;
    delete(params: { calendarId: string; eventId: string }): Promise<unknown>;
  };
}

/** Punto de inyeccion para tests: sustituye el cliente real de `googleapis` por un doble sin red. */
export type CalendarApiFactory = (auth: GoogleJwtClient) => CalendarApiSurface;

function defaultCalendarApiFactory(auth: GoogleJwtClient): CalendarApiSurface {
  // El cast es necesario porque calendar_v3.Calendar expone mucha mas
  // superficie (con sobrecargas) que la que declaramos en CalendarApiSurface;
  // estructuralmente cumple el subconjunto que usamos.
  return google.calendar({ version: 'v3', auth }) as unknown as CalendarApiSurface;
}

// ---------------------------------------------------------------------------
// Credenciales de la cuenta de servicio
// ---------------------------------------------------------------------------

const googleServiceAccountSchema = z.object({
  client_email: z.string().min(1),
  private_key: z.string().min(1),
});

export type GoogleServiceAccountCredentials = z.infer<typeof googleServiceAccountSchema>;

/**
 * `GOOGLE_CALENDAR_CREDENTIALS` puede llegar como el JSON literal de la
 * cuenta de servicio o como ese mismo JSON codificado en base64 (comun
 * cuando la variable de entorno no tolera bien los saltos de linea de
 * `private_key`). Se soportan ambas formas intentando `JSON.parse` directo
 * primero y, si falla, decodificando base64 antes de reintentar — en vez de
 * adivinar el formato por el primer caracter, que es mas fragil.
 */
export function parseGoogleCredentials(raw: string): GoogleServiceAccountCredentials {
  const tryParseJson = (text: string): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  };

  const direct = tryParseJson(raw);
  const candidate = direct !== undefined ? direct : tryParseJson(Buffer.from(raw, 'base64').toString('utf8'));

  if (candidate === undefined) {
    throw new Error('GOOGLE_CALENDAR_CREDENTIALS no es JSON valido ni base64 de un JSON valido');
  }

  const result = googleServiceAccountSchema.safeParse(candidate);
  if (!result.success) {
    const detalle = result.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ');
    throw new Error(`GOOGLE_CALENDAR_CREDENTIALS no tiene la forma esperada (client_email, private_key): ${detalle}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Configuracion del calendario por clinica (ver punto 4 del comentario de cabecera)
// ---------------------------------------------------------------------------

const clinicCalendarConfigSchema = z.object({
  googleCalendarId: z.string().min(1, 'clinic.config.googleCalendarId es requerido para usar el calendario'),
  googleImpersonateSubject: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Reintentos
// ---------------------------------------------------------------------------

export interface CalendarRetryOptions {
  retries: number;
  minTimeout: number;
  factor: number;
}

const DEFAULT_RETRY_OPTIONS: CalendarRetryOptions = {
  retries: 4,
  minTimeout: 300,
  factor: 2,
};

function isTransientStatus(status: number | undefined): boolean {
  // Sin respuesta (status indefinido) = probable corte de red: se trata como
  // transitorio para darle una oportunidad al reintento.
  if (status === undefined) return true;
  return status === 429 || (status >= 500 && status <= 599);
}

function extractHttpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const withStatus = err as { status?: unknown; response?: { status?: unknown } };
  if (typeof withStatus.status === 'number') return withStatus.status;
  if (typeof withStatus.response === 'object' && withStatus.response !== null) {
    const responseStatus = (withStatus.response as { status?: unknown }).status;
    if (typeof responseStatus === 'number') return responseStatus;
  }
  return undefined;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Ejecuta `fn` con reintentos SOLO para errores transitorios (429, 5xx, o sin
 * respuesta). Cualquier otro error (400/401/403/404 segun el caso) aborta de
 * inmediato via `AbortError`: reintentar un error de autorizacion o de
 * validacion no lo arregla, solo demora el fallo.
 */
async function withTransientRetry<T>(
  fn: () => Promise<T>,
  retryOptions: CalendarRetryOptions,
  logger: Logger,
  operacion: string,
): Promise<T> {
  return pRetry(
    async () => {
      try {
        return await fn();
      } catch (err) {
        if (isTransientStatus(extractHttpStatus(err))) {
          throw err; // p-retry decide si reintenta
        }
        throw new AbortError(toError(err));
      }
    },
    {
      retries: retryOptions.retries,
      minTimeout: retryOptions.minTimeout,
      factor: retryOptions.factor,
      onFailedAttempt: (ctx) => {
        logger.warn(
          { operacion, intento: ctx.attemptNumber, quedan: ctx.retriesLeft, error: ctx.error.message },
          'reintento de llamada a Google Calendar',
        );
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

export interface GoogleCalendarClientOptions {
  /** Sustituye el cliente real de `googleapis` por un doble. Solo para tests. */
  calendarApiFactory?: CalendarApiFactory;
  retryOptions?: CalendarRetryOptions;
}

interface ResolvedClinicCalendar {
  api: CalendarApiSurface;
  calendarId: string;
  clinic: Clinic;
}

export class GoogleCalendarClient implements CalendarPort {
  private readonly calendarApiFactory: CalendarApiFactory;
  private readonly retryOptions: CalendarRetryOptions;
  /**
   * Cachea SOLO la conexion (cliente autenticado + id de calendario) por
   * clinica, nunca datos de disponibilidad. Evita reconstruir el JWT en cada
   * llamada; si la configuracion de una clinica cambia, se puede invalidar
   * con `invalidateClinicCache`.
   */
  private readonly cache = new Map<string, { api: CalendarApiSurface; calendarId: string }>();

  constructor(
    private readonly clinicRepository: ClinicRepository,
    private readonly config: Pick<Config, 'GOOGLE_CALENDAR_CREDENTIALS'>,
    private readonly logger: Logger,
    options?: GoogleCalendarClientOptions,
  ) {
    this.calendarApiFactory = options?.calendarApiFactory ?? defaultCalendarApiFactory;
    this.retryOptions = options?.retryOptions ?? DEFAULT_RETRY_OPTIONS;
  }

  /** Solo para tests o para forzar una reconexion tras un cambio de configuracion. */
  invalidateClinicCache(clinicId?: string): void {
    if (clinicId) this.cache.delete(clinicId);
    else this.cache.clear();
  }

  private async resolveClinicCalendar(clinicId: string): Promise<ResolvedClinicCalendar> {
    const clinic = await this.clinicRepository.findById(clinicId);
    if (!clinic) {
      throw new Error(`clinica no encontrada: ${clinicId}`);
    }

    const cached = this.cache.get(clinicId);
    if (cached) {
      return { api: cached.api, calendarId: cached.calendarId, clinic };
    }

    const calendarConfig = clinicCalendarConfigSchema.safeParse(clinic.config);
    if (!calendarConfig.success) {
      const detalle = calendarConfig.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ');
      throw new Error(`clinic.config invalido para el calendario (clinica ${clinicId}): ${detalle}`);
    }

    if (!this.config.GOOGLE_CALENDAR_CREDENTIALS) {
      throw new Error('GOOGLE_CALENDAR_CREDENTIALS no esta configurado: el calendario no puede operar');
    }
    const credentials = parseGoogleCredentials(this.config.GOOGLE_CALENDAR_CREDENTIALS);

    const jwt = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/calendar'],
      subject: calendarConfig.data.googleImpersonateSubject,
    });

    const api = this.calendarApiFactory(jwt);
    this.cache.set(clinicId, { api, calendarId: calendarConfig.data.googleCalendarId });
    return { api, calendarId: calendarConfig.data.googleCalendarId, clinic };
  }

  async findAvailableSlots(clinicId: string, from: Date, to: Date, durationMin: number): Promise<CalendarSlot[]> {
    if (durationMin <= 0) {
      throw new Error('durationMin debe ser mayor que 0');
    }
    const { api, calendarId, clinic } = await this.resolveClinicCalendar(clinicId);

    const response = await withTransientRetry(
      () =>
        api.freebusy.query({
          requestBody: {
            timeMin: from.toISOString(),
            timeMax: to.toISOString(),
            timeZone: clinic.timezone,
            items: [{ id: calendarId }],
          },
        }),
      this.retryOptions,
      this.logger,
      'freebusy.query',
    );

    const busy = (response.data.calendars?.[calendarId]?.busy ?? [])
      .filter((p): p is { start: string; end: string } => Boolean(p.start && p.end))
      .map((p) => ({ start: new Date(p.start), end: new Date(p.end) }));

    const slots: CalendarSlot[] = [];
    const stepMs = durationMin * 60_000;
    for (let t = from.getTime(); t + stepMs <= to.getTime(); t += stepMs) {
      const slotStart = new Date(t);
      const slotEnd = new Date(t + stepMs);
      const overlaps = busy.some((b) => slotStart < b.end && slotEnd > b.start);
      if (!overlaps) {
        slots.push({ start: slotStart, end: slotEnd });
      }
    }
    return slots;
  }

  async isSlotFree(clinicId: string, start: Date, end: Date): Promise<boolean> {
    const { api, calendarId, clinic } = await this.resolveClinicCalendar(clinicId);

    // Consulta SIEMPRE fresca contra la API: nunca se reutiliza aqui el
    // resultado de findAvailableSlots ni ningun valor calculado antes. Es la
    // doble verificacion previa a escribir (control C7) — si se cacheara,
    // dos citas podrian colarse en el mismo hueco entre el momento en que se
    // ofrecio el horario al paciente y el momento en que se confirma.
    const response = await withTransientRetry(
      () =>
        api.freebusy.query({
          requestBody: {
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            timeZone: clinic.timezone,
            items: [{ id: calendarId }],
          },
        }),
      this.retryOptions,
      this.logger,
      'freebusy.query(isSlotFree)',
    );

    const busy = response.data.calendars?.[calendarId]?.busy ?? [];
    return busy.length === 0;
  }

  /** Ver punto 5 del comentario de cabecera: idempotencia sin tocar la firma del puerto. */
  private deriveEventId(clinicId: string, event: Omit<CalendarEvent, 'id'>, patientPhone: string): string {
    const raw = `${clinicId}|${event.start.toISOString()}|${event.end.toISOString()}|${patientPhone}`;
    const hash = createHash('sha256').update(raw).digest('hex');
    // Los ids de evento de Google solo admiten el alfabeto [a-v0-9]; el hex
    // (0-9a-f) es un subconjunto valido. Se prefija con una letra para
    // garantizar que el id nunca empiece por un caracter problematico.
    return `rid${hash.slice(0, 40)}`;
  }

  private mapToCalendarEvent(data: calendar_v3.Schema$Event, profesionalFallback: string | undefined): CalendarEvent {
    const start = data.start?.dateTime ?? data.start?.date;
    const end = data.end?.dateTime ?? data.end?.date;
    if (!data.id || !start || !end) {
      throw new Error('respuesta de Google Calendar incompleta: falta id, start o end');
    }
    return {
      id: data.id,
      start: new Date(start),
      end: new Date(end),
      titulo: data.summary ?? '',
      profesional: profesionalFallback,
    };
  }

  async createEvent(
    clinicId: string,
    event: Omit<CalendarEvent, 'id'>,
    patientPhone: string,
  ): Promise<CalendarEvent> {
    const { api, calendarId, clinic } = await this.resolveClinicCalendar(clinicId);

    // Defensa adicional dentro del cliente: aunque la herramienta de negocio
    // (crear-cita.tool.ts, fuera de este archivo) debe llamar a isSlotFree
    // antes de invocar createEvent, aqui se repite la comprobacion justo
    // antes de escribir. Es la misma llamada de freebusy, asi que es barata,
    // y cierra la ventana de carrera si algo escribio entre la comprobacion
    // de la herramienta y esta llamada.
    const free = await this.isSlotFree(clinicId, event.start, event.end);
    if (!free) {
      throw new Error('horario_no_disponible: el horario dejo de estar libre justo antes de crear la cita');
    }

    const eventId = this.deriveEventId(clinicId, event, patientPhone);
    const descripcionPartes = [`Paciente: ${patientPhone}`];
    if (event.profesional) descripcionPartes.push(`Profesional: ${event.profesional}`);

    const data = await pRetry(
      async () => {
        try {
          const res = await api.events.insert({
            calendarId,
            requestBody: {
              id: eventId,
              summary: event.titulo,
              description: descripcionPartes.join(' | '),
              // toISOString() siempre termina en "Z" (offset explicito) +
              // timeZone IANA de la clinica: ver punto 1 del comentario de
              // cabecera. Nunca se construye esta fecha con el reloj local
              // del servidor.
              start: { dateTime: event.start.toISOString(), timeZone: clinic.timezone },
              end: { dateTime: event.end.toISOString(), timeZone: clinic.timezone },
            },
          });
          return res.data;
        } catch (err) {
          const status = extractHttpStatus(err);
          if (status === 409) {
            // El id ya existe: un intento anterior (quiza este mismo
            // reintento) ya creo la cita, solo que la respuesta no llego a
            // tiempo. NO se crea una segunda cita: se recupera la existente.
            const existing = await api.events.get({ calendarId, eventId });
            return existing.data;
          }
          if (isTransientStatus(status)) {
            throw err; // p-retry reintenta: es seguro porque el id es el mismo
          }
          throw new AbortError(toError(err));
        }
      },
      {
        retries: this.retryOptions.retries,
        minTimeout: this.retryOptions.minTimeout,
        factor: this.retryOptions.factor,
        onFailedAttempt: (ctx) => {
          this.logger.warn(
            { operacion: 'events.insert', intento: ctx.attemptNumber, quedan: ctx.retriesLeft, error: ctx.error.message },
            'reintento de creacion de cita en Google Calendar',
          );
        },
      },
    );

    return this.mapToCalendarEvent(data, event.profesional);
  }

  async cancelEvent(clinicId: string, eventId: string): Promise<void> {
    const { api, calendarId } = await this.resolveClinicCalendar(clinicId);

    await pRetry(
      async () => {
        try {
          await api.events.delete({ calendarId, eventId });
        } catch (err) {
          const status = extractHttpStatus(err);
          // Cancelar es idempotente por naturaleza: si el evento ya no
          // existe (alguien lo borro antes, o un reintento anterior ya
          // funciono), no es un error para quien llama.
          if (status === 404 || status === 410) return;
          if (isTransientStatus(status)) throw err;
          throw new AbortError(toError(err));
        }
      },
      {
        retries: this.retryOptions.retries,
        minTimeout: this.retryOptions.minTimeout,
        factor: this.retryOptions.factor,
      },
    );
  }
}
