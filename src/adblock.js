// Optional ad / tracker / cookie-banner blocking using Ghostery's filter lists.
// The lists are downloaded on first use and kept in memory.

let blockerPromise;

async function getBlocker() {
  blockerPromise ??= import('@ghostery/adblocker-playwright')
    .then(({ PlaywrightBlocker }) => PlaywrightBlocker.fromPrebuiltFull(fetch))
    .catch((err) => {
      blockerPromise = undefined; // try again on the next request
      throw err;
    });
  return blockerPromise;
}

/** Returns true when blocking is active for `page`, false if the lists couldn't load. */
export async function enableAdblock(page, log) {
  try {
    const blocker = await getBlocker();
    await blocker.enableBlockingInPage(page);
    return true;
  } catch (err) {
    log.warn({ err }, 'Ad blocking unavailable; rendering without it');
    return false;
  }
}
