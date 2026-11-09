# wordcraft-web

[WordCraft](https://github.com/storytold/wordcraft) — the open-source word processor written in
pure Rust — running in the browser via WebAssembly, published weekly to GitHub Pages as an
installable, offline-capable PWA.

**Live app: <https://sloth-os.github.io/wordcraft/>**

## What this repository is

This repository holds **no Rust source**. It is a thin publishing overlay over the upstream
project:

```
.github/workflows/pages.yml   # weekly build + deploy (the heart of it)
site/                         # PWA files layered onto the upstream build output
scripts/build-site.sh         # build script the workflow runs
```

Every run — weekly on schedule, on every push, or manual `workflow_dispatch` — the workflow:

1. Clones upstream `storytold/wordcraft` at its latest `main`, plus its pinned asset repos
   (`craft-i18n` for interface translations at the SHA in `craft-i18n.rev`, `craft-fonts` for the
   Georgian/Arabic interface faces embedded in the wasm).
2. Builds `apps/wordcraft-web` with Trunk (`trunk build --release`, `wasm-opt -z`), exactly as
   upstream's own release pipeline does.
3. Layers `site/` over the output: a web app manifest, PWA icons, a service worker, an offline
   notice, and a `version.json` deployment id.
4. Publishes the result to GitHub Pages.

Because every build is from upstream's latest `main`, the published app tracks upstream
development without this repo carrying a fork.

## PWA / offline

- `site/manifest.webmanifest` names the app, icons and `standalone` display, so browsers offer
  "Install app" / "Add to Home Screen".
- `site/sw.js` is a service worker: precaches the shell (`index.html`, manifest, icons,
  `version.json`), serves the content-hashed `.wasm`/`.js` cache-first, `index.html` network-first
  (so a new weekly build is picked up on the next visit, offline falls back to the cached copy).
- `version.json` carries the deployment id (upstream commit + build time); it is never cached,
  so `https://sloth-os.github.io/wordcraft/version.json` always shows the live build. A new
  deployment updates the worker because browsers re-fetch `sw.js` on navigation and it calls
  `skipWaiting`/`clients.claim`.
- User-added fonts and preferences live in IndexedDB/`localStorage`, which the app manages itself.

## Notes

- The upstream build outputs content-hashed asset names and a ~13 MB wasm (~5 MB with Brotli);
  GitHub Pages serves it uncompressed, so the first load is the slow one — later loads and all
  offline use come from the service worker cache.
- GitHub Pages serves `.wasm` as `application/wasm`, which the build requires.
- Source and license: the app is upstream WordCraft, MIT OR Apache-2.0, © the ArtCraft team and
  WordCraft contributors. This overlay is MIT OR Apache-2.0 too.
