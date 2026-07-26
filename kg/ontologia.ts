/**
 * ONTOLOGIA del grafo de conocimiento de Recepcion-IA.
 *
 * Define QUE tipos de cosa existen en este proyecto y COMO se relacionan. El
 * extractor (`extraer.ts`) solo sabe leer archivos; es aqui donde se declara
 * el vocabulario con el que se describe el sistema.
 *
 * Regla de oro: en este archivo solo viven (a) los tipos y (b) los hechos
 * curados que NO se pueden derivar mecanicamente del codigo — lineas rojas,
 * fases, capas arquitectonicas. Todo lo demas se extrae. Si un hecho curado
 * deja de corresponderse con el codigo, `verificar.ts` lo detecta: cada
 * constante de aqui tiene un ancla comprobable en las fuentes.
 */

// ---------------------------------------------------------------------------
// Vocabulario
// ---------------------------------------------------------------------------

export const TIPOS_NODO = [
  'capa', // estrato arquitectonico: nucleo, canales, infraestructura...
  'modulo', // un archivo de codigo fuente
  'simbolo', // algo exportado por un modulo: clase, interfaz, funcion, constante
  'puerto', // interfaz de frontera declarada en core/types/ports.ts
  'herramienta', // una de las herramientas de negocio del modelo
  'control', // control del informe etico (C1..Cn) u operativo (O1..On)
  'categoria_adversarial', // categoria de la bateria adversarial (C1..C13)
  'linea_roja', // prohibicion absoluta del sistema
  'canal', // whatsapp | voz
  'tabla', // tabla de la base de datos
  'politica_rls', // politica row-level security
  'documento', // archivo de docs/
  'prompt', // archivo de prompts/
  'flujo', // flujo de n8n
  'prueba', // archivo de tests/
  'variable_entorno', // variable leida por infra/config.ts
  'fase', // fase del plan de construccion
] as const;
export type TipoNodo = (typeof TIPOS_NODO)[number];

export const RELACIONES = [
  'pertenece_a', // modulo -> capa
  'importa', // modulo -> modulo
  'exporta', // modulo -> simbolo
  'implementa', // simbolo -> puerto
  'declara_puerto', // modulo -> puerto
  'inyecta', // simbolo -> simbolo (composicion en server.ts)
  'registra', // registro -> herramienta
  'menciona', // cualquiera -> control
  'aplica', // modulo -> linea_roja
  'verifica', // prueba -> modulo | control | linea_roja
  'cubre_categoria', // prueba -> categoria_adversarial
  'usa_tabla', // modulo -> tabla
  'protege', // politica_rls -> tabla
  'lee_variable', // modulo -> variable_entorno
  'sirve_canal', // modulo -> canal
  'documenta', // documento -> cualquiera
  'cubre_fase', // documento | prueba -> fase
] as const;
export type Relacion = (typeof RELACIONES)[number];

// ---------------------------------------------------------------------------
// Forma del grafo
// ---------------------------------------------------------------------------

export interface Nodo {
  /** `tipo:identificador`. Estable entre extracciones: es la clave del grafo. */
  id: string;
  tipo: TipoNodo;
  nombre: string;
  /** Ruta relativa a la raiz del repo, cuando el nodo corresponde a un archivo. */
  ruta?: string;
  /** Linea donde se declara, cuando aplica. Permite abrir el sitio exacto. */
  linea?: number;
  /** Frase corta tomada del propio codigo o curada aqui. */
  resumen?: string;
  /** Datos propios del tipo de nodo (clase de simbolo, capa del modulo, etc.). */
  meta?: Record<string, string | number | boolean | string[]>;
}

export interface Arista {
  desde: string;
  hacia: string;
  relacion: Relacion;
  /** De donde se dedujo la arista: `ruta:linea`. Hace auditable la extraccion. */
  origen?: string;
}

export interface Grafo {
  version: number;
  /** sha256 de las fuentes. Cambia si y solo si cambia lo extraido. */
  huella: string;
  generadoPor: string;
  nodos: Nodo[];
  aristas: Arista[];
}

export const VERSION_GRAFO = 1;

// ---------------------------------------------------------------------------
// Hechos curados
// ---------------------------------------------------------------------------

export interface DefinicionCapa {
  id: string;
  nombre: string;
  /** Prefijos de ruta que pertenecen a esta capa. El primero que casa, gana. */
  prefijos: string[];
  regla: string;
}

/**
 * El orden importa: `clasificarCapa` devuelve la primera que casa, y
 * `src/core/types` debe resolverse antes que `src/core`.
 */
export const CAPAS: DefinicionCapa[] = [
  {
    id: 'contratos',
    nombre: 'Contratos',
    prefijos: ['src/core/types/'],
    regla: 'Los puertos y tipos compartidos. No depende de nada del proyecto.',
  },
  {
    id: 'nucleo',
    nombre: 'Nucleo',
    prefijos: ['src/core/'],
    regla: 'Nunca importa de channels/ ni de infra/. Solo de los puertos.',
  },
  {
    id: 'canales',
    nombre: 'Canales',
    prefijos: ['src/channels/'],
    regla: 'Traducen, no deciden. Importan de core/, nunca al reves.',
  },
  {
    id: 'infraestructura',
    nombre: 'Infraestructura',
    prefijos: ['src/infra/'],
    regla: 'Implementaciones concretas de los puertos. Sustituibles.',
  },
  {
    id: 'composicion',
    nombre: 'Raiz de composicion',
    prefijos: ['src/server.ts'],
    regla: 'El unico sitio donde el nucleo se encuentra con lo concreto.',
  },
  {
    id: 'datos',
    nombre: 'Datos',
    prefijos: ['db/'],
    regla: 'Migraciones numeradas con RLS y semilla de la clinica de demostracion.',
  },
  {
    id: 'scripts',
    nombre: 'Scripts',
    prefijos: ['scripts/'],
    regla: 'Operacion: migrar, sembrar, demostrar, medir WER.',
  },
  {
    id: 'pruebas',
    nombre: 'Pruebas',
    prefijos: ['tests/'],
    regla: 'unit, integration y adversarial. La adversarial corre en dos modos.',
  },
  {
    id: 'prompts',
    nombre: 'Prompts',
    prefijos: ['prompts/'],
    regla: 'El prompt maestro y los bloques de estilo, en archivos, no en codigo.',
  },
  {
    id: 'documentacion',
    nombre: 'Documentacion',
    prefijos: ['docs/'],
    regla: 'Decisiones, contratos verificados y estado real del proyecto.',
  },
  {
    id: 'flujos',
    nombre: 'Flujos n8n',
    prefijos: ['n8n/'],
    regla: 'Automatizaciones externas: recordatorios, escalamiento, reportes.',
  },
  {
    id: 'grafo',
    nombre: 'Grafo de conocimiento',
    prefijos: ['kg/'],
    regla: 'Utillaje de desarrollo. No forma parte del sistema en produccion.',
  },
];

export function clasificarCapa(ruta: string): DefinicionCapa | undefined {
  return CAPAS.find((capa) => capa.prefijos.some((prefijo) => ruta.startsWith(prefijo)));
}

/**
 * Las lineas rojas del sistema (README, y bloque PROHIBICIONES ABSOLUTAS del
 * prompt maestro).
 *
 * `violacion` es el ancla comprobable: el identificador con el que la capa 2
 * detecta la infraccion en `core/types/guardrail.ts`. Una linea roja sin
 * violacion asociada esta escrita en el prompt pero NO tiene control detras —
 * y eso es exactamente lo que el grafo debe hacer visible, porque el prompt es
 * una expectativa, no una garantia.
 */
export interface DefinicionLineaRoja {
  id: string;
  nombre: string;
  /** Valor de `OutboundViolation` que la vigila, si existe alguno. */
  violacion?: string;
}

export const LINEAS_ROJAS: DefinicionLineaRoja[] = [
  { id: 'no_diagnosticar', nombre: 'Nunca diagnosticar', violacion: 'afirmacion_clinica' },
  { id: 'no_interpretar_sintomas', nombre: 'Nunca interpretar sintomas', violacion: 'afirmacion_clinica' },
  { id: 'no_recomendar_tratamientos', nombre: 'Nunca recomendar tratamientos', violacion: 'afirmacion_clinica' },
  { id: 'no_prometer_resultados', nombre: 'Nunca prometer resultados', violacion: 'promesa_de_resultado' },
  {
    id: 'no_cerrar_precios',
    nombre: 'Nunca cerrar precios de tratamientos que requieren valoracion',
    violacion: 'precio_cerrado_sin_valoracion',
  },
  { id: 'no_inventar_datos', nombre: 'Nunca inventar datos ausentes de la base' },
  { id: 'no_afirmar_ser_humano', nombre: 'Nunca afirmar ser humano', violacion: 'afirmacion_de_ser_humano' },
  {
    id: 'urgencia_escala',
    nombre: 'Ante urgencia medica: interrumpir el flujo comercial y escalar',
  },
];

export const CANALES = [
  { id: 'whatsapp', nombre: 'WhatsApp', resumen: 'Texto. Webhook de Meta con firma X-Hub-Signature-256.' },
  { id: 'voz', nombre: 'Voz', resumen: 'ElevenLabs con Custom LLM sobre un endpoint compatible con OpenAI.' },
];

export const FASES = [
  { id: '0', nombre: 'Fase 0 - Cimientos', resumen: 'Config, logger, arranque que falla si falta entorno.' },
  { id: '1', nombre: 'Fase 1 - Nucleo', resumen: 'ConversationService, prompt maestro, guardrails de 3 capas.' },
  { id: '2', nombre: 'Fase 2 - WhatsApp', resumen: 'Webhook, deduplicacion, formatter, revelacion escrita.' },
  { id: '3', nombre: 'Fase 3 - Bateria adversarial', resumen: '13 categorias, 91 casos en modo dobles.' },
  { id: '4', nombre: 'Fase 4 - Voz', resumen: 'Gateway OpenAI-SSE, mapper de system tools, sesiones.' },
  { id: '5', nombre: 'Fase 5 - Post-llamada', resumen: 'Webhook post-call de ElevenLabs, transcripciones.' },
  { id: '6', nombre: 'Fase 6 - Flujos n8n', resumen: 'Recordatorios, escalamiento, reporte mensual, QA nocturno.' },
  { id: '7', nombre: 'Fase 7 - Equidad', resumen: 'Auditoria de equidad del reconocimiento del habla (WER).' },
];

// ---------------------------------------------------------------------------
// Ayudas de identidad
// ---------------------------------------------------------------------------

export const idModulo = (ruta: string): string => `modulo:${ruta}`;
export const idSimbolo = (ruta: string, nombre: string): string => `simbolo:${ruta}#${nombre}`;
export const idPuerto = (nombre: string): string => `puerto:${nombre}`;
export const idHerramienta = (nombre: string): string => `herramienta:${nombre}`;
export const idControl = (codigo: string): string => `control:${codigo}`;
export const idCategoria = (codigo: string): string => `categoria_adversarial:${codigo}`;
export const idLineaRoja = (id: string): string => `linea_roja:${id}`;
export const idCanal = (id: string): string => `canal:${id}`;
export const idTabla = (nombre: string): string => `tabla:${nombre}`;
export const idPolitica = (nombre: string): string => `politica_rls:${nombre}`;
export const idCapa = (id: string): string => `capa:${id}`;
export const idVariable = (nombre: string): string => `variable_entorno:${nombre}`;
export const idFase = (id: string): string => `fase:${id}`;
