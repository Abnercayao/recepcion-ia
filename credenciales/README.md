# credenciales/

**Todo lo que pongas aquí lo ignora git.** Es el sitio local para los archivos
de credenciales que no caben en una variable de entorno: JSON de cuentas de
servicio, certificados, claves privadas.

Este `README.md` es lo único versionado de la carpeta, y existe para que la
carpeta viaje en el repositorio y no haya que recordar crearla.

## Cómo se usa

Deja aquí el archivo y apunta la variable de entorno al contenido, no a la ruta:

```bash
# Google Calendar: el JSON de la cuenta de servicio, en base64
base64 -w0 credenciales/google-service-account.json
```

El resultado va en `GOOGLE_CALENDAR_CREDENTIALS`, dentro de tu `.env`.
`parseGoogleCredentials` acepta el JSON en claro o en base64; se prefiere base64
porque la `private_key` lleva saltos de línea que rompen los archivos `.env`.

## Lo que NO debe pasar

Ninguna credencial real debe acabar en `.env.example`, ni en un commit, ni en un
mensaje de chat. Un commit posterior no borra nada: el valor se queda en el
historial y sigue siendo válido hasta que se rote.

`npm run comprobar-secretos` revisa el árbol de trabajo, y el hook de pre-commit
revisa lo que está a punto de entrar. Si alguno se queja, hazle caso.

## Si una credencial se filtró

Rotarla es lo único que sirve. Limpiar el historial ayuda, pero llega tarde:
lo que estuvo publicado hay que darlo por comprometido.
