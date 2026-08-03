/**
 * Demo conversacional en la terminal.
 *
 * Levanta el NUCLEO REAL —prompt maestro, guardrails de tres capas, detector de
 * urgencia, las cinco herramientas y el orquestador del turno— y lo deja hablar
 * contigo por consola. Lo unico que necesita es `ANTHROPIC_API_KEY`.
 *
 * El montaje vive en `nucleo-demo.ts` y lo comparte con la web local
 * (`npm run demo:web`). Que es real y que no, esta documentado alli.
 *
 * Uso:  npm run demo          (estilo de texto)
 *       npm run demo -- --voz (estilo de voz)
 */
// La guia de puesta en marcha dice: pon la clave en .env y ejecuta `npm run
// demo`. Sin esto, el script no lee ese archivo y aborta pidiendo una clave que
// el usuario ya habia puesto.
import 'dotenv/config';

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import type { Channel } from '../src/core/types/index.js';
import { FaltaLaClaveError, montarNucleoDeDemostracion } from './nucleo-demo.js';

async function main(): Promise<void> {
  const canal: Channel = process.argv.includes('--voz') ? 'voice' : 'whatsapp';

  const nucleo = await montarNucleoDeDemostracion();
  const { servicio, clinica, rag, dobles, modelo, modeloClasificacion } = nucleo;

  const telefono = '+51987654321';

  console.log('\n' + '='.repeat(66));
  console.log(`  ${clinica.nombre} — demo del nucleo`);
  console.log('='.repeat(66));
  console.log(`  Canal: ${canal}${canal === 'whatsapp' ? '   (usa --voz para el estilo de voz)' : ''}`);
  console.log(`  Modelo: ${modelo}   ·   Clasificacion: ${modeloClasificacion}`);
  console.log(`  Base de conocimiento: ${rag.total} fragmentos (coincidencia de palabras)`);
  console.log(`  Paciente simulado: ${telefono}`);
  console.log('-'.repeat(66));
  console.log('  Datos FICTICIOS. Persistencia en memoria: al salir se pierde.');
  console.log('  Escribe "salir" para terminar.');
  console.log('='.repeat(66) + '\n');

  const rl = createInterface({ input: stdin, output: stdout });

  for (;;) {
    const texto = (await rl.question('Tu > ')).trim();
    if (texto.length === 0) continue;
    if (['salir', 'exit', 'quit'].includes(texto.toLowerCase())) break;

    try {
      const respuesta = await servicio.handleTurn({
        clinicId: clinica.id,
        patientPhoneE164: telefono,
        text: texto,
        channel: canal,
        receivedAt: new Date(),
      });

      console.log(`\nAgente > ${respuesta.text}`);

      if (respuesta.escalate) {
        console.log(
          `\n  [ESCALAMIENTO] motivo=${respuesta.escalate.reason} prioridad=${respuesta.escalate.priority}`,
        );
        console.log(`  resumen para recepcion: ${respuesta.escalate.summaryForAgent}`);
      }

      const llamadas = dobles.toolCalls.filas;
      if (llamadas.length > 0) {
        const ultimas = llamadas.slice(-3).map((l) => `${l.herramienta}:${l.estado}`);
        console.log(`  [herramientas] ${ultimas.join('  ')}`);
      }

      console.log(`  [${respuesta.latencyMs} ms]\n`);
    } catch (error) {
      console.error(`\n  Fallo el turno: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  rl.close();
  console.log('\nHasta luego.\n');
}

main().catch((error: unknown) => {
  if (error instanceof FaltaLaClaveError) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
