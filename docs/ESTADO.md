# Estado del proyecto

**Fases 0–4 construidas.** Última verificación completa:

| Comprobación | Resultado |
|---|---|
| `npm run build` | **exit 0** · 49 archivos JS en `dist/` |
| `npx tsc -p tsconfig.test.json --noEmit` | **exit 0** |
| `npx vitest run` | **16 ficheros · 414 pasando · 12 fallos esperados · 7 saltados** |
| Arranque real desde `dist/` | `/health` → 200 · gateway sin secreto → 401 · secreto erróneo → 401 |
| Entorno incompleto | falla al arrancar enumerando cada variable ausente |

Los **12 «fallos esperados»** son hallazgos reales de la batería adversarial, marcados con `it.fails` para que fallen automáticamente si alguien los corrige sin actualizar el test. No son deuda oculta: son deuda señalizada.
Los **7 saltados** son la batería contra el modelo real, que requiere `ANTHROPIC_API_KEY`.

---

## Qué está construido

**Núcleo** (`src/core/`) — no conoce ningún canal.
Contratos congelados con 12 puertos de frontera · `ConversationService` con `handleTurn` y `streamTurn` · `MessageRouter` con continuidad multicanal · prompt maestro de 10 bloques en archivos · guardrails de 3 capas · detector de urgencia con prefiltro léxico · RAG con embeddings · 5 herramientas defensivas.

**Canales** (`src/channels/`) — traducen, no deciden.
WhatsApp: webhook con firma `X-Hub-Signature-256`, deduplicación, formatter, revelación escrita. Voz: gateway OpenAI-SSE, mapper de system tools, sesiones, buffer words.

**Infraestructura** (`src/infra/`).
Config con validación Zod · logger con enmascarado obligatorio de PII · 8 repositorios sobre Supabase · Google Calendar con idempotencia por SHA-256 · cliente ElevenLabs con verificación de firma · canal de notificación de respaldo.

**Datos y scripts.** Migraciones 001–003 con RLS y `audit_log` inalterable · `scripts/migrate.ts` · `scripts/seed.ts` (ejecutado: 39 fragmentos desde la clínica de demostración).

**Raíz de composición.** `src/server.ts` — el único punto donde el núcleo se encuentra con la infraestructura concreta.

## Criterios de aceptación

| Fase | Criterio | Estado |
|---|---|---|
| 0 | `npm run build` sin errores | ✅ |
| 0 | Entorno incompleto falla con mensaje claro | ✅ verificado ejecutando |
| 0 | Logger enmascara DNI y teléfono | ✅ 30 tests |
| 1 | Mismo servicio en ambos canales, solo difiere el estilo | ✅ forma precisa verificada |
| 1 | Capa 2 bloquea precio cerrado y afirmación clínica | ✅ sobre el turno completo |
| 2 | Ninguna lógica de negocio en `channels/whatsapp/` | ✅ |
| 2 | Conversación real por WhatsApp que agenda en Calendar | ⛔ **requiere cuenta de BSP** |
| 3 | Batería de 13 categorías | ✅ 91 casos en modo dobles |
| 3 | Criterios bloqueantes de la Tabla 14 | ⚠️ verificables en modo dobles; los de latencia y equidad, no |
| 4 | SSE válido terminando en `data: [DONE]` | ✅ forma literal byte a byte |
| 4 | Escalamiento → `transfer_to_number` con whitelist | ✅ sobre el núcleo real |
| 4 | Petición sin secreto → 401 | ✅ las tres vías |
| 5–7 | — | ⛔ **fuera de alcance**: exigen cuentas reales y hablantes con consentimiento |

## Lo que NO se ha verificado, y no puede verificarse aquí

- **Ninguna llamada real** a Anthropic, Supabase, Voyage, Google Calendar, Meta ni ElevenLabs. Todo con dobles. El sistema compila, arranca y sus controles funcionan; que los proveedores respondan como se asume está sin comprobar.
- **El modelo obedeciendo el prompt.** El modo dobles prueba que *los controles atrapan* lo que el modelo pueda decir, no que el modelo se porte bien. Eso exige la clave de API.
- **Todo el canal de voz con audio real**: latencia por turno, gestión de turnos, barge-in y la brecha de comprensión por segmento de hablante.
- **Las asunciones sobre ElevenLabs** que su documentación no cubre: formato de streaming de `tool_calls`, header de autenticación entrante, composición del HMAC del webhook. Ver `contrato-elevenlabs.md`.

## Asuntos abiertos

Detalle completo en `decisiones.md`. Los principales:

1. **RLS vs `SUPABASE_SERVICE_KEY`** — decidido para v1 con deuda reconocida; el `audit_log` inalterable sí queda resuelto de verdad.
2. **`CalendarPort` sin sede ni profesional** — la clínica tiene dos sedes y especialistas que no atienden en ambas.
3. **Falta herramienta de cancelación** — y las fuentes se contradicen: la Tabla 13 la exige, el anti-patrón 10 fija cinco herramientas.
4. **Umbral del RAG en 0.75, sin calibrar** — no hay clave de Voyage.
5. **Riesgo de doble locución al escalar por voz** — solo detectable con telefonía real.
6. **Revelación en WhatsApp sobre memoria de proceso** — frágil para un criterio bloqueante.

## Correcciones hechas a los documentos originales

- El proveedor de voz **no documenta header de autenticación** hacia nuestro endpoint. Resuelto con tres vías.
- **Zero Retention Mode es exclusivo de Enterprise**, por agente.
- **El criterio de la Fase 1 es literalmente falso**: el bloque 9 también difiere entre canales.
- El **Anexo C** no incluye 11 variables de entorno que el sistema necesita.
