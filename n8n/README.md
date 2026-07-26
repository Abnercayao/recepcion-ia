# Flujos de orquestacion (n8n) — Fase 6

## Estado: NADA de esto se ha ejecutado nunca

No hay instancia de n8n en este entorno de construccion. Los 5 archivos `.json` de
esta carpeta se escribieron a mano (via un generador Node, ver
`docs/decisiones.md` de esta rama si se conserva el script), se validaron con
`JSON.parse` y se revisaron nodo por nodo contra los tipos y el esquema reales
del proyecto (`src/core/types/ports.ts`, `src/infra/notification.client.ts`,
`db/migrations/001_init.sql`). **Ninguno se ha importado a una instancia de n8n,
ninguno se ha ejecutado, ninguna conexion HTTP/Postgres/Slack/Twilio real se ha
probado.** Todo lo que sigue es una descripcion de la intencion de diseno, no
un reporte de ejecucion.

Verificacion realizada (la unica posible sin una instancia de n8n):

```
node -e "for (const f of require('fs').readdirSync('n8n')) if (f.endsWith('.json')) { JSON.parse(require('fs').readFileSync('n8n/'+f,'utf8')); console.log('ok', f) }"
```

Los 5 archivos parsean. Estructura de cada uno: `{ name, nodes: [...],
connections: {...}, settings: {...} }`; cada nodo trae `parameters`, `name`,
`type`, `typeVersion`, `position`, `id`. Ningun nodo lleva un valor de
credencial embebido: las credenciales se referencian solo por **nombre**
(`credentials.<tipo>.name`), nunca con tokens, API keys ni URLs de webhook
secretas dentro del JSON.

---

## Como importar cada flujo

En n8n: **Workflows → Import from File** (o *Import from URL/Clipboard* pegando
el contenido). Tras importar, n8n marca cada nodo que usa una credencial con un
icono de alerta hasta que se le asigna una credencial real con ese nombre. Hay
que:

1. Crear primero las credenciales de la tabla de abajo, **con el nombre EXACTO**
   indicado (n8n solo guarda el nombre en el JSON exportado, no un id que
   pueda resolverse solo).
2. Abrir cada nodo con alerta y seleccionar la credencial ya creada.
3. Revisar los parametros marcados como "editar antes de activar" (ver la
   seccion de cada flujo): nombres de canal de Slack, plantillas de WhatsApp,
   variables de entorno que n8n debe poder leer.
4. Activar el flujo solo despues de (3). Ninguno de estos flujos es seguro de
   activar "tal cual" sin revisar esas variables primero.

No hay una sexta credencial "administradora" que lo resuelva todo: cada
integracion (Postgres, Google Calendar, WhatsApp, Slack, Twilio, Anthropic) es
una credencial separada, deliberadamente, para que revocar una no afecte a las
demas.

---

## F3_recordatorios.json

**Disparador:** `scheduleTrigger`, cron `0 * * * *` (cada hora, en punto).

**Que hace:** por cada clinica con `config.googleCalendarId` (misma columna
que usa `src/infra/calendar.client.ts`), lista los eventos de Google Calendar
en las proximas 73 h y, para cada evento cuya hora de inicio caiga dentro de
±30 min de 72 h / 24 h / 3 h antes, envia una plantilla de WhatsApp de
recordatorio. Ademas, de forma independiente, revisa si el recordatorio de 24 h
(el intermedio) se envio hace mas de 6 h y el paciente no genero ninguna
actividad de conversacion despues de eso; si es asi, alerta a recepcion.

**Por que no hay tabla de citas involucrada — vacio de diseno heredado, no
introducido aqui.** El esquema de Postgres (`db/migrations/001_init.sql`) no
tiene tabla de citas: la agenda vive **solo** en Google Calendar, y
`CalendarPort` (`src/core/types/ports.ts`) no tiene ningun metodo para listar
eventos, solo `findAvailableSlots` (que usa `freebusy.query` y por diseno
**nunca** devuelve titulo, descripcion ni telefono — ver el comentario de
cabecera de `calendar.client.ts`, punto 2). El unico lugar donde el telefono
del paciente queda accesible es el campo `description` de texto libre que
`GoogleCalendarClient.createEvent` escribe al crear la cita (`"Paciente:
<telefono> | Profesional: <...>"`). Este flujo **parsea ese texto con una
expresion regular** para recuperar el telefono. Es fragil: si el formato de esa
descripcion cambia en `calendar.client.ts`, este flujo deja de encontrar
telefonos y silenciosamente no manda recordatorios. Se documenta como vacio
detectado, no como decision robusta — la solucion correcta seria una tabla de
citas propia o un endpoint de lectura en el nucleo, ninguna de las dos existe
hoy y ninguna esta en el alcance de esta rama (solo `n8n/*`).

**Idempotencia (como se resolvio, que era obligatorio segun el encargo):** no
existe tabla de "recordatorios enviados", asi que este flujo usa `audit_log`
como bitacora — la unica tabla generica de la especificacion que admite un
evento de texto libre mas detalle JSON sin tocar el esquema. Antes de enviar
cualquier recordatorio, el nodo **"Recordatorio ya enviado? (idempotencia)"**
ejecuta:

```sql
SELECT NOT EXISTS (
  SELECT 1 FROM audit_log
  WHERE clinic_id = '<clinica>'::uuid
    AND evento = 'recordatorio_enviado_<ventana>'
    AND detalle_enmascarado->>'calendarEventId' = '<id del evento de Google>'
) AS no_enviado_aun;
```

Nota deliberada de diseno: esta consulta usa `NOT EXISTS` sobre una
subconsulta (no un `FROM audit_log` directo) para que **siempre** devuelva
exactamente una fila, sin importar si ya se envio o no. Eso es lo que permite
que el nodo `IF` que sigue decida por **valor** (`no_enviado_aun = true/false`)
en vez de por **presencia o ausencia de filas** — un `FROM audit_log` normal
habria hecho desaparecer el item cuando YA se envio, y en n8n un item que
desaparece no dispara nada rio abajo (ni siquiera una rama "false"), lo cual
habria roto el cierre del bucle sobre `Split In Batches`.

Solo despues de enviar con exito, el nodo **"Registrar envio (idempotencia)"**
inserta la fila `evento = 'recordatorio_enviado_72h' | '_24h' | '_3h'` con
`clinic_id` y `detalle_enmascarado = { calendarEventId, ventana, fechaCitaIso,
telefonoEnmascarado }`. Un cron horario que se re-ejecuta, o que se solapa con
la ejecucion anterior por un `Split In Batches` lento, **no puede** volver a
mandar el mismo recordatorio: la clave de idempotencia es
`(clinic_id, evento, calendarEventId)`, y esa combinacion es estable
mientras el id del evento de Google no cambie (y ese id es deterministico
desde que se creo la cita — ver el punto 5 del comentario de cabecera de
`calendar.client.ts`).

**Riesgo aceptado, no resuelto del todo:** el par
"consultar-si-ya-se-envio" + "insertar-que-se-envio" son dos pasos separados,
no una unica operacion atomica (no hay una restriccion `UNIQUE` en
`audit_log` sobre `(clinic_id, evento, detalle_enmascarado->>'calendarEventId')`
que lo protegiera a nivel de base de datos, porque **anadir una restriccion
asi implicaria tocar `db/migrations/`, que no esta en el alcance de esta
rama** — solo `n8n/*`). En teoria, dos ejecuciones **concurrentes** del mismo
cron podrian intercalarse entre esos dos pasos y enviar el mismo recordatorio
dos veces. En la practica esto exige que dos ejecuciones horarias se solapen,
lo cual n8n normalmente no hace para un mismo cron (una ejecucion suele
terminar bastante antes de que arranque la siguiente, salvo un flujo colgado
una hora entera). Se documenta como deuda reconocida, igual que el resto de
huecos de este proyecto: no se inventa una garantia que la base de datos no
sostiene.

**Recordatorio intermedio sin respuesta → alerta a recepcion.** El nodo
**"24h enviado + grace period + actividad paciente"** hace una sola consulta
que:
1. Busca si existe un `recordatorio_enviado_24h` para este evento con **mas
   de 6 horas** de antiguedad (parametro `GRACE`, elegido por esta rama — la
   especificacion pide la alerta pero no fija un plazo).
2. Si existe, cruza contra `patients` + `conversations` (por
   `clinic_id + telefono_e164`) para ver la `ultima_actividad` de la
   conversacion mas reciente de ese paciente.
3. Calcula `sin_respuesta = (no hay conversacion) OR (ultima_actividad <=
   momento del envio del recordatorio de 24h)`.

Si `sin_respuesta = true`, y todavia no se habia alertado por este mismo
evento (mismo patron de idempotencia sobre `audit_log`, evento
`recordatorio_sin_respuesta_escalado`), el flujo llama al **mismo webhook**
que dispara `F4_notificar_escalamiento.json`, construyendo a mano un cuerpo con
la forma de `CargaDeEscalamiento` (la interfaz privada de
`src/infra/notification.client.ts`) con `motivo: 'peticion_humano'` y
`prioridad: 'normal'` (no es una urgencia medica, es un seguimiento operativo
estancado). **Esto exige que la URL de este nodo HTTP Request sea la MISMA que
la URL publica del webhook de `F4_notificar_escalamiento.json`** (el mismo
valor que el nucleo usa como `N8N_WEBHOOK_URL`) — si se despliegan en rutas
distintas, esta alerta se pierde en silencio. Se lee de
`{{ $env.N8N_WEBHOOK_URL }}` para no duplicar el valor a mano.

**Se sigue enviando el recordatorio de 3 h aunque se haya alertado a
recepcion por falta de respuesta.** Decision deliberada: la alerta a recepcion
es **adicional**, no un reemplazo del ultimo intento automatico — apagar el
canal automatico hacia el paciente justo cuando mas cerca esta la cita
contradice el principio de "nunca silencio" (control O5) que gobierna todo el
sistema.

**Contradiccion heredada que este flujo expone, no que cree:** el boton
"Reprogramar" del recordatorio, si el paciente lo toca, entra como un mensaje
normal de WhatsApp al flujo `F1_whatsapp_inbound` (fuera del alcance de esta
rama) y de ahi al nucleo. Pero **el nucleo no tiene ninguna herramienta
`reprogramar_cita`** (`docs/decisiones.md`, vacio D11: "no existe
`cancelar_cita` ni `reprogramar_cita`... el anti-patron 10 fija cinco
herramientas, ninguna de reprogramacion"). Hoy ese boton lleva a una
conversacion donde el agente no tiene forma tecnica de ejecutar lo que el
boton promete. No es un error de este flujo: es el mismo vacio D11 ya
reconocido, que F3 simplemente hereda al ofrecer el boton que la
especificacion (seccion 11) pide explicitamente.

**Nodos clave:** `Cada hora` (scheduleTrigger) → `Clinicas con calendario
configurado` (postgres) → `Por clinica` (splitInBatches, loop por clinica) →
`Eventos proximos (72h)` (googleCalendar, `getAll`) → `Calcular ventana y
extraer telefono` (code) → dos caminos en paralelo (envio del recordatorio /
deteccion de falta de respuesta) → `Fin de este evento` (noOp) → vuelve a
`Por clinica`.

**Credenciales que requiere:** `Postgres - Recepcion IA`, `Google Calendar -
Recepcion IA (cuenta de servicio)`, `WhatsApp Cloud API - Recepcion IA`.

**Antes de activar, hay que:**
- Crear en Meta Business Manager las 3 plantillas aprobadas
  `recordatorio_cita_72h`, `recordatorio_cita_24h`, `recordatorio_cita_3h`, cada
  una con botones de respuesta rapida (`QUICK_REPLY`) "Confirmar" y
  "Reprogramar". **Sin esto, el nodo de envio falla siempre**: WhatsApp exige
  plantilla aprobada para mensajes que el negocio inicia fuera de una ventana
  de 24 h de conversacion activa (ver tambien
  `Informe_Etico_Regulatorio_Recepcion_IA.docx`, la politica de WhatsApp
  Business citada ahi mismo).
- Verificar que la cuenta de servicio de Google Calendar usada aqui tenga
  acceso de lectura al mismo calendario que usa `GOOGLE_CALENDAR_CREDENTIALS`
  en el nucleo (puede ser la misma cuenta de servicio, o una de solo lectura
  compartida sobre el mismo calendario).

---

## F4_notificar_escalamiento.json

**Disparador:** `webhook` (POST), path `/escalamiento`. Lo llama
`NotificationClient.notifyEscalation` (`src/infra/notification.client.ts`)
cuando el nucleo necesita escalar un caso a un humano y la transferencia
telefonica no aplica o falla. El cuerpo que llega es **exactamente**
`CargaDeEscalamiento` (interfaz privada de ese archivo, lineas 46-57):

```ts
{
  conversationId: string;
  clinicId: string;
  clinicaNombre: string;
  motivo: 'urgencia' | 'peticion_humano' | 'reclamo' | 'fallo_comprension';
  prioridad: 'urgente' | 'normal';
  resumenParaRecepcion: string;
  telefonoPaciente: string;
  pacienteNombre?: string;
  canal: string;
  ocurridoEn: string; // ISO 8601
}
```

Importante: `NotificationClient` **no enmascara** `telefonoPaciente` en el
cuerpo que envia (solo enmascara lo que el propio nucleo escribe en SUS logs,
via `maskPII`). El webhook llega con el telefono real: este flujo si debe
enmascararlo **antes de persistirlo** en `audit_log` (lo hace en los nodos
`Registrar notificacion urgente/normal`), pero puede usarlo sin enmascarar
mientras lo tiene solo en memoria de ejecucion (para el SMS/Slack), igual que
el propio nucleo usa `ctx.patient.telefonoE164` en claro durante el turno y
solo lo enmascara al loguear.

**Distincion urgente vs. normal — caminos realmente distintos, no una
etiqueta:**

- **`prioridad = 'urgente'`:** SMS inmediato a recepcion via Twilio (nodo
  `SMS urgente a recepcion`, usando el primer numero de
  `clinics.transfer_whitelist`) **+** mensaje en el canal de Slack
  `urgencias-recepcion` con formato de alarma. Es la unica combinacion de los
  5 flujos que dispara un canal fuera de Slack (SMS), a proposito: una
  urgencia no puede depender de que alguien tenga Slack abierto en ese
  momento.
- **`prioridad = 'normal'`:** solo un mensaje en el canal de Slack
  `recepcion-general` (canal **distinto** al de arriba), sin SMS y sin
  mencion `@here`. Se trata como cola de trabajo ordinaria.

Ambos caminos terminan registrando el evento en `audit_log`
(`evento = 'escalamiento_notificado'`, con `prioridad` real dentro de
`detalle_enmascarado`) antes de converger en un unico
`Responder 200 al nucleo` (`respondToWebhook`). Se responde **al final**, no
al recibir el webhook: si Slack o Twilio fallan, el nodo correspondiente
lanza error, n8n no llega al `respondToWebhook`, y n8n devuelve un error al
llamador. Esto es intencional: `NotificationClient.notifyEscalation` reintenta
con `p-retry` sobre 5xx/errores de red y solo aborta sin reintentar ante 4xx
(ver el archivo fuente) — que F4 solo confirme 200 cuando la notificacion
**realmente** salio hacia recepcion es lo que hace que ese reintento tenga
sentido. Si F4 respondiera 200 de inmediato y luego fallara en silencio al
notificar a Slack, se reproduciria exactamente el "escalamiento al vacio" que
`notification.client.ts` dice, en su propio comentario de cabecera, que es el
peor resultado posible del sistema.

**Nodos clave:** `Webhook escalamiento` → `Buscar clinica y whitelist`
(postgres, trae `transfer_whitelist` para el SMS) → `Es urgente?` (if) →
[urgente: Twilio → Slack → Postgres] / [normal: Slack → Postgres] → converge
en `Responder 200 al nucleo`.

**Credenciales que requiere:** `Postgres - Recepcion IA`, `Twilio - Recepcion
IA`, `Slack - Recepcion IA`.

**Antes de activar, hay que:**
- Crear los canales de Slack `urgencias-recepcion` y `recepcion-general` (o
  cambiar esos nombres en los nodos por los reales de la clinica).
- Que el entorno donde corre n8n exponga `TWILIO_PHONE_NUMBER` como variable
  accesible via `$env` en expresiones (mismo nombre que ya usa
  `src/infra/config.ts`, para no duplicar el valor en dos sitios). Esto
  depende de que la instancia de n8n no tenga bloqueado el acceso a variables
  de entorno desde expresiones (`N8N_BLOCK_ENV_ACCESS_IN_NODE`); no se
  verifico contra ninguna instancia real.

---

## F6_reporte_mensual.json

**Disparador:** `scheduleTrigger`, cron `0 6 1 * *` (dia 1 de cada mes, 6:00).

**Que hace:** agrega metricas del mes calendario **anterior** directamente
sobre Postgres (conversaciones totales y por canal, escaladas y por motivo,
llamadas a herramientas por tipo, citas creadas con exito, latencia promedio
de respuesta del asistente, llamadas de voz y su duracion promedio), se las
pasa a Claude para que redacte una narrativa en espanol, y ensambla un objeto
de reporte final (`estado: 'listo_para_envio'`) que registra en `audit_log`.

**Contradiccion con la especificacion, dejada explicita (no resuelta en
silencio):** la seccion 11 de la especificacion describe este flujo como
*"Agrega metricas → narrativa con Claude → **PDF** → **envio**"*. Este flujo
se detiene en "narrativa lista", sin generar PDF ni enviarlo, por dos motivos
concretos:
1. Ninguno de los nodos estandar autorizados para esta rama
   (`scheduleTrigger`, `webhook`, `postgres`, `httpRequest`, `if`, `code`)
   genera PDF. Anadir uno implicaria un nodo o un servicio externo que no
   estaba en la lista del encargo.
2. Ni `src/infra/config.ts` ni la especificacion definen un canal de envio
   (correo, WhatsApp del equipo, Drive) ni una credencial para el reporte
   mensual.

Se prefirio dejar el hueco visible (el reporte queda en `estado:
'listo_para_envio'`, sin PDF ni destinatario) en vez de inventar un canal de
entrega que nadie especifico. Es una decision de esta rama, reportada aqui
como corresponde.

**Limitacion deliberada:** la consulta de metricas agrega **todas** las
clinicas juntas, sin filtrar por `clinic_id`. Es coherente con que el resto
del sistema hoy solo sostiene una clinica en produccion de verdad
(`WHATSAPP_PHONE_ID` y `CLINIC_ID` son variables singulares en
`src/server.ts`, no por-clinica) — ver tambien `docs/decisiones.md`, vacio 5.
Separar por clinica es una repeticion mecanica de la misma consulta si
alguna vez hace falta, no un cambio de arquitectura.

**Nodos clave:** `Dia 1 del mes` → `Metricas del mes anterior` (postgres,
agregacion con CTE `periodo`) → `Formatear metricas para el prompt` (code) →
`Generar narrativa con Claude` (httpRequest a la API de Anthropic, modelo
`claude-sonnet-5` — el de conversacion/generacion, no el de clasificacion,
segun `docs/decisiones.md` D1) → `Ensamblar reporte final` (code) →
`Registrar generacion de reporte` (postgres).

**Credenciales que requiere:** `Postgres - Recepcion IA`, `Anthropic API -
Recepcion IA`.

---

## QA_nocturno.json

**Disparador:** `scheduleTrigger`, cron `0 3 * * *` (cada noche, 3:00).

**Que hace, en dos partes:**

**1. Evaluacion del 100 % de las conversaciones del dia.** Trae todas las
conversaciones iniciadas en las ultimas 24 h con su transcripcion completa
(`json_agg` sobre `messages`), y por cada una (`Split In Batches`, una a la
vez) le pide a Claude que aplique una rubrica de 5 puntos — correccion, tono,
cumplimiento de las reglas duras (nunca diagnostica, nunca interpreta
sintomas, nunca recomienda tratamiento, nunca cierra precio que requiere
valoracion, nunca afirma ser humano), oportunidad de agendar aprovechada,
señales de urgencia bien escaladas — tomada literalmente de la seccion D
("Modelo de auditoria interna para la mitigacion de sesgos") del informe
etico-regulatorio. Usa el modelo de **clasificacion**
(`CLAUDE_MODEL_CLASIFICACION` = `claude-haiku-4-5-20251001` segun
`docs/decisiones.md` D1), no el de conversacion: evaluar con una rubrica
cerrada es clasificacion, no generacion de alto riesgo. Cada veredicto
(`aprobada` | `defectuosa`, con puntaje y hallazgos) se registra en
`audit_log` (`evento = 'qa_evaluacion_automatica'`).

Si Claude no devuelve JSON valido, el flujo **no** interpreta eso como
"aprobada por omision": el nodo `Parsear veredicto de Claude` cae a un
veredicto por defecto `defectuosa` con el hallazgo "no se pudo parsear la
respuesta del evaluador automatico". Fallar en silencio hacia "aprobada"
produciria exactamente la "metrica tranquilizadora" que la fase A4 del
informe etico ("Calibracion del propio evaluador") advierte que es peor que
no tener metrica.

**2. Muestreo aleatorio de conversaciones APROBADAS — el punto clave del
encargo, hecho explicito aqui y no solo en este README.** Terminada la
evaluacion del dia, el nodo `Recuperar aprobadas de hoy` trae **solo** las
que el paso anterior marco `aprobada`. El nodo `Muestreo aleatorio de
aprobadas (10%)` elige al azar (Fisher-Yates real, `Math.random`, no una
seleccion "representativa" por estratos) un 10 % de ellas (minimo 1 si hay
alguna), y el nodo `Registrar muestreo aleatorio` deja constancia en
`audit_log` (`evento = 'qa_muestreo_aleatorio_aprobadas'`) de **cuantas** se
muestrearon y **cuales** — precisamente para que exista un rastro
verificable de que el muestreo se ejecuto esa noche, no solo de que el flujo
"dice" hacerlo.

La cita textual que motiva este paso, del informe etico-regulatorio
(seccion 3.1.5, apartado E — "Bucle de retroalimentacion"; ver tambien la
version equivalente en la seccion A.5 del informe etico-regulatorio):

> "El control que preserva la validez del bucle es el muestreo aleatorio de
> conversaciones aprobadas y no solo de las marcadas como defectuosas. Sin
> el, un evaluador automatico converge hacia validar sus propios errores
> sistematicos."

El reporte final (`Ensamblar reporte nocturno`) incluye la muestra completa
(con transcripciones) bajo un titulo explicito: **"revision humana
obligatoria"**. Es deliberado que no sea una segunda pasada del mismo
evaluador automatico sobre si mismo — eso no rompe nada, es el mismo modelo
con los mismos puntos ciegos. Lo que rompe la circularidad es que una
persona, no el modelo, revise esa muestra. Este flujo prepara y deja lista
esa muestra; no puede forzar a que alguien la lea.

**Parametro que esta rama tuvo que fijar (la especificacion no lo hace):** la
tasa de muestreo, 10 % con minimo 1. Es un valor editable en un solo lugar
(`TASA_MUESTREO` dentro del nodo `Muestreo aleatorio de aprobadas (10%)`).

**Vacio de esquema, igual que en F3:** no existe una tabla
`qa_evaluaciones` en `db/migrations/`; se reusa `audit_log` como bitacora,
por el mismo motivo que en F3 (anadir tablas esta fuera del alcance de esta
rama, que es solo `n8n/*`). Documentado, no oculto.

**Nodos clave:** `Cada noche (3am)` → `Conversaciones del dia con
transcripcion` (postgres) → `Por conversacion` (splitInBatches) → `Evaluar
con Claude (rubrica)` → `Parsear veredicto de Claude` (code, con una
reimplementacion minima y manual del enmascarador de PII para los
`hallazgos`, ver mas abajo) → `Registrar evaluacion` → vuelve al loop; al
terminar → `Recuperar aprobadas de hoy` → `Muestreo aleatorio de aprobadas
(10%)` → `Registrar muestreo aleatorio` → `Agregar metricas del dia` →
`Ensamblar reporte nocturno` → `Registrar generacion de reporte QA`.

**Credenciales que requiere:** `Postgres - Recepcion IA`, `Anthropic API -
Recepcion IA`.

---

## heartbeat.json

**Disparador:** `scheduleTrigger`, cron `*/5 * * * *` (cada 5 minutos).

**Que hace:** `GET` a `{{ $env.NUCLEO_BASE_URL }}/health` y compara contra la
forma real de la respuesta de `src/server.ts` (linea 141):
`{ estado: 'ok', canales: { whatsapp, voz } }`. Si la peticion falla a nivel
de red (`continueOnFail: true` en el nodo HTTP, para no cortar el flujo) o si
`estado !== 'ok'`, alerta en el canal de Slack `urgencias-recepcion` y
registra el fallo en `audit_log` (`evento = 'heartbeat_fallo'`), uno por cada
ciclo de 5 minutos en el que el nucleo siga caido (asi se puede medir cuanto
duro la caida, no solo que empezo).

`/health` no exige ningun secreto de gateway (se registra sin autenticacion
en `src/server.ts`), asi que este nodo HTTP no necesita credencial.

**`NUCLEO_BASE_URL` es una variable NUEVA, exclusiva de este flujo — vacio
detectado.** `src/infra/config.ts` no tiene ninguna variable con la URL
publica del nucleo, porque el nucleo nunca necesita conocer su propia
direccion (solo recibe peticiones, nunca las hace hacia si mismo).
`heartbeat.json` corre **fuera** del proceso del nucleo y si necesita saberla.
Hay que definirla en el entorno de n8n (no en el del nucleo).

**Nodos clave:** `Cada 5 minutos` → `GET /health del nucleo` → `Nucleo
responde "ok"?` (if) → [ok: `Nucleo saludable (sin accion)`, no-op] / [fallo:
`Alertar canal urgencias (Slack)` → `Registrar fallo de heartbeat`].

**Credenciales que requiere:** `Postgres - Recepcion IA`, `Slack - Recepcion
IA`.

---

## F5_reactivacion — NO se construyo

La tabla de la seccion 11 de la especificacion lo marca **desactivado por
defecto**, y el informe etico-regulatorio es todavia mas explicito (paragrafo
sobre la Ley N.° 29571 y control C14, y de nuevo en la seccion de controles):

> "Las campañas de reactivacion se ejecutan solo sobre bases con
> consentimiento acreditado por la clinica, con plantillas aprobadas y
> exclusion previa de numeros registrados en «Gracias, No Insista». **Las
> llamadas salientes automatizadas quedan suspendidas hasta contar con
> confirmacion legal expresa de su licitud.**" (control C14)

Construir este flujo de todos modos — aunque quedara "desactivado" dentro de
n8n — habria significado dejar documentado, con detalle tecnico suficiente
para ejecutarlo, un mecanismo que la propia especificacion y el informe
etico-regulatorio dicen que **no debe operar** sin dos cosas que no existen
en este proyecto: (1) asesoria legal expresa sobre la Ley de Proteccion y
Defensa del Consumidor peruana aplicada a mensajeria masiva automatizada, y
(2) un cruce verificado contra el registro «Gracias, No Insista» de Indecopi,
que no tiene ninguna integracion en este sistema (no hay cliente para su
API/consulta en `src/infra/`, no esta en el alcance de ninguna rama de esta
construccion). Construirlo "por si acaso" habria sido decidir, por cuenta de
esta rama, que esas dos condiciones no importan — exactamente lo que el
contrato de construccion prohibe (no inventar capacidades que la
especificacion no autorizo). No es un flujo pendiente por descuido: es un
flujo bloqueado por diseno.

---

## Credenciales a crear en n8n (nombre exacto)

| Nombre de la credencial | Tipo (aprox., no verificado contra n8n real) | Usada en |
|---|---|---|
| `Postgres - Recepcion IA` | Postgres | F3, F4, F6, QA_nocturno, heartbeat |
| `Google Calendar - Recepcion IA (cuenta de servicio)` | Google Calendar OAuth2 / cuenta de servicio | F3 |
| `WhatsApp Cloud API - Recepcion IA` | HTTP Header Auth (`Authorization: Bearer <WHATSAPP_BSP_TOKEN>`) | F3 |
| `Twilio - Recepcion IA` | Twilio API (Account SID + Auth Token) | F4 |
| `Slack - Recepcion IA` | Slack API (token de bot con permiso `chat:write`) | F4, heartbeat |
| `Anthropic API - Recepcion IA` | HTTP Header Auth (`x-api-key: <ANTHROPIC_API_KEY>`) | F6, QA_nocturno |

El nombre es literal: si se crea con otro nombre, hay que editar el `name`
dentro de `credentials` en el nodo correspondiente (o remapearlo desde la UI
de n8n al importar).

## Variables de entorno relacionadas

**Ya existen en `src/infra/config.ts` (se reusa el mismo nombre a proposito,
para no tener el mismo valor duplicado bajo dos nombres distintos):**

| Variable | Donde se usa en n8n |
|---|---|
| `WHATSAPP_PHONE_ID` | F3, para construir la URL de envio de la plantilla |
| `TWILIO_PHONE_NUMBER` | F4, como remitente del SMS urgente |
| `N8N_WEBHOOK_URL` | F3 (para reusar el webhook de F4 al alertar por falta de respuesta) |

**Nuevas, exclusivas de n8n — no existen en `config.ts` porque el nucleo
nunca las necesito para si mismo:**

| Variable | Por que hace falta | Usada en |
|---|---|---|
| `NUCLEO_BASE_URL` | El nucleo solo recibe peticiones, nunca llama a su propia URL publica; heartbeat corre fuera del proceso y si necesita saberla | heartbeat |

Todas las referencias `{{ $env.VARIABLE }}` asumen que la instancia de n8n
tiene habilitado el acceso a variables de entorno desde expresiones. No se
verifico contra ninguna instancia real (ver limitaciones).

---

## Supuestos no verificados / limitaciones conocidas

Todo lo siguiente son decisiones tomadas sin poder contrastarlas contra una
instancia de n8n real. Se documentan para que quien importe estos flujos sepa
exactamente donde revisar primero si algo no calza:

1. **Orden de las salidas de `Split In Batches`.** Se asumio salida 0 =
   "loop" (lote actual), salida 1 = "done" (termino). Si al importar aparece
   invertido, basta con cruzar las dos conexiones que salen del nodo `Por
   clinica` (F3) o `Por conversacion` (QA_nocturno).
2. **Forma exacta de las condiciones del nodo `IF`.** Se uso
   `operator: { type: 'boolean', operation: 'true' }` para "es verdadero". Es
   una aproximacion razonable a la version 2.x del nodo, no confirmada
   campo por campo contra una instalacion real.
3. **Nombre interno del tipo de credencial de Google Calendar** (`credentials.
   googleCalendarOAuth2Api`). n8n distingue credenciales de OAuth2 y de cuenta
   de servicio con nombres internos distintos segun la version; quien
   importe puede necesitar reasignar el tipo de credencial del nodo antes de
   poder seleccionar la credencial creada.
4. **Interpolacion de SQL con `{{ }}` en vez de parametros nativos del nodo
   Postgres.** Las consultas de estos 5 flujos construyen el SQL con
   expresiones de n8n embebidas directamente en el texto (`'{{ $json.x }}'`),
   no con el mecanismo de "Query Parameters" nativo del nodo Postgres (cuyo
   nombre de campo exacto en la version instalada no se pudo verificar sin
   una instancia real). Es legible pero **no es la practica recomendada para
   produccion**: alguien que reemplace estas consultas antes de ejecutarlas de
   verdad deberia migrarlas a parametros nativos para eliminar el riesgo de
   inyeccion SQL, que aqui solo se mitiga parcialmente escapando comillas
   simples a mano (`.replace(/'/g, "''")`) en los valores que se insertan como
   JSON.
5. **Reimplementacion manual del enmascarador de PII dentro de n8n.** n8n no
   puede importar `src/infra/pii-masker.ts` (corre en un sandbox aislado sin
   acceso al codigo del proyecto). Los nodos `Code` que necesitan enmascarar
   antes de persistir (F3, F4, QA_nocturno) traen una copia reducida a mano de
   los mismos patrones (DNI de 8 digitos, telefono E.164 peruano, telefono
   local, correo). Es una duplicacion de logica sin una fuente unica de
   verdad: si las reglas de enmascarado cambian en `pii-masker.ts`, estas
   copias **no** se actualizan solas.
6. **`typeVersion` de cada nodo.** Se eligieron valores plausibles para
   versiones recientes de n8n (`postgres` 2.5, `httpRequest` 4.2, `if` 2.2,
   `code` 2, etc.), sin poder confirmarlos contra una version instalada
   especifica. Si n8n rechaza un nodo por `typeVersion` desconocida al
   importar, basta con bajar ese numero al que soporte la instalacion; los
   `parameters` de cada nodo se escribieron con nombres de campo estables
   entre versiones recientes, no deberian requerir mas cambios.

---

## Resumen de vacios y contradicciones detectados en esta rama

- **No existe tabla de citas en Postgres.** F3 depende de parsear el
  telefono del paciente desde el texto libre de la descripcion de cada evento
  de Google Calendar. Fragil, documentado arriba.
- **No existe tabla de evaluaciones de QA.** F3 y QA_nocturno reusan
  `audit_log` como bitacora de idempotencia y de resultados, en vez de una
  tabla dedicada — decision forzada por el alcance de esta rama (solo
  `n8n/*`, sin migraciones nuevas).
- **F6 no genera PDF ni envia nada**, pese a que la seccion 11 de la
  especificacion dice "narrativa → PDF → envio". Se detiene en "narrativa
  lista", documentado como contradiccion, no resuelto inventando un canal de
  envio que nadie definio.
- **El boton "Reprogramar" de F3 no tiene, hoy, una herramienta real detras**
  (vacio D11 de `docs/decisiones.md`, heredado de fases anteriores, no
  introducido por esta rama).
- **F5_reactivacion no se construyo**, por bloqueo legal explicito (control
  C14 e informe etico-regulatorio), no por descuido.
- Ninguno de estos 5 flujos se ha importado, ejecutado, ni probado contra
  Postgres, Google Calendar, WhatsApp, Slack, Twilio o Anthropic reales. Todo
  lo anterior es diseno documentado, no comportamiento verificado.
