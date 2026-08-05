/**
 * Guardrails del agente de voz: recupera en modo ALOJADO el control que hoy no
 * existe alli.
 *
 * ------------------------------------------------------------------------
 * POR QUE ESTE ARCHIVO EXISTE
 *
 * `docs/CONTINUAR.md` afirmaba que el proveedor "no ofrece ningun mecanismo
 * para inspeccionar el texto antes de sintetizarlo, asi que la capa 2 no puede
 * existir en ese modo". Era cierto cuando se comprobo; ya no lo es. Guardrails
 * 2.0 incluye VALIDADORES DE RESPUESTA que evaluan cada contestacion del
 * agente y la bloquean antes de entregarla.
 *
 * Es decir: el sistema llevaba en modo alojado sin capa 2 pudiendo tenerla.
 * Este script la pone.
 *
 * ------------------------------------------------------------------------
 * EN QUE SE PARECE Y EN QUE NO A NUESTRA CAPA 2
 *
 * `src/core/claude/guardrails.ts` es DETERMINISTA: mismas entradas, mismo
 * veredicto, y sustituye la frase por una respuesta canonica escrita por
 * nosotros. Estos guardrails son un JUEZ LLM y sus salidas son distintas:
 *
 *   · No sustituyen texto. Solo pueden CORTAR LA LLAMADA (`end_call`) o
 *     REGENERAR la respuesta (`retry`, hasta tres intentos).
 *   · `retry` exige modo BLOQUEANTE, que anade 200-500 ms por turno.
 *   · En modo streaming no hay retry y pueden colarse ~500 ms de audio antes
 *     del bloqueo.
 *
 * DECISION: modo BLOQUEANTE con `retry`. Colgarle el telefono a un paciente
 * porque el modelo solto un precio es peor que hacerle esperar medio segundo,
 * y regenerar se parece mucho mas a lo que hace nuestra capa 2 (sustituir)
 * que colgar. El coste de latencia esta aceptado y anotado.
 *
 * NO SUSTITUYE a la capa 2 del nucleo: en modo Custom LLM esa sigue siendo la
 * buena. Esto cubre el modo alojado, que hasta ahora no tenia nada.
 *
 * Uso:
 *   npm run agente:guardrails            # aplica
 *   npm run agente:guardrails -- --ver   # solo muestra lo que hay
 */
import 'dotenv/config';

const AGENTE = process.env['ELEVENLABS_AGENT_ID'];
const KEY = process.env['ELEVENLABS_API_KEY'];

/**
 * Temperatura del modelo de voz.
 *
 * El agente venia con 1.0. El nucleo usa 0.3, y no por gusto: una recepcion
 * clinica no debe ser creativa. Con 1.0 se midieron horarios inventados y
 * respuestas que se iban del guion.
 */
const TEMPERATURA = 0.3;

async function api(metodo: string, ruta: string, cuerpo?: unknown): Promise<Record<string, any>> {
  const r = await fetch(`https://api.elevenlabs.io${ruta}`, {
    method: metodo,
    headers: { 'xi-api-key': KEY!, 'content-type': 'application/json' },
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`${metodo} ${ruta} -> ${r.status}: ${texto.slice(0, 500)}`);
  return texto ? (JSON.parse(texto) as Record<string, any>) : {};
}

/**
 * Las cinco lineas rojas, traducidas a reglas en lenguaje natural.
 *
 * Son las MISMAS que vigila `detectOutboundViolations`. Se escriben aqui en
 * prosa porque el juez es un modelo, no una regex; el criterio no cambia.
 *
 * Cada regla dice lo que NO se puede decir Y lo que si es aceptable, porque un
 * juez que solo conoce la prohibicion bloquea de mas: la respuesta canonica
 * del propio sistema ("el precio final depende de la valoracion") menciona
 * precios, y sin la excepcion la bloquearia.
 */
const REGLAS: Array<{ name: string; prompt: string }> = [
  {
    name: 'sin_diagnostico',
    prompt:
      'Eres el control de una recepcionista virtual de una clinica dental. BLOQUEA la respuesta si ' +
      'diagnostica, interpreta sintomas, evalua gravedad, nombra una patologia como si la padeciera ' +
      'el paciente, o recomienda un tratamiento concreto para su caso. Tambien si sugiere medicacion ' +
      'o remedios caseros. NO bloquees si se limita a describir tratamientos en general, a decir que ' +
      'eso lo valora el profesional en consulta, o a ofrecer una cita.',
  },
  {
    name: 'sin_precio_cerrado',
    prompt:
      'BLOQUEA la respuesta si da un precio CERRADO y definitivo de un tratamiento que requiere ' +
      'valoracion profesional. NO bloquees si da un RANGO de referencia y ademas menciona que el ' +
      'precio final depende de la valoracion del profesional. NO bloquees el precio de la consulta ' +
      'de evaluacion, que si es fijo.',
  },
  {
    name: 'nunca_es_humano',
    prompt:
      'BLOQUEA la respuesta si el agente afirma ser una persona, o niega ser un asistente virtual, ' +
      'o se presenta como recepcionista humana, doctora o empleada de carne y hueso. NO bloquees si ' +
      'dice con naturalidad que es un asistente virtual, ni si simplemente da su nombre.',
  },
  {
    name: 'sin_promesa_de_resultado',
    prompt:
      'BLOQUEA la respuesta si promete un resultado, garantiza que no habra dolor, asegura un plazo ' +
      'de recuperacion o afirma que el tratamiento quedara perfecto. NO bloquees si describe lo que ' +
      'suele ocurrir remitiendo a la valoracion del profesional.',
  },
  {
    name: 'sin_cita_no_confirmada',
    prompt:
      'BLOQUEA la respuesta si afirma que una cita YA quedo agendada, reservada o confirmada sin que ' +
      'en esta conversacion se haya ejecutado con exito la herramienta crear_cita. NO bloquees si ' +
      'OFRECE agendar, si pregunta por una fecha, o si confirma una cita que la herramienta acaba de ' +
      'crear correctamente.',
  },
  {
    name: 'sin_datos_inventados',
    prompt:
      'BLOQUEA la respuesta si afirma datos de la clinica que no le han sido entregados: numero de ' +
      'sedes distinto del que conoce, direcciones, telefonos, nombres de profesionales, coberturas de ' +
      'seguro concretas u horarios que no vengan de sus herramientas o de su contexto. Es especialmente ' +
      'grave afirmar que la clinica tiene una sola sede. NO bloquees si reconoce que no tiene el dato y ' +
      'ofrece confirmarlo con recepcion.',
  },
];

async function main(): Promise<void> {
  if (!AGENTE || !KEY) {
    throw new Error('Faltan ELEVENLABS_AGENT_ID o ELEVENLABS_API_KEY en el entorno.');
  }

  if (process.argv.includes('--ver')) {
    const a = await api('GET', `/v1/convai/agents/${AGENTE}`);
    const g = a['platform_settings']['guardrails'];
    console.log(`temperatura      : ${a['conversation_config']['agent']['prompt']['temperature']}`);
    console.log(`focus            : ${g['focus']?.['is_enabled']}`);
    console.log(`prompt_injection : ${g['prompt_injection']?.['is_enabled']}`);
    console.log(`modo de ejecucion: ${g['content']?.['execution_mode']}`);
    console.log(`accion al saltar : ${g['content']?.['trigger_action']?.['type']}`);
    const custom = (g['custom']?.['config']?.['configs'] ?? []) as Array<{ name: string }>;
    console.log(`personalizados   : ${custom.map((c) => c.name).join(', ') || 'ninguno'}`);
    return;
  }

  const antes = await api('GET', `/v1/convai/agents/${AGENTE}`);
  const contenido = antes['platform_settings']['guardrails']['content'];

  await api('PATCH', `/v1/convai/agents/${AGENTE}`, {
    conversation_config: {
      agent: { prompt: { temperature: TEMPERATURA } },
    },
    platform_settings: {
      guardrails: {
        version: '1',
        // Mantiene al agente en su asunto. Una recepcion clinica que se pone a
        // hablar de otra cosa es, ademas de raro, superficie de ataque.
        focus: { is_enabled: true },
        // Control C9 del informe: inyeccion indirecta. Estaba apagado teniendo
        // el control documentado.
        prompt_injection: { is_enabled: true },
        content: {
          ...contenido,
          // BLOQUEANTE, no streaming: es lo unico que permite `retry`.
          // Regenerar se parece a sustituir; colgar, no.
          execution_mode: 'blocking',
          trigger_action: { type: 'retry' },
          config: {
            ...contenido['config'],
            self_harm: { is_enabled: true, threshold: 'low' },
            sexual: { is_enabled: true, threshold: 'medium' },
            violence: { is_enabled: true, threshold: 'medium' },
            harassment: { is_enabled: true, threshold: 'medium' },
            // El mas importante del dominio: informacion medica y legal. Es la
            // categoria que cubre "nunca diagnosticar" desde la plataforma.
            medical_and_legal_information: { is_enabled: true, threshold: 'low' },
          },
        },
        custom: {
          config: {
            configs: REGLAS.map((r) => ({
              name: r.name,
              prompt: r.prompt,
              model: 'gemini-2.5-flash-lite',
              execution_mode: 'blocking',
            })),
          },
        },
      },
    },
  });

  const a = await api('GET', `/v1/convai/agents/${AGENTE}`);
  const g = a['platform_settings']['guardrails'];
  const custom = (g['custom']?.['config']?.['configs'] ?? []) as Array<{ name: string }>;

  console.log(`temperatura      : ${a['conversation_config']['agent']['prompt']['temperature']}`);
  console.log(`focus            : ${g['focus']?.['is_enabled']}`);
  console.log(`prompt_injection : ${g['prompt_injection']?.['is_enabled']}`);
  console.log(`modo de ejecucion: ${g['content']?.['execution_mode']}`);
  console.log(`accion al saltar : ${g['content']?.['trigger_action']?.['type']}`);
  console.log(`personalizados   : ${custom.map((c) => c.name).join(', ') || 'ninguno'}`);
  console.log(
    '\nModo bloqueante: anade 200-500 ms por turno. Es el precio de poder REGENERAR\n' +
      'en vez de colgarle el telefono al paciente.',
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
