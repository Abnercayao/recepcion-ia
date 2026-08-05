/**
 * TRAZA DE TURNO: que paso, en que orden y cuanto costo cada salto.
 *
 * Existe por un hueco concreto. El sistema ya persistia el resultado
 * (`tool_calls.latencia_ms`, `latency_metrics`, mensajes de rol `tool`) y
 * registraba fragmentos sueltos en el log, pero nadie podia ver un turno
 * ENTERO de una vez: cuantas veces se llamo al modelo, que recupero el RAG y
 * con que similitud, si la capa 2 retuvo o bloqueo, donde se fueron los
 * segundos. Diagnosticar la latencia --12-14 s contra un objetivo de 1200 ms--
 * o una respuesta inventada obligaba a leer logs de dos procesos a la vez.
 *
 * TRES DECISIONES QUE CONVIENE CONOCER
 *
 * 1. No entra en `ports.ts`. Ese archivo es el contrato compartido y esta
 *    congelado. La traza es observabilidad, no una frontera del dominio: se
 *    declara aqui y se inyecta como dependencia OPCIONAL del orquestador. Sin
 *    recolector, `TRAZA_NULA` hace que todas las llamadas cuesten una rama.
 *
 * 2. El nucleo DECLARA, `infra/` GUARDA. Aqui no hay almacenamiento ni
 *    enmascarado: `maskPII` vive en `infra/pii-masker.ts` y el nucleo no puede
 *    importarlo. Quien implemente `RecolectorDeTraza` es responsable de
 *    enmascarar antes de guardar (control C6). Ver `infra/traza.memoria.ts`.
 *
 * 3. El resumen se CALCULA de los saltos, no se lleva a mano. Un contador
 *    paralelo se desincroniza en cuanto alguien anade una rama y se olvida de
 *    incrementarlo; derivarlo no puede mentir sobre lo que se registro.
 */

/** Familia del salto. Es lo que la interfaz agrupa y colorea. */
export type TipoDeSalto =
  | 'enrutado'
  | 'capa1'
  | 'capa3'
  | 'rag'
  | 'prompt'
  | 'modelo'
  | 'herramienta'
  | 'capa2'
  | 'persistencia'
  | 'webhook'
  | 'aviso';

export type EstadoDeSalto = 'ok' | 'aviso' | 'error';

export interface SaltoDeTraza {
  /** Orden de apertura dentro del turno, empezando en 1. */
  n: number;
  tipo: TipoDeSalto;
  nombre: string;
  estado: EstadoDeSalto;
  /** Milisegundos desde el inicio del turno hasta que ABRIO este salto. */
  desdeMs: number;
  duracionMs: number;
  detalle: Record<string, unknown>;
}

export interface ResumenDeTurno {
  llamadasAlModelo: number;
  /** Herramienta -> veces invocada EN ESTE TURNO. La causa principal de latencia. */
  herramientas: Record<string, number>;
  tokensIn: number;
  tokensOut: number;
  /** Como resolvio el RAG: vectorial, respaldo lexico, cortesia, vacio... */
  ragEstrategia: string;
  fragmentos: number;
  /** Que hizo la capa 2 con la salida del modelo. */
  capa2: 'no actuo' | 'retuvo' | 'bloqueo';
  urgencia: boolean;
  escalado: boolean;
  /** Reparto del tiempo. Lo que no cae en ningun tramo medido queda en `otros`. */
  msModelo: number;
  msHerramientas: number;
  msRag: number;
  msOtros: number;
}

export interface TrazaDeTurno {
  id: string;
  conversationId: string;
  clinicId: string;
  canal: string;
  sesion?: string;
  /** Mensaje del paciente que abrio el turno. Lo enmascara el recolector. */
  entrada: string;
  /** Respuesta finalmente EMITIDA. La rellena `cerrar`. */
  salida: string;
  abiertoEn: string;
  duracionMs: number;
  saltos: SaltoDeTraza[];
  resumen: ResumenDeTurno;
}

export interface CabeceraDeTurno {
  /**
   * Puede abrirse vacio. El turno empieza ANTES de que el enrutador resuelva la
   * conversacion, y ese tramo tambien hay que medirlo: si el enrutado es lo que
   * falla, una traza que empieza despues no lo ve. Se rellena con `identificar`.
   */
  conversationId?: string;
  clinicId?: string;
  canal: string;
  sesion?: string;
  entrada: string;
}

/** Devuelto por `iniciar`. Cerrarlo dos veces no hace nada: la primera manda. */
export interface MedidorDeSalto {
  fin(cierre?: { estado?: EstadoDeSalto; detalle?: Record<string, unknown> }): void;
}

export interface TurnoEnTraza {
  /** Completa la cabecera en cuanto el enrutador resuelve a quien pertenece el turno. */
  identificar(datos: { conversationId?: string; clinicId?: string }): void;
  /**
   * Salto con duracion. El `fin` del medidor la cierra.
   *
   * `desde` permite FECHAR EL SALTO HACIA ATRAS, en el instante en que de
   * verdad empezo. Hace falta cuando el codigo se entera tarde de que algo ya
   * estaba corriendo: la espera al primer token del modelo empieza cuando se
   * lanza la peticion, pero solo se descubre al llegar el primer fragmento. Sin
   * esto, esa espera --que suele ser la mayor parte del turno-- no se le
   * atribuye a nadie y el diagnostico apunta al sitio equivocado.
   */
  iniciar(
    tipo: TipoDeSalto,
    nombre: string,
    detalle?: Record<string, unknown>,
    desde?: number,
  ): MedidorDeSalto;
  /** Salto instantaneo: una decision, un aviso, un veredicto. */
  marcar(
    tipo: TipoDeSalto,
    nombre: string,
    estado?: EstadoDeSalto,
    detalle?: Record<string, unknown>,
  ): void;
  /** Campos del resumen que no se pueden derivar de los saltos. */
  anotar(campos: Partial<ResumenDeTurno>): void;
  /** Cierra el turno y lo entrega al recolector. Idempotente. */
  cerrar(salida: string): void;
}

export interface RecolectorDeTraza {
  abrir(cabecera: CabeceraDeTurno): TurnoEnTraza;
}

// ---------------------------------------------------------------------------
// Objeto nulo
// ---------------------------------------------------------------------------

const MEDIDOR_NULO: MedidorDeSalto = { fin: () => {} };

const TURNO_NULO: TurnoEnTraza = {
  identificar: () => {},
  iniciar: () => MEDIDOR_NULO,
  marcar: () => {},
  anotar: () => {},
  cerrar: () => {},
};

/**
 * Recolector que no recoge nada.
 *
 * Es lo que usa el orquestador cuando no le inyectan uno, y es la razon de que
 * instrumentar no haya obligado a tocar un solo test existente: sin recolector,
 * el comportamiento es identico al de antes.
 */
export const TRAZA_NULA: RecolectorDeTraza = { abrir: () => TURNO_NULO };

// ---------------------------------------------------------------------------
// Construccion de un turno
// ---------------------------------------------------------------------------

const RESUMEN_VACIO: ResumenDeTurno = {
  llamadasAlModelo: 0,
  herramientas: {},
  tokensIn: 0,
  tokensOut: 0,
  ragEstrategia: 'sin datos',
  fragmentos: 0,
  capa2: 'no actuo',
  urgencia: false,
  escalado: false,
  msModelo: 0,
  msHerramientas: 0,
  msRag: 0,
  msOtros: 0,
};

/**
 * Acumula los saltos de UN turno y, al cerrarlo, entrega la traza completa.
 *
 * `ahora` es inyectable para que los tests no dependan del reloj.
 */
export class TurnoEnTrazaImpl implements TurnoEnTraza {
  private readonly t0: number;
  private readonly saltos: SaltoDeTraza[] = [];
  private anotado: Partial<ResumenDeTurno> = {};
  private cabecera: CabeceraDeTurno;
  private cerrado = false;
  private n = 0;

  constructor(
    cabecera: CabeceraDeTurno,
    private readonly entregar: (traza: TrazaDeTurno) => void,
    private readonly ahora: () => number = Date.now,
  ) {
    this.cabecera = cabecera;
    this.t0 = ahora();
  }

  identificar(datos: { conversationId?: string; clinicId?: string }): void {
    this.cabecera = {
      ...this.cabecera,
      ...(datos.conversationId ? { conversationId: datos.conversationId } : {}),
      ...(datos.clinicId ? { clinicId: datos.clinicId } : {}),
    };
  }

  iniciar(
    tipo: TipoDeSalto,
    nombre: string,
    detalle: Record<string, unknown> = {},
    desde?: number,
  ): MedidorDeSalto {
    // Nunca antes del inicio del turno: un `desde` mal calculado no debe
    // producir un salto con `desdeMs` negativo, que se leeria como un error de
    // medida en vez de como lo que es, un dato aproximado.
    const abierto = desde !== undefined ? Math.max(this.t0, desde) : this.ahora();
    this.n += 1;
    const salto: SaltoDeTraza = {
      n: this.n,
      tipo,
      nombre,
      estado: 'ok',
      desdeMs: abierto - this.t0,
      duracionMs: 0,
      detalle,
    };
    // Se empuja YA, no al cerrar: si el turno revienta a mitad, el salto en
    // curso tiene que verse en la traza. Un salto sin cerrar con duracion 0 es
    // justo la pista que hace falta para saber donde murio.
    this.saltos.push(salto);

    let yaCerrado = false;
    return {
      fin: (cierre) => {
        if (yaCerrado) return;
        yaCerrado = true;
        salto.duracionMs = this.ahora() - abierto;
        if (cierre?.estado) salto.estado = cierre.estado;
        if (cierre?.detalle) salto.detalle = { ...salto.detalle, ...cierre.detalle };
      },
    };
  }

  marcar(
    tipo: TipoDeSalto,
    nombre: string,
    estado: EstadoDeSalto = 'ok',
    detalle: Record<string, unknown> = {},
  ): void {
    this.n += 1;
    this.saltos.push({
      n: this.n,
      tipo,
      nombre,
      estado,
      desdeMs: this.ahora() - this.t0,
      duracionMs: 0,
      detalle,
    });
  }

  anotar(campos: Partial<ResumenDeTurno>): void {
    this.anotado = { ...this.anotado, ...campos };
  }

  cerrar(salida: string): void {
    if (this.cerrado) return;
    this.cerrado = true;

    const duracionMs = this.ahora() - this.t0;
    // Un turno que muere en el enrutado no tiene conversacion, y aun asi tiene
    // que aparecer en el panel: es justo el caso que hay que poder ver.
    const conversationId = this.cabecera.conversationId ?? 'sin-conversacion';
    const traza: TrazaDeTurno = {
      id: `${conversationId}-${String(this.t0)}`,
      conversationId,
      clinicId: this.cabecera.clinicId ?? 'sin-clinica',
      canal: this.cabecera.canal,
      ...(this.cabecera.sesion ? { sesion: this.cabecera.sesion } : {}),
      entrada: this.cabecera.entrada,
      salida,
      abiertoEn: new Date(this.t0).toISOString(),
      duracionMs,
      saltos: this.saltos,
      resumen: this.calcularResumen(duracionMs),
    };
    this.entregar(traza);
  }

  /** Todo lo derivable sale de los saltos; `anotado` solo cubre lo que no lo es. */
  private calcularResumen(duracionMs: number): ResumenDeTurno {
    const herramientas: Record<string, number> = {};
    let llamadasAlModelo = 0;
    let msModelo = 0;
    let msHerramientas = 0;
    let msRag = 0;

    for (const s of this.saltos) {
      if (s.tipo === 'modelo') {
        llamadasAlModelo += 1;
        msModelo += s.duracionMs;
      } else if (s.tipo === 'herramienta') {
        herramientas[s.nombre] = (herramientas[s.nombre] ?? 0) + 1;
        msHerramientas += s.duracionMs;
      } else if (s.tipo === 'rag') {
        msRag += s.duracionMs;
      }
    }

    return {
      ...RESUMEN_VACIO,
      ...this.anotado,
      llamadasAlModelo,
      herramientas,
      msModelo,
      msHerramientas,
      msRag,
      // Lo no atribuido a ningun tramo medido. Si crece, es que hay tiempo
      // yendose por un sitio que todavia no se esta midiendo.
      msOtros: Math.max(0, duracionMs - msModelo - msHerramientas - msRag),
    };
  }
}
