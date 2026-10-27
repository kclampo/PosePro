/* version.js — THE single source of truth for the release number.
 *
 * Kevin, 2026-10-22: "add the release number on the page so I can confirm I am
 * running the latest."
 *
 * ⚠️ TWO THINGS, and the second is the one that actually matters:
 *   1. The badge shows the version of the code CURRENTLY RUNNING (from the
 *      constant below). That is the number the service worker served him.
 *   2. It then asks the server for the newest published version and compares.
 *      A service worker that is serving a stale bundle will still say its own
 *      old number — so the comparison, not the badge alone, is what proves he
 *      is current.
 *
 * ⚠️ RELEASE CHECKLIST — bump BOTH, or the check lies:
 *      version.js  -> const APP_VERSION
 *      version.json -> "version"
 *      sw.js        -> CACHE
 */
(function () {
  const APP_VERSION = '1.8.8';

  window.APP_VERSION = APP_VERSION;

  function paint(text, cls) {
    var els = document.querySelectorAll('[data-version]');
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = text;
      els[i].className = 'ver' + (cls ? ' ' + cls : '');
    }
  }

  function check() {
    paint('v' + APP_VERSION, '');
    // cache:'no-store' AND a unique query string, because a cached answer would
    // always say "up to date" — which is precisely the failure this exists to
    // catch. The service worker also bypasses version.json entirely.
    fetch('version.json?ts=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.version) return;              // offline: badge alone is fine
        if (j.version === APP_VERSION) {
          paint('v' + APP_VERSION + ' · LATEST', 'ok');
        } else {
          paint('v' + APP_VERSION + ' · UPDATE v' + j.version, 'warn');
        }
      })
      .catch(function () { /* offline is normal for this app */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }
})();
