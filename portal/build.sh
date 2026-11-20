#!/usr/bin/env bash
# Arma portal/public con las páginas de riesgo/ y los recursos compartidos del sitio.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf public && mkdir -p public/assets
cp ../riesgo/index.html ../riesgo/editor.html ../riesgo/riesgo.js ../riesgo/riesgo.css ../riesgo/apoyomet.png public/
cp login.html public/
for f in leaflet.js leaflet.css sitio.css logo-meteoia.png favicon-32.png ios-180.png; do cp "../assets/$f" public/assets/; done
printf 'User-agent: *\nDisallow: /\n' > public/robots.txt
echo "portal/public listo: $(ls public | wc -l) archivos"
