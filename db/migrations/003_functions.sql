-- 003_functions.sql
-- Funcion de busqueda vectorial (seccion 3 de la especificacion) + el indice
-- HNSW que la sostiene.
--
-- Nota sobre la ubicacion del indice HNSW: la especificacion (seccion 3)
-- listaba `create index ... using hnsw (embedding vector_cosine_ops);`
-- inmediatamente despues de la tabla knowledge_chunks, es decir, dentro de
-- 001_init.sql. El encargo de esta rama pidio explicitamente que el indice
-- HNSW viva en ESTE archivo ("003_functions.sql: la funcion match_knowledge
-- ... mas el indice HNSW"), junto a la unica funcion que lo usa. Se sigue esa
-- instruccion y se deja constancia de la desviacion respecto del orden
-- literal de la especificacion en el informe final.
create index on knowledge_chunks using hnsw (embedding vector_cosine_ops);

-- match_knowledge: copiada literalmente de la especificacion (seccion 3).
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

-- ---------------------------------------------------------------------------
-- Notas de diseno y dudas abiertas (pedidas explicitamente por el encargo)
-- ---------------------------------------------------------------------------
--
-- 1. SECURITY INVOKER, no DEFINER (deliberado, no es el default implicito sin
--    pensarlo). `language sql stable` sin clausula de seguridad es SECURITY
--    INVOKER por default en Postgres, y se deja asi a proposito: si algun dia
--    esta funcion la llama un rol que SI respeta RLS (no service_role), las
--    politicas de 002_rls.sql sobre knowledge_chunks se siguen aplicando
--    ENCIMA del filtro `k.clinic_id = p_clinic_id` de aqui abajo (defensa en
--    profundidad: dos capas que dicen "solo esta clinica"). Si fuera SECURITY
--    DEFINER, se ejecutaria con los privilegios del dueno de la funcion y
--    podria saltarse RLS incluso para roles que normalmente si la respetan.
--
-- 2. Esta funcion es exactamente el patron "Opcion B" que se propone en el
--    cabezal de 002_rls.sql para el vacio service-key-vs-RLS: recibe
--    p_clinic_id como ARGUMENTO EXPLICITO y lo aplica en el WHERE, en vez de
--    depender de una variable de sesion. Esto la hace correcta incluso
--    llamada con el service key (que bypasea RLS): el aislamiento aqi no
--    depende de RLS sino de que quien invoca la funcion pase el clinic_id
--    correcto -el de TurnContext.clinic.id, ya autenticado por la
--    aplicacion, NUNCA uno que llegue sin validar desde el mensaje entrante-.
--    Si mas adelante se escriben las funciones equivalentes para
--    patients/conversations/messages (ver Opcion B), deberian seguir este
--    mismo molde.
--
-- 3. p_min_similarity = 0.5 por defecto: la formula `1 - (k.embedding <=>
--    p_embedding)` es matematicamente coherente con `<=>` de pgvector
--    (distancia coseno = 1 - similitud_coseno), asi que el resultado de
--    "similarity" SI es similitud coseno en el rango [-1, 1] y el umbral se
--    compara contra la magnitud correcta -no hay bug de signos ni de
--    escala aqui-. Lo que NO se pudo verificar (vacio, no bug): si 0.5 es un
--    umbral razonable para el modelo de embeddings realmente usado. La
--    especificacion fija pgvector pero NO fija el proveedor de embeddings; el
--    resto del codigo (src/infra/config.ts: EMBEDDING_MODEL default
--    'voyage-3', EMBEDDING_DIMENSIONS default 1024, que coincide con el
--    vector(1024) de esta funcion y de knowledge_chunks.embedding) asume
--    Voyage. Para embeddings de texto en general, 0.5 de similitud coseno es
--    un punto de partida razonable (ni tan laxo que devuelva ruido, ni tan
--    estricto que descarte parafraseo), pero el numero correcto depende del
--    modelo y del dominio (preguntas cortas de pacientes vs. fragmentos largos
--    de protocolo) y solo se puede calibrar con datos reales de la clinica:
--    no hay forma de confirmarlo sin correr consultas reales contra la base
--    de conocimiento poblada, que esta rama no tiene. Queda como validacion
--    pendiente de Fase 1/3 (bateria adversarial), no como algo que se pueda
--    cerrar por inspeccion de esta migracion.
--
-- 4. Acoplamiento vector(1024) <-> EMBEDDING_DIMENSIONS: el tipo `vector(N)`
--    de pgvector fija N en el esquema; si algun dia EMBEDDING_MODEL cambia a
--    un modelo con otra dimension, esta funcion Y la columna
--    knowledge_chunks.embedding necesitan una migracion nueva (ALTER COLUMN
--    ... TYPE vector(M) + reindexar + recalcular embeddings existentes). No
--    es algo que se pueda resolver en tiempo de ejecucion via config.
