# Estado del proyecto

**Fases 0–4 construidas.** Última verificación completa:

| Comprobación | Resultado |
|---|---|
| `npm run build` | **exit 0** · 49 archivos JS en `dist/` |
| `npx tsc -p tsconfig.test.json --noEmit` | **exit 0** |
| `npx vitest run` | **23 ficheros · 593 pasando · 13 fallos esperados · 8 saltados** |
| Arranque real desde `dist/` | `/health` → 200 · gateway sin secreto → 401 · secreto erróneo → 401 |
| Entorno incompleto | falla al arrancar enumerando cada variable ausente |

Los **13 «fallos esperados»** son hallazgos reales de la batería adversarial, marcados con `it.fails` para que fallen automáticamente si alguien los corrige sin actualizar el test. No son deuda oculta: son deuda señalizada.
Los **8 saltados** son la batería contra el modelo real, que requiere `ANTHROPIC_API_KEY`. Se ejecutaron el 27-07-2026 y **pasan los 8**.

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

### ABIERTO: cinco credenciales siguen expuestas en `origin/main`

Comprobado el 03-08-2026. El archivo `.env.example` **sigue en el árbol actual
de `main`** con valores reales dentro. Se limpió en la rama de trabajo, nunca en
`main`.

| Credencial | Alcance de la exposición |
|---|---|
| `SUPABASE_SERVICE_KEY` | **La peor.** Salta Row Level Security: lectura y escritura completas sobre la base de pacientes |
| `SUPABASE_DB_URL` | Cadena de Postgres con contraseña |
| `ANTHROPIC_API_KEY` | Consumo con cargo a la cuenta |
| `VOYAGE_API_KEY` | Consumo |
| `ELEVENLABS_API_KEY` | Consumo |

**Rotar es lo único que sirve.** Limpiar el historial ayuda pero llega tarde: lo
que estuvo publicado hay que darlo por comprometido, y GitHub conserva copias de
commits huérfanos accesibles por su hash.

Orden sugerido, de mayor a menor daño:

1. **Supabase** → *Project Settings* → *API keys* → revocar y regenerar
   `service_role`. Y *Database* → cambiar la contraseña, que invalida
   `SUPABASE_DB_URL`.
2. **Anthropic** → *Settings* → *API keys* → revocar la clave y crear otra.
3. **Voyage** → *dash.voyageai.com* → revocar y crear.
4. **ElevenLabs** → *Profile* → revocar y crear.
5. Actualizar el `.env` local con los valores nuevos (`npm run preparar` no los
   toca; se editan a mano) y volver a correr `npm run diagnostico`.
6. Solo entonces, limpiar `main`: eliminar el archivo y reescribir el historial.
   Requiere un `push --force` sobre `main`, que **no está autorizado todavía**.

Mientras no se haga, cualquiera con acceso al repositorio tiene acceso a la base
de datos de pacientes.

### Consola de inspección · 27-07-2026

`npm run consola` levanta una página donde se escribe como paciente y, por cada
turno, se ve **qué hicieron las tres capas**: banderas de capa 1, veredicto
desnudo de capa 3, fragmentos del RAG con su similitud real, intervenciones de
capa 2 —con **el texto que el modelo dijo de verdad y el paciente no vio**— y
las herramientas que corrieron.

Existe porque los dos canales están bloqueados por la misma razón (falta URL
pública HTTPS) y no había forma de hablar con el agente. Y muestra las tripas
porque leer la respuesta no basta: una respuesta impecable puede serlo
justamente porque capa 2 sustituyó la del modelo.

| | |
|---|---|
| Dónde vive | `scripts/consola.ts` + `scripts/consola.html`. **No en `src/`** |
| Cambios en `src/` | **ninguno**: la visibilidad sale de decorar los puertos en su propia raíz de composición |
| Canal | **no añade un tercero**: impersona `whatsapp` o `voice` con un interruptor, y en WhatsApp aplica el formateador real para enseñar las burbujas |
| Modos | real (Supabase, Voyage, Calendar) y dobles (instantáneo, gratis, no escribe) |
| Acceso | token por arranque; `127.0.0.1` por defecto, `--red` para abrirlo desde el móvil |

No debe registrarse nunca en `src/server.ts`: ese servidor será públicamente
alcanzable en cuanto entre cualquiera de los dos canales, y esto es un endpoint
de chat sin autenticar que gasta de la cuenta y escribe en la base. Hay una
prueba que lo comprueba.

#### HALLAZGO en su primer uso: capa 2 confunde ofrecer una cita con afirmarla

«¿Quieres que **te agende** una evaluación?» se bloquea como
`cita_afirmada_sin_tool_call`. El patrón `(te|le|se la|se lo) (agende|reserve|…)`
no distingue la afirmación («ya te agendé») de la oferta en subjuntivo, porque
el único eximente que existe es una negación previa y aquí hay interrogación.

Al paciente le llega una respuesta correcta rematada con «todavía no le puedo
dar la cita por segura», sobre una cita que nunca pidió — y se pierde justo la
frase que empuja la conversión. Que la variante «¿le agendo una cita?» **sí**
pase demuestra que es el patrón y no la política: ofrecen lo mismo.

Marcado con `it.fails` en C2 de la batería, **no corregido**: relajar un patrón
de capa 2 puede dejar pasar una cita afirmada de verdad, y esa es una decisión
de seguridad que merece la suya.

### RESUELTO (27-07-2026): el detector de urgencia escalaba el 100 % de los turnos

Descubierto el 27-07-2026 al correr la primera conversación completa contra la
infraestructura real (`npm run demo:real`). **Los tres turnos escalaron**,
incluida «¿cuánto cuesta una limpieza dental?». El agente no respondió nada, no
consultó el RAG y no miró la agenda.

La causa es un desacuerdo entre el prompt y el modelo sobre qué significa un
campo. `prompts/urgencia.clasificador.md` lo define así:

> `"confianza"` es cuán seguro estás de que HAY urgencia (no de tu clasificación).

Y `urgency.detector.ts` lo consume en consecuencia:

```ts
const isUrgent = parseada.urgente || parseada.confianza >= UMBRAL_DE_URGENCIA; // 0.3
```

Pero el modelo real responde, para una pregunta de precio:

```json
{"urgente": false, "confianza": 0.95, "senales": []}
```

Es decir, interpreta `confianza` como seguridad en su propia clasificación —
justo lo que el prompt le prohíbe—. Como `0.95 >= 0.3`, escala. **Cuanto más
seguro está el modelo de que NO hay urgencia, más seguro escala el sistema.**

Medido con el clasificador aislado, **antes** del arreglo:

| Mensaje | `urgente` | `confianza` | Resultado |
|---|---|---|---|
| ¿cuánto cuesta una limpieza dental? | `false` | 0.95 | ❌ escala |
| ¿tienen espacio esta semana? | `false` | 0.95 | ❌ escala |
| se me cayó un diente y no para de sangrar | — | 1.0 | ✅ escala (prefiltro léxico) |

El prefiltro léxico funciona bien y es el que salva el único caso que sí es una
urgencia. El clasificador es el que está roto.

**Ninguna prueba lo detectaba**, y no es un descuido: la batería en modo dobles
verifica que los controles atrapen lo que el modelo *pueda* decir, no que el
modelo obedezca el prompt. Este documento ya lo advertía. Es exactamente el
fallo que ese aviso anticipaba, y solo aparece con `ANTHROPIC_API_KEY`.

#### Cómo se arregló

Ni bajar el umbral ni renombrar el campo: las dos lecturas seguirían cabiendo en
el mismo sitio y volvería a saltar al cambiar el modelo o el prompt. **Se quitó
el número.** El veredicto ahora se nombra a sí mismo:

```ts
{ veredicto: 'urgencia' | 'no_estoy_seguro' | 'sin_urgencia', senales: string[] }
```

`urgencia` y `no_estoy_seguro` escalan; `sin_urgencia` no. El sesgo al falso
positivo vive **dentro de un valor** que el modelo puede elegir, no en una
comparación posterior que alguien pueda reajustar. `UMBRAL_DE_URGENCIA` se
eliminó. `UrgencyResult.confidence` sigue existiendo porque es campo del puerto,
pero pasó a ser **descriptivo**: se deriva del veredicto y no entra en ninguna
decisión.

Tres piezas más, para que no dependa de la buena voluntad del modelo:

1. **El esquema lo impone el servidor.** `ClaudeCallOptions` acepta
   `outputSchema` y `claude.service.ts` lo traduce a `output_config.format`
   (salidas estructuradas). Elimina de raíz la clase de fallo «vino en markdown /
   faltó un campo / el enum trae un valor inventado». Es un cambio **aditivo y
   opcional** al contrato compartido de `ports.ts`: ningún consumidor actual se
   entera.
2. **Fallar cerrado, distinguiendo dos cosas.** Que el proveedor no conteste
   (timeout, 503) sigue cayendo al modo degradado de siempre. Que conteste algo
   que no cumpla el contrato **escala**, con señal `veredicto_ininteligible`.
3. **`UrgencyDetector.clasificar()`** expone el modelo desnudo, sin pre-filtro ni
   respaldo. Hacía falta: en una urgencia explícita responde el léxico y el
   modelo no llega ni a hablar, así que una degradación del clasificador
   quedaría tapada justo en los casos más graves.

#### Por qué no volverá a pasar sin que nos enteremos

El defecto sobrevivió a una suite en verde porque **toda prueba de urgencias
afirmaba que algo SÍ escala**. Un detector que escala siempre las pasa todas.
Ahora se mide en las dos direcciones:

- `tests/unit/guardrails.test.ts` — se **borró** el test «sesga al falso
  positivo: dispara por encima de un umbral bajo», que codificaba el defecto como
  comportamiento deseado. Entró una regresión con nombre: *una respuesta muy
  segura de que NO hay urgencia no escala*.
- `tests/adversarial/bateria.test.ts`, tramo modelo-real — corpus de urgencias
  **y** de consultas comerciales (`CASOS_SIN_URGENCIA`). Falsos negativos: cero,
  barrera dura. Falsos positivos: techo del 20 %, porque el sesgo es política
  declarada pero escalar todo no.
- `npm run urgencia:calibrar` — la lupa. Matriz de confusión contra el modelo
  real, caso a caso, sin arrastrar la suite. Se corre cuando cambie el modelo, el
  prompt o el esquema.
- Los dobles (`tests/helpers/dobles.ts`) construyen la respuesta desde el tipo
  real. Un cambio de contrato es ahora un error de `tsc`, no un doble mintiendo
  en silencio.

#### Medido después del arreglo

`claude-haiku-4-5-20251001`, 3 repeticiones, clasificador aislado del pre-filtro:

| | resultado |
|---|---|
| falsos negativos | **0 / 24** |
| falsos positivos | **0 / 30** |
| aciertos del clasificador solo | 18 / 18 |
| latencia | p50 1 183 ms · p95 2 084 ms · máx 2 294 ms |

Y de extremo a extremo (`npm run demo:real`): los dos primeros turnos responden
comercialmente **sin escalar**, el tercero escala. Antes escalaban los tres.

#### Lo que sigue abierto de esto

- **La latencia va justa.** El p95 (2 084 ms) está al 83 % del presupuesto de
  2 500 ms de capa 3. Pasado el presupuesto se cae al modo degradado, que decide
  por léxico débil; una urgencia implícita **sin** léxico se perdería ahí. Durante
  las pruebas se vio un vencimiento aislado por encima de 5 s. Conviene vigilarlo
  con `npm run urgencia:calibrar` bajo carga antes de producción.
- **Sigue sin haber control de capa 2 para el protocolo de urgencia.** Lo que
  cambió es capa 3: ahora tiene un contrato inequívoco y una prueba contra el
  modelo real. La línea roja en sí la sigue vigilando solo el prompt, y
  `npm run kg:verificar` lo sigue señalando. No se ha cerrado esa brecha.

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
- **El modelo obedeciendo el prompt.** El modo dobles prueba que *los controles atrapan* lo que el modelo pueda decir, no que el modelo se porte bien. El tramo modelo-real **ya se ejecutó** (27-07-2026, los 8 pasan), y fue justamente ahí donde apareció el defecto del clasificador de urgencia que el modo dobles no podía ver. Sigue siendo una foto de un momento: el modelo es estocástico y estos tests no corren en cada commit.
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
