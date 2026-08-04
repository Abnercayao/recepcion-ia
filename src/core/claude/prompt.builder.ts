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
 */
function formatearFechaHora(fecha: Date, timezone: string): string {
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

    return (
      `${fmt.format(fecha)} (${timezone})\n` +
      `Proximos dias, ya calculados -- usa ESTOS, no los deduzcas: ${proximos.join(' · ')}.`
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
  const enConfig = ctx.clinic.config['sede'];
  if (typeof enConfig === 'string' && enConfig.trim() !== '') return enConfig.trim();
  return 'sede unica';
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
