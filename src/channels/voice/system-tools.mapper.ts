/**
 * system-tools.mapper.ts
 *
 * LA DISTINCION QUE SOSTIENE TODO EL DISENO.
 *
 *   · Herramientas de NEGOCIO (`consultar_agenda`, `crear_cita`, `guardar_lead`,
 *     `escalar_humano`, `consultar_rag`): se ejecutan DENTRO del nucleo, con sus
 *     validaciones defensivas y su registro auditable. **No se exponen jamas a
 *     ElevenLabs** (anti-patron 3: duplicaria definiciones y sacaria la
 *     validacion del nucleo). Su resultado vuelve al bucle de herramientas de
 *     Claude y por SSE solo sale el texto final.
 *
 *   · Herramientas de SISTEMA (`transfer_to_number`, `end_call`,
 *     `language_detection`, `skip_turn`): tienen efecto en la TELEFONIA, que
 *     nosotros no controlamos. Se emiten como `tool_calls` en el chunk SSE para
 *     que las ejecute ElevenLabs.
 *
 * Los nombres de los parametros de las herramientas de sistema estan
 * CONFIRMADOS contra la documentacion oficial en docs/contrato-elevenlabs.md §4
 * y se usan aqui LITERALMENTE (`transfer_number`, `client_message`,
 * `agent_message`, `reason`, `message`, `language`). Es el unico sitio del
 * repositorio donde aparecen esos nombres.
 *
 * Este archivo NO decide nada de negocio: no elige cuando transferir (eso lo
 * decide el nucleo y llega como `EscalationRequest`), solo traduce esa decision
 * al vocabulario del proveedor y hace cumplir la lista blanca una segunda vez.
 */
import { z } from 'zod';
import {
  businessToolNameSchema,
  systemToolNameSchema,
  type BusinessToolName,
  type EscalationRequest,
  type SystemToolName,
} from '../../core/types/index.js';

// ---------------------------------------------------------------------------
// Clasificacion
// ---------------------------------------------------------------------------

/**
 * No se reescribe la lista de nombres: se pregunta a los esquemas del nucleo
 * (`core/types/tool.ts`), que son la fuente unica. Anadir una herramienta alli
 * la clasifica correctamente aqui sin tocar este archivo.
 */
export function esHerramientaDeSistema(nombre: string): nombre is SystemToolName {
  return systemToolNameSchema.safeParse(nombre).success;
}

export function esHerramientaDeNegocio(nombre: string): nombre is BusinessToolName {
  return businessToolNameSchema.safeParse(nombre).success;
}

// ---------------------------------------------------------------------------
// Parametros exactos (docs/contrato-elevenlabs.md §4)
// ---------------------------------------------------------------------------

/** `transfer_number` (req) · `client_message` (req) · `agent_message` (req) · `reason` (opt) */
export const transferToNumberArgsSchema = z.object({
  transfer_number: z.string().min(1),
  client_message: z.string().min(1),
  agent_message: z.string().min(1),
  reason: z.string().optional(),
});
export type TransferToNumberArgs = z.infer<typeof transferToNumberArgsSchema>;

/** `reason` (req) · `message` (opt) */
export const endCallArgsSchema = z.object({
  reason: z.string().min(1),
  message: z.string().optional(),
});
export type EndCallArgs = z.infer<typeof endCallArgsSchema>;

/** `reason` (req) · `language` (req) */
export const languageDetectionArgsSchema = z.object({
  reason: z.string().min(1),
  language: z.string().min(1),
});
export type LanguageDetectionArgs = z.infer<typeof languageDetectionArgsSchema>;

/** `reason` (opt) */
export const skipTurnArgsSchema = z.object({
  reason: z.string().optional(),
});
export type SkipTurnArgs = z.infer<typeof skipTurnArgsSchema>;

/** Una invocacion de herramienta de sistema, ya validada. */
export type SystemToolInvocation =
  | { name: 'transfer_to_number'; args: TransferToNumberArgs }
  | { name: 'end_call'; args: EndCallArgs }
  | { name: 'language_detection'; args: LanguageDetectionArgs }
  | { name: 'skip_turn'; args: SkipTurnArgs };

/**
 * Argumentos serializados. El formato (string JSON) es parte de la asuncion
 * sobre el streaming de tool calls; el mapper SSE es quien la documenta.
 */
export function argumentosJson(invocacion: SystemToolInvocation): string {
  return JSON.stringify(invocacion.args);
}

// ---------------------------------------------------------------------------
// EscalationRequest -> transfer_to_number
// ---------------------------------------------------------------------------

/**
 * Resumen de respaldo cuando el nucleo no trae uno. `agent_message` es
 * REQUERIDO por el proveedor y ademas es criterio de aceptacion de la Fase 4
 * («`agent_message` no vacio»): nunca se emite vacio, se degrada a esto.
 */
export function resumenDeRespaldo(request: EscalationRequest): string {
  return (
    `Escalamiento automatico del asistente virtual. Motivo: ${request.reason}. ` +
    `Prioridad: ${request.priority}. El nucleo no genero resumen para la persona que recibe el caso.`
  );
}

export type MotivoDeNoTransferencia = 'sin_numero' | 'fuera_de_lista_blanca';

export type ResultadoDeTransferencia =
  | { ok: true; invocacion: Extract<SystemToolInvocation, { name: 'transfer_to_number' }> }
  | { ok: false; motivo: MotivoDeNoTransferencia };

/**
 * Traduce una `EscalationRequest` del nucleo a la herramienta de sistema
 * `transfer_to_number`.
 *
 * LISTA BLANCA, SEGUNDA VEZ. `escalar_humano` (nucleo) ya sanea el numero
 * contra `clinic.transfer_whitelist` antes de construir la peticion. Aqui se
 * vuelve a comprobar, a proposito: este mapper tambien atiende el camino de
 * FALLO TECNICO, donde la peticion la fabrica el adaptador y nunca paso por la
 * herramienta. Un numero fuera de lista no se marca nunca, y el llamador
 * decide que hacer (notificar por el canal de respaldo).
 *
 * Hay ademas una TERCERA lista blanca, del lado del proveedor: el destino de la
 * transferencia se declara en el agente y el modelo solo puede referenciar un
 * numero ya configurado (docs/contrato-elevenlabs.md §4).
 *
 * NUMERO DE RESPALDO: si la peticion no trae `transferNumber` (caso tipico del
 * fallo tecnico), se usa el PRIMERO de la lista blanca. Es una decision nuestra
 * y esta declarada: preferimos derivar a la recepcion de la clinica antes que
 * dejar la llamada sin salida. Si la lista esta vacia, no se transfiere.
 */
export function mapearEscalacion(
  request: EscalationRequest,
  transferWhitelist: readonly string[],
): ResultadoDeTransferencia {
  const candidato = request.transferNumber ?? transferWhitelist[0];
  if (!candidato) return { ok: false, motivo: 'sin_numero' };
  if (!transferWhitelist.includes(candidato)) return { ok: false, motivo: 'fuera_de_lista_blanca' };

  const clientMessage =
    request.messageForPatient.trim() !== ''
      ? request.messageForPatient
      : 'Le paso con una persona del equipo.';
  const agentMessage =
    request.summaryForAgent.trim() !== '' ? request.summaryForAgent : resumenDeRespaldo(request);

  return {
    ok: true,
    invocacion: {
      name: 'transfer_to_number',
      args: {
        transfer_number: candidato,
        client_message: clientMessage,
        agent_message: agentMessage,
        reason: request.reason,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Otras herramientas de sistema
// ---------------------------------------------------------------------------

/** Motivo canonico cuando el nucleo marca `endCall` en el `OutboundMessage`. */
export const MOTIVO_DE_FIN_DE_LLAMADA = 'el asistente dio la conversacion por terminada';

export function mapearFinDeLlamada(mensajeDeDespedida?: string): Extract<SystemToolInvocation, { name: 'end_call' }> {
  const args: EndCallArgs = { reason: MOTIVO_DE_FIN_DE_LLAMADA };
  if (mensajeDeDespedida !== undefined && mensajeDeDespedida.trim() !== '') {
    args.message = mensajeDeDespedida;
  }
  return { name: 'end_call', args };
}

/**
 * Valida una herramienta de sistema que llegue como `TurnChunk` de tipo
 * `tool_call` desde el nucleo.
 *
 * Hoy el nucleo solo emite herramientas de NEGOCIO por ese canal, asi que esta
 * funcion no tiene camino caliente. Existe porque el tipo `TurnChunk` no
 * distingue unas de otras: si manana el nucleo emitiera `skip_turn`, el gateway
 * debe saber traducirlo en vez de tragarselo en silencio. Devuelve `undefined`
 * si los argumentos no cumplen el contrato del proveedor -- NUNCA se emite a la
 * telefonia algo que no valido (anti-patron 4).
 */
export function mapearToolCallDeSistema(nombre: string, args: unknown): SystemToolInvocation | undefined {
  if (!esHerramientaDeSistema(nombre)) return undefined;

  switch (nombre) {
    case 'transfer_to_number': {
      const parsed = transferToNumberArgsSchema.safeParse(args);
      return parsed.success ? { name: 'transfer_to_number', args: parsed.data } : undefined;
    }
    case 'end_call': {
      const parsed = endCallArgsSchema.safeParse(args);
      return parsed.success ? { name: 'end_call', args: parsed.data } : undefined;
    }
    case 'language_detection': {
      const parsed = languageDetectionArgsSchema.safeParse(args);
      return parsed.success ? { name: 'language_detection', args: parsed.data } : undefined;
    }
    case 'skip_turn': {
      const parsed = skipTurnArgsSchema.safeParse(args);
      return parsed.success ? { name: 'skip_turn', args: parsed.data } : undefined;
    }
    default:
      return undefined;
  }
}
