/**
 * The Orbit island swap script — the project's FIRST shipped client artifact.
 *
 * `defer` on a component makes the engine emit an inert placeholder and hand
 * the host a manifest. Nothing replaced the placeholder, because no consumer
 * existed. This is that consumer, and it belongs in this repository rather than
 * in each embedder: under the settled position that Orbit ships JavaScript, a
 * swap protocol reinvented per host is a protocol with no specification.
 *
 * What the host keeps is exactly what the engine cannot own: the endpoint, and
 * signing. The engine has no key material, so it cannot sign — but the manifest
 * is the seam, not the DOM. The host signs the manifest server-side and emits an
 * opaque token; this script copies that token through verbatim and never
 * constructs, parses or validates it.
 *
 * Ambient authority lives here and nowhere else in the system, which is why this
 * file is first in scope for the third-party audit. Read it as if it were.
 *
 * Configured entirely from its own script tag, so a theme ships one tag:
 *
 *   <script src="/orbit-islands.js"
 *           data-endpoint="/_islands"
 *           data-token="…"
 *           integrity="sha384-…"
 *           crossorigin="anonymous"
 *           defer></script>
 *
 * Reports through DOM events on `document` rather than a global, so nothing has
 * to exist before this script loads and two copies cannot fight over a
 * namespace:
 *
 *   orbit:islands-filled  { detail: { filled: string[] } }
 *   orbit:islands-failed  { detail: { ids: string[], reason: string } }
 */

(function orbitIslands() {
  'use strict';

  var SELECTOR = 'orbit-island[data-island]';

  /**
   * The script's own tag. `document.currentScript` is null in a module or when
   * re-entered, so fall back to locating the tag by the attribute that
   * configures it — a page with two differently-configured tags is a host bug
   * either way, and taking the first is a defined answer rather than a crash.
   */
  function ownScript() {
    return document.currentScript || document.querySelector('script[data-endpoint]');
  }

  function report(name, detail) {
    document.dispatchEvent(new CustomEvent('orbit:islands-' + name, { detail: detail }));
  }

  /**
   * Fail without touching anything.
   *
   * The fallback is already on the page and is already correct — it is what the
   * author wrote for exactly this case. Clearing it, retrying into it, or
   * substituting an error message would each replace working output with worse
   * output. A failed island must never invalidate rendered SSR.
   */
  function giveUp(ids, reason) {
    report('failed', { ids: ids, reason: reason });
  }

  function run() {
    var script = ownScript();
    if (!script) return;

    var endpoint = script.getAttribute('data-endpoint');
    if (!endpoint) return;
    var token = script.getAttribute('data-token') || '';

    var nodes = document.querySelectorAll(SELECTOR);
    if (nodes.length === 0) return;

    var byId = {};
    var ids = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var id = nodes[i].getAttribute('data-island');
      // An id seen twice is a host or engine bug. Filling the first and leaving
      // the rest is defined; filling all of them from one response entry would
      // duplicate personalized content across unrelated placeholders.
      if (!id || Object.prototype.hasOwnProperty.call(byId, id)) continue;
      byId[id] = nodes[i];
      ids.push(id);
    }
    if (ids.length === 0) return;

    /*
     * ONE request for every island on the page. N islands must not mean N round
     * trips: the whole reason a fragment was deferred is that the page could be
     * cached without it, and paying N latencies to get it back gives that away.
     *
     * The ids travel in the BODY, never in the URL. They come from the DOM, and
     * a value from the DOM interpolated into a request URL is a request-forgery
     * surface even when the values are engine-generated today.
     */
    fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token, ids: ids }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error('http ' + response.status);
        return response.json();
      })
      .then(function (payload) {
        var islands = payload && payload.islands;
        if (!islands || typeof islands !== 'object') throw new Error('malformed');

        var filled = [];
        var missed = [];
        for (var j = 0; j < ids.length; j += 1) {
          var key = ids[j];
          // `hasOwnProperty` via the prototype, not `islands.hasOwnProperty`:
          // the payload is host JSON and may carry its own `hasOwnProperty`.
          var present =
            Object.prototype.hasOwnProperty.call(islands, key) &&
            typeof islands[key] === 'string';
          if (!present) {
            missed.push(key);
            continue;
          }
          /*
           * The one place this script writes markup.
           *
           * The content is Orbit's own render output, produced by the same
           * engine, through the same six-context escaper, in the host's second
           * pass — not author markup and not user input. That is the whole
           * argument for `innerHTML` here, and it is why the response must come
           * from the host's own endpoint over same-origin credentials.
           */
          byId[key].innerHTML = islands[key];
          filled.push(key);
        }
        if (filled.length > 0) report('filled', { filled: filled });
        if (missed.length > 0) giveUp(missed, 'absent');
      })
      .catch(function (err) {
        giveUp(ids, (err && err.message) || 'error');
      });
  }

  // `defer` on the tag already guarantees parsed DOM, but a host that omits it
  // would otherwise query before the placeholders exist.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
