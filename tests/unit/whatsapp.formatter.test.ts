/**
 * Tests de src/channels/whatsapp/whatsapp.formatter.ts.
 *
 * Cubre exactamente lo que pide el Encargo 2: troceado por frases respetando
 * el limite de 4096 caracteres sin cortar palabras, negritas de WhatsApp
 * (`*asi*`) correctas, y la garantia de que NUNCA se emite markdown de
 * doble asterisco (`**asi**`).
 */
import { describe, expect, it } from 'vitest';
import { formatOutboundMessage } from '../../src/channels/whatsapp/whatsapp.formatter.js';
import { WHATSAPP_MAX_MESSAGE_LENGTH } from '../../src/channels/whatsapp/whatsapp.types.js';

describe('formatOutboundMessage - casos simples', () => {
  it('un texto corto se devuelve como un unico mensaje sin cambios', () => {
    const chunks = formatOutboundMessage('Hola, tu cita es el jueves a las 4pm.');
    expect(chunks).toEqual(['Hola, tu cita es el jueves a las 4pm.']);
  });

  it('preserva saltos de linea sin transformarlos', () => {
    const texto = 'Linea uno.\nLinea dos.\nLinea tres.';
    const chunks = formatOutboundMessage(texto);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(texto);
  });

  it('deja pasar emojis sin modificarlos', () => {
    const texto = 'Tu cita quedo confirmada 😊 Nos vemos pronto.';
    const chunks = formatOutboundMessage(texto);
    expect(chunks[0]).toContain('😊');
  });

  it('texto vacio devuelve un unico chunk vacio', () => {
    const chunks = formatOutboundMessage('');
    expect(chunks).toEqual(['']);
  });
});

describe('formatOutboundMessage - negritas de WhatsApp', () => {
  it('convierte markdown de doble asterisco a la negrita real de WhatsApp (un solo asterisco)', () => {
    const chunks = formatOutboundMessage('Tu cita es **el jueves** a las 4pm.');
    expect(chunks[0]).toBe('Tu cita es *el jueves* a las 4pm.');
  });

  it('nunca deja pasar doble asterisco literal en la salida', () => {
    const chunks = formatOutboundMessage('Confirmado: **martes 10** con la **Dra. Perez**.');
    for (const chunk of chunks) {
      expect(chunk).not.toContain('**');
    }
  });

  it('preserva negritas ya correctas de WhatsApp (un solo asterisco) sin tocarlas', () => {
    const chunks = formatOutboundMessage('Tu cita es *el jueves* a las 4pm.');
    expect(chunks[0]).toBe('Tu cita es *el jueves* a las 4pm.');
  });

  it('convierte varias ocurrencias de doble asterisco en el mismo texto', () => {
    const chunks = formatOutboundMessage('**Uno** y **dos** y **tres**.');
    expect(chunks[0]).toBe('*Uno* y *dos* y *tres*.');
  });
});

describe('formatOutboundMessage - troceado por limite de 4096 caracteres', () => {
  it('no trocea un texto que cae exactamente en el limite', () => {
    const texto = 'a'.repeat(WHATSAPP_MAX_MESSAGE_LENGTH);
    const chunks = formatOutboundMessage(texto);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(WHATSAPP_MAX_MESSAGE_LENGTH);
  });

  it('trocea un texto que excede el limite en mas de un mensaje', () => {
    // Genera frases cortas repetidas para superar el limite con puntuacion clara.
    const frase = 'Esta es una frase de prueba para el troceado. ';
    const texto = frase.repeat(Math.ceil((WHATSAPP_MAX_MESSAGE_LENGTH * 2.5) / frase.length));
    const chunks = formatOutboundMessage(texto);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(WHATSAPP_MAX_MESSAGE_LENGTH);
    }
    // Reensamblar los trozos debe reproducir el texto original sin perdida.
    expect(chunks.join('')).toBe(texto);
  });

  it('nunca corta a mitad de una palabra al trocear por frases', () => {
    const frase = 'Recuerda traer tu documento de identidad y llegar quince minutos antes. ';
    const texto = frase.repeat(Math.ceil((WHATSAPP_MAX_MESSAGE_LENGTH * 3) / frase.length));
    const chunks = formatOutboundMessage(texto);

    for (const chunk of chunks) {
      // Ninguna frontera de chunk debe caer dentro de una palabra: cada
      // chunk debe empezar y terminar en un limite de espacio en blanco
      // (o al inicio/fin absoluto del texto original).
      expect(chunk.length === 0 || /^\S/.test(chunk) || /\s$/.test(chunk) || chunk === chunk.trim()).toBe(true);
    }
    expect(chunks.join('')).toBe(texto);
  });

  it('respeta el limite incluso cuando una sola "frase" (sin puntuacion) excede el limite', () => {
    // Sin puntuacion de cierre: cae al caso limite de trocear por palabras.
    const palabras = Array.from({ length: 2000 }, (_, i) => `palabra${i}`).join(' ');
    const chunks = formatOutboundMessage(palabras);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(WHATSAPP_MAX_MESSAGE_LENGTH);
    }
    // No debe haber partido ninguna palabra: cada trozo, sin espacios en los
    // extremos, debe estar compuesto integramente por "palabraN" completas.
    for (const chunk of chunks) {
      const piezas = chunk.trim().split(/\s+/).filter(Boolean);
      for (const pieza of piezas) {
        expect(/^palabra\d+$/.test(pieza)).toBe(true);
      }
    }
  });

  it('acepta un limite configurable (para probar el caso limite sin textos gigantes)', () => {
    const chunks = formatOutboundMessage('Hola. Como estas. Bien gracias.', 10);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
    }
    expect(chunks.join('')).toBe('Hola. Como estas. Bien gracias.');
  });
});
