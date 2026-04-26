const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { randomUUID } = require("crypto");
const { promisify } = require("util");
const { pathToFileURL } = require("url");

const execFileAsync = promisify(execFile);

const OFFICE_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".odt",
  ".ods",
  ".odp",
  ".rtf",
]);

let cachedSofficeLookup = null;

function getExtension(fileName) {
  return path.extname(fileName || "").toLowerCase();
}

function isOfficeDocument(fileName) {
  return OFFICE_EXTENSIONS.has(getExtension(fileName));
}

async function isSofficeAvailable(config) {
  if (
    cachedSofficeLookup &&
    cachedSofficeLookup.binary === config.sofficeBin
  ) {
    return cachedSofficeLookup.available;
  }

  try {
    await execFileAsync(config.sofficeBin, ["--version"], {
      timeout: 10000,
    });
    cachedSofficeLookup = {
      binary: config.sofficeBin,
      available: true,
    };
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      cachedSofficeLookup = {
        binary: config.sofficeBin,
        available: false,
      };
      return false;
    }

    throw error;
  }
}

async function cleanupOldPreviews(config) {
  const entries = await fs.readdir(config.previewDir, { withFileTypes: true });
  const now = Date.now();

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const target = path.join(config.previewDir, entry.name);

        try {
          const stat = await fs.stat(target);
          if (now - stat.mtimeMs > config.previewRetentionMs) {
            await fs.rm(target, { recursive: true, force: true });
          }
        } catch (_error) {
          return;
        }
      })
  );
}

async function createOfficePreview(config, uploadedFile) {
  if (!uploadedFile) {
    const error = new Error("document is required.");
    error.statusCode = 400;
    throw error;
  }

  if (!isOfficeDocument(uploadedFile.originalname)) {
    const error = new Error(
      "Only Office documents can use server-side conversion preview."
    );
    error.statusCode = 400;
    throw error;
  }

  const available = await isSofficeAvailable(config);
  if (!available) {
    const error = new Error(
      `LibreOffice headless is not available. Install it and ensure '${config.sofficeBin}' is in PATH.`
    );
    error.statusCode = 501;
    throw error;
  }

  const previewId = randomUUID();
  const workDir = path.join(config.previewDir, previewId);
  const sourceName = `source${getExtension(uploadedFile.originalname)}`;
  const sourcePath = path.join(workDir, sourceName);
  const outputDir = path.join(workDir, "out");
  const profileDir = path.join(workDir, "profile");
  const previewPath = path.join(workDir, "preview.pdf");

  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(profileDir, { recursive: true });
  await fs.rename(uploadedFile.path, sourcePath);

  try {
    await execFileAsync(
      config.sofficeBin,
      [
        "--headless",
        "--nologo",
        "--nolockcheck",
        "--nodefault",
        "--norestore",
        `-env:UserInstallation=${pathToFileURL(profileDir).toString()}`,
        "--convert-to",
        "pdf",
        "--outdir",
        outputDir,
        sourcePath,
      ],
      {
        timeout: config.sofficeTimeoutMs,
      }
    );

    const outputEntries = await fs.readdir(outputDir);
    const convertedName = outputEntries.find((entry) =>
      entry.toLowerCase().endsWith(".pdf")
    );

    if (!convertedName) {
      const error = new Error("LibreOffice did not produce a PDF preview.");
      error.statusCode = 500;
      throw error;
    }

    await fs.rename(path.join(outputDir, convertedName), previewPath);
  } catch (error) {
    const normalized =
      error.code === "ETIMEDOUT"
        ? new Error("LibreOffice conversion timed out.")
        : error;
    normalized.statusCode = normalized.statusCode || 500;
    throw normalized;
  } finally {
    await fs.rm(sourcePath, { force: true }).catch(() => {});
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    previewId,
    kind: "pdf",
    generatedFrom: "office",
    url: `/api/previews/${previewId}/file`,
  };
}

async function resolvePreviewFile(config, previewId) {
  if (!/^[a-f0-9-]{36}$/i.test(previewId)) {
    const error = new Error("Invalid preview id.");
    error.statusCode = 400;
    throw error;
  }

  const previewPath = path.join(config.previewDir, previewId, "preview.pdf");

  try {
    await fs.access(previewPath);
  } catch (_error) {
    const error = new Error("Preview not found or expired.");
    error.statusCode = 404;
    throw error;
  }

  return previewPath;
}

module.exports = {
  createOfficePreview,
  isOfficeDocument,
  isSofficeAvailable,
  resolvePreviewFile,
  OFFICE_EXTENSIONS: Array.from(OFFICE_EXTENSIONS),
};
