/**
 * Configura el agente de ElevenLabs para razonar con un modelo ALOJADO por el
 * proveedor, en vez de con nuestro Custom LLM.
 *
 * Ver la cabecera de `src/channels/voice/webhook-tools.controller.ts` para lo
 * que se pierde en este modo. En resumen: desaparece la capa 2, que es la que
 * convierte las lineas rojas en un control. Lo que queda es que el modelo no
 * pueda HACER lo que quiera aunque pueda DECIR lo que quiera.
 *
 * Para volver al modo Custom LLM:
 *   npm run agente:alojado -- --revertir
 *
 * Uso:
 *   npm run agente:alojado -- --tunel https://xxx.trycloudflare.com
 *   npm run agente:alojado -- --tunel https://... --modelo qwen36-35b-a3b
 */
import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const RAIZ = resolve(import.meta.dirname, '..');
const AGENTE = process.env['ELEVENLABS_AGENT_ID'];
const KEY = process.env['ELEVENLABS_API_KEY'];
const SECRETO = process.env['VOICE_GATEWAY_SECRET'];
const CLINICA = process.env['CLINIC_ID'];

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function api(metodo: string, ruta: string, cuerpo?: unknown): Promise<Record<string, any>> {
  const r = await fetch(`https://api.elevenlabs.io${ruta}`, {
    method: metodo,
    headers: { 'xi-api-key': KEY!, 'content-type': 'application/json' },
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`${metodo} ${ruta} -> ${r.status}: ${texto.slice(0, 400)}`);
  return texto ? (JSON.parse(texto) as Record<string, any>) : {};
}

async function revertir(): Promise<void> {
  const respaldo = JSON.parse(
    await readFile(join(RAIZ, 'n8n', 'respaldo-agente-custom-llm.json'), 'utf8'),
  ) as Record<string, any>;
  const p = respaldo['conversation_config']['agent']['prompt'];
  await api('PATCH', `/v1/convai/agents/${AGENTE}`, {
    conversation_config: {
      agent: {
        prompt: {
          prompt: p['prompt'],
          llm: p['llm'],
          custom_llm: p['custom_llm'],
          tools: [],
          tool_ids: [],
        },
      },
    },
  });
  console.log('Revertido al modo Custom LLM: el nucleo vuelve a estar en el camino del turno.');
}

/**
 * Prompt para el modelo alojado.
 *
 * No es el mismo que usa el nucleo: alli el bloque 8 llega ya relleno con los
 * fragmentos del RAG y el 9 con las variables de sesion. Aqui el modelo tiene
 * que ir a buscarlos, asi que esos dos bloques se sustituyen por la
 * instruccion de usar las herramientas.
 */
async function construirPrompt(): Promise<string> {
  const maestro = await readFile(join(RAIZ, 'prompts', 'maestro.md'), 'utf8');
  const estilo = await readFile(join(RAIZ, 'prompts', 'estilo.voz.md'), 'utf8');

  const bloques = maestro.split(/^## /m).filter((b) => b.trim() !== '');
  // Se conservan los bloques 1-7 (identidad, prohibiciones, urgencia,
  // herramientas...) y se descartan el 8 (contexto RAG) y el 9 (sesion), que
  // en este modo no se pueden prerrellenar.
  const invariables = bloques
    .slice(0, 7)
    .map((b) => `## ${b.trim()}`)
    .join('\n\n');

  return [
    invariables,
    '## CONTEXTO APROBADO',
    'NO tienes el contexto delante. Antes de responder cualquier pregunta sobre',
    'la clinica -- precios, sedes, horarios, seguros, tratamientos, urgencias --',
    'DEBES llamar a `consultar_rag`. Lo que devuelva es lo unico que puedes',
    'afirmar. Si no devuelve nada, dices que no dispones del dato y ofreces',
    'escalar. NUNCA completas con conocimiento propio: no sabes nada de esta',
    'clinica que no venga de esa herramienta.',
    '',
    '## SESION',
    `Clinica: ${process.env['CLINIC_NAME'] ?? 'Clinica Aurora'}. Zona horaria America/Lima.`,
    'Pasa `session_id` en TODAS las llamadas a herramientas, con el mismo valor',
    'durante toda la conversacion, para que las citas y los avisos queden atados',
    'al mismo paciente.',
    '',
    '## ESTILO DE VOZ',
    estilo.trim(),
  ].join('\n');
}

async function main(): Promise<void> {
  if (!AGENTE || !KEY || !SECRETO || !CLINICA) {
    throw new Error(
      'Faltan ELEVENLABS_AGENT_ID, ELEVENLABS_API_KEY, VOICE_GATEWAY_SECRET o CLINIC_ID en el entorno.',
    );
  }

  if (process.argv.includes('--revertir')) {
    await revertir();
    return;
  }

  const tunel = arg('tunel');
  if (!tunel) throw new Error('Falta --tunel https://<dominio>');
  const modelo = arg('modelo') ?? 'qwen36-35b-a3b';

  const base = `${tunel.replace(/\/+$/, '')}/v1/g/${SECRETO}/c/${CLINICA}`;

  // Los esquemas salen del propio codigo, no se copian a mano: asi no pueden
  // desincronizarse de lo que las herramientas validan de verdad con Zod.
  const definiciones = (await (await fetch(`${base}/tools`)).json()) as {
    herramientas: Array<{ name: string; description: string; input_schema: Record<string, any> }>;
  };

  /**
   * ElevenLabs exige `description` en CADA propiedad del esquema, tambien en
   * las anidadas: sin ella responde 400. Los esquemas derivados de Zod no
   * siempre la llevan, asi que se rellena de forma recursiva. Se deja el
   * nombre de la propiedad como descripcion minima en vez de inventar
   * semantica que el codigo no declara.
   */
  const conDescripciones = (esquema: Record<string, any>, nombre = ''): Record<string, any> => {
    const salida: Record<string, any> = { ...esquema };
    if (salida['type'] !== 'object' && salida['type'] !== 'array' && !salida['description']) {
      salida['description'] = nombre || 'parametro';
    }
    if (salida['properties']) {
      salida['properties'] = Object.fromEntries(
        Object.entries(salida['properties'] as Record<string, any>).map(([k, v]) => [
          k,
          conDescripciones(v as Record<string, any>, k),
        ]),
      );
      if (!salida['description']) salida['description'] = nombre || 'objeto';
    }
    if (salida['items']) {
      salida['items'] = conDescripciones(salida['items'] as Record<string, any>, `${nombre} (elemento)`);
      if (!salida['description']) salida['description'] = nombre || 'lista';
    }
    return salida;
  };

  const tools = definiciones.herramientas.map((h) => {
    const originales = (h.input_schema['properties'] ?? {}) as Record<string, any>;
    const props: Record<string, any> = Object.fromEntries(
      Object.entries(originales).map(([k, v]) => [k, conDescripciones(v as Record<string, any>, k)]),
    );
    props['session_id'] = {
      type: 'string',
      description: 'Identificador de esta conversacion. El MISMO en todas las llamadas.',
    };
    return {
      type: 'webhook',
      name: h.name,
      description: h.description,
      response_timeout_secs: 20,
      api_schema: {
        url: `${base}/tools/${h.name}`,
        method: 'POST',
        request_body_schema: {
          type: 'object',
          properties: props,
          required: h.input_schema['required'] ?? [],
        },
      },
    };
  });

  await api('PATCH', `/v1/convai/agents/${AGENTE}`, {
    conversation_config: {
      agent: {
        prompt: {
          prompt: await construirPrompt(),
          llm: modelo,
          custom_llm: null,
          tools,
        },
      },
    },
  });

  const a = await api('GET', `/v1/convai/agents/${AGENTE}`);
  const p = a['conversation_config']['agent']['prompt'];
  console.log(`llm            : ${p['llm']}`);
  console.log(`custom_llm     : ${p['custom_llm'] ? 'si' : 'no (el nucleo NO esta en el camino)'}`);
  console.log(`prompt         : ${String(p['prompt']).length} caracteres`);
  console.log(`herramientas   : ${(p['tools'] ?? []).map((t: any) => t.name).join(', ') || 'ninguna'}`);
  console.log('\nSIN capa 2: el texto del modelo va directo a voz sin pasar por checkOutbound.');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
