// WordCraft file handling: when the installed PWA is launched for a document (OS file manager
// "open with", double-click on a registered extension), deliver the file into the app.
//
// The manifest declares file_handlers with action "./" — the app page itself — so a launch loads
// the normal app (offline-capable through the service worker, same cached assets) and this script
// hands the launched file to the running wasm app:
//
//   1. launchQueue.setConsumer receives LaunchParams.files (FileSystemFileHandles, read granted).
//   2. Once the app is up (#wordcraft_loading is removed only after eframe installs its canvas
//      event handlers — upstream removes it after WebRunner::start() resolves), the file is
//      delivered as a synthetic drop on #wordcraft_canvas. eframe's drop listener reads
//      dataTransfer.files() and the app opens the file exactly like a drag-and-dropped one:
//      documents open (beside unsaved work), pictures/fonts/spreadsheets route as inserts.
//   3. If the drop does not land (canvas replaced, listener not attached), fall back to
//      window.wordcraft.execute("file.open", …) — the page command API the app installs.
//
// Launches arriving while the app is already running (launch_handler client_mode focus-existing)
// re-invoke the consumer in the same document: the same path delivers each new file.
//
// Chromium-desktop only (Chrome/Edge 102+, and the PWA must be installed); the guard below keeps
// every other browser at plain drag-and-drop. Files larger than 512 MiB are refused by the app's
// own open path; nothing here needs a size check of its own.
'use strict';

(function () {
  if (!('launchQueue' in window)) return;
  if (!('files' in (window.LaunchParams && LaunchParams.prototype))) return;

  var canvasId = 'wordcraft_canvas';
  var loadingId = 'wordcraft_loading';

  window.launchQueue.setConsumer(function (launchParams) {
    var files = launchParams && launchParams.files ? launchParams.files : [];
    Array.prototype.forEach.call(files, function (handle) {
      appReady()
        .then(function () {
          return handle.getFile();
        })
        .then(deliver)
        .catch(function (err) {
          console.warn('wordcraft file handling: launch not delivered:', err);
        });
    });
  });

  /// The app accepting drops: #wordcraft_loading is removed after eframe's canvas listeners are
  /// installed, so once it is gone the canvas drop listener exists. Poll briefly, then wait on a
  /// MutationObserver for slow starts (the wasm is ~60 MB).
  function appReady() {
    if (!document.getElementById(loadingId)) return Promise.resolve();
    return new Promise(function (resolve) {
      var observer = new MutationObserver(function () {
        if (!document.getElementById(loadingId)) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      // Belt and braces: if the observer never fires (element already gone, or the app failed to
      // start), stop waiting so the queue does not hold the file forever.
      var ticks = 0;
      var poll = setInterval(function () {
        if (!document.getElementById(loadingId) || ++ticks > 600) {
          clearInterval(poll);
          observer.disconnect();
          resolve();
        }
      }, 250);
    });
  }

  /// Hand the file to the app: a synthetic drop first, the command API as fallback.
  function deliver(file) {
    var canvas = document.getElementById(canvasId);
    var dropped = false;
    if (canvas && typeof DataTransfer === 'function' && typeof DragEvent === 'function') {
      try {
        var dt = new DataTransfer();
        dt.items.add(file);
        var event = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
        dropped = !canvas.dispatchEvent(event);
      } catch (err) {
        dropped = false;
      }
    }
    if (dropped) return Promise.resolve();

    var api = window.wordcraft;
    if (api && typeof api.execute === 'function') {
      return readBase64(file).then(function (data) {
        return api.execute('file.open', { path: file.name, data: data });
      });
    }
    return Promise.reject(new Error('app is not accepting files (no canvas drop listener, no window.wordcraft)'));
  }

  /// Base64 of the file's bytes, for the fallback command API.
  function readBase64(file) {
    return file.arrayBuffer().then(function (buffer) {
      var bytes = new Uint8Array(buffer);
      var binary = '';
      var chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    });
  }
})();
