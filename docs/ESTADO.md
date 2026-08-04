# Estado del proyecto

**Fases 0–4 construidas.** Última verificación completa:

| Comprobación | Resultado |
|---|---|
| `npm run build` | **exit 0** · 49 archivos JS en `dist/` |
| `npm run typecheck` | **exit 0** |
| `npx vitest run` | **20 ficheros · 537 pasando · 12 fallos esperados · 7 saltados** |
| `npx vitest run tests/adversarial` **con clave real** | **88 pasando · 12 fallos esperados · 0 saltados** |
| Arranque real desde `dist/` | `/health` → 200 · gateway sin secreto → 401 · secreto erróneo → 401 |
| Entorno incompleto | falla al arrancar enumerando cada variable ausente |
| `npm run kg:verificar` | **exit 0** |

Los **12 «fallos esperados»** son hallazgos reales de la batería adversarial, marcados con `it.fails` para que fallen automáticamente si alguien los corrige sin actualizar el test. No son deuda oculta: son deuda señalizada.
Los **7 saltados** son la batería contra el modelo real. Ya se han ejecutado al menos una vez (ver abajo); se saltan cuando no hay `ANTHROPIC_API_KEY` en el entorno del proceso. Ojo: `vitest` **no lee el `.env`**, así que hay que exportar la variable en la shell para que corran.

---

## Verificación contra proveedores reales

Hecha con credenciales activas. Deja de ser cierto que «ninguna llamada real está comprobada»:

| Proveedor | Comprobación | Resultado |
|---|---|---|
| Anthropic | `POST /v1/messages` | **200** |
| Voyage | `POST /v1/embeddings` | **200** · 1024 dimensiones, coincide con `vector(1024)` del esquema |
| Supabase PostgREST | `GET /rest/v1/clinics` | **200** · tabla accesible |
| Supabase Postgres | conexión directa | **conectada** · 12 tablas en `public`; migraciones 001–003 aplicadas |
| ElevenLabs | `GET /v1/user` y `GET /v1/convai/agents/{id}` | **200** · el agente existe |

**Batería adversarial contra el modelo real:** 0 consejos clínicos, 0 precios cerrados no autorizados, 0 fugas entre clínicas, 0 inyecciones exitosas, 1/1 urgencias escaladas, 5/5 respuestas correctas.

**Demo conversacional (`npm run demo`) contra el modelo real:** saludo, consulta de precio (devuelve rango, no cifra cerrada), petición de cita (usa `consultar_agenda`) y petición de medicación (se niega y deriva) se comportan según la especificación. «Me sangra mucho la encía y no para» escala en **16 ms** por el prefiltro léxico, sin llegar a llamar al modelo.

Sigue sin comprobarse todo lo que exige cuentas de las que no se dispone: Meta BSP, telefonía real y Google Calendar.

---

## Fallo encontrado al ejecutar contra el modelo real

Merece constar, porque ilustra un límite de la batería.

El clasificador de urgencia marcaba **todo mensaje** como urgencia médica: un saludo, una consulta de precios y una petición de cita escalaban igual. El flujo comercial estaba anulado por completo.

La causa era una ambigüedad del prompt, no de la lógica. El campo `confianza` se definía como «cuán seguro estás de que HAY urgencia», y el modelo lo devolvía como su seguridad **en la propia clasificación**: ante un saludo respondía `{"urgente": false, "confianza": 0.95}`. Como el detector escala cuando la confianza supera 0.3 con independencia del booleano —comportamiento deliberado, fijado en `tests/unit/guardrails.test.ts:479`—, el `false` se ignoraba.

Corregido renombrando el campo a `probabilidad_de_urgencia`, con la semántica explícita y ejemplos resueltos en el prompt. El umbral y el sesgo hacia el falso positivo no se tocaron: moverlos es una decisión clínica.

**Por qué la batería no lo veía**, que es lo importante: en modo dobles el clasificador devuelve valores controlados, así que la ambigüedad nunca se ejercita; y en modo modelo-real la Tabla 14 solo mide el **sub**-escalamiento. Sobre-escalar al 100% no dispara ningún criterio. No hay hoy ninguna prueba que detecte un exceso de derivaciones, y añadirla exige decidir qué tasa es aceptable — decisión clínica, no de ingeniería.

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
| 3 | Batería de 13 categorías | ✅ 91 casos en modo dobles · ejecutada también contra el modelo real |
| 3 | Criterios bloqueantes de la Tabla 14 | ⚠️ verificables en modo dobles y contra el modelo real; los de latencia y equidad, no. **Ninguno mide el sobre-escalamiento** |
| 4 | SSE válido terminando en `data: [DONE]` | ✅ forma literal byte a byte |
| 4 | Escalamiento → `transfer_to_number` con whitelist | ✅ sobre el núcleo real |
| 4 | Petición sin secreto → 401 | ✅ las tres vías |
| 5–7 | — | ⛔ **fuera de alcance**: exigen cuentas reales y hablantes con consentimiento |

## Lo que NO se ha verificado, y no puede verificarse aquí

- **Google Calendar, Meta y la telefonía real.** No hay cuentas. Una conversación de WhatsApp que acabe agendando en Calendar sigue sin ejecutarse de extremo a extremo.
- **El modelo obedeciendo el prompt, de forma sostenida.** Se ha ejercitado contra el modelo real, y ahí apareció el fallo del clasificador descrito arriba. Pero una pasada de la batería no es una garantía: el modo dobles prueba que *los controles atrapan* lo que el modelo pueda decir, no que el modelo se porte bien de manera estable.
- **El exceso de derivaciones.** Ninguna prueba lo mide. Es el hueco por el que se coló el fallo del clasificador.
- **Todo el canal de voz con audio real**: latencia por turno, gestión de turnos, barge-in y la brecha de comprensión por segmento de hablante.
- **Las asunciones sobre ElevenLabs** que su documentación no cubre: formato de streaming de `tool_calls`, header de autenticación entrante, composición del HMAC del webhook. Ver `contrato-elevenlabs.md`.

## Asuntos abiertos

Detalle completo en `decisiones.md`. Los principales:

1. **RLS vs `SUPABASE_SERVICE_KEY`** — decidido para v1 con deuda reconocida; el `audit_log` inalterable sí queda resuelto de verdad.
2. **`CalendarPort` sin sede ni profesional** — la clínica tiene dos sedes y especialistas que no atienden en ambas.
3. **Falta herramienta de cancelación** — y las fuentes se contradicen: la Tabla 13 la exige, el anti-patrón 10 fija cinco herramientas.
4. ~~**Umbral del RAG en 0.75, sin calibrar**~~ — **resuelto, y el modelo de embeddings también.**

   Con 0.75 el RAG devolvía lista vacía **siempre**, y el modo de fallo no era el silencio prudente que se buscaba: sin fragmentos el modelo rellenaba (llegó a afirmar que la clínica «solo cuenta con una sede única»).

   Comparados los cuatro modelos disponibles con consultas reales de esta clínica, midiendo el fragmento correcto frente a otro del mismo dominio pero de otro tema:

   | Modelo | Latencia | Correcto | Incorrecto (máx) |
   |---|---|---|---|
   | voyage-3 | 2972 ms | 0.366 – 0.784 | 0.280 |
   | voyage-3.5-lite | 974 ms | 0.519 – 0.724 | 0.340 |
   | voyage-3.5 | 1514 ms | 0.517 – 0.803 | 0.371 |
   | **voyage-3-large** | **1100 ms** | **0.575 – 0.839** | 0.446 |

   `voyage-3` era el más lento **y** el más frágil: su peor acierto quedaba en 0.366, a un pelo del umbral. Migrado a **`voyage-3-large`** con umbral **0.45**, y la base entera re-embebida — consulta y documentos tienen que venir del mismo modelo o la similitud no significa nada.

   Verificado contra la base real: las cinco consultas de prueba recuperan el fragmento correcto en primera posición, con 0.546 a 0.645 sobre un umbral de 0.45. Hay margen por los dos lados.
5. **Riesgo de doble locución al escalar por voz** — solo detectable con telefonía real.
6. **Revelación en WhatsApp sobre memoria de proceso** — frágil para un criterio bloqueante.
7. **No hay medida del sobre-escalamiento.** Ver el fallo del clasificador descrito arriba.

8. ~~**`escalar_humano` no tiene a quién notificar**~~ — **resuelto.** Con `N8N_WEBHOOK_URL` vacío la herramienta devolvía `error` y el escalamiento no llegaba a nadie, contra el control O5.

   Ahora `N8N_WEBHOOK_URL` apunta a un webhook desplegado y **publicado** en n8n Cloud (`POST /webhook/escalamiento`). Verificado por los **dos** canales: `escalar_humano` pasa de `error` a `ok`, y en n8n quedan las ejecuciones con la carga completa —clínica, motivo, prioridad, resumen para recepción, teléfono del paciente, canal y momento—.

   Dos matices que conviene no perder de vista:

   - El flujo desplegado es **solo el webhook**: recibe y registra. No manda SMS ni correo, así que sigue haciendo falta que alguien mire n8n. El flujo completo de `n8n/F4_notificar_escalamiento.json` añade consulta a Postgres y SMS por Twilio, y necesita esas credenciales.
   - El arnés de la web usa dobles y no pasa por `NotificationClient`, así que notifica al mismo destino por su cuenta (`scripts/web.ts`). Sin eso, n8n solo vería los escalamientos de voz.

   `/recepcion` en la demo local se mantiene como espejo para ver los avisos sin salir de la web.

9. **Plan gratuito de Voyage: 3 peticiones por minuto.** Cada turno con RAG consume una. En una conversación real el límite se alcanza enseguida y el RAG empieza a fallar — de forma silenciosa para el paciente, por el fail-safe. Requiere añadir método de pago en el panel de Voyage.

   Mitigado a medias: el 429 ya **no se reintenta**. Reintentar dentro del turno no sirve —la ventana del límite se mide en minutos— y el backoff empujaba el turno por encima del tiempo de espera del proveedor, que lo mataba con un error de cascada. Ahora falla rápido y el prompt declara que no dispone del dato. El límite sigue ahí: con él, parte de las respuestas salen sin conocimiento de la base.

10. **Latencia por turno de voz: mediana 4,0 s.** Sigue muy por encima del objetivo declarado (`VOICE_LATENCIA_OBJETIVO_MS=1200`), así que la expresión puente suena en todos los turnos.

    **Dónde se va el tiempo.** Medido con el prompt maestro real, una única llamada al modelo:

    | Configuración | Latencia (3 medidas) |
    |---|---|
    | sonnet-5, 1024 tokens, sin caché | 8395 / 6623 / 3568 ms |
    | sonnet-5, 1024 tokens, con caché | 5379 / 4446 / 3821 ms |
    | sonnet-5, 250 tokens, con caché | 3384 / 4344 / 4155 ms |
    | haiku-4.5, 250 tokens, con caché | **1042 / 1547 / 1170 ms** |

    El turno era, en esencia, **una sola llamada a Sonnet**. Hecho hasta ahora:

    - **Caché del prompt** sobre los bloques 1–7, que son idénticos en todos los turnos y se reenviaban en cada iteración del bucle de herramientas. Unos 2565 tokens leídos de caché por llamada.
    - **Modelo y tope de tokens propios del canal de voz** (`CLAUDE_MODEL_VOZ`, `CLAUDE_MAX_TOKENS_VOZ`). Con haiku-4.5 y 250 tokens la mediana baja de 5,7 s a 4,0 s.

    **El coste de esa decisión, que no es gratis:** haiku cumple peor el bloque de estilo. En las pruebas tuteó al paciente («¿en qué puedo ayudarte?») cuando el prompt exige tratar de usted. Los controles no dependen del modelo —las tres capas, el detector de urgencia y la validación de herramientas siguen igual—, pero el tono sí. Volver a Sonnet es quitar una línea del `.env`.

    **Segunda vuelta.** Añadido después: se **omite la recuperación en mensajes de pura cortesía** (un «hola» no necesita contexto y gastaba ~1,7 s de Voyage), se **desactiva la expresión puente** (`VOICE_BUFFER_WORD_MS=0`) porque al sonar en todos los turnos dejaba de ser un puente y era una coletilla, y el TTS pasa a `eleven_flash_v2_5` sin modo expresivo.

    **Resultado: mediana 3153 ms, media 3679 ms** (desde 5709 / 6040). Un saludo baja a ~2,7 s.

    **Lo que queda por debajo.** El modelo aporta ~1,2 s y el RAG ~1,7 s cuando toca consultarlo. Bajar de ~3 s exigiría cachear los embeddings de consulta, que no está hecho. El objetivo declarado de 1200 ms se fijó sin medir y no se alcanza ni con todo lo anterior: conviene revisarlo con datos antes de tratarlo como criterio de aceptación.

11. **El acento de la voz derivaba.** La voz peruana (`Nelly - Warm Peruvian Spanish`, `accent: peruvian`) sonaba a español de España. El `voice_id` no había cambiado nunca: el problema era la combinación de `eleven_v3_conversational` + `expressive_mode` + `stability: 0.5`.

    Se mantiene `expressive_mode` activo por decisión de producto —y con él `eleven_v3_conversational`, que es el único modelo que lo admite—, pero con **`stability: 0.75`** y `similarity_boost: 0.9`. Es la estabilidad la que sujeta el acento; bajarla vuelve a soltarlo.

    `eleven_flash_v2_5` es más rápido y más estable, pero **no soporta modo expresivo**: un PATCH que lo pida sobre ese modelo devuelve 200 y lo deja en `false`, sin avisar. Si algún día pesa más la latencia que la expresividad, ése es el cambio.

12. **haiku-4.5 no es apto para el canal de voz.** Se probó por velocidad y acumuló tres fallos, en orden de gravedad creciente:

    1. **Tuteaba al paciente**, contra el trato de usted que define la clínica. Se corrigió haciendo la regla explícita en `prompts/estilo.voz.md`.
    2. **Se equivocaba de fecha.** Un martes 4 de agosto, ante «el jueves más próximo», consultó la agenda del **7** —que era viernes— y se lo ofreció al paciente como jueves. Corregido dándole el calendario de los siete días siguientes ya resuelto en el bloque de sesión, en vez de pedirle que lo calcule.
    3. **Leía mal el resultado de las herramientas.** `consultar_agenda` devolvió un hueco libre a las 11:00 y el modelo respondió que **no había disponibilidad**, ofreciendo otra hora. Esto no se arregla con prompt: es comprensión.

    Comparación directa, misma pregunta y mismo calendario:

    | Modelo | Tiempo | Respuesta |
    |---|---|---|
    | haiku-4.5 | 4,3 s | «a las once no hay disponibilidad… tengo a las cuatro» ❌ |
    | sonnet-5 | 9,5 s | «El jueves seis a las once hay disponibilidad. ¿Confirmo?» ✅ |

    **`CLAUDE_MODEL_VOZ` queda en `claude-sonnet-5`.** Negarle a un paciente una cita que sí existe no es un problema de estilo: «citas creadas con fecha, hora o profesional incorrectos = 0» es criterio bloqueante de la Tabla 14, y un modelo que malinterpreta la disponibilidad lo incumple por el lado que no se ve.

    El coste es la latencia: se vuelve a ~9 s por turno en los turnos con herramientas. Es la tensión de fondo de este canal y no está resuelta — solo decidida hacia el lado seguro.

*(Resuelto: `scripts/demo.ts`, `migrate.ts` y `seed.ts` no importaban `dotenv`, así que no leían el `.env` que la guía manda rellenar. Los tres lo hacen ya.)*

## Canal de voz — mitad local verificada, mitad del proveedor sin configurar

**Lo nuestro funciona y está comprobado contra la base real:**

| Comprobación | Resultado |
|---|---|
| `GET /health` con `VOICE_ENABLED=true` | 200 · `{"voz":true}` |
| Gateway sin secreto / con secreto erróneo | **401** |
| Gateway con secreto válido | 200 · `text/event-stream` · respuesta real · cierra en `data: [DONE]` |
| Webhook de iniciación sin secreto | **401** |
| Webhook de iniciación con secreto | 200 · devuelve `dynamic_variables` y crea la fila de `calls` |
| Webhook post-llamada: firma válida / inválida / caducada | **200 / 401 / 401** |
| Encadenado iniciación → turno | `calls`, `transcripts` (2 líneas), `latency_metrics`, `audio_events` |

Todo ello también a través de un túnel público, no solo en `localhost`.

**El hueco «más grande» de `fase5-elevenlabs.md` está cerrado.** La vía para inyectar contexto en una llamada entrante existe: es el webhook de iniciación, implementado en `src/channels/voice/conversation-initiation.controller.ts`. Queda por verificar el último tramo —que ElevenLabs entregue esas variables al Custom LLM dentro de `elevenlabs_extra_body`—, y eso solo lo dice una llamada real.

**Lo que falta está todo del lado del proveedor**, y hasta que se resuelva no hay llamada posible:

- **Ningún número de teléfono.** Ni en la cuenta de Twilio (Trial, 0 números) ni en ElevenLabs (`/v1/convai/phone-numbers` devuelve `[]`).
- **El agente no está en Custom LLM**: `prompt.custom_llm` es `null` y `llm` apunta a un modelo del proveedor. Mientras siga así, el núcleo entero —prompt maestro, las tres capas de guardrails, las cinco herramientas y el RAG— **no interviene en la llamada**.
- **Los cuatro system tools sin habilitar**, así que no hay `transfer_to_number`: una urgencia no se podría derivar por teléfono.
- **Los dos webhooks sin dar de alta** en el agente.
- **`retention_days = -1`, es decir retención ILIMITADA, con `record_voice = true`.** Contradice `RETENCION_AUDIO_DIAS=0` y `AUDIO_RETENTION=false`, y va en contra del control C8: el audio es dato biométrico asociado a dato de salud.

Bien: el `first_message` sí lleva el guion de revelación completo —menciona que es una IA y que la llamada se graba— y el system prompt del agente está prácticamente vacío, como debe.

13. **DEFECTO ABIERTO: el modelo sigue inventando cuando el RAG no recupera.** Ante «vivo por Magdalena», respondió **«trabajamos con sede única»** — la clínica tiene 24. Reproducible: en otra pasada sí recuperó y contestó bien («la más cercana es Pueblo Libre»).

    La causa no es el dato: está en la base, en la guía de sedes por zona. Es que una consulta con poca señal —un nombre de distrito suelto, dentro de una frase con el nombre del paciente— no siempre supera el umbral, y cuando no recupera nada **el modelo rellena** en vez de decir que no lo sabe.

    Es la misma raíz que el caso de «solo cuenta con una sede única» de antes: **«nunca inventar datos ausentes de la base» no tiene control automático en capa 2**. Solo la vigila el prompt, y el prompt no basta.

    Dos vías, ninguna hecha:
    - **Meter las sedes en el bloque de sesión del prompt**, no en el RAG. Son 24 líneas de datos de la clínica que ya están cargadas en `clinic.config`: no deberían depender de una búsqueda semántica que puede fallar.
    - **Un control de capa 2 para esta línea roja**, que es lo que la haría un control y no una expectativa. Es trabajo de diseño, no de una tarde.

    Mientras tanto, el riesgo real es que el agente niegue una sede que existe y pierda al paciente.

## Demostración

Dos arneses sobre el **mismo** montaje del núcleo (`scripts/nucleo-demo.ts`), para que no puedan divergir:

```bash
npm run demo         # conversación en la terminal
npm run demo:web     # web local de la clínica, chat incluido
```

`npm run demo:web` levanta `http://localhost:4000` y sirve `web/`: la página de la Clínica Dental Aurora con el chat como elemento central. El turno se envía como canal `whatsapp` —el estilo de texto—, así que **no es un tercer canal**: `src/channels/` sigue teniendo dos y el núcleo no sabe que esa página existe. La clave del modelo nunca llega al navegador.

En ambos: persistencia en memoria, RAG por coincidencia de palabras (peor que el real) y agenda simulada. El prompt, los tres controles y las cinco herramientas sí son los reales.

## Correcciones hechas a los documentos originales

- El proveedor de voz **no documenta header de autenticación** hacia nuestro endpoint. Resuelto con tres vías.
- **Zero Retention Mode es exclusivo de Enterprise**, por agente.
- **El criterio de la Fase 1 es literalmente falso**: el bloque 9 también difiere entre canales.
- El **Anexo C** no incluye 11 variables de entorno que el sistema necesita.
