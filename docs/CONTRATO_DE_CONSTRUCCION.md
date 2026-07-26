# Contrato de construcción — reglas para toda rama de trabajo

Documento de obligado cumplimiento para cualquier agente que escriba código en este repositorio.
Se construye en paralelo: la disciplina de este documento es lo que evita que las ramas colisionen.

## Entorno ya resuelto (no lo rehagas)

- Repo: `C:\Users\abner\dev\recepcion-ia` — ya inicializado con git.
- Node **24.18.0**, npm **11.16.0** — ya instalados.
- Dependencias **ya instaladas**. NO ejecutes `npm install`. Si crees necesitar un paquete nuevo, **no lo instales**: repórtalo en tu informe final y sigue sin él.
- `node`/`npm` no están en el PATH de shells nuevos. Prefija siempre:
  ```
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  ```

## Versiones reales (difieren de lo que asume la especificación)

| Paquete | Versión instalada | Qué implica |
|---|---|---|
| TypeScript | **7.0.2** | Compilador nuevo. Si algo no compila, revisa sintaxis antes de culpar al tipo. |
| Zod | **4.4.3** | v4, no v3. `z.ZodIssueCode.custom`, `z.ZodType<T>`, `error.issues` funcionan (verificado). `z.string().url()` sigue funcionando. |
| Fastify | 5.10.0 | |
| @anthropic-ai/sdk | 0.115.0 | |
| Vitest | 4.1.10 | |

## Reglas de código innegociables

1. **ESM + NodeNext.** Todo import relativo lleva extensión `.js`, aunque el archivo sea `.ts`:
   `import { algo } from './otro.js';` ← correcto. Sin extensión NO compila.
2. **`verbatimModuleSyntax` activo.** Los imports de solo-tipo van con `import type { X } from ...`.
3. **Sin `any`.** `strict: true`. Si necesitas escapar, usa `unknown` y estrecha con Zod.
4. **Los tipos ya están fijados.** Importa siempre de `src/core/types/index.js`. **No redefinas** `Channel`, `InboundMessage`, `OutboundMessage`, `EscalationRequest`, `TurnChunk`, `TurnContext`, `ToolResult`, ni ningún puerto de `ports.ts`. Si un tipo te falta o te estorba, **no lo cambies**: dilo en tu informe.
5. **Regla de dependencias.** `channels/` puede importar de `core/`. **`core/` NUNCA importa de `channels/`.** `core/` tampoco importa de `infra/`: depende de los puertos de `ports.ts`, y la implementación se inyecta por constructor.
6. **Inyección por constructor.** Nada de singletons ni de `import` de clientes concretos dentro de `core/`. Todo servicio recibe sus dependencias como parámetro. Es lo que hace que los tests corran sin red.
7. **Comentarios en español, sin tildes ni eñes** (evita problemas de codificación en Windows). Comenta el *por qué*, no el *qué*. Densidad baja: solo donde la decisión no sea evidente.
8. **Nada de PII en logs.** Todo lo que se registre pasa por el enmascarador.

## Cómo verificas tu trabajo

Ejecuta:
```
npx tsc -p tsconfig.test.json --noEmit
```
Verás errores de archivos de **otras ramas que aún no existen**. Es esperado.
**Corrige únicamente los errores cuyo archivo esté en tu lista asignada.** Ignora el resto y no crees archivos ajenos para "arreglarlos".

## Qué entregas

Un informe final en español con:
- Lista de archivos creados.
- Decisiones de diseño que tomaste y su motivo.
- **Vacíos detectados**: lo que la especificación no define y tuviste que decidir.
- Lo que NO pudiste verificar y por qué.
- Cualquier contradicción que hayas encontrado entre la especificación y los informes.

Sé literal sobre lo que no verificaste. Un informe que dice "no lo comprobé" vale más que uno que afirma de más.

## Fuentes de verdad del proyecto

- `C:\Users\abner\OneDrive\Documentos\IA GENERATIVA\Proyecto Final - Recepcion IA\ESPECIFICACION_TECNICA_CONSTRUCCION.md` — el brief. Manda.
- Los dos `.docx` de esa carpeta contienen el informe del proyecto y el informe ético-regulatorio. Si necesitas leerlos, están extraídos en texto plano en el scratchpad de la sesión.

## Restricciones de dominio que el código debe hacer cumplir

Nunca diagnosticar · nunca interpretar síntomas · nunca recomendar tratamientos · nunca prometer resultados · nunca cerrar precios de tratamientos que requieren valoración · nunca inventar datos ausentes de la base · nunca afirmar ser humano · ante urgencia, interrumpir el flujo comercial y escalar.

Se implementan en **tres capas** (prompt, verificación de salida, validación en herramientas). Si tu rama toca una de esas capas, esa capa es tu responsabilidad principal: el resto del código asume que la tuya funciona.
