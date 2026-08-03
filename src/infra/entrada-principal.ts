/**
 * ¿Se esta ejecutando este modulo directamente, o solo lo han importado?
 *
 * Los scripts y `server.ts` arrancan solo si son la entrada del proceso, para
 * que un test pueda importarlos sin levantar nada. La comprobacion parece
 * trivial y tiene una trampa que rompe en Windows y no en Linux.
 *
 * La forma ingenua era esta:
 *
 *   import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
 *
 * En POSIX cuadra de casualidad: `process.argv[1]` es `/home/...`, la barra
 * inicial completa el tercer separador y sale `file:///home/...`.
 *
 * En Windows `process.argv[1]` es `C:\...`, que normalizado queda `C:/...` y
 * produce `file://C:/...` —DOS barras— mientras Node genera `file:///C:/...`
 * —TRES—. La condicion nunca se cumple, el proceso termina sin ejecutar nada y
 * SIN ERROR: `npm run consola` y `npm start` simplemente no hacian nada.
 *
 * `pathToFileURL` es la conversion que define Node, y contempla ademas la
 * unidad de disco, los UNC y el escapado de caracteres. No se reimplementa.
 */
import { pathToFileURL } from 'node:url';

export function esEntradaPrincipal(metaUrl: string): boolean {
  const argumento = process.argv[1];
  if (argumento === undefined) return false;
  try {
    return metaUrl === pathToFileURL(argumento).href;
  } catch {
    return false;
  }
}
