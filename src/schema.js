import { badRequest } from './errors.js';

export const IMAGE_FORMATS = ['png', 'jpeg', 'webp'];
const WAIT_STRATEGIES = ['load', 'domcontentloaded', 'networkidle', 'selector', 'expression', 'settled'];

const cookie = {
  type: 'object',
  required: ['name', 'value'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 256 },
    value: { type: 'string', maxLength: 4096 },
    domain: { type: 'string', maxLength: 253 },
    path: { type: 'string', maxLength: 1024 },
    secure: { type: 'boolean' },
    httpOnly: { type: 'boolean' },
    sameSite: { enum: ['Strict', 'Lax', 'None'] },
  },
};

// Ajv fills in the defaults (including nested ones under `default: {}`).
export const renderBodySchema = {
  type: 'object',
  required: ['url'],
  additionalProperties: false,
  properties: {
    url: { type: 'string', minLength: 1, maxLength: 8192 },
    format: { enum: [...IMAGE_FORMATS, 'pdf', 'html', 'mhtml'], default: 'png' },
    quality: { type: 'integer', minimum: 1, maximum: 100, default: 80 },
    fullPage: { type: 'boolean', default: true },
    viewport: {
      type: 'object',
      additionalProperties: false,
      default: {},
      properties: {
        width: { type: 'integer', minimum: 320, maximum: 3840, default: 1280 },
        height: { type: 'integer', minimum: 240, maximum: 4320, default: 800 },
        scale: { type: 'number', minimum: 0.5, maximum: 3, default: 1 },
      },
    },
    wait: {
      type: 'object',
      additionalProperties: false,
      default: {},
      properties: {
        until: { enum: WAIT_STRATEGIES },
        selector: { type: 'string', minLength: 1, maxLength: 1000 },
        expression: { type: 'string', minLength: 1, maxLength: 5000 },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 60_000, default: 15_000 },
        quietMs: { type: 'integer', minimum: 100, maximum: 10_000, default: 1_000 },
        delayMs: { type: 'integer', minimum: 0, maximum: 30_000, default: 0 },
        strict: { type: 'boolean', default: false },
      },
    },
    scrollToLoad: { type: 'boolean' },
    maxHeight: { type: 'integer', minimum: 256 },
    overflow: { enum: ['truncate', 'scale', 'tiles', 'error'], default: 'truncate' },
    tileHeight: { type: 'integer', minimum: 512, maximum: 16_000, default: 4096 },
    hideSelectors: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 500 }, default: [] },
    blockAds: { type: 'boolean', default: false },
    headers: { type: 'object', maxProperties: 50, additionalProperties: { type: 'string', maxLength: 8192 } },
    cookies: { type: 'array', maxItems: 100, items: cookie },
    colorScheme: { enum: ['light', 'dark', 'no-preference'], default: 'light' },
    userAgent: { type: 'string', minLength: 1, maxLength: 1000 },
    pdf: {
      type: 'object',
      additionalProperties: false,
      default: {},
      properties: {
        paper: { enum: ['A3', 'A4', 'A5', 'Letter', 'Legal', 'Tabloid'], default: 'A4' },
        landscape: { type: 'boolean', default: false },
        margin: { type: 'string', pattern: '^\\d+(\\.\\d+)?(px|in|cm|mm)$', default: '10mm' },
        media: { enum: ['screen', 'print'], default: 'screen' },
        scale: { type: 'number', minimum: 0.1, maximum: 2, default: 1 },
        printBackground: { type: 'boolean', default: true },
      },
    },
    html: {
      type: 'object',
      additionalProperties: false,
      default: {},
      properties: {
        baseHref: { type: 'boolean', default: true },
      },
    },
  },
};

/** Fills in defaults that depend on other fields and checks cross-field rules. */
export function normalizeOptions(body, limits) {
  const opts = structuredClone(body);

  let url;
  try {
    url = new URL(opts.url);
  } catch {
    throw badRequest('url is not a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('url must use http or https');
  }
  opts.url = url.href;

  const wait = opts.wait;
  wait.until ??= wait.selector ? 'selector' : wait.expression ? 'expression' : 'settled';
  if (wait.until === 'selector' && !wait.selector) throw badRequest('wait.until "selector" needs wait.selector');
  if (wait.until === 'expression' && !wait.expression) throw badRequest('wait.until "expression" needs wait.expression');

  const isImage = IMAGE_FORMATS.includes(opts.format);
  opts.scrollToLoad ??= (isImage && opts.fullPage) || opts.format === 'pdf';
  opts.maxHeight = Math.min(opts.maxHeight ?? limits.maxImageHeight, limits.maxImageHeight);

  return opts;
}
