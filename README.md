# Recepción-IA

Agente conversacional para el primer contacto de pacientes en clínicas dentales y de medicina estética. Resuelve consultas desde una base de conocimiento aprobada, agenda contra Google Calendar y escala a una persona cuando corresponde.

Opera en **dos canales sobre un único núcleo**: WhatsApp (texto) y llamada telefónica (voz, vía ElevenLabs con Custom LLM). El canal es un atributo del mensaje, no una propiedad del sistema: hay **un** `ConversationService`, **un** prompt maestro, **una** base de conocimiento por clínica y **cinco** herramientas de negocio. Los canales son adaptadores que traducen.

El razonamiento es siempre de Claude. ElevenLabs aporta reconocimiento de voz, gestión de turnos y síntesis; el turno se dirige a un endpoint propio compatible con la interfaz de OpenAI.

## Puesta en marcha

```bash
npm install
```

```bash
cp .env.example .env
```

Rellena `.env`. El sistema **no arranca** si falta algo obligatorio, y te dirá exactamente qué. Es deliberado.

```bash
npm run build
```

```bash
npm run dev
```

## Credenciales

```bash
cp .env.example .env
```

Los valores reales van en `.env`, que git ignora. **Nunca en `.env.example`**,
que sí está versionado. Los archivos de credenciales —JSON de cuentas de
servicio, certificados— van en `credenciales/`, ignorada entera salvo su README.

Un hook de pre-commit revisa lo que está a punto de entrar y rechaza el commit
si detecta una credencial. Se instala solo con `npm install`; para pasarlo a
mano, `npm run comprobar-secretos`.

Que una credencial llegue a un commit no se arregla con un commit posterior: el
valor se queda en el historial y sigue siendo válido hasta que se rota.

## Base de datos

```bash
npm run db:migrate
```

Carga la base de conocimiento de una clínica. Sin `--aprobar-como`, los fragmentos entran **inactivos**: la aprobación es un acto humano nominal, no un paso del script.

```bash
npm run db:seed -- --dry-run
```

## Pruebas

```bash
npm test
```

```bash
npm run test:adversarial
```

La batería adversarial corre en dos modos. El modo por defecto usa dobles y verifica las capas deterministas — es lo que puede correr siempre. El modo contra el modelo real se activa solo si existe `ANTHROPIC_API_KEY`.

**Importante:** el modo dobles no prueba que el modelo obedezca el prompt; prueba que los controles atrapan lo que el modelo pueda decir. Son cosas distintas y conviene no confundirlas al leer los resultados.

## Grafo de conocimiento

El repositorio tiene un mapa consultable de sí mismo: qué existe, dónde vive y
cómo se conecta.

```bash
npm run kg -- panorama       # capas, puertos, herramientas, líneas rojas, tablas
npm run kg -- ver crear_cita
npm run kg -- control C9     # dónde se toca un control y qué lo prueba
npm run kg:verificar         # ¿está al día? ¿se cumple la regla de dependencias?
npm run kg:visor             # escribe kg/grafo.html: el grafo, para verlo
```

`.mcp.json` lo expone además como servidor MCP, así que un agente abierto sobre
este repositorio lo tiene disponible sin configurar nada. Detalles, límites del
extractor y cómo extenderlo, en [`kg/README.md`](kg/README.md).

Si cambias código, `npm run kg:extraer`. Si se olvida, `npm test` lo detecta.

## Estructura

```
src/
  core/          NÚCLEO — no conoce ningún canal
    conversation/  orquestación del turno y continuidad multicanal
    claude/        prompt maestro, guardrails de 3 capas, invocación del modelo
    rag/           recuperación sobre la base aprobada
    tools/         las 5 herramientas de negocio, defensivas
    urgency/       clasificador dedicado
    types/         contratos y puertos de frontera
  channels/      ADAPTADORES — traducen, no deciden
    whatsapp/     webhook, formato, envío
    voice/        gateway SSE, mapper de system tools, sesiones
  infra/         implementaciones concretas de los puertos
  server.ts      raíz de composición
db/migrations/   SQL numerado, con RLS
db/seed/         clínica de demostración (ficticia)
prompts/         prompt maestro y bloques de estilo
tests/           unit · integration · adversarial
docs/            decisiones, contratos verificados, estado
kg/              grafo de conocimiento del propio repositorio
```

**Regla de dependencias:** `channels/` importa de `core/`. **`core/` nunca importa de `channels/` ni de `infra/`** — depende de los puertos de `core/types/ports.ts`, y las implementaciones se inyectan en `server.ts`.

## Líneas rojas

Nunca diagnosticar · nunca interpretar síntomas · nunca recomendar tratamientos · nunca prometer resultados · nunca cerrar precios de tratamientos que requieren valoración · nunca inventar datos ausentes de la base · nunca afirmar ser humano. Ante urgencia médica: interrumpir el flujo comercial y escalar.

Se implementan en **tres capas** —prompt, verificación de salida y validación en herramientas—, no solo en el prompt. La capa 2 es la que convierte las reglas en un control: sin ella son una expectativa.

## Antes de producción

Lee [`docs/ESTADO.md`](docs/ESTADO.md). Resume qué está verificado, qué no puede verificarse sin cuentas reales, y los asuntos abiertos. [`docs/decisiones.md`](docs/decisiones.md) registra lo que la especificación dejó abierto y por qué se decidió cada cosa; [`docs/contrato-elevenlabs.md`](docs/contrato-elevenlabs.md) distingue lo verificado contra la documentación oficial de lo que son asunciones nuestras.

El despliegue del canal de voz **no debe hacerse** antes de la auditoría de equidad del reconocimiento del habla: expondría a los pacientes a un sesgo de magnitud desconocida.
