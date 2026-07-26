# Contrato real de ElevenLabs — verificado contra la documentación oficial

Verificación hecha durante esta construcción. **Todo lo marcado `NO DOCUMENTADO` es una decisión nuestra, no una garantía del proveedor**, y debe confirmarse en el panel de la cuenta antes de producción.

## 1. Request que ElevenLabs envía a `POST /v1/chat/completions`

Campos de nivel superior confirmados:

```
messages: Array<{ role: string; content: string }>
model: string
temperature?: number
max_tokens?: number
stream?: boolean
user_id?: string
elevenlabs_extra_body?: object      // CONFIRMADO: este es el nombre exacto
tools?: Array<...>                   // formato OpenAI, cuando hay system tools habilitados
```

`elevenlabs_extra_body` **no es un campo válido de la API de OpenAI**: la implementación de referencia lo extrae del body antes de reenviar. Nosotros lo consumimos para obtener `clinic_id`, `session_id` y teléfono.

Se configura desde el SDK al iniciar la conversación (`ConversationConfig(extra_body=...)`), no como campo estático del panel.

## 2. ⚠ Autenticación entrante — NO DOCUMENTADO

**La documentación oficial no especifica ningún header de autenticación que ElevenLabs envíe a nuestro endpoint.** La especificación del proyecto (§5, paso 1) asume un "secreto compartido en header", y el criterio de aceptación de la Fase 4 exige que una petición sin secreto devuelva 401.

**Decisión adoptada:** el gateway acepta el secreto por **tres vías simultáneas**, y rechaza con 401 si ninguna coincide:

1. `Authorization: Bearer <VOICE_GATEWAY_SECRET>` (lo más probable, por ser interfaz OpenAI)
2. `x-gateway-secret: <VOICE_GATEWAY_SECRET>`
3. **Segmento secreto en la ruta**: `POST /v1/g/<VOICE_GATEWAY_SECRET>/chat/completions`

La vía 3 es la única que funciona con certeza aunque el proveedor no envíe header alguno, porque la URL del Custom LLM sí es configurable por nosotros. Es el respaldo que hace que el control exista de verdad.

## 3. Response SSE esperada

Confirmado literalmente: cada chunk como `data: {json}\n\n`, cierre con `data: [DONE]\n\n`.

Forma del chunk (`chat.completion.chunk`):

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion.chunk",
  "created": 1234567890,
  "model": "...",
  "choices": [{ "delta": { "content": "..." }, "index": 0, "finish_reason": null }]
}
```

**Streaming de `tool_calls`: NO DOCUMENTADO.** La documentación solo muestra ejemplos estáticos completos. Como la implementación de referencia es un proxy literal del SDK de OpenAI, asumimos el formato de streaming de OpenAI: primer fragmento con `index` + `id` + `function.name`, siguientes con `index` + `function.arguments` incremental, cierre con `finish_reason: "tool_calls"`. **Es una inferencia nuestra.**

**Esquema de `Message` para round-trips de tool calling: NO DOCUMENTADO.** El ejemplo oficial solo define `{role, content}`, insuficiente para mensajes `assistant` con `tool_calls[]` y mensajes `role: "tool"` con `tool_call_id`. Asumimos el estándar OpenAI.

## 4. System tools — nombres de parámetros confirmados

Se exponen al Custom LLM dentro de `tools[]` en formato OpenAI. Cita oficial: *"system tools are exposed as function definitions that your LLM can call"*.

| Tool | Parámetros exactos |
|---|---|
| `transfer_to_number` | `transfer_number` (req) · `client_message` (req) · `agent_message` (req) · `reason` (opt) |
| `end_call` | `reason` (req) · `message` (opt) |
| `language_detection` | `reason` (req) · `language` (req) |
| `skip_turn` | `reason` (opt) |

Coinciden exactamente con lo que asumía la especificación. **El destino de la transferencia se declara en el agente**, no se pasa libremente: el modelo solo puede referenciar un número ya configurado. Eso es una segunda lista blanca, del lado del proveedor, que se suma a la nuestra.

## 5. Privacidad — dos mecanismos distintos, no confundir

- **`retention_days`** bajo `platform_settings.privacy`: `-1` = ilimitada, `0` = borrado inmediato. En el panel: Agent Settings → Advanced → Data Retention. *(Dato de resumen, no verificado carácter a carácter: confírmalo en el panel.)*
- **Zero Retention Mode**: feature distinta, **solo Enterprise**. Se activa por agente en "Privacy settings". Restringe el logging de audio/texto de STT, TTS y de la entrada/salida de Agents. HIPAA exige además un BAA vigente.

Consecuencia para el informe ético: la afirmación "evaluar Zero Retention Mode si el plan lo permite" es correcta, pero conviene precisar que **es exclusivo de Enterprise**.

## 6. Disclosure — obligación literal

Debe notificarse, **inmediatamente antes de cualquier interacción**, que:

1. se está interactuando con IA y no con una persona;
2. la conversación se graba y puede compartirse con ElevenLabs y sus proveedores de modelos de lenguaje.

*"Users must not be able to access or use the feature without first being presented with this notice."* Formatos aceptados: pantalla previa, pop-up, banner persistente o **divulgación verbal al inicio de la llamada**.

El guion de la §7 de la especificación cumple ambos puntos. La responsabilidad de cumplimiento recae enteramente en nosotros, no en el proveedor.

## 7. Webhook post-llamada

Payload de nivel superior: `type`, `data`, `event_timestamp`.

Variantes de `data`: transcripción (`agent_id`, `conversation_id`, `status`, `transcript[]`, `metadata`, `analysis`, `has_audio`…), audio (`full_audio` en base64 MP3) y fallo de inicio (`failure_reason`: `busy` | `no-answer` | `unknown`).

Firma: header `ElevenLabs-Signature`, valor `t=<timestamp>,v0=<hash>`, HMAC-SHA256 sobre el secreto del webhook. **La composición exacta del string firmado no está documentada** — se delega al SDK oficial.

## 8. Riesgo de documentación

Coexisten rutas `eleven-agents/…`, `conversational-ai/…` y `agents-platform/…` con el mismo contenido: hay un rebranding en curso. Si una URL da 404, probar las otras variantes.
