const fs = require("fs/promises");
const path = require("path");

const express = require("express");
const multer = require("multer");

const { getConfig, redactUrl } = require("./lib/config");
const { cancelJob, getJobs, listPrinters, printFile } = require("./lib/cups");
const {
  createOfficePreview,
  isSofficeAvailable,
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

app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

app.get(
  "/api/config",
  asyncRoute(async (_request, response) => {
    response.json({
      cupsServer: redactUrl(config.cupsServerUrl),
      officePreviewAvailable: await isSofficeAvailable(config),
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
        jobName: request.body.jobName,
        requestingUser: request.body.requestingUser,
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
