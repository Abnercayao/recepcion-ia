# Fase 5 — Puesta en marcha del agente en ElevenLabs

Guía **operativa**, para quien ya tiene cuenta de ElevenLabs y va a configurar el agente contra este repositorio.

No es documentación de diseño: para eso están `contrato-elevenlabs.md` (lo que el proveedor garantiza de verdad y lo que no) y `decisiones.md` (por qué está construido así). Aquí solo están los pasos, en orden, y al final la lista de lo que **no se puede dar por bueno hasta hacer una llamada real**.

> **Nada de esta guía se ha ejecutado.** El código de las Fases 0–4 está construido y probado con dobles; esta fase requiere una cuenta y una llamada telefónica real. Cada paso está escrito a partir del contrato verificado con la documentación oficial, no de una ejecución.

---

## 0. Antes de tocar el panel

Ten esto resuelto o los pasos siguientes no se pueden completar:

| Requisito | Comprobación |
|---|---|
| Base de datos migrada | `npm run db:migrate` (necesita `SUPABASE_DB_URL`, no la service key) |
| Base de conocimiento cargada | `npm run db:seed` |
| Clínica creada con `transfer_whitelist` poblada | sin ella el sistema **no arranca** con `VOICE_ENABLED=true` |
| Número de teléfono | SIP trunking o integración nativa de Twilio, del lado de ElevenLabs |
| Endpoint alcanzable desde internet | ver §7 (túnel en desarrollo) |

Variables de entorno que vas a rellenar en esta fase:

```bash
VOICE_ENABLED=true
ELEVENLABS_API_KEY=          # panel → perfil → API Keys
ELEVENLABS_AGENT_ID=         # lo devuelve el panel al crear el agente (paso 1)
VOICE_GATEWAY_URL=           # URL pública de tu gateway (paso 7)
VOICE_GATEWAY_SECRET=        # lo eliges tú; protege NUESTRO endpoint
ELEVENLABS_WEBHOOK_SECRET=   # lo genera ElevenLabs; firma SU webhook (paso 6)
TRANSFER_WHITELIST=+51987000111,+51987000222
RETENCION_AUDIO_DIAS=0
AUDIO_RETENTION=false
```

**`VOICE_GATEWAY_SECRET` y `ELEVENLABS_WEBHOOK_SECRET` son dos secretos distintos con dos direcciones distintas.** El primero protege nuestro endpoint frente a peticiones que no vengan de ElevenLabs (§2 del contrato). El segundo es con el que ElevenLabs firma lo que nos manda al terminar la llamada (§7). Ponerles el mismo valor «para simplificar» funciona por accidente y deja los dos controles acoplados: si rotas uno, rompes el otro sin darte cuenta.

---

## 1. Crear el agente y apuntarlo al Custom LLM

Panel → **Agents** → *Create agent* → en la sección de LLM elige **Custom LLM**.

**URL a poner — es una URL BASE, sin `/chat/completions` al final:**

```
https://TU-DOMINIO/v1/g/EL-VALOR-DE-VOICE_GATEWAY_SECRET
```

Ejemplo con un túnel de desarrollo y el secreto `s3cr3t-de-desarrollo`:

```
https://tu-tunel.trycloudflare.com/v1/g/s3cr3t-de-desarrollo
```

⚠ **El proveedor añade `/chat/completions` él mismo.** Es el mismo criterio que sus guías para proveedores OpenAI-compatibles: la de Together AI indica literalmente `https://api.together.xyz/v1`, y la petición sale contra `https://api.together.xyz/v1/chat/completions`.

Si pones la ruta completa, la llamada acaba en `.../chat/completions/chat/completions` y el gateway responde **404** en cada turno. Este documento lo dijo mal hasta que se comprobó contra el panel real: la versión anterior incluía la ruta final.

Verificación rápida de que la URL base es la buena — **añádele tú `/chat/completions`** y comprueba que responde:

```bash
curl -N -X POST https://TU-DOMINIO/v1/g/<SECRETO>/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"x","stream":true,"messages":[{"role":"user","content":"Hola"}],
       "elevenlabs_extra_body":{"clinic_id":"<UUID>","session_id":"p1","phone":"+51987654321"}}'
```

Contra la URL base **sin** esa ruta, un 404 es lo esperado y no indica ningún problema.

### Por qué el secreto va en la ruta

La documentación oficial **no especifica ningún header de autenticación** que ElevenLabs envíe hacia un endpoint Custom LLM (`contrato-elevenlabs.md` §2). La especificación del proyecto asume «secreto compartido en header» y el criterio de aceptación de la Fase 4 exige que una petición sin secreto devuelva 401. Eso deja un control que solo existiría si el proveedor colaborase.

El gateway acepta el secreto por **tres vías simultáneas** y rechaza con 401 si no coincide ninguna:

1. `Authorization: Bearer <VOICE_GATEWAY_SECRET>` — lo más probable, por ser una interfaz OpenAI;
2. `x-gateway-secret: <VOICE_GATEWAY_SECRET>`;
3. **segmento secreto en la ruta** ← ésta.

La 3 es la única que funciona con certeza **aunque el proveedor no envíe header alguno**, porque la URL sí la controlamos nosotros. Si el panel te ofrece además un campo de API key o de headers personalizados, rellénalo también con el mismo valor: las tres vías conviven y cualquiera que coincida basta.

> Consecuencia operativa: **la URL del Custom LLM contiene un secreto**. Trátala como una credencial — no la pegues en tickets, capturas ni chats. Rotarla significa cambiar `VOICE_GATEWAY_SECRET` y volver a editar la URL en el panel.

**Model id:** cualquier identificador propio (p. ej. `recepcion-ia-voice`). El gateway lo devuelve tal cual en los chunks SSE y no elige modelo con él: el modelo real lo fija `CLAUDE_MODEL_CONVERSACION`.

Copia el `agent_id` que te da el panel a `ELEVENLABS_AGENT_ID`.

---

## 2. `first_message` — el guion de revelación, literal

Campo **First message** del agente. Pega exactamente esto, sustituyendo `{{clinica}}` por el nombre de la clínica (o dejándolo como variable dinámica si la vas a inyectar):

```
Hola, le atiende el asistente virtual de {{clinica}}. Soy un asistente de
inteligencia artificial, no una persona. Esta llamada puede ser grabada y
compartida con nuestros proveedores de servicio para fines de calidad y mejora
del servicio. Si en cualquier momento prefiere hablar con una persona, dígamelo
y le transfiero. ¿En qué le puedo ayudar?
```

Es el guion de la §7 de la especificación, y **no es configurable por el cliente**. Cubre los dos elementos que exige la obligación de transparencia (`contrato-elevenlabs.md` §6): (1) que se está interactuando con una IA y no con una persona, y (2) que la conversación se graba y puede compartirse. Formatos aceptados por el proveedor: pantalla previa, pop-up, banner persistente o **divulgación verbal al inicio de la llamada** — que es lo que hace `first_message`.

**El sistema comprueba esto de verdad, no lo da por hecho.** El webhook post-llamada (`src/channels/voice/post-call.controller.ts`) lee la primera intervención del agente en la transcripción real y verifica que contenga los dos elementos:

- si los contiene → marca `calls.disclosure_ejecutada = true` y escribe `disclosure_verificada` en `audit_log`;
- si falta alguno → **no marca nada**, registra en nivel `error` y escribe `disclosure_incumplida` en `audit_log`. Es criterio **bloqueante** de la Fase 5.

Si acortas el guion y quitas la mención a la grabación, la llamada seguirá funcionando pero quedará registrada como incumplimiento. Está hecho a propósito: es el único punto del sistema que ve la transcripción real y puede afirmar con evidencia que el aviso sonó.

---

## 3. System prompt del agente: mínimo o vacío

**Deja el campo de system prompt del agente vacío**, o con una sola línea neutra del tipo «Sigue las instrucciones del LLM configurado».

La personalidad, las siete reglas invariables, el bloque de estilo de voz, las restricciones de dominio (nunca diagnosticar, nunca cerrar precios que requieren valoración, nunca afirmar ser humano…) y el contexto de sesión viven en el **prompt maestro del núcleo**, en `prompts/`, y los ensambla `prompt.builder.ts` en cada turno.

Duplicarlas en el panel crea **dos fuentes de verdad** que divergen en cuanto alguien edita una sola de las dos. El fallo es especialmente malo aquí porque es silencioso: el modelo recibiría instrucciones contradictorias y elegiría, y no habría forma de saber cuál ganó mirando el repositorio. Las tres capas de guardrails están calibradas contra el prompt del núcleo; un prompt paralelo en el panel no pasa por ninguna de ellas.

Lo mismo aplica a la **base de conocimiento del panel**: no la uses. El conocimiento aprobado vive en `knowledge_chunks` y se recupera con `consultar_rag`, que filtra por `clinic_id` y por `activo = true` (control C9). Cargar documentos en el panel salta ese filtro por completo.

---

## 4. Los cuatro system tools y la lista blanca del proveedor

Habilita en el agente **exactamente estos cuatro**, ni uno más:

| Tool | Parámetros (confirmados, `contrato-elevenlabs.md` §4) |
|---|---|
| `transfer_to_number` | `transfer_number` (req) · `client_message` (req) · `agent_message` (req) · `reason` (opt) |
| `end_call` | `reason` (req) · `message` (opt) |
| `language_detection` | `reason` (req) · `language` (req) |
| `skip_turn` | `reason` (opt) |

**No registres ninguna herramienta de negocio en ElevenLabs.** `consultar_agenda`, `crear_cita`, `consultar_rag`, `guardar_lead` y `escalar_humano` se ejecutan **dentro del núcleo**, con sus validaciones defensivas y su registro en `tool_calls`. Exponerlas al proveedor es el anti-patrón 3: duplica definiciones y saca la validación del núcleo. Por SSE solo sale el texto final.

### Lista blanca de transferencia — se configura DOS veces, a propósito

En `transfer_to_number`, el **destino se declara en el agente**: el modelo solo puede referenciar un número ya configurado en el panel, no pasar uno libremente. Eso es una segunda lista blanca, del lado del proveedor.

Configura en el panel **los mismos números** que pusiste en `TRANSFER_WHITELIST` (formato E.164, con `+`). Las dos listas son independientes y las dos tienen que dejar pasar el número:

- la nuestra (`clinics.transfer_whitelist`, leída de la clínica en cada turno — **nunca del request**) la aplica `system-tools.mapper.ts` antes de emitir el `tool_call`;
- la del panel la aplica ElevenLabs al ejecutarlo.

Si divergen, la transferencia falla del lado que sea más restrictivo. El escalamiento **no se pierde** por eso: `escalar_humano` ya habrá notificado a recepción por el canal de respaldo (control O5, el modo de fallo del sistema es la reversión a operación manual, nunca el silencio). Pero el paciente no oirá la derivación, así que revisa que las dos listas coincidan.

### Conversation flow

Configura turn-taking, interrupciones (barge-in) y timeouts. **Aquí no hay valores recomendados que podamos dar con fundamento**: dependen del audio real y de cómo hable el paciente. Es lo primero a ajustar tras la primera llamada.

Nota: el gateway ya emite una expresión puente (`"Un momento, por favor... "`, con elipsis **más espacio** — el espacio es obligatorio o el sintetizador la pega a la palabra siguiente) cuando el primer token tarda más de `VOICE_BUFFER_WORD_MS`. Que eso se oiga **no es una solución, es la señal de que hay que optimizar**; queda registrado como evento `silencio` en `audio_events`.

---

## 5. Privacidad: retención de audio desactivada

Panel → **Agent Settings → Advanced → Data Retention**.

- **`retention_days = 0`** → borrado inmediato. **`-1`** → retención ilimitada (no lo pongas).
- Retención de conversación (texto) según la política declarada; en este repositorio, `RETENCION_TRANSCRIPCION_DIAS=365`.

Del lado nuestro, deja `RETENCION_AUDIO_DIAS=0` y `AUDIO_RETENTION=false`. `config.ts` **rechaza arrancar** si pones `AUDIO_RETENTION=true` con `RETENCION_AUDIO_DIAS=0`: es una contradicción y el audio es dato biométrico asociado a dato de salud (control C8), así que se decide explícitamente o no se arranca.

> ⚠ **Zero Retention Mode es otra cosa, y es exclusivo de Enterprise.** Es una funcionalidad distinta de `retention_days`: se activa por agente en *Privacy settings* y restringe el **logging** de audio y texto de STT, TTS y de la entrada/salida del agente. `retention_days = 0` solo fija cuánto se conserva lo que ya se registró; no impide que se registre. Si el caso de uso exige HIPAA, hace falta además un **BAA vigente**. Si tu plan no es Enterprise, esta casilla no existe y hay que decirlo así en el informe, no darla por evaluada.

Existe `ElevenLabsClient.updateRetentionDays()` en `src/infra/elevenlabs.client.ts` para hacerlo por API, pero **la URL del endpoint es una asunción sin verificar** (ver la cabecera de ese archivo, «ASUNCIÓN SIN VERIFICAR #2»). Para la puesta en marcha, hazlo por el panel y comprueba visualmente el valor.

---

## 6. Webhook post-llamada

Panel → sección de **Webhooks** (post-call webhooks) → añade un endpoint:

```
https://TU-DOMINIO/webhooks/elevenlabs/post-call
```

**El secreto de firma sale ahí mismo**: al crear el webhook, el panel muestra un *signing secret* (se enseña **una sola vez**; cópialo en ese momento). Ese valor va a `ELEVENLABS_WEBHOOK_SECRET`. No es la API key, no es `VOICE_GATEWAY_SECRET`.

Qué hace nuestro endpoint con cada uno de los tres payloads documentados (`contrato-elevenlabs.md` §7):

| Payload | Qué hacemos |
|---|---|
| **Transcripción** (`transcript[]`, `status`, `metadata`) | Reconcilia con las líneas que el gateway ya escribió turno a turno — **no las duplica** —, verifica el guion de revelación, y cierra la llamada (`call_status`, `finalizada_en`, `voice_duration_s`). |
| **Audio** (`full_audio`, base64 MP3) | Con `RETENCION_AUDIO_DIAS=0` se **descarta sin escribirlo** y queda constancia en `audit_log` (`audio_post_llamada_descartado`). El base64 nunca se loguea. |
| **Fallo de inicio** (`failure_reason`: `busy` \| `no-answer` \| `unknown`) | Marca la llamada como `fallida` con `voice_duration_s = 0` y audita `llamada_no_iniciada`. **No** marca la revelación: una llamada que no se estableció no pudo ejecutarla, y marcarla inflaría el porcentaje de cumplimiento con llamadas que nunca ocurrieron. |

Comportamiento de seguridad, sin excepciones: **firma inválida, malformada, ausente o con timestamp fuera de la ventana de tolerancia (5 min por defecto) → 401 y no se procesa nada.** Si el despliegue no tiene `ELEVENLABS_WEBHOOK_SECRET`, el endpoint rechaza *todo* con 401 y lo grita en el arranque en nivel `fatal` — falla cerrado, pero ruidoso.

## 6b. Webhook de iniciación — sin esto no hay canal de voz entrante

Panel → en la sección de webhooks del agente, **«Añadir webhook»** para recuperar `conversation_initiation_client_data` al iniciarse una llamada de Twilio.

```
POST https://TU-DOMINIO/webhooks/elevenlabs/g/<VOICE_GATEWAY_SECRET>/conversation-initiation
```

Mismo secreto y mismas tres vías que el Custom LLM: los dos endpoints protegen la misma frontera y en la misma dirección. No hace falta añadir encabezados si el secreto va en la ruta.

**Es la pieza que hace funcionar el canal.** El gateway necesita `clinic_id` y el teléfono para resolver el contexto; en una llamada entrante no hay SDK cliente que los inyecte, y este webhook es la única vía. Sin él, cada llamada acaba en el mensaje de respaldo y en una derivación a recepción.

Nuestro endpoint responde:

```json
{
  "type": "conversation_initiation_client_data",
  "dynamic_variables": {
    "clinic_id": "…", "session_id": "…", "phone": "+51…", "clinica": "Clínica Dental Aurora"
  }
}
```

`clinica` alimenta el `{{clinica}}` del `first_message`. `session_id` lo generamos nosotros: es la clave con la que el gateway encuentra la llamada en cada turno, y con la que se crea la fila de `calls`.

Requiere `CLINIC_ID` en el entorno. Con `VOICE_ENABLED=true` y sin ella, el sistema **no arranca**: una llamada entrante que no se puede atribuir a una clínica no se debe atender.

### Recomendación: no te suscribas al webhook de audio

Si la retención de audio está desactivada (que es la configuración correcta aquí), **no suscribas el evento de audio en el panel**. Dos razones:

1. El mejor control sobre un dato biométrico es que no salga del proveedor. Recibirlo para tirarlo es peor que no recibirlo.
2. El servidor tiene `bodyLimit` de **1 MiB** (`src/server.ts`). Un MP3 completo en base64 lo supera con holgura en cualquier llamada de más de un minuto, así que el webhook de audio recibiría **413** y ElevenLabs lo reintentaría. El endpoint acepta un `bodyLimitBytes` propio si algún día hace falta, pero subirlo para descartar el contenido no tiene sentido.

Si aun así llega audio, el controlador lo descarta correctamente. Lo que no puede hacer es guardarlo: **no hay columna ni almacén de audio en el esquema**, y si la política llegara a permitir retenerlo, el sistema lo dice en nivel `error` en vez de fingir que lo guardó.

---

## 7. Exponer el endpoint local en desarrollo

ElevenLabs necesita alcanzar tu máquina tanto para el Custom LLM (cada turno) como para el webhook (al colgar). En local hace falta un túnel:

```bash
# Cualquiera de los dos sirve. El puerto es el de PORT (por defecto 3000).
cloudflared tunnel --url http://localhost:3000
ngrok http 3000
```

Arranca el servidor **antes** del túnel:

```bash
npm run build && npm start     # o: npm run dev
```

La única variable de entorno que tocas por el túnel es **`VOICE_GATEWAY_URL`** — y es puramente informativa para nuestro lado; lo que de verdad manda es la **URL que pegas en el panel de ElevenLabs**, en dos sitios:

1. **Custom LLM** → `https://<túnel>/v1/g/<VOICE_GATEWAY_SECRET>/chat/completions`
2. **Post-call webhook** → `https://<túnel>/webhooks/elevenlabs/post-call`

⚠ Los túneles gratuitos **cambian de dominio en cada reinicio**. Cada vez que reinicies el túnel hay que editar esas dos URLs en el panel. Si el agente empieza a fallar sin que hayas tocado nada, ése es el primer sospechoso.

### Comprobación rápida antes de llamar por teléfono

```bash
# 1. Salud del proceso
curl https://<túnel>/health
# → {"estado":"ok","canales":{"whatsapp":false,"voz":true}}

# 2. El gateway rechaza sin secreto (criterio de aceptación de la Fase 4)
curl -i -X POST https://<túnel>/v1/chat/completions \
  -H 'content-type: application/json' -d '{"messages":[]}'
# → HTTP/1.1 401

# 3. El webhook rechaza sin firma
curl -i -X POST https://<túnel>/webhooks/elevenlabs/post-call \
  -H 'content-type: application/json' -d '{"data":{}}'
# → HTTP/1.1 401

# 4. Con el secreto en la ruta, SSE válido terminado en [DONE]
curl -N -X POST https://<túnel>/v1/g/<VOICE_GATEWAY_SECRET>/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"recepcion-ia-voice","stream":true,
       "messages":[{"role":"user","content":"Hola"}],
       "elevenlabs_extra_body":{"clinic_id":"<UUID>","session_id":"prueba-1","phone":"+51987654321"}}'
```

Si el paso 4 devuelve el mensaje de respaldo («fallo técnico») en vez de una respuesta normal, mira el log: casi siempre es un `clinic_id` que no es un UUID válido o que no existe en `clinics`.

### Después de la primera llamada real, comprueba en la base

```sql
select call_status, disclosure_ejecutada, voice_duration_s, finalizada_en,
       elevenlabs_conversation_id
  from calls order by iniciada_en desc limit 1;

-- Sin líneas duplicadas: la reconciliación del webhook funcionó.
select hablante, texto, ts_inicio_ms from transcripts
 where call_id = '<id>' order by ts_inicio_ms nulls last;

-- Latencia por turno (Fase 5 pide percentiles contra VOICE_LATENCIA_OBJETIVO_MS).
select turno, llm_ms, total_ms from latency_metrics where call_id = '<id>' order by turno;

-- Barge-in y expresiones puente.
select tipo, ts, payload from audio_events where call_id = '<id>' order by ts;

-- Evidencia de cumplimiento.
select evento, detalle from audit_log
 where evento in ('disclosure_verificada','disclosure_incumplida','audio_post_llamada_descartado');
```

---

## QUE NO PODEMOS VERIFICAR

Todo lo de esta sección está construido según lo que la documentación oficial dice o —cuando no dice nada— según una asunción **declarada**. Ninguna de estas cosas se confirma sin una llamada telefónica real. Están ordenadas por lo que más duele si la asunción es falsa.

### 1. ~~De dónde sale `elevenlabs_extra_body` en una llamada entrante~~ — RESUELTO

**La vía existe: el webhook de iniciación.** El panel lo ofrece como *«Añadir un webhook para recuperar `conversation_initiation_client_data` cuando se inicia una llamada de Twilio»*. ElevenLabs lo llama al entrar la llamada, antes de que el agente hable, y usa la respuesta como datos de iniciación de esa conversación.

Implementado en `src/channels/voice/conversation-initiation.controller.ts` (paso 6b de esta guía). Devuelve `clinic_id`, `session_id`, `phone` y `clinica` como `dynamic_variables`, y de paso crea la fila de `calls` —lo único que permite persistir transcripción y latencias—.

**Lo que sigue sin verificar** es el último tramo: que ElevenLabs entregue esas `dynamic_variables` al Custom LLM **dentro de `elevenlabs_extra_body`**. Es lo primero que hay que mirar en la primera llamada real. Si no llegan ahí, el arreglo es local: leerlas de donde vengan, en `voice-session.service.resolverContexto`.

### 2. Doble locución al escalar (`decisiones.md`, vacío abierto 6)

Cuando el núcleo escala, el mensaje para el paciente sale **dos veces**: por el stream SSE como texto (que ElevenLabs sintetiza) y otra vez como `client_message` de `transfer_to_number`. La especificación pide explícitamente esa asignación de campos, así que está implementada tal cual.

Según cómo ejecute ElevenLabs la herramienta, el paciente podría **oír lo mismo repetido justo en el momento de una urgencia**, que es el peor momento posible para que el sistema suene defectuoso. No es comprobable sin telefonía real.

Si ocurre: la corrección es local: dejar de emitir el texto por SSE cuando el turno acaba en `transfer_to_number` y confiar solo en `client_message`, o al revés. Está aislado en `voice-gateway.controller.ts` (`emitirTransferencia`).

### 3. Composición del string firmado del webhook

`contrato-elevenlabs.md` §7 dice literalmente que **la composición exacta del string firmado no está documentada** y que se delega en el SDK oficial. No hay SDK instalado (el contrato de construcción prohíbe añadir dependencias), así que se asume el patrón de Stripe: `` `${timestamp}.${rawBody}` ``, aislado en `buildSignedPayload()` de `src/infra/elevenlabs.client.ts`.

**Síntoma si la asunción es falsa: el webhook devolverá 401 siempre** y la transcripción no se consolidará nunca — de forma silenciosa desde el punto de vista de la llamada, que habrá ido bien. Antes de dar la fase por buena, comprueba que llegan filas nuevas a `transcripts` con `ts_inicio_ms` informado. Si no llegan, éste es el primer sospechoso y el arreglo es de una línea.

### 4. Autenticación entrante hacia el Custom LLM

No documentada (§2). Por eso hay tres vías y por eso la recomendación es la del segmento en la ruta. Lo que no se puede verificar sin tráfico real es **si ElevenLabs envía algún header** que permitiera prescindir de tener el secreto en la URL. Si resulta que sí, cambiar la URL del panel a `/v1/chat/completions` y configurar el header es una mejora inmediata.

### 5. Formato de streaming de `tool_calls`

Tampoco documentado (§3): la documentación solo muestra ejemplos estáticos completos. Como la implementación de referencia del proveedor es un proxy literal del SDK de OpenAI, **asumimos el formato de streaming de OpenAI** (primer fragmento con `index` + `id` + `function.name`, siguientes con `arguments` incremental, cierre con `finish_reason: "tool_calls"`). Está aislado en `openai-sse.mapper.ts`.

Síntoma si es falso: el agente habla con normalidad pero **las transferencias y los `end_call` no se ejecutan nunca**. Se detecta comparando `audio_events` de tipo `transferencia` con lo que realmente pasó en la llamada.

### 6. Dónde reaparece nuestro `session_id` en el payload post-llamada

El webhook trae el `conversation_id` de ElevenLabs, pero `CallRepository` no tiene un `findByElevenlabsConversationId` (el índice existe en la migración 001, el método en el puerto no). El controlador busca la fila por **nuestro** `session_id`, probándolo en varias ubicaciones plausibles del payload —`conversation_initiation_client_data.dynamic_variables`, `metadata`, raíz— **ninguna confirmada**, y cae al `conversation_id` como último recurso.

Si ninguna acierta, el webhook responderá 200 (correctamente: la firma era válida) pero no consolidará nada y dejará un `warn` de «no hay fila en `calls`». Comprobar en el primer webhook real dónde viene el `session_id` y, si hace falta, ajustar `RUTAS_DE_SESSION_ID`.

### 7. Los criterios de aceptación que exigen audio y personas

- **Latencia por turno dentro del objetivo** (`VOICE_LATENCIA_OBJETIVO_MS=1200`). `llm_ms` y `total_ms` los medimos nosotros; **`stt_ms` y `tts_ms` los mide ElevenLabs y el gateway no los ve**, así que se guardan como `NULL` a propósito en vez de inventarlos. La latencia total percibida por el paciente **no es observable desde este código**: sale del panel de conversaciones del proveedor.
- **Barge-in registrado en `audio_events`.** El tipo existe en el esquema, pero el gateway no recibe ningún evento de interrupción del proveedor: esa fila **hoy no la escribe nadie**. Si el criterio se sostiene, hace falta una vía (webhook o evento cliente→servidor) que aún no está identificada.
- **Equidad de comprensión por segmento de hablante** (Fase 7, bloqueante para producción de voz). Exige hablantes reales con consentimiento informado. No es un problema técnico.
- **Retención `0` aplicada de verdad.** Podemos ver que el panel dice `0`; que el proveedor lo cumpla en su infraestructura es una afirmación suya, no una verificación nuestra.

---

## Resumen de una página

1. Túnel arriba → apuntar las **tres** URLs del panel a él.
2. Custom LLM con la URL **base** `/v1/g/<VOICE_GATEWAY_SECRET>` — sin `/chat/completions`, que lo añade el proveedor. **Comprueba que el agente quedó en Custom LLM**: si `llm` sigue con un modelo del proveedor, el núcleo entero —prompt maestro, guardrails y herramientas— no interviene en la llamada.
3. Webhook de iniciación en `/webhooks/elevenlabs/g/<VOICE_GATEWAY_SECRET>/conversation-initiation`. Sin él no hay canal de voz entrante.
4. `first_message` = guion de la §7, **literal**. System prompt del agente **vacío**.
5. Los **cuatro** system tools; ninguna herramienta de negocio; whitelist en el panel = `TRANSFER_WHITELIST`.
6. `retention_days = 0`. **`-1` es retención ilimitada**: en un contexto sanitario es lo contrario de lo que pide el control C8. Zero Retention Mode solo si el plan es Enterprise.
7. Webhook post-llamada → `/webhooks/elevenlabs/post-call`, secreto a `ELEVENLABS_WEBHOOK_SECRET`. Sin suscribir el evento de audio.
8. Llamar, colgar, y **mirar la base**: `disclosure_ejecutada`, `transcripts` sin duplicados, `latency_metrics`, `audit_log`.

### Comprobar la configuración sin abrir el panel

La API de ElevenLabs devuelve el agente entero. Merece la pena mirarlo antes de llamar, porque el panel es fácil de dejar a medias:

```bash
curl -s -H "xi-api-key: $ELEVENLABS_API_KEY" \
  https://api.elevenlabs.io/v1/convai/agents/$ELEVENLABS_AGENT_ID
```

Lo que tiene que salir: `prompt.custom_llm` **no nulo**, `platform_settings.privacy.retention_days` en `0`, los cuatro `built_in_tools` habilitados, y `conversation_initiation_client_data_webhook` y `post_call_webhook_id` **con valor**. Y en `/v1/convai/phone-numbers`, el número dado de alta y asignado a este agente.
