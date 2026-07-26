import { describe, expect, it } from 'vitest';
import { chunkText, type Chunk } from '../../src/core/rag/chunker.js';

/** Longitud del sufijo de `a` que tambien es prefijo de `b` (mide el solapamiento real entre fragmentos). */
function solapamientoCompartido(a: string, b: string): number {
  const maximo = Math.min(a.length, b.length);
  for (let n = maximo; n > 0; n--) {
    if (a.slice(-n) === b.slice(0, n)) return n;
  }
  return 0;
}

describe('chunkText', () => {
  it('un solo parrafo corto produce un unico fragmento, preservando fuente y version', () => {
    const resultado = chunkText({
      contenido: '  Atendemos de lunes a viernes, de 9 a 18 horas.  ',
      fuente: 'faq',
      version: 3,
    });

    expect(resultado).toHaveLength(1);
    expect(resultado[0]).toEqual<Chunk>({
      contenido: 'Atendemos de lunes a viernes, de 9 a 18 horas.',
      fuente: 'faq',
      version: 3,
      indice: 0,
    });
  });

  it('ignora parrafos vacios generados por lineas en blanco de mas', () => {
    const resultado = chunkText({
      contenido: 'Primer parrafo.\n\n\n\n   \n\nSegundo parrafo.',
      fuente: 'formulario',
      version: 1,
    });

    expect(resultado.map((f) => f.contenido)).toEqual(['Primer parrafo.\n\nSegundo parrafo.']);
  });

  it('fusiona parrafos cortos consecutivos en un mismo fragmento mientras quepan en el maximo', () => {
    const p1 = 'Hola, bienvenido.'; // 18
    const p2 = 'Atendemos de lunes a viernes.'; // 29
    const p3 = 'El horario es de 9 a 18 horas.'; // 30

    const resultado = chunkText(
      { contenido: `${p1}\n\n${p2}\n\n${p3}`, fuente: 'faq', version: 1 },
      { maxCaracteres: 50, minCaracteres: 20, solapamientoCaracteres: 10 },
    );

    // p1+p2 caben juntos en 50 (18+2+29=49); p3 no cabe con ellos y empieza fragmento propio.
    expect(resultado).toHaveLength(2);
    expect(resultado[0]?.contenido).toBe(`${p1}\n\n${p2}`);
    expect(resultado[1]?.contenido).toBe(p3);
    // Trazabilidad: todos los fragmentos declaran la misma fuente y version del documento origen.
    for (const [i, frag] of resultado.entries()) {
      expect(frag.fuente).toBe('faq');
      expect(frag.version).toBe(1);
      expect(frag.indice).toBe(i);
    }
  });

  it('no deja un fragmento huerfano demasiado breve: lo fusiona aunque exceda un poco el maximo', () => {
    // Buffer acumulado quedaria en 10 caracteres (< minCaracteres=20) si se cerrara aqui;
    // en vez de eso se fusiona con el parrafo siguiente aunque supere maxCaracteres=15.
    const corto = 'Hola a todos.'; // 13 chars, < minCaracteres
    const siguiente = 'Bienvenidos.'; // 12 chars

    const resultado = chunkText(
      { contenido: `${corto}\n\n${siguiente}`, fuente: 'faq', version: 1 },
      { maxCaracteres: 15, minCaracteres: 20, solapamientoCaracteres: 5 },
    );

    expect(resultado).toHaveLength(1);
    expect(resultado[0]?.contenido).toBe(`${corto}\n\n${siguiente}`);
  });

  it('parte un parrafo que excede el maximo por limites de oracion, con solapamiento entre fragmentos consecutivos', () => {
    const oraciones = [
      'Frase numero uno aqui.',
      'Frase numero dos aqui.',
      'Frase numero tres aqui.',
      'Frase numero cuatro aqui.',
      'Frase numero cinco aqui.',
      'Frase numero seis aqui.',
    ];
    const parrafoLargo = oraciones.join(' ');

    const resultado = chunkText(
      { contenido: parrafoLargo, fuente: 'protocolo_urgencia', version: 2 },
      { maxCaracteres: 45, minCaracteres: 10, solapamientoCaracteres: 15 },
    );

    // El parrafo (mas de 140 caracteres) no cabe en un fragmento de 45: debe partirse.
    expect(resultado.length).toBeGreaterThan(1);

    // Ninguna oracion queda cortada a mitad de frase: cada fragmento termina en . ? o !
    for (const frag of resultado) {
      expect(frag.contenido.trim()).toMatch(/[.?!]$/);
    }

    // Solapamiento real: el final de cada fragmento reaparece al inicio del siguiente.
    for (let i = 0; i < resultado.length - 1; i++) {
      const actual = resultado[i];
      const siguiente = resultado[i + 1];
      if (!actual || !siguiente) throw new Error('indices inesperados en el test');
      expect(solapamientoCompartido(actual.contenido, siguiente.contenido)).toBeGreaterThan(0);
    }

    // Trazabilidad preservada en todos los fragmentos partidos.
    for (const frag of resultado) {
      expect(frag.fuente).toBe('protocolo_urgencia');
      expect(frag.version).toBe(2);
    }
  });

  it('una sola oracion mas larga que el maximo no se pierde: se acepta como fragmento propio', () => {
    const oracionGigante =
      'Esta es una oracion deliberadamente larga que por si sola ya supera el maximo configurado para un fragmento.';

    const resultado = chunkText(
      { contenido: oracionGigante, fuente: 'web', version: 1 },
      { maxCaracteres: 30, minCaracteres: 5, solapamientoCaracteres: 5 },
    );

    expect(resultado).toHaveLength(1);
    expect(resultado[0]?.contenido).toBe(oracionGigante);
  });
});

describe('chunkText en modo un parrafo por fragmento', () => {
  /** Cuatro entradas de FAQ, todas cortas: juntas caben de sobra en un fragmento por defecto. */
  const faq = [
    '**Atienden sin cita?**\nSe atiende con cita previa.',
    '**Cuanto demora una limpieza?**\nEntre 40 y 60 minutos.',
    '**Aceptan seguro?**\nNo se trabaja con seguros ni con reembolso de EPS.',
    '**Atienden los domingos?**\nNo. De lunes a viernes y sabados por la manana.',
  ].join('\n\n');

  it('por defecto empaqueta las entradas cortas, que es lo que diluye la recuperacion en un FAQ', () => {
    const resultado = chunkText({ contenido: faq, fuente: 'faq', version: 1 });

    // El comportamiento por defecto mezcla preguntas sin relacion en un vector.
    expect(resultado.length).toBeLessThan(4);
  });

  it('con unParrafoPorFragmento cada pregunta queda aislada', () => {
    const resultado = chunkText(
      { contenido: faq, fuente: 'faq', version: 1 },
      { unParrafoPorFragmento: true },
    );

    expect(resultado).toHaveLength(4);
    expect(resultado[0]?.contenido).toContain('sin cita');
    expect(resultado[0]?.contenido).not.toContain('limpieza');
    expect(resultado[3]?.contenido).toContain('domingos');
    // Se preservan fuente, version e indice correlativo.
    expect(resultado.map((c: Chunk) => c.indice)).toEqual([0, 1, 2, 3]);
    expect(resultado.every((c: Chunk) => c.fuente === 'faq' && c.version === 1)).toBe(true);
  });

  it('sigue partiendo por oracion el parrafo que excede el maximo', () => {
    const largo = 'Primera oracion del parrafo. Segunda oracion del parrafo. Tercera oracion.';

    const resultado = chunkText(
      { contenido: largo, fuente: 'faq', version: 1 },
      { unParrafoPorFragmento: true, maxCaracteres: 40, solapamientoCaracteres: 0 },
    );

    expect(resultado.length).toBeGreaterThan(1);
    expect(resultado.every((c: Chunk) => c.contenido.length <= 40)).toBe(true);
  });

  it('solapamiento cero no duplica el fragmento anterior (regresion de slice(-0))', () => {
    // En JavaScript -0 === 0, asi que `texto.slice(-n)` con n = 0 devuelve la
    // cadena entera. Sin guarda, pedir cero solapamiento producia el maximo.
    const texto = 'Primera oracion del parrafo. Segunda oracion del parrafo. Tercera oracion.';

    const resultado = chunkText(
      { contenido: texto, fuente: 'faq', version: 1 },
      { unParrafoPorFragmento: true, maxCaracteres: 40, solapamientoCaracteres: 0 },
    );

    expect(resultado).toHaveLength(3);
    expect(resultado[1]?.contenido).toBe('Segunda oracion del parrafo.');
    expect(resultado[2]?.contenido).toBe('Tercera oracion.');
    // Ninguna oracion aparece en dos fragmentos distintos.
    expect(resultado[1]?.contenido).not.toContain('Primera');
  });
});
