# Grafo de conocimiento

Un mapa consultable de Recepción-IA: qué existe, dónde vive y cómo se conecta.
Está pensado para que un agente (o una persona) se oriente en el proyecto sin
tener que abrir quince archivos primero.

No sustituye al código. Dice **dónde mirar** y **cómo se conecta todo**; la
verdad sigue estando en las fuentes.

## Uso

```bash
npm run kg -- panorama            # mapa general: capas, puertos, herramientas, líneas rojas
npm run kg -- buscar cita         # dónde está algo
npm run kg -- ver crear_cita      # ficha de un nodo y todas sus relaciones
npm run kg -- vecinos CalendarPort implementa
npm run kg -- camino whatsapp.controller.ts tabla:conversations
npm run kg -- depende conversation.service.ts
npm run kg -- control C9          # dónde se toca un control y qué lo prueba
```

Regenerar y comprobar:

```bash
npm run kg:extraer      # reconstruye kg/grafo.json desde las fuentes
npm run kg:verificar    # invariantes de extracción y de arquitectura
```

## Conectado al agente por MCP

`.mcp.json`, en la raíz, declara el servidor `recepcion-ia-kg`. Cualquier sesión
de Claude Code abierta sobre este repositorio tiene ocho herramientas
disponibles sin configurar nada:

| Herramienta | Para qué |
|---|---|
| `kg_panorama` | Orientación completa del proyecto en una llamada |
| `kg_buscar` | Localizar algo por nombre, ruta o resumen |
| `kg_ver` | Ficha de un nodo con todas sus relaciones |
| `kg_vecinos` | «Quién implementa esto», «quién escribe en esta tabla» |
| `kg_camino` | Cómo se conectan dos elementos cualesquiera |
| `kg_dependencias` | Alcance real de un cambio antes de hacerlo |
| `kg_control` | Trazar un control del informe ético por el código |
| `kg_verificar` | Si el grafo está al día y si la arquitectura se cumple |

La CLI y el servidor MCP comparten el mismo motor (`consultar.ts`), de forma que
lo que ve una persona y lo que ve un agente no pueden divergir.

## Estructura

```
ontologia.ts   vocabulario: tipos de nodo, relaciones y hechos curados
extraer.ts     lee las fuentes y produce grafo.json
consultar.ts   motor de consulta (funciones puras)
cli.ts         envoltorio de terminal
mcp.ts         envoltorio MCP
verificar.ts   invariantes
grafo.json     el artefacto, versionado en git
kg.test.ts     pruebas
```

`grafo.json` **se versiona**. Es un artefacto generado, pero comprometerlo es lo
que hace que una sesión nueva —o un contenedor recién creado— tenga el mapa
disponible de inmediato, sin instalar ni ejecutar nada.

## Cómo se extrae, y qué no garantiza

La extracción es **léxica**, no sintáctica. TypeScript 7 es el port nativo y ya
no expone la API clásica de AST (`ts.createSourceFile` no existe), así que el
extractor lee las fuentes con expresiones ajustadas a las convenciones reales de
este código: módulos ES con extensión `.js` explícita, `export class|interface|…`
a principio de línea, `implements` en la misma declaración.

Eso funciona bien aquí porque el estilo del repositorio es uniforme, pero un
extractor léxico **se degrada en silencio**: cambia una convención de escritura,
deja de reconocer algo y produce un grafo más pequeño que sigue pareciendo
válido. Por eso existe `verificar.ts`, y por eso sus mínimos son explícitos —12
puertos, 5 herramientas, 11 tablas, 13 categorías—: si la extracción se rompe,
falla en voz alta en vez de mentir.

El grafo es una **función pura de las fuentes**: misma entrada, misma salida byte
a byte. No lleva fecha de generación a propósito; llevarla haría que el archivo
cambiara en cada ejecución y arruinaría la detección de desfase.

### Dos cosas que conviene saber

**`C1..C13` significa dos cosas distintas en este proyecto.** Son los controles
del informe ético-regulatorio, y son también las 13 categorías de la batería
adversarial. No coinciden: la categoría C9 es «inyección a través del RAG», el
control C9 es «aislamiento estricto de datos entre clínicas». El grafo los
mantiene separados (`control:C9` y `categoria_adversarial:C9`) y hay pruebas que
lo fijan. Al leer un resultado, mira el tipo de nodo.

**Las definiciones de los controles son inferidas.** El enunciado autoritativo
vive en el informe ético-regulatorio, que no está en el repositorio. Lo que
muestra el grafo se reconstruye de cómo lo citan el código y la documentación
—por eso cada control lleva `definicionInferida: true`—. Sirve para orientarse,
no para auditar. Lo que sí es exacto es la lista de sitios donde se toca cada
control: eso sale de las fuentes.

## Mantenimiento

Después de cambiar código, `npm run kg:extraer`. Si se olvida, `npm test` lo
detecta: hay una prueba que compara el artefacto en disco con lo que sale de las
fuentes de ahora mismo.

Para extender el grafo con un tipo de nodo o una relación nuevos: decláralo en
`ontologia.ts`, extráelo en `extraer.ts`, y añade su mínimo en `verificar.ts`.
La prueba «solo usa tipos y relaciones del vocabulario declarado» impide que se
cuele un tipo no documentado.
