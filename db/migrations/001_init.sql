-- 001_init.sql
-- Esquema inicial de Recepcion-IA.
--
-- Base: ESPECIFICACION_TECNICA_CONSTRUCCION.md, seccion 3 (las 13 tablas y sus
-- columnas se copian LITERALMENTE de ahi). Todo lo que la especificacion no
-- traia se marca con "ANADIDO:" y su justificacion, para que quede claro que
-- es una decision de esta rama y no un cambio silencioso al contrato de datos.
--
-- Convencion de nombres de los tipos "estado libre" (rol, canal, estado,
-- call_status, etc.): los valores permitidos de cada CHECK se tomaron de
-- src/core/types/*.ts (los enums de Zod ya fijados: channelSchema,
-- messageRolSchema, conversationEstadoSchema, TOOL_STATUS, businessToolNameSchema).
-- Si un CHECK de aqui y un enum de ese archivo alguna vez difieren, el enum de
-- TypeScript manda (es el contrato compartido, ver ports.ts) y esta migracion
-- quedo desactualizada: hay que corregir aqui, no alla.

create extension if not exists vector;

-- ANADIDO: pgcrypto. gen_random_uuid() es nativo desde PostgreSQL 13 y Supabase
-- lo trae por defecto, pero declarar la extension explicita evita que la
-- migracion falle en un Postgres mas viejo o con la funcion deshabilitada.
-- No tiene costo si ya esta disponible (IF NOT EXISTS).
create extension if not exists pgcrypto;

-- ANADIDO: funcion generica para mantener "updated_at" via trigger. Se reusa
-- en todas las tablas de esta migracion que reciben cambios despues del alta
-- (ver el porque tabla a tabla mas abajo). No es de la especificacion.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table clinics (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  timezone text not null default 'America/Lima',
  config jsonb not null default '{}',
  retencion_transcripcion_dias int not null default 365,
  retencion_audio_dias int not null default 0,      -- 0 = no retener audio
  transfer_whitelist text[] not null default '{}',
  creado_en timestamptz not null default now(),
  -- ANADIDO: updated_at. config y transfer_whitelist se editan desde el panel
  -- de administracion despues del alta (p. ej. anadir un numero a la lista
  -- blanca de transferencia). Sin esta columna no hay forma de saber cuando
  -- cambio algo tan sensible como transfer_whitelist (relevante para C10:
  -- auditoria de cambios operativos, no solo de conversaciones).
  updated_at timestamptz not null default now()
);
create trigger trg_clinics_updated_at
  before update on clinics
  for each row execute function set_updated_at();

create table patients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  telefono_e164 text not null,
  nombre text,
  consentimiento_at timestamptz,
  -- consentimiento_canal queda TEXT libre a proposito: la especificacion no
  -- fija los valores permitidos (no es 'whatsapp'|'voice' necesariamente;
  -- podria ser 'presencial' o 'web' en el futuro) y el tipo InboundMessage/
  -- Patient de core/types/conversation.ts tampoco lo tipa como enum cerrado.
  -- Se documenta como VACIO DETECTADO en el informe final en vez de inventar
  -- un cierre que la especificacion no pidio.
  consentimiento_canal text,
  creado_en timestamptz not null default now(),
  unique (clinic_id, telefono_e164),
  -- ANADIDO: updated_at. nombre y consentimiento_at/consentimiento_canal se
  -- actualizan cuando el paciente lo corrige o lo otorga mas tarde en otra
  -- conversacion (message.router.ts hace upsert, no solo insert).
  updated_at timestamptz not null default now()
);
create trigger trg_patients_updated_at
  before update on patients
  for each row execute function set_updated_at();
-- ANADIDO: indice por clinic_id. clinic_id es FK y PostgreSQL NO indexa
-- columnas de clave foranea automaticamente. Sin este indice, tanto la
-- politica RLS de aislamiento (002_rls.sql) como cualquier listado
-- administrativo "pacientes de esta clinica" hacen seq scan sobre toda la
-- tabla a medida que crece.
create index idx_patients_clinic on patients (clinic_id);

-- CLAVE DE LA CONTINUIDAD MULTICANAL
create table conversations (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  estado text not null default 'activa'       -- activa | escalada | cerrada
    constraint chk_conversations_estado check (estado in ('activa', 'escalada', 'cerrada')),
  canal_origen text not null                  -- whatsapp | voice
    constraint chk_conversations_canal_origen check (canal_origen in ('whatsapp', 'voice')),
  ultimo_canal text not null
    constraint chk_conversations_ultimo_canal check (ultimo_canal in ('whatsapp', 'voice')),
  iniciada_en timestamptz not null default now(),
  ultima_actividad timestamptz not null default now(),
  escalada_en timestamptz,
  escalada_motivo text,
  -- ANADIDO: updated_at, DISTINTO de ultima_actividad a proposito.
  -- ultima_actividad es el reloj de negocio que gobierna la ventana de
  -- continuidad (seccion 10 de la especificacion: 72h por defecto,
  -- VENTANA_CONTINUIDAD_HORAS). updated_at es bookkeeping generico de "cuando
  -- se toco esta fila por ultima vez, por el motivo que sea". No deben
  -- confundirse: una correccion administrativa (p. ej. QA nocturno anotando
  -- algo) no debe reabrir la ventana de continuidad del paciente.
  updated_at timestamptz not null default now()
);
create trigger trg_conversations_updated_at
  before update on conversations
  for each row execute function set_updated_at();
create index on conversations (clinic_id, patient_id, ultima_actividad desc);
-- Nota: "conversaciones de una clinica" (sin patient_id) ya queda cubierto por
-- el prefijo izquierdo (clinic_id) del indice anterior; no hace falta otro.

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  rol text not null                           -- user | assistant | system | tool
    constraint chk_messages_rol check (rol in ('user', 'assistant', 'system', 'tool')),
  contenido text not null,
  canal text not null                         -- EL CANAL ES ATRIBUTO DEL MENSAJE
    constraint chk_messages_canal check (canal in ('whatsapp', 'voice')),
  session_id text,                            -- id de sesion de voz o de ventana de chat
  tokens_in int, tokens_out int,
  latencia_ms int,
  creado_en timestamptz not null default now()
  -- Sin updated_at a proposito: MessageRepository (ports.ts) solo define
  -- append() y listByConversation(), nunca update(). messages es append-only
  -- y es el "historial autoritativo" (seccion 10); permitir editarlo despues
  -- de escrito rompe esa garantia y falsearia una auditoria.
);
create index on messages (conversation_id, creado_en);

create table calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  session_id text not null unique,
  elevenlabs_conversation_id text,
  proveedor_sip text,
  numero_origen text, numero_destino text,
  call_status text not null default 'iniciada' -- iniciada|en_curso|transferida|finalizada|fallida
    constraint chk_calls_call_status check (
      call_status in ('iniciada', 'en_curso', 'transferida', 'finalizada', 'fallida')
    ),
  iniciada_en timestamptz not null default now(),
  finalizada_en timestamptz,
  voice_duration_s int,
  transferida_a text,
  consentimiento_grabacion boolean not null default false,
  retencion_audio boolean not null default false,
  disclosure_ejecutada boolean not null default false,   -- auditable: obligacion contractual
  -- ANADIDO: updated_at. call_status, finalizada_en y voice_duration_s
  -- cambian durante la llamada y de nuevo al llegar el webhook post-llamada
  -- (seccion 5, paso 9). Sin esto no hay forma de saber cuando se consolido
  -- el estado final de una llamada.
  updated_at timestamptz not null default now()
);
create trigger trg_calls_updated_at
  before update on calls
  for each row execute function set_updated_at();
-- ANADIDO: conversation_id es FK sin indice automatico. call.repository.ts
-- necesita "la(s) llamada(s) de esta conversacion" en cada turno de voz.
create index idx_calls_conversation on calls (conversation_id);
-- ANADIDO: el webhook post-llamada de ElevenLabs identifica la llamada por
-- elevenlabs_conversation_id (el id que asigna ElevenLabs), no por el
-- session_id propio (seccion 5, "Webhook post-llamada -> endpoint propio para
-- consolidar transcripcion, duracion y estado"). Sin este indice, ese webhook
-- -que llega bajo presion de latencia igual que el resto del pipeline de voz-
-- hace seq scan sobre toda la tabla calls para encontrar la fila a actualizar.
create index idx_calls_elevenlabs_conversation on calls (elevenlabs_conversation_id);

create table transcripts (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  hablante text not null                      -- paciente | agente
    constraint chk_transcripts_hablante check (hablante in ('paciente', 'agente')),
  texto text not null,
  ts_inicio_ms int, ts_fin_ms int,
  confianza numeric
  -- Sin updated_at: transcripts es append-only, igual que messages.
);
-- ANADIDO: call_id es FK sin indice automatico. transcript.repository.ts lee
-- "toda la transcripcion de esta llamada"; la politica RLS de 002_rls.sql
-- tambien necesita este indice para no hacer seq scan en cada fila visible.
create index idx_transcripts_call on transcripts (call_id);

create table audio_events (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  tipo text not null           -- inicio|barge_in|silencio|reintento_comprension|transferencia|fin
    constraint chk_audio_events_tipo check (
      tipo in ('inicio', 'barge_in', 'silencio', 'reintento_comprension', 'transferencia', 'fin')
    ),
  ts timestamptz not null default now(),
  payload jsonb
  -- Sin updated_at: registro de eventos, append-only por naturaleza.
);
-- ANADIDO: mismo motivo que transcripts (FK call_id sin indice automatico).
create index idx_audio_events_call on audio_events (call_id);

create table tool_calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  message_id uuid references messages(id) on delete set null,
  -- "herramienta" queda TEXT SIN CHECK, a proposito, aunque el nombre de la
  -- columna sugeriria restringirla a las 5 herramientas de negocio
  -- (consultar_agenda, crear_cita, guardar_lead, escalar_humano, consultar_rag
  -- de businessToolNameSchema en core/types/tool.ts). Motivo: esta tabla debe
  -- poder auditar tambien el caso en que el modelo invoca una herramienta que
  -- NO EXISTE o esta mal escrita (fila con estado='rechazada_validacion'); un
  -- CHECK aqui bloquearia justo el registro del caso anomalo -intento de
  -- llamar a algo que no es una herramienta valida- que mas interesa poder
  -- auditar para detectar abuso, alucinacion o inyeccion. Se documenta como
  -- decision deliberada, no como omision.
  herramienta text not null,
  argumentos_enmascarados jsonb not null,
  estado text not null          -- ok | error | rechazada_validacion (TOOL_STATUS)
    -- Esta es la "forma de conclusion" de la llamada a la herramienta: cerro
    -- bien, cerro con error, o la capa de validacion defensiva (seccion 8) la
    -- rechazo antes de ejecutar. A diferencia de "herramienta", el conjunto de
    -- valores de "estado" SI esta cerrado y controlado por nuestro propio
    -- codigo (nunca lo escribe el modelo), asi que el CHECK es seguro.
    constraint chk_tool_calls_estado check (estado in ('ok', 'error', 'rechazada_validacion')),
  error_detalle text,
  latencia_ms int,
  creado_en timestamptz not null default now()
  -- Sin updated_at: se escribe una sola vez, al terminar la ejecucion
  -- (ToolCallRepository.record() en ports.ts no tiene update()).
);
-- ANADIDO: soporta ToolCallRepository.countByTool(conversationId, herramienta)
-- (limite maxCallsPerConversation de BusinessTool, ver core/types/tool.ts) sin
-- seq scan. El prefijo izquierdo (conversation_id) tambien sirve para "todas
-- las llamadas a herramientas de esta conversacion" y para RLS.
create index idx_tool_calls_conversation_herramienta on tool_calls (conversation_id, herramienta);
-- ANADIDO: message_id es FK nullable sin indice automatico (on delete set
-- null la usaria al borrar un mensaje).
create index idx_tool_calls_message on tool_calls (message_id);

create table latency_metrics (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  turno int not null,
  stt_ms int, llm_ms int, tts_ms int, total_ms int
  -- Sin updated_at: metrica puntual por turno, append-only.
);
-- ANADIDO: call_id es FK sin indice automatico; el reporte de percentiles de
-- latencia por turno (Fase 5, seccion 16 del brief) filtra por call_id.
create index idx_latency_metrics_call on latency_metrics (call_id);

create table knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  contenido text not null,
  embedding vector(1024),
  fuente text not null                        -- formulario | web | faq | protocolo_urgencia
    constraint chk_knowledge_chunks_fuente check (
      fuente in ('formulario', 'web', 'faq', 'protocolo_urgencia')
    ),
  version int not null default 1,
  aprobado_por text,
  aprobado_en timestamptz,
  activo boolean not null default false,       -- SIN aprobacion no se activa
  -- ANADIDO: updated_at. version, aprobado_por/aprobado_en y activo cambian
  -- durante el ciclo de aprobacion humana (control C9 del informe etico:
  -- "revision humana antes de produccion"). Sin esta columna no se puede
  -- auditar cuando se aprobo o se desactivo un fragmento de conocimiento.
  updated_at timestamptz not null default now()
);
create trigger trg_knowledge_chunks_updated_at
  before update on knowledge_chunks
  for each row execute function set_updated_at();
-- El indice HNSW (embedding vector_cosine_ops) que pide la especificacion se
-- crea en 003_functions.sql, junto a match_knowledge() -que es quien lo usa-
-- en vez de aqui. Es una desviacion deliberada del orden literal de la
-- seccion 3 del brief (que lo listaba junto a esta tabla), siguiendo la
-- instruccion explicita del encargo de esta rama ("003_functions.sql: la
-- funcion match_knowledge ... mas el indice HNSW"). Se deja constancia en el
-- informe final.
--
-- ANADIDO (no HNSW, complementario): btree sobre (clinic_id, activo). El
-- indice HNSW solo ordena por similitud de "embedding"; no acelera el filtro
-- "clinic_id = ... and activo = true" que exige match_knowledge() para el
-- aislamiento entre clinicas (control C9). pgvector no puede pre-filtrar por
-- columnas normales dentro de la busqueda HNSW (salvo "iterative scan" en
-- versiones recientes, que no se asume aqui): sin este indice auxiliar, la
-- fase de filtrado por clinica puede degradar a seq scan en catalogos
-- grandes de conocimiento compartidos por muchas clinicas.
create index idx_knowledge_chunks_clinic_activo on knowledge_chunks (clinic_id, activo);

create table audit_log (
  id bigserial primary key,
  clinic_id uuid,
  conversation_id uuid,
  evento text not null,
  detalle_enmascarado jsonb,
  creado_en timestamptz not null default now()
  -- Sin updated_at: seria contradictorio con la inmutabilidad exigida abajo
  -- (control C10). Un registro de auditoria que se puede "actualizar" ya no
  -- es un registro de auditoria.
);
-- ANADIDO: indices de consulta habituales (por clinica y por conversacion,
-- ambos ordenados por fecha) para el reporte mensual (F6_reporte_mensual) y
-- cualquier panel de auditoria, sin depender de un seq scan sobre toda la
-- tabla a medida que crece indefinidamente (no tiene politica de retencion:
-- es auditoria).
create index idx_audit_log_clinic on audit_log (clinic_id, creado_en desc);
create index idx_audit_log_conversation on audit_log (conversation_id, creado_en desc);

-- =============================================================================
-- ANADIDO: INMUTABILIDAD DE audit_log (control C10 del informe etico-regulatorio:
-- "Registro inalterable de cada turno, cada llamada a herramienta y cada
-- decision de escalamiento").
--
-- Un audit_log que admite UPDATE o DELETE no es un registro de auditoria, es
-- una tabla mas. Se revoca la capacidad de modificar o borrar filas a los
-- roles con los que la aplicacion o cualquier usuario final podrian conectarse.
--
-- POR QUE ESTO SI FUNCIONA CONTRA EL SERVICE KEY (a diferencia del problema
-- que se documenta en 002_rls.sql para las demas tablas): en PostgreSQL, el
-- atributo BYPASSRLS (el que tiene el rol "service_role" de Supabase) solo
-- hace que las POLITICAS de row-level security no se evaluen para ese rol.
-- NO afecta al sistema de privilegios de GRANT/REVOKE, que es una capa
-- distinta y anterior: si a un rol se le revoca UPDATE/DELETE sobre una
-- tabla, ese rol no puede ejecutar esas sentencias sobre esa tabla aunque
-- tenga BYPASSRLS, y aunque RLS ni siquiera este activo. Por eso el REVOKE de
-- abajo protege audit_log de verdad, incluso si el backend usa
-- SUPABASE_SERVICE_KEY. (La UNICA excepcion real es un superusuario de
-- Postgres o el dueno de la tabla, que en Supabase normalmente NO es el rol
-- de aplicacion sino "postgres"/el rol que corre las migraciones.)
--
-- Esto es distinto -y no alcanza- para el problema de AISLAMIENTO ENTRE
-- CLINICAS de las demas tablas: ahi el service_role SI necesita poder
-- INSERT/SELECT/UPDATE (solo que acotado por clinica), asi que revocar el
-- privilegio entero no es una opcion. Ver el bloque de cabecera de
-- 002_rls.sql para el mecanismo propuesto en ese caso.
-- =============================================================================
do $$
begin
  revoke update, delete on audit_log from public;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke update, delete on audit_log from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke update, delete on audit_log from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke update, delete on audit_log from service_role;
  end if;
end;
$$;
