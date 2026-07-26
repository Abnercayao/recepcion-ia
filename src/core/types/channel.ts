import { z } from 'zod';

/**
 * El canal es un atributo del MENSAJE, no una propiedad del sistema.
 *
 * Esta es la restriccion arquitectonica no negociable del proyecto: existe un
 * unico ConversationService, un unico prompt maestro, una unica base de
 * conocimiento por clinica y un unico conjunto de herramientas. Los canales son
 * adaptadores que traducen. Si aparece logica de negocio ramificada por canal
 * fuera del bloque de estilo del prompt, el diseno esta mal implementado.
 */
export type Channel = 'whatsapp' | 'voice';

export const channelSchema = z.enum(['whatsapp', 'voice']);

export const CHANNELS: readonly Channel[] = ['whatsapp', 'voice'] as const;

export function isChannel(value: unknown): value is Channel {
  return channelSchema.safeParse(value).success;
}
