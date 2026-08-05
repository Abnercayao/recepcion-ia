# Continuar aquí

Traspaso entre sesiones. Lo que hace falta saber para seguir sin releer todo el
historial. **Estado a 4 de agosto de 2026**, commit `38bbb84`.

Léelo junto con [`ESTADO.md`](ESTADO.md), que tiene el detalle de cada asunto
abierto con sus mediciones.

---

## Lo primero: en qué punto está

El sistema funciona de punta a punta por texto y por voz. Lo que queda no es
construir, es **medir y afinar**.

| Pieza | Estado |
|---|---|
| Chat de texto (web) | funciona · `npm run demo:web` → `localhost:4000` |
| Chat de voz (widget en la web) | funciona · widget de ElevenLabs embebido |
| Base de conocimiento | 39 fragmentos activos, aprobados a nombre de Abner Cayao |
| RAG | `voyage-3-large`, umbral 0.45, con respaldo léxico |
| Google Calendar | agendamiento verificado: lee huecos y crea citas con la hora correcta |
| Escalamientos | llegan a n8n Cloud y al panel local `/recepcion` |
| Telefonía | **no** hay número. Twilio pide perfil de cumplimiento |
| Web pública | túnel a `:4000`, verificado desde fuera. Ver más abajo |

---

## La traza de turno (hecha)

La web muestra, bajo cada respuesta y con «Detalle técnico» activado, **cada
salto del turno con su duración y su detalle**: enrutado, capa 1, clasificador
de urgencia, RAG, ensamblado del prompt, cada llamada al modelo, cada
herramienta con sus argumentos y su resultado, las decisiones de la capa 2 y la
persistencia. Más un panel aparte con el canal de voz.

| Pieza | Dónde |
|---|---|
| Tipos y recolector | `src/core/observabilidad/traza.ts` |
| Almacén en memoria + enmascarado PII | `src/infra/traza.memoria.ts` |
| Emisión durante el turno | `src/core/conversation/conversation.service.ts` |
| Cómo resolvió el RAG | `src/core/rag/diagnostico.ts`, `rag.service.ts` |
| Voz en modo alojado | `src/channels/voice/webhook-tools.controller.ts` |
| Interfaz | `web/chat.js` (`pintarTraza`), `web/estilos.css` |

**Es dependencia opcional.** Sin recolector inyectado, `TRAZA_NULA` deja el
comportamiento idéntico al de antes; por eso instrumentar no obligó a tocar un
solo test existente.

**El diagnóstico del RAG viaja en la llamada**, no en una propiedad del
servicio: el servicio es único y lo comparten los dos canales, así que un
«último diagnóstico» mutable se pisaría entre un turno de voz y uno de texto
simultáneos.

**El endpoint de trazas del núcleo va protegido** (`/v1/g/:secret/trazas`, con
`VOICE_GATEWAY_SECRET`) y la web lo pide **desde el servidor**, no desde el
navegador: el puerto 3000 se publica por un túnel y las trazas llevan lo que
dijo el paciente. Sin secreto configurado, la ruta no se registra.

### Lo que encontró el primer día

1. **La latencia es el modelo, no las herramientas.** Medido en un turno de
   agendamiento: 13 235 ms totales, de los cuales **13 211 ms son las tres
   llamadas al modelo** y 2 ms las herramientas. Confirma lo que se sospechaba
   y lo deja medido.
2. **`consultar_agenda` se invocó dos veces** en un mismo turno para la misma
   petición. Cada repetición cuesta una ida y vuelta más al modelo: la segunda
   costó 4,1 s. Es el candidato más claro para bajar latencia.
3. **Falso positivo de la capa 2**, reparado (ver abajo).

---

## Los DOS MODOS del agente, y por qué importa

Es la decisión de fondo. `npm run agente:alojado -- --revertir` vuelve al modo
seguro; `-- --tunel https://<dominio>` pone el modo rápido.

| | Custom LLM (núcleo en el camino) | Modelo alojado (actual) |
|---|---|---|
| Razona | nuestro `ConversationService` | Qwen, dentro de ElevenLabs |
| **Capa 2 sobre la salida** | ✅ | ❌ **no existe hook de salida** |
| Capas 1 y 3 | ✅ | ❌ |
| Validación Zod + invariantes + `tool_calls` | ✅ | ✅ |
| Historial autoritativo y continuidad multicanal | ✅ | ❌ |
| Latencia | 12–14 s | **sin medir** |

**Ahora mismo está en modo alojado.** Se comprobó contra la documentación del
proveedor que no ofrece ningún mecanismo para inspeccionar el texto antes de
sintetizarlo, así que la capa 2 no puede existir en ese modo. Lo que queda es
que el modelo no pueda *hacer* lo que quiera aunque pueda *decir* lo que quiera.

**La prueba pendiente que decide**: correr la batería adversarial contra el modo
alojado. Está calibrada contra el prompt y los guardrails del núcleo, así que
habría que reescribirla para hablar con el agente de ElevenLabs. Es lo que diría
el precio exacto de la velocidad.

Hay una **tercera opción no construida**: implementar `ClaudePort` contra un
proveedor compatible con OpenAI, para usar un modelo rápido **conservando las
tres capas**. Es un adaptador nuevo para un puerto que ya existe; no toca el
núcleo.

---

## Servicios que hay que tener levantados

```bash
npm run demo:web    # web + panel de recepción, puerto 4000
npm run dev         # núcleo + gateway de voz + webhook tools, puerto 3000
```

Y **dos túneles distintos**, que no hay que confundir:

```bash
# 1. Voz: para que ElevenLabs alcance la maquina. Sin el, no hay llamadas.
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000 --no-autoupdate

# 2. Web publica: para que cualquiera abra la pagina desde internet.
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:4000 --no-autoupdate
```

Son independientes y conviven sin problema. **Matar el de 3000 tumba la voz aunque
la web siga en pie**: la página pública sirve el widget, pero el widget llama a
ElevenLabs y ElevenLabs llama a los webhooks del túnel de 3000.

⚠ **`clinica.json` y la fila de Supabase son DOS fuentes de verdad.**
El archivo es la semilla; **la fila manda en producción**. Ya mordió dos veces:
se añadieron las sedes y luego los feriados a la semilla, pasaron las pruebas,
quedaron bien en la web —que lee el archivo— y por **voz** seguían sin existir,
porque nadie actualizó la fila. El 6 de agosto, feriado, se seguía agendando.

Cada vez que cambie `db/seed/clinica-demo/clinica.json`:

```bash
npm run db:seed -- --solo-clinica
```

Actualiza `clinics.config` y **no** toca la base de conocimiento —reejecutar la
carga completa duplicaría los fragmentos y obligaría a re-aprobarlos a mano
(control O2)—.

⚠ **El repositorio y el agente de ElevenLabs son DOS fuentes de verdad.**
Cambiar el prompt en el código no lo publica. Ya mordió una vez: el defecto de
las sedes se reparó, pasó las pruebas y quedó bien por texto, pero **por voz
siguió roto** porque nadie ejecutó `npm run agente:alojado`. Ante «estoy en
Comas» el agente ofrecía otras sedes y no la de Comas, que sí existe.

Antes de una demostración, o después de tocar `prompts/` o la semilla:

```bash
npm run agente:alojado -- --verificar
```

Compara el prompt vivo con el del repositorio, avisa si falta la lista de sedes
y muestra la configuración de voz. Sale con código 1 si hay desfase.

⚠ **Los túneles cambian de dominio cada vez que se reinician.** Cuando le pase al
de 3000 hay que actualizar en el panel de ElevenLabs: el Custom LLM, el webhook
de iniciación y el post-llamada; y volver a ejecutar
`npm run agente:alojado -- --tunel <nuevo>` si se está en modo alojado. Cuando le
pase al de 4000, basta con repartir la URL nueva: no hay nada que reconfigurar.

**La web pública no tiene ninguna protección**, por decisión explícita: sin
límite por IP y sin código de acceso. Cada mensaje que escriba cualquiera con el
enlace gasta crédito de `ANTHROPIC_API_KEY`. Mientras el enlace circule poco no
pasa nada; si se publica en abierto, conviene poner un tope antes.

⚠ **`GET /api/trazas` del puerto 4000 tampoco está protegido**, y lista los
turnos recientes de **todos** los visitantes, no solo los de quien pregunta.
Todo pasa por `maskPII` —teléfonos, DNI y correos salen enmascarados— pero el
texto libre que escriba un visitante lo puede leer otro. Con datos ficticios y
un enlace que circula a mano es asumible; en cuanto haya una persona real
escribiendo, hay que cerrarlo. La salida más barata es exigir el mismo
`VOICE_GATEWAY_SECRET` que ya protege el endpoint del núcleo: son cuatro líneas
en `scripts/web.ts`, calcadas de las de `src/server.ts`.

Ojo con la asimetría: el puerto 3000 **sí** protege sus trazas, porque ahí viven
las conversaciones de voz, que son llamadas reales.

`tsx watch` **no vigila el `.env`**: tras cambiarlo hay que forzar recarga
tocando `src/server.ts`.

---

## Configuración externa, dónde vive cada cosa

| Servicio | Detalle |
|---|---|
| **ElevenLabs** | agente `agent_3001kyfz28j4f728rxkp7a3bnerp` («Recepcionista_IA»). Voz *Nelly - Warm Peruvian Spanish*, `eleven_v3_conversational`, `expressive_mode: true`, `stability: 0.75`. LLM de respaldo **desactivado** a propósito. `cascade_timeout_seconds: 15` (máximo permitido) |
| **n8n Cloud** | `recepcioniabot.app.n8n.cloud`, flujo «F4 - Notificar escalamiento» publicado. Solo recibe y registra: no manda SMS ni correo |
| **Google Calendar** | proyecto `calcium-post-365206`, cuenta de servicio `recepcion-ia-agenda@…`, calendario `723a5338…@group.calendar.google.com`, zona horaria de Perú |
| **Supabase** | 12 tablas, migraciones 001–003 aplicadas |
| **Voyage** | plan de pago. Antes el límite de 3 peticiones/minuto rompía el RAG |

Todas las claves están en `.env`, que **no** se versiona. Hay un `.env.example`
eliminado a propósito: contenía credenciales reales.

---

## Defectos abiertos (los que muerden)

1. ~~**El modelo inventa cuando el RAG no recupera.**~~ **REPARADO.**

   La causa no era del todo la que se creía. «Trabajamos con sede única» no lo
   inventó el modelo: se lo dábamos escrito. `sedeDe()` en `prompt.builder.ts`
   devolvía la cadena literal `'sede unica'` cuando `clinic.config.sede` no
   existía —y no existe en la semilla, cuya clave es `sedes_informativas`—, así
   que el valor por defecto entraba al bloque de sesión **en todos los turnos**
   como un dato más.

   Lo segundo sí era el RAG: ante «¿qué sedes tienen?» recuperaba el fragmento
   de franquicias y el modelo contestaba 8 de 24. Y `clinic.config` solo tenía
   las 16 propias; las 8 franquicias vivían únicamente en la base de
   conocimiento.

   Reparado en tres sitios: la lista completa se añadió a `clinic.config`
   (`sedes_franquicia`), se renderiza en el bloque de sesión con
   `renderizarSedes()` —la misma función que usa el modo alojado, que descarta
   los bloques 8 y 9 y se habría quedado sin ellas—, y la prohibición 5 del
   prompt ahora admite los DATOS DE SESIÓN como fuente válida, que si no el
   modelo no tendría permiso para usarlos. Verificado contra el modelo real:
   24 sedes, ninguna mención a sede única. Regresión cubierta en
   `tests/unit/prompt.builder.test.ts`.

   ⚠ La línea roja «nunca inventar datos ausentes de la base» **sigue sin
   control automático en capa 2**. Esto cierra el caso de las sedes, no la
   clase entera.

2. ~~**Falso positivo de la capa 2 al ofrecer cita.**~~ **REPARADO.**

   Lo encontró el panel de traza el primer día. En español, la primera persona
   del pretérito y la del subjuntivo se escriben igual: «ya le *agendé* la
   cita» y «¿quiere que le *agende* una cita?». `PATRONES_DE_CITA_AFIRMADA`
   solo miraba la forma verbal y bloqueaba las dos, así que al paciente le
   llegaba pegado un «todavía no le puedo dar la cita por segura» sin venir a
   cuento. No era un caso raro: **ofrecer la cita es el cierre comercial del
   propio prompt**.

   Reparado con `OFRECIMIENTO_PREVIO`, una lista cerrada de verbos de
   ofrecimiento seguidos de «que». Un «que» suelto no exime: «le confirmo que
   ya le agendé» sigue bloqueando. De paso se cerró un hueco de
   `primerMatchAfirmativo`, que al encontrar un match exento abandonaba el
   patrón y perdía las apariciones posteriores del mismo.

3. ~~**Agendamiento: feriados, horario y sede.**~~ **REPARADO.** Eran cuatro
   defectos con la misma raíz —el código leía claves de configuración que la
   semilla no tiene— y el mismo modo de fallo: en vez de avisar, se aplicaba un
   valor por defecto inventado y el agente agendaba mal con aplomo.

   | Defecto | Qué pasaba | Dónde |
   |---|---|---|
   | Horario no leído | Leía `config.horario` (singular); la semilla tiene `horarios` (plural, con tramos). Nunca casaba → defecto 08:00–20:00 L–S. Agendaba antes de abrir, en la pausa de mediodía, tras cerrar y sábado por la tarde | `crear-cita.tool.ts` |
   | Sin feriados | El concepto no existía en ninguna capa. El 6/8, Batalla de Junín, se agendaba igual | ninguna |
   | Disponibilidad falsa | En la web, `CalendarDoble.slots` arranca vacío → `findAvailableSlots` devolvía **siempre** `[]`. Con Google, la rejilla se anclaba en un `desde` arbitrario y una ventana más corta que la cita daba cero huecos | `consultar-agenda.tool.ts` |
   | Sin sede | `crear_cita` no tenía el campo. Agendaba sin preguntar en cuál de las 24 | `crear-cita.tool.ts` |

   La lógica vive ahora en **`src/core/agenda/horario.ts`**, en el núcleo y no en
   el adaptador: hay dos implementaciones de `CalendarPort` y el horario es
   regla de negocio, no un detalle de Google. Puesta ahí, la cumplen las dos.

   Cambios que conviene conocer:
   - **`consultar_agenda` genera los huecos**, ya no los pide a
     `findAvailableSlots`. Nacen del horario real, alineados al comienzo de cada
     tramo y saltando feriados, y se verifican con `isSlotFree` **en paralelo**
     (en serie serían catorce idas y vueltas sobre un turno en espera).
   - Devuelve un campo **`motivo`** cuando la lista va vacía: «feriado» y «lleno»
     son cosas distintas y el modelo se inventaba cuál.
   - **`sede` es requerida en el esquema de `crear_cita`.** No es una regla del
     prompt: la corta Zod. Importa sobre todo en **modo alojado**, donde no hay
     capa 2 y la validación es el único control que queda en pie.
   - El horario de respaldo, cuando la clínica no declara nada, es
     deliberadamente **estrecho** (L–V 09:00–13:00) y avisa. Antes abría de más
     en silencio, que es lo que dejaba colar las citas.

   ⚠ **La lista de feriados es dato de la clínica, no una fuente legal.** Está
   en `clinic.config.feriados` y llega hasta 2026-12-25. El código **no** calcula
   fiestas móviles (Jueves y Viernes Santo cambian cada año) ni conoce feriados
   regionales ni cierres propios. Cuando se acabe la lista, `verificarApertura`
   deja de bloquear feriados y solo queda el horario semanal. **Hay que
   revisarla cada año.**

   **Cada sede tiene ya su propia agenda** (ver el punto siguiente).

4. ~~**Una sola agenda para 24 sedes.**~~ **REPARADO — y obligó a tocar el
   contrato congelado.**

   Las 24 sedes compartían `googleCalendarId`, así que la ocupación de una
   bloqueaba a todas: si Comas estaba lleno, Miraflores aparecía lleno también.
   No era un detalle técnico, era un error de negocio.

   **`src/core/types/ports.ts` cambió.** Es el contrato compartido que CLAUDE.md
   marca como congelado, y el cambio es **aditivo** para no romper nada:
   - `sede?: string` opcional en `findAvailableSlots`, `isSlotFree`,
     `createEvent` y `cancelEvent`. Una implementación que lo ignore sigue
     cumpliendo el contrato: se comporta como clínica de sede única.
   - `CalendarEvent` gana `sede?`, `pacienteTelefono?` y `pacienteNombre?`.
   - `CalendarSlot` gana `sede?`.

   El calendario concreto se resuelve por sede en
   `clinic.config.calendarios_por_sede` (`{ "comas": "xxx@group.calendar.google.com" }`).
   La **idempotencia** de `createEvent` incluye ahora la sede en el hash: el
   mismo paciente a la misma hora en dos sedes son dos citas distintas, no un
   reintento.

   ⚠ **Falta la configuración, no el código.** `calendarios_por_sede` está
   VACÍO en la semilla: hay que dar de alta un calendario de Google por sede y
   compartirlo con la cuenta de servicio con permiso para «Hacer cambios en los
   eventos». Mientras una sede no tenga el suyo se cae a `googleCalendarId` **y
   el cliente avisa por el log** — esa sede sigue compartiendo agenda. El aviso
   es deliberado: seguir mezclando en silencio es justo el fallo que se corrigió.

   La web de demostración **sí** separa por sede (`CalendarDoble` particiona),
   así que ahí el comportamiento correcto se ve hoy. Verificado en vivo: con
   Comas ocupado a las 10:00, Miraflores ofrece las 10:00; y Comas ya no.

5. ~~**La cita no llevaba al paciente.**~~ **REPARADO.** El doble de agenda
   descartaba `patientPhone`, así que en la web las citas se creaban sin ningún
   dato de quien las pedía. Ahora el evento lleva teléfono y sede, y el título
   es `motivo · paciente · sede`. Sin teléfono no se puede confirmar ni
   reprogramar: recepción no sabe a quién llamar.

   Pendiente menor: el **nombre** solo entra si está en el registro del
   paciente (`ctx.patient.nombre`). El arnés de la web no lo captura aunque el
   paciente lo diga en la conversación, así que el título cae al teléfono. En
   los canales reales llega por `InboundMessage.patientName`.

6. **Latencia.** En modo Custom LLM, 12–14 s en turnos con herramientas, contra
   un objetivo declarado de 1200 ms y un corte del proveedor de 15 s. Sin
   margen. **Ya medido con la traza**: en un turno de agendamiento, 13 211 ms
   de 13 235 fueron las tres llamadas al modelo y 2 ms las herramientas. El
   cuello son las idas y vueltas, confirmado.

   Lo más rentable ahora: **evitar la llamada repetida a `consultar_agenda`**.
   La traza la enseña invocándose dos veces en el mismo turno para la misma
   petición, y esa repetición arrastra una ida y vuelta más al modelo (4,1 s
   medidos). El bloque 6.1 del prompt ya pide consultar «UNA vez y ANCHO»; no
   se está cumpliendo.

7. **Sin medida del sobre-escalamiento.** La Tabla 14 solo mide el
   *sub*-escalamiento; derivar de más es invisible. Fue el hueco por el que se
   coló el fallo del clasificador de urgencia.

8. **La idempotencia de `crear_cita` no se ha probado en vivo**: la doble
   verificación previa (C7) aborta antes de llegar a la ruta del 409.

---

## Cosas aprendidas que ahorran horas

- **El objetivo de 1200 ms se fijó sin medir** y no se alcanza ni optimizando.
  Conviene revisarlo con datos antes de tratarlo como criterio de aceptación.
- **Un modelo más rápido cumple peor las reglas.** haiku-4.5 tuteó al paciente,
  se equivocó de fecha y llegó a negar una cita que sí existía. Lo primero y lo
  segundo se arreglaron con prompt; lo tercero no.
- **ElevenLabs añade `/chat/completions`** a la URL base del Custom LLM. Poner
  la ruta completa da 404 en cada turno.
- **El widget web no envía `elevenlabs_extra_body`.** Por eso la clínica viaja
  en nuestra URL: `/v1/g/:secret/c/:clinicId/...`.
- **`eleven_flash_v2_5` no soporta `expressive_mode`**: acepta el PATCH con 200
  y lo deja en `false`, sin avisar.
- **La aprobación de la base es nominal** (control O2) y no la firma un script.
  Al cambiar de modelo de embeddings hay que **re-embeber y volver a aprobar**:
  consulta y documentos tienen que venir del mismo modelo.
- **`npm run db:seed` solo inserta.** Reejecutarlo duplica; para reaprobar, un
  `update` directo.

