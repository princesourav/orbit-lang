// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SIZE_BUDGET } from './build.mjs';

/**
 * The swap script, exercised against a real DOM.
 *
 * "Real DOM" and not "real browser": this runs under happy-dom, which
 * implements DOM semantics — `innerHTML`, `querySelectorAll`, `CustomEvent`,
 * `readyState` — in Node. It is not a browser matrix, and the script's
 * behaviour in Safari or on an ES5 engine is not evidenced here. That gap is
 * recorded in SECURITY.md rather than papered over: this file proves the logic,
 * not the compatibility.
 *
 * What it does prove is the property that matters most, and the one a unit test
 * of a pure function could not reach: **a failing island never damages the page
 * that was already rendered**. Every failure path below asserts the fallback is
 * still there afterwards.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(HERE, 'islands.js'), 'utf8');
const MINIFIED = readFileSync(path.join(HERE, 'dist', 'orbit-islands.min.js'), 'utf8');

const FALLBACK = '<span class="skeleton">…</span>';

/**
 * Lay out a page the way the engine emits one, then run the script over it.
 *
 * The script is evaluated with `new Function` rather than imported, because it
 * is an IIFE that reads `document.currentScript` — it has to run in a document
 * that already contains its own tag, exactly as it does on a page.
 */
function page({ ids = ['i0'], endpoint = '/_islands', token = 't0k', fallback = FALLBACK } = {}) {
  document.head.innerHTML =
    `<script data-endpoint="${endpoint}" data-token="${token}"></script>`;
  document.body.innerHTML = ids
    .map((id) => `<orbit-island data-island="${id}">${fallback}</orbit-island>`)
    .join('');
}

function runScript(code = SOURCE) {
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'fetch', 'CustomEvent', code)(
    globalThis.window,
    globalThis.document,
    globalThis.fetch,
    globalThis.CustomEvent,
  );
}

/** Wait for the script's promise chain to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function listen() {
  const events = [];
  const push = (e) => events.push({ type: e.type, detail: e.detail });
  document.addEventListener('orbit:islands-filled', push);
  document.addEventListener('orbit:islands-failed', push);
  return events;
}

function islandHtml(id = 'i0') {
  return document.querySelector(`orbit-island[data-island="${id}"]`)?.innerHTML;
}

let fetchMock;

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function respond(body, { ok = true, status = 200 } = {}) {
  fetchMock.mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
}

describe('the happy path', () => {
  it('renders the fallback first, then swaps in the island content', async () => {
    page();
    // Before the script runs, the page is the SSR output: fallback showing.
    expect(islandHtml()).toBe(FALLBACK);

    respond({ islands: { i0: '<b>Cart (3)</b>' } });
    const events = listen();
    runScript();
    await settle();

    expect(islandHtml()).toBe('<b>Cart (3)</b>');
    expect(events).toEqual([{ type: 'orbit:islands-filled', detail: { filled: ['i0'] } }]);
  });

  it('sends one request for every island on the page', async () => {
    // N islands must not mean N round trips: the reason the fragment was
    // deferred is that the page could be cached without it, and paying N
    // latencies to get it back gives that away.
    page({ ids: ['i0', 'i1', 'i2'] });
    respond({ islands: { i0: '<i>a</i>', i1: '<i>b</i>', i2: '<i>c</i>' } });
    runScript();
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(islandHtml('i0')).toBe('<i>a</i>');
    expect(islandHtml('i2')).toBe('<i>c</i>');
  });

  it('puts the ids in the body and the token through verbatim, never in the URL', async () => {
    // Values from the DOM interpolated into a request URL are a forgery surface
    // even when the values are engine-generated today.
    page({ ids: ['i0', 'i1'], endpoint: '/_islands', token: 'opaque-signed-blob' });
    respond({ islands: {} });
    runScript();
    await settle();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/_islands');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(init.body)).toEqual({ token: 'opaque-signed-blob', ids: ['i0', 'i1'] });
  });

  it('does nothing at all when the page has no islands', async () => {
    document.head.innerHTML = '<script data-endpoint="/_islands"></script>';
    document.body.innerHTML = '<p>ordinary page</p>';
    runScript();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when the host forgot to configure an endpoint', async () => {
    document.head.innerHTML = '<script></script>';
    document.body.innerHTML = `<orbit-island data-island="i0">${FALLBACK}</orbit-island>`;
    runScript();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(islandHtml()).toBe(FALLBACK);
  });
});

describe('a failing island never damages the page', () => {
  /**
   * The property the whole design turns on. The fallback is already correct —
   * it is what the author wrote for exactly this case — so clearing it,
   * retrying into it, or substituting an error message each replace working
   * output with worse output.
   */
  const cases = [
    ['the network rejects', () => fetchMock.mockRejectedValue(new Error('offline')), 'offline'],
    ['the endpoint 500s', () => respond({}, { ok: false, status: 500 }), 'http 500'],
    ['the body is not JSON', () => fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) }), 'bad json'],
    ['the payload has no islands key', () => respond({ nope: true }), 'malformed'],
    ['islands is not an object', () => respond({ islands: 'nope' }), 'malformed'],
  ];

  for (const [name, arrange, reason] of cases) {
    it(`leaves the fallback intact when ${name}`, async () => {
      page();
      arrange();
      const events = listen();
      runScript();
      await settle();

      expect(islandHtml()).toBe(FALLBACK);
      expect(events).toEqual([
        { type: 'orbit:islands-failed', detail: { ids: ['i0'], reason } },
      ]);
    });
  }

  it('fills what it can and reports only what was absent', async () => {
    // One island missing from the response must not cost the others their
    // content: a failure is per-island, not per-page.
    page({ ids: ['i0', 'i1'] });
    respond({ islands: { i0: '<b>ok</b>' } });
    const events = listen();
    runScript();
    await settle();

    expect(islandHtml('i0')).toBe('<b>ok</b>');
    expect(islandHtml('i1')).toBe(FALLBACK);
    expect(events).toEqual([
      { type: 'orbit:islands-filled', detail: { filled: ['i0'] } },
      { type: 'orbit:islands-failed', detail: { ids: ['i1'], reason: 'absent' } },
    ]);
  });

  it('ignores a non-string value rather than stringifying it into the page', async () => {
    page();
    respond({ islands: { i0: { toString: () => '<b>coerced</b>' } } });
    runScript();
    await settle();
    expect(islandHtml()).toBe(FALLBACK);
  });

  it('does not retry, so a broken endpoint costs one request and not a storm', async () => {
    page();
    fetchMock.mockRejectedValue(new Error('offline'));
    runScript();
    await settle();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('what it refuses to touch', () => {
  it('ignores an id the page never asked for', async () => {
    // A response naming a placeholder that is not on this page is a host bug at
    // best; acting on it would let one render's content land in another's.
    page({ ids: ['i0'] });
    document.body.innerHTML += '<orbit-island>no id</orbit-island>';
    respond({ islands: { i0: '<b>a</b>', i9: '<b>elsewhere</b>' } });
    runScript();
    await settle();

    expect(document.body.innerHTML).toContain('<b>a</b>');
    expect(document.body.innerHTML).not.toContain('elsewhere');
    expect(document.body.innerHTML).toContain('no id');
  });

  it('fills a duplicated id once and leaves the rest alone', async () => {
    // Filling every copy from one response entry would duplicate personalized
    // content across placeholders that were never the same island.
    page({ ids: ['i0', 'i0'] });
    respond({ islands: { i0: '<b>once</b>' } });
    runScript();
    await settle();

    const filled = [...document.querySelectorAll('orbit-island')].map((n) => n.innerHTML);
    expect(filled).toEqual(['<b>once</b>', FALLBACK]);
  });

  it('touches no element other than a placeholder', async () => {
    page();
    document.body.insertAdjacentHTML('afterbegin', '<header id="hdr">untouched</header>');
    respond({ islands: { i0: '<b>x</b>' } });
    runScript();
    await settle();
    expect(document.querySelector('#hdr').innerHTML).toBe('untouched');
  });

  it('is not fooled by a payload carrying its own hasOwnProperty', async () => {
    // The payload is host JSON. `islands.hasOwnProperty(key)` would call
    // whatever the payload defined; the script goes through Object.prototype.
    page();
    respond({ islands: JSON.parse('{"hasOwnProperty": "<b>evil</b>"}') });
    const events = listen();
    runScript();
    await settle();

    expect(islandHtml()).toBe(FALLBACK);
    expect(events).toEqual([
      { type: 'orbit:islands-failed', detail: { ids: ['i0'], reason: 'absent' } },
    ]);
  });
});

describe('the shipped artifact', () => {
  it('is within its size budget', () => {
    const bytes = Buffer.byteLength(MINIFIED, 'utf8');
    expect(bytes).toBeLessThanOrEqual(SIZE_BUDGET);
  });

  it('behaves identically after minification', async () => {
    // The tests above run the source. This runs what actually ships.
    page();
    respond({ islands: { i0: '<b>minified</b>' } });
    runScript(MINIFIED);
    await settle();
    expect(islandHtml()).toBe('<b>minified</b>');
  });

  it('reaches for no dynamic-code or document-rewriting primitive', () => {
    // The one artifact in the system with ambient authority. What it does NOT
    // contain is as much of its audit surface as what it does.
    for (const primitive of ['eval(', 'new Function', 'document.write', 'setTimeout', 'XMLHttpRequest']) {
      expect(MINIFIED, `shipped script must not use ${primitive}`).not.toContain(primitive);
    }
  });

  it('writes markup in exactly one place', () => {
    // If a second `innerHTML` ever appears, it is a new sink and wants its own
    // argument. One is reviewable; two is a pattern.
    const writes = MINIFIED.split('innerHTML').length - 1;
    expect(writes).toBe(1);
  });
});

describe('the published metadata', () => {
  /**
   * The SRI hash and the tag that carries it are emitted together so they
   * cannot drift apart — a host that computes its own hash is a host that can
   * get it wrong silently, and a mismatched `integrity` simply blocks the
   * script, which looks exactly like the island endpoint being down.
   *
   * Asserted here rather than by pointing the claims manifest at
   * `dist/orbit-islands.json`: that file is a build output, so citing it made a
   * claim that passed locally and was unbacked on a clean checkout.
   */
  it('emits an SRI hash, the tag that carries it, and the budget', () => {
    const meta = JSON.parse(readFileSync(path.join(HERE, 'dist', 'orbit-islands.json'), 'utf8'));

    expect(meta.integrity).toMatch(/^sha384-[A-Za-z0-9+/]+=*$/);
    expect(meta.tag).toContain(`integrity="${meta.integrity}"`);
    expect(meta.tag).toContain('crossorigin="anonymous"');
    expect(meta.tag).toContain('data-endpoint=');
    expect(meta.budget).toBe(SIZE_BUDGET);
    expect(meta.bytes).toBeLessThanOrEqual(meta.budget);
    expect(meta.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the hash matches the script it ships beside', async () => {
    // Not a restatement of the build: recomputed here, so a metadata file that
    // fell out of step with the artifact fails rather than being believed.
    const { createHash } = await import('node:crypto');
    const meta = JSON.parse(readFileSync(path.join(HERE, 'dist', 'orbit-islands.json'), 'utf8'));
    const recomputed = 'sha384-' + createHash('sha384').update(MINIFIED, 'utf8').digest('base64');
    expect(meta.integrity).toBe(recomputed);
  });
});
