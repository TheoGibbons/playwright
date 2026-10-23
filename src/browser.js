import { chromium } from 'playwright';

/**
 * Owns the Chromium process. Every render gets its own BrowserContext (fresh
 * cookies, storage and cache). After `recycleAfter` contexts the browser is
 * replaced; the old one is closed once its last context finishes. With
 * `idleShutdownMs` > 0, Chromium is closed after that long without renders and
 * launched again by the next request.
 */
export class BrowserManager {
  #current = null; // { browser, active, served, retiring }
  #launching = null;
  #closed = false;
  #pending = 0; // newContext() calls in flight, so idle shutdown can't race them
  #idleTimer = null;

  constructor({ proxyUrl, sandbox, recycleAfter, idleShutdownMs = 0, log }) {
    this.proxyUrl = proxyUrl;
    this.sandbox = sandbox;
    this.recycleAfter = recycleAfter;
    this.idleShutdownMs = idleShutdownMs;
    this.log = log;
  }

  get status() {
    const c = this.#current;
    return { running: Boolean(c?.browser.isConnected()), activeContexts: c?.active ?? 0, served: c?.served ?? 0 };
  }

  /** Launches Chromium up front so a broken install fails at boot, not on the first request. */
  async start() {
    await this.#entry();
    this.#armIdleTimer();
  }

  async newContext(options) {
    this.#pending++;
    this.#clearIdleTimer();
    try {
      const entry = await this.#entry();
      entry.served++;
      entry.active++;
      let context;
      try {
        // A userAgent in `options` replaces the default.
        context = await entry.browser.newContext({ userAgent: entry.userAgent, ...options });
      } catch (err) {
        this.#done(entry);
        throw err;
      }
      context.once('close', () => this.#done(entry));
      return context;
    } finally {
      this.#pending--;
      this.#armIdleTimer();
    }
  }

  async close() {
    this.#closed = true;
    this.#clearIdleTimer();
    await this.#launching?.catch(() => {});
    await this.#current?.browser.close().catch(() => {});
    this.#current = null;
  }

  async #entry() {
    if (this.#closed) throw new Error('Browser manager is closed');
    const current = this.#current;
    if (current && !current.browser.isConnected()) this.#current = null;
    if (current && current.served >= this.recycleAfter) {
      current.retiring = true;
      if (current.active === 0) current.browser.close().catch(() => {});
      this.#current = null;
    }
    if (this.#current) return this.#current;

    this.#launching ??= this.#launch().finally(() => {
      this.#launching = null;
    });
    return this.#launching;
  }

  async #launch() {
    const started = Date.now();
    const browser = await chromium.launch({
      // Full Chromium in new headless mode renders like real Chrome (the
      // separate headless shell differs in small ways).
      channel: 'chromium',
      chromiumSandbox: this.sandbox,
      // Playwright would otherwise kill Chromium the instant a signal arrives,
      // failing every render in flight. server.js owns shutdown: it lets those
      // renders finish, then closes the browser.
      handleSIGTERM: false,
      handleSIGINT: false,
      proxy: { server: this.proxyUrl },
      args: [
        // Keep every byte on the proxied path.
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        // Bot checks read navigator.webdriver. This makes it false, as it is
        // in a browser a person is using.
        '--disable-blink-features=AutomationControlled',
        // The zygote has every process it forks drop its capabilities with
        // capset(), which Lambda refuses, so each renderer crashed there.
        // Without the sandbox it buys nothing, so launch processes directly,
        // in Docker too, where the tests then cover what Lambda runs.
        ...(this.sandbox ? [] : ['--no-zygote']),
      ],
    });
    let userAgent;
    try {
      userAgent = await regularUserAgent(browser);
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
    const entry = { browser, userAgent, active: 0, served: 0, retiring: false };
    browser.on('disconnected', () => {
      if (this.#current === entry) {
        this.#current = null;
        if (!this.#closed) this.log.warn('Chromium disconnected unexpectedly; will relaunch on next request');
      }
    });
    this.#current = entry;
    this.log.info({ ms: Date.now() - started, version: browser.version() }, 'Chromium launched');
    return entry;
  }

  #done(entry) {
    entry.active--;
    if (entry.retiring && entry.active === 0) {
      this.log.info({ served: entry.served }, 'Recycling Chromium');
      entry.browser.close().catch(() => {});
    }
    this.#armIdleTimer();
  }

  #armIdleTimer() {
    const entry = this.#current;
    if (this.idleShutdownMs <= 0 || this.#closed || this.#idleTimer || this.#pending > 0) return;
    if (!entry || entry.active > 0) return;

    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (this.#current !== entry || entry.active > 0 || this.#pending > 0) return;
      this.#current = null;
      this.log.info({ idleMs: this.idleShutdownMs, served: entry.served }, 'Closing idle Chromium');
      entry.browser.close().catch(() => {});
    }, this.idleShutdownMs);
    this.#idleTimer.unref(); // never keep the process alive just for this
  }

  #clearIdleTimer() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }
}

/**
 * Chromium's own user agent with "HeadlessChrome" changed to "Chrome". That
 * word is the only difference from the same browser run with a window, and bot
 * checks match on it.
 */
async function regularUserAgent(browser) {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { userAgent } = await cdp.send('Browser.getVersion');
    return userAgent.replace('HeadlessChrome/', 'Chrome/');
  } finally {
    await cdp.detach().catch(() => {});
  }
}
