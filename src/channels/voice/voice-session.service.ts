/**
 * voice-session.service.ts
 *
 * El estado de SESION de una llamada, que el nucleo no conoce y no debe
 * conocer: la fila de `calls`, el numero de turno, los eventos de audio, las
 * metricas de latencia y las lineas de transcripcion.
 *
 * Sigue siendo traduccion, no negocio: aqui no se decide que responder ni
 * cuando escalar. Se resuelve «de que clinica, que paciente y que llamada es
 * este request» y se deja rastro de lo ocurrido. Todo lo demas lo decide el
 * `ConversationService`, el MISMO que usa WhatsApp.
 *
 * REGLA DE ORO DE ESTE ARCHIVO: ninguna operacion de persistencia puede tumbar
 * una llamada en curso. Todas las escrituras se hacen «best effort» y se
 * registran en el log si fallan. El silencio en una llamada es el peor modo de
 * fallo (anti-patron 7); perder una metrica no lo es.
 */
import { z } from 'zod';
import type { Logger } from '../../core/types/index.js';
import {
  aE164,
  telefonoDeExtraBody,
  type AudioEventTipo,
  type CallRecord,
  type CallRepository,
  type ElevenlabsExtraBody,
  type TranscriptRepository,
} from './voice.types.js';

/** `InboundMessage.clinicId` exige un UUID: se comprueba aqui y no en el nucleo. */
const clinicIdSchema = z.string().uuid();

export interface ContextoDeSesionDeVoz {
  clinicId: string;
  patientPhoneE164: string;
  sessionId?: string;
  /** `undefined` si no hay fila en `calls` para esta sesion (llamada no registrada aun). */
  call?: CallRecord;
  /** Turno dentro de la llamada, 1-based. 1 cuando no hay registro previo. */
  turno: number;
}

export type MotivoDeContextoInvalido =
  | 'sin_extra_body'
  | 'clinic_id_ausente_o_invalido'
  | 'telefono_no_resoluble';

export type ResolucionDeSesion =
  | { ok: true; contexto: ContextoDeSesionDeVoz }
  | { ok: false; motivo: MotivoDeContextoInvalido };

export interface VoiceSessionDeps {
  calls: CallRepository;
  transcripts: TranscriptRepository;
  logger: Logger;
  now?: () => Date;
}

export interface VoiceSessionOptions {
  /**
   * Si `true`, el gateway marca `calls.disclosure_ejecutada` en el primer turno
   * de la llamada, dando por hecho que el `first_message` del agente contiene el
   * guion de revelacion (§7).
   *
   * POR DEFECTO ES `false`, y es deliberado. `disclosure_ejecutada` es la
   * evidencia AUDITABLE de una obligacion contractual y regulatoria: marcarla a
   * partir de una inferencia («ha llegado un turno, luego el agente ya hablo»)
   * seria fabricar evidencia de cumplimiento que este proceso no observo. Lo
   * que si hace el gateway por defecto es DETECTAR y registrar la ausencia.
   * Quien componga el sistema (Fase 5) puede activarlo una vez verificado en el
   * panel que el `first_message` es el guion, o -mejor- dejar que lo marque el
   * webhook post-llamada, que si ve la transcripcion real.
   */
  marcarDisclosureAlPrimerTurno?: boolean;
  /**
   * Si `true` (por defecto), se persiste una linea de `transcripts` por turno
   * con lo que dijo el paciente y lo que emitio el agente.
   *
   * Es una transcripcion PROPIA, no la del proveedor: nos da rastro aunque el
   * webhook post-llamada no llegue nunca. El webhook de la Fase 5 debe
   * RECONCILIAR con estas lineas (mismo `call_id`), no anadirlas otra vez.
   */
  persistirTranscripcion?: boolean;
}

export class VoiceSessionService {
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly opciones: Required<VoiceSessionOptions>;

  constructor(
    private readonly deps: VoiceSessionDeps,
    opciones: VoiceSessionOptions = {},
  ) {
    this.logger = deps.logger.child({ componente: 'voice-session.service' });
    this.now = deps.now ?? (() => new Date());
    this.opciones = {
      marcarDisclosureAlPrimerTurno: opciones.marcarDisclosureAlPrimerTurno ?? false,
      persistirTranscripcion: opciones.persistirTranscripcion ?? true,
    };
  }

  /**
   * Resuelve el contexto del turno a partir de `elevenlabs_extra_body`.
   *
   * El telefono se toma del extra body y, si falta, del registro de la llamada
   * (`calls.numero_origen`) buscado por `session_id` -- que es exactamente el
   * paso 2 de la §5 de la especificacion.
   */
  async resolverContexto(extra: ElevenlabsExtraBody | undefined): Promise<ResolucionDeSesion> {
    if (!extra) return { ok: false, motivo: 'sin_extra_body' };

    const clinicId = clinicIdSchema.safeParse(extra.clinic_id);
    if (!clinicId.success) return { ok: false, motivo: 'clinic_id_ausente_o_invalido' };

    const sessionId = extra.session_id?.trim() !== '' ? extra.session_id : undefined;

    let call: CallRecord | undefined;
    if (sessionId) {
      call = (await this.buscarLlamada(sessionId)) ?? undefined;
    }

    // Prioridad: lo que manda el proveedor en este turno; si no viene, el
    // numero con el que se registro la llamada.
    const telefono = aE164(telefonoDeExtraBody(extra)) ?? aE164(call?.numeroOrigen);
    if (!telefono) return { ok: false, motivo: 'telefono_no_resoluble' };

    const turno = call ? await this.siguienteTurno(call.id) : 1;

    const contexto: ContextoDeSesionDeVoz = {
      clinicId: clinicId.data,
      patientPhoneE164: telefono,
      turno,
    };
    if (sessionId !== undefined) contexto.sessionId = sessionId;
    if (call !== undefined) contexto.call = call;

    return { ok: true, contexto };
  }

  /**
   * Primer turno de la llamada: comprueba la revelacion obligatoria (§7).
   *
   * Ver `VoiceSessionOptions.marcarDisclosureAlPrimerTurno`: por defecto NO se
   * marca, solo se detecta y se registra la ausencia, en el log y como evento
   * de audio `inicio`. Una llamada que llega hasta aqui con el flag en `false`
   * es una desviacion auditable, no un detalle de implementacion.
   */
  async verificarDisclosure(call: CallRecord): Promise<void> {
    if (call.disclosureEjecutada) {
      await this.registrarEvento(call.id, 'inicio', { disclosure_ejecutada: true });
      return;
    }

    if (this.opciones.marcarDisclosureAlPrimerTurno) {
      try {
        await this.deps.calls.marcarDisclosureEjecutada(call.id);
      } catch (err) {
        this.logger.error(
          { callId: call.id, error: String(err) },
          'no se pudo marcar disclosure_ejecutada',
        );
      }
      await this.registrarEvento(call.id, 'inicio', {
        disclosure_ejecutada: true,
        evidencia: 'inferida_del_first_message_del_agente',
      });
      return;
    }

    this.logger.warn(
      { callId: call.id, sessionId: call.sessionId },
      'la llamada llega al gateway con disclosure_ejecutada=false: la revelacion obligatoria (§7) no esta registrada',
    );
    await this.registrarEvento(call.id, 'inicio', { disclosure_ejecutada: false });
  }

  /** Evento de audio. Nunca lanza: un evento perdido no puede cortar una llamada. */
  async registrarEvento(
    callId: string,
    tipo: AudioEventTipo,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const evento = { callId, tipo, ts: this.now(), ...(payload ? { payload } : {}) };
      await this.deps.calls.appendAudioEvent(evento);
    } catch (err) {
      this.logger.error({ callId, tipo, error: String(err) }, 'no se pudo registrar el evento de audio');
    }
  }

  /**
   * Cierre del turno: metricas de latencia y transcripcion.
   *
   * `stt_ms` y `tts_ms` quedan SIN INFORMAR a proposito: los mide ElevenLabs y
   * el gateway no los ve. Rellenarlos con un valor inventado haria inutil el
   * reporte de latencia de la Fase 5. `llm_ms` es el tiempo del nucleo y
   * `total_ms` el del request completo, que es lo unico que este proceso
   * observa de verdad.
   */
  async registrarCierreDeTurno(params: {
    call?: CallRecord;
    turno: number;
    textoDelPaciente: string;
    textoDelAgente: string;
    llmMs: number;
    totalMs: number;
  }): Promise<void> {
    const call = params.call;
    if (!call) {
      // Sin fila en `calls` no hay FK a la que colgar metricas ni transcripcion.
      this.logger.warn(
        { turno: params.turno },
        'turno de voz sin registro en `calls`: no se persisten latencias ni transcripcion',
      );
      return;
    }

    try {
      await this.deps.calls.appendLatencyMetric({
        callId: call.id,
        turno: params.turno,
        llmMs: params.llmMs,
        totalMs: params.totalMs,
      });
    } catch (err) {
      this.logger.error(
        { callId: call.id, turno: params.turno, error: String(err) },
        'no se pudo persistir la metrica de latencia del turno',
      );
    }

    if (!this.opciones.persistirTranscripcion) return;

    const lineas = [
      { callId: call.id, hablante: 'paciente' as const, texto: params.textoDelPaciente },
      { callId: call.id, hablante: 'agente' as const, texto: params.textoDelAgente },
    ].filter((l) => l.texto.trim() !== '');

    if (lineas.length === 0) return;

    try {
      await this.deps.transcripts.appendMany(lineas);
    } catch (err) {
      this.logger.error(
        { callId: call.id, turno: params.turno, error: String(err) },
        'no se pudo persistir la transcripcion del turno',
      );
    }
  }

  /** Marca la llamada como transferida. Best effort, igual que el resto. */
  async marcarTransferida(callId: string, numero: string): Promise<void> {
    try {
      await this.deps.calls.update(callId, { callStatus: 'transferida', transferidaA: numero });
    } catch (err) {
      this.logger.error({ callId, error: String(err) }, 'no se pudo marcar la llamada como transferida');
    }
  }

  private async buscarLlamada(sessionId: string): Promise<CallRecord | null> {
    try {
      return await this.deps.calls.findBySessionId(sessionId);
    } catch (err) {
      // Que la base no responda no puede dejar la llamada muda: se sigue sin
      // fila de `calls` y el turno se atiende igual, solo sin metricas.
      this.logger.error(
        { sessionId, error: String(err) },
        'no se pudo leer el registro de la llamada; se continua el turno sin el',
      );
      return null;
    }
  }

  private async siguienteTurno(callId: string): Promise<number> {
    try {
      return await this.deps.calls.siguienteTurno(callId);
    } catch (err) {
      this.logger.error({ callId, error: String(err) }, 'no se pudo calcular el numero de turno; se asume 1');
      return 1;
    }
  }
}
