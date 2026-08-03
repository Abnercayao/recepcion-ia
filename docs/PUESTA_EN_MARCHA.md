# Puesta en marcha — de cero a demo funcional

Guía ordenada de todo lo que hay que contratar y conectar. Cada etapa deja algo **funcionando y verificable**, así que puedes parar en cualquiera y tener un demo real hasta ahí.

## Antes de empezar: cómo se manejan las claves

**Las claves van únicamente en el archivo `.env` de la raíz del proyecto, escritas por ti.**

- No pegues ninguna clave en un chat, ni en un issue, ni en un commit. Una clave que se pega en algún sitio hay que considerarla comprometida y rotarla.
- `.env` ya está en `.gitignore`. Verifícalo con `git check-ignore .env` antes del primer push.
- Si una clave se te escapa a un commit, no basta con borrarla en el siguiente: queda en el historial. Hay que rotarla en el proveedor.

**No hay `.env.example` en el repositorio, y es deliberado.** Existió, y acabó commiteado con claves reales dentro: exactamente el fallo que este apartado advierte. Crea el `.env` a mano. Las variables van apareciendo en las etapas de abajo, y la lista completa con sus reglas de obligatoriedad está en el esquema de `src/infra/config.ts`.

El sistema valida el entorno al arrancar y **falla si falta algo obligatorio**, diciéndote exactamente qué. Eso es deliberado.

---

## Etapa 1 · Núcleo conversacional

**Contratar:** [console.anthropic.com](https://console.anthropic.com) → *Settings* → *API keys*. Es de pago por uso; hay que cargar saldo.

**En `.env`:**

```
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL_CONVERSACION=claude-sonnet-5
CLAUDE_MODEL_CLASIFICACION=claude-haiku-4-5-20251001
```

**Verifica:**

```bash
npm run demo
```

Conversas con el agente en la terminal. Con `-- --voz` usa el bloque de estilo de voz. Pruébalo con: una consulta de precios (debe dar rango, nunca cifra cerrada), una petición de diagnóstico (debe derivar), y «me sangra mucho la encía y no para» (debe interrumpir el flujo comercial y escalar).

En esta etapa la persistencia es en memoria y la recuperación es por coincidencia de palabras, no vectorial. El prompt, los tres controles y las cinco herramientas sí son los reales.

---

## Etapa 2 · Persistencia y RAG vectorial

**Contratar:**

1. **Supabase** — [supabase.com](https://supabase.com) → nuevo proyecto. Capa gratuita suficiente. Anota la contraseña de base de datos que defines al crearlo: no se puede volver a ver.
2. **Voyage AI** — [dash.voyageai.com](https://dash.voyageai.com) → API key. Capa gratuita amplia. Es el proveedor de embeddings; Anthropic no ofrece ese servicio, por eso hace falta un segundo proveedor.

**Dónde sacar cada dato de Supabase:**

| Dato | Dónde está |
|---|---|
| `SUPABASE_URL` | *Project Settings* → *Data API* → Project URL |
| `SUPABASE_SERVICE_KEY` | *Project Settings* → *API keys* → clave `service_role` |
| `SUPABASE_DB_URL` | *Project Settings* → *Database* → Connection string (URI) |

⚠ La clave `service_role` **salta Row Level Security**. Es de servidor: nunca la pongas en un cliente ni en el navegador.

**En `.env`:**

```
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_KEY=...
SUPABASE_DB_URL=postgresql://postgres:TU_PASSWORD@db.xxxxx.supabase.co:5432/postgres
VOYAGE_API_KEY=pa-...
```

**Aplica el esquema y carga la clínica de demostración:**

```bash
npm run db:migrate
```

```bash
npm run db:seed -- --aprobar-como "Nombre del profesional responsable"
```

Sin `--aprobar-como` los fragmentos entran **inactivos** y no se recuperan: la aprobación del contenido clínico es un acto humano nominal, no un paso automático.

---

## Etapa 3 · Agenda real

**Contratar:** [console.cloud.google.com](https://console.cloud.google.com) — gratuito.

1. Crea un proyecto y habilita **Google Calendar API**.
2. *IAM* → *Cuentas de servicio* → crear → generar clave **JSON**.
3. Abre Google Calendar, crea un calendario para la clínica, y en *Compartir con determinadas personas* añade el **email de la cuenta de servicio** con permiso «Hacer cambios en los eventos».
4. Copia el **ID del calendario** (*Configuración del calendario* → *Integrar calendario*).

**En `.env`** — el JSON completo en una sola línea, o en base64:

```
GOOGLE_CALENDAR_CREDENTIALS={"type":"service_account",...}
```

**Y el ID del calendario** va en la configuración de la clínica, no en `.env`: en `db/seed/clinica-demo/clinica.json`, campo `config.googleCalendarId`. Vuelve a ejecutar la semilla tras cambiarlo.

> **Limitación conocida:** el sistema agenda contra **un solo calendario por clínica**. `CalendarPort` no lleva sede ni profesional. La clínica de demostración tiene dos sedes y especialistas que no atienden en ambas: eso hoy no está soportado. Ver `decisiones.md`, vacío 2.

---

## Etapa 4 · Canal de voz

Es la etapa más cara y la que más piezas tiene. Guía detallada en [`fase5-elevenlabs.md`](fase5-elevenlabs.md).

**Contratar:**

1. **ElevenLabs** — [elevenlabs.io](https://elevenlabs.io), plan de pago con acceso a Agents.
2. **Twilio** o un proveedor SIP — número telefónico. De pago, y en Perú puede exigir documentación para números locales.
3. **Un túnel** para exponer tu servidor local: `cloudflared tunnel --url http://localhost:3000` o ngrok. En producción, un dominio propio con HTTPS.

**El secreto del gateway lo inventas tú.** Genera uno largo y aleatorio:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**En `.env`:**

```
VOICE_ENABLED=true
ELEVENLABS_API_KEY=...
ELEVENLABS_AGENT_ID=...
ELEVENLABS_VOICE_ID=...
ELEVENLABS_WEBHOOK_SECRET=...
VOICE_GATEWAY_SECRET=<el que acabas de generar>
VOICE_GATEWAY_URL=https://tu-tunel.trycloudflare.com
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+51...
TRANSFER_WHITELIST=+51999000001,+51999000002
```

⚠ **`TRANSFER_WHITELIST` debe llevar números reales de personas que vayan a contestar.** Es la lista a la que se transfiere una urgencia. Si está vacía, el sistema no arranca con la voz activada — a propósito.

**En el panel de ElevenLabs**, lo esencial (el detalle está en `fase5-elevenlabs.md`):

- LLM: **Custom LLM**, apuntando a `https://tu-tunel/v1/g/<VOICE_GATEWAY_SECRET>/chat/completions`. Ese segmento en la ruta es la única vía de autenticación que funciona con certeza: el proveedor **no documenta** qué cabecera envía.
- **System prompt del agente: vacío o mínimo.** Las reglas viven en nuestro prompt maestro; duplicarlas crea dos fuentes de verdad.
- **First message:** el guion de revelación. Es obligación contractual y criterio bloqueante.
- Habilita los 4 system tools y configura la lista blanca de transferencia también del lado de ElevenLabs.
- **Retención de audio: desactivada.**

---

## Etapa 5 · WhatsApp

**Empieza pronto:** la verificación de empresa en Meta suele tardar días y es el cuello de botella de todo el proyecto.

**Contratar:** [developers.facebook.com](https://developers.facebook.com) → app de tipo *Business* → producto *WhatsApp*. Requiere Meta Business verificada y un número que no esté ya en WhatsApp.

| Variable | Dónde está |
|---|---|
| `WHATSAPP_PHONE_ID` | WhatsApp → *API Setup* → Phone number ID |
| `WHATSAPP_BSP_TOKEN` | Token permanente vía *System User* (el token temporal caduca en 24 h) |
| `WHATSAPP_APP_SECRET` | *App Settings* → *Basic* → App Secret |
| `WHATSAPP_WEBHOOK_SECRET` | Lo inventas tú; es el `verify_token` del challenge |

Son **dos credenciales distintas**: el App Secret firma el HMAC de los mensajes, el verify token solo responde al challenge inicial. Confundirlas deja el webhook aceptando peticiones no firmadas por Meta.

```
WHATSAPP_ENABLED=true
CLINIC_ID=00000000-0000-4000-8000-000000000001
CLINIC_NAME=Clinica Dental Aurora
```

Configura el webhook en Meta apuntando a `https://tu-dominio/webhooks/whatsapp` y suscríbete al campo `messages`.

---

## Etapa 6 · Orquestación

**Contratar:** n8n autoalojado (Docker) o n8n Cloud. Ver [`n8n/README.md`](../n8n/README.md).

```
N8N_WEBHOOK_URL=https://tu-n8n/webhook/escalamiento
```

⚠ Si esta variable falta, un escalamiento que no pueda transferirse por teléfono **no llega a nadie**. El sistema lo registra en nivel `fatal` y lanza error, a propósito: un escalamiento silencioso es el peor fallo posible.

---

## Etapa 7 · Antes de exponer la voz a pacientes reales

**Bloqueante.** Ver [`fase7-equidad.md`](fase7-equidad.md).

El reconocimiento del habla no funciona igual con todas las variedades del español. Desplegar sin medirlo expone a los pacientes a un sesgo de magnitud desconocida, y a los hablantes de castellano andino o amazónico a un peor servicio sin que nadie lo sepa.

Requiere **personas reales leyendo un guion, con consentimiento informado firmado**. No es automatizable, y no debe simularse.

---

## Resumen de costes y plazos

| Servicio | Coste | Plazo | Sin él, no funciona |
|---|---|---|---|
| Anthropic | Pago por uso | Inmediato | Nada |
| Voyage AI | Capa gratuita | Inmediato | El RAG vectorial |
| Supabase | Capa gratuita | Inmediato | Persistencia y continuidad |
| Google Calendar | Gratuito | ~30 min | Agendamiento real |
| ElevenLabs | Pago | Inmediato | El canal de voz |
| Twilio / SIP | Pago + número | Horas o días | Llamadas telefónicas |
| Meta WhatsApp | Gratuito | **Días** | El canal de texto |
| n8n | Gratuito autoalojado | ~1 h | Recordatorios y escalamiento de respaldo |

## Qué no puedo hacer yo

Crear cuentas, aceptar términos de servicio, introducir credenciales o datos de pago, y verificar tu empresa ante Meta. Todo eso lo tienes que hacer tú. Lo que sí puedo es dejar el código listo, decirte exactamente dónde va cada dato, y ayudarte a diagnosticar cuando algo no conecte.
