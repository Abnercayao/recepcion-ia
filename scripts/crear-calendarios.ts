/**
 * Un calendario de Google POR SEDE.
 *
 * `CalendarPort` ya lleva `sede` y el cliente resuelve el calendario con
 * `clinic.config.calendarios_por_sede`. Pero ese mapa estaba VACIO, asi que
 * las 40 sedes seguian cayendo al calendario general: que Comas estuviera
 * lleno hacia parecer lleno a Miraflores. El codigo estaba listo; faltaban los
 * calendarios.
 *
 * Este script los crea y escribe el mapa en `clinica.json`. Es idempotente:
 * reutiliza el que ya exista con el mismo nombre en vez de crear otro.
 *
 * ⚠ QUIEN VE ESTOS CALENDARIOS. Los crea la CUENTA DE SERVICIO, asi que nacen
 * en su lista, no en la de nadie del equipo. Para que recepcion los vea en su
 * Google Calendar hay que compartirlos con sus correos: `--compartir-con
 * a@clinica.pe,b@clinica.pe`. Sin eso el sistema funciona pero las citas son
 * invisibles para las personas, que es peor que no separarlas.
 *
 * Uso:
 *   npm run cal:sedes -- --dry-run
 *   npm run cal:sedes
 *   npm run cal:sedes -- --compartir-con recepcion@clinica.pe
 */
import 'dotenv/config';

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { google } from 'googleapis';

import { parseGoogleCredentials } from '../src/infra/calendar.client.js';

const RAIZ = resolve(import.meta.dirname, '..');
const RUTA = join(RAIZ, 'db', 'seed', 'clinica-demo', 'clinica.json');

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Mismo criterio que el cliente y las herramientas. */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function main(): Promise<void> {
  const crudo = JSON.parse(await readFile(RUTA, 'utf8')) as {
    nombre: string;
    config: Record<string, any>;
  };
  const config = crudo.config;

  const sedes = [
    ...Object.keys((config['sedes_informativas'] ?? {}) as Record<string, string>),
    ...Object.keys((config['sedes_franquicia'] ?? {}) as Record<string, string>),
  ];
  const yaMapeadas = (config['calendarios_por_sede'] ?? {}) as Record<string, string>;

  console.log(`sedes: ${sedes.length} · ya con calendario: ${Object.keys(yaMapeadas).length}`);

  if (process.argv.includes('--dry-run')) {
    for (const s of sedes) {
      console.log(`  ${s}${yaMapeadas[normalizar(s)] ? ' (ya tiene)' : ' -> se crearia'}`);
    }
    return;
  }

  const cred = parseGoogleCredentials(process.env['GOOGLE_CALENDAR_CREDENTIALS'] ?? '');
  const jwt = new google.auth.JWT({
    email: cred.client_email,
    key: cred.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  const cal = google.calendar({ version: 'v3', auth: jwt });

  // Los que ya existen, para no duplicar si el script se corre dos veces.
  const lista = await cal.calendarList.list({ maxResults: 250 });
  const porNombre = new Map<string, string>();
  for (const c of lista.data.items ?? []) {
    if (c.summary && c.id) porNombre.set(c.summary, c.id);
  }

  const compartirCon = (arg('compartir-con') ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '');

  const mapa: Record<string, string> = { ...yaMapeadas };

  /**
   * Se guarda DESPUES DE CADA sede, no al final.
   *
   * Google corta la creacion de calendarios por cuota ("Calendar usage limits
   * exceeded") y la primera version de este script guardaba solo al terminar:
   * al cortarse dejo once calendarios creados y sin registrar, invisibles para
   * el sistema y sin forma de reutilizarlos salvo por su nombre. Guardar sobre
   * la marcha convierte un corte en una pausa.
   */
  const guardar = async (): Promise<void> => {
    config['calendarios_por_sede'] = mapa;
    await writeFile(RUTA, `${JSON.stringify(crudo, null, 2)}\n`, 'utf8');
  };

  let creados = 0;
  for (const sede of sedes) {
    const titulo = `${crudo.nombre} — ${sede}`;
    const clave = normalizar(sede);

    let id = mapa[clave] ?? porNombre.get(titulo);
    if (id) {
      console.log(`= ${sede} -> ya existia`);
    } else {
      try {
        // Un respiro entre creaciones: la cuota es por ventana de tiempo, no
        // solo por total.
        if (creados > 0) await new Promise((r) => setTimeout(r, 1500));
        const creado = await cal.calendars.insert({
          requestBody: { summary: titulo, timeZone: 'America/Lima' },
        });
        id = creado.data.id ?? '';
        creados += 1;
        console.log(`+ ${sede}`);
      } catch (e) {
        const msg = (e as Error).message;
        await guardar();
        console.log(`\n! Corte en "${sede}": ${msg}`);
        console.log(
          `  Guardadas ${Object.keys(mapa).length} de ${sedes.length}. Vuelve a ejecutar\n` +
            '  `npm run cal:sedes` mas tarde: reutiliza lo ya creado y sigue donde lo dejo.',
        );
        return;
      }
    }
    mapa[clave] = id;
    await guardar();

    for (const correo of compartirCon) {
      try {
        await cal.acl.insert({
          calendarId: id,
          requestBody: { role: 'writer', scope: { type: 'user', value: correo } },
        });
      } catch (e) {
        console.log(`  (no se pudo compartir con ${correo}: ${(e as Error).message})`);
      }
    }
  }

  await guardar();
  console.log(`\ncalendarios_por_sede: ${Object.keys(mapa).length} sedes escritas en clinica.json`);
  console.log('Ahora: npm run db:seed -- --solo-clinica');
  if (compartirCon.length === 0) {
    console.log(
      '\n⚠ Nadie del equipo VE estos calendarios: los creo la cuenta de servicio.\n' +
        '  Comparte con: npm run cal:sedes -- --compartir-con correo@clinica.pe',
    );
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
