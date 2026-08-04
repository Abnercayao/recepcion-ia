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

---

## LA TAREA SIGUIENTE (lo que el usuario pidió)

**Instrumentar la web para ver, con detalle, qué pasa en cada turno**: idas y
vueltas, latencia por tramo, herramientas invocadas, aciertos y fallos del RAG.
Hoy el chat solo muestra un total en milisegundos tras pulsar «Detalle técnico».

Lo que hace falta ver para diagnosticar, y hoy no se ve:

- **Reparto del tiempo dentro del turno**: embedding, consulta vectorial,
  cada llamada al modelo, cada herramienta, y el tiempo que se va en red.
- **Cuántas veces llama el modelo a cada herramienta** en un mismo turno. Es
  la causa principal de la latencia: cada llamada obliga a una ida y vuelta más.
- **Qué recuperó el RAG y con qué similitud**, o si cayó al respaldo léxico, o
  si se omitió por ser cortesía.
- **Si actuó la capa 2**, con qué violación y qué texto sustituyó.
- **En modo alojado**: qué webhook llamó el proveedor, con qué argumentos y
  cuánto tardó la ida y vuelta completa.

Buena parte del dato ya se persiste (`tool_calls.latencia_ms`,
`latency_metrics`, `audio_events`) o se registra en el log; falta exponerlo y
pintarlo. `scripts/web.ts` ya devuelve `herramientas` y `latenciaMs` por turno:
es el sitio natural para ampliar.

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

Y el túnel, imprescindible para que ElevenLabs alcance la máquina:

```bash
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000 --no-autoupdate
```

⚠ **El túnel cambia de dominio cada vez que se reinicia.** Cuando pase hay que
actualizar en el panel de ElevenLabs: el Custom LLM, el webhook de iniciación y
el post-llamada; y volver a ejecutar `npm run agente:alojado -- --tunel <nuevo>`
si se está en modo alojado.

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

1. **El modelo inventa cuando el RAG no recupera.** Ante «vivo por Magdalena»
   llegó a decir «trabajamos con sede única»; la clínica tiene 24. Reproducible.
   La línea roja «nunca inventar datos ausentes de la base» **no tiene control
   automático en capa 2**.
   **Arreglo propuesto y no hecho**: meter las 24 sedes en el bloque de sesión
   del prompt, no en el RAG. Ya están en `clinic.config`; no deberían depender
   de una búsqueda semántica que puede fallar.

2. **Latencia.** En modo Custom LLM, 12–14 s en turnos con herramientas, contra
   un objetivo declarado de 1200 ms y un corte del proveedor de 15 s. Sin
   margen. El cuello son las idas y vueltas al modelo, no las herramientas
   (600–1445 ms cada una).

3. **Sin medida del sobre-escalamiento.** La Tabla 14 solo mide el
   *sub*-escalamiento; derivar de más es invisible. Fue el hueco por el que se
   coló el fallo del clasificador de urgencia.

4. **La idempotencia de `crear_cita` no se ha probado en vivo**: la doble
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
