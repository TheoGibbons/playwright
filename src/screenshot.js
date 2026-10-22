// Full-page screenshots, captured in tiles and stitched with sharp.
//
// Chromium can't reliably capture one region taller than its ~16384px GPU
// texture limit (content repeats or comes out blank). Capturing 4096px tiles
// avoids that, so the height limit becomes our choice (memory, image format)
// instead of the browser's.

import sharp from 'sharp';
import { strToU8, zipSync } from 'fflate';
import { HttpError } from './errors.js';

const CAPTURE_TILE_PX = 4096;
// Largest dimension each encoder accepts.
const FORMAT_MAX_PX = { png: Number.MAX_SAFE_INTEGER, jpeg: 65_535, webp: 16_383 };
const CONTENT_TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

/** Same measurement Playwright uses for fullPage screenshots, in CSS pixels. */
export function measurePage(page) {
  return page.evaluate(() => {
    const b = document.body;
    const d = document.documentElement;
    return {
      width: Math.ceil(Math.max(b?.scrollWidth ?? 0, d.scrollWidth, b?.offsetWidth ?? 0, d.offsetWidth, d.clientWidth)),
      height: Math.ceil(Math.max(b?.scrollHeight ?? 0, d.scrollHeight, b?.offsetHeight ?? 0, d.offsetHeight, d.clientHeight)),
    };
  });
}

/**
 * Takes the screenshot described by `opts` and returns
 * { body, contentType, extension, meta }.
 */
export async function captureScreenshot(page, opts, limits) {
  const { format, quality } = opts;
  const dpr = opts.viewport.scale;
  const widthCss = opts.viewport.width;

  if (!opts.fullPage) {
    const png = await page.screenshot({ type: 'png', animations: 'disabled' });
    return image(await encode(sharp(png), format, quality), format, {});
  }

  const size = await measurePage(page);
  const capturedCss = Math.min(size.height, limits.maxCaptureHeight);
  const cappedByServer = size.height > limits.maxCaptureHeight;
  const limitPx = Math.min(opts.maxHeight, limits.maxImageHeight, FORMAT_MAX_PX[format]);
  const fullPx = Math.ceil(capturedCss * dpr);
  const meta = { pageHeight: size.height };

  if (fullPx <= limitPx) {
    const tiles = await captureTiles(page, { widthCss, heightCss: capturedCss, dpr, tilePx: CAPTURE_TILE_PX });
    return image(await encode(await stitch(tiles), format, quality), format, { ...meta, truncated: cappedByServer });
  }

  switch (opts.overflow) {
    case 'error':
      throw new HttpError(422, 'page_too_tall', `Page is ${Math.ceil(size.height * dpr)}px tall; the limit is ${limitPx}px`, {
        pageHeight: size.height,
        pixelHeight: Math.ceil(size.height * dpr),
        maxHeight: limitPx,
        hint: 'Retry with overflow "truncate", "scale" or "tiles", or use format "pdf".',
      });

    case 'truncate': {
      const heightCss = Math.floor(limitPx / dpr);
      const tiles = await captureTiles(page, { widthCss, heightCss, dpr, tilePx: CAPTURE_TILE_PX });
      return image(await encode(await stitch(tiles), format, quality), format, { ...meta, truncated: true });
    }

    case 'scale': {
      const factor = limitPx / fullPx;
      const tiles = await captureTiles(page, { widthCss, heightCss: capturedCss, dpr, tilePx: CAPTURE_TILE_PX });
      return image(await encode(await stitch(tiles, factor), format, quality), format, {
        ...meta,
        truncated: cappedByServer,
        scaleFactor: Number(factor.toFixed(4)),
      });
    }

    case 'tiles': {
      const tiles = await captureTiles(page, { widthCss, heightCss: capturedCss, dpr, tilePx: opts.tileHeight });
      return tileArchive(tiles, opts, { ...meta, truncated: cappedByServer });
    }

    default:
      throw new Error(`Unhandled overflow mode ${opts.overflow}`);
  }
}

async function captureTiles(page, { widthCss, heightCss, dpr, tilePx }) {
  const tileCss = Math.max(1, Math.floor(tilePx / dpr));
  const tiles = [];
  for (let y = 0; y < heightCss; y += tileCss) {
    const h = Math.min(tileCss, heightCss - y);
    // fullPage + clip lets the clip extend past the viewport. The page stays
    // scrolled to the top, so fixed headers appear once, not in every tile.
    const buf = await page.screenshot({
      type: 'png',
      fullPage: true,
      clip: { x: 0, y, width: widthCss, height: h },
      animations: 'disabled',
    });
    const { width, height } = await sharp(buf).metadata();
    tiles.push({ buf, yCss: y, heightCss: h, width, height });
  }
  return tiles;
}

/** Composites tiles top to bottom, optionally scaling each one by `factor`. */
async function stitch(tiles, factor = 1) {
  if (tiles.length === 1 && factor === 1) return sharp(tiles[0].buf);

  const width = Math.max(1, Math.round(tiles[0].width * factor));
  const totalPx = tiles.reduce((sum, t) => sum + t.height, 0);
  const height = Math.max(1, Math.round(totalPx * factor));

  const layers = [];
  let srcTop = 0;
  for (const t of tiles) {
    // Derive each tile's output rows from cumulative positions so rounding
    // never leaves a gap or overlap between tiles.
    const top = Math.round(srcTop * factor);
    const bottom = Math.round((srcTop + t.height) * factor);
    srcTop += t.height;
    if (bottom <= top) continue;

    let tile = sharp(t.buf);
    if (factor !== 1) tile = tile.resize(width, bottom - top, { fit: 'fill' });
    const { data, info } = await tile.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    layers.push({ input: data, raw: { width: info.width, height: info.height, channels: info.channels }, top, left: 0 });
  }

  return sharp({ create: { width, height, channels: 4, background: '#ffffff' } }).composite(layers);
}

function encode(img, format, quality) {
  switch (format) {
    case 'png':
      return img.png({ compressionLevel: 6 }).toBuffer();
    case 'jpeg':
      return img.flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer();
    case 'webp':
      return img.webp({ quality }).toBuffer();
    default:
      throw new Error(`Not an image format: ${format}`);
  }
}

function image(body, format, meta) {
  return { body, contentType: CONTENT_TYPES[format], extension: format === 'jpeg' ? 'jpg' : format, meta };
}

async function tileArchive(tiles, opts, meta) {
  const ext = opts.format === 'jpeg' ? 'jpg' : opts.format;
  const files = {};
  const manifest = { pageHeight: meta.pageHeight, truncated: meta.truncated, viewport: opts.viewport, tiles: [] };

  for (const [i, t] of tiles.entries()) {
    const name = `tile-${String(i + 1).padStart(3, '0')}.${ext}`;
    const body = opts.format === 'png' ? t.buf : await encode(sharp(t.buf), opts.format, opts.quality);
    files[name] = [body, { level: 0 }]; // already compressed
    manifest.tiles.push({ file: name, y: t.yCss, height: t.heightCss, pixelWidth: t.width, pixelHeight: t.height });
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));

  return {
    body: Buffer.from(zipSync(files)),
    contentType: 'application/zip',
    extension: 'zip',
    meta: { ...meta, tileCount: tiles.length },
  };
}
