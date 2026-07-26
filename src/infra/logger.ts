/**
 * Logger estructurado sobre pino.
 *
 * INVARIANTE: todo objeto registrado pasa por maskPII. Es imposible saltarlo.
 * Control C6: este es el punto de control central contra fuga de PII en logs.
 */

import pino, { type Logger as PinoLogger } from 'pino';
import { maskPII } from './pii-masker.js';
import type { Logger } from '../core/types/ports.js';
import type { Config } from './config.js';

/**
 * Envoltura alrededor de pino que enmascara todo lo que se registra.
 *
 * Implementa la interfaz Logger y garantiza que cada llamada a fatal/error/warn/info/debug
 * pasa el objeto por maskPII, haciendo imposible que un DNI o telefono se escape.
 */
class MaskedLogger implements Logger {
  constructor(
    private readonly pinoLogger: PinoLogger,
  ) {}

  fatal(obj: Record<string, unknown>, msg?: string): void {
    const masked = maskPII(obj) as Record<string, unknown>;
    this.pinoLogger.fatal(masked, msg);
  }

  error(obj: Record<string, unknown>, msg?: string): void {
    const masked = maskPII(obj) as Record<string, unknown>;
    this.pinoLogger.error(masked, msg);
  }

  warn(obj: Record<string, unknown>, msg?: string): void {
    const masked = maskPII(obj) as Record<string, unknown>;
    this.pinoLogger.warn(masked, msg);
  }

  info(obj: Record<string, unknown>, msg?: string): void {
    const masked = maskPII(obj) as Record<string, unknown>;
    this.pinoLogger.info(masked, msg);
  }

  debug(obj: Record<string, unknown>, msg?: string): void {
    const masked = maskPII(obj) as Record<string, unknown>;
    this.pinoLogger.debug(masked, msg);
  }

  child(bindings: Record<string, unknown>): Logger {
    const maskedBindings = maskPII(bindings) as Record<string, unknown>;
    const childPino = this.pinoLogger.child(maskedBindings);
    return new MaskedLogger(childPino);
  }
}

/**
 * Crea un logger segun la configuracion.
 *
 * - Nivel desde config.LOG_LEVEL
 * - pino-pretty solo cuando NODE_ENV !== 'production'
 * - Enmascaramiento obligatorio de todo objeto registrado
 */
export function createLogger(config: Config): Logger {
  const isDev = config.NODE_ENV !== 'production';

  const pinoOptions = {
    level: config.LOG_LEVEL,
    ...(isDev && { transport: { target: 'pino-pretty' } }),
  };

  const pinoInstance = pino(pinoOptions);
  return new MaskedLogger(pinoInstance);
}
