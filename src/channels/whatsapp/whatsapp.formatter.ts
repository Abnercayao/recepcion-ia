/**
 * whatsapp.formatter.ts
 *
 * Traduce el texto PURO que emite el nucleo (`OutboundMessage.text`; el
 * nucleo "no emite markdown, ni emojis, ni SSML", ver core/types/message.ts)
 * al formato propio del canal de texto (Tabla 9 del informe del proyecto:
 * negritas, saltos de linea y emojis moderados admitidos en el canal de
 * texto). Aqui NO se decide contenido: solo se ajusta su forma.
 *
 * Responsabilidades exactas (Encargo 2):
 *  1. Negritas de WhatsApp: `*asi*` (un asterisco), que NO es markdown.
 *     Si por algun motivo llega texto con markdown de doble asterisco
 *     (`**asi**`) -- el nucleo no deberia emitirlo nunca, pero esta es la
 *     ultima linea de defensa -- se convierte a la negrita real de WhatsApp.
 *     Nunca se deja pasar `**` literal: WhatsApp no lo interpreta y se ve
 *     tal cual en el chat del paciente.
 *  2. Saltos de linea: WhatsApp los renderiza tal cual en `text.body`; no
 *     hace falta transformarlos, se preservan sin tocar.
 *  3. Emojis: se dejan pasar sin modificar. Decidir SI incluir un emoji es
 *     una decision de contenido/tono (vive en el prompt maestro, bloque de
 *     estilo de texto); el formateador no inyecta emojis por su cuenta,
 *     porque eso cruzaria a "decidir" y no "traducir".
 *  4. Troceado: la Cloud API limita el cuerpo de un mensaje de texto a 4096
 *     caracteres. Si el texto excede el limite, se trocea por frases
 *     (nunca a mitad de palabra) y se devuelve un array de mensajes a
 *     enviar en orden.
 */
import { WHATSAPP_MAX_MESSAGE_LENGTH } from './whatsapp.types.js';

/**
 * Convierte markdown de doble asterisco (`**negrita**`) a la negrita real de
 * WhatsApp (`*negrita*`). No toca asteriscos simples ya correctos.
 */
function convertDoubleAsteriskBold(text: string): string {
  return text.replace(/\*\*([^*]+?)\*\*/g, '*$1*');
}

/**
 * Divide un texto en "frases", conservando la puntuacion de cierre (. ! ?) y
 * el espacio en blanco que la sigue, para poder reensamblar los trozos sin
 * alterar ni un caracter del texto original. Si el texto no termina con
 * puntuacion de frase, el remanente final se devuelve como su propia "frase".
 */
function splitIntoSentences(text: string): string[] {
  const matches = text.match(/[\s\S]*?[.!?]+(?:\s+|$)|[\s\S]+$/g);
  return matches && matches.length > 0 ? matches : [text];
}

/**
 * Ultimo recurso cuando una sola "frase" ya excede el limite (p. ej. un
 * parrafo largo sin puntuacion, o una URL). Corta en el ultimo espacio antes
 * del limite para NUNCA partir una palabra. Si no hay ningun espacio util
 * (una palabra unica mas larga que el limite completo), se corta duro: caso
 * degenerado que se documenta en vez de fingir que no puede pasar.
 */
function splitLongTextByWords(text: string, limit: number): { head: string; rest: string } {
  if (text.length <= limit) {
    return { head: text, rest: '' };
  }
  // Se busca el espacio en [0, limit-1] (no en limit) para que, al incluirlo
  // en `head`, el largo de `head` (cut + 1) jamas exceda `limit`. El espacio
  // se deja pegado al final de `head` (no al inicio de `rest`): asi no se
  // pierde ni un caracter del texto original y `rest` nunca arranca con un
  // espacio colgante.
  const cut = text.lastIndexOf(' ', limit - 1);
  if (cut <= 0) {
    // No hay espacio util: una sola palabra mas larga que el limite entero.
    // Caso degenerado documentado, no fingido: se corta duro.
    return { head: text.slice(0, limit), rest: text.slice(limit) };
  }
  return { head: text.slice(0, cut + 1), rest: text.slice(cut + 1) };
}

/**
 * Empaqueta un texto ya formateado en trozos de a lo sumo `limit` caracteres,
 * frase por frase, sin partir palabras.
 */
function packIntoChunks(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let current = '';

  for (const rawSentence of splitIntoSentences(text)) {
    let sentence = rawSentence;

    while (sentence.length > limit) {
      if (current.length > 0) {
        chunks.push(current);
        current = '';
      }
      const { head, rest } = splitLongTextByWords(sentence, limit);
      chunks.push(head);
      sentence = rest;
    }

    if (sentence.length === 0) continue;

    if (current.length + sentence.length > limit) {
      chunks.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Punto de entrada del formateador. Devuelve uno o mas mensajes listos para
 * enviar por la Cloud API, en el orden en que deben salir.
 */
export function formatOutboundMessage(
  rawText: string,
  limit: number = WHATSAPP_MAX_MESSAGE_LENGTH,
): string[] {
  const formatted = convertDoubleAsteriskBold(rawText);
  return packIntoChunks(formatted, limit);
}
