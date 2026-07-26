import { z } from 'zod';
import type { BusinessTool, ToolRegistry, ToolStatus } from '../types/tool.js';
import type { Logger, ToolCallRepository } from '../types/ports.js';

/**
 * Registro central de herramientas de negocio.
 *
 * Aqui vive el UNICO control transversal: el limite de invocaciones por
 * conversacion (`maxCallsPerConversation`). Cada herramienta valida sus
 * propias invariantes de negocio (colision de agenda, lista blanca de
 * transferencia, etc.); contar cuantas veces se llamo ya y cortar el paso es
 * una responsabilidad compartida por las cinco, y por eso vive aqui una sola
 * vez en lugar de repetirse en cada `execute`.
 */
export class ToolRegistryImpl implements ToolRegistry {
  private readonly herramientas = new Map<string, BusinessTool>();

  constructor(
    tools: BusinessTool[],
    private readonly toolCallRepository: ToolCallRepository,
    private readonly logger: Logger,
  ) {
    for (const tool of tools) {
      if (this.herramientas.has(tool.name)) {
        // fallo de configuracion del que arma el registro, no del modelo: se
        // hace ruido de inmediato en vez de dejar una herramienta "fantasma".
        throw new Error(`herramienta duplicada en el registro: ${tool.name}`);
      }
      this.herramientas.set(tool.name, this.envolverConLimite(tool));
    }
  }

  get(name: string): BusinessTool | undefined {
    return this.herramientas.get(name);
  }

  list(): BusinessTool[] {
    return [...this.herramientas.values()];
  }

  toClaudeToolDefinitions(): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }> {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: zodASchemaClaude(tool.name, tool.input),
    }));
  }

  /**
   * Envuelve `execute` para que ninguna llamada real llegue a la herramienta
   * una vez superado `maxCallsPerConversation`. `countByTool` (el unico metodo
   * que expone `ToolCallRepository` para esto) cuenta TODAS las llamadas
   * registradas, exitosas o no: el limite es sobre intentos, no solo sobre
   * ejecuciones exitosas. Cada herramienta documenta, en su propio archivo,
   * por que eligio su numero.
   */
  private envolverConLimite(tool: BusinessTool): BusinessTool {
    const ejecutarOriginal = tool.execute.bind(tool);
    return {
      name: tool.name,
      description: tool.description,
      input: tool.input,
      maxCallsPerConversation: tool.maxCallsPerConversation,
      execute: async (args, ctx) => {
        const empezado = Date.now();
        const yaLlamadas = await this.toolCallRepository.countByTool(ctx.conversationId, tool.name);
        if (yaLlamadas >= tool.maxCallsPerConversation) {
          const mensaje = `limite de ${tool.maxCallsPerConversation} llamadas a "${tool.name}" alcanzado en esta conversacion`;
          this.logger.warn(
            { conversationId: ctx.conversationId, herramienta: tool.name, yaLlamadas },
            mensaje,
          );
          const estado: ToolStatus = 'rechazada_validacion';
          await this.toolCallRepository.record({
            conversationId: ctx.conversationId,
            herramienta: tool.name,
            argumentosEnmascarados: { _bloqueo: 'limite_llamadas_excedido' },
            estado,
            errorDetalle: mensaje,
            latenciaMs: Date.now() - empezado,
          });
          return { status: estado, error: mensaje, latencyMs: Date.now() - empezado };
        }
        return ejecutarOriginal(args, ctx);
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Conversion de esquemas Zod a JSON Schema para la API de Claude.
// ---------------------------------------------------------------------------

/**
 * Zod 4 (4.4.3, version instalada en este repo) expone `z.toJSONSchema()`.
 * Se comprueba en tiempo de ejecucion antes de usarlo (por si una version
 * futura lo retira) y se recurre a un conversor manual, escrito a mano SOLO
 * para los esquemas que de verdad usan estas cinco herramientas, como exige
 * el contrato de construccion.
 */
function zodASchemaClaude(nombreHerramienta: string, schema: z.ZodType<unknown>): Record<string, unknown> {
  const toJSONSchema = (z as unknown as { toJSONSchema?: (s: z.ZodType<unknown>) => Record<string, unknown> })
    .toJSONSchema;
  if (typeof toJSONSchema === 'function') {
    const json = toJSONSchema(schema);
    // $schema es metadata de JSON Schema; la API de Claude solo quiere el
    // esquema en si dentro de `input_schema`.
    const { $schema: _descartado, ...resto } = json;
    return resto;
  }
  const manual = ESQUEMAS_MANUALES[nombreHerramienta];
  if (manual) return manual;
  // Ultimo recurso: un esquema permisivo. No es un riesgo de seguridad -
  // ninguna herramienta confia en lo que valida este esquema de todos modos,
  // cada `execute` vuelve a validar con el Zod real - solo degrada la guia
  // que recibe el modelo.
  return { type: 'object', additionalProperties: true };
}

/**
 * Conversion manual de respaldo, escrita a mano para los 5 esquemas de
 * entrada que usan las herramientas de este directorio. Se mantiene en
 * sincronia manualmente con cada `*InputSchema`; si uno cambia y este archivo
 * no se actualiza, el peor caso es una peor descripcion para el modelo (la
 * validacion real sigue siendo la de Zod dentro de cada `execute`).
 */
const ESQUEMAS_MANUALES: Record<string, Record<string, unknown>> = {
  consultar_agenda: {
    type: 'object',
    properties: {
      desde: { type: 'string', format: 'date-time' },
      hasta: { type: 'string', format: 'date-time' },
      duracionMin: { type: 'integer', minimum: 15, maximum: 240, default: 30 },
      profesional: { type: 'string', minLength: 1, maxLength: 120 },
    },
    required: ['desde', 'hasta', 'duracionMin'],
    additionalProperties: false,
  },
  crear_cita: {
    type: 'object',
    properties: {
      inicio: { type: 'string', format: 'date-time' },
      duracionMin: { type: 'integer', minimum: 15, maximum: 180, default: 30 },
      motivo: { type: 'string', minLength: 1, maxLength: 200 },
      profesional: { type: 'string', minLength: 1, maxLength: 120 },
      confirmadoPorPaciente: { type: 'boolean', const: true },
    },
    required: ['inicio', 'duracionMin', 'confirmadoPorPaciente'],
    additionalProperties: false,
  },
  guardar_lead: {
    type: 'object',
    properties: {
      interesNivel: { type: 'string', enum: ['alto', 'medio', 'bajo'] },
      motivoResumen: { type: 'string', minLength: 1, maxLength: 300 },
      contactoPreferido: { type: 'string', enum: ['whatsapp', 'voz'] },
    },
    required: ['interesNivel', 'motivoResumen'],
    additionalProperties: false,
  },
  escalar_humano: {
    type: 'object',
    properties: {
      reason: { type: 'string', enum: ['urgencia', 'peticion_humano', 'reclamo', 'fallo_comprension'] },
      priority: { type: 'string', enum: ['urgente', 'normal'] },
      summaryForAgent: { type: 'string', minLength: 1 },
      messageForPatient: { type: 'string', minLength: 1 },
      transferNumber: { type: 'string' },
    },
    required: ['reason', 'priority', 'summaryForAgent', 'messageForPatient'],
    additionalProperties: false,
  },
  consultar_rag: {
    type: 'object',
    properties: {
      consulta: { type: 'string', minLength: 1, maxLength: 500 },
      limite: { type: 'integer', minimum: 1, maximum: 8, default: 5 },
    },
    required: ['consulta', 'limite'],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Enmascarado de PII compartido por las herramientas de este directorio.
//
// No existe todavia (en esta rama) un enmascarador centralizado en `infra/`;
// crear uno alli no me corresponde (no esta en mi lista de archivos). Estas
// funciones son deliberadamente pequenas y viven aqui porque `tool.registry.ts`
// es el unico archivo mio que el resto de herramientas puede importar sin
// crear un ciclo (el registro no importa de ninguna herramienta concreta).
// Si otra rama define un enmascarador comun en infra/, este es el unico punto
// de cambio para delegarle el trabajo.
// ---------------------------------------------------------------------------

const RE_EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const RE_TELEFONO_E164 = /\+[1-9]\d{7,14}/g;
/** DNI, telefonos sin '+', numeros de tarjeta: cualquier corrida larga de digitos. */
const RE_SERIE_NUMERICA_LARGA = /\d{6,}/g;

/** Enmascara PII evidente dentro de un texto libre antes de que se registre en cualquier log. */
export function enmascararTexto(texto: string): string {
  return texto
    .replace(RE_EMAIL, '[correo_oculto]')
    .replace(RE_TELEFONO_E164, (m) => `+***${m.slice(-2)}`)
    .replace(RE_SERIE_NUMERICA_LARGA, (m) => `***${m.slice(-2)}`);
}

/** Cota de profundidad/tamano: un objeto de argumentos hostil no puede colgar el enmascarado. */
const PROFUNDIDAD_MAXIMA = 4;
const ELEMENTOS_MAXIMOS = 50;

function enmascararValor(valor: unknown, profundidad: number): unknown {
  if (profundidad > PROFUNDIDAD_MAXIMA) return '[profundidad_maxima_alcanzada]';
  if (typeof valor === 'string') return enmascararTexto(valor);
  if (Array.isArray(valor)) {
    return valor.slice(0, ELEMENTOS_MAXIMOS).map((v) => enmascararValor(v, profundidad + 1));
  }
  if (valor && typeof valor === 'object') {
    const resultado: Record<string, unknown> = {};
    for (const [clave, val] of Object.entries(valor as Record<string, unknown>).slice(0, ELEMENTOS_MAXIMOS)) {
      resultado[clave] = enmascararValor(val, profundidad + 1);
    }
    return resultado;
  }
  return valor; // numeros, booleanos, null, undefined: sin texto libre que enmascarar
}

/**
 * Punto unico de enmascarado antes de escribir `argumentosEnmascarados` en
 * `ToolCallRepository`. Recibe los argumentos SIN VALIDAR (pueden venir de un
 * parseo fallido) porque incluso un intento rechazado debe quedar auditado
 * sin PII en claro.
 */
export function maskArgsForLog(args: unknown): Record<string, unknown> {
  const enmascarado = enmascararValor(args, 0);
  if (enmascarado && typeof enmascarado === 'object' && !Array.isArray(enmascarado)) {
    return enmascarado as Record<string, unknown>;
  }
  return { valor: enmascarado };
}
