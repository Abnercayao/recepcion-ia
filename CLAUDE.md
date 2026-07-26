# Recepción-IA

Agente conversacional para el primer contacto de pacientes en clínicas dentales
y de medicina estética. Dos canales —WhatsApp y voz— sobre **un único núcleo**.

## Empieza por el grafo de conocimiento

Este repositorio tiene un grafo consultable de sí mismo. **Úsalo antes de
rastrear archivos**: responde en una llamada lo que leyendo código cuesta abrir
media docena de archivos.

- Por MCP (ya declarado en `.mcp.json`, disponible sin configurar nada):
  `kg_panorama`, `kg_buscar`, `kg_ver`, `kg_vecinos`, `kg_camino`,
  `kg_dependencias`, `kg_control`, `kg_verificar`.
- Por terminal, si el servidor MCP no está cargado en la sesión:
  `npm run kg -- panorama`, `npm run kg -- ver <algo>`, `npm run kg -- control C9`.

**Al abrir una sesión sobre este proyecto, llama primero a `kg_panorama`.** Da
capas, los 12 puertos con sus implementaciones, las 5 herramientas, las líneas
rojas y las tablas, de una sola vez.

El grafo dice **dónde mirar y cómo se conecta todo**. La verdad sigue estando en
el código: léelo después, y solo donde haga falta. Detalles y límites del
extractor en `kg/README.md`.

**Si cambias código, regenera el grafo**: `npm run kg:extraer`. Si se olvida,
`npm test` falla — hay una prueba que compara el artefacto con las fuentes.

Para verlo gráficamente: `npm run kg:visor` escribe `kg/grafo.html`, una página
autocontenida con dos disposiciones (fuerza y capas).

## Arquitectura

```
src/core/       NÚCLEO — no conoce ningún canal
src/channels/   ADAPTADORES — traducen, no deciden
src/infra/      implementaciones concretas de los puertos
src/server.ts   raíz de composición: el único punto donde el núcleo se
                encuentra con lo concreto
```

**Regla de dependencias, innegociable:** `channels/` importa de `core/`.
`core/` **nunca** importa de `channels/` ni de `infra/` — depende de los puertos
de `src/core/types/ports.ts`, y las implementaciones se inyectan en `server.ts`.
`npm run kg:verificar` comprueba esta regla.

`src/core/types/ports.ts` es el **contrato compartido**. No lo modifiques sin
avisar.

## Líneas rojas

Nunca diagnosticar · nunca interpretar síntomas · nunca recomendar tratamientos
· nunca prometer resultados · nunca cerrar precios de tratamientos que requieren
valoración · nunca inventar datos ausentes de la base · nunca afirmar ser humano.
Ante urgencia médica: interrumpir el flujo comercial y escalar.

Se implementan en **tres capas** —prompt, verificación de salida, validación en
herramientas—, no solo en el prompt. La **capa 2** (`checkOutbound` en
`src/core/claude/guardrails.ts`) es la que convierte las reglas en un control:
bloquea y sustituye. Sin ella son una expectativa.

Dos líneas rojas —«no inventar datos» y el protocolo de urgencia— **no tienen
control automático en capa 2**: solo las vigila el prompt. `kg_panorama` lo
señala. Tenlo presente antes de afirmar que algo está garantizado.

## Comandos

```bash
npm run build          # tsc
npm run typecheck      # tsc --noEmit sobre src, tests, scripts y kg
npm test               # vitest (12 fallos esperados marcados con it.fails)
npm run test:adversarial
npm run kg:extraer     # regenera kg/grafo.json
npm run kg:verificar   # invariantes de extracción y arquitectura
```

Los **12 fallos esperados** son hallazgos reales de la batería adversarial,
marcados con `it.fails` para que fallen automáticamente si alguien los corrige
sin actualizar el test. No son deuda oculta: son deuda señalizada. **No los
"arregles" sin entender qué documentan.**

Los **7 saltados** son la batería contra el modelo real; requieren
`ANTHROPIC_API_KEY`.

## Dos numeraciones que se parecen y no son lo mismo

`C1..C13` designa a la vez los **controles** del informe ético-regulatorio y las
**13 categorías** de la batería adversarial. No coinciden: la categoría C9 es
«inyección a través del RAG», el control C9 es «aislamiento estricto de datos
entre clínicas». El grafo los separa (`control:C9` vs `categoria_adversarial:C9`).
Comprueba siempre el tipo de nodo antes de sacar conclusiones.

## Antes de tocar nada en producción

Lee `docs/ESTADO.md`: qué está verificado, qué no puede verificarse sin cuentas
reales y qué queda abierto. Ninguna llamada real a Anthropic, Supabase, Voyage,
Google Calendar, Meta ni ElevenLabs está comprobada — todo corre con dobles.

El despliegue del canal de voz **no debe hacerse** antes de la auditoría de
equidad del reconocimiento del habla.

## Estilo

El código está en español: identificadores, comentarios y mensajes. Mantenlo.
Los comentarios explican **por qué**, no qué hace la línea siguiente.
