import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { normalizeBaseUrl } from "../lib/config.js";
import { buildPrinterPath, httpUrlToIppUrl, ippUriToHttpUrl } from "../lib/cups.js";
import { cleanupOldPreviews, isOfficeDocument } from "../lib/preview.js";
import { formatPageRanges, parsePageRanges } from "../lib/print-options.js";

const cupsUrl = normalizeBaseUrl("192.168.1.50");
assert.equal(cupsUrl.toString(), "http://192.168.1.50:631/");

const ippUrl = httpUrlToIppUrl("http://192.168.1.50:631/printers/office");
assert.equal(ippUrl, "ipp://192.168.1.50:631/printers/office");

const httpUrl = ippUriToHttpUrl("ipp://cups.local:631/printers/main", cupsUrl);
assert.equal(httpUrl.toString(), "http://cups.local:631/printers/main");

assert.equal(buildPrinterPath("A4 Color"), "/printers/A4%20Color");
assert.deepEqual(parsePageRanges("1-3,5,7-8"), [
  [1, 3],
  [5, 5],
  [7, 8],
]);
assert.deepEqual(parsePageRanges("3,1-2,2-5"), [[1, 5]]);
assert.equal(formatPageRanges([[1, 3], [5, 5], [7, 8]]), "1-3,5,7-8");
assert.equal(isOfficeDocument("report.docx"), true);
assert.equal(isOfficeDocument("sheet.xlsx"), true);
assert.equal(isOfficeDocument("photo.jpg"), false);
assert.equal(typeof cleanupOldPreviews, "function");

execFileSync(
  process.execPath,
  [
    "scripts/pre-commit-checks.mjs",
    "--files",
    "scripts/pre-commit-checks.mjs",
    "scripts/smoke-test.mjs",
    "package.json",
    "README.md",
    ".husky/pre-commit",
  ],
  {
    stdio: "pipe",
  }
);

console.log("smoke ok");
