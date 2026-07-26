/**
 * DIAGNOSTICO DE INTEGRACIONES.
 *
 * Comprueba, una por una, que cada proveedor externo responde de verdad. Hasta
 * ahora todo el proyecto se ha verificado con dobles: esto es lo que empieza a
 * cerrar el hueco que `docs/ESTADO.md` describe como «ninguna llamada real».
 *
 * ES DE SOLO LECTURA. No crea ni modifica nada en ningun proveedor: no ejecuta
 * migraciones, no siembra datos, no escribe filas, no crea eventos de agenda ni
 * envia mensajes. Lo mas «caro» que hace es pedirle al modelo unos pocos tokens
 * y calcular un embedding de una frase. Se puede ejecutar tantas veces como
 * haga falta sin dejar rastro.
 *
 *   npm run diagnostico
 *   npm run diagnostico -- --solo anthropic,voyage
 *   npm run diagnostico -- --listar
 *
 * Cada etapa es independiente: que falle Supabase no impide comprobar el
 * modelo. Al final se resume que esta verificado y que no, porque «no
 * configurado» y «roto» son cosas distintas y conviene no confundirlas.
 */
import 'dotenv/config';

import { Client as ClientePg } from 'pg';

import { loadConfig, ConfigError, type Config } from '../src/infra/config.js';
import { createLogger } from '../src/infra/logger.js';
import { createSupabaseClient } from '../src/infra/supabase.client.js';
import { parseGoogleCredentials } from '../src/infra/calendar.client.js';
import { ClaudeService } from '../src/core/claude/claude.service.js';
import { VoyageEmbeddingService } from '../src/core/rag/embedding.service.js';

type Estado = 'ok' | 'fallo' | 'omitido';

interface Resultado {
  estado: Estado;
  detalle: string[];
}

interface Etapa {
  nombre: string;
  titulo: string;
  ejecutar: (config: Config) => Promise<Resultado>;
}

const TIEMPO_MAXIMO_MS = 30_000;

/** Las 11 tablas que crean las migraciones 001-003. */
const TABLAS = [
  'clinics', 'patients', 'conversations', 'messages', 'calls', 'transcripts',
  'audio_events', 'tool_calls', 'latency_metrics', 'knowledge_chunks', 'audit_log',
];

// ---------------------------------------------------------------------------
// Presentacion
// ---------------------------------------------------------------------------

const MARCA: Record<Estado, string> = { ok: '✓', fallo: '✗', omitido: '·' };

const ok = (...detalle: string[]): Resultado => ({ estado: 'ok', detalle });
const fallo = (...detalle: string[]): Resultado => ({ estado: 'fallo', detalle });
const omitido = (...detalle: string[]): Resultado => ({ estado: 'omitido', detalle });

/** Nunca se imprime un secreto: solo si esta y cuanto mide. */
const presencia = (valor: string | undefined, etiqueta: string): string =>
  valor ? `${etiqueta}: presente (${valor.length} caracteres)` : `${etiqueta}: AUSENTE`;

const mensajeDeError = (e: unknown): string => {
  if (e instanceof Error) {
    // Los SDK cuelgan el cuerpo de la respuesta en propiedades no tipadas;
    // ahi suele estar la causa real (clave invalida, cuota, region).
    const extra = (e as { status?: number; code?: string }).status
      ?? (e as { code?: string }).code;
    return extra ? `${e.message} [${extra}]` : e.message;
  }
  return String(e);
};

function conLimiteDeTiempo<T>(promesa: Promise<T>, ms: number, que: string): Promise<T> {
  return Promise.race([
    promesa,
    new Promise<never>((_, rechazar) =>
      setTimeout(() => rechazar(new Error(`sin respuesta en ${ms / 1000} s: ${que}`)), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Etapas
// ---------------------------------------------------------------------------

const ETAPAS: Etapa[] = [
  {
    nombre: 'anthropic',
    titulo: 'Anthropic — el modelo, que es el cerebro de ambos canales',
    async ejecutar(config) {
      const logger = createLogger(config);
      const claude = new ClaudeService({
        config: {
          apiKey: config.ANTHROPIC_API_KEY,
          modelPorDefecto: config.CLAUDE_MODEL_CONVERSACION,
          maxTokens: 16,
          temperature: config.CLAUDE_TEMPERATURE,
        },
        logger,
      });

      const detalle: string[] = [];
      for (const [papel, modelo] of [
        ['conversacion', config.CLAUDE_MODEL_CONVERSACION],
        ['clasificacion', config.CLAUDE_MODEL_CLASIFICACION],
      ] as const) {
        const empezado = Date.now();
        const respuesta = await conLimiteDeTiempo(
          claude.complete({
            system: 'Responde exactamente con la palabra: listo',
            messages: [{ role: 'user', content: 'di listo' }],
            model: modelo,
            maxTokens: 16,
          }),
          TIEMPO_MAXIMO_MS,
          `modelo de ${papel}`,
        );
        const texto = respuesta.text.trim().slice(0, 40);
        detalle.push(`${papel}: ${modelo} respondio en ${Date.now() - empezado} ms — «${texto}»`);
      }
      return ok(...detalle);
    },
  },

  {
    nombre: 'voyage',
    titulo: 'Voyage — embeddings, sin los que el RAG no recupera nada',
    async ejecutar(config) {
      if (!config.VOYAGE_API_KEY) {
        return omitido('VOYAGE_API_KEY ausente: el RAG no puede funcionar sin ella');
      }
      const embeddings = new VoyageEmbeddingService({
        apiKey: config.VOYAGE_API_KEY,
        model: config.EMBEDDING_MODEL,
        dimensions: config.EMBEDDING_DIMENSIONS,
      });

      const empezado = Date.now();
      const vectores = await conLimiteDeTiempo(
        embeddings.embed(['¿cuanto cuesta una limpieza dental?'], 'query'),
        TIEMPO_MAXIMO_MS,
        'embeddings',
      );
      const dimensiones = vectores[0]?.length ?? 0;
      const detalle = [
        `${config.EMBEDDING_MODEL} respondio en ${Date.now() - empezado} ms`,
        `vector de ${dimensiones} dimensiones`,
      ];

      // Si las dimensiones no cuadran con la columna `vector(n)` de la
      // migracion, las inserciones fallaran mas tarde y en otro sitio.
      if (dimensiones !== config.EMBEDDING_DIMENSIONS) {
        return fallo(
          ...detalle,
          `DESAJUSTE: EMBEDDING_DIMENSIONS=${config.EMBEDDING_DIMENSIONS} pero el proveedor devuelve ${dimensiones}`,
          'la columna vector(n) de knowledge_chunks rechazara las inserciones',
        );
      }
      return ok(...detalle, `coincide con EMBEDDING_DIMENSIONS=${config.EMBEDDING_DIMENSIONS}`);
    },
  },

  {
    nombre: 'supabase-api',
    titulo: 'Supabase — acceso por API REST y presencia de las 11 tablas',
    async ejecutar(config) {
      const supabase = createSupabaseClient(config);
      const detalle: string[] = [];
      const ausentes: string[] = [];

      for (const tabla of TABLAS) {
        // `head: true` con `count` no descarga ni una fila: solo pregunta
        // cuantas hay. Es la comprobacion mas barata de que la tabla existe y
        // de que la clave tiene permiso para leerla.
        const { count, error } = await conLimiteDeTiempo(
          Promise.resolve(supabase.from(tabla).select('*', { count: 'exact', head: true })),
          TIEMPO_MAXIMO_MS,
          `tabla ${tabla}`,
        );
        if (error) ausentes.push(`${tabla} (${error.message})`);
        else detalle.push(`${tabla}: ${count ?? 0} filas`);
      }

      if (ausentes.length > 0) {
        return fallo(
          ...detalle,
          `NO accesibles: ${ausentes.join(', ')}`,
          'si la base esta vacia, faltan las migraciones: `npm run db:migrate`',
        );
      }
      return ok(...detalle);
    },
  },

  {
    nombre: 'supabase-db',
    titulo: 'Supabase — conexion directa, RLS y extension vectorial',
    async ejecutar(config) {
      if (!config.SUPABASE_DB_URL) {
        return omitido('SUPABASE_DB_URL ausente: sin ella no se pueden ejecutar migraciones');
      }
      const cliente = new ClientePg({ connectionString: config.SUPABASE_DB_URL });
      try {
        await conLimiteDeTiempo(cliente.connect(), TIEMPO_MAXIMO_MS, 'conexion a Postgres');
        const detalle: string[] = [];

        const version = await cliente.query<{ version: string }>('select version()');
        detalle.push((version.rows[0]?.version ?? '').split(' ').slice(0, 2).join(' '));

        const vector = await cliente.query<{ extname: string }>(
          "select extname from pg_extension where extname = 'vector'",
        );
        detalle.push(vector.rowCount ? 'extension `vector` instalada' : 'extension `vector` AUSENTE');

        // El aislamiento entre clinicas (control C9) descansa en RLS. Que la
        // tabla exista no dice nada; lo que importa es si tiene RLS activo y
        // politicas encima.
        const rls = await cliente.query<{ tabla: string; activo: boolean; politicas: string }>(
          `select c.relname as tabla,
                  c.relrowsecurity as activo,
                  count(p.polname)::text as politicas
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
             left join pg_policy p on p.polrelid = c.oid
            where n.nspname = 'public' and c.relkind = 'r'
            group by c.relname, c.relrowsecurity
            order by c.relname`,
        );

        const sinRls = rls.rows.filter((r) => !r.activo).map((r) => r.tabla);
        const sinPoliticas = rls.rows.filter((r) => r.activo && r.politicas === '0').map((r) => r.tabla);
        detalle.push(`${rls.rowCount} tablas en el esquema public`);
        detalle.push(`con RLS activo: ${rls.rows.filter((r) => r.activo).length}`);

        if (rls.rowCount === 0) {
          return fallo(...detalle, 'la base esta vacia: faltan las migraciones (`npm run db:migrate`)');
        }
        if (sinRls.length > 0 || sinPoliticas.length > 0) {
          return fallo(
            ...detalle,
            sinRls.length ? `SIN RLS: ${sinRls.join(', ')}` : '',
            sinPoliticas.length ? `con RLS pero SIN POLITICAS: ${sinPoliticas.join(', ')}` : '',
            'el aislamiento entre clinicas (control C9) no esta garantizado',
          );
        }
        return ok(...detalle, 'todas las tablas con RLS y al menos una politica');
      } finally {
        await cliente.end().catch(() => undefined);
      }
    },
  },

  {
    nombre: 'calendar',
    titulo: 'Google Calendar — credenciales de cuenta de servicio',
    async ejecutar(config) {
      if (!config.GOOGLE_CALENDAR_CREDENTIALS) {
        return omitido(
          'GOOGLE_CALENDAR_CREDENTIALS ausente',
          'sin esto `crear_cita` y `consultar_agenda` no pueden funcionar contra la agenda real',
        );
      }
      const credenciales = parseGoogleCredentials(config.GOOGLE_CALENDAR_CREDENTIALS);
      return ok(`cuenta de servicio: ${credenciales.client_email}`, 'credenciales bien formadas');
    },
  },

  {
    nombre: 'whatsapp',
    titulo: 'WhatsApp — canal de texto',
    async ejecutar(config) {
      if (!config.WHATSAPP_ENABLED) {
        return omitido('WHATSAPP_ENABLED=false: el canal esta apagado a proposito');
      }
      const respuesta = await conLimiteDeTiempo(
        fetch(`https://graph.facebook.com/v21.0/${config.WHATSAPP_PHONE_ID}`, {
          headers: { Authorization: `Bearer ${config.WHATSAPP_BSP_TOKEN}` },
        }),
        TIEMPO_MAXIMO_MS,
        'Graph API de Meta',
      );
      if (!respuesta.ok) {
        return fallo(`Graph API respondio ${respuesta.status}`, await respuesta.text().catch(() => ''));
      }
      const cuerpo = (await respuesta.json()) as { display_phone_number?: string };
      return ok(`numero verificado: ${cuerpo.display_phone_number ?? '(sin nombre)'}`);
    },
  },

  {
    nombre: 'elevenlabs',
    titulo: 'ElevenLabs — canal de voz',
    async ejecutar(config) {
      if (!config.VOICE_ENABLED) {
        return omitido(
          'VOICE_ENABLED=false: el canal esta apagado a proposito',
          'recuerda que docs/ESTADO.md condiciona el despliegue de voz a la auditoria de equidad del reconocimiento del habla',
        );
      }
      const respuesta = await conLimiteDeTiempo(
        fetch('https://api.elevenlabs.io/v1/user', {
          headers: { 'xi-api-key': config.ELEVENLABS_API_KEY ?? '' },
        }),
        TIEMPO_MAXIMO_MS,
        'API de ElevenLabs',
      );
      if (!respuesta.ok) return fallo(`la API respondio ${respuesta.status}`);
      return ok('clave valida');
    },
  },
];

// ---------------------------------------------------------------------------
// Ejecucion
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argumentos = process.argv.slice(2);

  if (argumentos.includes('--listar')) {
    process.stdout.write(ETAPAS.map((e) => `  ${e.nombre.padEnd(14)} ${e.titulo}`).join('\n') + '\n');
    return;
  }

  const indiceSolo = argumentos.indexOf('--solo');
  const pedidas = indiceSolo >= 0 && argumentos[indiceSolo + 1]
    ? new Set(argumentos[indiceSolo + 1]?.split(',').map((s) => s.trim()))
    : null;

  let config: Config;
  try {
    config = loadConfig();
  } catch (e) {
    const detalle = e instanceof ConfigError ? e.message : mensajeDeError(e);
    process.stdout.write(`✗ configuracion\n    ${detalle.split('\n').join('\n    ')}\n`);
    process.stdout.write('\nEl sistema no arranca sin entorno valido. Nada mas se ha comprobado.\n');
    process.exitCode = 1;
    return;
  }

  process.stdout.write('DIAGNOSTICO DE INTEGRACIONES · solo lectura\n\n');
  process.stdout.write('✓ configuracion\n');
  for (const linea of [
    presencia(config.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY'),
    presencia(config.VOYAGE_API_KEY, 'VOYAGE_API_KEY'),
    presencia(config.SUPABASE_SERVICE_KEY, 'SUPABASE_SERVICE_KEY'),
    presencia(config.SUPABASE_DB_URL, 'SUPABASE_DB_URL'),
    `canal de voz: ${config.VOICE_ENABLED ? 'habilitado' : 'apagado'} · WhatsApp: ${config.WHATSAPP_ENABLED ? 'habilitado' : 'apagado'}`,
  ]) {
    process.stdout.write(`    ${linea}\n`);
  }
  process.stdout.write('\n');

  const resultados: Array<{ etapa: Etapa; resultado: Resultado }> = [];

  for (const etapa of ETAPAS) {
    if (pedidas && !pedidas.has(etapa.nombre)) continue;
    let resultado: Resultado;
    try {
      resultado = await etapa.ejecutar(config);
    } catch (e) {
      resultado = fallo(mensajeDeError(e));
    }
    resultados.push({ etapa, resultado });

    process.stdout.write(`${MARCA[resultado.estado]} ${etapa.nombre} — ${etapa.titulo}\n`);
    for (const linea of resultado.detalle.filter(Boolean)) {
      process.stdout.write(`    ${linea}\n`);
    }
    process.stdout.write('\n');
  }

  const fallos = resultados.filter((r) => r.resultado.estado === 'fallo');
  const omitidas = resultados.filter((r) => r.resultado.estado === 'omitido');
  const correctas = resultados.filter((r) => r.resultado.estado === 'ok');

  process.stdout.write('RESUMEN\n');
  process.stdout.write(`  verificado contra el proveedor real: ${correctas.map((r) => r.etapa.nombre).join(', ') || '—'}\n`);
  process.stdout.write(`  sin configurar todavia: ${omitidas.map((r) => r.etapa.nombre).join(', ') || '—'}\n`);
  process.stdout.write(`  con fallo: ${fallos.map((r) => r.etapa.nombre).join(', ') || '—'}\n`);

  if (fallos.length > 0) process.exitCode = 1;
}

await main();
