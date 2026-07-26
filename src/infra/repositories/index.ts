/**
 * index.ts (repositories)
 *
 * Punto unico de reexportacion de las implementaciones sobre Supabase de los
 * seis puertos de persistencia de `src/core/types/ports.ts`. Quien componga
 * las dependencias (fuera de esta rama) importa desde aqui, no de cada
 * archivo individual.
 */
export * from './clinic.repository.js';
export * from './patient.repository.js';
export * from './conversation.repository.js';
export * from './message.repository.js';
export * from './tool-call.repository.js';
export * from './audit.repository.js';

// Persistencia exclusiva del canal de voz. Sus puertos no viven en `ports.ts`
// —que es el contrato del nucleo, agnostico al canal— sino en
// `src/channels/voice/voice.types.ts`, del lado del consumidor.
export * from './call.repository.js';
export * from './transcript.repository.js';
