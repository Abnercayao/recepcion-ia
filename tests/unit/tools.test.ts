import { describe, expect, it, vi } from 'vitest';
import type {
  AuditRepository,
  CalendarPort,
  ConversationRepository,
  Logger,
  NotificationPort,
  RagPort,
  ToolCallRepository,
} from '../../src/core/types/ports.js';
import type { Clinic, Patient, TurnContext } from '../../src/core/types/conversation.js';
import type { ToolCallRecord } from '../../src/core/types/tool.js';
import type { EscalationRequest } from '../../src/core/types/message.js';

import { ConsultarAgendaTool } from '../../src/core/tools/consultar-agenda.tool.js';
import { CrearCitaTool, type CrearCitaInput } from '../../src/core/tools/crear-cita.tool.js';
import { EscalarHumanoTool } from '../../src/core/tools/escalar-humano.tool.js';
import { GuardarLeadTool, type GuardarLeadInput } from '../../src/core/tools/guardar-lead.tool.js';
import { ConsultarRagTool } from '../../src/core/tools/consultar-rag.tool.js';
import { ToolRegistryImpl } from '../../src/core/tools/tool.registry.js';
import { CalendarDoble } from '../helpers/dobles.js';

// ---------------------------------------------------------------------------
// Dobles de prueba. Ninguno toca red: son los puertos de ports.ts, en memoria.
// ---------------------------------------------------------------------------

function crearLoggerFake(): Logger {
  const logger: Logger = {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return logger;
}

class FakeToolCallRepository implements ToolCallRepository {
  public registros: ToolCallRecord[] = [];

  async record(call: ToolCallRecord): Promise<void> {
    this.registros.push(call);
  }

  async countByTool(conversationId: string, herramienta: string): Promise<number> {
    return this.registros.filter((r) => r.conversationId === conversationId && r.herramienta === herramienta).length;
  }
}

function crearClinica(overrides: Partial<Clinic> = {}): Clinic {
  return {
    id: 'clinica-legitima',
    nombre: 'Clinica Test',
    timezone: 'America/Lima',
    config: {},
    retencionTranscripcionDias: 365,
    retencionAudioDias: 0,
    transferWhitelist: ['+51999111222'],
    ...overrides,
  };
}

function crearPaciente(overrides: Partial<Patient> = {}): Patient {
  return {
    id: 'paciente-1',
    clinicId: 'clinica-legitima',
    telefonoE164: '+51987654321',
    ...overrides,
  };
}

function crearContexto(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    conversationId: 'conv-1',
    clinic: crearClinica(),
    patient: crearPaciente(),
    channel: 'whatsapp',
    history: [],
    channelSwitched: false,
    comprehensionFailures: 0,
    now: new Date('2026-07-25T09:00:00-05:00'),
    ...overrides,
  };
}

function crearCalendarPortFake(overrides: Partial<CalendarPort> = {}): CalendarPort {
  return {
    findAvailableSlots: vi.fn().mockResolvedValue([]),
    isSlotFree: vi.fn().mockResolvedValue(true),
    createEvent: vi.fn().mockResolvedValue({
      id: 'evento-1',
      start: new Date('2026-08-03T10:00:00-05:00'),
      end: new Date('2026-08-03T10:30:00-05:00'),
      titulo: 'Cita',
    }),
    cancelEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function crearNotificationPortFake(overrides: Partial<NotificationPort> = {}): NotificationPort {
  return {
    notifyEscalation: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function crearConversationRepositoryFake(overrides: Partial<ConversationRepository> = {}): ConversationRepository {
  return {
    findActiveWithin: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    touch: vi.fn().mockResolvedValue(undefined),
    markEscalated: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as ConversationRepository;
}

function crearAuditRepositoryFake(overrides: Partial<AuditRepository> = {}): AuditRepository {
  return {
    log: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function crearRagPortFake(overrides: Partial<RagPort> = {}): RagPort {
  return {
    retrieve: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

const escalationBase: EscalationRequest = {
  reason: 'peticion_humano',
  priority: 'normal',
  summaryForAgent: 'el paciente pidio hablar con una persona',
  messageForPatient: 'en un momento te comunico con alguien del equipo',
};

// ---------------------------------------------------------------------------
// crear_cita
// ---------------------------------------------------------------------------

describe('CrearCitaTool', () => {
  const inicioValido = '2026-08-03T10:00:00-05:00'; // lunes 10:00 hora Lima, dentro de horario

  it('rechaza crear una cita si confirmadoPorPaciente viene ausente', async () => {
    const calendarPort = crearCalendarPortFake();
    const toolCallRepository = new FakeToolCallRepository();
    const tool = new CrearCitaTool(calendarPort, toolCallRepository, crearLoggerFake());

    const argsSinConfirmar = { inicio: inicioValido, duracionMin: 30 } as unknown as CrearCitaInput;
    const resultado = await tool.execute(argsSinConfirmar, crearContexto());

    expect(resultado.status).toBe('rechazada_validacion');
    expect(resultado.error).toMatch(/confirmacion explicita/);
    expect(calendarPort.isSlotFree).not.toHaveBeenCalled();
    expect(calendarPort.createEvent).not.toHaveBeenCalled();
  });

  it('rechaza crear una cita si confirmadoPorPaciente viene false', async () => {
    const calendarPort = crearCalendarPortFake();
    const toolCallRepository = new FakeToolCallRepository();
    const tool = new CrearCitaTool(calendarPort, toolCallRepository, crearLoggerFake());

    const argsFalso = {
      inicio: inicioValido,
      duracionMin: 30,
      confirmadoPorPaciente: false,
    } as unknown as CrearCitaInput;
    const resultado = await tool.execute(argsFalso, crearContexto());

    expect(resultado.status).toBe('rechazada_validacion');
    expect(calendarPort.createEvent).not.toHaveBeenCalled();
  });

  it('detecta la colision en la segunda verificacion (isSlotFree justo antes de createEvent) y no crea la cita', async () => {
    const calendarPort = crearCalendarPortFake({ isSlotFree: vi.fn().mockResolvedValue(false) });
    const toolCallRepository = new FakeToolCallRepository();
    const tool = new CrearCitaTool(calendarPort, toolCallRepository, crearLoggerFake());

    const args: CrearCitaInput = {
      inicio: inicioValido,
      duracionMin: 30,
      sede: 'Miraflores',
      confirmadoPorPaciente: true,
    };
    const resultado = await tool.execute(args, crearContexto());

    expect(resultado.status).toBe('rechazada_validacion');
    expect(resultado.error).toMatch(/ya no esta disponible/);
    expect(calendarPort.isSlotFree).toHaveBeenCalledTimes(1);
    expect(calendarPort.createEvent).not.toHaveBeenCalled();
  });

  it('crea la cita cuando todo es valido: confirmado, en horario, y el slot sigue libre', async () => {
    const calendarPort = crearCalendarPortFake();
    const toolCallRepository = new FakeToolCallRepository();
    const tool = new CrearCitaTool(calendarPort, toolCallRepository, crearLoggerFake());

    const args: CrearCitaInput = {
      inicio: inicioValido,
      duracionMin: 30,
      sede: 'Miraflores',
      confirmadoPorPaciente: true,
    };
    const resultado = await tool.execute(args, crearContexto());

    expect(resultado.status).toBe('ok');
    expect(calendarPort.isSlotFree).toHaveBeenCalledTimes(1);
    expect(calendarPort.createEvent).toHaveBeenCalledTimes(1);
    // Titulo: motivo · paciente · sede. Sin nombre conocido cae al telefono,
    // que es lo minimo para que recepcion sepa a quien esperar.
    expect(calendarPort.createEvent).toHaveBeenCalledWith(
      'clinica-legitima',
      expect.objectContaining({
        titulo: 'Cita · +51987654321 · sede Miraflores',
        sede: 'Miraflores',
        pacienteTelefono: '+51987654321',
      }),
      '+51987654321',
      'Miraflores',
    );
    // el registro de auditoria guarda argumentos, nunca objetos crudos sin pasar por el enmascarador
    expect(toolCallRepository.registros).toHaveLength(1);
    expect(toolCallRepository.registros[0]?.estado).toBe('ok');
  });

  it('rechaza una cita en el pasado', async () => {
    const calendarPort = crearCalendarPortFake();
    const toolCallRepository = new FakeToolCallRepository();
    const tool = new CrearCitaTool(calendarPort, toolCallRepository, crearLoggerFake());

    const args: CrearCitaInput = {
      inicio: '2026-07-01T10:00:00-05:00', // anterior a ctx.now (2026-07-25)
      duracionMin: 30,
      sede: 'Miraflores',
      confirmadoPorPaciente: true,
    };
    const resultado = await tool.execute(args, crearContexto());

    expect(resultado.status).toBe('rechazada_validacion');
    expect(resultado.error).toMatch(/pasado/);
    expect(calendarPort.isSlotFree).not.toHaveBeenCalled();
  });

  it('rechaza un horario fuera de la atencion de la clinica', async () => {
    const calendarPort = crearCalendarPortFake();
    const toolCallRepository = new FakeToolCallRepository();
    const tool = new CrearCitaTool(calendarPort, toolCallRepository, crearLoggerFake());

    const args: CrearCitaInput = {
      inicio: '2026-08-03T22:00:00-05:00', // lunes 22:00 Lima
      duracionMin: 30,
      sede: 'Miraflores',
      confirmadoPorPaciente: true,
    };
    const resultado = await tool.execute(args, crearContexto());

    expect(resultado.status).toBe('rechazada_validacion');
    expect(resultado.error).toMatch(/no cabe en el horario/);
    expect(calendarPort.isSlotFree).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Horario real, feriados y sede
  //
  // Los tres defectos que hacian que el agente agendara con aplomo donde no
  // debia. Ver la cabecera de `src/core/agenda/horario.ts`.
  // -------------------------------------------------------------------------

  /** Clinica con la forma REAL de la semilla, no la que el codigo leia antes. */
  const clinicaReal = crearClinica({
    config: {
      horarios: {
        lunes_viernes: [
          ['09:00', '13:00'],
          ['14:00', '19:00'],
        ],
        sabado: [['09:00', '13:00']],
        domingo: [],
      },
      feriados: [{ fecha: '2026-08-06', motivo: 'Batalla de Junin' }],
      sedes_informativas: { miraflores: 'Av. Benavides 2027', comas: 'Av. El Maestro Peruano 430' },
      sedes_franquicia: { 'san-borja': 'Av. Joaquin Madrid 235' },
      duracion_cita_min: 40,
    },
  });

  const citaEn = (inicio: string, sede = 'miraflores', duracionMin = 40): CrearCitaInput => ({
    inicio,
    duracionMin,
    sede,
    confirmadoPorPaciente: true,
  });

  const casosDeHorario: Array<[string, string, RegExp]> = [
    // Antes TODOS estos se creaban: el codigo leia `config.horario` (singular),
    // la semilla tiene `horarios` (plural), y el defecto era 08:00-20:00 L-S.
    ['antes de abrir (08:00, abre a las 9)', '2026-08-03T08:00:00-05:00', /no cabe en el horario/],
    ['en la pausa de mediodia (13:30)', '2026-08-03T13:30:00-05:00', /no cabe en el horario/],
    ['despues de cerrar (19:30, cierra a las 19)', '2026-08-03T19:30:00-05:00', /no cabe en el horario/],
    ['sabado por la tarde (cierra a las 13)', '2026-08-08T15:00:00-05:00', /no cabe en el horario/],
    ['domingo', '2026-08-09T10:00:00-05:00', /no atiende/],
    ['el feriado del 6 de agosto', '2026-08-06T10:00:00-05:00', /Batalla de Junin/],
  ];

  for (const [caso, inicio, esperado] of casosDeHorario) {
    it(`NO agenda ${caso}`, async () => {
      const calendarPort = crearCalendarPortFake();
      const tool = new CrearCitaTool(calendarPort, new FakeToolCallRepository(), crearLoggerFake());
      const resultado = await tool.execute(citaEn(inicio), crearContexto({ clinic: clinicaReal }));

      expect(resultado.status).toBe('rechazada_validacion');
      expect(resultado.error).toMatch(esperado);
      expect(calendarPort.createEvent).not.toHaveBeenCalled();
    });
  }

  it('una cita que EMPIEZA dentro pero TERMINA fuera tampoco pasa', async () => {
    // 12:40 + 40 min = 13:20, con la clinica ya cerrada. Comprobar solo el
    // comienzo --que es lo que se hacia-- la daba por buena.
    const calendarPort = crearCalendarPortFake();
    const tool = new CrearCitaTool(calendarPort, new FakeToolCallRepository(), crearLoggerFake());
    const resultado = await tool.execute(
      citaEn('2026-08-03T12:40:00-05:00'),
      crearContexto({ clinic: clinicaReal }),
    );

    expect(resultado.status).toBe('rechazada_validacion');
    expect(calendarPort.createEvent).not.toHaveBeenCalled();
  });

  it('agenda dentro del horario real y deja la sede en el titulo', async () => {
    const calendarPort = crearCalendarPortFake();
    const tool = new CrearCitaTool(calendarPort, new FakeToolCallRepository(), crearLoggerFake());
    const resultado = await tool.execute(
      { ...citaEn('2026-08-03T14:00:00-05:00'), motivo: 'Limpieza' },
      crearContexto({ clinic: clinicaReal }),
    );

    expect(resultado.status).toBe('ok');
    // La sede tiene que llegar a recepcion: `CalendarPort` no la lleva como
    // parametro, asi que el titulo es el unico sitio donde cabe.
    expect(calendarPort.createEvent).toHaveBeenCalledWith(
      clinicaReal.id,
      expect.objectContaining({ titulo: 'Limpieza · +51987654321 · sede miraflores' }),
      '+51987654321',
      'miraflores',
    );
  });

  it('sin sede no llega a tocar el calendario, y lo dice con la lista', async () => {
    const calendarPort = crearCalendarPortFake();
    const tool = new CrearCitaTool(calendarPort, new FakeToolCallRepository(), crearLoggerFake());
    const sinSede = { inicio: '2026-08-03T10:00:00-05:00', duracionMin: 40, confirmadoPorPaciente: true };
    const resultado = await tool.execute(sinSede as unknown as CrearCitaInput, crearContexto({ clinic: clinicaReal }));

    expect(resultado.status).toBe('rechazada_validacion');
    expect(resultado.error).toMatch(/falta la sede/);
    expect(resultado.error).toMatch(/miraflores/);
    expect(calendarPort.isSlotFree).not.toHaveBeenCalled();
  });

  it('rechaza una sede que no existe en vez de agendar en cualquier sitio', async () => {
    const calendarPort = crearCalendarPortFake();
    const tool = new CrearCitaTool(calendarPort, new FakeToolCallRepository(), crearLoggerFake());
    const resultado = await tool.execute(
      citaEn('2026-08-03T10:00:00-05:00', 'Magdalena'),
      crearContexto({ clinic: clinicaReal }),
    );

    expect(resultado.status).toBe('rechazada_validacion');
    expect(resultado.error).toMatch(/no existe o es ambigua/);
    expect(calendarPort.createEvent).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Una agenda POR SEDE
  // -------------------------------------------------------------------------

  it('que Comas este ocupado NO bloquea la misma hora en Miraflores', async () => {
    /**
     * El defecto que reporto el usuario. Las 24 sedes compartian calendario,
     * asi que una cita en Comas hacia aparecer ocupado ese horario en todas.
     * Con `CalendarDoble` --que ahora particiona por sede, igual que hace el
     * cliente de Google con `calendarios_por_sede`-- se comprueba de verdad.
     */
    const calendario = new CalendarDoble();
    const tool = new CrearCitaTool(calendario, new FakeToolCallRepository(), crearLoggerFake());
    const ctx = crearContexto({ clinic: clinicaReal });

    const enComas = await tool.execute(citaEn('2026-08-03T10:00:00-05:00', 'comas'), ctx);
    expect(enComas.status).toBe('ok');

    // MISMA hora, OTRA sede: tiene que poder agendarse.
    const enMiraflores = await tool.execute(citaEn('2026-08-03T10:00:00-05:00', 'miraflores'), ctx);
    expect(enMiraflores.status).toBe('ok');

    // Y la misma hora EN COMAS ya no, que para eso esta la comprobacion.
    const otraVezComas = await tool.execute(citaEn('2026-08-03T10:00:00-05:00', 'comas'), ctx);
    expect(otraVezComas.status).toBe('rechazada_validacion');
    expect(otraVezComas.error).toMatch(/ya no esta disponible/);

    expect(calendario.eventos).toHaveLength(2);
  });

  it('la disponibilidad tampoco mezcla sedes', async () => {
    const calendario = new CalendarDoble();
    const crear = new CrearCitaTool(calendario, new FakeToolCallRepository(), crearLoggerFake());
    const consultar = new ConsultarAgendaTool(calendario, new FakeToolCallRepository(), crearLoggerFake());
    const ctx = crearContexto({ clinic: clinicaReal });

    await crear.execute(citaEn('2026-08-03T09:00:00-05:00', 'comas'), ctx);

    const rango = {
      desde: '2026-08-03T09:00:00-05:00',
      hasta: '2026-08-03T13:00:00-05:00',
      duracionMin: 40,
    };
    const enComas = await consultar.execute({ ...rango, sede: 'comas' }, ctx);
    const enMiraflores = await consultar.execute({ ...rango, sede: 'miraflores' }, ctx);

    const huecos = (r: typeof enComas): Date[] =>
      ((r.data as { slots: Array<{ start: Date }> } | undefined)?.slots ?? []).map((s) => s.start);

    const nueve = new Date('2026-08-03T09:00:00-05:00').getTime();
    expect(huecos(enComas).some((d) => d.getTime() === nueve)).toBe(false);
    expect(huecos(enMiraflores).some((d) => d.getTime() === nueve)).toBe(true);
  });

  it('la cita creada lleva el telefono del paciente y su sede', async () => {
    // Sin telefono, recepcion no sabe a quien llamar para confirmar o mover la
    // cita. El doble lo descartaba, asi que en la web las citas se creaban sin
    // ningun dato de quien las habia pedido.
    const calendario = new CalendarDoble();
    const tool = new CrearCitaTool(calendario, new FakeToolCallRepository(), crearLoggerFake());
    const ctx = crearContexto({
      clinic: clinicaReal,
      patient: crearPaciente({ nombre: 'Rosa Quispe' }),
    });

    const resultado = await tool.execute(citaEn('2026-08-03T10:00:00-05:00', 'comas'), ctx);
    expect(resultado.status).toBe('ok');

    const evento = calendario.eventos[0];
    expect(evento?.pacienteTelefono).toBe('+51987654321');
    expect(evento?.sede).toBe('comas');
    // El titulo es lo que se lee de un vistazo en el calendario.
    expect(evento?.titulo).toContain('Rosa Quispe');
    expect(evento?.titulo).toContain('sede comas');
  });

  it('sin nombre conocido, el titulo cae al telefono en vez de quedarse anonimo', async () => {
    const calendario = new CalendarDoble();
    const tool = new CrearCitaTool(calendario, new FakeToolCallRepository(), crearLoggerFake());
    const resultado = await tool.execute(
      citaEn('2026-08-03T10:00:00-05:00', 'comas'),
      crearContexto({ clinic: clinicaReal }),
    );

    expect(resultado.status).toBe('ok');
    expect(calendario.eventos[0]?.titulo).toContain('+51987654321');
  });

  /**
   * REGRESION. El agente de voz en modo alojado manda TODOS los campos del
   * esquema y rellena con "" los que no tiene. Con `.min(1).optional()` la
   * cadena vacia chocaba contra el minimo --`optional()` admite que el campo
   * FALTE, no que venga vacio-- y el turno moria con:
   *
   *   argumentos invalidos: profesional: Too small: expected string to have
   *   >=1 characters
   *
   * Para el paciente eso era: el agente le pedia el nombre de un doctor, que no
   * tiene por que saberse, y dijera lo que dijera no se podia agendar. Un campo
   * opcional que bloquea es peor que no tenerlo.
   */
  it('el profesional VACIO no impide agendar', async () => {
    const calendarPort = crearCalendarPortFake();
    const tool = new CrearCitaTool(calendarPort, new FakeToolCallRepository(), crearLoggerFake());
    const conVacios = {
      inicio: '2026-08-03T10:00:00-05:00',
      duracionMin: 40,
      sede: 'comas',
      profesional: '',
      motivo: '',
      confirmadoPorPaciente: true,
    };
    const resultado = await tool.execute(conVacios as unknown as CrearCitaInput, crearContexto({ clinic: clinicaReal }));

    expect(resultado.status).toBe('ok');
    expect(calendarPort.createEvent).toHaveBeenCalledTimes(1);
  });

  it('el profesional vacio tampoco impide consultar la agenda', async () => {
    const calendarPort = crearCalendarPortFake();
    const tool = new ConsultarAgendaTool(calendarPort, new FakeToolCallRepository(), crearLoggerFake());
    const resultado = await tool.execute(
      {
        desde: '2026-08-03T09:00:00-05:00',
        hasta: '2026-08-03T13:00:00-05:00',
        duracionMin: 40,
        profesional: '',
        sede: 'comas',
      } as never,
      crearContexto({ clinic: clinicaReal }),
    );

    expect(resultado.status).toBe('ok');
    expect((resultado.data as { slots: unknown[] }).slots.length).toBeGreaterThan(0);
  });

  it('un profesional de verdad si se conserva', async () => {
    const calendarPort = crearCalendarPortFake();
    const tool = new CrearCitaTool(calendarPort, new FakeToolCallRepository(), crearLoggerFake());
    await tool.execute(
      { ...citaEn('2026-08-03T10:00:00-05:00', 'comas'), profesional: 'Dra. Ana Quispe' },
      crearContexto({ clinic: clinicaReal }),
    );

    expect(calendarPort.createEvent).toHaveBeenCalledWith(
      clinicaReal.id,
      expect.objectContaining({ profesional: 'Dra. Ana Quispe' }),
      '+51987654321',
      'comas',
    );
  });

  it('acepta la sede como la dice el paciente y la normaliza', async () => {
    const calendarPort = crearCalendarPortFake();
    const tool = new CrearCitaTool(calendarPort, new FakeToolCallRepository(), crearLoggerFake());
    const resultado = await tool.execute(
      citaEn('2026-08-03T10:00:00-05:00', 'San Borja'),
      crearContexto({ clinic: clinicaReal }),
    );

    expect(resultado.status).toBe('ok');
    expect(calendarPort.createEvent).toHaveBeenCalledWith(
      clinicaReal.id,
      expect.objectContaining({ titulo: 'Cita · +51987654321 · sede san-borja', sede: 'san-borja' }),
      '+51987654321',
      'san-borja',
    );
  });
});

// ---------------------------------------------------------------------------
// escalar_humano
// ---------------------------------------------------------------------------

describe('EscalarHumanoTool', () => {
  it('rechaza la transferencia a un numero fuera de la lista blanca pero SIEMPRE notifica (nunca en silencio)', async () => {
    const notificationPort = crearNotificationPortFake();
    const conversationRepository = crearConversationRepositoryFake();
    const toolCallRepository = new FakeToolCallRepository();
    const tool = new EscalarHumanoTool(notificationPort, conversationRepository, toolCallRepository, crearLoggerFake());

    const args: EscalationRequest = { ...escalationBase, transferNumber: '+51900000000' }; // no esta en la whitelist
    const resultado = await tool.execute(args, crearContexto());

    expect(resultado.status).toBe('ok');
    expect(resultado.data?.transferAutorizado).toBe(false);
    expect(resultado.data?.request.transferNumber).toBeUndefined();
    expect(notificationPort.notifyEscalation).toHaveBeenCalledTimes(1);
    expect(conversationRepository.markEscalated).toHaveBeenCalledWith('conv-1', 'peticion_humano');
  });

  it('autoriza la transferencia cuando el numero SI esta en la lista blanca de la clinica', async () => {
    const notificationPort = crearNotificationPortFake();
    const conversationRepository = crearConversationRepositoryFake();
    const toolCallRepository = new FakeToolCallRepository();
    const tool = new EscalarHumanoTool(notificationPort, conversationRepository, toolCallRepository, crearLoggerFake());

    const args: EscalationRequest = { ...escalationBase, transferNumber: '+51999111222' }; // si esta en la whitelist
    const resultado = await tool.execute(args, crearContexto());

    expect(resultado.status).toBe('ok');
    expect(resultado.data?.transferAutorizado).toBe(true);
    expect(resultado.data?.request.transferNumber).toBe('+51999111222');
    expect(notificationPort.notifyEscalation).toHaveBeenCalledTimes(1);
  });

  it('nunca usa la whitelist de otra clinica: el mismo numero es rechazado si el contexto es de otra clinica', async () => {
    const notificationPort = crearNotificationPortFake();
    const conversationRepository = crearConversationRepositoryFake();
    const toolCallRepository = new FakeToolCallRepository();
    const tool = new EscalarHumanoTool(notificationPort, conversationRepository, toolCallRepository, crearLoggerFake());

    const otraClinica = crearContexto({ clinic: crearClinica({ id: 'otra-clinica', transferWhitelist: ['+51888777666'] }) });
    const args: EscalationRequest = { ...escalationBase, transferNumber: '+51999111222' }; // valido solo en clinica-legitima
    const resultado = await tool.execute(args, otraClinica);

    expect(resultado.data?.transferAutorizado).toBe(false);
    expect(notificationPort.notifyEscalation).toHaveBeenCalledTimes(1);
  });

  it('rechaza argumentos que no forman una EscalationRequest valida, sin notificar', async () => {
    const notificationPort = crearNotificationPortFake();
    const conversationRepository = crearConversationRepositoryFake();
    const toolCallRepository = new FakeToolCallRepository();
    const tool = new EscalarHumanoTool(notificationPort, conversationRepository, toolCallRepository, crearLoggerFake());

    const argsInvalidos = { reason: 'motivo_inventado' } as unknown as EscalationRequest;
    const resultado = await tool.execute(argsInvalidos, crearContexto());

    expect(resultado.status).toBe('rechazada_validacion');
    expect(notificationPort.notifyEscalation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// consultar_agenda
// ---------------------------------------------------------------------------

describe('ConsultarAgendaTool', () => {
  it('nunca lee la agenda de una clinica distinta a la del contexto, aunque los argumentos intenten sugerir otra', async () => {
    const calendarPort = crearCalendarPortFake();
    const toolCallRepository = new FakeToolCallRepository();
    const tool = new ConsultarAgendaTool(calendarPort, toolCallRepository, crearLoggerFake());

    const ctx = crearContexto({ clinic: crearClinica({ id: 'clinica-legitima' }) });
    // el modelo "alucina" un clinicId ajeno; el esquema ni siquiera declara ese
    // campo, asi que Zod lo descarta - pero se prueba tambien a nivel de tipo
    // no fiable (unknown) para simular una entrada hostil.
    const argsHostiles = {
      // Lunes: tiene que ser un dia que la clinica abra, o no se genera
      // ningun candidato y la prueba no llegaria a comprobar nada.
      desde: '2026-08-03T00:00:00-05:00',
      hasta: '2026-08-04T00:00:00-05:00',
      duracionMin: 30,
      clinicId: 'clinica-ajena',
    };
    const resultado = await tool.execute(argsHostiles as never, ctx);

    expect(resultado.status).toBe('ok');
    // La disponibilidad se comprueba con `isSlotFree` sobre candidatos que
    // salen del horario de la clinica, no con la rejilla ciega de
    // `findAvailableSlots`. Lo que se verifica sigue siendo lo mismo: el
    // `clinicId` sale SIEMPRE del contexto y jamas de los argumentos.
    const llamadas = (calendarPort.isSlotFree as ReturnType<typeof vi.fn>).mock.calls;
    expect(llamadas.length).toBeGreaterThan(0);
    for (const [clinicId] of llamadas) {
      expect(clinicId).toBe('clinica-legitima');
    }
    expect(calendarPort.isSlotFree).not.toHaveBeenCalledWith(
      'clinica-ajena',
      expect.anything(),
      expect.anything(),
    );
  });

  it('rechaza un rango de fechas mayor al maximo permitido (30 dias)', async () => {
    const calendarPort = crearCalendarPortFake();
    const toolCallRepository = new FakeToolCallRepository();
    const tool = new ConsultarAgendaTool(calendarPort, toolCallRepository, crearLoggerFake());

    const resultado = await tool.execute(
      { desde: '2026-08-01T00:00:00-05:00', hasta: '2026-10-01T00:00:00-05:00', duracionMin: 30 },
      crearContexto(),
    );

    expect(resultado.status).toBe('rechazada_validacion');
    expect(resultado.error).toMatch(/30 dias/);
    expect(calendarPort.findAvailableSlots).not.toHaveBeenCalled();
  });

  it('rechaza un rango completamente en el pasado', async () => {
    const calendarPort = crearCalendarPortFake();
    const toolCallRepository = new FakeToolCallRepository();
    const tool = new ConsultarAgendaTool(calendarPort, toolCallRepository, crearLoggerFake());

    const resultado = await tool.execute(
      { desde: '2026-01-01T00:00:00-05:00', hasta: '2026-01-02T00:00:00-05:00', duracionMin: 30 },
      crearContexto(),
    );

    expect(resultado.status).toBe('rechazada_validacion');
    expect(calendarPort.findAvailableSlots).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// guardar_lead
// ---------------------------------------------------------------------------

describe('GuardarLeadTool', () => {
  it('enmascara telefonos/DNI en motivoResumen antes de escribir en auditoria', async () => {
    const auditRepository = crearAuditRepositoryFake();
    const toolCallRepository = new FakeToolCallRepository();
    const tool = new GuardarLeadTool(auditRepository, toolCallRepository, crearLoggerFake());

    const args: GuardarLeadInput = {
      interesNivel: 'alto',
      motivoResumen: 'pidio que lo contactemos al 987654321 y menciono su DNI 12345678',
    };
    const resultado = await tool.execute(args, crearContexto());

    expect(resultado.status).toBe('ok');
    const [, detalle] = (auditRepository.log as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    expect(String(detalle['motivoResumen'])).not.toContain('987654321');
    expect(String(detalle['motivoResumen'])).not.toContain('12345678');

    // el registro de la llamada a la herramienta tampoco lleva el numero en claro
    const argumentos = toolCallRepository.registros[0]?.argumentosEnmascarados as Record<string, unknown>;
    expect(String(argumentos['motivoResumen'])).not.toContain('987654321');
  });

  it('el campo de scoring (interesNivel) es siempre una categoria, nunca texto libre', async () => {
    const auditRepository = crearAuditRepositoryFake();
    const toolCallRepository = new FakeToolCallRepository();
    const tool = new GuardarLeadTool(auditRepository, toolCallRepository, crearLoggerFake());

    const argsConCategoriaInventada = {
      interesNivel: 'el paciente tiene una infeccion y quiere que le recetemos algo',
      motivoResumen: 'consulta general',
    } as unknown as GuardarLeadInput;
    const resultado = await tool.execute(argsConCategoriaInventada, crearContexto());

    expect(resultado.status).toBe('rechazada_validacion');
    expect(auditRepository.log).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// consultar_rag
// ---------------------------------------------------------------------------

describe('ConsultarRagTool', () => {
  it('descarta fragmentos de otra clinica aunque el puerto los devuelva por error', async () => {
    const ragPort = crearRagPortFake({
      retrieve: vi.fn().mockResolvedValue([
        { id: 'c1', clinicId: 'clinica-legitima', contenido: 'horario de atencion', fuente: 'faq' },
        { id: 'c2', clinicId: 'clinica-ajena', contenido: 'dato de otra clinica', fuente: 'faq' },
      ]),
    });
    const toolCallRepository = new FakeToolCallRepository();
    const tool = new ConsultarRagTool(ragPort, toolCallRepository, crearLoggerFake());

    const resultado = await tool.execute({ consulta: 'horario', limite: 5 }, crearContexto());

    expect(resultado.status).toBe('ok');
    expect(resultado.data?.chunks).toHaveLength(1);
    expect(resultado.data?.chunks[0]?.clinicId).toBe('clinica-legitima');
    expect(ragPort.retrieve).toHaveBeenCalledWith('clinica-legitima', 'horario', 5);
  });
});

// ---------------------------------------------------------------------------
// ToolRegistryImpl: limite transversal de invocaciones por conversacion
// ---------------------------------------------------------------------------

describe('ToolRegistryImpl', () => {
  it('bloquea una herramienta al superar maxCallsPerConversation sin llegar a ejecutarla', async () => {
    const toolCallRepository = new FakeToolCallRepository();
    // el registro real de cada llamada es responsabilidad de la propia
    // herramienta (ver cada *.tool.ts); este doble lo simula para poder
    // probar el conteo transversal que hace el registro de forma aislada.
    const ejecutarReal = vi.fn().mockImplementation(async (_args: unknown, ctx: TurnContext) => {
      await toolCallRepository.record({
        conversationId: ctx.conversationId,
        herramienta: 'consultar_rag',
        argumentosEnmascarados: {},
        estado: 'ok',
        latenciaMs: 1,
      });
      return { status: 'ok', latencyMs: 1 };
    });
    const herramientaDePrueba = {
      name: 'consultar_rag' as const,
      description: 'herramienta de prueba',
      input: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
      maxCallsPerConversation: 2,
      execute: ejecutarReal,
    };
    const registry = new ToolRegistryImpl([herramientaDePrueba], toolCallRepository, crearLoggerFake());
    const ctx = crearContexto();

    const tool = registry.get('consultar_rag')!;
    await tool.execute({}, ctx);
    await tool.execute({}, ctx);
    // ya van 2 llamadas registradas; la tercera debe bloquearse en el registro
    const resultado = await tool.execute({}, ctx);

    expect(resultado.status).toBe('rechazada_validacion');
    expect(ejecutarReal).toHaveBeenCalledTimes(2); // no 3: la tercera nunca llego a la herramienta real
  });

  it('toClaudeToolDefinitions convierte los 5 esquemas Zod a JSON Schema con "type: object"', () => {
    const toolCallRepository = new FakeToolCallRepository();
    const calendarPort = crearCalendarPortFake();
    const logger = crearLoggerFake();
    const consultarAgenda = new ConsultarAgendaTool(calendarPort, toolCallRepository, logger);
    const registry = new ToolRegistryImpl([consultarAgenda], toolCallRepository, logger);

    const definiciones = registry.toClaudeToolDefinitions();

    expect(definiciones).toHaveLength(1);
    expect(definiciones[0]?.name).toBe('consultar_agenda');
    expect(definiciones[0]?.input_schema).toMatchObject({ type: 'object' });
    expect((definiciones[0]?.input_schema['properties'] as Record<string, unknown>)['desde']).toBeDefined();
  });
});
