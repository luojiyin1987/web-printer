const fs = require("fs/promises");
const path = require("path");

const express = require("express");
const multer = require("multer");

const { getConfig, redactUrl } = require("./lib/config");
const { cancelJob, getJobs, listPrinters, printFile } = require("./lib/cups");
const {
  cleanupOldPreviews,
  createOfficePreview,
  isSofficeAvailable,
  OFFICE_EXTENSIONS,
  resolvePreviewFile,
} = require("./lib/preview");
const {
  formatPageRanges,
  parseCopies,
  parsePageRanges,
} = require("./lib/print-options");

const config = getConfig();
const app = express();

const PRINTER_CACHE_TTL_MS = 3000;
const JOB_CACHE_TTL_MS = 1500;
const PRINTER_JOBS_CACHE_MAX_ENTRIES = 128;
const PRINTER_JOBS_CACHE_IDLE_TTL_MS = 10 * 60 * 1000;

const printerListCache = createTimedCache(PRINTER_CACHE_TTL_MS);
const printerJobsCaches = new Map();

const upload = multer({
  dest: config.uploadDir,
  limits: {
    fileSize: config.uploadLimitBytes,
  },
});

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function sanitizeCupsString(value, maxLength) {
  const str = String(value || "").trim();
  const truncated = str.length > maxLength ? str.slice(0, maxLength) : str;
  // Strip control characters (except tab, newline, carriage return)
  return truncated.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

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

function invalidateCache(cache) {
  cache.value = undefined;
  cache.expiresAt = 0;
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

async function cleanupOldUploads(config) {
  const entries = await fs.readdir(config.uploadDir, { withFileTypes: true });
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours

  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const target = path.join(config.uploadDir, entry.name);
        try {
          const stat = await fs.stat(target);
          if (now - stat.mtimeMs > maxAge) {
            await fs.rm(target, { force: true });
          }
        } catch (_error) {
          // ignore
        }
      })
  );
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function getOfficePreviewConfig() {
  try {
    return {
      officePreviewAvailable: await isSofficeAvailable(config),
      officeExtensions: OFFICE_EXTENSIONS,
    };
  } catch (error) {
    console.error("Failed to probe LibreOffice availability:", error);
    return {
      officePreviewAvailable: false,
      officeExtensions: OFFICE_EXTENSIONS,
    };
  }
}

app.get(
  "/api/config",
  asyncRoute(async (_request, response) => {
    const officePreviewConfig = await getOfficePreviewConfig();
    response.json({
      cupsServer: redactUrl(config.cupsServerUrl),
      ...officePreviewConfig,
    });
  })
);

app.get(
  "/api/printers",
  asyncRoute(async (_request, response) => {
    const printers = await getCachedValue(printerListCache, () =>
      listPrinters(config)
    );
    response.json({ printers });
  })
);

app.get(
  "/api/printers/:printerName/jobs",
  asyncRoute(async (request, response) => {
    const jobs = await getCachedValue(
      getPrinterJobsCache(request.params.printerName),
      () => getJobs(config, request.params.printerName)
    );
    response.json({ jobs });
  })
);

app.post(
  "/api/previews",
  upload.single("document"),
  asyncRoute(async (request, response) => {
    try {
      const result = await createOfficePreview(config, request.file);
      response.status(201).json(result);
    } catch (error) {
      if (request.file?.path) {
        await fs.rm(request.file.path, { force: true }).catch(() => {});
      }

      throw error;
    }
  })
);

app.get(
  "/api/previews/:previewId/file",
  asyncRoute(async (request, response) => {
    const previewPath = await resolvePreviewFile(config, request.params.previewId);
    response.type("application/pdf");
    response.sendFile(previewPath);
  })
);

app.post(
  "/api/printers/:printerName/print",
  upload.single("document"),
  asyncRoute(async (request, response) => {
    if (!request.file) {
      response.status(400).json({ error: "document is required." });
      return;
    }

    const copies = parseCopies(request.body.copies);
    const pageRanges = parsePageRanges(request.body.pageRanges);

    try {
      const buffer = await fs.readFile(request.file.path);
      const result = await printFile(config, request.params.printerName, {
        buffer,
        copies,
        pageRanges,
        originalname: request.file.originalname,
        jobName: sanitizeCupsString(request.body.jobName, 128),
        requestingUser: sanitizeCupsString(request.body.requestingUser, 64),
      });

      invalidatePrinterState(request.params.printerName);

      response.status(201).json({
        ...result,
        pageRangesText: pageRanges.length > 0 ? formatPageRanges(pageRanges) : "",
      });
    } finally {
      await fs.rm(request.file.path, { force: true });
    }
  })
);

app.post(
  "/api/printers/:printerName/jobs/:jobId/cancel",
  asyncRoute(async (request, response) => {
    if (!/^\d+$/.test(request.params.jobId)) {
      response.status(400).json({ error: "jobId must be a positive integer." });
      return;
    }

    const result = await cancelJob(
      config,
      request.params.printerName,
      request.params.jobId
    );
    invalidatePrinterState(request.params.printerName);
    response.json(result);
  })
);

app.use((error, _request, response, _next) => {
  const message = error?.message || "Internal server error.";
  const normalizedMessage = message.toLowerCase();
  const status =
    error?.statusCode ||
    (normalizedMessage.includes("file too large") ||
    normalizedMessage.includes("document is required")
      ? 400
      : 500);

  response.status(status).json({ error: message });
});

async function start() {
  await fs.mkdir(config.uploadDir, { recursive: true });
  await fs.mkdir(config.previewDir, { recursive: true });

  await cleanupOldUploads(config).catch((error) => {
    console.error("Failed to clean up old uploads:", error);
  });
  await cleanupOldPreviews(config).catch((error) => {
    console.error("Failed to clean up old previews:", error);
  });

  // Periodic cleanup every 10 minutes
  setInterval(() => {
    cleanupOldUploads(config).catch((error) => {
      console.error("Periodic upload cleanup failed:", error);
    });
    cleanupOldPreviews(config).catch((error) => {
      console.error("Periodic preview cleanup failed:", error);
    });
    cleanupPrinterJobsCaches();
  }, 10 * 60 * 1000);

  app.listen(config.port, config.host, () => {
    console.log(
      `web-printer listening on http://${config.host}:${config.port} -> ${redactUrl(
        config.cupsServerUrl
      )}`
    );
  });
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
