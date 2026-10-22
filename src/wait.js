// Deciding when a page is "ready" to capture.

import { setTimeout as sleep } from 'node:timers/promises';
import { errors as pwErrors } from 'playwright';
import { HttpError, badRequest } from './errors.js';

// Puppeteer's "networkidle2" idea: a couple of long-lived requests (analytics
// beacons, long-polling) shouldn't stop a page from counting as quiet.
const NETWORK_BUSY_ABOVE = 2;

/** Counts in-flight requests from the moment it's attached. */
export function trackNetwork(page) {
  let inflight = 0;
  let quietSince = Date.now();

  const onStart = () => {
    inflight++;
    if (inflight > NETWORK_BUSY_ABOVE) quietSince = null;
  };
  const onEnd = () => {
    inflight = Math.max(0, inflight - 1);
    if (inflight <= NETWORK_BUSY_ABOVE && quietSince === null) quietSince = Date.now();
  };
  page.on('request', onStart);
  page.on('requestfinished', onEnd);
  page.on('requestfailed', onEnd);

  return {
    quietFor: () => (quietSince === null ? 0 : Date.now() - quietSince),
  };
}

// Runs in the page. Installs a MutationObserver on first call; afterwards
// returns how many ms the DOM has been unchanged. Returns 0 after a client-side
// navigation wiped the previous observer.
function domQuietProbe() {
  const state = window.__renderSettle;
  if (!state) {
    const s = { last: performance.now() };
    window.__renderSettle = s;
    new MutationObserver(() => {
      s.last = performance.now();
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    return 0;
  }
  return performance.now() - state.last;
}

/** Waits until neither the DOM nor the network has changed for `quietMs`. */
async function waitForSettled(page, network, { quietMs, deadline, signal }) {
  while (Date.now() < deadline) {
    let domQuiet = 0;
    try {
      domQuiet = await page.evaluate(domQuietProbe);
    } catch {
      // Execution context destroyed by a navigation; probe again.
    }
    if (domQuiet >= quietMs && network.quietFor() >= quietMs) return true;
    await sleep(Math.max(0, Math.min(100, deadline - Date.now())), undefined, { signal });
  }
  return false;
}

async function untilTimeout(promise) {
  try {
    await promise;
    return true;
  } catch (err) {
    if (err instanceof pwErrors.TimeoutError) return false;
    throw err;
  }
}

/**
 * Applies the requested wait strategy. Timeouts are soft unless `wait.strict`:
 * the page is captured as it is and the caller is told via `timedOut`.
 */
export async function waitForReady(page, network, wait, signal) {
  const deadline = Date.now() + wait.timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  let ok;

  switch (wait.until) {
    case 'domcontentloaded':
      ok = true; // page.goto already waited for it
      break;
    case 'load':
    case 'networkidle':
      ok = await untilTimeout(page.waitForLoadState(wait.until, { timeout: remaining() }));
      break;
    case 'selector':
      try {
        ok = await untilTimeout(page.waitForSelector(wait.selector, { state: 'visible', timeout: remaining() }));
      } catch (err) {
        if (signal.aborted) throw err;
        throw badRequest(`wait.selector failed: ${firstLine(err)}`);
      }
      break;
    case 'expression':
      try {
        // Exceptions (e.g. reading window.app.ready before window.app exists)
        // count as "not yet" instead of failing the render.
        const probe = `(() => { try { return (${wait.expression}); } catch { return false; } })()`;
        ok = await untilTimeout(page.waitForFunction(probe, undefined, { timeout: remaining(), polling: 100 }));
      } catch (err) {
        if (signal.aborted) throw err;
        throw badRequest(`wait.expression failed: ${firstLine(err)}`);
      }
      break;
    case 'settled':
      ok =
        (await untilTimeout(page.waitForLoadState('load', { timeout: remaining() }))) &&
        (await waitForSettled(page, network, { quietMs: wait.quietMs, deadline, signal }));
      break;
    default:
      throw badRequest(`Unknown wait.until "${wait.until}"`);
  }

  if (!ok && wait.strict) {
    throw new HttpError(504, 'wait_timeout', `Page was not ready (${wait.until}) within ${wait.timeoutMs}ms`);
  }
  return { timedOut: !ok };
}

/**
 * Scrolls to the bottom in viewport-sized steps so lazy images and
 * IntersectionObserver content load, then returns to the top and lets the page
 * settle briefly.
 */
export async function scrollToLoad(page, network, { maxHeight, signal }) {
  await page.evaluate(
    async ({ maxHeight, stepDelayMs, budgetMs }) => {
      const started = performance.now();
      const step = Math.max(200, Math.floor(window.innerHeight * 0.9));
      const docHeight = () => Math.max(document.body?.scrollHeight ?? 0, document.documentElement.scrollHeight);
      let y = 0;
      while (performance.now() - started < budgetMs) {
        if (y + window.innerHeight >= docHeight() || y >= maxHeight) break;
        y += step;
        window.scrollTo({ top: y, behavior: 'instant' });
        await new Promise((r) => setTimeout(r, stepDelayMs));
      }
      window.scrollTo({ top: 0, behavior: 'instant' });
    },
    { maxHeight, stepDelayMs: 150, budgetMs: 10_000 },
  );
  await waitForSettled(page, network, { quietMs: 500, deadline: Date.now() + 3_000, signal });
}

function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0];
}
