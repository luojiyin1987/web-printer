const ipp = require("ipp");
const mime = require("mime-types");

// CUPS extends IPP with vendor-specific operations not present in the
// standard ipp library. Register the operation code so that
// printer.execute("CUPS-Get-Printers", ...) serializes correctly.
if (!ipp.operations["CUPS-Get-Printers"]) {
  ipp.operations["CUPS-Get-Printers"] = 0x4002;
}

const REQUESTED_PRINTER_ATTRIBUTES = [
  "printer-name",
  "printer-info",
  "printer-location",
  "printer-make-and-model",
  "printer-is-accepting-jobs",
  "printer-state",
  "printer-state-message",
  "printer-state-reasons",
  "printer-uri-supported",
  "queued-job-count",
  "document-format-supported",
  "page-ranges-supported",
];

const REQUESTED_JOB_ATTRIBUTES = [
  "job-id",
  "job-name",
  "job-originating-user-name",
  "job-printer-uri",
  "job-state",
  "job-state-reasons",
  "time-at-creation",
  "time-at-processing",
  "time-at-completed",
];

function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "undefined" || value === null || value === "") {
    return [];
  }

  return [value];
}

function httpUrlToIppUrl(rawUrl) {
  const url = new URL(rawUrl);
  const protocol = url.protocol === "https:" ? "ipps" : "ipp";
  return `${protocol}://${url.host}${url.pathname}${url.search}`;
}

function ippUriToHttpUrl(printerUri, fallbackBaseUrl) {
  const uri = new URL(printerUri);
  const target = new URL(fallbackBaseUrl.toString());

  target.protocol = uri.protocol === "ipps:" ? "https:" : "http:";
  target.hostname = uri.hostname;
  target.port = uri.port || target.port;
  target.pathname = uri.pathname || "/";
  target.search = uri.search;
  target.hash = "";

  return target;
}

function buildPrinterPath(printerName) {
  return `/printers/${encodeURIComponent(printerName)}`;
}

function createPrinter(url, printerUri) {
  return ipp.Printer(url.toString(), {
    uri: printerUri || httpUrlToIppUrl(url.toString()),
  });
}

function execute(printer, operation, message, timeoutMs = 30000) {
  let timeoutId = null;

  return Promise.race([
    new Promise((resolve, reject) => {
      printer.execute(operation, message, (error, response) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        if (error) {
          reject(error);
          return;
        }

        if (response.statusCode && response.statusCode !== "successful-ok") {
          reject(new Error(`IPP request failed: ${response.statusCode}`));
          return;
        }

        resolve(response);
      });
    }),
    new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`IPP request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

function normalizePrinter(baseUrl, attributes) {
  const supportedUris = toArray(attributes["printer-uri-supported"]);
  const printerUri =
    supportedUris[0] ||
    httpUrlToIppUrl(
      new URL(buildPrinterPath(attributes["printer-name"]), baseUrl).toString()
    );
  const printerUrl = ippUriToHttpUrl(printerUri, baseUrl).toString();

  return {
    id: attributes["printer-name"],
    name: attributes["printer-name"],
    info: attributes["printer-info"] || attributes["printer-name"],
    location: attributes["printer-location"] || "",
    makeAndModel: attributes["printer-make-and-model"] || "",
    acceptingJobs: Boolean(attributes["printer-is-accepting-jobs"]),
    state: attributes["printer-state"] || "unknown",
    stateMessage: attributes["printer-state-message"] || "",
    stateReasons: toArray(attributes["printer-state-reasons"]),
    queuedJobCount: attributes["queued-job-count"] || 0,
    documentFormats: toArray(attributes["document-format-supported"]),
    pageRangesSupported: Boolean(attributes["page-ranges-supported"]),
    printerUri,
    printerUrl,
  };
}

function normalizeJob(attributes) {
  return {
    id: attributes["job-id"],
    name: attributes["job-name"] || `job-${attributes["job-id"]}`,
    user: attributes["job-originating-user-name"] || "",
    printerUri: attributes["job-printer-uri"] || "",
    state: attributes["job-state"] || "unknown",
    stateReasons: toArray(attributes["job-state-reasons"]),
    timeAtCreation: attributes["time-at-creation"] || null,
    timeAtProcessing: attributes["time-at-processing"] || null,
    timeAtCompleted: attributes["time-at-completed"] || null,
  };
}

async function listPrinters(config) {
  const rootUrl = new URL("/", config.cupsServerUrl);
  const printer = createPrinter(rootUrl);
  printer.url.rejectUnauthorized = config.cupsTlsRejectUnauthorized;
  const response = await execute(printer, "CUPS-Get-Printers", {
    "operation-attributes-tag": {
      "requested-attributes": REQUESTED_PRINTER_ATTRIBUTES,
      limit: 200,
    },
  });
  const groups = toArray(response["printer-attributes-tag"]);

  return groups
    .filter((group) => group && group["printer-name"])
    .map((group) => normalizePrinter(config.cupsServerUrl, group))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function getJobs(config, printerName) {
  const printerUrl = new URL(buildPrinterPath(printerName), config.cupsServerUrl);
  const printer = createPrinter(printerUrl);
  printer.url.rejectUnauthorized = config.cupsTlsRejectUnauthorized;
  const response = await execute(printer, "Get-Jobs", {
    "operation-attributes-tag": {
      "requested-attributes": REQUESTED_JOB_ATTRIBUTES,
      "which-jobs": "not-completed",
      "my-jobs": false,
    },
  });
  const groups = toArray(response["job-attributes-tag"]);

  return groups
    .filter((group) => group && typeof group["job-id"] !== "undefined")
    .map(normalizeJob)
    .sort((left, right) => right.id - left.id);
}

async function printFile(config, printerName, file) {
  const printerUrl = new URL(buildPrinterPath(printerName), config.cupsServerUrl);
  const printer = createPrinter(printerUrl);
  printer.url.rejectUnauthorized = config.cupsTlsRejectUnauthorized;
  const detectedMimeType =
    mime.lookup(file.originalname) || "application/octet-stream";
  const copies = Number.parseInt(file.copies, 10);
  const jobAttributes = {};

  if (Number.isInteger(copies) && copies > 1) {
    jobAttributes.copies = copies;
  }

  if (Array.isArray(file.pageRanges) && file.pageRanges.length > 0) {
    jobAttributes["page-ranges"] = file.pageRanges;
  }

  const message = {
    "operation-attributes-tag": {
      "requesting-user-name":
        file.requestingUser || config.defaultRequestingUser,
      "job-name": file.jobName || file.originalname,
      "document-format": detectedMimeType,
    },
    data: file.buffer,
  };

  if (Object.keys(jobAttributes).length > 0) {
    message["job-attributes-tag"] = jobAttributes;
  }

  const response = await execute(printer, "Print-Job", message);

  return {
    jobId: response["job-attributes-tag"]?.["job-id"] || null,
    status: response.statusCode || "successful-ok",
    printerName,
    documentFormat: detectedMimeType,
  };
}

async function cancelJob(config, printerName, jobId) {
  const printerUrl = new URL(buildPrinterPath(printerName), config.cupsServerUrl);
  const printer = createPrinter(printerUrl);
  printer.url.rejectUnauthorized = config.cupsTlsRejectUnauthorized;

  await execute(printer, "Cancel-Job", {
    "operation-attributes-tag": {
      "job-id": Number.parseInt(jobId, 10),
    },
  });

  return {
    jobId: Number.parseInt(jobId, 10),
    printerName,
    status: "canceled",
  };
}

module.exports = {
  buildPrinterPath,
  getJobs,
  listPrinters,
  printFile,
  cancelJob,
  httpUrlToIppUrl,
  ippUriToHttpUrl,
};
