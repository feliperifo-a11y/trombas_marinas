# Portal del pronóstico de riesgo (usuario y clave)

Las páginas de `riesgo/` se sirven desde un Worker de Cloudflare que exige número de usuario y clave.
Los usuarios, las emisiones y el registro de accesos quedan en Workers KV, no en este repositorio.

| Perfil | Puede |
|---|---|
| Cliente | Ver las emisiones (solo sus ciudades, si se le asignaron) y descargar PDF, Word y Excel |
| Editor | Lo anterior, más elaborar y emitir pronósticos |
| Administrador | Todo, más crear, editar y dar de baja usuarios y ver el registro de accesos |

## Puesta en marcha (una sola vez)

1. **Cloudflare, token:** Mi perfil → API Tokens → Create Token → plantilla **"Edit Cloudflare Workers"** → elegir la cuenta → Create. Copiar el token.
2. **Cloudflare, Account ID:** Workers & Pages → panel derecho → **Account ID**.
3. **Cloudflare, subdominio:** si la cuenta nunca usó Workers, entrar a Workers & Pages y elegir el subdominio `*.workers.dev`.
4. **GitHub, secretos:** repositorio → Settings → Secrets and variables → Actions → New repository secret:
   - `CLOUDFLARE_API_TOKEN` (paso 1)
   - `CLOUDFLARE_ACCOUNT_ID` (paso 2)
   - `ADMIN_USUARIO` (número del administrador, por ejemplo `0001`)
   - `ADMIN_CLAVE` (clave larga del administrador)
5. **Desplegar:** Actions → "Portal de riesgo (Cloudflare)" → Run workflow. El resumen muestra la dirección del portal
   (`https://riesgo-apoyomet.<subdominio>.workers.dev`). La primera vez crea solo el espacio KV `RIESGO_PORTAL`.

Cada cambio en `riesgo/` o `portal/` que llegue a `main` vuelve a desplegar el portal.

## Uso

- El administrador entra con `ADMIN_USUARIO` y `ADMIN_CLAVE` y abre **Editor → Usuarios** para crear cada usuario
  (número, nombre, perfil, clave y ciudades). La clave se muestra una sola vez al guardarla.
- Cada usuario puede cambiar su clave desde la barra superior. Si la olvida, el administrador le asigna una nueva.
- Desactivar o eliminar un usuario corta su sesión de inmediato.
- Tras 5 intentos fallidos, el usuario queda bloqueado 15 minutos.
- Para cambiar la clave del administrador: actualizar el secreto `ADMIN_CLAVE` en GitHub y volver a ejecutar el workflow.

## Detalles técnicos

- `worker.js`: verificación de sesión (cookie `HttpOnly`, `Secure`, `SameSite=Strict`, 12 h), API y entrega de páginas.
- Claves con PBKDF2-SHA256 y sal propia por usuario; nunca se guardan en texto.
- `build.sh` arma `portal/public` con las páginas de `riesgo/` y los recursos de `assets/`.
- Plan gratuito de Workers y KV: alcanza de sobra para decenas de usuarios y una o dos emisiones diarias.
