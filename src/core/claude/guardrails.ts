/**
 * Las tres capas de control (especificacion §9, control C3 del informe etico).
 *
 * CAPA 1 (`checkInbound`)  -> deteccion sobre la entrada. NO bloquea: marca.
 * CAPA 2 (`checkOutbound`) -> verificacion de la salida. BLOQUEA y sustituye.
 * CAPA 3 (`urgency.detector.ts`) -> clasificador de urgencia, en paralelo.
 *
 * Por que la capa 2 existe: el prompt es una expectativa, no una garantia
 * (anti-patron 5). Sin esta capa el sistema no tiene ningun control sobre lo
 * que dice. Por eso `pass: false` aqui es bloqueante y siempre trae
 * `replacement`: el nucleo nunca se queda sin nada que decir.
 *
 * Los patrones estan escritos para el ESPANOL DE PERU en registro coloquial y
 * sobre texto NORMALIZADO (minusculas, sin tildes): la transcripcion de voz
 * llega sin tildes y sin puntuacion, y el modelo escribe como habla la
 * recepcion, no como escribiria un manual.
 */
import type {
  AuditRepository,
  Channel,
  GuardrailResult,
  InboundFlag,
  Logger,
  OutboundViolation,
  TurnContext,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Respuestas canonicas
// ---------------------------------------------------------------------------

/**
 * Texto sustituto por violacion. Es texto PURO: lo consume igual el
 * sintetizador de voz que el formateador de WhatsApp.
 *
 * VACIO DE LA ESPECIFICACION: la respuesta canonica esta redactada en el
 * bloque 4 del prompt, pero el prompt es una instruccion para el modelo, no
 * una cadena que la capa 2 pueda emitir. Se declara aqui y se permite
 * sobreescribirla por constructor para que una clinica pueda ajustar el tono
 * sin tocar el codigo.
 */
export const RESPUESTAS_CANONICAS: Record<OutboundViolation, string> = {
  afirmacion_clinica:
    'Entiendo la molestia. Eso lo tiene que valorar el doctor en consulta, porque depende de lo que vea. ¿Le busco un espacio esta semana?',
  precio_cerrado_sin_valoracion:
    'Le puedo dar un rango de referencia, pero el precio final depende de la valoración del doctor, porque cambia según lo que vea en consulta. ¿Le busco un espacio para la valoración?',
  afirmacion_de_ser_humano:
    'Le aclaro: soy el asistente virtual de la clínica, no una persona. Si prefiere hablar con alguien del equipo, se lo paso ahora mismo.',
  cita_afirmada_sin_tool_call:
    'Todavía no le puedo dar la cita por segura: no me consta que haya quedado grabada en la agenda. Permítame verificarlo y le aviso.',
  promesa_de_resultado:
    'No le puedo prometer un resultado; eso lo tiene que ver el doctor en consulta, según su caso. ¿Le busco un espacio para la valoración?',
};

/**
 * Orden de sustitucion cuando hay varias violaciones a la vez. Primero lo que
 * mas dano hace si sale: una afirmacion clinica, y despues la transparencia.
 */
export const PRIORIDAD_DE_VIOLACIONES: readonly OutboundViolation[] = [
  'afirmacion_clinica',
  'afirmacion_de_ser_humano',
  'cita_afirmada_sin_tool_call',
  'promesa_de_resultado',
  'precio_cerrado_sin_valoracion',
] as const;

/** Respuesta cuando la entrada es una consulta clinica (capa 1, informativa). */
export const RESPUESTA_ANTE_CONSULTA_CLINICA = RESPUESTAS_CANONICAS.afirmacion_clinica;

// ---------------------------------------------------------------------------
// Normalizacion
// ---------------------------------------------------------------------------

/**
 * Minusculas, sin diacriticos, sin espacios repetidos.
 *
 * La virgulilla tambien cae: «señor» queda «senor». Es deliberado, porque la
 * transcripcion de voz y el tecleo rapido en WhatsApp la pierden a menudo, y
 * porque asi un solo patron cubre las dos grafias. Todos los patrones de este
 * archivo estan escritos sobre esta forma normalizada.
 */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Palabras que el espanol intercala entre la negacion y el verbo sin cambiar
 * el sentido: cliticos («no SE garantiza», «no LE puedo asegurar») y modales
 * («no PODEMOS garantizar»). La lista es cerrada a proposito: si se permitiera
 * texto arbitrario, un «no» lejano suprimiria una violacion real.
 */
const INTERCALABLES =
  '(?:se|me|te|le|les|lo|la|los|las|nos|puedo|puede|podemos|pueden|podria|podriamos|podemos|vamos a|voy a|se puede|le puedo|te puedo|les puedo)';

const NEGACION_PREVIA = new RegExp(
  `\\b(no|nunca|tampoco|jamas)\\b(?:\\s+${INTERCALABLES}\\b){0,3}[\\s,:;]*$`,
);

/**
 * Busca el primer patron que aparezca SIN una negacion delante.
 * «no soy una persona» debe pasar; «soy una persona» no.
 *
 * La negacion no siempre va pegada al verbo: «no SE garantiza» es la propia
 * FAQ aprobada de la clinica, y con la comprobacion pegada se bloqueaba como
 * si fuera una promesa de resultado. Censurar el contenido aprobado degrada
 * el criterio de «respuestas correctas >= 95%» sin proteger de nada.
 */
function primerMatchAfirmativo(texto: string, patrones: readonly RegExp[]): string | undefined {
  for (const re of patrones) {
    const m = re.exec(texto);
    if (!m) continue;
    // Ventana amplia para que quepa «no le puedo » y similares; lo que la
    // acota de verdad no es la longitud sino la lista cerrada de intercalables.
    const antes = texto.slice(Math.max(0, m.index - 40), m.index);
    if (NEGACION_PREVIA.test(antes)) continue;
    return m[0];
  }
  return undefined;
}

function alguno(texto: string, patrones: readonly RegExp[]): string | undefined {
  for (const re of patrones) {
    const m = re.exec(texto);
    if (m) return m[0];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// CAPA 2 — patrones de salida
// ---------------------------------------------------------------------------

const TRATAMIENTOS =
  '(implante|implantes|ortodoncia|brackets|braquets|endodoncia|tratamiento de conducto|corona|coronas|carilla|carillas|blanqueamiento|limpieza|profilaxis|extraccion|extracciones|protesis|puente|resina|curacion|incrustacion|cirugia|injerto|botox|toxina|acido hialuronico|relleno|rellenos|peeling|laser|lifting|criolipolisis|mesoterapia)';

const DIAGNOSTICOS =
  '(caries|gingivitis|periodontitis|piorrea|infeccion|absceso|flemon|pulpitis|bruxismo|sarro|placa bacteriana|quiste|granuloma|fractura|alergia|hongos|nervio expuesto|nervio muerto|muela del juicio impactada)';

/** Cifra monetaria en cualquiera de las formas en que se escribe en Peru. */
const PATRONES_DE_PRECIO: readonly RegExp[] = [
  /s\/\.?\s?\d/, // S/ 350 · S/. 350 · S/350
  /(?:us\s?)?\$\s?\d/, // $350 · US$ 350
  /\d[\d.,]*\s*(?:soles|sol\b|lucas|dolares|usd)/, // 350 soles · 1,200 soles · 80 lucas
  new RegExp(
    '\\b(?:mil|cien|ciento|doscientos|trescientos|cuatrocientos|quinientos|seiscientos|setecientos|ochocientos|novecientos|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)\\b[a-z\\s]{0,30}\\b(?:soles|lucas)\\b',
  ), // «mil doscientos soles» · «trescientos cincuenta soles»
];

/** La mencion obligatoria: el precio final depende de la valoracion. */
const PATRONES_DE_VALORACION: readonly RegExp[] = [
  /valoracion/,
  /evaluacion (previa|profesional|del doctor|de la doctora)/,
  /previa evaluacion/,
  /(precio|costo|monto) final depende/,
  /depende de (lo que vea|lo que encuentre|la evaluacion|el caso|cada caso)/,
  /(tras|despues de|luego de) (la |una )?(valoracion|evaluacion|revision|consulta)/,
  /(lo|eso) tiene que ver(lo)? el (doctor|especialista|odontologo)/,
  /hay que verlo en consulta/,
];

/** El precio solo se admite como RANGO de referencia, nunca como cifra cerrada. */
const PATRONES_DE_RANGO: readonly RegExp[] = [
  /\bentre\b[^.]{0,60}\by\b/,
  /\bde\b[^.]{0,25}\b(a|hasta)\b[^.]{0,25}\d/,
  /\bdesde\b/,
  /\ba partir de\b/,
  /\baproximadamente\b/,
  /\bmas o menos\b/,
  /\balrededor de\b/,
  /\bvan? desde\b/,
  /\brango\b/,
  /\bvaria\b/,
  /\bbordea\b/,
  /\ben promedio\b/,
];

/** La consulta o valoracion SI tiene precio cerrado: no requiere valoracion previa. */
const RE_CONSULTA = /\b(consulta|valoracion|evaluacion|cita|primera visita|chequeo)\b/;
const RE_TRATAMIENTO = new RegExp(`\\b${TRATAMIENTOS}\\b`);

function frasesConPrecio(texto: string): string[] {
  return texto
    .split(/(?<=[.;!?])\s+|\n+/)
    .filter((frase) => PATRONES_DE_PRECIO.some((re) => re.test(frase)));
}

/** True si TODAS las cifras del texto son el precio de la consulta, no de un tratamiento. */
function elPrecioEsSoloDeLaConsulta(texto: string): boolean {
  const frases = frasesConPrecio(texto);
  if (frases.length === 0) return false;
  return frases.every((f) => RE_CONSULTA.test(f) && !RE_TRATAMIENTO.test(f));
}

const PATRONES_CLINICOS: readonly RegExp[] = [
  // Diagnostico atribuido al paciente.
  new RegExp(`\\b(tienes|tiene|usted tiene|ud tiene|presentas|presenta)\\b[^.]{0,20}\\b${DIAGNOSTICOS}\\b`),
  new RegExp(
    `\\b(es|son|seria|se trata de|parece|suena a|debe ser|puede ser|podria ser|sera|estamos ante)\\b\\s*(un[ao]?s?\\s+)?${DIAGNOSTICOS}\\b`,
  ),
  /\blo que (tienes|tiene|te pasa|le pasa|sientes|siente)\b[^.]{0,15}\b(es|seria|parece|suena)\b/,
  // Interpretacion de sintomas.
  /\b(eso (te |le )?pasa por|eso se debe a|se debe a que|es sintoma de|es senal de|es indicio de|indica que|significa que tienes)\b/,
  // Evaluacion de gravedad, en cualquiera de sus dos direcciones.
  /\bno es (nada |algo )?(grave|serio|de cuidado|preocupante|urgente)\b/,
  /\b(es|parece) (algo )?(leve|pasajero|normal|comun|frecuente)\b/,
  /\bno (te |le )?preocupes?,? (no es nada|no pasa nada)\b/,
  /\bno pasa nada\b/,
  /\bes normal (que|sentir|tener|doler)\b/,
  /\bes (muy )?grave\b/,
  // Recomendacion de tratamiento para un caso concreto.
  new RegExp(
    `\\b(necesitas|necesita|vas a necesitar|va a necesitar|(te|le) (hace falta|conviene|corresponde)|tienes que hacerte|tiene que hacerse|hay que (sacar|extraer|hacer|poner)|(te|le) recomiendo|(te|le) sugiero|lo mejor (en tu caso|en su caso|para ti|para usted) es|deberias hacerte|deberia hacerse|requiere|amerita)\\b[^.]{0,40}\\b${TRATAMIENTOS}\\b`,
  ),
  /\b(hay que|tienes que|tiene que|habria que) (sacar|extraer|matar el nervio|abrir|drenar)\b/,
  /\b(te|le) (recomiendo|sugiero) que (te|se) (saques?|haga|opere|extraiga)\b/,
  // Medicacion y remedios caseros: es acto medico igual.
  /\b(toma|tomate|tome|tomese|puedes tomar|puede tomar|(te|le) recomiendo tomar)\b[^.]{0,30}\b(ibuprofeno|paracetamol|naproxeno|amoxicilina|antibiotico|analgesico|antiinflamatorio|panadol|dolocordralan|apronax)\b/,
  /\b(ibuprofeno|paracetamol|naproxeno|amoxicilina|antibiotico|antiinflamatorio)\b[^.]{0,20}\b(cada|te ayuda|le ayuda|te va a|le va a|para el dolor)\b/,
  /\b(enjuagate|enjuaga|enjuaguese|enjuague|haz buches|buches de|hazte buches|hagase buches|aplicate|aplica|apliquese|ponte|pongase|colocate)\b[^.]{0,25}\b(agua con sal|agua tibia|hielo|frio|calor|manzanilla|clavo de olor)\b/,
];

const PATRONES_DE_SER_HUMANO_AFIRMATIVOS: readonly RegExp[] = [
  /\bsoy (una |un |la |el )?(persona|humano|humana|ser humano|de carne y hueso)\b/,
  /\bsoy (la |una )?(recepcionista|secretaria|asistente de recepcion|senorita|chica|doctora|doctor)\b/,
  /\bsoy \w+,? de (recepcion|la clinica|admision)\b/,
  /\b(habla|hablas|hablando|esta hablando|estas hablando) con una persona\b/,
  /\b(te|le) (habla|atiende) una persona\b/,
  /\bsoy real\b/,
  /\bclaro que soy (una )?persona\b/,
  /\bsi,? soy (una )?persona\b/,
];

/** Negar ser una IA es afirmar ser humano. Aqui la negacion ES la violacion. */
const PATRONES_DE_NEGAR_SER_IA: readonly RegExp[] = [
  /\b(no|tampoco) soy (un |una )?(robot|bot|maquina|ia|inteligencia artificial|programa|computadora|sistema|asistente virtual|chatbot)\b/,
  // La coma es obligatoria: «no, soy una persona» afirma; «no soy una persona» niega.
  /\bno, soy (una )?persona\b/,
];

const PATRONES_DE_CITA_AFIRMADA: readonly RegExp[] = [
  /\b(ya )?(quedo|queda|quedamos|esta|ha quedado)\s+(agendad|reservad|confirmad|separad|registrad|programad)/,
  /\b(ya )?(te|le|se la|se lo) (agende|reserve|separe|registre|confirme|programe|deje)\b/,
  /\bya (agende|reserve|separe|registre|confirme|programe)\b/,
  /\b(su|tu) cita (esta|quedo|ha quedado|es)\b[^.]{0,20}\b(confirmad|agendad|registrad|lista|reservad)/,
  /\bcita (confirmada|agendada|registrada|reservada|separada)\b/,
  /\b(tengo|tenemos) (su|tu) cita\b/,
  /\b(lo|la|le|los|las|te) (espero|esperamos) el\b/,
  /\blisto,? (ya )?(esta|quedo|quedaste)\b/,
  /\bquedo para el\b/,
  /\bagendado para\b/,
];

const PATRONES_DE_PROMESA: readonly RegExp[] = [
  /\bno (te|le) va a doler\b/,
  /\bno (vas|va) a sentir (nada|dolor|molestia)\b/,
  /\bes indoloro\b/,
  /\bsin (nada de )?dolor\b/,
  /\b(te|le) va a quedar (perfecto|perfecta|genial|increible|precioso|preciosa|espectacular|natural|regio)\b/,
  /\bqueda (perfecto|perfecta|como nuevo|como nueva|impecable)\b/,
  /\bgarantiz/,
  /\b(te|le) aseguro\b/,
  /\b100 ?% (seguro|efectivo|garantizado)\b/,
  /\bresultados? garantizados?\b/,
  /\bno hay (ningun )?riesgo\b/,
  /\bes (totalmente|completamente) seguro\b/,
  /\bno hay complicaciones\b/,
  /\ben \d+ (dias|semanas|sesiones)\b[^.]{0,25}\b(vas a estar|va a estar|queda|estaras|estara)\b/,
  /\b(vas|va) a (quedar|salir) (feliz|encantad|content)/,
  /\b(te|le) lo dejo como nuevo\b/,
];

// ---------------------------------------------------------------------------
// CAPA 1 — patrones de entrada
// ---------------------------------------------------------------------------

const PATRONES_DE_INYECCION: readonly RegExp[] = [
  /\bignora\b[^.]{0,30}\b(lo anterior|tus instrucciones|las instrucciones|las reglas|lo que te dijeron)\b/,
  /\bolvida(te)?\b[^.]{0,30}\b(lo anterior|tus instrucciones|tus reglas|las reglas|todo)\b/,
  /\ba partir de ahora (eres|seras|actua|vas a ser)\b/,
  /\b(actua|comportate|responde) como (si fueras |un |una )/,
  /\bhaz de cuenta que eres\b/,
  /\bfinge (ser|que eres)\b/,
  /\bahora eres\b/,
  /\beres (un|una) (dentista|doctor|doctora|medico|odontolog|especialista)/,
  /\bmodo (desarrollador|dios|libre|debug|prueba)\b/,
  /\bsin (filtros|restricciones|limitaciones|reglas)\b/,
  /\b(system|sistema) prompt\b/,
  /\b(muestrame|dime|repite|imprime|escribe)\b[^.]{0,25}\b(tu prompt|tus instrucciones|tus reglas|el prompt)\b/,
  /\bcual(es)? (es|son) tus (instrucciones|reglas)\b/,
  /\b(nuevas?|otras?) (reglas|instrucciones) (son|para ti)\b/,
  /\bdesactiva (tus|las)\b/,
  /\bno eres un (asistente|bot|robot)\b/,
  /\bjailbreak\b/,
];

/** Solo texto: la transcripcion de voz nunca produce etiquetas ni delimitadores. */
const PATRONES_DE_INYECCION_SOLO_TEXTO: readonly RegExp[] = [
  /<\/?(contexto_aprobado|system|instrucciones|prompt)\s*>/,
  /\[\/?inst\]/,
  /```\s*(system|prompt|instrucciones)/,
  /^\s*system\s*:/m,
];

const PATRONES_DE_CONSULTA_CLINICA: readonly RegExp[] = [
  /\bme duele\b/,
  /\btengo (un )?dolor\b/,
  /\bdolor de (muela|diente|encia|cabeza|mandibula|oido)\b/,
  /\bse me (hincho|inflamo|cayo|rompio|movio|partio|salio|infecto)\b/,
  /\b(hinchad|inflamad)[oa]\b/,
  /\bsangr(a|o|e|ando|ado)\b/,
  /\b(pus|absceso|flemon)\b/,
  /\bfiebre\b/,
  /\b(muela|diente) picad[oa]\b/,
  /\bcaries\b/,
  /\bme (arde|late|punza|molesta)\b/,
  /\bsensibilidad\b/,
  /\bsera (caries|infeccion|grave|algo)\b/,
  /\bque (tengo|sera|tendre|puede ser|sera lo que tengo)\b/,
  /\bes normal que\b/,
  /\bes grave\b/,
  /\b(puedo|podria) tomar\b/,
  /\bque (me )?(tomo|receta|recomienda para)\b/,
  /\bmal aliento\b/,
  /\bencias? (sangran|retraidas|hinchadas)\b/,
  /\bse me salio (la|el)\b/,
  /\bmancha[s]? (en|de) (los dientes|la encia)\b/,
];

const PATRONES_DE_DATOS_AJENOS: readonly RegExp[] = [
  /\b(la|el) (cita|historial|tratamiento|ficha) de (mi|el senor|la senora|su|don|dona)\b/,
  /\bdatos de (mi|otro paciente|la senora|el senor|don|dona)\b/,
  /\bque cita tiene\b/,
  /\ba que hora (atendieron|vino|va a venir|atienden) a\b/,
  /\bel historial de\b/,
  /\bdime (los )?datos de\b/,
  /\bcuanto (pago|debe) (mi|el senor|la senora)\b/,
];

// ---------------------------------------------------------------------------
// CAPA 1 — API
// ---------------------------------------------------------------------------

export function detectInboundFlags(text: string, channel: Channel): InboundFlag[] {
  const t = normalizar(text);
  const flags: InboundFlag[] = [];

  const patronesInyeccion =
    channel === 'whatsapp'
      ? [...PATRONES_DE_INYECCION, ...PATRONES_DE_INYECCION_SOLO_TEXTO]
      : PATRONES_DE_INYECCION;

  if (alguno(t, patronesInyeccion) !== undefined) flags.push('intento_inyeccion');
  if (alguno(t, PATRONES_DE_CONSULTA_CLINICA) !== undefined) flags.push('consulta_clinica');
  if (alguno(t, PATRONES_DE_DATOS_AJENOS) !== undefined) {
    flags.push('solicitud_datos_de_otro_paciente');
  }
  return flags;
}

/**
 * CAPA 1. NO es bloqueante: `pass: false` significa «esto viene marcado»,
 * no «no lo atiendas». El turno continua; lo que cambia es que el orquestador
 * sabe que tiene delante una consulta clinica o un intento de inyeccion.
 */
export function checkInbound(text: string, channel: Channel): GuardrailResult {
  const flags = detectInboundFlags(text, channel);
  if (flags.length === 0) return { pass: true };
  return {
    pass: false,
    reason: flags.join(','),
    replacement: flags.includes('consulta_clinica') ? RESPUESTA_ANTE_CONSULTA_CLINICA : undefined,
  };
}

// ---------------------------------------------------------------------------
// CAPA 2 — API
// ---------------------------------------------------------------------------

/**
 * Lo que la capa 2 no puede deducir del texto: si la herramienta se ejecuto.
 *
 * Lo sabe el orquestador del turno, no el guardrail. Si no se pasa, el valor
 * por defecto es `false`: sin prueba de que la cita se creo, afirmar que se
 * creo se bloquea. Fallar cerrado es el unico default aceptable aqui.
 */
export interface OutboundEvidence {
  /** True SOLO si `crear_cita` devolvio `status: 'ok'` en este turno. */
  citaCreada: boolean;
}

/**
 * Ultimo recurso cuando el orquestador no pasa evidencia: rastrea el historial
 * en busca de un resultado de `crear_cita` correcto. Es una heuristica sobre
 * texto persistido, no una fuente de verdad; por eso no releva al llamador de
 * pasar `evidence`.
 */
function evidenciaDelHistorial(ctx: TurnContext): OutboundEvidence {
  const citaCreada = ctx.history.some(
    (m) =>
      m.rol === 'tool' &&
      m.contenido.includes('crear_cita') &&
      /"?(status|estado)"?\s*[:=]\s*"?ok"?/i.test(m.contenido),
  );
  return { citaCreada };
}

export function detectOutboundViolations(
  text: string,
  ctx: TurnContext,
  evidence?: OutboundEvidence,
): OutboundViolation[] {
  const t = normalizar(text);
  const pruebas = evidence ?? evidenciaDelHistorial(ctx);
  const violaciones: OutboundViolation[] = [];

  // 1. Precio. Solo se admite RANGO de referencia + mencion de valoracion.
  if (PATRONES_DE_PRECIO.some((re) => re.test(t))) {
    const mencionaValoracion = PATRONES_DE_VALORACION.some((re) => re.test(t));
    const esRango = PATRONES_DE_RANGO.some((re) => re.test(t));
    if (!elPrecioEsSoloDeLaConsulta(t) && (!mencionaValoracion || !esRango)) {
      violaciones.push('precio_cerrado_sin_valoracion');
    }
  }

  // 2. Afirmacion clinica o diagnostico.
  if (alguno(t, PATRONES_CLINICOS) !== undefined) violaciones.push('afirmacion_clinica');

  // 3. Afirmar ser humano, en directo o negando ser una IA.
  if (
    primerMatchAfirmativo(t, PATRONES_DE_SER_HUMANO_AFIRMATIVOS) !== undefined ||
    alguno(t, PATRONES_DE_NEGAR_SER_IA) !== undefined
  ) {
    violaciones.push('afirmacion_de_ser_humano');
  }

  // 4. Cita dada por hecha sin herramienta ejecutada con exito.
  if (!pruebas.citaCreada && primerMatchAfirmativo(t, PATRONES_DE_CITA_AFIRMADA) !== undefined) {
    violaciones.push('cita_afirmada_sin_tool_call');
  }

  // 5. Promesa de resultado.
  if (primerMatchAfirmativo(t, PATRONES_DE_PROMESA) !== undefined) {
    violaciones.push('promesa_de_resultado');
  }

  return violaciones;
}

/** La violacion que decide el texto sustituto cuando hay mas de una. */
export function violacionDominante(violaciones: readonly OutboundViolation[]): OutboundViolation {
  for (const candidata of PRIORIDAD_DE_VIOLACIONES) {
    if (violaciones.includes(candidata)) return candidata;
  }
  return violaciones[0] as OutboundViolation;
}

/**
 * CAPA 2. BLOQUEANTE.
 *
 * `pass: false` significa que ese texto NO se envia ni se sintetiza: se emite
 * `replacement` en su lugar y se registra el incidente.
 */
export function checkOutbound(
  text: string,
  ctx: TurnContext,
  evidence?: OutboundEvidence,
  respuestas: Record<OutboundViolation, string> = RESPUESTAS_CANONICAS,
): GuardrailResult {
  const violaciones = detectOutboundViolations(text, ctx, evidence);
  if (violaciones.length === 0) return { pass: true };
  const dominante = violacionDominante(violaciones);
  return {
    pass: false,
    reason: violaciones.join(','),
    replacement: respuestas[dominante],
  };
}

// ---------------------------------------------------------------------------
// Servicio: las mismas capas, con registro de incidente
// ---------------------------------------------------------------------------

export interface GuardrailDeps {
  logger: Logger;
  /** Opcional: si no hay repositorio de auditoria, el incidente solo se loguea. */
  audit?: AuditRepository;
  /** Permite a una clinica ajustar el tono sin tocar el codigo. */
  respuestas?: Partial<Record<OutboundViolation, string>>;
}

/**
 * Envoltorio con efectos. Las funciones puras de arriba siguen siendo la
 * implementacion; esta clase solo anade el registro del incidente.
 *
 * NO registra el texto: un texto de salida bloqueado puede contener PII del
 * paciente y el enmascarador vive en `infra/`, que el nucleo no puede
 * importar. Se registran las categorias y el tamano, que es lo que sirve para
 * auditar sin exponer a nadie (control C6).
 */
export class GuardrailService {
  private readonly respuestas: Record<OutboundViolation, string>;

  constructor(private readonly deps: GuardrailDeps) {
    this.respuestas = { ...RESPUESTAS_CANONICAS, ...(deps.respuestas ?? {}) };
  }

  checkInbound(text: string, channel: Channel, ctx?: TurnContext): GuardrailResult {
    const resultado = checkInbound(text, channel);
    if (!resultado.pass) {
      this.deps.logger.warn(
        {
          capa: 1,
          flags: resultado.reason,
          canal: channel,
          conversationId: ctx?.conversationId,
        },
        'guardrail de entrada: mensaje marcado',
      );
      void this.registrar('guardrail_inbound', { flags: resultado.reason, canal: channel }, ctx);
    }
    return resultado;
  }

  checkOutbound(text: string, ctx: TurnContext, evidence?: OutboundEvidence): GuardrailResult {
    const resultado = checkOutbound(text, ctx, evidence, this.respuestas);
    if (!resultado.pass) {
      this.deps.logger.error(
        {
          capa: 2,
          violaciones: resultado.reason,
          canal: ctx.channel,
          conversationId: ctx.conversationId,
          longitudBloqueada: text.length,
        },
        'guardrail de salida: respuesta BLOQUEADA y sustituida',
      );
      void this.registrar(
        'guardrail_outbound_bloqueado',
        { violaciones: resultado.reason, canal: ctx.channel, longitudBloqueada: text.length },
        ctx,
      );
    }
    return resultado;
  }

  /** El fallo de auditoria no puede tumbar el turno: se loguea y se sigue. */
  private async registrar(
    evento: string,
    detalle: Record<string, unknown>,
    ctx?: TurnContext,
  ): Promise<void> {
    if (!this.deps.audit) return;
    try {
      await this.deps.audit.log(evento, detalle, ctx?.clinic.id, ctx?.conversationId);
    } catch (error) {
      this.deps.logger.error(
        { evento, error: error instanceof Error ? error.message : String(error) },
        'no se pudo registrar el incidente de guardrail',
      );
    }
  }
}
