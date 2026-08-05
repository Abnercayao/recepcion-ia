# Especificación técnica de construcción — Sistema Recepción-IA multicanal

> **Cómo usar este documento.** Es el brief para construir el sistema desde cero con un agente de código (Claude Code o equivalente). No describe un proyecto existente: **no hay código previo**. Cada fase tiene criterios de aceptación verificables. Ejecutar en orden; no saltar la fase 0.
>
> **Estado de partida declarado:** el proyecto existe únicamente como diseño documentado. No hay repositorio, ni workflows de n8n, ni esquema de base de datos desplegado, ni agente de ElevenLabs configurado.

---

## 0. Contexto para el agente de código

**Qué se construye.** Un agente conversacional que atiende el primer contacto de pacientes de clínicas dentales y de medicina estética, resuelve consultas desde una base de conocimiento aprobada, agenda citas contra Google Calendar, confirma citas y escala a un humano cuando corresponde. Opera en **dos canales que comparten un único núcleo**: WhatsApp (texto) y llamada telefónica (voz vía ElevenLabs).

**Restricción arquitectónica no negociable.** El canal es un atributo del mensaje, no una propiedad del sistema. Existe **un** `ConversationService`, **un** prompt maestro, **una** base de conocimiento por clínica, **un** conjunto de herramientas de negocio. Los canales son adaptadores. Si en algún momento aparece lógica de negocio duplicada por canal, el diseño está mal implementado.

**El cerebro es Claude, siempre.** ElevenLabs aporta STT, gestión de turnos/barge-in y TTS. El razonamiento se dirige al endpoint propio mediante la funcionalidad **Custom LLM** de ElevenAgents, que requiere una interfaz compatible con OpenAI (`POST /v1/chat/completions`) que responda con SSE.

**Restricciones de dominio (líneas rojas del sistema).** Nunca diagnosticar, nunca interpretar síntomas, nunca recomendar tratamientos, nunca prometer resultados, nunca cerrar precios de tratamientos que requieren valoración, nunca inventar datos ausentes de la base, nunca afirmar ser humano. Ante urgencia médica: interrumpir el flujo comercial y escalar. Estas restricciones se implementan en **tres capas** (prompt, verificación de salida, y validación en herramientas), no solo en el prompt.

---

## 1. Stack y decisiones fijadas

| Capa | Elección | Notas |
|---|---|---|
| Lenguaje | TypeScript (Node.js 20+), ESM | Estricto: `strict: true`, sin `any` implícito |
| API HTTP | Fastify | Ligero, buen soporte de SSE |
| Modelo | Claude vía `@anthropic-ai/sdk` | Dos niveles: rápido para clasificación, capacidad alta para generación |
| Datos + vectores | Supabase (PostgreSQL + `pgvector`) | Una sola herramienta para relacional, vectorial y auth |
| Capa de voz | ElevenAgents (ElevenLabs) | Custom LLM + system tools + SIP/Twilio |
| Canal texto | WhatsApp Cloud API vía BSP autorizado | Nunca APIs no oficiales |
| Orquestación | n8n autoalojado | Tareas programadas (recordatorios, QA nocturno, reportes) |
| Agenda | Google Calendar API | Service account con delegación |
| Validación | Zod | Esquemas compartidos entre runtime y tipos |
| Tests | Vitest | Unit + integración + batería adversarial |
| Logs | Pino, JSON estructurado | Con enmascaramiento de PII obligatorio |

**Instalación:**

```bash
npm i fastify @anthropic-ai/sdk @supabase/supabase-js zod pino pino-pretty \
      googleapis dotenv p-retry libphonenumber-js
npm i -D typescript tsx vitest @types/node
```

---

## 2. Estructura de carpetas

```
src/
  core/                          # NÚCLEO — no conoce ningún canal
    conversation/
      conversation.service.ts    # orquesta el turno completo
      message.router.ts          # identifica paciente, resuelve conversation_id, clasifica intención
      conversation.repository.ts
    claude/
      claude.service.ts          # invoca Claude, streaming, tool loop
      prompt.builder.ts          # ensambla prompt maestro + contexto RAG + bloque de estilo por canal
      guardrails.ts              # verificación de ENTRADA y de SALIDA
    rag/
      rag.service.ts
      embedding.service.ts
      knowledge.repository.ts
    tools/
      tool.registry.ts
      consultar-agenda.tool.ts
      crear-cita.tool.ts
      guardar-lead.tool.ts
      escalar-humano.tool.ts
      consultar-rag.tool.ts
    urgency/
      urgency.detector.ts        # clasificador dedicado, NO delegado al prompt principal
    types/
      channel.ts                 # type Channel = 'whatsapp' | 'voice'
      message.ts  conversation.ts  tool.ts

  channels/                      # ADAPTADORES — traducen, no deciden
    whatsapp/
      whatsapp.adapter.ts
      whatsapp.controller.ts     # webhook entrante
      whatsapp.formatter.ts      # formato de salida propio del canal
    voice/
      voice.adapter.ts
      voice-gateway.controller.ts  # POST /v1/chat/completions  (interfaz OpenAI para ElevenLabs)
      openai-sse.mapper.ts         # mapea salida de Claude -> chunks SSE OpenAI
      system-tools.mapper.ts       # mapea system tools de ElevenLabs <-> tool loop de Claude
      voice-session.service.ts
      call.repository.ts
      transcript.repository.ts

  infra/
    supabase.client.ts  calendar.client.ts  elevenlabs.client.ts
    logger.ts  pii-masker.ts  config.ts     # config valida env con Zod al arrancar

  server.ts

db/migrations/                   # SQL numerado
n8n/                             # workflows exportados como JSON, versionados
prompts/                         # prompt maestro y bloques de estilo (semilla de la BD)
tests/
  unit/  integration/  adversarial/   # la batería de 13 categorías
```

**Regla de dependencias:** `channels/` puede importar de `core/`. **`core/` nunca importa de `channels/`.** Si necesita hacerlo, la abstracción está mal puesta.

---

## 3. Esquema de base de datos

`db/migrations/001_init.sql`:

```sql
create extension if not exists vector;

create table clinics (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  timezone text not null default 'America/Lima',
  config jsonb not null default '{}',
  retencion_transcripcion_dias int not null default 365,
  retencion_audio_dias int not null default 0,      -- 0 = no retener audio
  transfer_whitelist text[] not null default '{}',
  creado_en timestamptz not null default now()
);

create table patients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  telefono_e164 text not null,
  nombre text,
  consentimiento_at timestamptz,
  consentimiento_canal text,
  creado_en timestamptz not null default now(),
  unique (clinic_id, telefono_e164)
);

-- CLAVE DE LA CONTINUIDAD MULTICANAL
create table conversations (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  estado text not null default 'activa',       -- activa | escalada | cerrada
  canal_origen text not null,                  -- whatsapp | voice
  ultimo_canal text not null,
  iniciada_en timestamptz not null default now(),
  ultima_actividad timestamptz not null default now(),
  escalada_en timestamptz,
  escalada_motivo text
);
create index on conversations (clinic_id, patient_id, ultima_actividad desc);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  rol text not null,                           -- user | assistant | system | tool
  contenido text not null,
  canal text not null,                         -- EL CANAL ES ATRIBUTO DEL MENSAJE
  session_id text,                             -- id de sesión de voz o de ventana de chat
  tokens_in int, tokens_out int,
  latencia_ms int,
  creado_en timestamptz not null default now()
);
create index on messages (conversation_id, creado_en);

create table calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  session_id text not null unique,
  elevenlabs_conversation_id text,
  proveedor_sip text,
  numero_origen text, numero_destino text,
  call_status text not null default 'iniciada', -- iniciada|en_curso|transferida|finalizada|fallida
  iniciada_en timestamptz not null default now(),
  finalizada_en timestamptz,
  voice_duration_s int,
  transferida_a text,
  consentimiento_grabacion boolean not null default false,
  retencion_audio boolean not null default false,
  disclosure_ejecutada boolean not null default false   -- auditable: obligación contractual
);

create table transcripts (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  hablante text not null,                      -- paciente | agente
  texto text not null,
  ts_inicio_ms int, ts_fin_ms int,
  confianza numeric
);

create table audio_events (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  tipo text not null,          -- inicio|barge_in|silencio|reintento_comprension|transferencia|fin
  ts timestamptz not null default now(),
  payload jsonb
);

create table tool_calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  message_id uuid references messages(id) on delete set null,
  herramienta text not null,
  argumentos_enmascarados jsonb not null,
  estado text not null,                        -- ok | error | rechazada_validacion
  error_detalle text,
  latencia_ms int,
  creado_en timestamptz not null default now()
);

create table latency_metrics (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  turno int not null,
  stt_ms int, llm_ms int, tts_ms int, total_ms int
);

create table knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  contenido text not null,
  embedding vector(1024),
  fuente text not null,                        -- formulario | web | faq | protocolo_urgencia
  version int not null default 1,
  aprobado_por text,
  aprobado_en timestamptz,
  activo boolean not null default false        -- SIN aprobación no se activa
);
create index on knowledge_chunks using hnsw (embedding vector_cosine_ops);

create table audit_log (
  id bigserial primary key,
  clinic_id uuid,
  conversation_id uuid,
  evento text not null,
  detalle_enmascarado jsonb,
  creado_en timestamptz not null default now()
);
```

**Migración 002 — RLS.** Activar Row Level Security en todas las tablas con `clinic_id` y política de aislamiento por inquilino. Sin esto, un bug de query cruza datos entre clínicas.

**Migración 003 — función de búsqueda vectorial:**

```sql
create or replace function match_knowledge(
  p_clinic_id uuid, p_embedding vector(1024), p_limit int default 5, p_min_similarity float default 0.5
) returns table (id uuid, contenido text, fuente text, similarity float)
language sql stable as $$
  select k.id, k.contenido, k.fuente, 1 - (k.embedding <=> p_embedding) as similarity
  from knowledge_chunks k
  where k.clinic_id = p_clinic_id and k.activo = true
    and 1 - (k.embedding <=> p_embedding) > p_min_similarity
  order by k.embedding <=> p_embedding limit p_limit;
$$;
```

---

## 4. Contratos de tipos del núcleo

```ts
// core/types/channel.ts
export type Channel = 'whatsapp' | 'voice';

// core/types/message.ts
export interface InboundMessage {
  clinicId: string;
  patientPhoneE164: string;
  patientName?: string;
  text: string;
  channel: Channel;
  sessionId?: string;          // voz: id de llamada; texto: ventana de chat
  receivedAt: Date;
}

export interface OutboundMessage {
  conversationId: string;
  text: string;                // texto puro; el adaptador aplica el formato del canal
  channel: Channel;
  escalate?: EscalationRequest;
  endCall?: boolean;
  latencyMs: number;
}

export interface EscalationRequest {
  reason: 'urgencia' | 'peticion_humano' | 'reclamo' | 'fallo_comprension';
  priority: 'urgente' | 'normal';
  summaryForAgent: string;     // en voz -> agent_message de transfer_to_number
  messageForPatient: string;   // en voz -> client_message
  transferNumber?: string;     // SIEMPRE validado contra clinic.transfer_whitelist
}

// core/conversation/conversation.service.ts
export interface ConversationService {
  handleTurn(input: InboundMessage): Promise<OutboundMessage>;
  streamTurn(input: InboundMessage): AsyncIterable<TurnChunk>;  // requerido por el canal de voz
}
export type TurnChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; args: unknown }
  | { type: 'escalate'; request: EscalationRequest }
  | { type: 'done'; message: OutboundMessage };
```

**`streamTurn` es obligatorio**: el canal de voz necesita emitir SSE progresivamente o la latencia percibida arruina la conversación.

---

## 5. Voice Gateway — el componente crítico

ElevenLabs, configurado con Custom LLM, envía peticiones con forma OpenAI a un endpoint propio. El gateway **traduce y nada más**.

```ts
// channels/voice/voice-gateway.controller.ts
// POST /v1/chat/completions
//
// Entrada relevante del body:
//   messages[]                -> historial de la conversación
//   tools[]                   -> system tools configurados (end_call, transfer_to_number,
//                                language_detection, skip_turn), en formato OpenAI
//   stream: true
//   elevenlabs_extra_body     -> variables dinámicas propias (clinic_id, session_id, phone)
//
// Salida obligatoria:
//   Content-Type: text/event-stream
//   chunks:  data: {json}\n\n     con forma chat.completion.chunk
//   cierre:  data: [DONE]\n\n
```

Pasos de la implementación:

1. **Autenticar** la petición (secreto compartido en header). Rechazar si no coincide.
2. **Extraer contexto** de `elevenlabs_extra_body`: `clinic_id`, `session_id`, teléfono del paciente. Si falta el teléfono, obtenerlo del registro de la llamada por `session_id`.
3. **Tomar el último mensaje de usuario** del array `messages`. El historial autoritativo vive en la BD propia, no en el que envía ElevenLabs — usar el de ElevenLabs solo como señal del turno actual.
4. **Invocar `conversationService.streamTurn()`** con `channel: 'voice'`.
5. **Mapear a SSE OpenAI** con `openai-sse.mapper.ts`. Cada delta de texto de Claude se convierte en un chunk.
6. **Mapear tool calls**:
   - Herramientas de **negocio** (`consultar_agenda`, `crear_cita`, `guardar_lead`, `escalar_humano`, `consultar_rag`): se ejecutan **dentro del núcleo**. No se exponen a ElevenLabs. Su resultado vuelve al tool loop de Claude y solo el texto final sale por SSE.
   - Herramientas de **sistema** (`transfer_to_number`, `end_call`, `language_detection`, `skip_turn`): se emiten como `tool_calls` en el chunk SSE, en formato OpenAI, para que ElevenLabs las ejecute en la telefonía.
   - Cuando el núcleo produce una `EscalationRequest`, el mapper emite `transfer_to_number` con `transfer_number` (validado contra whitelist), `client_message` y `agent_message` = resumen generado.
7. **Buffer words ante latencia:** si el primer token de Claude tarda más del umbral, emitir un chunk puente terminado en `"... "` (elipsis + espacio; el espacio es obligatorio para no distorsionar el audio). Registrar el evento — es señal de que hay que optimizar, no una solución.
8. **Persistir**: turno en `messages`, métricas en `latency_metrics`, eventos en `audio_events`.
9. **Errores:** nunca devolver 500 seco. Emitir un chunk con mensaje de respaldo hablable y disparar transferencia a humano. El silencio en una llamada es el peor modo de fallo.

### Configuración del agente en ElevenLabs

- LLM: **Custom LLM** → URL del gateway, model id propio, secreto.
- **System prompt del agente en ElevenLabs: mínimo o vacío.** La personalidad y las reglas viven en el prompt maestro del núcleo. Duplicarlas aquí crea dos fuentes de verdad.
- System tools habilitados: `transfer_to_number` (con números en whitelist), `end_call`, `language_detection`, `skip_turn`.
- Conversation flow: configurar turn-taking, interrupciones (barge-in) y timeouts.
- **Privacidad: retención de audio desactivada.** Retención de conversación según política. Evaluar Zero Retention Mode si el plan lo permite.
- **First message = guion de revelación** (ver §7). Obligación contractual del proveedor.
- Webhook post-llamada → endpoint propio para consolidar transcripción, duración y estado en `calls` / `transcripts`.

---

## 6. Prompt maestro

Vive en la BD (tabla de configuración o `prompts/` como semilla), **no hardcodeado**. `prompt.builder.ts` ensambla:

```
[BLOQUE 1-7: prompt maestro invariable]   ← igual en ambos canales
[BLOQUE 8: <contexto_aprobado> fragmentos RAG </contexto_aprobado>]
[BLOQUE 9: variables de sesión — canal, fecha/hora actual, clínica, sede, paciente]
[BLOQUE 10: bloque de estilo del canal]   ← ÚNICA diferencia entre texto y voz
```

Bloques 1–7 (rol, objetivo, prohibiciones absolutas, respuesta canónica, protocolo de urgencia, criterios de escalamiento, uso de herramientas): ver el informe del proyecto, §3.1.4. Copiar literalmente.

**Bloque de estilo — voz:**

```
- Máximo 2-3 frases por turno. Nunca listas largas: ofrece 2 opciones y pregunta.
- Sin marcas de formato, sin emojis, sin símbolos: todo se pronuncia.
- Números y fechas escritos como se dicen: "el jueves once a las cuatro y media de la tarde".
- Antes de escribir en la agenda, repite fecha y hora y pide confirmación explícita.
- Ante audio dudoso, verifica comprensión. Máximo 2 reintentos; al segundo, ofrece
  continuar por WhatsApp o transferir a una persona SIN que el paciente lo pida.
- Frases cortas con puntuación que induzca pausas. Nunca dos preguntas en un turno.
- La personalidad y todas las reglas anteriores no cambian.
```

**Bloque de estilo — texto:** puede desarrollar, admite listas y negritas, emojis moderados.

---

## 7. Revelación obligatoria (disclosure)

Obligación contractual del proveedor de voz + estándar de transparencia + derecho del usuario de salud. **No configurable por el cliente.** Auditable vía `calls.disclosure_ejecutada`.

```
"Hola, le atiende el asistente virtual de {{clinica}}. Soy un asistente de
inteligencia artificial, no una persona. Esta llamada puede ser grabada y
compartida con nuestros proveedores de servicio para fines de calidad y mejora
del servicio. Si en cualquier momento prefiere hablar con una persona, dígamelo
y le transfiero. ¿En qué le puedo ayudar?"
```

Se implementa como `first_message` del agente y se marca el flag al iniciar la llamada. En WhatsApp, equivalente escrito al inicio de cada conversación nueva.

---

## 8. Herramientas — implementación defensiva

Ninguna herramienta confía en los argumentos que produce el modelo.

| Herramienta | Validaciones obligatorias |
|---|---|
| `consultar_agenda` | Rango de fechas acotado; solo la clínica del contexto; nunca devuelve datos de otros pacientes |
| `crear_cita` | Zod sobre fecha/hora; **doble verificación de colisión** justo antes de escribir; requiere flag `confirmadoPorPaciente=true`; máx. N citas por conversación |
| `escalar_humano` | `transferNumber` **debe** estar en `clinic.transfer_whitelist`; si no, rechaza y usa el canal de notificación de respaldo |
| `guardar_lead` | Enmascara PII antes de escribir en logs; nunca guarda contenido clínico literal en campos de scoring |
| `consultar_rag` | Solo `clinic_id` del contexto; solo chunks con `activo=true` |

Toda ejecución se registra en `tool_calls` con argumentos enmascarados. Rate limit por conversación y por clínica.

---

## 9. Guardrails — tres capas

```ts
// core/claude/guardrails.ts
export interface GuardrailResult { pass: boolean; reason?: string; replacement?: string; }

// CAPA 1 — entrada: detección de intento de inyección y de consulta clínica
export function checkInbound(text: string, channel: Channel): GuardrailResult;

// CAPA 2 — salida (antes de enviar/sintetizar): BLOQUEANTE
//   · patrón de precio cerrado sin la mención obligatoria de valoración -> bloquear
//   · patrón de afirmación clínica / diagnóstico -> bloquear
//   · afirmación de ser humano -> bloquear
//   · afirmación de haber agendado sin tool_call exitoso previo -> bloquear
//   En todos los casos: sustituir por la respuesta canónica y registrar incidente.
export function checkOutbound(text: string, ctx: TurnContext): GuardrailResult;

// CAPA 3 — urgencia: clasificador dedicado sobre CADA turno, con modelo rápido.
//   Corre en paralelo a la generación. Si detecta urgencia, aborta la respuesta
//   comercial y fuerza el protocolo de urgencia. Sesgo deliberado al falso positivo.
export function detectUrgency(text: string): Promise<UrgencyResult>;
```

La capa 2 es la que hace que las reglas dejen de ser una expectativa y pasen a ser un control.

---

## 10. Continuidad multicanal

`message.router.ts`:

1. Normalizar teléfono a E.164 con `libphonenumber-js` (default `PE`).
2. `upsert` en `patients` por `(clinic_id, telefono_e164)`.
3. Buscar conversación activa del paciente con `ultima_actividad` dentro de la ventana (configurable, sugerido 72 h). Si existe → reutilizar `conversation_id` **aunque el canal sea distinto**. Si no → crear.
4. Actualizar `ultimo_canal`.
5. Si el canal cambió respecto del mensaje anterior, el prompt recibe una nota de contexto para que el agente lo anuncie explícitamente al paciente (no dar la impresión de que sus datos circulan sin su conocimiento).

**Test de aceptación:** iniciar por voz → colgar → escribir por WhatsApp → el agente retoma con el contexto y **el mismo `conversation_id`**.

---

## 11. Flujos en n8n

Exportar como JSON en `n8n/` y versionar.

| Flujo | Disparador | Función |
|---|---|---|
| `F1_whatsapp_inbound` | Webhook BSP | Recibe → llama a `/api/whatsapp/inbound` del núcleo → responde |
| `F3_recordatorios` | Cron horario | Citas próximas → recordatorios 72/24/3 h con botones → procesa respuestas |
| `F4_notificar_escalamiento` | Webhook del núcleo | Notifica a recepción con el resumen |
| `F5_reactivacion` | Cron mensual | **Desactivado por defecto.** Requiere validación legal + cruce con «Gracias, No Insista» |
| `F6_reporte_mensual` | Cron día 1 | Agrega métricas → narrativa con Claude → PDF → envío |
| `QA_nocturno` | Cron diario | Evalúa el 100 % de conversaciones con rúbrica + **muestreo aleatorio de aprobadas** |
| `heartbeat` | Cron 5 min | Verifica salud; alerta ante fallo |

---

## 12. Fases de construcción con criterios de aceptación

### Fase 0 — Fundaciones
- Repo, TypeScript estricto, `config.ts` que valida env con Zod y **falla al arrancar** si falta algo.
- Migraciones 001–003 aplicadas. RLS activo.
- Logger con enmascarador de PII.
- **Aceptación:** `npm run build` sin errores; arrancar con env incompleto falla con mensaje claro; test que verifica que el logger enmascara un DNI y un teléfono.

### Fase 1 — Núcleo sin canales
- `ConversationService`, `MessageRouter`, `ClaudeService` (con streaming y tool loop), `PromptBuilder`, `RagService`, las 5 herramientas de negocio, `guardrails`, `urgency.detector`.
- **Aceptación:** test de integración que ejecuta un turno completo con `channel:'whatsapp'` y otro con `channel:'voice'` **usando el mismo servicio**, y verifica que solo difiere el bloque de estilo del prompt. Los tests de guardrails de capa 2 bloquean un precio cerrado y una afirmación clínica.

### Fase 2 — Canal WhatsApp
- Adapter, controller de webhook, formatter, integración con BSP y con Google Calendar.
- **Aceptación:** conversación real de extremo a extremo por WhatsApp que agenda una cita visible en Calendar; escalamiento notifica a recepción; ninguna lógica de negocio en `channels/whatsapp/`.

### Fase 3 — Batería adversarial
- Implementar `tests/adversarial/` con las 13 categorías del informe (§3.1.5).
- **Aceptación (bloqueante):** 0 consejos clínicos · 100 % urgencias escaladas · 0 precios cerrados no autorizados · 0 inyecciones exitosas · 0 fugas entre clínicas · 0 citas con datos incorrectos · ≥95 % respuestas correctas y en tono.

### Fase 4 — Voice Gateway
- `voice-gateway.controller.ts`, `openai-sse.mapper.ts`, `system-tools.mapper.ts`, repos de `calls`/`transcripts`/`audio_events`/`latency_metrics`.
- **Aceptación:** `curl` con un body OpenAI-like devuelve SSE válido terminando en `data: [DONE]`; una `EscalationRequest` produce un `tool_call` de `transfer_to_number` con `agent_message` no vacío y `transfer_number` en whitelist; petición sin secreto → 401.

### Fase 5 — Integración con ElevenLabs
- Agente creado y apuntando al gateway (túnel en desarrollo). System tools habilitados. Retención de audio off. `first_message` = guion de revelación. Webhook post-llamada.
- **Aceptación:** llamada real que agenda una cita; `calls.disclosure_ejecutada = true`; transcripción y latencias persistidas; barge-in registrado en `audio_events`; latencia por turno dentro del objetivo.

### Fase 6 — Continuidad y n8n
- Ventana de continuidad; flujos F3, F4, F6, QA nocturno, heartbeat.
- **Aceptación:** el test de §10 pasa; recordatorio disparado y respuesta procesada; QA nocturno genera reporte con muestreo aleatorio de aprobadas.

### Fase 7 — Auditoría de equidad (bloqueante para producción de voz)
- Script de medición de WER por segmento de hablante; tabla de línea base; umbral de brecha.
- **Aceptación:** línea base documentada con hablantes reales y consentimiento informado; el flujo de dos-fallos-y-salida-alternativa verificado con audio real.

---

## 13. Anti-patrones a evitar

1. **Un segundo prompt para voz.** Solo se concatena un bloque de estilo.
2. **Lógica de negocio en el adaptador.** Los adaptadores traducen.
3. **Registrar las herramientas de negocio en ElevenLabs.** Duplica definiciones y saca la validación del núcleo.
4. **Confiar en los argumentos del modelo.** Validar siempre.
5. **Reglas solo en el prompt.** Sin la capa 2 de guardrails no hay control.
6. **Historial autoritativo en ElevenLabs.** La fuente de verdad es la BD propia.
7. **Devolver 500 en el gateway.** Produce silencio en la llamada. Responder con mensaje hablable + transferencia.
8. **Activar audio retention "por si acaso".** Es dato biométrico asociado a dato de salud.
9. **Desplegar voz antes de la fase 7.** Expone pacientes a un sesgo de magnitud desconocida.
10. **Frameworks multiagente, fine-tuning o Kubernetes en v1.** Un flujo, un prompt, RAG simple, cinco herramientas.

---

## 14. Variables de entorno

```bash
# Modelo (cerebro, común a ambos canales)
ANTHROPIC_API_KEY=
CLAUDE_MODEL_CONVERSACION=
CLAUDE_MODEL_CLASIFICACION=
CLAUDE_TEMPERATURE=0.3

# Datos
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
RETENCION_TRANSCRIPCION_DIAS=365
RETENCION_AUDIO_DIAS=0

# Voz (ElevenLabs)
VOICE_ENABLED=false
ELEVENLABS_API_KEY=
ELEVENLABS_AGENT_ID=
ELEVENLABS_VOICE_ID=
ELEVENLABS_MODEL=
ELEVENLABS_WS_URL=
VOICE_GATEWAY_URL=
VOICE_GATEWAY_SECRET=
VOICE_LATENCIA_OBJETIVO_MS=1200
AUDIO_RETENTION=false

# Telefonía
SIP_PROVIDER=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
TRANSFER_WHITELIST=

# Texto
WHATSAPP_BSP_TOKEN=
WHATSAPP_PHONE_ID=
WHATSAPP_WEBHOOK_SECRET=

# Integraciones
GOOGLE_CALENDAR_CREDENTIALS=
N8N_WEBHOOK_URL=

# Continuidad
VENTANA_CONTINUIDAD_HORAS=72
```

---

## 15. Documentación oficial de referencia

Verificada a julio de 2026. Consultar antes de implementar cada pieza.

- Custom LLM: `https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm`
- System tools: `https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools`
- Transfer to number: `https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/transfer-to-number`
- Client→server events (contextual updates): `https://elevenlabs.io/docs/eleven-agents/customization/events/client-to-server-events`
- Dynamic variables: `https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables`
- Conversation flow (turn-taking, barge-in): `https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow`
- SIP trunking: `https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking`
- Twilio nativo: `https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/native-integration`
- Post-call webhooks: `https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks`
- Privacidad y retención: `https://elevenlabs.io/docs/eleven-agents/customization/privacy`
- Disclosure requirements: `https://elevenlabs.io/docs/eleven-agents/legal/disclosure-requirement`
- pgvector en Supabase: `https://supabase.com/docs/guides/database/extensions/pgvector`

---

## 16. Espacios de evidencia para los informes

Al completar cada fase, capturar lo siguiente para pegarlo en los anexos de los dos informes:

- [ ] **Fase 3** → Tabla de resultados de la batería por categoría + verificación de cada criterio bloqueante → *Anexo C del informe ético, Anexo E del informe del proyecto*
- [ ] **Fase 2 y 5** → Transcripciones anonimizadas: agendamiento exitoso, derivación clínica, urgencia escalada, inyección contenida, fallo con corrección → *Anexo E*
- [ ] **Fase 5** → Captura del panel de conversaciones de voz (duración, transcripción, latencia) + captura de cita creada en Calendar + extracto de `tool_calls` → *Anexo E*
- [ ] **Fase 5** → Tabla de latencia por turno (percentiles vs. objetivo) → *Anexo E*
- [ ] **Fase 7** → Tabla de WER por segmento de hablante + consentimientos informados → *Anexo B del informe ético*
- [ ] **Fase 0** → Contrato de encargo de tratamiento firmado + aviso de privacidad revisado + designación de responsable de datos → *Anexos A, D y E del informe ético*
- [ ] **Continuo** → Iteraciones del prompt posteriores a v1.0, indicando si el fallo se originó en transcripción, prompt o gestión de turnos → *Tabla 12 del informe del proyecto*
