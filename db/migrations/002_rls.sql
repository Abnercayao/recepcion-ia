-- 002_rls.sql
-- Row Level Security: aislamiento por inquilino (clinica).
--
-- La especificacion (seccion 3) lo pide en una linea: "Activar Row Level
-- Security en todas las tablas con clinic_id y politica de aislamiento por
-- inquilino. Sin esto, un bug de query cruza datos entre clinicas." El
-- informe etico-regulatorio lo eleva a control C9 ("Aislamiento estricto de
-- datos entre clinicas") y la Tabla 14 de criterios de aprobacion para
-- produccion lo marca como BLOQUEANTE ABSOLUTO: "Fugas de datos entre
-- clinicas o entre pacientes = 0".
--
-- =============================================================================
-- VACIO REAL DE LA ESPECIFICACION -- LEER ANTES DE CONFIAR EN ESTE ARCHIVO
-- =============================================================================
--
-- El backend de este sistema se conecta a Supabase con SUPABASE_SERVICE_KEY
-- (ver seccion 14 de la especificacion y src/infra/config.ts). La clave de
-- servicio de Supabase mapea, en Postgres, al rol "service_role", que tiene
-- el atributo BYPASSRLS. Un rol con BYPASSRLS hace que TODAS las politicas
-- creadas en este archivo se ignoren por completo para ese rol: no es que
-- "siempre pase", es que Postgres ni siquiera las evalua.
--
-- Dicho sin rodeos: TAL COMO ESTA DESCRITO EL STACK EN LA SECCION 14, ESTE
-- ARCHIVO NO AISLA NADA EN PRODUCCION. Si src/infra/supabase.client.ts
-- (fuera del alcance de esta rama) se limita a crear el cliente con
-- createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) y usarlo para todo -que es
-- el patron mas comun y el que sugiere la seccion 14 al no mencionar otro
-- mecanismo- entonces un bug de query que olvide el "where clinic_id = ..."
-- SI cruza datos entre clinicas, exactamente el escenario que la
-- especificacion dice que esta migracion evita. Esta migracion, sola, NO
-- cumple el criterio bloqueante de la Tabla 14.
--
-- La especificacion no dice como resolver esta tension (usar el service key
-- para tener acceso administrativo total, pero necesitar aislamiento real por
-- clinica). Es un vacio, no un detalle menor: se senala aqui de forma
-- prominente porque es la pieza que decide si el control C9 existe de verdad
-- o es una politica de papel.
--
-- MECANISMO CONCRETO PROPUESTO (dos variantes; hay que elegir una en la rama
-- que implemente src/infra/supabase.client.ts y core/conversation/*):
--
-- OPCION A -- rol de aplicacion NO-bypass + set_config() por transaccion.
--   1. Crear un rol Postgres nuevo para el backend, SIN el atributo
--      BYPASSRLS (a diferencia de service_role) y sin ser dueno de las
--      tablas: `create role app_backend login password '...' noBypassRLS;`
--      con los GRANT de SELECT/INSERT/UPDATE/DELETE que necesite sobre las
--      tablas de negocio (nunca sobre audit_log en UPDATE/DELETE, ver 001).
--   2. El backend deja de usar @supabase/supabase-js con la service key para
--      las tablas multi-tenant y abre una conexion Postgres directa (pg/
--      postgres-js) autenticada como app_backend.
--   3. Al iniciar CADA transaccion que atiende un turno, la primera sentencia
--      es `select set_config('app.clinic_id', $1, true);` con el clinic_id
--      YA VALIDADO por la aplicacion (nunca el que mande el cliente sin
--      verificar). El `true` final es is_local=true: el valor vive solo
--      dentro de esa transaccion y se limpia solo al hacer COMMIT/ROLLBACK.
--   4. Las politicas de abajo leen ese valor con la funcion app_clinic_id().
--   CUIDADO CON EL POOLING: si el backend usa un pool de conexiones en modo
--   "transaction" (p. ej. supavisor/pgbouncer en modo transaction), esto
--   funciona SOLO SI cada unidad de trabajo (un turno completo) esta envuelta
--   en una unica transaccion explicita que empieza con el set_config. Si en
--   cambio el pool reutiliza la misma sesion entre requests sin abrir
--   transacciones propias, el valor de una peticion puede "sobrevivir" y
--   filtrarse a la siguiente. Esto NO es hipotetico: es la forma mas comun en
--   que este patron se rompe en produccion.
--
-- OPCION B -- funciones/vistas seguras (RECOMENDADA para este proyecto,
-- porque @supabase/supabase-js habla con Postgres a traves de PostgREST, y
-- PostgREST no da una forma comoda de ejecutar `set_config` por request desde
-- el cliente JS; forzarlo requeriria firmar un JWT propio por clinica, un
-- mecanismo que la especificacion tampoco define).
--   1. Ninguna tabla multi-tenant se expone directo al rol que usa el
--      backend: los GRANT de SELECT/INSERT/UPDATE se revocan sobre las
--      tablas y se otorgan solo sobre funciones RPC `security definer` (o
--      vistas) que reciben p_clinic_id como parametro EXPLICITO y lo aplican
--      ellas mismas en el WHERE, en vez de confiar en una variable de sesion.
--   2. match_knowledge() (003_functions.sql) ya sigue exactamente este patron
--      -recibe p_clinic_id explicito y filtra por el en el WHERE- pero esta
--      definida SECURITY INVOKER (no definer) a proposito: ver el comentario
--      en ese archivo. Para el resto de tablas (patients, conversations,
--      messages, etc.) haria falta escribir el equivalente: p.ej.
--      `crear_conversacion(p_clinic_id uuid, p_patient_id uuid, ...)`,
--      `listar_mensajes(p_clinic_id uuid, p_conversation_id uuid, ...)`,
--      llamadas via supabase.rpc(...) desde el backend en vez de
--      supabase.from('conversations').select(...).
--   3. Ventaja: no depende de que variables de sesion sobrevivan
--      correctamente a traves de un pool HTTP/PostgREST; el clinic_id viaja
--      como argumento de la llamada, no como estado ambiental. Desventaja:
--      hay que escribir y mantener una funcion por cada acceso, en vez de
--      apoyarse en el query builder de supabase-js.
--
-- CUALQUIERA DE LAS DOS: las politicas de este archivo siguen siendo
-- necesarias como defensa en profundidad (si algun dia se anade un rol o un
-- panel de administracion que SI respete RLS), pero mientras el UNICO punto
-- de entrada al dato sea un rol con BYPASSRLS, el aislamiento real depende de
-- disciplina en el codigo de aplicacion, no de este archivo. Esto debe
-- quedar explicito en el informe de aprobacion para produccion (Tabla 14):
-- el criterio "fugas entre clinicas = 0" NO puede darse por verificado solo
-- por que exista este archivo.
-- =============================================================================

-- Funcion auxiliar: lee el clinic_id de la sesion/transaccion actual de forma
-- segura. nullif(...,'') evita que un GUC vacio (no seteado, o seteado a '')
-- reviente el cast a uuid; current_setting(..., true) evita el error de
-- Postgres cuando el parametro no existe en absoluto (missing_ok=true ->
-- retorna NULL). Si el resultado es NULL, las comparaciones "= app_clinic_id()"
-- de las politicas no matchean ninguna fila: falla CERRADO por diseno (nadie
-- ve nada si no se seteo el contexto), nunca abierto.
create or replace function app_clinic_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.clinic_id', true), '')::uuid;
$$;

comment on function app_clinic_id() is
  'Lee app.clinic_id seteado por set_config(''app.clinic_id'', <uuid>, true) '
  'al inicio de la transaccion (Opcion A del cabezal de 002_rls.sql). '
  'Devuelve NULL si no se seteo: las politicas de esta migracion fallan '
  'cerradas (0 filas) en ese caso, no abiertas.';

-- ---------------------------------------------------------------------------
-- Tablas con clinic_id directo
-- ---------------------------------------------------------------------------

alter table clinics enable row level security;
alter table clinics force row level security;
create policy tenant_isolation_clinics on clinics
  using (id = app_clinic_id())
  with check (id = app_clinic_id());
-- Nota: el alta de una clinica nueva (INSERT en clinics) no puede pasar por
-- esta politica porque, antes de existir la clinica, no hay un app_clinic_id()
-- valido que la autorice. Es una operacion administrativa: debe correr por un
-- camino con privilegios elevados (el rol dueno de las tablas, o migrate.ts /
-- un panel interno), nunca desde el rol de aplicacion multi-tenant.

alter table patients enable row level security;
alter table patients force row level security;
create policy tenant_isolation_patients on patients
  using (clinic_id = app_clinic_id())
  with check (clinic_id = app_clinic_id());

alter table conversations enable row level security;
alter table conversations force row level security;
create policy tenant_isolation_conversations on conversations
  using (clinic_id = app_clinic_id())
  with check (clinic_id = app_clinic_id());

alter table knowledge_chunks enable row level security;
alter table knowledge_chunks force row level security;
create policy tenant_isolation_knowledge_chunks on knowledge_chunks
  using (clinic_id = app_clinic_id())
  with check (clinic_id = app_clinic_id());

-- ---------------------------------------------------------------------------
-- Tablas que cuelgan de conversations por FK (un nivel: conversation_id)
-- ---------------------------------------------------------------------------

alter table messages enable row level security;
alter table messages force row level security;
create policy tenant_isolation_messages on messages
  using (
    exists (
      select 1 from conversations c
      where c.id = messages.conversation_id
        and c.clinic_id = app_clinic_id()
    )
  )
  with check (
    exists (
      select 1 from conversations c
      where c.id = messages.conversation_id
        and c.clinic_id = app_clinic_id()
    )
  );

alter table tool_calls enable row level security;
alter table tool_calls force row level security;
create policy tenant_isolation_tool_calls on tool_calls
  using (
    exists (
      select 1 from conversations c
      where c.id = tool_calls.conversation_id
        and c.clinic_id = app_clinic_id()
    )
  )
  with check (
    exists (
      select 1 from conversations c
      where c.id = tool_calls.conversation_id
        and c.clinic_id = app_clinic_id()
    )
  );

alter table calls enable row level security;
alter table calls force row level security;
create policy tenant_isolation_calls on calls
  using (
    exists (
      select 1 from conversations c
      where c.id = calls.conversation_id
        and c.clinic_id = app_clinic_id()
    )
  )
  with check (
    exists (
      select 1 from conversations c
      where c.id = calls.conversation_id
        and c.clinic_id = app_clinic_id()
    )
  );

-- ---------------------------------------------------------------------------
-- Tablas que cuelgan de calls, que a su vez cuelga de conversations
-- (dos niveles: call_id -> calls.conversation_id -> conversations.clinic_id)
-- ---------------------------------------------------------------------------

alter table transcripts enable row level security;
alter table transcripts force row level security;
create policy tenant_isolation_transcripts on transcripts
  using (
    exists (
      select 1 from calls c
      join conversations co on co.id = c.conversation_id
      where c.id = transcripts.call_id
        and co.clinic_id = app_clinic_id()
    )
  )
  with check (
    exists (
      select 1 from calls c
      join conversations co on co.id = c.conversation_id
      where c.id = transcripts.call_id
        and co.clinic_id = app_clinic_id()
    )
  );

alter table audio_events enable row level security;
alter table audio_events force row level security;
create policy tenant_isolation_audio_events on audio_events
  using (
    exists (
      select 1 from calls c
      join conversations co on co.id = c.conversation_id
      where c.id = audio_events.call_id
        and co.clinic_id = app_clinic_id()
    )
  )
  with check (
    exists (
      select 1 from calls c
      join conversations co on co.id = c.conversation_id
      where c.id = audio_events.call_id
        and co.clinic_id = app_clinic_id()
    )
  );

alter table latency_metrics enable row level security;
alter table latency_metrics force row level security;
create policy tenant_isolation_latency_metrics on latency_metrics
  using (
    exists (
      select 1 from calls c
      join conversations co on co.id = c.conversation_id
      where c.id = latency_metrics.call_id
        and co.clinic_id = app_clinic_id()
    )
  )
  with check (
    exists (
      select 1 from calls c
      join conversations co on co.id = c.conversation_id
      where c.id = latency_metrics.call_id
        and co.clinic_id = app_clinic_id()
    )
  );

-- ---------------------------------------------------------------------------
-- audit_log: clinic_id es NULLABLE (hay eventos de plataforma sin clinica).
-- Se habilita RLS para lectura/insercion, pero DELIBERADAMENTE no se crea
-- ninguna politica de UPDATE ni DELETE: combinado con RLS activo, cualquier
-- rol sujeto a RLS (es decir, sin BYPASSRLS) queda sin ninguna politica
-- permisiva para esas dos operaciones, lo que las bloquea por defecto. La
-- proteccion real contra roles con BYPASSRLS (como service_role) es el
-- REVOKE explicito ya aplicado en 001_init.sql, que es independiente de RLS.
-- ---------------------------------------------------------------------------

alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy tenant_isolation_audit_log_select on audit_log
  for select
  using (clinic_id is null or clinic_id = app_clinic_id());
create policy tenant_isolation_audit_log_insert on audit_log
  for insert
  with check (clinic_id is null or clinic_id = app_clinic_id());
