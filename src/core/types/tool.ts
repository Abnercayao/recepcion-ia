import { z } from 'zod';
import type { TurnContext } from './conversation.js';

/**
 * Herramientas de NEGOCIO: se ejecutan dentro del nucleo y sirven a los dos
 * canales. Su definicion existe una sola vez. NUNCA se registran en la
 * plataforma de voz (anti-patron 3: duplicaria definiciones y sacaria la
 * validacion del nucleo).
 */
export const businessToolNameSchema = z.enum([
  'consultar_agenda',
  'crear_cita',
  'guardar_lead',
  'escalar_humano',
  'consultar_rag',
]);
export type BusinessToolName = z.infer<typeof businessToolNameSchema>;

/**
 * Herramientas de SISTEMA: las ejecuta la plataforma de voz porque requieren
 * efectos en la telefonia. El nucleo solo las emite; no las implementa.
 * Solo existen en el canal de voz.
 */
export const systemToolNameSchema = z.enum([
  'transfer_to_number',
  'end_call',
  'language_detection',
  'skip_turn',
]);
export type SystemToolName = z.infer<typeof systemToolNameSchema>;

export type ToolName = BusinessToolName | SystemToolName;

export const TOOL_STATUS = ['ok', 'error', 'rechazada_validacion'] as const;
export type ToolStatus = (typeof TOOL_STATUS)[number];

/** Resultado de ejecutar una herramienta de negocio. */
export interface ToolResult<T = unknown> {
  status: ToolStatus;
  /** Datos que vuelven al tool loop de Claude. Nunca contiene PII sin enmascarar. */
  data?: T;
  /** Mensaje de error legible por el modelo, para que reintente o derive. */
  error?: string;
  latencyMs: number;
}

/**
 * Una herramienta de negocio.
 *
 * Regla no negociable: NINGUNA herramienta confia en los argumentos que produce
 * el modelo. `input` valida con Zod ANTES de ejecutar, y `execute` vuelve a
 * comprobar las invariantes que dependen del estado (colisiones de agenda,
 * lista blanca de transferencia, pertenencia a la clinica del contexto).
 */
export interface BusinessTool<TInput = unknown, TOutput = unknown> {
  name: BusinessToolName;
  /** Descripcion que ve el modelo. Debe decir cuando usarla y cuando no. */
  description: string;
  input: z.ZodType<TInput>;
  execute(args: TInput, ctx: TurnContext): Promise<ToolResult<TOutput>>;
  /** Maximo de invocaciones por conversacion. Contiene bucles y abuso. */
  maxCallsPerConversation: number;
}

export interface ToolRegistry {
  get(name: string): BusinessTool | undefined;
  list(): BusinessTool[];
  /** Definiciones en el formato que espera la API de Claude. */
  toClaudeToolDefinitions(): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
}

/** Registro auditable de una invocacion, con argumentos ya enmascarados. */
export interface ToolCallRecord {
  conversationId: string;
  messageId?: string;
  herramienta: string;
  argumentosEnmascarados: Record<string, unknown>;
  estado: ToolStatus;
  errorDetalle?: string;
  latenciaMs: number;
}
