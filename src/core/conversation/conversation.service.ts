/**
 * EL servicio de conversacion. Uno solo, comun a los dos canales.
 *
 * Aqui se junta todo: enrutado, las tres capas de control, RAG, prompt, modelo,
 * herramientas y persistencia. Es tambien el unico sitio donde se resuelve la
 * tension entre emitir en streaming (que el canal de voz exige) y verificar la
 * salida con un guardrail BLOQUEANTE (que la seguridad exige). Ver
 * `VerificadorDeSalida`, mas abajo: ahi esta la decision y su coste.
 *
 * ORDEN DEL TURNO
 *   1. El router construye el `TurnContext` (§10).
 *   2. Se persiste el mensaje entrante: el historial autoritativo es esta base.
 *   3. CAPA 1 sobre la entrada. Marca, NO bloquea.
 *   4. CAPA 3 (urgencia) se LANZA aqui y corre en paralelo con RAG y con la
 *      generacion. No se espera en serie: es un requisito de latencia (C4).
 *   5. RAG -> PromptBuilder -> modelo con el bucle de herramientas.
 *   6. CAPA 2 sobre la salida, BLOQUEANTE, con `evidence` EXPLICITA.
 *   7. Persistencia de mensajes y latencias.
 */
import type {
  AuditRepository,
  Channel,
  ClaudeCallOptions,
  ClaudeMessage,
  ClaudePort,
  ClaudeStreamChunk,
  ClaudeToolUse,
  EscalationRequest,
  GuardrailResult,
  InboundMessage,
  KnowledgeChunk,
  Logger,
  MessageRepository,
  OutboundMessage,
  OutboundViolation,
  RagPort,
  StoredMessage,
  ToolRegistry,
  TurnChunk,
  TurnContext,
  UrgencyResult,
} from '../types/index.js';
import type { ConversationService } from '../types/index.js';
import type { ToolLoopResult } from '../claude/claude.service.js';
import type { PromptBuilder } from '../claude/prompt.builder.js';
import { detectOutboundViolations, type OutboundEvidence } from '../claude/guardrails.js';
import type { EscalarHumanoOutput } from '../tools/escalar-humano.tool.js';
import type { MessageRouter } from './message.router.js';

// ---------------------------------------------------------------------------
// Puertos locales
//
// No redefinen nada de `ports.ts`: cubren dos capacidades que el contrato
// congelado no expresa y que el orquestador necesita inyectar para poder
// probarse sin red.
// ---------------------------------------------------------------------------

/**
 * `ClaudePort` mas el bucle de herramientas.
 *
 * `streamLoop` no esta en `ClaudePort` a proposito (el puerto no conoce
 * herramientas de negocio), pero el orquestador si lo necesita. Se declara
 * aqui como extension estructural: `ClaudeService` la cumple sin cambiar nada.
 */
export interface ClaudeToolLoopPort extends ClaudePort {
  streamLoop(
    opts: ClaudeCallOptions,
    ejecutar: (toolUse: ClaudeToolUse) => Promise<ToolLoopResult>,
    maxIteraciones?: number,
  ): AsyncIterable<ClaudeStreamChunk>;
}

/** Lo unico que el orquestador usa del detector de urgencia (capa 3). */
export interface UrgencyPort {
  detectUrgency(text: string): Promise<UrgencyResult>;
}

/** Lo unico que el orquestador usa de los guardrails (capas 1 y 2). */
export interface GuardrailChecker {
  checkInbound(text: string, channel: Channel, ctx?: TurnContext): GuardrailResult;
  checkOutbound(text: string, ctx: TurnContext, evidence?: OutboundEvidence): GuardrailResult;
}

// ---------------------------------------------------------------------------
// Textos canonicos del orquestador
// ---------------------------------------------------------------------------

/**
 * Protocolo de urgencia (bloque 5 del prompt maestro). Es texto PURO: lo
 * consume igual el sintetizador de voz que el formateador de WhatsApp.
 *
 * Redactado para no disparar la capa 2 sobre si mismo (hay un test que lo
 * comprueba): ni promete, ni diagnostica, ni afirma ser una persona.
 */
export const MENSAJE_DE_URGENCIA =
  'Por lo que me indica, esto necesita atención inmediata. No espere: acuda ahora al servicio de ' +
  'emergencia más cercano o al contacto de urgencias de la clínica. Le estoy pasando con una persona ' +
  'del equipo en este momento.';

/** Fallo tecnico. El modo de fallo del sistema es la reversion a manual, nunca el silencio (O5). */
export const MENSAJE_DE_FALLO_TECNICO =
  'Disculpe, tuve un problema para atenderle en este momento. Le voy a pasar con una persona del ' +
  'equipo para que le ayude.';

/** El modelo no produjo nada emitible. Tampoco aqui se deja al paciente en silencio. */
export const MENSAJE_SIN_RESPUESTA =
  'Disculpe, no logré preparar una respuesta. ¿Quiere que le pase con alguien del equipo?';

// ---------------------------------------------------------------------------
// El nudo: streaming contra un guardrail bloqueante
// ---------------------------------------------------------------------------

/**
 * Violaciones que texto posterior NO puede deshacer.
 *
 * Dependen de la PRESENCIA de un patron: una vez que el modelo dijo «usted
 * tiene una infeccion», nada de lo que escriba despues lo borra. Sobre estas,
 * verificar un prefijo es una decision SOLIDA: si el prefijo viola, el texto
 * completo tambien. Por eso se puede cortar de inmediato, sin esperar al final.
 */
export const VIOLACIONES_IRRECUPERABLES: readonly OutboundViolation[] = [
  'afirmacion_clinica',
  'afirmacion_de_ser_humano',
  'promesa_de_resultado',
] as const;

/**
 * Las otras dos dependen de una AUSENCIA y pueden limpiarse dentro del mismo
 * turno, asi que no se cortan: se RETIENEN.
 *   · `precio_cerrado_sin_valoracion` desaparece si una frase posterior anade
 *     la mencion obligatoria a la valoracion.
 *   · `cita_afirmada_sin_tool_call` desaparece si `crear_cita` responde `ok`
 *     mas adelante en el mismo turno (la evidencia cambia, no el texto).
 */
export function esIrrecuperable(violaciones: readonly OutboundViolation[]): boolean {
  return violaciones.some((v) => VIOLACIONES_IRRECUPERABLES.includes(v));
}

export interface DecisionDeEmision {
  /** Texto ya verificado y listo para salir. Puede ser cadena vacia. */
  emitir: string;
  /** Si viene, el turno se corta: no se emite nada mas del modelo. */
  corte?: { motivo: string; replacement: string };
}

/**
 * COMO SE CONCILIA EL STREAMING CON UN GUARDRAIL BLOQUEANTE.
 *
 * El problema es real y no tiene solucion perfecta: la capa 2 dictamina sobre
 * un TEXTO COMPLETO, y el canal de voz necesita que se emita antes de que ese
 * texto exista. Lo que ya se sintetizo no se puede desdecir.
 *
 * DECISION: se verifica por FRASES COMPLETAS y sobre el PREFIJO ACUMULADO, con
 * un retardo configurable de una frase. Nunca sale un caracter que no haya
 * pasado por `checkOutbound`.
 *
 * La garantia que se ofrece, y es la mas fuerte que admite el streaming:
 *
 *   INVARIANTE DE EMISION — en todo momento, el texto ya emitido, evaluado
 *   COMO UN TODO por la capa 2, pasa.
 *
 * Como se sostiene:
 *   1. Solo se emite en limites de frase (`.`, `?`, `!`, salto de linea).
 *   2. Se verifica el prefijo COMPLETO acumulado, no la frase suelta. Verificar
 *      frase a frase seria mas estricto (una frase con un rango de precio
 *      todavia no acompanado de la mencion de valoracion daria falso positivo)
 *      y ademas ciego a los patrones que cruzan el limite entre frases.
 *   3. Retardo de una frase: la frase N se emite cuando ya llego la N+1 y el
 *      prefijo hasta N+1 pasa. Cubre los patrones que se completan a caballo
 *      de dos frases y da margen a que llegue la mencion de valoracion.
 *   4. Violacion IRRECUPERABLE -> corte inmediato: se deja de generar y se
 *      emite la respuesta canonica.
 *   5. Violacion RECUPERABLE -> RETENCION: no se emite y se sigue generando.
 *      Si el texto posterior la limpia, se emite todo junto. Si no, al cerrar
 *      se descarta y sale la respuesta canonica. El coste esta aceptado: para
 *      ese tramo, el turno deja de ser streaming. Preferimos perder latencia a
 *      soltar un precio cerrado por el altavoz.
 *
 * LO QUE ESTA DECISION NO CUBRE (declarado, no escondido):
 *   a. Si el modelo abre limpio y ensucia despues, el prefijo limpio YA SALIO.
 *      Se corta el resto y se emite la respuesta canonica, pero el paciente ya
 *      escucho ese prefijo. Es inevitable en cualquier esquema de streaming; lo
 *      unico que se garantiza es que ese prefijo, por si solo, no viola nada.
 *   b. Un patron que se complete a mas de una frase de distancia (retardo > 1)
 *      no se ve venir. Es una cota deliberada: subir el retardo sube la
 *      latencia percibida en voz, que es el motivo de existir del streaming.
 *   c. Un turno sin ningun signo de puntuacion no tiene limites de frase y se
 *      comporta como no-streaming: se verifica entero al cerrar.
 */
export class VerificadorDeSalida {
  private texto = '';
  private emitidoHasta = 0;
  private escaneadoHasta = 0;
  private readonly limites: number[] = [];

  constructor(
    private readonly ctx: TurnContext,
    private readonly guardrails: GuardrailChecker,
    /** Getter, no valor: la evidencia cambia dentro del turno segun se ejecutan las herramientas. */
    private readonly evidencia: () => OutboundEvidence,
    private readonly retardoDeFrases: number,
  ) {}

  /** Todo lo que el modelo lleva producido, emitido o no. */
  get textoDelModelo(): string {
    return this.texto;
  }

  push(delta: string): DecisionDeEmision {
    this.texto += delta;
    this.detectarLimites();

    const indice = this.limites.length - 1 - this.retardoDeFrases;
    if (indice < 0) return { emitir: '' };
    const hasta = this.limites[indice] as number;
    if (hasta <= this.emitidoHasta) return { emitir: '' };
    return this.evaluarPrefijo(hasta);
  }

  /** Fin del stream: se dictamina sobre el texto COMPLETO, sin excepciones. */
  cerrar(): DecisionDeEmision {
    if (this.texto.length === this.emitidoHasta) return { emitir: '' };
    const resultado = this.guardrails.checkOutbound(this.texto, this.ctx, this.evidencia());
    if (resultado.pass) {
      const emitir = this.texto.slice(this.emitidoHasta);
      this.emitidoHasta = this.texto.length;
      return { emitir };
    }
    return {
      emitir: '',
      corte: {
        motivo: resultado.reason ?? 'violacion_capa_2',
        replacement: resultado.replacement ?? MENSAJE_SIN_RESPUESTA,
      },
    };
  }

  /**
   * Las decisiones intermedias usan la funcion PURA, no `GuardrailService`:
   * retener no es un incidente y no debe ensuciar la auditoria. El incidente se
   * registra una sola vez, cuando de verdad se bloquea.
   */
  private evaluarPrefijo(hasta: number): DecisionDeEmision {
    const candidato = this.texto.slice(0, hasta);
    const violaciones = detectOutboundViolations(candidato, this.ctx, this.evidencia());

    if (violaciones.length === 0) {
      const emitir = this.texto.slice(this.emitidoHasta, hasta);
      this.emitidoHasta = hasta;
      return { emitir };
    }
    if (!esIrrecuperable(violaciones)) return { emitir: '' }; // retencion

    const resultado = this.guardrails.checkOutbound(candidato, this.ctx, this.evidencia());
    return {
      emitir: '',
      corte: {
        motivo: resultado.reason ?? violaciones.join(','),
        replacement: resultado.replacement ?? MENSAJE_SIN_RESPUESTA,
      },
    };
  }

  /**
   * Un limite de frase es el final de una corrida de `.!?` o de salto de linea
   * SEGUIDA de espacio. La exigencia de espacio evita partir «S/ 2.500» y evita
   * dar por cerrada una frase que solo esta a medio llegar por el stream.
   */
  private detectarLimites(): void {
    const re = /[.!?]+(?=\s)|\n+/g;
    re.lastIndex = this.escaneadoHasta;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.texto)) !== null) {
      const fin = m.index + m[0].length;
      this.limites.push(fin);
      this.escaneadoHasta = fin;
      re.lastIndex = fin;
    }
  }
}

// ---------------------------------------------------------------------------
// Historial -> hilo de mensajes del modelo
// ---------------------------------------------------------------------------

/**
 * El hilo que ve el modelo se reconstruye SIEMPRE desde la base propia
 * (anti-patron 6). Se descartan los roles `tool` y `system`: el resultado de
 * las herramientas de turnos anteriores ya no es accionable y meterlo en el
 * hilo invita al modelo a reutilizar una cita vieja como si fuera de ahora.
 */
export function historialAMensajes(
  history: readonly StoredMessage[],
  textoActual: string,
): ClaudeMessage[] {
  const mensajes: ClaudeMessage[] = [];
  for (const m of history) {
    if (m.rol !== 'user' && m.rol !== 'assistant') continue;
    const ultimo = mensajes[mensajes.length - 1];
    if (ultimo && ultimo.role === m.rol) {
      ultimo.content = `${ultimo.content}\n${m.contenido}`;
      continue;
    }
    // El hilo tiene que empezar en `user`: la API rechaza un primer turno de
    // assistant, y un historial puede empezar por el saludo del agente.
    if (mensajes.length === 0 && m.rol === 'assistant') continue;
    mensajes.push({ role: m.rol, content: m.contenido });
  }
  const ultimo = mensajes[mensajes.length - 1];
  if (ultimo && ultimo.role === 'user') ultimo.content = `${ultimo.content}\n${textoActual}`;
  else mensajes.push({ role: 'user', content: textoActual });
  return mensajes;
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export interface ConversationServiceDeps {
  router: MessageRouter;
  claude: ClaudeToolLoopPort;
  promptBuilder: PromptBuilder;
  rag: RagPort;
  urgency: UrgencyPort;
  guardrails: GuardrailChecker;
  tools: ToolRegistry;
  messages: MessageRepository;
  logger: Logger;
  audit?: AuditRepository;
}

export interface ConversationServiceOptions {
  /** Modelo de CONVERSACION. Si falta, decide el `ClaudePort`. */
  model?: string;
  maxTokens?: number;
  /**
   * Modelo y tope de tokens SOLO para el canal de voz. Si no se fijan, se usan
   * los generales.
   *
   * Existen por una medida, no por gusto. Con el prompt maestro real y una
   * pregunta corriente, una unica llamada tarda:
   *
   *     sonnet-5,  1024 tokens, sin cache : 8395 / 6623 / 3568 ms
   *     sonnet-5,  1024 tokens, con cache : 5379 / 4446 / 3821 ms
   *     sonnet-5,   250 tokens, con cache : 3384 / 4344 / 4155 ms
   *     haiku-4.5,  250 tokens, con cache : 1042 / 1547 / 1170 ms
   *
   * En texto, esperar cuatro segundos es aceptable. En una llamada telefonica
   * no lo es: el objetivo declarado son 1200 ms, ElevenLabs corta a los 15 s, y
   * por encima de dos o tres segundos la conversacion deja de parecer una
   * conversacion. El coste es que en voz responde un modelo menos capaz.
   *
   * Lo que NO cambia al cambiar de modelo: las tres capas de guardrails, el
   * detector de urgencia, la validacion de las herramientas y el contexto del
   * RAG. Los controles no dependen de que el modelo se porte bien.
   */
  modelVoz?: string;
  maxTokensVoz?: number;
  /** Frases de retardo antes de emitir. 0 = emitir en cuanto el prefijo pasa. */
  retardoDeFrases?: number;
  /** Retardo SOLO en voz. Por defecto 0: alli el retardo se oye como silencio. */
  retardoDeFrasesVoz?: number;
  maxIteracionesDeHerramientas?: number;
  limiteFragmentosRag?: number;
}

const RETARDO_DE_FRASES_POR_DEFECTO = 1;

export class ConversationServiceImpl implements ConversationService {
  private readonly logger: Logger;
  private readonly opciones: Required<Pick<ConversationServiceOptions, 'retardoDeFrases'>> &
    ConversationServiceOptions;

  constructor(
    private readonly deps: ConversationServiceDeps,
    opciones: ConversationServiceOptions = {},
  ) {
    this.logger = deps.logger.child({ componente: 'conversation.service' });
    this.opciones = {
      ...opciones,
      retardoDeFrases: opciones.retardoDeFrases ?? RETARDO_DE_FRASES_POR_DEFECTO,
      retardoDeFrasesVoz: opciones.retardoDeFrasesVoz ?? 0,
    };
  }

  /**
   * `handleTurn` CONSUME `streamTurn`. Deliberado: si hubiera dos
   * implementaciones, la de texto y la de voz podrian divergir en los controles
   * y solo una quedaria cubierta por los tests. Hay un solo flujo.
   */
  async handleTurn(input: InboundMessage): Promise<OutboundMessage> {
    let final: OutboundMessage | undefined;
    for await (const chunk of this.streamTurn(input)) {
      if (chunk.type === 'done') final = chunk.message;
    }
    if (!final) {
      throw new Error('el turno termino sin emitir el chunk `done`');
    }
    return final;
  }

  async *streamTurn(input: InboundMessage): AsyncIterable<TurnChunk> {
    const inicio = Date.now();

    // Si esto falla no hay `conversationId` y no se puede construir un
    // `OutboundMessage`: la excepcion sube al adaptador de canal, que es quien
    // sabe como disculparse en su medio.
    const ctx = await this.deps.router.route(input);
    const log = this.logger.child({
      conversationId: ctx.conversationId,
      canal: ctx.channel,
      clinicId: ctx.clinic.id,
    });

    await this.deps.messages.append({
      conversationId: ctx.conversationId,
      rol: 'user',
      contenido: input.text,
      canal: ctx.channel,
      sessionId: ctx.sessionId,
    });

    // CAPA 1. Marca, no bloquea. No se usa su `replacement`: cortar el turno
    // aqui dejaria sin atender a quien dice «me duele una muela, quiero cita»,
    // que es la consulta mas comun de una recepcion. Lo que si hace falta es
    // que quede registrado y que la capa 2 vigile la salida.
    const entrada = this.deps.guardrails.checkInbound(input.text, ctx.channel, ctx);
    if (!entrada.pass) {
      log.warn({ capa: 1, flags: entrada.reason }, 'mensaje entrante marcado por la capa 1');
    }

    // CAPA 3 EN PARALELO. Se lanza ANTES del RAG y no se espera aqui: el
    // presupuesto de latencia del control C4 no admite encadenar clasificador y
    // generacion. El `catch` evita un rechazo sin gestionar; el detector ya
    // promete no lanzar, esto es cinturon y tirantes.
    let urgencia: UrgencyResult | undefined;
    const enCursoUrgencia = this.deps.urgency.detectUrgency(input.text).then(
      (r) => {
        urgencia = r;
      },
      (err: unknown) => {
        log.error({ capa: 3, error: String(err) }, 'el detector de urgencia lanzo; se sigue sin su veredicto');
      },
    );

    const fragmentos = await this.recuperarContexto(ctx, input.text, log);

    // Punto de control 1: el pre-filtro lexico de la capa 3 resuelve sin red,
    // asi que a esta altura ya suele haber veredicto. Si es urgencia, la
    // respuesta comercial no llega ni a empezar.
    if (urgencia?.isUrgent) {
      yield* this.protocoloDeUrgencia(ctx, input, urgencia, inicio, '', log);
      return;
    }

    const evidencia: OutboundEvidence = { citaCreada: false };
    const verificador = new VerificadorDeSalida(
      ctx,
      this.deps.guardrails,
      () => evidencia,
      // En VOZ el retardo se paga en silencio audible: la frase 1 no sale
      // hasta que llega la 2, asi que el paciente espera un turno entero de
      // generacion antes de oir nada. Con retardo 0 se emite en cuanto el
      // prefijo pasa la capa 2.
      //
      // No es un agujero: una violacion RECUPERABLE sigue provocando
      // RETENCION, no emision. Lo que se pierde es streaming en ese tramo
      // -- se degrada a esperar-- no la garantia. Lo que si baja es el margen
      // para patrones que se completan en la frase siguiente; en texto, donde
      // el retardo no se oye, se mantiene en 1.
      (ctx.channel === 'voice' ? this.opciones.retardoDeFrasesVoz : undefined) ??
        this.opciones.retardoDeFrases,
    );

    let emitido = '';
    let escalacionDelModelo: EscalationRequest | undefined;
    let corte: { motivo: string; replacement: string } | undefined;
    let tokensIn = 0;
    let tokensOut = 0;

    try {
      const prompt = this.deps.promptBuilder.build({ ctx, fragmentos });
      const opciones: ClaudeCallOptions = {
        system: prompt.system,
        // Bloques 1-7: identicos en todos los turnos y en ambos canales, y
        // reenviados en cada iteracion del bucle de herramientas. Es el tramo
        // que vale la pena cachear; lo que va detras (contexto RAG, sesion y
        // estilo) cambia y se deja fuera a proposito.
        systemPrefijoCacheable: prompt.segments.invariable,
        messages: historialAMensajes(ctx.history, input.text),
        tools: this.deps.tools.toClaudeToolDefinitions(),
      };
      // El canal decide el modelo. Ver `modelVoz` para el porque y las medidas.
      const esVoz = ctx.channel === 'voice';
      const modelo = (esVoz ? this.opciones.modelVoz : undefined) ?? this.opciones.model;
      const tope = (esVoz ? this.opciones.maxTokensVoz : undefined) ?? this.opciones.maxTokens;
      if (modelo !== undefined) opciones.model = modelo;
      if (tope !== undefined) opciones.maxTokens = tope;

      const ejecutar = async (toolUse: ClaudeToolUse): Promise<ToolLoopResult> => {
        const resultado = await this.ejecutarHerramienta(toolUse, ctx, log);
        // EVIDENCIA EXPLICITA PARA LA CAPA 2. Es esto, y solo esto, lo que
        // separa «el modelo dice que agendo» de «la agenda tiene la cita».
        // Sin pasarlo, `checkOutbound` cae en una heuristica sobre el historial
        // que falla cerrado y bloquea confirmaciones legitimas.
        if (toolUse.name === 'crear_cita' && resultado.estado === 'ok') evidencia.citaCreada = true;
        if (toolUse.name === 'escalar_humano' && resultado.estado === 'ok') {
          escalacionDelModelo = (resultado.datos as EscalarHumanoOutput | undefined)?.request;
        }
        return resultado.paraElModelo;
      };

      const iterador = this.deps.claude
        .streamLoop(opciones, ejecutar, this.opciones.maxIteracionesDeHerramientas)
        [Symbol.asyncIterator]();

      try {
        for (;;) {
          const paso = await iterador.next();
          if (paso.done === true) break;

          // Punto de control 2: la urgencia puede resolver a mitad de la
          // generacion. En cuanto lo hace, se abandona la respuesta comercial.
          if (urgencia?.isUrgent) break;

          const chunk = paso.value;
          if (chunk.type === 'text') {
            const decision = verificador.push(chunk.delta);
            if (decision.emitir !== '') {
              emitido += decision.emitir;
              yield { type: 'text', delta: decision.emitir };
            }
            if (decision.corte) {
              corte = decision.corte;
              break;
            }
          } else if (chunk.type === 'tool_use') {
            yield { type: 'tool_call', name: chunk.toolUse.name, args: chunk.toolUse.input };
          } else {
            tokensIn += chunk.tokensIn;
            tokensOut += chunk.tokensOut;
          }
        }
      } finally {
        // Cortar el stream cierra tambien el bucle de herramientas: sin esto,
        // un corte por urgencia dejaria al modelo generando contra el vacio.
        await iterador.return?.(undefined);
      }
    } catch (err) {
      log.error({ error: err instanceof Error ? err.message : String(err) }, 'fallo la generacion del turno');
      yield* this.protocoloDeFalloTecnico(ctx, input, inicio, emitido, log);
      return;
    }

    // Punto de control 3: no se cierra un turno con el veredicto de urgencia
    // pendiente. La espera no es serie con la generacion (ya corrio en
    // paralelo) y el detector trae su propio timeout.
    await enCursoUrgencia;
    const veredicto = urgencia;
    if (veredicto?.isUrgent) {
      yield* this.protocoloDeUrgencia(ctx, input, veredicto, inicio, emitido, log);
      return;
    }

    if (!corte) {
      const cierre = verificador.cerrar();
      if (cierre.emitir !== '') {
        emitido += cierre.emitir;
        yield { type: 'text', delta: cierre.emitir };
      }
      corte = cierre.corte;
    }

    if (corte) {
      log.warn(
        { capa: 2, motivo: corte.motivo, yaEmitido: emitido.length },
        'capa 2: se corta la respuesta del modelo y se emite la respuesta canonica',
      );
      const separador = emitido.endsWith(' ') || emitido === '' ? '' : ' ';
      emitido += separador + corte.replacement;
      yield { type: 'text', delta: separador + corte.replacement };
    }

    if (emitido.trim() === '') {
      emitido = MENSAJE_SIN_RESPUESTA;
      yield { type: 'text', delta: emitido };
    }

    if (escalacionDelModelo) {
      yield { type: 'escalate', request: escalacionDelModelo };
    }

    const latencyMs = Date.now() - inicio;
    await this.persistirRespuesta(ctx, emitido, { tokensIn, tokensOut, latencyMs });

    const mensaje: OutboundMessage = {
      conversationId: ctx.conversationId,
      text: emitido,
      channel: ctx.channel,
      latencyMs,
    };
    if (escalacionDelModelo) mensaje.escalate = escalacionDelModelo;
    yield { type: 'done', message: mensaje };
  }

  // -------------------------------------------------------------------------
  // Piezas del turno
  // -------------------------------------------------------------------------

  /** El RAG nunca tumba el turno: sin contexto, el prompt declara que no tiene el dato. */
  private async recuperarContexto(
    ctx: TurnContext,
    texto: string,
    log: Logger,
  ): Promise<KnowledgeChunk[]> {
    try {
      return await this.deps.rag.retrieve(ctx.clinic.id, texto, this.opciones.limiteFragmentosRag);
    } catch (err) {
      log.error({ error: String(err) }, 'fallo la recuperacion RAG; se sigue sin contexto aprobado');
      return [];
    }
  }

  /**
   * Ejecuta una herramienta y deja rastro. El resultado se persiste como
   * mensaje de rol `tool`: es lo que hace auditable el turno y lo que alimenta,
   * en turnos POSTERIORES, la heuristica de respaldo de la capa 2.
   */
  private async ejecutarHerramienta(
    toolUse: ClaudeToolUse,
    ctx: TurnContext,
    log: Logger,
  ): Promise<{ estado: string; datos: unknown; paraElModelo: ToolLoopResult }> {
    const herramienta = this.deps.tools.get(toolUse.name);
    if (!herramienta) {
      // No se lanza: el modelo puede corregirse si se le devuelve el error.
      log.warn({ herramienta: toolUse.name }, 'el modelo pidio una herramienta que no existe');
      const content = JSON.stringify({
        status: 'error',
        error: `herramienta desconocida: ${toolUse.name}`,
      });
      return {
        estado: 'error',
        datos: undefined,
        paraElModelo: { toolUseId: toolUse.id, content, isError: true },
      };
    }

    const resultado = await herramienta.execute(toolUse.input, ctx);
    const contenido = JSON.stringify({
      herramienta: toolUse.name,
      status: resultado.status,
      data: resultado.data,
      error: resultado.error,
    });

    try {
      await this.deps.messages.append({
        conversationId: ctx.conversationId,
        rol: 'tool',
        contenido,
        canal: ctx.channel,
        sessionId: ctx.sessionId,
        latenciaMs: resultado.latencyMs,
      });
    } catch (err) {
      // Un fallo persistiendo la traza no puede tumbar la conversacion.
      log.error({ error: String(err), herramienta: toolUse.name }, 'no se pudo persistir el resultado de la herramienta');
    }

    return {
      estado: resultado.status,
      datos: resultado.data,
      paraElModelo: {
        toolUseId: toolUse.id,
        content: contenido,
        isError: resultado.status !== 'ok',
      },
    };
  }

  /**
   * Protocolo de urgencia. Prevalece sobre todo lo demas (bloque 5 del prompt).
   *
   * Escala POR LA HERRAMIENTA, no a mano: la lista blanca de transferencia, el
   * aviso a recepcion y el registro auditable viven en `escalar_humano` y no se
   * duplican aqui.
   */
  private async *protocoloDeUrgencia(
    ctx: TurnContext,
    input: InboundMessage,
    urgencia: UrgencyResult,
    inicio: number,
    yaEmitido: string,
    log: Logger,
  ): AsyncIterable<TurnChunk> {
    log.warn(
      { capa: 3, senales: urgencia.signals, confianza: urgencia.confidence, yaEmitido: yaEmitido.length },
      'URGENCIA: se aborta la respuesta comercial y se fuerza el protocolo de urgencia',
    );

    const request: EscalationRequest = {
      reason: 'urgencia',
      priority: 'urgente',
      summaryForAgent:
        `URGENCIA detectada por la capa 3 (confianza ${urgencia.confidence}). ` +
        `Senales: ${urgencia.signals.join(', ') || 'sin detalle'}. ` +
        `Ultimo mensaje del paciente: ${input.text}`,
      messageForPatient: MENSAJE_DE_URGENCIA,
    };
    // En voz la derivacion es una transferencia real; la herramienta valida el
    // numero contra la lista blanca y lo descarta si no esta.
    const primero = ctx.clinic.transferWhitelist[0];
    if (ctx.channel === 'voice' && primero) request.transferNumber = primero;

    yield { type: 'tool_call', name: 'escalar_humano', args: request };
    try {
      await this.ejecutarHerramienta(
        { id: `urgencia-${ctx.conversationId}`, name: 'escalar_humano', input: { ...request } },
        ctx,
        log,
      );
    } catch (err) {
      log.fatal({ error: String(err) }, 'fallo el escalamiento de una urgencia');
    }

    /**
     * EXCEPCION NARROW Y DELIBERADA A LA CAPA 2.
     *
     * El texto de urgencia es nuestro, no del modelo, y se verifica igual. Pero
     * si alguna vez fallara, sustituirlo por la respuesta canonica pondria
     * «¿le busco un espacio esta semana?» en boca del agente ante alguien que no
     * puede respirar. Se emite igual y se grita en el log. Hay un test que
     * comprueba que este texto pasa la capa 2, para que la excepcion no se
     * ejerza nunca en la practica.
     */
    const verificado = this.deps.guardrails.checkOutbound(MENSAJE_DE_URGENCIA, ctx, { citaCreada: false });
    if (!verificado.pass) {
      log.fatal(
        { capa: 2, motivo: verificado.reason },
        'el mensaje canonico de urgencia viola la capa 2; se emite igual porque el protocolo de urgencia prevalece',
      );
    }

    yield { type: 'text', delta: MENSAJE_DE_URGENCIA };
    yield { type: 'escalate', request };

    const latencyMs = Date.now() - inicio;
    const texto = yaEmitido === '' ? MENSAJE_DE_URGENCIA : `${yaEmitido} ${MENSAJE_DE_URGENCIA}`;
    await this.persistirRespuesta(ctx, texto, { tokensIn: 0, tokensOut: 0, latencyMs });
    await this.auditar('urgencia_detectada', ctx, {
      senales: urgencia.signals,
      confianza: urgencia.confidence,
      latenciaClasificadorMs: urgencia.latencyMs,
      canal: ctx.channel,
    });

    yield {
      type: 'done',
      message: {
        conversationId: ctx.conversationId,
        text: texto,
        channel: ctx.channel,
        escalate: request,
        latencyMs,
      },
    };
  }

  /** Anti-patron 7: un fallo tecnico produce un mensaje hablable y una derivacion, nunca silencio. */
  private async *protocoloDeFalloTecnico(
    ctx: TurnContext,
    input: InboundMessage,
    inicio: number,
    yaEmitido: string,
    log: Logger,
  ): AsyncIterable<TurnChunk> {
    /**
     * VACIO DE LA ESPECIFICACION: `EscalationReason` es un enum cerrado sin
     * valor para «fallo tecnico». Se usa `fallo_comprension`, que es el mas
     * cercano, y se deja constancia. Anadir un valor obligaria a tocar un
     * contrato congelado.
     */
    const request: EscalationRequest = {
      reason: 'fallo_comprension',
      priority: 'normal',
      summaryForAgent:
        'Fallo tecnico del asistente durante el turno. Ultimo mensaje del paciente: ' + input.text,
      messageForPatient: MENSAJE_DE_FALLO_TECNICO,
    };
    yield { type: 'tool_call', name: 'escalar_humano', args: request };
    try {
      await this.ejecutarHerramienta(
        { id: `fallo-${ctx.conversationId}`, name: 'escalar_humano', input: { ...request } },
        ctx,
        log,
      );
    } catch (err) {
      log.fatal({ error: String(err) }, 'fallo tambien el escalamiento tras un fallo tecnico');
    }

    yield { type: 'text', delta: MENSAJE_DE_FALLO_TECNICO };
    yield { type: 'escalate', request };

    const latencyMs = Date.now() - inicio;
    const texto = yaEmitido === '' ? MENSAJE_DE_FALLO_TECNICO : `${yaEmitido} ${MENSAJE_DE_FALLO_TECNICO}`;
    await this.persistirRespuesta(ctx, texto, { tokensIn: 0, tokensOut: 0, latencyMs });

    yield {
      type: 'done',
      message: {
        conversationId: ctx.conversationId,
        text: texto,
        channel: ctx.channel,
        escalate: request,
        latencyMs,
      },
    };
  }

  private async persistirRespuesta(
    ctx: TurnContext,
    texto: string,
    metricas: { tokensIn: number; tokensOut: number; latencyMs: number },
  ): Promise<void> {
    try {
      await this.deps.messages.append({
        conversationId: ctx.conversationId,
        rol: 'assistant',
        // Se persiste lo que SE EMITIO, no lo que el modelo produjo: el
        // historial autoritativo tiene que coincidir con lo que oyo o leyo el
        // paciente, o el siguiente turno razonara sobre una conversacion que
        // nunca ocurrio.
        contenido: texto,
        canal: ctx.channel,
        sessionId: ctx.sessionId,
        tokensIn: metricas.tokensIn,
        tokensOut: metricas.tokensOut,
        latenciaMs: metricas.latencyMs,
      });
    } catch (err) {
      this.logger.error(
        { conversationId: ctx.conversationId, error: String(err) },
        'no se pudo persistir la respuesta del asistente',
      );
    }
  }

  private async auditar(
    evento: string,
    ctx: TurnContext,
    detalle: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.audit) return;
    try {
      await this.deps.audit.log(evento, detalle, ctx.clinic.id, ctx.conversationId);
    } catch (err) {
      this.logger.error({ evento, error: String(err) }, 'no se pudo registrar el evento de auditoria');
    }
  }
}
