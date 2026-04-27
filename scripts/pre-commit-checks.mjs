import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { parseDocument } from "yaml";

const MAX_FILE_SIZE_BYTES = 500 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".dockerignore",
  ".env",
  ".example",
  ".gitignore",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".toml",
  ".txt",
  ".yaml",
  ".yml",
]);

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function getCandidateFiles() {
  const filesFlagIndex = process.argv.indexOf("--files");
  if (filesFlagIndex !== -1) {
    return process.argv.slice(filesFlagIndex + 1).filter(Boolean);
  }

  if (process.argv.includes("--all-files")) {
    return git(["ls-files"])
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isTextFile(filePath, buffer) {
  if (TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return true;
  }

  const baseName = path.basename(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(baseName)) {
    return true;
  }

  return !buffer.includes(0);
}

function checkTextFormatting(filePath, text, errors) {
  if (text.includes("\r")) {
    errors.push(`${filePath}: contains CRLF line endings; use LF only.`);
  }

  if (text.length > 0 && !text.endsWith("\n")) {
    errors.push(`${filePath}: missing trailing newline at end of file.`);
  }

  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (/[ \t]+$/.test(line)) {
      errors.push(`${filePath}:${index + 1}: trailing whitespace.`);
    }

    if (/^(<<<<<<<|=======|>>>>>>>)( .*)?$/.test(line)) {
      errors.push(`${filePath}:${index + 1}: unresolved merge conflict marker.`);
    }
  }
}

function checkStructuredFile(filePath, text, errors) {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".json") {
    try {
      JSON.parse(text);
    } catch (error) {
      errors.push(`${filePath}: invalid JSON (${error.message}).`);
    }
    return;
  }

  if (extension === ".yaml" || extension === ".yml") {
    const document = parseDocument(text);
    if (document.errors.length > 0) {
      const message = document.errors.map((error) => error.message).join("; ");
      errors.push(`${filePath}: invalid YAML (${message}).`);
    }
  }
}

function checkPrivateKey(filePath, text, errors) {
  const privateKeyPattern =
    /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/;

  if (privateKeyPattern.test(text)) {
    errors.push(`${filePath}: possible private key detected.`);
  }
}

function main() {
  const errors = [];
  const files = getCandidateFiles();

  for (const filePath of files) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      continue;
    }

    if (stat.size > MAX_FILE_SIZE_BYTES) {
      errors.push(
        `${filePath}: file is ${stat.size} bytes, exceeding ${MAX_FILE_SIZE_BYTES} bytes.`
      );
    }

    const buffer = fs.readFileSync(filePath);
    if (!isTextFile(filePath, buffer)) {
      continue;
    }

    const text = buffer.toString("utf8");
    checkTextFormatting(filePath, text, errors);
    checkStructuredFile(filePath, text, errors);
    checkPrivateKey(filePath, text, errors);
  }

  if (errors.length > 0) {
    console.error("pre-commit checks failed:\n");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`pre-commit checks passed for ${files.length} file(s)`);
}

main();
