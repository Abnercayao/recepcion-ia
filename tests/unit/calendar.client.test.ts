/**
 * Tests de src/infra/calendar.client.ts.
 *
 * No hay credenciales reales de Google: se inyecta un doble de transporte
 * (`calendarApiFactory`) que nunca toca la red. Se prueba sobre todo:
 *  - conversion de zona horaria (RFC3339 + IANA, sin desplazar la hora);
 *  - logica de huecos libres a partir de freebusy;
 *  - que isSlotFree consulte SIEMPRE fresco (nunca cacheado);
 *  - idempotencia de createEvent (id determinista, manejo de 409, reintento
 *    de errores transitorios, aborto de errores no transitorios);
 *  - idempotencia de cancelEvent ante 404.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { calendar_v3 } from 'googleapis';
import {
  GoogleCalendarClient,
  parseGoogleCredentials,
  type CalendarApiFactory,
} from '../../src/infra/calendar.client.js';
import type { Clinic, ClinicRepository, Logger } from '../../src/core/types/index.js';

function fakeLogger(): Logger {
  const self: Logger = {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => self),
  };
  return self;
}

const FAKE_CREDENTIALS = JSON.stringify({
  client_email: 'servicio@proyecto.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nFAKEKEY\n-----END PRIVATE KEY-----\n',
});

function makeClinic(overrides: Partial<Clinic> = {}): Clinic {
  return {
    id: 'clinica-1',
    nombre: 'Clinica de prueba',
    timezone: 'America/Lima',
    config: { googleCalendarId: 'calendario-clinica-1@group.calendar.google.com' },
    retencionTranscripcionDias: 365,
    retencionAudioDias: 0,
    transferWhitelist: [],
    ...overrides,
  };
}

function fakeClinicRepository(clinic: Clinic | null): ClinicRepository {
  return {
    findById: vi.fn(async () => clinic),
  };
}

interface FakeApi {
  freebusy: { query: ReturnType<typeof vi.fn> };
  events: {
    insert: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
}

function fakeCalendarApi(): FakeApi {
  return {
    freebusy: { query: vi.fn() },
    events: { insert: vi.fn(), get: vi.fn(), delete: vi.fn() },
  };
}

/** Reintentos instantaneos: los tests no deben esperar los backoffs reales. */
const FAST_RETRY = { retries: 2, minTimeout: 0, factor: 1 };

function buildClient(clinic: Clinic | null, api: FakeApi) {
  const clinicRepository = fakeClinicRepository(clinic);
  const logger = fakeLogger();
  const calendarApiFactory: CalendarApiFactory = () => api as unknown as ReturnType<CalendarApiFactory>;
  const client = new GoogleCalendarClient(
    clinicRepository,
    { GOOGLE_CALENDAR_CREDENTIALS: FAKE_CREDENTIALS },
    logger,
    { calendarApiFactory, retryOptions: FAST_RETRY },
  );
  return { client, clinicRepository, logger };
}

describe('parseGoogleCredentials', () => {
  it('parsea JSON literal', () => {
    const creds = parseGoogleCredentials(FAKE_CREDENTIALS);
    expect(creds.client_email).toBe('servicio@proyecto.iam.gserviceaccount.com');
  });

  it('parsea el mismo JSON codificado en base64', () => {
    const b64 = Buffer.from(FAKE_CREDENTIALS, 'utf8').toString('base64');
    const creds = parseGoogleCredentials(b64);
    expect(creds.client_email).toBe('servicio@proyecto.iam.gserviceaccount.com');
  });

  it('lanza si no es JSON valido ni base64 de JSON valido', () => {
    expect(() => parseGoogleCredentials('no-es-json-ni-base64-valido-@@@')).toThrow();
  });

  it('lanza si falta private_key', () => {
    const incompleto = JSON.stringify({ client_email: 'x@y.com' });
    expect(() => parseGoogleCredentials(incompleto)).toThrow(/private_key/);
  });
});

describe('GoogleCalendarClient - resolucion de clinica', () => {
  it('lanza si la clinica no existe', async () => {
    const { client } = buildClient(null, fakeCalendarApi());
    await expect(client.isSlotFree('clinica-x', new Date(), new Date())).rejects.toThrow(/no encontrada/);
  });

  it('lanza si clinic.config no trae googleCalendarId', async () => {
    const clinic = makeClinic({ config: {} });
    const { client } = buildClient(clinic, fakeCalendarApi());
    await expect(client.isSlotFree('clinica-1', new Date(), new Date())).rejects.toThrow(/googleCalendarId/);
  });
});

describe('GoogleCalendarClient.findAvailableSlots', () => {
  let api: FakeApi;

  beforeEach(() => {
    api = fakeCalendarApi();
  });

  it('usa RFC3339 con offset explicito + IANA de la clinica, sin desplazar la hora', async () => {
    api.freebusy.query.mockResolvedValue({
      data: { calendars: { 'calendario-clinica-1@group.calendar.google.com': { busy: [] } } },
    });
    const clinic = makeClinic();
    const { client } = buildClient(clinic, api);

    // 2026-08-03 14:00 UTC == 2026-08-03 09:00 America/Lima (UTC-5)
    const from = new Date('2026-08-03T14:00:00.000Z');
    const to = new Date('2026-08-03T15:00:00.000Z');

    await client.findAvailableSlots('clinica-1', from, to, 30);

    expect(api.freebusy.query).toHaveBeenCalledWith({
      requestBody: {
        timeMin: '2026-08-03T14:00:00.000Z',
        timeMax: '2026-08-03T15:00:00.000Z',
        timeZone: 'America/Lima',
        items: [{ id: 'calendario-clinica-1@group.calendar.google.com' }],
      },
    });
  });

  it('devuelve huecos libres de 30 min descontando los intervalos ocupados de freebusy', async () => {
    // Rango de 14:00 a 16:00 UTC, ocupado de 14:30 a 15:00 UTC.
    api.freebusy.query.mockResolvedValue({
      data: {
        calendars: {
          'calendario-clinica-1@group.calendar.google.com': {
            busy: [{ start: '2026-08-03T14:30:00.000Z', end: '2026-08-03T15:00:00.000Z' }],
          },
        },
      },
    });
    const { client } = buildClient(makeClinic(), api);

    const slots = await client.findAvailableSlots(
      'clinica-1',
      new Date('2026-08-03T14:00:00.000Z'),
      new Date('2026-08-03T16:00:00.000Z'),
      30,
    );

    // Candidatos: [14:00-14:30] libre, [14:30-15:00] ocupado, [15:00-15:30] libre, [15:30-16:00] libre
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      '2026-08-03T14:00:00.000Z',
      '2026-08-03T15:00:00.000Z',
      '2026-08-03T15:30:00.000Z',
    ]);
  });

  it('excluye un candidato que se solapa parcialmente con un bloque ocupado', async () => {
    // Ocupado 14:15-14:45 solapa parcialmente el candidato [14:00-14:30] y [14:30-15:00]
    api.freebusy.query.mockResolvedValue({
      data: {
        calendars: {
          'calendario-clinica-1@group.calendar.google.com': {
            busy: [{ start: '2026-08-03T14:15:00.000Z', end: '2026-08-03T14:45:00.000Z' }],
          },
        },
      },
    });
    const { client } = buildClient(makeClinic(), api);

    const slots = await client.findAvailableSlots(
      'clinica-1',
      new Date('2026-08-03T14:00:00.000Z'),
      new Date('2026-08-03T15:00:00.000Z'),
      30,
    );

    expect(slots).toHaveLength(0);
  });

  it('no devuelve un candidato parcial que no completa la duracion pedida', async () => {
    api.freebusy.query.mockResolvedValue({ data: { calendars: {} } });
    const { client } = buildClient(makeClinic(), api);

    // Rango de 45 min, slots de 30 min: solo cabe 1 candidato completo.
    const slots = await client.findAvailableSlots(
      'clinica-1',
      new Date('2026-08-03T14:00:00.000Z'),
      new Date('2026-08-03T14:45:00.000Z'),
      30,
    );

    expect(slots).toHaveLength(1);
  });
});

describe('GoogleCalendarClient.isSlotFree', () => {
  it('devuelve true cuando freebusy no reporta bloques ocupados', async () => {
    const api = fakeCalendarApi();
    api.freebusy.query.mockResolvedValue({ data: { calendars: { cal: { busy: [] } } } });
    const clinic = makeClinic({ config: { googleCalendarId: 'cal' } });
    const { client } = buildClient(clinic, api);

    const free = await client.isSlotFree(
      'clinica-1',
      new Date('2026-08-03T14:00:00.000Z'),
      new Date('2026-08-03T14:30:00.000Z'),
    );
    expect(free).toBe(true);
  });

  it('devuelve false cuando freebusy reporta un bloque ocupado', async () => {
    const api = fakeCalendarApi();
    api.freebusy.query.mockResolvedValue({
      data: { calendars: { cal: { busy: [{ start: '2026-08-03T14:00:00.000Z', end: '2026-08-03T14:30:00.000Z' }] } } },
    });
    const clinic = makeClinic({ config: { googleCalendarId: 'cal' } });
    const { client } = buildClient(clinic, api);

    const free = await client.isSlotFree(
      'clinica-1',
      new Date('2026-08-03T14:00:00.000Z'),
      new Date('2026-08-03T14:30:00.000Z'),
    );
    expect(free).toBe(false);
  });

  it('consulta la API de forma fresca en cada llamada: nunca cachea el resultado', async () => {
    const api = fakeCalendarApi();
    api.freebusy.query.mockResolvedValue({ data: { calendars: { cal: { busy: [] } } } });
    const clinic = makeClinic({ config: { googleCalendarId: 'cal' } });
    const { client } = buildClient(clinic, api);

    await client.isSlotFree('clinica-1', new Date('2026-08-03T14:00:00.000Z'), new Date('2026-08-03T14:30:00.000Z'));
    await client.isSlotFree('clinica-1', new Date('2026-08-03T14:00:00.000Z'), new Date('2026-08-03T14:30:00.000Z'));

    expect(api.freebusy.query).toHaveBeenCalledTimes(2);
  });
});

describe('GoogleCalendarClient.createEvent', () => {
  const clinic = makeClinic({ config: { googleCalendarId: 'cal' } });
  const event = {
    start: new Date('2026-08-03T14:00:00.000Z'),
    end: new Date('2026-08-03T14:30:00.000Z'),
    titulo: 'Consulta general',
    profesional: 'Dra. Rojas',
  };

  it('crea la cita con dateTime RFC3339 (offset explicito) + timeZone IANA de la clinica', async () => {
    const api = fakeCalendarApi();
    api.freebusy.query.mockResolvedValue({ data: { calendars: { cal: { busy: [] } } } });
    api.events.insert.mockResolvedValue({
      data: {
        id: 'evt-1',
        summary: event.titulo,
        start: { dateTime: event.start.toISOString(), timeZone: 'America/Lima' },
        end: { dateTime: event.end.toISOString(), timeZone: 'America/Lima' },
      },
    });
    const { client } = buildClient(clinic, api);

    const created = await client.createEvent('clinica-1', event, '+51987654321');

    expect(created.id).toBe('evt-1');
    expect(created.start.toISOString()).toBe('2026-08-03T14:00:00.000Z');
    expect(created.end.toISOString()).toBe('2026-08-03T14:30:00.000Z');

    const insertCall = api.events.insert.mock.calls[0]![0] as {
      calendarId: string;
      requestBody: calendar_v3.Schema$Event;
    };
    expect(insertCall.calendarId).toBe('cal');
    expect(insertCall.requestBody.start).toEqual({ dateTime: '2026-08-03T14:00:00.000Z', timeZone: 'America/Lima' });
    expect(insertCall.requestBody.end).toEqual({ dateTime: '2026-08-03T14:30:00.000Z', timeZone: 'America/Lima' });
  });

  it('deriva el mismo id de evento para la misma cita logica (idempotencia)', async () => {
    const api = fakeCalendarApi();
    api.freebusy.query.mockResolvedValue({ data: { calendars: { cal: { busy: [] } } } });
    api.events.insert.mockResolvedValue({ data: { id: 'evt-1', summary: 't', start: { dateTime: event.start.toISOString() }, end: { dateTime: event.end.toISOString() } } });

    const { client: clientA } = buildClient(clinic, api);
    await clientA.createEvent('clinica-1', event, '+51987654321');
    const idPrimeraLlamada = (api.events.insert.mock.calls[0]![0] as { requestBody: { id?: string } }).requestBody.id;

    // Instancia NUEVA del cliente (simula un reintento tras reiniciar el proceso): mismo id esperado.
    const { client: clientB } = buildClient(clinic, api);
    await clientB.createEvent('clinica-1', event, '+51987654321');
    const idSegundaLlamada = (api.events.insert.mock.calls[1]![0] as { requestBody: { id?: string } }).requestBody.id;

    expect(idPrimeraLlamada).toBeDefined();
    expect(idPrimeraLlamada).toBe(idSegundaLlamada);
    expect(idPrimeraLlamada).toMatch(/^[a-v0-9]+$/); // alfabeto valido para ids de evento de Google
  });

  it('ante un 409 (evento ya creado por un intento anterior) recupera el existente en vez de duplicar', async () => {
    const api = fakeCalendarApi();
    api.freebusy.query.mockResolvedValue({ data: { calendars: { cal: { busy: [] } } } });
    api.events.insert.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
    api.events.get.mockResolvedValue({
      data: { id: 'evt-existente', summary: event.titulo, start: { dateTime: event.start.toISOString() }, end: { dateTime: event.end.toISOString() } },
    });
    const { client } = buildClient(clinic, api);

    const created = await client.createEvent('clinica-1', event, '+51987654321');

    expect(created.id).toBe('evt-existente');
    expect(api.events.insert).toHaveBeenCalledTimes(1); // NO se reintento el insert ante el 409
    expect(api.events.get).toHaveBeenCalledTimes(1);
  });

  it('reintenta un error transitorio (503) y termina creando la cita', async () => {
    const api = fakeCalendarApi();
    api.freebusy.query.mockResolvedValue({ data: { calendars: { cal: { busy: [] } } } });
    api.events.insert
      .mockRejectedValueOnce(Object.assign(new Error('temporal'), { status: 503 }))
      .mockResolvedValueOnce({
        data: { id: 'evt-1', summary: event.titulo, start: { dateTime: event.start.toISOString() }, end: { dateTime: event.end.toISOString() } },
      });
    const { client } = buildClient(clinic, api);

    const created = await client.createEvent('clinica-1', event, '+51987654321');

    expect(created.id).toBe('evt-1');
    expect(api.events.insert).toHaveBeenCalledTimes(2);
  });

  it('NO reintenta un error no transitorio (400) y lo propaga', async () => {
    const api = fakeCalendarApi();
    api.freebusy.query.mockResolvedValue({ data: { calendars: { cal: { busy: [] } } } });
    api.events.insert.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));
    const { client } = buildClient(clinic, api);

    await expect(client.createEvent('clinica-1', event, '+51987654321')).rejects.toThrow();
    expect(api.events.insert).toHaveBeenCalledTimes(1);
  });

  it('rechaza crear la cita si isSlotFree fresco dice que ya no esta libre', async () => {
    const api = fakeCalendarApi();
    api.freebusy.query.mockResolvedValue({
      data: { calendars: { cal: { busy: [{ start: event.start.toISOString(), end: event.end.toISOString() }] } } },
    });
    const { client } = buildClient(clinic, api);

    await expect(client.createEvent('clinica-1', event, '+51987654321')).rejects.toThrow(/horario_no_disponible/);
    expect(api.events.insert).not.toHaveBeenCalled();
  });
});

describe('GoogleCalendarClient.cancelEvent', () => {
  it('llama a events.delete con el calendarId de la clinica', async () => {
    const api = fakeCalendarApi();
    api.events.delete.mockResolvedValue(undefined);
    const clinic = makeClinic({ config: { googleCalendarId: 'cal' } });
    const { client } = buildClient(clinic, api);

    await client.cancelEvent('clinica-1', 'evt-1');

    expect(api.events.delete).toHaveBeenCalledWith({ calendarId: 'cal', eventId: 'evt-1' });
  });

  it('no lanza si el evento ya no existe (404): cancelar es idempotente', async () => {
    const api = fakeCalendarApi();
    api.events.delete.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const clinic = makeClinic({ config: { googleCalendarId: 'cal' } });
    const { client } = buildClient(clinic, api);

    await expect(client.cancelEvent('clinica-1', 'evt-1')).resolves.toBeUndefined();
  });

  it('propaga un error no transitorio distinto de 404/410', async () => {
    const api = fakeCalendarApi();
    api.events.delete.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const clinic = makeClinic({ config: { googleCalendarId: 'cal' } });
    const { client } = buildClient(clinic, api);

    await expect(client.cancelEvent('clinica-1', 'evt-1')).rejects.toThrow();
  });
});
