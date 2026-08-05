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

import { renderizarProfesionales, renderizarSedes } from '../src/core/claude/prompt.builder.js';
import { clinicaDeLaSemilla } from './nucleo-demo.js';

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
  // Las sedes se leen de la MISMA semilla que alimenta a Supabase y se
  // renderizan con la MISMA funcion que usa el nucleo. Si divergieran, el
  // defecto de "8 sedes de 24" quedaria arreglado en texto y vivo en voz.
  const clinica = await clinicaDeLaSemilla();

  const bloques = maestro.split(/^## /m).filter((b) => b.trim() !== '');
  // Se conservan los bloques 1-7 (identidad, prohibiciones, urgencia,
  // herramientas...) y se descartan el 8 (contexto RAG) y el 9 (sesion), que
  // en este modo no se pueden prerrellenar.
  //
  // `{{clinica_nombre}}` SI se sustituye aqui: es un marcador del prompt
  // maestro que este modo no rellenaba, asi que viajaba literal al proveedor.
  // ElevenLabs intenta resolver los `{{...}}` contra sus variables dinamicas y
  // esa no existe, de modo que el agente podia acabar diciendole el marcador al
  // paciente.
  const invariables = bloques
    .slice(0, 7)
    .map((b) => `## ${b.trim()}`)
    .join('\n\n')
    .replaceAll('{{clinica_nombre}}', clinica.nombre);

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
    `Clinica: ${clinica.nombre}. Zona horaria ${clinica.timezone}.`,
    '',
    /**
     * LA FECHA, POR VARIABLE DINAMICA.
     *
     * No se puede escribir aqui: este prompt se publica UNA vez y se queda
     * fijo, asi que una fecha literal caducaria al dia siguiente. `{{...}}` lo
     * resuelve ElevenLabs en CADA conversacion con lo que le devuelve el
     * webhook de iniciacion (llamadas) o con lo que trae el widget (web).
     *
     * Sin esto el agente no sabia en que dia vivia y lo deducia de su
     * entrenamiento: un martes 4 de agosto afirmaba que "manana" era el 6 y
     * que el viernes era el 8. Todo corrido un dia.
     */
    // El numero desde el que llaman. Sin el, el agente no puede cumplir el
    // paso 1 del cierre --confirmar a que numero se manda todo-- y acabaria
    // pidiendoselo a alguien que ya nos lo esta dando por el propio canal.
    'NUMERO DESDE EL QUE LLAMA EL PACIENTE: {{phone}}',
    'Usalo para confirmar a que numero se manda la informacion. Si viene vacio o no',
    'parece un numero, pideselo al paciente en vez de inventarlo o de leerlo tal cual.',
    '',
    'FECHA Y HORA ACTUALES: {{fecha_y_hora}}',
    'Esa linea es la UNICA fuente valida para saber en que dia estas. No deduzcas',
    'la fecha de hoy, ni el dia de la semana, ni que dia cae "manana" o "el viernes":',
    'usa los dias ya calculados que aparecen ahi. Si te falta ese dato, preguntale al',
    'paciente la fecha concreta en vez de suponerla.',
    'Pasa `session_id` en TODAS las llamadas a herramientas, con el mismo valor',
    'durante toda la conversacion, para que las citas y los avisos queden atados',
    'al mismo paciente.',
    '',
    // Excepcion DECLARADA al parrafo de arriba: ahi se dice que nada se afirma
    // sin pasar por `consultar_rag`. Las sedes son la excepcion, y es
    // deliberado: es un censo cerrado, y hacerlo depender de una busqueda es
    // justo lo que producia la respuesta con 8 sedes de 24.
    renderizarSedes(clinica.config),
    '',
    // Elegir doctor es OPCIONAL. Se ofrece para que la conversacion suene a
    // recepcion de verdad, nunca como requisito para agendar.
    renderizarProfesionales(clinica.config),
    '',
    '## ESTILO DE VOZ',
    estilo.trim(),
  ].join('\n');
}

/**
 * Compara el prompt VIVO del agente con el que produce este repositorio.
 *
 * Existe por un fallo real y caro: se reparo el defecto de las sedes en el
 * codigo, paso las pruebas, quedo bien por texto... y por VOZ siguio roto una
 * semana, porque publicar en ElevenLabs es un paso manual que nadie ejecuto. El
 * repositorio y el agente son dos fuentes de verdad y no hay nada que las ate.
 *
 * Esto no las ata --sigue haciendo falta publicar-- pero convierte un desfase
 * silencioso en una linea de consola. Es barato y se puede correr antes de una
 * demostracion.
 *
 * Uso:  npm run agente:alojado -- --verificar
 */
async function verificar(): Promise<void> {
  const agente = await api('GET', `/v1/convai/agents/${AGENTE}`);
  const vivo = String(agente['conversation_config']['agent']['prompt']['prompt'] ?? '');
  const esperado = await construirPrompt();

  // El prompt lleva la URL del tunel dentro de las herramientas, no del texto,
  // asi que comparar el texto es estable entre reinicios del tunel.
  if (vivo === esperado) {
    console.log('El prompt del agente coincide con el del repositorio.');
  } else {
    console.error(
      `DESFASE: el agente NO tiene el prompt de este repositorio.\n` +
        `  vivo      : ${String(vivo.length)} caracteres\n` +
        `  repositorio: ${String(esperado.length)} caracteres\n\n` +
        'Publica con:  npm run agente:alojado -- --tunel https://<dominio>',
    );
  }

  // Las sedes se comprueban aparte porque son el caso que ya fallo: si faltan,
  // el agente contesta con las que le devuelva el RAG, que pueden ser 8 de 24.
  const clinica = await clinicaDeLaSemilla();
  const sedes = renderizarSedes(clinica.config);
  const faltan = vivo.includes(sedes) ? [] : ['la lista completa de sedes'];
  if (faltan.length > 0) {
    console.error(`  Falta ademas en el agente: ${faltan.join(', ')}.`);
  }

  // Se informa de la voz pero NO se toca: este script no la configura, y si
  // alguna vez lo hiciera, un despliegue de prompt podria pisar el acento.
  const tts = agente['conversation_config']['tts'] as Record<string, unknown>;
  console.log(
    `voz            : ${String(tts['voice_id'])} · ${String(tts['model_id'])} · ` +
      `stability ${String(tts['stability'])} · expressive ${String(tts['expressive_mode'])} · ` +
      `optimize_streaming_latency ${String(tts['optimize_streaming_latency'])}`,
  );

  if (vivo !== esperado) process.exitCode = 1;
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

  if (process.argv.includes('--verificar')) {
    await verificar();
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
        /**
         * El saludo NO anuncia que es un asistente virtual.
         *
         * Decision del titular: quien llama ya lo sabe por el numero al que
         * marca, y repetirlo en cada llamada suena a robot. La linea roja
         * sigue en pie --si le preguntan, nunca dice ser una persona-- pero el
         * criterio de aceptacion §7 ("conversaciones con revelacion ejecutada
         * = 100%") deja de cumplirse a proposito. Queda dicho en
         * docs/CONTINUAR.md.
         */
        first_message: `${(await clinicaDeLaSemilla()).nombre}, buenas. ¿Con quién tengo el gusto?`,
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
