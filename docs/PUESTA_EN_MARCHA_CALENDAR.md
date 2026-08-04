# Google Calendar — puesta en marcha del agendamiento

Guía operativa para dejar `crear_cita` y `consultar_agenda` funcionando contra un calendario real.

> **Estado: bloqueado en el paso 0.** La cuenta de Google usada tiene el acceso a Google Cloud restringido: *«Se bloqueó el acceso a Google Cloud. A partir del 13 de mayo de 2025, Google Cloud comenzó a aplicar la verificación en 2 pasos»*. Sin resolver eso no se puede crear la cuenta de servicio.

---

## 0. Desbloquear Google Cloud

Activa la verificación en dos pasos en la cuenta de Google, o entra con una que ya la tenga.

Es un cambio de seguridad de la cuenta y requiere tu teléfono: hazlo tú, en [myaccount.google.com/security](https://myaccount.google.com/security). Los cambios tardan unos minutos en propagarse.

---

## 1. Habilitar la API

Consola de Google Cloud → proyecto → **APIs y servicios → Biblioteca** → *Google Calendar API* → **Habilitar**.

---

## 2. Cuenta de servicio

**IAM y administración → Cuentas de servicio → Crear cuenta de servicio.**

- Nombre: `recepcion-ia-agenda` (o el que prefieras).
- **No hace falta asignarle ningún rol del proyecto.** El permiso que necesita no es de IAM: es el que le dé el propio calendario en el paso 4. Dar roles de más aquí es superficie de ataque sin contrapartida.

Copia su **email**, de la forma `recepcion-ia-agenda@<proyecto>.iam.gserviceaccount.com`. Se usa en el paso 4.

---

## 3. Clave privada — **este paso lo haces tú**

En la cuenta de servicio → **Claves → Agregar clave → Crear clave nueva → JSON**. Se descarga un archivo.

Ese archivo **es una credencial**: quien lo tenga puede escribir en el calendario. No lo pegues en un chat, ni en un issue, ni lo subas al repositorio.

Ponlo en el `.env`, en una sola línea. Las dos formas valen:

```bash
# JSON en claro, en una linea
GOOGLE_CALENDAR_CREDENTIALS={"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...","client_email":"..."}
```

```bash
# o en base64, que evita problemas con comillas y saltos de linea
GOOGLE_CALENDAR_CREDENTIALS=eyJ0eXBlIjoic2VydmljZV9hY2NvdW50Ii...
```

Para generar el base64 en PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\ruta\a\la\clave.json"))
```

---

## 4. El calendario, y compartirlo

En [calendar.google.com](https://calendar.google.com): **Otros calendarios → + → Crear calendario**. Ponle nombre (p. ej. «Clínica Aurora — agenda») y zona horaria **America/Lima**.

Luego, en **Configuración del calendario**:

1. **Compartir con determinadas personas** → añade el **email de la cuenta de servicio** del paso 2, con permiso **«Hacer cambios en los eventos»**. Sin esto la API responde 404 o 403, no un error claro.
2. **Integrar el calendario → ID del calendario**: cópialo. Tiene la forma `xxxxxxxx@group.calendar.google.com`.

Ese ID va en `db/seed/clinica-demo/clinica.json`, en `config.googleCalendarId`, sustituyendo a `PENDIENTE-pegar-el-id-del-calendario`. Después hay que refrescar la fila de la clínica en la base (el `db:seed` la actualiza por `upsert`).

### Sobre `googleImpersonateSubject`

Se **omite a propósito**. Solo hace falta con **delegación de dominio de Google Workspace**, que requiere un dominio propio y permisos de administrador del workspace. Compartir el calendario con la cuenta de servicio consigue lo mismo para un calendario, sin dominio y sin delegación.

Si algún día hay Workspace y se quiere que la cuenta de servicio actúe *en nombre de* un buzón, se añade esa clave y se autoriza el client ID en la consola de administración.

---

## 5. Comprobar

Con el `.env` relleno y el ID del calendario puesto:

```bash
npm run demo:web
```

Y en el chat: «quiero agendar una limpieza para el jueves por la mañana». Debe ejecutar `consultar_agenda` y, al confirmar, `crear_cita`.

En la base:

```sql
select herramienta, estado, error_detalle
  from tool_calls
 where herramienta in ('consultar_agenda','crear_cita')
 order by creado_en desc limit 5;
```

Y en Google Calendar, el evento creado.

### Qué mirar si falla

| Síntoma | Causa más probable |
|---|---|
| 404 al consultar | el `googleCalendarId` no es el correcto, o el calendario no está compartido con la cuenta de servicio |
| 403 | compartido pero con permiso de solo lectura: hace falta «Hacer cambios en los eventos» |
| 401 | el JSON de la clave está mal pegado (saltos de línea del `private_key`) — usa base64 |
| Cita con la hora corrida | zona horaria del calendario distinta de `America/Lima`. Es criterio **bloqueante** de la Tabla 14 |

---

## Lo que ya está resuelto en el código

- Serialización de fechas en UTC con `timeZone` IANA adjunto, para que la cita no se corra de hora.
- `freebusy.query` en vez de `events.list`: la disponibilidad se consulta sin poder ver título ni asistentes de otros pacientes. El aislamiento es estructural, no una promesa.
- Idempotencia por SHA-256 de (clínica, inicio, fin, teléfono): un reintento no duplica la cita.
- Doble verificación de hueco libre inmediatamente antes de escribir (control C7).
