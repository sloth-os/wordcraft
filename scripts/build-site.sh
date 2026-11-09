#!/usr/bin/env bash
# Build the WordCraft web app for GitHub Pages: upstream source + this overlay's PWA files.
#
# The workflow calls this from the publishing repo checkout, with the upstream wordcraft clone in
# $WORDCRAFT_DIR (its apps/wordcraft-web builds with Trunk into dist/web). After the build, the
# site overlay (manifest, service worker, icons, offline page, version marker) is layered on top.
#
# Environment:
#   WORDCRAFT_DIR   upstream wordcraft checkout (required)
#   SITE_DIR        overlay directory in this repo (default: <script>/../site)
#   OUT_DIR         output directory (default: <repo>/_site)
#   DEPLOY_ID       deployment marker value (default: "<short sha> <utc date>")
#
# Writes: $OUT_DIR ready for actions/deploy-pages, plus a step summary with the build's size.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WORDCRAFT_DIR="${WORDCRAFT_DIR:?WORDCRAFT_DIR must point at the upstream wordcraft checkout}"
SITE_DIR="${SITE_DIR:-$HERE/site}"
OUT_DIR="${OUT_DIR:-$HERE/_site}"
DEPLOY_ID="${DEPLOY_ID:-"$(git -C "$WORDCRAFT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown) $(date -u +%Y-%m-%dT%H:%M:%SZ)"}"

TRUNK_DIST="$WORDCRAFT_DIR/dist/web"
[[ -f "$TRUNK_DIST/index.html" ]] || { echo "error: $TRUNK_DIST/index.html missing; build first" >&2; exit 1; }

# ---1. Upstream build output -------------------------------------------------------------
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp -R "$TRUNK_DIST/." "$OUT_DIR/"

# --- 2. PWA overlay ------------------------------------------------------------------------
mkdir -p "$OUT_DIR/icons"
cp "$SITE_DIR/manifest.webmanifest" "$OUT_DIR/"
cp "$SITE_DIR/sw.js" "$OUT_DIR/"
cp "$SITE_DIR/offline.html" "$OUT_DIR/"

# Icons: from upstream's hicolor set (same app icon the desktop app uses; MIT OR Apache-2.0) at
# the sizes it ships, with 192 and the maskable variants (artwork inside the safe zone on a
# solid tile) generated from the 512 original — generated here so this repo ships no binary blobs.
python3 - "$WORDCRAFT_DIR/assets/app-icon/hicolor/512x512/apps/ai.storyteller.wordcraft.png" \
  "$WORDCRAFT_DIR/assets/app-icon/hicolor/256x256/apps/ai.storyteller.wordcraft.png" "$OUT_DIR/icons" <<'PY'
import sys
from PIL import Image

src512_path, src256_path, out_dir = sys.argv[1:4]
src512 = Image.open(src512_path).convert("RGBA")
src256 = Image.open(src256_path).convert("RGBA")

# "any" icons: as-is at the sizes upstream ships.
src512.save(f"{out_dir}/icon-512.png", "PNG")
src256.save(f"{out_dir}/icon-256.png", "PNG")
src512.resize((192, 192), Image.LANCZOS).save(f"{out_dir}/icon-192.png", "PNG")

# Maskable icons: the launcher mask crops to a shape (circle, squircle…), so the artwork must
# sit inside the central ~80% safe zone on a background of the app tile's blue.
for px in (192, 512):
    canvas = Image.new("RGBA", (px, px), (59, 91, 219, 255))
    icon = src512.resize((int(px * 0.8), int(px * 0.8)), Image.LANCZOS)
    canvas.paste(icon, ((px - icon.width) // 2, (px - icon.height) // 2), icon)
    canvas.save(f"{out_dir}/icon-maskable-{px}.png", "PNG")
PY
cp "$WORDCRAFT_DIR/assets/app-icon/wordcraft.svg" "$OUT_DIR/icons/icon.svg" 2>/dev/null \
  || cp "$WORDCRAFT_DIR/assets/app-icon/hicolor/scalable/apps/ai.storyteller.wordcraft.svg" "$OUT_DIR/icons/icon.svg"

# --- 3. Deployment marker -------------------------------------------------------------------
# version.json: the build's identity, uncached by the service worker. commit is the upstream SHA
# this build came from; version is what the app's About window shows.
UPSTREAM_SHA="$(git -C "$WORDCRAFT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
UPSTREAM_DATE="$(git -C "$WORDCRAFT_DIR" log -1 --format=%cI 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
VERSION="$(awk '/^\[workspace.package\]/{p=1} p && /^version/{gsub(/[" ]/,"",$3); print $3; exit}' "$WORDCRAFT_DIR/Cargo.toml")"
printf '{\n  "commit": "%s",\n  "builtAt": "%s",\n  "upstreamDate": "%s",\n  "version": "%s",\n  "deployId": "%s"\n}\n' \
  "$UPSTREAM_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$UPSTREAM_DATE" "$VERSION" "$DEPLOY_ID" > "$OUT_DIR/version.json"

# --- 4. Wire the overlay into index.html ------------------------------------------------------
# index.html comes from the upstream build; it knows nothing of the PWA. Add the manifest link,
# theme color and the service worker registration (a tiny inline module, kept inline so the
# registration is on the critical path without another request).
python3 - "$OUT_DIR/index.html" <<'PY'
import sys

path = sys.argv[1]
html = open(path, encoding="utf-8").read()

head_add = (
    '  <link rel="manifest" href="manifest.webmanifest">\n'
    '  <meta name="theme-color" content="#3b5bdb">\n'
    '  <link rel="apple-touch-icon" href="icons/icon-192.png">\n'
 '  <meta name="description" content="WordCraft: open-source word processor in the browser">\n'
)
if 'rel="manifest"' not in html:
    html = html.replace("</head>", head_add + "</head>", 1)

sw_register = (
    "  <script>\n"
    "    if ('serviceWorker' in navigator) {\n"
    "      window.addEventListener('load', function () {\n"
    "        navigator.serviceWorker.register('sw.js').catch(function (e) {\n"
    "          console.warn('service worker registration failed (offline support disabled):', e);\n"
    "        });\n"
    "      });\n"
    "    }\n"
    "  </script>\n"
)
if 'serviceWorker' in html:
    pass # already registered (upstream grew its own): leave it alone
elif "</body>" in html:
    html = html.replace("</body>", sw_register + "</body>", 1)
else:
    html += sw_register

open(path, "w", encoding="utf-8").write(html)
print("index.html: manifest link and service worker registration added")
PY

# --- 5. Verify the result --------------------------------------------------------------------
python3 - "$OUT_DIR" <<'PY'
import json, sys, pathlib

out = pathlib.Path(sys.argv[1])
must = ["index.html", "manifest.webmanifest", "sw.js", "offline.html", "version.json",
        "icons/icon-192.png", "icons/icon-256.png", "icons/icon-512.png",
        "icons/icon-maskable-192.png", "icons/icon-maskable-512.png", "icons/icon.svg"]
missing = [f for f in must if not (out / f).is_file()]
if missing:
    sys.exit(f"error: missing after build: {missing}")
manifest = json.loads((out / "manifest.webmanifest").read_text())
html = (out / "index.html").read_text()
assert 'rel="manifest"' in html, "index.html lost its manifest link"
assert "serviceWorker" in html or "<script" not in html, "no service worker registration"
wasm = list(out.glob("*.wasm"))
assert wasm, "no wasm in the output — the trunk build output was not copied"
assert len(manifest["icons"]) >= 4, "manifest icons missing"
print(f"verify: {len(must)} core files, {len(wasm)} wasm, manifest ok")
PY

# --- 6. Summary ---------------------------------------------------------------------------------
TOTAL=$(du -sb "$OUT_DIR" | cut -f1)
WASM=$(du -cb "$OUT_DIR"/*.wasm | tail -1 | cut -f1)
{
  echo "### Pages build"
  echo ""
  echo "- upstream: \`$UPSTREAM_SHA\` ($UPSTREAM_DATE)"
  echo "- app version: \`$VERSION\`"
  echo "- site size: $((TOTAL / 1024 / 1024)) MB ($((TOTAL / 1024)) KB), wasm: $((WASM / 1024 / 1024)) MB"
  echo "- deployed to: ${GITHUB_PAGES_URL:-GitHub Pages}"
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"

echo "site assembled in $OUT_DIR"
