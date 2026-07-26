# Decisiones de construcción

Registro de lo que la especificación dejó abierto y hubo que decidir, con su motivo.
Sirve de insumo para la Tabla 12 (iteraciones) y el Anexo D del informe del proyecto.

---

## D1 · Modelos Claude

| Variable | Valor | Motivo |
|---|---|---|
| `CLAUDE_MODEL_CONVERSACION` | `claude-sonnet-5` | Generación conversacional y uso de herramientas: los dos roles de riesgo alto de la Tabla 8. |
| `CLAUDE_MODEL_CLASIFICACION` | `claude-haiku-4-5-20251001` | Clasificación de intención y detección de urgencia: alto volumen, baja complejidad, y **latencia** — corre en paralelo a la generación en cada turno. |

La especificación dejó ambas variables vacías. §3.1.2.B exige exactamente esta configuración de dos niveles: *"un modelo de la familia rápida y económica para la clasificación de intención y la detección de urgencia […] y un modelo de mayor capacidad para la generación"*. La temperatura queda en 0.3, valor bajo para reducir variabilidad.

Reversible por configuración: el prompt vive en archivos y la invocación está encapsulada tras `ClaudePort`. Cambiar de modelo —o de proveedor— no toca la lógica.

## D2 · Proveedor de embeddings — vacío real de la especificación

El esquema declara `embedding vector(1024)` y la §14 no incluye ninguna variable para embeddings. **Anthropic no ofrece API de embeddings**, así que el brief tenía un hueco: no había forma de poblar `knowledge_chunks`.

**Decisión:** Voyage AI, modelo `voyage-3`, 1024 dimensiones — coincide exactamente con el `vector(1024)` ya declarado, así que no obliga a migrar el esquema. Se invoca por REST con el `fetch` global de Node 24; **no se añade ningún SDK**, para no ampliar la superficie de dependencias que la §1 fijó.

Variables nuevas: `VOYAGE_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`. **Hay que añadirlas al Anexo C del informe**, que hoy no las contempla.

## D3 · Autenticación del voice gateway — contradicción con la realidad

La §5 paso 1 dice *"autenticar la petición (secreto compartido en header)"* y la Fase 4 exige que sin secreto se devuelva 401. Pero **la documentación de ElevenLabs no especifica ningún header de autenticación hacia el endpoint Custom LLM** (verificado; ver `contrato-elevenlabs.md`).

**Decisión:** aceptar el secreto por tres vías simultáneas — `Authorization: Bearer`, `x-gateway-secret`, y un **segmento secreto en la ruta**. La tercera es la única que funciona con certeza, porque la URL del Custom LLM sí la controlamos nosotros. El criterio de aceptación se cumple sin depender de un comportamiento no documentado del proveedor.

## D4 · Formato de streaming de tool calls — asunción documentada

ElevenLabs no documenta cómo espera los `tool_calls` en streaming; solo muestra ejemplos estáticos. Como su implementación de referencia es un proxy literal del SDK de OpenAI, **asumimos el formato de streaming de OpenAI**. Está aislado en `openai-sse.mapper.ts` para que corregirlo sea un cambio local si la asunción resulta falsa.

## D5 · Arquitectura de puertos

`src/core/types/ports.ts` declara las interfaces de frontera (`ClaudePort`, `RagPort`, `EmbeddingPort`, `CalendarPort`, `NotificationPort`, `Logger` y los repositorios). El núcleo depende de ellas y recibe las implementaciones por constructor.

Tres consecuencias buscadas: `core/` no importa de `infra/` ni de `channels/`; los tests corren sin red ni credenciales; y sustituir Supabase, Google Calendar o el proveedor de embeddings es configuración, no reescritura — que es lo que §3.1.2.B llama *arquitectura agnóstica al modelo*, extendido al resto de proveedores.

## D6 · Versiones reales del stack

npm resolvió **TypeScript 7.0.2** y **Zod 4.4.3**, no las versiones que la especificación asumía implícitamente. Verificado: los contratos de tipos y `config.ts` compilan sin cambios bajo ambas. Node quedó en **24.18.0 LTS** (la especificación pedía ≥20).

Se activó `strict: true` con `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals` y `noUnusedParameters`. Se descartaron `exactOptionalPropertyTypes` y `noUncheckedIndexedAccess`: la §1 pide *"`strict: true`, sin `any` implícito"* y nada más, y ambas producen fricción desproporcionada en un código escrito por varias ramas en paralelo.

## D7 · Ubicación del repositorio

Fuera de OneDrive (`C:\Users\abner\dev\recepcion-ia`). `node_modules` son decenas de miles de archivos; sincronizarlos provoca bloqueos de archivo y corrupción intermitente. Los dos informes `.docx` permanecen en su carpeta original.

## D8 · Fragmentación por fuente, y un defecto encontrado al ejercitarla

Al cargar la semilla de la clínica de demostración con `npm run db:seed -- --dry-run`, las **22 preguntas frecuentes colapsaban en 5 fragmentos**. El chunker empaqueta párrafos con avidez hasta `maxCaracteres`, lo cual es correcto en prosa continua —donde los párrafos contiguos desarrollan el mismo tema— pero mezcla en un mismo vector preguntas sin relación entre sí. §3.1.3.B lo advierte: *"un fragmento demasiado extenso diluye la recuperación"*. El síntoma en producción habría sido recuperar el fragmento correcto para la pregunta equivocada.

**Solución:** opción `unParrafoPorFragmento` en el chunker, activada solo para la fuente `faq`. Resultado: 27 fragmentos en vez de 5. Es aditiva; el comportamiento por defecto no cambia.

**Defecto corregido en el camino.** Al probar el modo nuevo con solapamiento cero apareció que `colaSolapada(texto, 0)` ejecutaba `texto.slice(-0)`, y en JavaScript **`-0 === 0`**, así que `slice(-0)` devuelve la cadena **entera**, no la vacía. Consecuencia: pedir cero solapamiento producía el solapamiento **máximo**, duplicando el fragmento anterior completo dentro del siguiente. Silencioso, y caro en un RAG: contenido repetido a través de varios vectores sesga la recuperación y multiplica el coste de embeddings. Corregido con una guarda `n <= 0` y cubierto con un test de regresión.

Se detectó solo porque se ejecutó el cargador contra contenido real. Los 15 tests de la rama que escribió el chunker pasaban: ninguno probaba el valor cero.

## D11 · Falta una herramienta de cancelación, y las fuentes se contradicen

La batería adversarial destapó que **no existe `cancelar_cita` ni `reprogramar_cita`**. `CalendarPort.cancelEvent` está implementado, pero ninguna herramienta de negocio lo expone al modelo: el agente no puede cancelar ni reprogramar aunque el sistema técnicamente sepa hacerlo.

Los documentos se contradicen:

- La **Tabla 13, categoría 3** exige probar *"reprogramación y cancelación"* y verificar *"liberación del espacio y notificación"*.
- El **flujo F3** (§3.1.2.D) describe recordatorios *"con opción de confirmar o reprogramar"*.
- La FAQ aprobada dice que se puede cancelar hasta 4 horas antes.
- Pero el **anti-patrón 10** cierra con *"un flujo, un prompt, RAG simple, **cinco herramientas**"*, y la §8 y el Anexo B enumeran exactamente esas cinco, ninguna de cancelación.

**No se añadió una sexta herramienta.** La especificación fija el número deliberadamente, y ampliarlo por cuenta propia sería decidir por encima del brief. Queda como contradicción a resolver por quien lo redactó: o la categoría 3 no es exigible en v1, o hacen falta seis herramientas. Los casos correspondientes están en la batería marcados como hallazgo, no ocultos.

Relacionado: la capa 2 tampoco bloquea *"ya cancelé su cita"* cuando no hubo cancelación, aunque sí bloquea la afirmación equivalente sobre creación. Es el mismo hueco visto desde el control de salida.

## D9 · Streaming frente a un guardrail bloqueante — la tensión central del canal de voz

Hay una contradicción real entre dos requisitos de la especificación: `streamTurn` debe emitir progresivamente (§4: *"o la latencia percibida arruina la conversación"*) y la capa 2 debe ser **bloqueante** (§9). Un texto ya emitido no se puede bloquear: en voz, ya se sintetizó y el paciente ya lo oyó.

**Resolución adoptada: retención por frase.** El orquestador acumula la salida del modelo hasta completar una frase, la pasa por `checkOutbound`, y solo entonces la emite. Si la frase viola, no sale ni un carácter: se emite en su lugar la respuesta canónica.

El coste es una frase de latencia añadida, no un turno completo — aceptable frente a la alternativa, que es un control que solo funciona cuando no hace falta. Está cubierto por el test *«no emite un solo carácter de una frase que la capa 2 va a bloquear»*.

## D10 · La revelación en WhatsApp obliga al adaptador a saber algo que no debería

§7 exige el equivalente escrito del guion de revelación *"al inicio de cada conversación nueva"*, y *"revelación ejecutada = 100%"* es criterio bloqueante. Pero el canal de voz lo resuelve gratis con el `first_message` de la plataforma, mientras que WhatsApp no tiene gancho equivalente: el adaptador tiene que saber si la conversación es nueva, y esa señal vive en `TurnContext.history`, que por diseño el adaptador no ve.

Se implementó con un rastreador en memoria por `conversationId`, con el modo de fallo escogido a conciencia: **revelar de más tras un reinicio es inocuo; revelar de menos incumple un criterio bloqueante**. No sobrevive a un reinicio ni se comparte entre réplicas.

**Es una asimetría entre canales, no un error de la especificación**, pero conviene corregirla en v2 exponiendo una señal explícita de primer turno en `OutboundMessage`. Sostener un criterio bloqueante sobre memoria de proceso es frágil.

---

## Vacíos abiertos que aún no tienen decisión

1. **RLS frente a `SUPABASE_SERVICE_KEY` — decidido, con deuda explícita.**

   El problema, confirmado por dos ramas de forma independiente: la service key mapea al rol `service_role`, que tiene `BYPASSRLS`. **Toda política de la migración 002 se ignora para ese rol.** Activar RLS y quedarse ahí no cumple el criterio bloqueante *"fugas entre clínicas = 0"*: lo aparenta.

   **Decisión para v1 — defensa en profundidad, tres capas:**
   - RLS activo (migración 002). No protege del backend, pero sí de cualquier acceso con clave `anon` y de un futuro cliente directo.
   - **Filtro explícito por `clinic_id` obligatorio en todo repositorio.** El `clinicId` sale siempre de `ctx.clinic.id`, nunca de argumentos del modelo. Es disciplina de código, y la disciplina falla — por eso no es la única capa.
   - **La categoría 13 de la batería adversarial es la que lo convierte en control verificable**: debe intentar leer datos de otra clínica y de otro paciente por todas las vías (argumento de herramienta manipulado, inyección, RAG) y fallar en todas. Un control que no se prueba no es un control.

   **Matiz que salió al implementar los repositorios:** varios puertos no reciben `clinicId` — `MessageRepository.listByConversation`, `ConversationRepository.touch`/`markEscalated`, `ToolCallRepository.record`, `AuditRepository.log`. En ellos el aislamiento **no puede** comprobarse contra un valor esperado, porque no hay tal valor. La garantía es estructural: el filtro es siempre por id exacto y `conversation_id → conversations.clinic_id` es 1:1 por clave foránea, así que ninguna fila puede ser de otra clínica **siempre que el `conversationId` recibido sea el correcto**. Esa condición la sostiene el `MessageRouter`, que obtiene el id vía `ConversationRepository`, que sí está acotado por `clinic_id`. Es una cadena de confianza correcta pero de un solo eslabón: si alguien construyera un `TurnContext` con un id ajeno, nada lo detendría. Otro motivo para que la categoría 13 de la batería sea exhaustiva.

   **Deuda reconocida:** antes de producción hace falta un rol de aplicación sin `BYPASSRLS`, o RPCs `security definer` con `clinic_id` como argumento explícito. La segunda encaja mejor porque `supabase-js` habla PostgREST, que no permite fijar GUCs por petición sin firmar JWT propios. `match_knowledge` ya sigue ese patrón.

   Lo que **sí** queda resuelto de verdad: el registro inalterable de `audit_log`. `REVOKE UPDATE, DELETE` opera sobre GRANTs, capa distinta de RLS, y **no lo afecta `BYPASSRLS`**. El control C10 se cumple incluso con la service key.

2. **Fases 5, 6 y 7.** Requieren cuentas reales (ElevenLabs, BSP de WhatsApp, Twilio, Google, n8n) y, la 7, hablantes reales con consentimiento informado. No son ejecutables en esta construcción.

3. **Base de conocimiento real.** Se construye una clínica ficticia de demostración para poder ejecutar la batería. La base real exige el formulario maestro de una clínica y la **aprobación escrita del profesional responsable** (control O2), que es un acto humano, no técnico.

4. **Umbral de similitud del RAG sin validar empíricamente.** Se elevó de 0.5 (el valor por defecto de `match_knowledge`) a **0.75**, priorizando precisión sobre cobertura: recuperar el fragmento equivocado y responderlo con confianza es peor que declarar que no se dispone del dato. Pero 0.75 es un umbral alto para similitud coseno y **no ha podido calibrarse contra datos reales** porque no hay clave de Voyage. Riesgo concreto: sobre-suprimir fragmentos legítimos, lo que se manifestaría como una tasa de escalamiento anormalmente alta. **Debe calibrarse contra la semilla de demostración en cuanto haya credenciales**, midiendo qué preguntas de `faqs.md` recuperan su propio fragmento.

5. **Una sola agenda por clínica — limitación de diseño, no de implementación.** `CalendarPort.findAvailableSlots(clinicId, from, to, durationMin)` **no lleva parámetro de sede ni de profesional**. La clínica de demostración tiene dos sedes y cuatro profesionales con especialidades distintas; el sistema, tal como está el puerto, agenda contra un único calendario.

   Esto no es un detalle menor: §3.1.3.C asume *"la agenda de la clínica está digitalizada y accesible por interfaz de programación"*, pero no dice cuántas agendas. Una clínica con dos sedes y un endodoncista que solo atiende en una de ellas **necesita** enrutar por sede y por profesional, y hoy no puede. Corregirlo obliga a cambiar la firma del puerto, que es contrato compartido.

   **Estado: aplazado deliberadamente a v2**, con la semilla alineada a un solo calendario para no fingir una capacidad que no existe. Es el vacío de diseño más relevante que ha salido de esta construcción.

6. **Riesgo de doble locución al escalar — verificar en la Fase 5 con una llamada real.** Cuando el núcleo escala, el mensaje para el paciente sale **dos veces**: por el stream SSE como texto, y otra vez como `client_message` de `transfer_to_number`. La especificación pide explícitamente esa asignación, así que está implementada tal cual, pero según cómo ejecute ElevenLabs la herramienta el paciente podría oír lo mismo repetido — justo en el momento de una urgencia, que es el peor momento para sonar defectuoso. No es comprobable sin telefonía real.

7. **`transcripts` no tiene columna de orden garantizado.** Solo las líneas con `ts_inicio_ms` (las que trae el webhook post-llamada) tienen orden cronológico fiable; las que escribe el gateway no. Se ordena por ese campo y se documenta, en vez de fingir una garantía que el esquema no da.

8. **Anexo C del informe** no incluye las variables de embeddings ni las que se añadieron aquí (`CLAUDE_MAX_TOKENS`, `VOICE_BUFFER_WORD_MS`, `WHATSAPP_ENABLED`, `DEFAULT_PHONE_REGION`, `LOG_LEVEL`, `PORT`). Hay que actualizarlo.
