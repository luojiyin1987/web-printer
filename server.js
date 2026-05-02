const fs = require("fs/promises");
const path = require("path");

const express = require("express");
const multer = require("multer");

const { getConfig, redactUrl } = require("./lib/config");
const { cancelJob, getJobs, listPrinters, printFile } = require("./lib/cups");
const {
  cleanupOldPreviews,
  createOfficePreview,
  isOfficeDocument,
  isSofficeAvailable,
  OFFICE_EXTENSIONS,
  resolvePreviewFile,
} = require("./lib/preview");
const { formatPageRanges, parseCopies, parsePageRanges } = require("./lib/print-options");
const {
  printerListCache,
  getCachedValue,
  getPrinterJobsCache,
  cleanupPrinterJobsCaches,
  invalidatePrinterState,
} = require("./lib/cache-manager");

const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;
const JOB_ID_PATTERN = /^\d+$/;
const PUBLIC_DIR = path.join(__dirname, "public");

const config = getConfig();
const app = express();
let maintenanceTimer = null;
const uploadOptions = {
  dest: config.uploadDir,
  limits: {
    fileSize: config.uploadLimitBytes,
  },
};

const upload = multer(uploadOptions);
const officeUpload = multer({
  ...uploadOptions,
  fileFilter: (_request, file, callback) => {
    if (isOfficeDocument(file.originalname)) {
      callback(null, true);
      return;
    }

    const error = new Error(
      "Only Office documents can use server-side conversion preview."
    );
    error.statusCode = 400;
    callback(error);
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
  return truncated.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

async function removeFileIfPresent(filePath) {
  if (!filePath) {
    return;
  }

  await fs.rm(filePath, { force: true }).catch(() => {});
}

async function cleanupOldUploads() {
  const entries = await fs.readdir(config.uploadDir, { withFileTypes: true });
  const now = Date.now();

  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const target = path.join(config.uploadDir, entry.name);

        try {
          const stat = await fs.stat(target);
          if (now - stat.mtimeMs > UPLOAD_MAX_AGE_MS) {
            await fs.rm(target, { force: true });
          }
        } catch (_error) {
          // ignore cleanup races
        }
      })
  );
}

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

async function getCachedPrinters() {
  return getCachedValue(printerListCache, () => listPrinters(config));
}

async function getCachedPrinterJobs(printerName) {
  return getCachedValue(getPrinterJobsCache(printerName), () =>
    getJobs(config, printerName)
  );
}

function buildPrintJobRequest(request) {
  return {
    copies: parseCopies(request.body.copies),
    pageRanges: parsePageRanges(request.body.pageRanges),
    originalname: request.file.originalname,
    jobName: sanitizeCupsString(request.body.jobName, 128),
    requestingUser: sanitizeCupsString(request.body.requestingUser, 64),
  };
}

function sendBadRequest(response, message) {
  response.status(400).json({ error: message });
}

function resolveErrorStatus(error) {
  const message = error?.message || "Internal server error.";
  const normalizedMessage = message.toLowerCase();

  return (
    error?.statusCode ||
    (normalizedMessage.includes("file too large") ||
    normalizedMessage.includes("document is required")
      ? 400
      : 500)
  );
}

async function handleGetConfig(_request, response) {
  const officePreviewConfig = await getOfficePreviewConfig();
  response.json({
    cupsServer: redactUrl(config.cupsServerUrl),
    ...officePreviewConfig,
  });
}

async function handleListPrinters(_request, response) {
  const printers = await getCachedPrinters();
  response.json({ printers });
}

async function handleListJobs(request, response) {
  const jobs = await getCachedPrinterJobs(request.params.printerName);
  response.json({ jobs });
}

async function handleCancelJob(request, response) {
  const { printerName, jobId } = request.params;

  if (!JOB_ID_PATTERN.test(jobId)) {
    sendBadRequest(response, "jobId must be a positive integer.");
    return;
  }

  const result = await cancelJob(config, printerName, jobId);
  invalidatePrinterState(printerName);
  response.json(result);
}

async function handleCreatePreview(request, response) {
  try {
    const result = await createOfficePreview(config, request.file);
    response.status(201).json(result);
  } catch (error) {
    await removeFileIfPresent(request.file?.path);
    throw error;
  }
}

async function handleGetPreviewFile(request, response) {
  const previewPath = await resolvePreviewFile(config, request.params.previewId);
  response.type("application/pdf");
  response.sendFile(previewPath);
}

async function handlePrintDocument(request, response) {
  if (!request.file) {
    sendBadRequest(response, "document is required.");
    return;
  }

  const { printerName } = request.params;
  const printRequest = buildPrintJobRequest(request);

  try {
    const buffer = await fs.readFile(request.file.path);
    const result = await printFile(config, printerName, {
      buffer,
      ...printRequest,
    });

    invalidatePrinterState(printerName);

    response.status(201).json({
      ...result,
      pageRangesText:
        printRequest.pageRanges.length > 0
          ? formatPageRanges(printRequest.pageRanges)
          : "",
    });
  } finally {
    await removeFileIfPresent(request.file.path);
  }
}

function handleError(error, _request, response, _next) {
  const message = error?.message || "Internal server error.";
  response.status(resolveErrorStatus(error)).json({ error: message });
}

function registerMiddleware() {
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));
}

function registerRoutes() {
  app.get("/api/config", asyncRoute(handleGetConfig));
  app.get("/api/printers", asyncRoute(handleListPrinters));
  app.get("/api/printers/:printerName/jobs", asyncRoute(handleListJobs));
  app.post(
    "/api/printers/:printerName/jobs/:jobId/cancel",
    asyncRoute(handleCancelJob)
  );
  app.post(
    "/api/previews",
    officeUpload.single("document"),
    asyncRoute(handleCreatePreview)
  );
  app.get("/api/previews/:previewId/file", asyncRoute(handleGetPreviewFile));
  app.post(
    "/api/printers/:printerName/print",
    upload.single("document"),
    asyncRoute(handlePrintDocument)
  );
}

async function ensureRuntimeDirectories() {
  await fs.mkdir(config.uploadDir, { recursive: true });
  await fs.mkdir(config.previewDir, { recursive: true });
}

async function runStartupCleanup() {
  await cleanupOldUploads().catch((error) => {
    console.error("Failed to clean up old uploads:", error);
  });
  await cleanupOldPreviews(config).catch((error) => {
    console.error("Failed to clean up old previews:", error);
  });
}

function scheduleMaintenance() {
  maintenanceTimer = setTimeout(async () => {
    await cleanupOldUploads().catch((error) => {
      console.error("Periodic upload cleanup failed:", error);
    });
    await cleanupOldPreviews(config).catch((error) => {
      console.error("Periodic preview cleanup failed:", error);
    });
    cleanupPrinterJobsCaches();
    scheduleMaintenance();
  }, MAINTENANCE_INTERVAL_MS);
}

function stopMaintenance() {
  if (maintenanceTimer) {
    clearTimeout(maintenanceTimer);
    maintenanceTimer = null;
  }
}

function logStartup() {
  console.log(
    `web-printer listening on http://${config.host}:${config.port} -> ${redactUrl(
      config.cupsServerUrl
    )}`
  );
}

function registerShutdownHandlers(server) {
  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`${signal} received, shutting down gracefully.`);
    stopMaintenance();

    const forcedExitTimer = setTimeout(() => {
      console.error("Forced exit after graceful shutdown timeout.");
      process.exit(1);
    }, 10000);

    server.close((error) => {
      clearTimeout(forcedExitTimer);

      if (error) {
        console.error("Graceful shutdown failed:", error);
        process.exit(1);
        return;
      }

      process.exit(0);
    });
    server.closeIdleConnections();
  }

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
}

async function start() {
  registerMiddleware();
  registerRoutes();
  app.use(handleError);

  await ensureRuntimeDirectories();
  await runStartupCleanup();
  scheduleMaintenance();

  const server = app.listen(config.port, config.host, logStartup);
  registerShutdownHandlers(server);
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
