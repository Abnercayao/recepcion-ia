/**
 * Enrutador de mensajes entrantes (especificacion §10).
 *
 * Es el unico sitio del sistema que decide A QUE CONVERSACION pertenece un
 * mensaje. La regla de fondo: una conversacion es de un PACIENTE en una
 * CLINICA, nunca de un canal. Por eso el mismo `conversation_id` sobrevive al
 * salto de voz a WhatsApp mientras la ultima actividad este dentro de la
 * ventana de continuidad.
 *
 * Devuelve el `TurnContext` ya construido: es lo unico que las capas de abajo
 * (PromptBuilder, herramientas, guardrails) necesitan saber del turno.
 */
import { isSupportedCountry, parsePhoneNumberFromString } from 'libphonenumber-js';
import type {
  ClinicRepository,
  Conversation,
  ConversationRepository,
  InboundMessage,
  Logger,
  MessageRepository,
  PatientRepository,
  StoredMessage,
  TurnContext,
} from '../types/index.js';

/** Ventana de continuidad por defecto, en horas (VENTANA_CONTINUIDAD_HORAS). */
export const VENTANA_CONTINUIDAD_HORAS_POR_DEFECTO = 72;

/** Region por defecto para normalizar el telefono (DEFAULT_PHONE_REGION). */
export const REGION_TELEFONICA_POR_DEFECTO = 'PE';

/**
 * Cuantos mensajes previos se cargan como historial.
 *
 * VACIO DE LA ESPECIFICACION: no fija un tamano. 40 mensajes cubren de sobra
 * una conversacion de recepcion completa (una llamada tipica no pasa de 20
 * turnos) sin que una conversacion larga acabe inflando el prompt y la
 * latencia del canal de voz.
 */
export const LIMITE_DE_HISTORIAL_POR_DEFECTO = 40;

export class MessageRouterError extends Error {
  constructor(
    message: string,
    readonly codigo: 'telefono_invalido' | 'clinica_desconocida',
  ) {
    super(message);
    this.name = 'MessageRouterError';
  }
}

export interface MessageRouterDeps {
  clinics: ClinicRepository;
  patients: PatientRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  logger: Logger;
}

export interface MessageRouterOptions {
  ventanaContinuidadHoras?: number;
  /** Region ISO-3166 alpha-2. Viene de `config.DEFAULT_PHONE_REGION`. */
  regionPorDefecto?: string;
  limiteDeHistorial?: number;
}

/**
 * Patrones de NO-COMPRENSION en lo que dijo el asistente.
 *
 * VACIO DE LA ESPECIFICACION: `TurnContext.comprehensionFailures` es un
 * contador de "fallos de comprension CONSECUTIVOS" (bloque 7 del prompt), pero
 * ningun puerto de `ports.ts` lo persiste: no hay columna ni repositorio para
 * el. Se reconstruye leyendo la cola del historial, que si es autoritativo.
 * Es una heuristica sobre texto y esta declarada como tal; el coste de
 * equivocarse esta sesgado a favor del paciente (contar de mas ofrece antes la
 * salida alternativa, contar de menos solo retrasa un turno esa oferta).
 */
const PATRONES_DE_NO_COMPRENSION: readonly RegExp[] = [
  /\bno (le |te )?(entend|escuch|logro entender|alcance a escuchar)/i,
  /\bno (le |te )?comprend/i,
  /\b(me lo|se lo|lo) puede repetir\b/i,
  /\b(puede|podria) (repetir|repetirmelo|decirlo de nuevo)\b/i,
  /\bdisculpe,? (no|se corto)/i,
  /\bse (corto|escucho entrecortado)\b/i,
  /\bperdon,? no (le|te)/i,
];

/** True si ese texto del asistente es un "no le entendi". */
export function esFalloDeComprension(texto: string): boolean {
  return PATRONES_DE_NO_COMPRENSION.some((re) => re.test(texto));
}

/**
 * Cuenta fallos CONSECUTIVOS mirando la cola del historial. Se detiene en el
 * primer turno del asistente que si entendio: el contador vuelve a cero en
 * cuanto hay un turno comprendido, tal como exige el criterio 4 del prompt.
 */
export function contarFallosDeComprension(history: readonly StoredMessage[]): number {
  let fallos = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const mensaje = history[i] as StoredMessage;
    if (mensaje.rol !== 'assistant') continue;
    if (!esFalloDeComprension(mensaje.contenido)) break;
    fallos += 1;
  }
  return fallos;
}

/**
 * Normaliza a E.164 con la region por defecto de la clinica.
 *
 * El adaptador de canal ya deberia entregar E.164 (`InboundMessage` lo declara
 * asi), pero la identidad del paciente depende de esta cadena: si un canal
 * entrega "987 654 321" y otro "+51987654321", el mismo paciente se parte en
 * dos filas y la continuidad multicanal deja de funcionar en silencio. Se
 * normaliza aqui, una sola vez, para que ese fallo no dependa de la disciplina
 * de cada adaptador.
 */
export function normalizarTelefono(crudo: string, region: string): string {
  const regionValida = isSupportedCountry(region) ? region : undefined;
  const parseado = parsePhoneNumberFromString(crudo.trim(), regionValida);
  if (!parseado || !parseado.isValid()) {
    throw new MessageRouterError(
      `no se pudo normalizar el telefono a E.164 con la region "${region}"`,
      'telefono_invalido',
    );
  }
  return parseado.number;
}

/** Comprueba que la zona horaria de la clinica es una IANA valida. Solo avisa. */
export function zonaHorariaEsValida(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('es-PE', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export class MessageRouter {
  private readonly ventanaMs: number;
  private readonly region: string;
  private readonly limiteDeHistorial: number;
  private readonly logger: Logger;
  /** Clinicas cuya zona horaria ya se verifico. Evita pagar el Intl en cada turno. */
  private readonly zonasVerificadas = new Set<string>();

  constructor(
    private readonly deps: MessageRouterDeps,
    options: MessageRouterOptions = {},
  ) {
    const horas = options.ventanaContinuidadHoras ?? VENTANA_CONTINUIDAD_HORAS_POR_DEFECTO;
    this.ventanaMs = horas * 60 * 60 * 1000;
    this.region = options.regionPorDefecto ?? REGION_TELEFONICA_POR_DEFECTO;
    this.limiteDeHistorial = options.limiteDeHistorial ?? LIMITE_DE_HISTORIAL_POR_DEFECTO;
    this.logger = deps.logger.child({ componente: 'message.router' });
  }

  /** Construye el contexto del turno. No persiste el mensaje entrante: eso es del servicio. */
  async route(input: InboundMessage): Promise<TurnContext> {
    const telefonoE164 = normalizarTelefono(input.patientPhoneE164, this.region);

    const clinic = await this.deps.clinics.findById(input.clinicId);
    if (!clinic) {
      throw new MessageRouterError(
        `clinica desconocida: ${input.clinicId}`,
        'clinica_desconocida',
      );
    }

    if (!this.zonasVerificadas.has(clinic.id)) {
      this.zonasVerificadas.add(clinic.id);
      if (!zonaHorariaEsValida(clinic.timezone)) {
        this.logger.error(
          { clinicId: clinic.id, timezone: clinic.timezone },
          'la zona horaria de la clinica no es una IANA valida; las fechas caeran a UTC y el agente agendara mal',
        );
      }
    }

    const patient = await this.deps.patients.upsert(clinic.id, telefonoE164, input.patientName);

    const ahora = input.receivedAt;
    const desde = new Date(ahora.getTime() - this.ventanaMs);

    const existente = await this.deps.conversations.findActiveWithin(clinic.id, patient.id, desde);
    const conversation: Conversation =
      existente ?? (await this.deps.conversations.create(clinic.id, patient.id, input.channel));

    // El salto de canal se calcula ANTES del `touch`: despues, `ultimoCanal` ya
    // es el canal de este turno y la comparacion siempre daria falso.
    const channelSwitched = existente !== null && existente.ultimoCanal !== input.channel;

    // El historial se lee antes de escribir nada de este turno: `history` es lo
    // que paso ANTES, no incluye el mensaje que estamos atendiendo.
    const history = await this.deps.messages.listByConversation(
      conversation.id,
      this.limiteDeHistorial,
    );

    await this.deps.conversations.touch(conversation.id, input.channel);

    if (channelSwitched) {
      this.logger.info(
        {
          conversationId: conversation.id,
          canalAnterior: existente?.ultimoCanal,
          canalNuevo: input.channel,
        },
        'continuidad multicanal: la conversacion cambia de canal; el agente debe anunciarlo',
      );
    }

    return {
      conversationId: conversation.id,
      clinic,
      patient,
      channel: input.channel,
      sessionId: input.sessionId,
      history,
      channelSwitched,
      comprehensionFailures: contarFallosDeComprension(history),
      // `now` es el instante del turno. Un `Date` de JavaScript NO lleva zona:
      // es un instante absoluto. "En la zona de la clinica" se materializa al
      // renderizarlo (prompt.builder usa `clinic.timezone` con Intl) y al
      // validar horarios (crear_cita hace lo mismo). Aqui solo se comprueba que
      // la zona declarada existe, para que el fallo no aparezca a mitad de una
      // conversacion.
      now: ahora,
    } satisfies TurnContext;
  }
}
