/**
 * Ensamblador del prompt maestro.
 *
 * El prompt NO esta en el codigo: vive en `prompts/` (semilla de la BD). Aqui
 * solo se parte en bloques, se sustituyen las variables y se concatena el
 * bloque de estilo del canal.
 *
 * Estructura (especificacion §6):
 *   [BLOQUES 1-7] invariables, identicos en ambos canales
 *   [BLOQUE 8]    <contexto_aprobado> con los fragmentos RAG
 *   [BLOQUE 9]    variables de sesion
 *   [BLOQUE 10]   bloque de estilo del canal  <- UNICA diferencia entre canales
 *
 * `build()` devuelve tambien los segmentos por separado. No es decoracion: es
 * lo que permite verificar en un test que entre `whatsapp` y `voice` no cambia
 * nada mas que el estilo (criterio de aceptacion de la Fase 1).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Channel, KnowledgeChunk, TurnContext } from '../types/index.js';
import { cierresProximos, formatearMinutos, resolverAgenda } from '../agenda/horario.js';

/** Numero de bloques `## ` que debe tener `maestro.md`. Si cambia, el split falla. */
export const TOTAL_DE_BLOQUES = 10;
/** Ultimo bloque invariable. Los bloques 8, 9 y 10 se rellenan por turno. */
export const ULTIMO_BLOQUE_INVARIABLE = 7;

export const ARCHIVOS_DE_PROMPT = {
  maestro: 'maestro.md',
  estiloVoz: 'estilo.voz.md',
  estiloTexto: 'estilo.texto.md',
  urgencia: 'urgencia.clasificador.md',
} as const;

export interface PromptTemplates {
  /** Contenido literal de `prompts/maestro.md`. */
  maestro: string;
  /** Bloque de estilo por canal. Es lo unico que difiere entre canales. */
  estiloPorCanal: Record<Channel, string>;
  /** Prompt del clasificador de urgencia (lo consume `urgency.detector.ts`). */
  urgencia: string;
}

/** Segmentos del prompt ya renderizado, para verificacion y para auditoria. */
export interface PromptSegments {
  /** Bloques 1-7. Debe ser identico byte a byte entre canales. */
  invariable: string;
  /** Bloque 8. */
  contexto: string;
  /** Bloque 9. */
  sesion: string;
  /** Bloque 10. */
  estilo: string;
}

export interface BuiltPrompt {
  /** El `system` que se le pasa al modelo. */
  system: string;
  segments: PromptSegments;
}

export interface BuildPromptInput {
  ctx: TurnContext;
  /** Fragmentos ya recuperados y APROBADOS. Vacio es un caso valido. */
  fragmentos?: KnowledgeChunk[];
  /** Sede concreta. Si no viene se busca en `clinic.config.sede`. */
  sede?: string;
}

export class PromptTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptTemplateError';
  }
}

/**
 * Lee las plantillas del disco. Se ejecuta una vez al arrancar: el prompt es
 * fijo durante la vida del proceso, no se relee por turno.
 */
export async function loadPromptTemplates(promptsDir: string): Promise<PromptTemplates> {
  const leer = (archivo: string) => readFile(path.join(promptsDir, archivo), 'utf8');
  const [maestro, voz, texto, urgencia] = await Promise.all([
    leer(ARCHIVOS_DE_PROMPT.maestro),
    leer(ARCHIVOS_DE_PROMPT.estiloVoz),
    leer(ARCHIVOS_DE_PROMPT.estiloTexto),
    leer(ARCHIVOS_DE_PROMPT.urgencia),
  ]);
  return {
    maestro,
    estiloPorCanal: { voice: voz.trim(), whatsapp: texto.trim() },
    urgencia: urgencia.trim(),
  };
}

/** Parte el maestro por encabezados `## `. Devuelve los 10 bloques en orden. */
function partirEnBloques(maestro: string): string[] {
  const lineas = maestro.split(/\r?\n/);
  const bloques: string[] = [];
  let actual: string[] | undefined;
  for (const linea of lineas) {
    if (linea.startsWith('## ')) {
      if (actual) bloques.push(actual.join('\n').trimEnd());
      actual = [linea];
    } else if (actual) {
      actual.push(linea);
    }
    // Lo que aparece antes del primer `## ` se descarta a proposito: el prompt
    // empieza en el bloque 1 y no admite preambulo.
  }
  if (actual) bloques.push(actual.join('\n').trimEnd());

  if (bloques.length !== TOTAL_DE_BLOQUES) {
    throw new PromptTemplateError(
      `maestro.md debe tener exactamente ${TOTAL_DE_BLOQUES} bloques "## "; se encontraron ${bloques.length}. ` +
        'Anadir o quitar un bloque obliga a revisar prompt.builder.ts y sus tests.',
    );
  }
  return bloques;
}

function sustituir(texto: string, valores: Record<string, string>): string {
  return texto.replace(/\{\{(\w+)\}\}/g, (_, clave: string) => {
    const valor = valores[clave];
    if (valor === undefined) {
      throw new PromptTemplateError(`marcador {{${clave}}} sin valor en el ensamblado del prompt`);
    }
    return valor;
  });
}

/**
 * Fecha y hora en la zona de la clinica, MAS el calendario de los proximos
 * siete dias ya resuelto.
 *
 * El dia de la semana solo no basta. Medido con haiku-4.5: un martes 4 de
 * agosto, ante "el jueves mas proximo", el modelo consulto la agenda del 7 --
 * que era viernes-- y se lo ofrecio al paciente como jueves. "Citas creadas
 * con fecha, hora o profesional incorrectos = 0" es criterio BLOQUEANTE de la
 * Tabla 14, asi que la aritmetica de fechas no puede quedar en manos del
 * modelo: se le da hecha.
 *
 * Cuesta unas pocas decenas de tokens y elimina toda una clase de error.
 *
 * Se exporta porque el modo ALOJADO la necesita igual. Alli no la tenia, y el
 * agente hablado corria las fechas un dia entero: un martes 4 de agosto decia
 * que "manana" era el 6 y que el viernes era el 8. No es que calculara mal:
 * es que NO SABIA en que dia vivia y lo deducia de su entrenamiento.
 */
export function formatearFechaHora(fecha: Date, timezone: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('es-PE', {
      timeZone: timezone,
      dateStyle: 'full',
      timeStyle: 'short',
    });

    const dia = new Intl.DateTimeFormat('es-PE', {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'numeric',
    });

    const proximos: string[] = [];
    for (let i = 1; i <= 7; i += 1) {
      proximos.push(dia.format(new Date(fecha.getTime() + i * 86_400_000)));
    }

    // «Manana» y «pasado manana» se dicen APARTE, no solo dentro de la lista.
    // Medido: con la lista sola, el modelo seguia resolviendo «manana» al dia
    // equivocado --decia que manana era jueves siendo martes--. Indexar en una
    // lista es una operacion que se le puede dar hecha, y sale gratis.
    const manana = proximos[0] ?? '';
    const pasado = proximos[1] ?? '';
    return (
      `HOY es ${fmt.format(fecha)} (${timezone}).\n` +
      `MANANA es ${manana}. PASADO MANANA es ${pasado}.\n` +
      `Resto de dias, ya calculados -- usa ESTOS, no los deduzcas: ${proximos.join(' · ')}.`
    );
  } catch {
    // Una zona invalida no puede tumbar el turno: se degrada a ISO y se sigue.
    return `${fecha.toISOString()} (UTC; zona "${timezone}" invalida)`;
  }
}

/**
 * Los fragmentos entran como DATOS delimitados. Se les quita cualquier cierre
 * de etiqueta que pudiera romper el delimitador: es la defensa minima frente a
 * la inyeccion indirecta a traves de la base de conocimiento (control C9).
 */
function renderizarFragmentos(fragmentos: KnowledgeChunk[]): string {
  if (fragmentos.length === 0) {
    return '(no hay informacion aprobada para esta consulta)';
  }
  return fragmentos
    .map((f, i) => {
      const limpio = f.contenido.replace(/<\/?contexto_aprobado>/gi, '');
      return `[${i + 1}] (fuente: ${f.fuente})\n${limpio.trim()}`;
    })
    .join('\n\n');
}

function notasDeSesion(ctx: TurnContext): string {
  const notas: string[] = [];
  if (ctx.channelSwitched) {
    notas.push(
      'Nota: la conversacion venia por otro canal. Anuncia el cambio de canal ' +
        'explicitamente antes de continuar, para que el paciente sepa que sus ' +
        'datos no circulan sin su conocimiento.',
    );
  }
  if (ctx.comprehensionFailures >= 2) {
    notas.push(
      `Nota: llevas ${ctx.comprehensionFailures} fallos de comprension consecutivos. ` +
        'Aplica AHORA el criterio 4 de escalamiento: ofrece continuar por WhatsApp ' +
        'o hablar con una persona, sin esperar a que el paciente lo pida.',
    );
  } else if (ctx.comprehensionFailures === 1) {
    notas.push(
      'Nota: llevas 1 fallo de comprension. Al siguiente aplicas el criterio 4 de escalamiento.',
    );
  }
  return notas.length > 0 ? notas.join('\n') : 'Sin notas.';
}

function sedeDe(ctx: TurnContext, explicita?: string): string {
  if (explicita && explicita.trim() !== '') return explicita.trim();
  /**
   * Solo `sede` --que declara una clinica de sede UNICA--. `sede_por_defecto`
   * NO cuenta, aunque exista en la configuracion.
   *
   * Se probo al reves y se vio el efecto: con `sede_por_defecto: miraflores`
   * el bloque de sesion decia «Sede de esta conversacion: miraflores» y el
   * modelo lo trataba como decidido —«para el viernes en Miraflores tengo
   * estos horarios»— sin que el paciente hubiera elegido nada. Es el mismo
   * error que el viejo `'sede unica'`: presentar un valor por defecto de la
   * configuracion como un hecho de la conversacion.
   *
   * `sede_por_defecto` sigue siendo util donde le corresponde --el calendario
   * contra el que se agenda--, pero no es la sede que el paciente pidio.
   */
  const enConfig = ctx.clinic.config['sede'];
  if (typeof enConfig === 'string' && enConfig.trim() !== '') return enConfig.trim();
  /**
   * NO se devuelve "sede unica".
   *
   * Ese era el valor por defecto y era una AFIRMACION FALSA sobre la clinica
   * que entraba al prompt como dato de sesion. La semilla no tiene la clave
   * `sede` --tiene `sedes_informativas`--, asi que el defecto se aplicaba
   * SIEMPRE, y el modelo lo repetia: ante "vivo por Magdalena" contesto
   * "trabajamos con sede unica" teniendo la clinica 24. Era la linea roja
   * "nunca inventar datos ausentes de la base", y no la cruzaba el modelo:
   * se la dabamos escrita nosotros.
   *
   * Desconocer la sede de la conversacion es un hecho corriente; afirmar que
   * solo hay una es un dato inventado. Se dice lo primero.
   */
  return 'TODAVIA NO ELEGIDA — preguntale al paciente en cual quiere atenderse antes de agendar';
}

/**
 * TODAS las sedes de la clinica, tomadas de `clinic.config`.
 *
 * Van en el bloque de SESION y no en el CONTEXTO APROBADO a proposito. El
 * contexto lo llena el RAG, y el RAG puede fallar: basta con que la busqueda
 * recupere el fragmento de franquicias y no el de sedes propias para que el
 * modelo conteste 8 sedes de 24 --medido, es como se detecto esto--. Un dato
 * censal, cerrado y que cabe en unas lineas no debe depender de que una
 * busqueda semantica acierte; se le da hecho, igual que la aritmetica de
 * fechas de `formatearFechaHora`.
 *
 * El coste es real y esta aceptado: el bloque 9 NO se cachea (solo los bloques
 * 1-7 lo son), asi que esto son unos cientos de tokens en cada iteracion del
 * bucle de herramientas. Se paga a cambio de cerrar una clase entera de
 * invencion sobre la que no hay control automatico en capa 2.
 *
 * Se exporta porque el modo ALOJADO (`scripts/configurar-agente-alojado.ts`)
 * arma su propio prompt descartando los bloques 8 y 9, y necesita el mismo
 * texto. Con dos implementaciones, el defecto se arreglaria en texto y seguiria
 * vivo en voz.
 */
/**
 * Horario de la semana y dias en que la clinica NO atiende.
 *
 * Va en el bloque de sesion por la misma razon que las sedes: es un dato
 * cerrado y no puede depender de que una busqueda semantica acierte. Pero hay
 * un motivo mas, propio de esto: sin la lista por delante, el unico control
 * posible es RECHAZAR la cita cuando el paciente ya propuso la fecha, y la
 * conversacion se vuelve un tira y afloja --propone el jueves, se le dice que
 * no, propone otra cosa--. Con la lista, el agente lo dice antes.
 *
 * Medido: el 6 de agosto es feriado por la Batalla de Junin y ninguna sede
 * atiende; el agente agendaba ese dia sin inmutarse porque no existia el
 * concepto de feriado en ninguna capa.
 */
function renderizarCierres(ctx: TurnContext): string {
  const agenda = resolverAgenda(ctx.clinic);
  const lineas: string[] = [];

  const NOMBRES = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  const semana: string[] = [];
  for (let dia = 1; dia <= 6; dia += 1) {
    const tramos = agenda.porDia.get(dia) ?? [];
    semana.push(
      tramos.length === 0
        ? `${NOMBRES[dia]}: cerrado`
        : `${NOMBRES[dia]}: ${tramos.map((t) => `${formatearMinutos(t.desde)}-${formatearMinutos(t.hasta)}`).join(' y ')}`,
    );
  }
  const domingo = agenda.porDia.get(0) ?? [];
  semana.push(domingo.length === 0 ? 'domingo: cerrado' : `domingo: ${domingo.length} tramo(s)`);
  lineas.push(`HORARIO SEMANAL: ${semana.join(' · ')}.`);
  lineas.push(
    'Fuera de esos tramos NO hay atencion, tampoco en la pausa de mediodia. No ofrezcas un horario que no quepa entero dentro de un tramo.',
  );

  const cierres = cierresProximos(ctx.now, 45, agenda);
  if (cierres.length > 0) {
    lineas.push(
      `DIAS CERRADOS proximos (ninguna sede atiende): ${cierres
        .map((c) => `${c.iso} (${c.motivo})`)
        .join(', ')}.`,
    );
    lineas.push(
      'Si el paciente propone uno de esos dias, DILO antes de consultar la agenda y ofrece el dia habil mas cercano.',
    );
  }

  return lineas.join('\n');
}

/**
 * Profesionales por sede, para poder OFRECERLOS.
 *
 * Nace de un fallo con dos mitades. La tecnica: el campo `profesional` era
 * opcional pero rechazaba la cadena vacia, y el agente de voz manda todos los
 * campos rellenando con `""`, asi que no se podia agendar nunca (ver
 * `textoOpcional`). La conversacional: el agente le pedia al paciente el nombre
 * de un doctor sin darle ninguna lista, y el paciente no tiene por que
 * saberselo.
 *
 * Elegir profesional es OPCIONAL y debe seguir siendolo: se ofrece, no se
 * exige. Por eso el texto insiste tanto en ello -- un campo opcional que en la
 * practica bloquea es peor que no tenerlo.
 */
export function renderizarProfesionales(config: Record<string, unknown>): string {
  const crudo = config['profesionales_por_sede'];
  if (crudo === null || typeof crudo !== 'object') {
    return 'PROFESIONALES: no hay lista por sede. No le pidas al paciente el nombre de un doctor: agenda sin profesional y recepcion asigna.';
  }

  const lineas: string[] = [];
  for (const [sede, lista] of Object.entries(crudo as Record<string, unknown>)) {
    if (!Array.isArray(lista) || lista.length === 0) continue;
    const nombres = lista
      .map((p) => {
        if (p === null || typeof p !== 'object') return undefined;
        const { nombre, especialidad } = p as { nombre?: unknown; especialidad?: unknown };
        if (typeof nombre !== 'string' || nombre.trim() === '') return undefined;
        return typeof especialidad === 'string' && especialidad.trim() !== ''
          ? `${nombre} (${especialidad})`
          : nombre;
      })
      .filter((n): n is string => n !== undefined);
    if (nombres.length > 0) {
      lineas.push(`  ${sede.replace(/-/g, ' ')}: ${nombres.join(' · ')}`);
    }
  }

  if (lineas.length === 0) {
    return 'PROFESIONALES: no hay lista por sede. No le pidas al paciente el nombre de un doctor: agenda sin profesional y recepcion asigna.';
  }

  return (
    'PROFESIONALES POR SEDE:\n' +
    `${lineas.join('\n')}\n` +
    'Elegir profesional es OPCIONAL y NUNCA es requisito para agendar. Si el paciente ' +
    'pregunta por quien atiende, o duda, LEELE los de esa sede y deja que elija. Si no ' +
    'lo menciona, NO se lo preguntes: agenda sin profesional y dile que recepcion le ' +
    'asigna al que corresponda. Jamas le pidas que adivine un nombre, ni bloquees la ' +
    'cita por no tenerlo. En las sedes que no aparecen aqui, no inventes nombres: di ' +
    'que recepcion le confirma quien le atendera.'
  );
}

export function renderizarSedes(config: Record<string, unknown>): string {
  const grupos: Array<[string, unknown]> = [
    ['propias', config['sedes_informativas']],
    ['franquicias', config['sedes_franquicia']],
  ];

  const lineas: string[] = [];
  let total = 0;

  for (const [etiqueta, crudo] of grupos) {
    if (crudo === null || typeof crudo !== 'object') continue;
    const entradas = Object.entries(crudo as Record<string, unknown>).filter(
      ([, direccion]) => typeof direccion === 'string' && direccion.trim() !== '',
    );
    if (entradas.length === 0) continue;

    total += entradas.length;
    lineas.push(`${etiqueta.toUpperCase()} (${entradas.length}):`);
    for (const [nombre, direccion] of entradas) {
      // La clave viene en kebab-case porque es un identificador; al modelo se
      // le da legible, que es como la va a decir el paciente.
      const legible = nombre.replace(/-/g, ' ');
      lineas.push(`  - ${legible}: ${String(direccion).trim()}`);
    }
  }

  if (total === 0) {
    // Sin lista no se afirma cuantas hay. Ausencia declarada, no rellenada.
    return 'Sedes: no figuran en la configuracion de la clinica. Si te preguntan, dilo y ofrece confirmarlo con recepcion. NO supongas el numero de sedes ni digas que hay una sola.';
  }

  return (
    `SEDES DE LA CLINICA — lista COMPLETA y AUTORITATIVA (${total} en total).\n` +
    `${lineas.join('\n')}\n` +
    'Esta lista manda sobre el CONTEXTO APROBADO: si un fragmento recuperado menciona ' +
    'menos sedes, es que solo recupero una parte, no que las demas no existan. Al ' +
    'preguntar por sedes responde desde AQUI. Nunca digas que hay una sola sede.'
  );
}

export class PromptBuilder {
  private readonly bloques: string[];

  constructor(private readonly templates: PromptTemplates) {
    this.bloques = partirEnBloques(templates.maestro);
    for (const canal of ['whatsapp', 'voice'] as const) {
      if (!templates.estiloPorCanal[canal] || templates.estiloPorCanal[canal].trim() === '') {
        throw new PromptTemplateError(`falta el bloque de estilo del canal "${canal}"`);
      }
    }
  }

  /** Prompt del clasificador de urgencia. Vive en archivo, igual que el maestro. */
  get promptDeUrgencia(): string {
    return this.templates.urgencia;
  }

  build(input: BuildPromptInput): BuiltPrompt {
    const { ctx } = input;
    const fragmentos = input.fragmentos ?? [];

    const valores: Record<string, string> = {
      clinica_nombre: ctx.clinic.nombre,
      fragmentos_rag: renderizarFragmentos(fragmentos),
      canal: ctx.channel,
      fecha_hora: formatearFechaHora(ctx.now, ctx.clinic.timezone),
      sede: sedeDe(ctx, input.sede),
      sedes_de_la_clinica: renderizarSedes(ctx.clinic.config),
      profesionales: renderizarProfesionales(ctx.clinic.config),
      dias_cerrados: renderizarCierres(ctx),
      paciente_nombre_si_conocido: ctx.patient.nombre?.trim() || 'no identificado',
      notas_de_sesion: notasDeSesion(ctx),
      bloque_estilo_segun_canal: this.templates.estiloPorCanal[ctx.channel],
    };

    const renderizados = this.bloques.map((b) => sustituir(b, valores));

    const segments: PromptSegments = {
      invariable: renderizados.slice(0, ULTIMO_BLOQUE_INVARIABLE).join('\n\n'),
      contexto: renderizados[ULTIMO_BLOQUE_INVARIABLE] as string,
      sesion: renderizados[ULTIMO_BLOQUE_INVARIABLE + 1] as string,
      estilo: renderizados[ULTIMO_BLOQUE_INVARIABLE + 2] as string,
    };

    const system = [segments.invariable, segments.contexto, segments.sesion, segments.estilo].join(
      '\n\n',
    );

    return { system, segments };
  }
}
