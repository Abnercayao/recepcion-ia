/**
 * supabase.client.ts
 *
 * Factoria del cliente de `@supabase/supabase-js` (v2) a partir de la
 * configuracion. Cliente unico y reutilizable: se crea una vez por proceso
 * (memoizado, igual que `getConfig()` en `./config.js`) y se inyecta en los
 * repositorios (`ClinicRepository`, `PatientRepository`, etc., puertos de
 * `src/core/types/ports.ts`), que no son responsabilidad de este archivo.
 *
 * ============================================================================
 * ADVERTENCIA DE SEGURIDAD — LEER ANTES DE ESCRIBIR CUALQUIER QUERY
 * ============================================================================
 * Este cliente se autentica con `SUPABASE_SERVICE_KEY` (la "service role
 * key"). Esa clave BYPASEA Row Level Security por diseno de Supabase: con
 * ella, una query ve TODAS las filas de TODAS las clinicas sin que importen
 * las politicas RLS de la migracion 002.
 *
 * Consecuencia directa: el aislamiento entre clinicas NO puede descansar en
 * RLS mientras se use esta clave (que es el caso de todo el backend, porque
 * es un servicio de confianza, no un cliente de navegador). CADA query hecha
 * con este cliente DEBE filtrar por `clinic_id` explicitamente en el codigo
 * de la aplicacion (`.eq('clinic_id', clinicId)` o equivalente). Un
 * `select('*')` sin ese filtro es una fuga de datos entre clinicas: viola el
 * control de aislamiento (C9 del informe etico) y es indistinguible de un
 * bug hasta que un paciente ve datos de otra clinica.
 *
 * Esta responsabilidad recae en quien escribe cada repositorio, no en este
 * archivo: este archivo solo fabrica el cliente. Se documenta aqui, de forma
 * prominente, porque es el punto de entrada que todos importan.
 * ============================================================================
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config.js';

/**
 * Alias con nombre propio para no acoplar el resto del codigo al generico de
 * la libreria (`SupabaseClient<Database>`). No se define un `Database`
 * generado (no hay tipos generados en este repo todavia): el generico por
 * defecto de la libreria se resuelve internamente sin que este archivo
 * introduzca ningun `any` propio.
 */
export type SupabaseAppClient = SupabaseClient;

/** Subconjunto de `Config` que este cliente necesita. */
export type SupabaseClientConfig = Pick<Config, 'SUPABASE_URL' | 'SUPABASE_SERVICE_KEY'>;

/**
 * Crea una instancia nueva del cliente. Normalmente no se llama directo:
 * usar `getSupabaseClient`, que memoiza una unica instancia reutilizable.
 * Abrir un cliente nuevo por request agotaria conexiones sin necesidad,
 * porque el cliente de supabase-js ya gestiona su propio pool interno.
 */
export function createSupabaseClient(config: SupabaseClientConfig): SupabaseAppClient {
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
    auth: {
      // Este cliente vive en el servidor y se autentica con la service key:
      // no hay sesion de usuario final que persistir ni token que refrescar.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

let cached: SupabaseAppClient | undefined;

/** Cliente unico del proceso, memoizado. Es el que deben importar los repositorios. */
export function getSupabaseClient(config: SupabaseClientConfig): SupabaseAppClient {
  cached ??= createSupabaseClient(config);
  return cached;
}

/** Solo para tests: fuerza la reconstruccion del cliente memoizado. */
export function resetSupabaseClientCache(): void {
  cached = undefined;
}
