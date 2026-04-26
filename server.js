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

app.get(
  "/api/config",
  asyncRoute(async (_request, response) => {
    response.json({
      cupsServer: redactUrl(config.cupsServerUrl),
      officePreviewAvailable: await isSofficeAvailable(config),
      officeExtensions: OFFICE_EXTENSIONS,
    });
  })
);

app.get(
  "/api/printers",
  asyncRoute(async (_request, response) => {
    const printers = await listPrinters(config);
    response.json({ printers });
  })
);

app.get(
  "/api/printers/:printerName/jobs",
  asyncRoute(async (request, response) => {
    const jobs = await getJobs(config, request.params.printerName);
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
