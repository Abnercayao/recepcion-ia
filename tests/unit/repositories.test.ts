/**
 * Tests de src/infra/repositories/*.
 *
 * No hay credenciales de Supabase (ni falta que hacen): se sustituye
 * `@supabase/supabase-js` por un doble minimo que reproduce el encadenamiento
 * `from().select().eq()...` sobre una tabla en memoria y aplica los filtros
 * de verdad (no solo registra que se llamaron). Eso permite probar, con
 * confianza real y no solo "se llamo con estos argumentos":
 *
 *  - el mapeo de nombres snake_case <-> camelCase en ambos sentidos;
 *  - la conversion de fechas timestamptz (string ISO) <-> Date en ambos
 *    sentidos;
 *  - que `listByConversation` jamas devuelve mensajes de una conversacion (y
 *    por tanto clinica) distinta de la solicitada, aunque el doble contenga
 *    filas de varias clinicas mezcladas en la misma tabla;
 *  - que un error de Supabase se lanza con contexto y nunca se traga como
 *    `null`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  SupabaseClinicRepository,
  SupabasePatientRepository,
  SupabaseConversationRepository,
  SupabaseMessageRepository,
  SupabaseToolCallRepository,
  SupabaseAuditRepository,
} from '../../src/infra/repositories/index.js';
import type { ToolCallRecord } from '../../src/core/types/index.js';

// ---------------------------------------------------------------------------
// Doble minimo de @supabase/supabase-js
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
}

type SelectOpts = { count?: 'exact'; head?: boolean };
type OrderOpts = { ascending?: boolean };
type OnConflictOpts = { onConflict?: string };

/**
 * Query builder falso. Implementa `then` (PromiseLike) igual que el real de
 * supabase-js: encadenar metodos no ejecuta nada hasta que se hace `await`.
 */
class FakeQueryBuilder implements PromiseLike<FakeResult> {
  private opType: 'select' | 'insert' | 'update' | 'upsert' = 'select';
  private payload: Row | Row[] | undefined;
  private onConflict: string | undefined;
  private readonly filters: Array<(row: Row) => boolean> = [];
  private orderCol: string | undefined;
  private orderAsc = true;
  private limitN: number | undefined;
  private singleMode: 'single' | 'maybeSingle' | undefined;
  private countMode: 'exact' | undefined;
  private headMode = false;

  constructor(
    private readonly table: string,
    private readonly store: Map<string, Row[]>,
    private readonly forcedErrors: Map<string, string>,
    private readonly idSeq: { n: number },
  ) {}

  select(_cols?: string, opts?: SelectOpts): this {
    if (opts?.count) this.countMode = opts.count;
    if (opts?.head) this.headMode = true;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push((row) => row[col] === val);
    return this;
  }

  gte(col: string, val: unknown): this {
    this.filters.push((row) => String(row[col]) >= String(val));
    return this;
  }

  order(col: string, opts?: OrderOpts): this {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  insert(payload: Row | Row[]): this {
    this.opType = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload: Row): this {
    this.opType = 'update';
    this.payload = payload;
    return this;
  }

  upsert(payload: Row, opts?: OnConflictOpts): this {
    this.opType = 'upsert';
    this.payload = payload;
    this.onConflict = opts?.onConflict;
    return this;
  }

  single(): this {
    this.singleMode = 'single';
    return this;
  }

  maybeSingle(): this {
    this.singleMode = 'maybeSingle';
    return this;
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onfulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private rows(): Row[] {
    let rows = this.store.get(this.table);
    if (!rows) {
      rows = [];
      this.store.set(this.table, rows);
    }
    return rows;
  }

  private nextId(): string {
    this.idSeq.n += 1;
    return `id-${this.idSeq.n}`;
  }

  private execute(): FakeResult {
    const forced = this.forcedErrors.get(this.table);
    if (forced) {
      return { data: null, error: { message: forced } };
    }

    const rows = this.rows();

    if (this.opType === 'insert') {
      const items = (Array.isArray(this.payload) ? this.payload : [this.payload as Row]).map((item) => ({
        id: this.nextId(),
        creado_en: new Date().toISOString(),
        ...item,
      }));
      rows.push(...items);
      return { data: this.singleMode ? items[0] : items, error: null };
    }

    if (this.opType === 'upsert') {
      const item = this.payload as Row;
      const conflictCols = (this.onConflict ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const existing = conflictCols.length > 0 ? rows.find((row) => conflictCols.every((c) => row[c] === item[c])) : undefined;
      let result: Row;
      if (existing) {
        Object.assign(existing, item);
        result = existing;
      } else {
        result = { id: this.nextId(), creado_en: new Date().toISOString(), ...item };
        rows.push(result);
      }
      return { data: this.singleMode ? result : [result], error: null };
    }

    if (this.opType === 'update') {
      const matched = rows.filter((row) => this.filters.every((f) => f(row)));
      matched.forEach((row) => Object.assign(row, this.payload as Row));
      return { data: this.singleMode ? (matched[0] ?? null) : matched, error: null };
    }

    // select
    let matched = rows.filter((row) => this.filters.every((f) => f(row)));

    if (this.countMode) {
      const count = matched.length;
      return { data: this.headMode ? null : matched, error: null, count };
    }

    if (this.orderCol) {
      const col = this.orderCol;
      const asc = this.orderAsc;
      matched = [...matched].sort((a, b) => {
        const av = String(a[col]);
        const bv = String(b[col]);
        if (av < bv) return asc ? -1 : 1;
        if (av > bv) return asc ? 1 : -1;
        return 0;
      });
    }

    if (this.limitN !== undefined) {
      matched = matched.slice(0, this.limitN);
    }

    if (this.singleMode === 'single') {
      return matched[0] ? { data: matched[0], error: null } : { data: null, error: { message: 'no existe la fila' } };
    }
    if (this.singleMode === 'maybeSingle') {
      return { data: matched[0] ?? null, error: null };
    }
    return { data: matched, error: null };
  }
}

class FakeSupabaseClient {
  readonly store = new Map<string, Row[]>();
  readonly forcedErrors = new Map<string, string>();
  private readonly idSeq = { n: 0 };

  from(table: string): FakeQueryBuilder {
    return new FakeQueryBuilder(table, this.store, this.forcedErrors, this.idSeq);
  }

  seed(table: string, rows: Row[]): void {
    this.store.set(table, [...rows]);
  }

  forceError(table: string, message: string): void {
    this.forcedErrors.set(table, message);
  }

  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

// ---------------------------------------------------------------------------
// ClinicRepository
// ---------------------------------------------------------------------------

describe('SupabaseClinicRepository', () => {
  let fake: FakeSupabaseClient;

  beforeEach(() => {
    fake = new FakeSupabaseClient();
  });

  it('mapea snake_case a camelCase, con defaults para config y transfer_whitelist nulos', async () => {
    fake.seed('clinics', [
      {
        id: 'clinica-1',
        nombre: 'Clinica Demo',
        timezone: 'America/Lima',
        config: null,
        retencion_transcripcion_dias: 365,
        retencion_audio_dias: 0,
        transfer_whitelist: null,
      },
    ]);
    const repo = new SupabaseClinicRepository(fake.asClient());

    const clinic = await repo.findById('clinica-1');

    expect(clinic).toEqual({
      id: 'clinica-1',
      nombre: 'Clinica Demo',
      timezone: 'America/Lima',
      config: {},
      retencionTranscripcionDias: 365,
      retencionAudioDias: 0,
      transferWhitelist: [],
    });
  });

  it('devuelve null si la clinica no existe (nunca lanza por "no encontrado")', async () => {
    const repo = new SupabaseClinicRepository(fake.asClient());
    await expect(repo.findById('no-existe')).resolves.toBeNull();
  });

  it('lanza con contexto de tabla/operacion ante un fallo real de infraestructura', async () => {
    fake.forceError('clinics', 'conexion perdida');
    const repo = new SupabaseClinicRepository(fake.asClient());

    await expect(repo.findById('clinica-1')).rejects.toThrow(/clinics\.findById/);
    await expect(repo.findById('clinica-1')).rejects.toThrow(/conexion perdida/);
  });
});

// ---------------------------------------------------------------------------
// PatientRepository
// ---------------------------------------------------------------------------

describe('SupabasePatientRepository', () => {
  let fake: FakeSupabaseClient;

  beforeEach(() => {
    fake = new FakeSupabaseClient();
  });

  it('crea un paciente nuevo y mapea fechas de consentimiento ausentes como undefined', async () => {
    const repo = new SupabasePatientRepository(fake.asClient());

    const patient = await repo.upsert('clinica-1', '+51987654321', 'Maria Lopez');

    expect(patient.clinicId).toBe('clinica-1');
    expect(patient.telefonoE164).toBe('+51987654321');
    expect(patient.nombre).toBe('Maria Lopez');
    expect(patient.consentimientoAt).toBeUndefined();
    expect(patient.consentimientoCanal).toBeUndefined();
  });

  it('usa onConflict (clinic_id, telefono_e164): un segundo upsert actualiza, no duplica', async () => {
    const repo = new SupabasePatientRepository(fake.asClient());

    const first = await repo.upsert('clinica-1', '+51987654321', 'Maria Lopez');
    const second = await repo.upsert('clinica-1', '+51987654321', 'Maria Lopez Corregido');

    expect(second.id).toBe(first.id); // misma fila, no una nueva
    expect(second.nombre).toBe('Maria Lopez Corregido');
    expect(fake.store.get('patients')).toHaveLength(1);
  });

  it('no borra el nombre existente cuando el nuevo upsert llega sin nombre', async () => {
    const repo = new SupabasePatientRepository(fake.asClient());

    await repo.upsert('clinica-1', '+51987654321', 'Maria Lopez');
    const second = await repo.upsert('clinica-1', '+51987654321'); // sin nombre

    expect(second.nombre).toBe('Maria Lopez');
  });

  it('convierte consentimiento_at (string ISO) a Date', async () => {
    fake.seed('patients', [
      {
        id: 'pac-1',
        clinic_id: 'clinica-1',
        telefono_e164: '+51987654321',
        nombre: 'Maria',
        consentimiento_at: '2026-01-15T10:00:00.000Z',
        consentimiento_canal: 'whatsapp',
      },
    ]);
    const repo = new SupabasePatientRepository(fake.asClient());

    const patient = await repo.upsert('clinica-1', '+51987654321');

    expect(patient.consentimientoAt).toBeInstanceOf(Date);
    expect(patient.consentimientoAt?.toISOString()).toBe('2026-01-15T10:00:00.000Z');
    expect(patient.consentimientoCanal).toBe('whatsapp');
  });

  it('lanza con contexto ante un fallo de infraestructura', async () => {
    fake.forceError('patients', 'timeout');
    const repo = new SupabasePatientRepository(fake.asClient());

    await expect(repo.upsert('clinica-1', '+51987654321')).rejects.toThrow(/patients\.upsert/);
  });
});

// ---------------------------------------------------------------------------
// ConversationRepository
// ---------------------------------------------------------------------------

describe('SupabaseConversationRepository', () => {
  let fake: FakeSupabaseClient;

  beforeEach(() => {
    fake = new FakeSupabaseClient();
  });

  it('create() fija canal_origen y ultimo_canal al mismo canal, y mapea la fila resultante', async () => {
    const repo = new SupabaseConversationRepository(fake.asClient());

    const conv = await repo.create('clinica-1', 'paciente-1', 'whatsapp');

    expect(conv.clinicId).toBe('clinica-1');
    expect(conv.patientId).toBe('paciente-1');
    expect(conv.canalOrigen).toBe('whatsapp');
    expect(conv.ultimoCanal).toBe('whatsapp');
    expect(conv.iniciadaEn).toBeInstanceOf(Date);
    expect(conv.ultimaActividad).toBeInstanceOf(Date);
    expect(conv.escaladaEn).toBeUndefined();
    expect(conv.escaladaMotivo).toBeUndefined();
  });

  it('findActiveWithin filtra por clinic_id + patient_id + estado=activa + ventana, y toma la mas reciente', async () => {
    fake.seed('conversations', [
      {
        id: 'conv-vieja',
        clinic_id: 'clinica-1',
        patient_id: 'paciente-1',
        estado: 'activa',
        canal_origen: 'whatsapp',
        ultimo_canal: 'whatsapp',
        iniciada_en: '2026-01-01T00:00:00.000Z',
        ultima_actividad: '2026-01-01T01:00:00.000Z',
        escalada_en: null,
        escalada_motivo: null,
      },
      {
        id: 'conv-reciente',
        clinic_id: 'clinica-1',
        patient_id: 'paciente-1',
        estado: 'activa',
        canal_origen: 'voice',
        ultimo_canal: 'voice',
        iniciada_en: '2026-01-02T00:00:00.000Z',
        ultima_actividad: '2026-01-02T05:00:00.000Z',
        escalada_en: null,
        escalada_motivo: null,
      },
      {
        // otra clinica, mismo patient_id: NUNCA debe ganar ni aparecer
        id: 'conv-otra-clinica',
        clinic_id: 'clinica-2',
        patient_id: 'paciente-1',
        estado: 'activa',
        canal_origen: 'voice',
        ultimo_canal: 'voice',
        iniciada_en: '2026-01-03T00:00:00.000Z',
        ultima_actividad: '2026-01-03T00:00:00.000Z',
        escalada_en: null,
        escalada_motivo: null,
      },
      {
        // misma clinica y paciente, pero cerrada: no cuenta como activa
        id: 'conv-cerrada',
        clinic_id: 'clinica-1',
        patient_id: 'paciente-1',
        estado: 'cerrada',
        canal_origen: 'voice',
        ultimo_canal: 'voice',
        iniciada_en: '2026-01-04T00:00:00.000Z',
        ultima_actividad: '2026-01-04T23:00:00.000Z',
        escalada_en: null,
        escalada_motivo: null,
      },
    ]);
    const repo = new SupabaseConversationRepository(fake.asClient());

    const found = await repo.findActiveWithin('clinica-1', 'paciente-1', new Date('2025-12-01T00:00:00.000Z'));

    expect(found?.id).toBe('conv-reciente');
  });

  it('findActiveWithin devuelve null fuera de la ventana de continuidad', async () => {
    fake.seed('conversations', [
      {
        id: 'conv-1',
        clinic_id: 'clinica-1',
        patient_id: 'paciente-1',
        estado: 'activa',
        canal_origen: 'whatsapp',
        ultimo_canal: 'whatsapp',
        iniciada_en: '2026-01-01T00:00:00.000Z',
        ultima_actividad: '2026-01-01T00:00:00.000Z',
        escalada_en: null,
        escalada_motivo: null,
      },
    ]);
    const repo = new SupabaseConversationRepository(fake.asClient());

    const found = await repo.findActiveWithin('clinica-1', 'paciente-1', new Date('2026-01-10T00:00:00.000Z'));

    expect(found).toBeNull();
  });

  it('touch() actualiza ultimo_canal y ultima_actividad por id', async () => {
    fake.seed('conversations', [
      {
        id: 'conv-1',
        clinic_id: 'clinica-1',
        patient_id: 'paciente-1',
        estado: 'activa',
        canal_origen: 'whatsapp',
        ultimo_canal: 'whatsapp',
        iniciada_en: '2026-01-01T00:00:00.000Z',
        ultima_actividad: '2026-01-01T00:00:00.000Z',
        escalada_en: null,
        escalada_motivo: null,
      },
    ]);
    const repo = new SupabaseConversationRepository(fake.asClient());

    await repo.touch('conv-1', 'voice');

    const row = fake.store.get('conversations')?.[0];
    expect(row?.ultimo_canal).toBe('voice');
    expect(row?.ultima_actividad).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('markEscalated() fija estado, escalada_en y escalada_motivo', async () => {
    fake.seed('conversations', [
      {
        id: 'conv-1',
        clinic_id: 'clinica-1',
        patient_id: 'paciente-1',
        estado: 'activa',
        canal_origen: 'whatsapp',
        ultimo_canal: 'whatsapp',
        iniciada_en: '2026-01-01T00:00:00.000Z',
        ultima_actividad: '2026-01-01T00:00:00.000Z',
        escalada_en: null,
        escalada_motivo: null,
      },
    ]);
    const repo = new SupabaseConversationRepository(fake.asClient());

    await repo.markEscalated('conv-1', 'peticion_humano');

    const row = fake.store.get('conversations')?.[0];
    expect(row?.estado).toBe('escalada');
    expect(row?.escalada_motivo).toBe('peticion_humano');
    expect(row?.escalada_en).toBeTruthy();
  });

  it('lanza con contexto ante un fallo de infraestructura en cada metodo', async () => {
    fake.forceError('conversations', 'db caida');
    const repo = new SupabaseConversationRepository(fake.asClient());

    await expect(repo.findActiveWithin('c', 'p', new Date())).rejects.toThrow(/findActiveWithin/);
    await expect(repo.create('c', 'p', 'whatsapp')).rejects.toThrow(/conversations\.create/);
    await expect(repo.touch('conv-1', 'voice')).rejects.toThrow(/conversations\.touch/);
    await expect(repo.markEscalated('conv-1', 'x')).rejects.toThrow(/conversations\.markEscalated/);
  });
});

// ---------------------------------------------------------------------------
// MessageRepository
// ---------------------------------------------------------------------------

describe('SupabaseMessageRepository', () => {
  let fake: FakeSupabaseClient;

  beforeEach(() => {
    fake = new FakeSupabaseClient();
  });

  it('append() mapea la fila insertada, con campos opcionales undefined cuando vienen null', async () => {
    const repo = new SupabaseMessageRepository(fake.asClient());

    const msg = await repo.append({
      conversationId: 'conv-1',
      rol: 'user',
      contenido: 'hola',
      canal: 'whatsapp',
    });

    expect(msg.conversationId).toBe('conv-1');
    expect(msg.rol).toBe('user');
    expect(msg.contenido).toBe('hola');
    expect(msg.canal).toBe('whatsapp');
    expect(msg.sessionId).toBeUndefined();
    expect(msg.tokensIn).toBeUndefined();
    expect(msg.tokensOut).toBeUndefined();
    expect(msg.latenciaMs).toBeUndefined();
    expect(msg.creadoEn).toBeInstanceOf(Date);
  });

  it('CRITICO: listByConversation NUNCA devuelve mensajes de otra conversacion/clinica', async () => {
    fake.seed('messages', [
      {
        id: 'msg-a1',
        conversation_id: 'conv-clinica-1',
        rol: 'user',
        contenido: 'mensaje de la clinica 1',
        canal: 'whatsapp',
        session_id: null,
        tokens_in: null,
        tokens_out: null,
        latencia_ms: null,
        creado_en: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'msg-b1',
        conversation_id: 'conv-clinica-2',
        rol: 'user',
        contenido: 'mensaje de la clinica 2 - JAMAS debe aparecer',
        canal: 'whatsapp',
        session_id: null,
        tokens_in: null,
        tokens_out: null,
        latencia_ms: null,
        creado_en: '2026-01-01T00:00:01.000Z',
      },
    ]);
    const repo = new SupabaseMessageRepository(fake.asClient());

    const messages = await repo.listByConversation('conv-clinica-1');

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe('msg-a1');
    expect(messages.some((m) => m.conversationId === 'conv-clinica-2')).toBe(false);
  });

  it('devuelve el historial en orden cronologico ascendente', async () => {
    fake.seed('messages', [
      {
        id: 'msg-3',
        conversation_id: 'conv-1',
        rol: 'assistant',
        contenido: 'tercero',
        canal: 'voice',
        session_id: null,
        tokens_in: null,
        tokens_out: null,
        latencia_ms: null,
        creado_en: '2026-01-01T00:00:03.000Z',
      },
      {
        id: 'msg-1',
        conversation_id: 'conv-1',
        rol: 'user',
        contenido: 'primero',
        canal: 'voice',
        session_id: null,
        tokens_in: null,
        tokens_out: null,
        latencia_ms: null,
        creado_en: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 'msg-2',
        conversation_id: 'conv-1',
        rol: 'assistant',
        contenido: 'segundo',
        canal: 'voice',
        session_id: null,
        tokens_in: null,
        tokens_out: null,
        latencia_ms: null,
        creado_en: '2026-01-01T00:00:02.000Z',
      },
    ]);
    const repo = new SupabaseMessageRepository(fake.asClient());

    const messages = await repo.listByConversation('conv-1');

    expect(messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
  });

  it('con limit, conserva los N mensajes MAS RECIENTES, no los mas antiguos', async () => {
    fake.seed(
      'messages',
      [1, 2, 3, 4].map((n) => ({
        id: `msg-${n}`,
        conversation_id: 'conv-1',
        rol: 'user',
        contenido: `numero ${n}`,
        canal: 'voice',
        session_id: null,
        tokens_in: null,
        tokens_out: null,
        latencia_ms: null,
        creado_en: `2026-01-01T00:00:0${n}.000Z`,
      })),
    );
    const repo = new SupabaseMessageRepository(fake.asClient());

    const messages = await repo.listByConversation('conv-1', 2);

    // Los dos mas recientes (3 y 4), devueltos en orden ascendente.
    expect(messages.map((m) => m.id)).toEqual(['msg-3', 'msg-4']);
  });

  it('lanza con contexto ante un fallo de infraestructura', async () => {
    fake.forceError('messages', 'red caida');
    const repo = new SupabaseMessageRepository(fake.asClient());

    await expect(
      repo.append({ conversationId: 'conv-1', rol: 'user', contenido: 'x', canal: 'whatsapp' }),
    ).rejects.toThrow(/messages\.append/);
    await expect(repo.listByConversation('conv-1')).rejects.toThrow(/messages\.listByConversation/);
  });
});

// ---------------------------------------------------------------------------
// ToolCallRepository
// ---------------------------------------------------------------------------

describe('SupabaseToolCallRepository', () => {
  let fake: FakeSupabaseClient;

  beforeEach(() => {
    fake = new FakeSupabaseClient();
  });

  function makeCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
    return {
      conversationId: 'conv-1',
      herramienta: 'consultar_agenda',
      argumentosEnmascarados: { especialidad: 'odontologia' },
      estado: 'ok',
      latenciaMs: 120,
      ...overrides,
    };
  }

  it('record() inserta con message_id null cuando no viene informado', async () => {
    const repo = new SupabaseToolCallRepository(fake.asClient());

    await repo.record(makeCall());

    const row = fake.store.get('tool_calls')?.[0];
    expect(row?.conversation_id).toBe('conv-1');
    expect(row?.herramienta).toBe('consultar_agenda');
    expect(row?.argumentos_enmascarados).toEqual({ especialidad: 'odontologia' });
    expect(row?.estado).toBe('ok');
    expect(row?.message_id).toBeNull();
  });

  it('countByTool cuenta solo por (conversation_id, herramienta) exactos, sin traer filas (head)', async () => {
    fake.seed('tool_calls', [
      { id: '1', conversation_id: 'conv-1', herramienta: 'consultar_agenda', estado: 'ok' },
      { id: '2', conversation_id: 'conv-1', herramienta: 'consultar_agenda', estado: 'ok' },
      { id: '3', conversation_id: 'conv-1', herramienta: 'crear_cita', estado: 'ok' }, // otra herramienta
      { id: '4', conversation_id: 'conv-2', herramienta: 'consultar_agenda', estado: 'ok' }, // otra conversacion
    ]);
    const repo = new SupabaseToolCallRepository(fake.asClient());

    const count = await repo.countByTool('conv-1', 'consultar_agenda');

    expect(count).toBe(2);
  });

  it('countByTool devuelve 0 cuando no hay llamadas previas', async () => {
    const repo = new SupabaseToolCallRepository(fake.asClient());
    await expect(repo.countByTool('conv-nueva', 'crear_cita')).resolves.toBe(0);
  });

  it('lanza con contexto ante un fallo de infraestructura', async () => {
    fake.forceError('tool_calls', 'error de escritura');
    const repo = new SupabaseToolCallRepository(fake.asClient());

    await expect(repo.record(makeCall())).rejects.toThrow(/tool_calls\.record/);
    await expect(repo.countByTool('conv-1', 'crear_cita')).rejects.toThrow(/tool_calls\.countByTool/);
  });
});

// ---------------------------------------------------------------------------
// AuditRepository
// ---------------------------------------------------------------------------

describe('SupabaseAuditRepository', () => {
  let fake: FakeSupabaseClient;

  beforeEach(() => {
    fake = new FakeSupabaseClient();
  });

  it('log() inserta evento y detalle enmascarado, con clinic_id/conversation_id null si se omiten', async () => {
    const repo = new SupabaseAuditRepository(fake.asClient());

    await repo.log('escalamiento', { motivo: 'urgencia' });

    const row = fake.store.get('audit_log')?.[0];
    expect(row?.evento).toBe('escalamiento');
    expect(row?.detalle_enmascarado).toEqual({ motivo: 'urgencia' });
    expect(row?.clinic_id).toBeNull();
    expect(row?.conversation_id).toBeNull();
  });

  it('log() persiste clinic_id y conversation_id cuando se informan', async () => {
    const repo = new SupabaseAuditRepository(fake.asClient());

    await repo.log('tool_call', { herramienta: 'crear_cita' }, 'clinica-1', 'conv-1');

    const row = fake.store.get('audit_log')?.[0];
    expect(row?.clinic_id).toBe('clinica-1');
    expect(row?.conversation_id).toBe('conv-1');
  });

  it('lanza con contexto ante un fallo de infraestructura, nunca traga el error', async () => {
    fake.forceError('audit_log', 'permiso denegado');
    const repo = new SupabaseAuditRepository(fake.asClient());

    await expect(repo.log('evento', {})).rejects.toThrow(/audit_log\.log/);
  });
});
