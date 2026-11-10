# NutriApp (PWA)

App web instalable en Android. Todo el código vive en `web/src`; el resultado listo para publicar queda en `web/dist/`.

## Publicar en GitHub Pages (gratis, desde el celular o el PC)
1. Crea un repositorio público en github.com (p. ej. `nutriapp`).
2. Sube **el contenido de la carpeta `dist/`** (index.html, sw.js, manifest.webmanifest, íconos) a la raíz del repositorio (botón *Add file → Upload files*).
3. En el repo: *Settings → Pages → Build and deployment → Deploy from a branch → main / (root) → Save*.
4. Espera 1–2 minutos: tu app queda en `https://TU-USUARIO.github.io/nutriapp/`.
5. Ábrela en Chrome del teléfono → menú ⋮ → **Instalar aplicación** (o *Añadir a pantalla de inicio*).

Para actualizar: vuelve a subir los archivos de `dist/` (reemplazan a los anteriores).

## Desarrollo
```
npm run typecheck:web && npm test && npm run build:web
```
