require("dotenv").config({ quiet: true });

const path = require("path");

function normalizeBaseUrl(rawValue) {
  if (!rawValue) {
    throw new Error("CUPS_SERVER_URL is required.");
  }

  const withScheme = /^https?:\/\//i.test(rawValue)
    ? rawValue
    : `http://${rawValue}`;
  const url = new URL(withScheme);

  if (!url.port) {
    url.port = "631";
  }

  url.pathname = "/";
  url.search = "";
  url.hash = "";

  return url;
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toBoolean(value, fallback) {
  if (typeof value === "undefined") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function redactUrl(url) {
  const clone = new URL(url.toString());

  if (clone.password) {
    clone.password = "***";
  }

  return clone.toString();
}

const PROJECT_ROOT = path.resolve(__dirname, "..");

function getConfig() {
  const cupsServerUrl = normalizeBaseUrl(process.env.CUPS_SERVER_URL);
  const sofficeTimeoutMs = toPositiveInt(process.env.SOFFICE_TIMEOUT_MS, 60000);

  return {
    host: process.env.HOST || "0.0.0.0",
    port: toPositiveInt(process.env.PORT, 3000),
    uploadLimitBytes:
      toPositiveInt(process.env.UPLOAD_LIMIT_MB, 25) * 1024 * 1024,
    defaultRequestingUser:
      process.env.DEFAULT_REQUESTING_USER || "web-printer",
    cupsTlsRejectUnauthorized: toBoolean(
      process.env.CUPS_TLS_REJECT_UNAUTHORIZED,
      true
    ),
    sofficeBin: process.env.SOFFICE_BIN || "soffice",
    sofficeTimeoutMs,
    shutdownGraceMs: toPositiveInt(process.env.SHUTDOWN_GRACE_MS, 10000),
    previewRetentionMs:
      toPositiveInt(process.env.PREVIEW_TTL_MINUTES, 60) * 60 * 1000,
    cupsServerUrl,
    uploadDir: path.join(PROJECT_ROOT, "tmp-uploads"),
    previewDir: path.join(PROJECT_ROOT, "tmp-previews"),
  };
}

module.exports = {
  getConfig,
  normalizeBaseUrl,
  redactUrl,
};
