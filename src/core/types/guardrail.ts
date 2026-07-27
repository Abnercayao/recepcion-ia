/**
 * Tipos de las tres capas de control.
 *
 * Las reglas del prompt son una expectativa; estas capas son el control.
 * Sin la capa 2 el sistema no tiene garantia alguna sobre lo que dice
 * (control C3 del informe etico; anti-patron 5 de la especificacion).
 */

/** Resultado de una verificacion. `pass: false` es BLOQUEANTE en la capa 2. */
export interface GuardrailResult {
  pass: boolean;
  /** Motivo legible. Se registra como incidente cuando pass es false. */
  reason?: string;
  /** Texto sustituto que SI se puede emitir. En capa 2 suele ser la respuesta canonica. */
  replacement?: string;
}

/** Categorias que la capa 2 sabe detectar. Cada una es un criterio bloqueante. */
export const OUTBOUND_VIOLATIONS = [
  'precio_cerrado_sin_valoracion',
  'afirmacion_clinica',
  'afirmacion_de_ser_humano',
  'cita_afirmada_sin_tool_call',
  'promesa_de_resultado',
] as const;
export type OutboundViolation = (typeof OUTBOUND_VIOLATIONS)[number];

export const INBOUND_FLAGS = [
  'intento_inyeccion',
  'consulta_clinica',
  'solicitud_datos_de_otro_paciente',
] as const;
export type InboundFlag = (typeof INBOUND_FLAGS)[number];

/**
 * Resultado del clasificador de urgencia (capa 3).
 *
 * Corre en PARALELO a la generacion, sobre cada turno, con el modelo rapido.
 * El sesgo esta deliberadamente puesto en el falso positivo: derivar de mas es
 * un costo operativo, derivar de menos es un dano (riesgo R3, control C4).
 */
export interface UrgencyResult {
  /** La decision. La toma el veredicto del clasificador, no un umbral. */
  isUrgent: boolean;
  /**
   * 0..1, DESCRIPTIVO. Alimenta el log y el motivo del escalamiento; NO entra
   * en ninguna decision. Se deriva de `isUrgent`, nunca al reves: hubo aqui un
   * umbral sobre este campo y escalaba el 100% de los turnos (ver la cabecera
   * de `urgency.detector.ts`). No vuelvas a comparar este numero con nada.
   */
  confidence: number;
  /** Senales detectadas, para auditoria de falsos positivos. */
  signals: string[];
  latencyMs: number;
}
