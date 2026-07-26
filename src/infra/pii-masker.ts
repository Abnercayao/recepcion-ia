/**
 * Enmascarador de datos personales (PII).
 *
 * Contexto: PERU. Enmascara DNI, telefonos, correos, tarjetas, carnes de
 * extranjeria. Nunca muta el objeto original, maneja ciclos.
 *
 * Control C6: todo lo que se registra en logs pasa por aqui.
 */

// Patrones de deteccion (contexto peruano)
const PATTERNS = {
  // DNI peruano: exactamente 8 digitos
  dni: /\b\d{8}\b/g,

  // Telefono E.164 peruano: +51 seguido de digitos
  phoneE164: /\+51\d+/g,

  // Telefono local peruano: 9 digitos empezando por 9
  phoneLocal: /\b9\d{8}\b/g,

  // Correo electronico
  email: /[a-zA-Z0-9][a-zA-Z0-9._%-]*@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,

  // Numero de tarjeta: 13-19 digitos, con o sin espacios/guiones
  cardNumber: /\b(?:\d{4}[\s-]?){3}\d{3,7}\b|\b\d{13,19}\b/g,

  // Carne de extranjeria: CE seguido de 9-12 caracteres alfanumericos
  // Permite palabras intermedias: "carne de extranjeria es ABC123"
  ceNumber: /(?:CE|carne\s+de\s+extranjeria)\b\D+([A-Za-z0-9]{9,12})\b/gi,
};

/**
 * Enmascara un string segun los patrones peruanos.
 */
function maskString(str: string): string {
  let result = str;

  // DNI: 8 digitos -> ********
  result = result.replace(PATTERNS.dni, (match) => {
    // Verificar que sea un dni valido (no sea parte de un numero mas largo)
    if (/^\d{8}$/.test(match)) {
      return '********';
    }
    return match;
  });

  // Telefono E.164: +51987654321 -> +51*******21 (mostrar ultimos 2)
  result = result.replace(PATTERNS.phoneE164, (match) => {
    const digits = match.slice(3); // Quitar +51
    if (digits.length >= 2) {
      const last2 = digits.slice(-2);
      const stars = '*'.repeat(Math.max(1, digits.length - 2));
      return `+51${stars}${last2}`;
    }
    return match;
  });

  // Telefono local: 987654321 -> *******21 (mostrar ultimos 2)
  result = result.replace(PATTERNS.phoneLocal, (match) => {
    if (match.length === 9 && match[0] === '9') {
      const last2 = match.slice(-2);
      const stars = '*'.repeat(7);
      return `${stars}${last2}`;
    }
    return match;
  });

  // Correo: abner.cf@hotmail.com -> a****@hotmail.com
  result = result.replace(PATTERNS.email, (match) => {
    const [local, domain] = match.split('@');
    if (local && domain) {
      const first = local[0];
      const masked = `${first}****@${domain}`;
      return masked;
    }
    return match;
  });

  // Numero de tarjeta: mostrar solo ultimos 4 digitos
  result = result.replace(PATTERNS.cardNumber, (match) => {
    const digitsOnly = match.replace(/[\s-]/g, '');
    if (digitsOnly.length >= 13 && digitsOnly.length <= 19 && /^\d+$/.test(digitsOnly)) {
      const last4 = digitsOnly.slice(-4);
      const stars = '*'.repeat(digitsOnly.length - 4);
      return `${stars}${last4}`;
    }
    return match;
  });

  // Carne de extranjeria: CE XXXX... -> CE ****...
  result = result.replace(PATTERNS.ceNumber, (match) => {
    // Extraer la parte alfanumerica despues de CE o "carne de extranjeria"
    const alfanumericMatch = match.match(/([A-Za-z0-9]+)$/);
    if (alfanumericMatch) {
      const number = alfanumericMatch[1];
      const masked = '*'.repeat(number.length);
      return match.replace(number, masked);
    }
    return match;
  });

  return result;
}

/**
 * Enmascara un valor arbitrario (string, objeto, array, etc).
 * No muta el original, devuelve copia.
 * Maneja referencias circulares.
 */
export function maskPII(value: unknown): unknown {
  const seen = new WeakSet<object>();

  function traverse(val: unknown): unknown {
    // Primitivos que no son string: devolver tal cual
    if (val === null || val === undefined) {
      return val;
    }

    if (typeof val === 'string') {
      return maskString(val);
    }

    if (typeof val !== 'object') {
      // number, boolean, function, symbol, etc
      return val;
    }

    // Es un objeto
    if (seen.has(val)) {
      // Referencia circular: devolver undefined para romper el ciclo
      return undefined;
    }

    // Date: no enmascarar, devolver copia (sigue siendo Date)
    if (val instanceof Date) {
      return new Date(val);
    }

    // Ignorar otros tipos especiales (RegExp, Map, Set, etc)
    if (val instanceof RegExp || val instanceof Map || val instanceof Set) {
      return val;
    }

    seen.add(val);

    // Array
    if (Array.isArray(val)) {
      const masked: unknown[] = [];
      for (let i = 0; i < val.length; i++) {
        masked[i] = traverse(val[i]);
      }
      return masked;
    }

    // Objeto plano
    const masked: Record<string, unknown> = {};
    for (const key in val) {
      if (Object.prototype.hasOwnProperty.call(val, key)) {
        masked[key] = traverse((val as Record<string, unknown>)[key]);
      }
    }
    return masked;
  }

  return traverse(value);
}

/**
 * Enmascara campos especificos por NOMBRE.
 *
 * Ejemplo: maskKeys({telefono: '+51987654321', nombre: 'Juan'}, ['telefono'])
 * Resultado: {telefono: '****', nombre: 'Juan'}
 *
 * Util cuando un valor no coincide con ningun patron automatico pero es PII.
 */
export function maskKeys(obj: unknown, keysToMask: string[]): unknown {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  const seen = new WeakSet<object>();

  function traverse(val: unknown): unknown {
    if (val === null || val === undefined) {
      return val;
    }

    if (typeof val !== 'object') {
      return val;
    }

    if (seen.has(val)) {
      return undefined;
    }

    if (val instanceof Date) {
      return new Date(val);
    }

    if (val instanceof RegExp || val instanceof Map || val instanceof Set) {
      return val;
    }

    seen.add(val);

    if (Array.isArray(val)) {
      return val.map((item) => traverse(item));
    }

    const masked: Record<string, unknown> = {};
    for (const key in val) {
      if (Object.prototype.hasOwnProperty.call(val, key)) {
        const lowerKey = key.toLowerCase();
        const shouldMask = keysToMask.some(
          (k) => k.toLowerCase() === lowerKey
        );

        if (shouldMask) {
          const value = (val as Record<string, unknown>)[key];
          // Intentar aplicar los patrones automaticos. Si no hay coincidencia, usar generico.
          if (typeof value === 'string') {
            const masked_str = maskString(value);
            // Si maskString cambio algo, devolver el resultado. Si no, devolver generico.
            masked[key] = masked_str;
          } else if (typeof value === 'number') {
            masked[key] = '****';
          } else if (value !== null && value !== undefined) {
            masked[key] = '****';
          } else {
            masked[key] = value;
          }
        } else {
          masked[key] = traverse((val as Record<string, unknown>)[key]);
        }
      }
    }
    return masked;
  }

  return traverse(obj);
}
