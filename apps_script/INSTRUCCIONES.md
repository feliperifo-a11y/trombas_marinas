# Alertas de trombas por correo: instalación (una sola vez, unos 5 minutos)

El envío sale desde tu Gmail y los suscriptores quedan en una planilla de tu Google Drive.

1. Crea una planilla nueva en Google Sheets (sheets.new) y llámala "Alertas trombasmarinas.cl".
2. En la planilla: **Extensiones → Apps Script**. Borra el contenido de `Código.gs` y pega todo `alertas_correo.gs`. Guarda (ícono de disquete).
3. En el selector de funciones elige **instalar** y presiona **Ejecutar**. Google pedirá permisos:
   "Revisar permisos" → tu cuenta → "Configuración avanzada" → "Ir a … (no seguro)" → "Permitir".
   El aviso aparece porque el script es tuyo y no está publicado en Google; es normal. Los permisos son: leer y escribir
   la planilla, enviar correos como tú y consultar trombasmarinas.cl.
4. (Opcional) Elige **probarAlerta** y ejecútala: te llega un correo de ejemplo a tu Gmail.
5. **Implementar → Nueva implementación** → tipo **Aplicación web**:
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario**
   Presiona **Implementar** y copia la **URL de la aplicación web** (termina en `/exec`).
6. Esa URL va en `index.html` (`const ALERTAS_URL = '…'`). Con eso aparece el botón "🔔 Alertas por correo".

Enlace para compartir: https://trombasmarinas.cl/?alertas (abre directo el formulario).

Límites: una cuenta Gmail gratuita envía hasta unos 100 destinatarios al día por Apps Script. Si la lista crece más,
conviene una cuenta de Google Workspace o un servicio de boletines.
Si cambias el código, usa **Implementar → Administrar implementaciones → Editar → Nueva versión** para mantener la misma URL.
