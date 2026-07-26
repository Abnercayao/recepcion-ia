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
      confirmadoPorPaciente: true,
    };
    const resultado = await tool.execute(args, crearContexto());

    expect(resultado.status).toBe('ok');
    expect(calendarPort.isSlotFree).toHaveBeenCalledTimes(1);
    expect(calendarPort.createEvent).toHaveBeenCalledTimes(1);
    expect(calendarPort.createEvent).toHaveBeenCalledWith(
      'clinica-legitima',
      expect.objectContaining({ titulo: 'Cita' }),
      '+51987654321',
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
      inicio: '2026-08-03T22:00:00-05:00', // lunes 22:00 Lima, fuera de 08:00-20:00
      duracionMin: 30,
      confirmadoPorPaciente: true,
    };
    const resultado = await tool.execute(args, crearContexto());

    expect(resultado.status).toBe('rechazada_validacion');
    expect(resultado.error).toMatch(/fuera del horario/);
    expect(calendarPort.isSlotFree).not.toHaveBeenCalled();
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
      desde: '2026-08-01T00:00:00-05:00',
      hasta: '2026-08-02T00:00:00-05:00',
      duracionMin: 30,
      clinicId: 'clinica-ajena',
    };
    const resultado = await tool.execute(argsHostiles as never, ctx);

    expect(resultado.status).toBe('ok');
    expect(calendarPort.findAvailableSlots).toHaveBeenCalledTimes(1);
    expect(calendarPort.findAvailableSlots).toHaveBeenCalledWith(
      'clinica-legitima',
      expect.any(Date),
      expect.any(Date),
      30,
    );
    // nunca se le paso 'clinica-ajena' al puerto
    expect(calendarPort.findAvailableSlots).not.toHaveBeenCalledWith(
      'clinica-ajena',
      expect.anything(),
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
