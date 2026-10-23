// All runtime configuration comes from environment variables.

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const apiKeys = (process.env.API_KEYS ?? '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: int('PORT', 3000),
  logLevel: process.env.LOG_LEVEL || 'info',

  apiKeys,

  // How many pages render at once, and how many requests may wait for a slot.
  maxConcurrency: int('MAX_CONCURRENCY', 2),
  maxQueue: int('MAX_QUEUE', 20),
  // Hard ceiling for a whole job (queue wait excluded). The browser context is
  // killed when it is hit.
  jobTimeoutMs: int('JOB_TIMEOUT_MS', 60_000),
  navigationTimeoutMs: int('NAVIGATION_TIMEOUT_MS', 30_000),

  // Tallest single image we will produce (device pixels). Requests may ask for
  // less, never more.
  maxImageHeight: int('MAX_IMAGE_HEIGHT', 32_768),
  // Never capture more than this many CSS pixels of page, whatever the overflow
  // mode. Protects against infinite-scroll pages.
  maxCaptureHeight: int('MAX_CAPTURE_HEIGHT', 100_000),

  // Relaunch Chromium after this many renders to shed leaked memory.
  recycleAfter: int('BROWSER_RECYCLE_AFTER', 200),
  // Close Chromium after this long without renders, freeing its memory; the
  // next request starts it again. 0 keeps it running.
  idleShutdownMs: int('IDLE_SHUTDOWN_MS', 60_000),
  chromiumSandbox: bool('CHROMIUM_SANDBOX', false),

  // Lets pages reach localhost / RFC1918 / link-local addresses. Leave off on
  // anything internet-facing: it is what stops SSRF into your network.
  allowPrivateNetworks: bool('ALLOW_PRIVATE_NETWORKS', false),
};

export function assertConfig() {
  if (config.apiKeys.length === 0) {
    throw new Error('API_KEYS is empty. Set it to one or more comma-separated keys.');
  }
  if (config.apiKeys.some((k) => k.length < 16)) {
    throw new Error('Every API key in API_KEYS must be at least 16 characters.');
  }
}
