function createTimedCache(ttlMs) {
  return {
    ttlMs,
    value: undefined,
    expiresAt: 0,
    inFlight: null,
    lastAccessAt: Date.now(),
  };
}

async function getCachedValue(cache, loader) {
  cache.lastAccessAt = Date.now();

  if (Date.now() < cache.expiresAt) {
    return cache.value;
  }

  if (cache.inFlight) {
    return cache.inFlight;
  }

  cache.inFlight = (async () => {
    const value = await loader();
    cache.value = value;
    cache.expiresAt = Date.now() + cache.ttlMs;
    return value;
  })();

  try {
    return await cache.inFlight;
  } finally {
    cache.inFlight = null;
  }
}

function invalidateCache(cache) {
  cache.value = undefined;
  cache.expiresAt = 0;
}

// ---------------------------------------------------------------------------
// Printer jobs caches (per-printer LRU with idle eviction)
// ---------------------------------------------------------------------------

const PRINTER_CACHE_TTL_MS = 3000;
const JOB_CACHE_TTL_MS = 1500;
const PRINTER_JOBS_CACHE_MAX_ENTRIES = 128;
const PRINTER_JOBS_CACHE_IDLE_TTL_MS = 10 * 60 * 1000;

const printerListCache = createTimedCache(PRINTER_CACHE_TTL_MS);
const printerJobsCaches = new Map();

function getPrinterJobsCache(printerName) {
  cleanupPrinterJobsCaches();

  if (!printerJobsCaches.has(printerName)) {
    printerJobsCaches.set(printerName, createTimedCache(JOB_CACHE_TTL_MS));
  }

  const cache = printerJobsCaches.get(printerName);
  cache.lastAccessAt = Date.now();
  return cache;
}

function cleanupPrinterJobsCaches() {
  const now = Date.now();

  for (const [printerName, cache] of printerJobsCaches.entries()) {
    if (cache.inFlight) {
      continue;
    }

    if (now - cache.lastAccessAt > PRINTER_JOBS_CACHE_IDLE_TTL_MS) {
      printerJobsCaches.delete(printerName);
    }
  }

  if (printerJobsCaches.size <= PRINTER_JOBS_CACHE_MAX_ENTRIES) {
    return;
  }

  const removableEntries = Array.from(printerJobsCaches.entries())
    .filter(([, cache]) => !cache.inFlight)
    .sort((left, right) => left[1].lastAccessAt - right[1].lastAccessAt);

  while (
    printerJobsCaches.size > PRINTER_JOBS_CACHE_MAX_ENTRIES &&
    removableEntries.length > 0
  ) {
    const [printerName] = removableEntries.shift();
    printerJobsCaches.delete(printerName);
  }
}

function invalidatePrinterState(printerName) {
  invalidateCache(printerListCache);

  if (!printerName) {
    return;
  }

  const jobsCache = printerJobsCaches.get(printerName);
  if (jobsCache) {
    invalidateCache(jobsCache);
  }
}

module.exports = {
  printerListCache,
  getCachedValue,
  getPrinterJobsCache,
  cleanupPrinterJobsCaches,
  invalidateCache,
  invalidatePrinterState,
};
