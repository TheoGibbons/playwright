import { chromium } from 'playwright';

/**
 * Owns the Chromium process. Every render gets its own BrowserContext (fresh
 * cookies, storage and cache). After `recycleAfter` contexts the browser is
 * replaced; the old one is closed once its last context finishes.
 */
export class BrowserManager {
  #current = null; // { browser, active, served, retiring }
  #launching = null;
  #closed = false;

  constructor({ proxyUrl, sandbox, recycleAfter, log }) {
    this.proxyUrl = proxyUrl;
    this.sandbox = sandbox;
    this.recycleAfter = recycleAfter;
    this.log = log;
  }

  get status() {
    const c = this.#current;
    return { connected: Boolean(c?.browser.isConnected()), activeContexts: c?.active ?? 0, served: c?.served ?? 0 };
  }

  async start() {
    await this.#entry();
  }

  async newContext(options) {
    const entry = await this.#entry();
    entry.served++;
    entry.active++;
    let context;
    try {
      context = await entry.browser.newContext(options);
    } catch (err) {
      this.#done(entry);
      throw err;
    }
    context.once('close', () => this.#done(entry));
    return context;
  }

  async close() {
    this.#closed = true;
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
      proxy: { server: this.proxyUrl },
      args: [
        // Keep every byte on the proxied path.
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
    });
    const entry = { browser, active: 0, served: 0, retiring: false };
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
  }
}
