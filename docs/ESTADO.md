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

## Verificado contra proveedores reales · 26-07-2026

Primera sesión con credenciales de verdad. Hasta aquí todo se había comprobado
con dobles. Se ejecuta con `npm run diagnostico` (solo lectura, repetible).

| Comprobación | Resultado |
|---|---|
| Anthropic · modelo de conversación | `claude-sonnet-5` responde · **1511 ms** |
| Anthropic · modelo de clasificación | `claude-haiku-4-5` responde · **963 ms** |
| Voyage · embeddings | `voyage-3` responde · **1024 dimensiones**, coinciden con `EMBEDDING_DIMENSIONS` |
| Supabase · migraciones 001–003 | aplicadas · las 3 registradas en `_migrations` con checksum coincidente |
| Supabase · esquema | 11 tablas del proyecto, accesibles por PostgREST |
| Siembra de la clínica de demostración | 39 fragmentos · faq 27, formulario 7, protocolo 5 · **todos inactivos** |
| **Control O2** — nada se recupera sin aprobación | ✅ con 0 aprobados, `match_knowledge` devuelve 0; al activar uno, devuelve 1 |
| **Control C9** — aislamiento entre clínicas | ✅ mismo vector, misma base: la clínica sembrada ve 1, una clínica ajena ve 0 |

Sobre las dos últimas: la prueba se hizo **falsable a propósito**. Con todos los
fragmentos inactivos, ambas clínicas devuelven cero aunque el filtro por
`clinic_id` estuviera roto, así que ese resultado no prueba nada. Se activó un
fragmento temporalmente, se repitió la consulta y se revirtió. Sin ese paso, el
«pasa» habría sido un artefacto.

### Google Calendar · 27-07-2026

| Comprobación | Resultado |
|---|---|
| Autenticación de la cuenta de servicio | ✅ token obtenido · Calendar API habilitada en el proyecto |
| Calendario de la clínica | creado por la propia cuenta de servicio, zona `America/Lima` |
| `clinic.config` | `googleCalendarId` real · `googleImpersonateSubject` **eliminado** (exigía Workspace con delegación) |
| `CalendarPort.findAvailableSlots` | ✅ 108 huecos de 40 min en 3 días |
| Herramienta `consultar_agenda` | ✅ `ok` en **834 ms**, sobre conversación y paciente reales |

Una cuenta de servicio no tiene calendarios propios y no hereda ninguno: hasta
que se le comparte uno —o crea el suyo, que es lo que se hizo aquí—
`calendarList` devuelve cero y la agenda no existe aunque las credenciales sean
perfectas.

### CORREGIDO: el horario de atención de la clínica

Se creyó al principio que el horario no se aplicaba en ninguna parte. **No era
exacto**, y lo que había era peor de explicar pero menos grave de efecto:

- `consultar_agenda` **no filtraba nada**. De 73 huecos ofrecidos al modelo, 49
  caían fuera del horario, hasta las 23:57.
- `crear_cita` **sí** validaba, pero contra el horario equivocado. Su
  `dentroDeHorario` local leía `clinic.config.horario` (**singular**) y la
  clínica declara `horarios` (**plural**) con otra forma. El parseo fallaba en
  silencio y se caía al valor por defecto: lunes a sábado, 08:00–20:00.

Efecto combinado: el agente ofrecía las 23:57, el paciente la elegía y la
herramienta la rechazaba. Y al revés, aceptaba citas a las 14:00 —con la clínica
cerrada al mediodía— y a las 08:00, antes de abrir, porque el horario por
defecto no conoce ni el cierre del mediodía ni la hora real de apertura.

El formato heredado, además, **no puede expresar un cierre al mediodía**: con
`horaApertura`/`horaCierre` la pausa de 13:00 a 15:00 es inexpresable.

**Resuelto** en `src/core/tools/horario-clinica.ts`, compartido por las dos
herramientas para que lo que se ofrece y lo que se acepta no puedan divergir.
Vive en el núcleo y no en `infra/` porque es regla de negocio de la clínica: a
`freebusy` de Google las 23:57 le constan libres, y lo están.

| | Antes | Después |
|---|---|---|
| Huecos ofrecidos (3 días) | 73 | **24** |
| Fuera de horario | 49 | **0** |
| Rango horario ofrecido | hasta 23:57 | **09:00–19:00** |

Se corrigen de paso dos cosas que el formato anterior no cubría: la cita se
valida **entera**, no solo su inicio —40 minutos a las 19:50 terminaban veinte
después del cierre—, y se rechaza la cita a caballo entre dos franjas. 15
pruebas en `tests/unit/horario-clinica.test.ts`.

### RAG de extremo a extremo · 27-07-2026

Los 39 fragmentos quedaron **aprobados por «Abner Cayao»** (aprobación ficticia
sobre datos ficticios; no sustituye la de un profesional sanitario real).

Y con eso apareció el defecto que el contenido inactivo tapaba: **el umbral de
similitud estaba en 0.75 y no dejaba pasar nada**. La consulta «¿cuánto cuesta
una limpieza dental?» puntúa 0.7316 contra el fragmento que la responde
literalmente —«Profilaxis y limpieza dental: S/ 90 a S/ 150»— y quedaba fuera.
El RAG devolvía cero para todo.

| Umbral | Fragmentos que pasan |
|---|---|
| 0.75 (anterior) | **0** |
| 0.60 | 2 |
| **0.50 (actual)** | **5, todos del tema** |
| 0.40 | 15, ya con ruido |

Corregido a 0.50 y expuesto como `RAG_UMBRAL_SIMILITUD` para poder ajustarlo sin
tocar código. **Es una calibración de un solo punto**: sirve para que el sistema
funcione, no para dar el asunto por cerrado.

### Otro defecto: `npm run db:seed` no es idempotente

Siempre inserta y después aprueba lo que acaba de insertar. Ejecutarlo dos veces
deja 78 fragmentos, con los 39 originales huérfanos e inactivos. Por eso la
aprobación de esta sesión se hizo sobre los fragmentos existentes, por el mismo
`KnowledgeRepository.aprobar` que usa el script.

### Bloqueantes descubiertos

1. **Voyage en plan gratuito: 3 peticiones/minuto y 10 000 tokens/minuto.** Cada
   consulta de paciente necesita un embedding, así que el sistema atiende una
   consulta cada veinte segundos y con dos pacientes simultáneos empieza a
   devolver vacío. `RagService` degrada como debe —lista vacía y el prompt
   declara que no dispone del dato—, pero es un bloqueante de producción. Hace
   falta método de pago en la cuenta.
2. **`SUPABASE_DB_URL` apunta a `db.<proyecto>.supabase.co`, que no resuelve**
   (sin registro A ni AAAA). Es la conexión directa heredada, que ya no se
   provisiona en proyectos nuevos. Bloquea `npm run db:migrate`. Mientras tanto,
   `npm run db:sql` genera las migraciones en un solo archivo para el editor SQL
   del panel, con el registro de `_migrations` coherente.

### Defectos corregidos en el camino

- **`migrate.ts`, `seed.ts` y `demo.ts` no cargaban `.env`.** Solo `server.ts`
  importaba `dotenv/config`, así que el flujo del README (crear `.env`
  y luego `npm run db:migrate`) fallaba enumerando como ausentes variables que sí
  estaban en el archivo.
- **El diagnóstico daba un falso positivo sobre Supabase.** Comprobaba la
  existencia de las tablas con `head: true`, y PostgREST responde 204 sin error a
  una petición HEAD aunque la tabla no exista. Informó «11 tablas, 0 filas» sobre
  una base sin una sola tabla. Ahora consulta la raíz de PostgREST y confirma con
  un GET real.

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

- **Google Calendar, Meta y ElevenLabs**: sin credenciales, todo con dobles. *(Anthropic, Supabase y Voyage sí quedaron verificados el 26-07-2026; ver la sección de arriba.)*
- **La agenda de la clínica de demostración no existe.** `clinic.config.googleCalendarId` apunta a `aurora-miraflores@group.calendar.google.com`, que es ficticio, igual que `googleImpersonateSubject`. Aunque las credenciales de la cuenta de servicio sean válidas, no habrá agenda real hasta cambiar esos dos valores.
- **El modelo obedeciendo el prompt.** El modo dobles prueba que *los controles atrapan* lo que el modelo pueda decir, no que el modelo se porte bien. La clave de API ya existe, así que los 7 tests saltados **ya se pueden ejecutar**; no se han ejecutado todavía.
- **El RAG de extremo a extremo con contenido aprobado.** Los 39 fragmentos están sembrados pero inactivos: falta la aprobación nominal (control O2), que es un acto humano y no un paso del script.
- **Todo el canal de voz con audio real**: latencia por turno, gestión de turnos, barge-in y la brecha de comprensión por segmento de hablante.
- **Las asunciones sobre ElevenLabs** que su documentación no cubre: formato de streaming de `tool_calls`, header de autenticación entrante, composición del HMAC del webhook. Ver `contrato-elevenlabs.md`.

## Asuntos abiertos

Detalle completo en `decisiones.md`. Los principales:

1. **RLS vs `SUPABASE_SERVICE_KEY`** — decidido para v1 con deuda reconocida; el `audit_log` inalterable sí queda resuelto de verdad.
2. **`CalendarPort` sin sede ni profesional** — la clínica tiene dos sedes y especialistas que no atienden en ambas.
3. **Falta herramienta de cancelación** — y las fuentes se contradicen: la Tabla 13 la exige, el anti-patrón 10 fija cinco herramientas.
4. ~~**Umbral del RAG en 0.75, sin calibrar**~~ — **corregido el 27-07-2026**: medido con embeddings reales, 0.75 no pasaba ni un fragmento. Ahora 0.50, ajustable por `RAG_UMBRAL_SIMILITUD`. Sigue siendo una calibración de un solo punto: falta un conjunto de consultas de referencia.
5. **Riesgo de doble locución al escalar por voz** — solo detectable con telefonía real.
6. **Revelación en WhatsApp sobre memoria de proceso** — frágil para un criterio bloqueante.

## Correcciones hechas a los documentos originales

- El proveedor de voz **no documenta header de autenticación** hacia nuestro endpoint. Resuelto con tres vías.
- **Zero Retention Mode es exclusivo de Enterprise**, por agente.
- **El criterio de la Fase 1 es literalmente falso**: el bloque 9 también difiere entre canales.
- El **Anexo C** no incluye 11 variables de entorno que el sistema necesita.
