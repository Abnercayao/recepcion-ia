/**
 * Recolector de trazas en memoria.
 *
 * Implementa `RecolectorDeTraza` (declarado en el nucleo) y es lo que alimenta
 * el panel de diagnostico de la web. Guarda un anillo de los ultimos turnos y
 * los sirve del mas reciente al mas antiguo.
 *
 * POR QUE EN MEMORIA Y NO EN LA BASE
 * Es un instrumento de diagnostico en vivo, no un registro de auditoria. La
 * auditoria ya existe y va a `audit_log`, `tool_calls` y `messages`, con sus
 * politicas de retencion. Duplicarla aqui anadiria una escritura por salto en
 * el camino critico del turno --el que el paciente esta esperando-- para
 * guardar algo que solo se mira mientras se depura. Se pierde al reiniciar, y
 * es lo correcto: nada de esto deberia sobrevivir al proceso.
 *
 * ENMASCARADO (control C6)
 * TODO lo que se guarda pasa por `maskPII`, igual que el log. La traza lleva
 * texto del paciente y argumentos de herramientas --nombres, telefonos--, y se
 * sirve por HTTP: es exactamente el material que el control C6 existe para que
 * no se escape. El nucleo no puede hacerlo (no importa de `infra/`), asi que
 * es responsabilidad de esta clase y se hace en un solo punto: `guardar`.
 */
import {
  TurnoEnTrazaImpl,
  type CabeceraDeTurno,
  type RecolectorDeTraza,
  type TrazaDeTurno,
  type TurnoEnTraza,
} from '../core/observabilidad/traza.js';
import { maskPII } from './pii-masker.js';

/** Turnos retenidos. Pasado el tope, cae el mas antiguo. */
const MAX_TRAZAS_POR_DEFECTO = 60;

export interface OpcionesDeRecolector {
  maxTrazas?: number;
  /**
   * Recorta los textos largos antes de guardarlos. El prompt del sistema son
   * ~12 KB; guardarlo entero por turno llena la memoria sin decir nada mas de
   * lo que dice su tamano.
   */
  maxCaracteresPorCampo?: number;
}

const MAX_CARACTERES_POR_DEFECTO = 2000;

export class RecolectorDeTrazaEnMemoria implements RecolectorDeTraza {
  private readonly trazas: TrazaDeTurno[] = [];
  private readonly maxTrazas: number;
  private readonly maxCaracteres: number;

  constructor(opciones: OpcionesDeRecolector = {}) {
    this.maxTrazas = opciones.maxTrazas ?? MAX_TRAZAS_POR_DEFECTO;
    this.maxCaracteres = opciones.maxCaracteresPorCampo ?? MAX_CARACTERES_POR_DEFECTO;
  }

  abrir(cabecera: CabeceraDeTurno): TurnoEnTraza {
    return new TurnoEnTrazaImpl(cabecera, (traza) => {
      this.guardar(traza);
    });
  }

  /**
   * Deja una traza ya montada, para lo que NO pasa por el orquestador.
   *
   * El modo alojado es el caso: alli razona el modelo del proveedor y lo unico
   * que toca nuestro codigo son los webhooks de las herramientas. Sin esto, el
   * canal de voz seria un agujero negro justo en el modo en que corre hoy.
   */
  registrar(traza: TrazaDeTurno): void {
    this.guardar(traza);
  }

  /** De la mas reciente a la mas antigua. */
  listar(limite?: number): TrazaDeTurno[] {
    const n = limite ?? this.trazas.length;
    return this.trazas.slice(0, Math.max(0, n));
  }

  /**
   * La ultima traza de una conversacion.
   *
   * Se busca por conversacion y no "la ultima de todas" a proposito: con dos
   * pestanas abiertas --dos pacientes distintos-- coger la mas reciente
   * devolveria la del otro, y el panel mostraria el turno de alguien mas.
   */
  ultimaDe(conversationId: string): TrazaDeTurno | undefined {
    return this.trazas.find((t) => t.conversationId === conversationId);
  }

  /** Trazas posteriores a un instante ISO. Para que la web pida solo lo nuevo. */
  desde(iso: string): TrazaDeTurno[] {
    const corte = Date.parse(iso);
    if (Number.isNaN(corte)) return this.listar();
    return this.trazas.filter((t) => Date.parse(t.abiertoEn) > corte);
  }

  get total(): number {
    return this.trazas.length;
  }

  vaciar(): void {
    this.trazas.length = 0;
  }

  private guardar(traza: TrazaDeTurno): void {
    const seguro = maskPII(this.recortar(traza)) as TrazaDeTurno;
    this.trazas.unshift(seguro);
    if (this.trazas.length > this.maxTrazas) this.trazas.length = this.maxTrazas;
  }

  /**
   * Recorta cadenas largas dejando constancia de lo recortado.
   *
   * Se hace ANTES de enmascarar a proposito: enmascarar un texto ya cortado es
   * mas barato, y el corte nunca parte un patron de forma que lo esconda del
   * enmascarador --lo peor que puede pasar es que el trozo con el telefono
   * desaparezca entero, que es el lado seguro del error.
   */
  private recortar(traza: TrazaDeTurno): TrazaDeTurno {
    const corta = (v: unknown): unknown => {
      if (typeof v === 'string' && v.length > this.maxCaracteres) {
        return `${v.slice(0, this.maxCaracteres)}… [+${String(v.length - this.maxCaracteres)} caracteres]`;
      }
      /**
       * Las fechas ANTES que el caso general de objeto.
       *
       * Un `Date` no tiene propiedades enumerables, asi que `Object.entries` lo
       * deja en `{}`: los huecos de agenda llegaban al panel como
       * `{"start":{},"end":{}}`. Es el peor fallo posible en un instrumento de
       * diagnostico --borra justo el dato que se esta diagnosticando-- y se
       * descubrio depurando por que el agente ofrecia horarios raros: la traza
       * no podia decirlo. Se pasa a ISO, que es legible y no ambiguo.
       */
      if (v instanceof Date) return v.toISOString();
      if (Array.isArray(v)) return v.map(corta);
      if (v !== null && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, corta(x)]));
      }
      return v;
    };

    return {
      ...traza,
      entrada: corta(traza.entrada) as string,
      salida: corta(traza.salida) as string,
      saltos: traza.saltos.map((s) => ({ ...s, detalle: corta(s.detalle) as Record<string, unknown> })),
    };
  }
}
