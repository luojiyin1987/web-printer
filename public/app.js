const state = {
  printers: [],
  selectedPrinter: null,
  previewUrl: null,
  officePreviewAvailable: false,
  previewToken: 0,
};

const dom = {
  cupsServer: document.querySelector("#cups-server"),
  printerCount: document.querySelector("#printer-count"),
  printerList: document.querySelector("#printer-list"),
  printerSelect: document.querySelector("#printer-select"),
  refreshPrinters: document.querySelector("#refresh-printers"),
  refreshJobs: document.querySelector("#refresh-jobs"),
  jobList: document.querySelector("#job-list"),
  printForm: document.querySelector("#print-form"),
  printMessage: document.querySelector("#print-message"),
  submitButton: document.querySelector("#submit-button"),
  documentInput: document.querySelector("#document"),
  previewPanel: document.querySelector("#preview-panel"),
  pageRanges: document.querySelector("#page-ranges"),
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return (
      {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char] || char
    );
  });
}

function badgeKindFromState(stateValue) {
  if (stateValue === "processing") {
    return "warn";
  }

  if (stateValue === "stopped" || stateValue === "aborted") {
    return "danger";
  }

  return "";
}

function setMessage(text, isError = false) {
  dom.printMessage.textContent = text;
  dom.printMessage.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function getSelectedPrinter() {
  return state.printers.find((printer) => printer.name === state.selectedPrinter) || null;
}

function syncPrintOptions() {
  const printer = getSelectedPrinter();
  const pageRangesSupported = Boolean(printer?.pageRangesSupported);

  dom.pageRanges.disabled = !pageRangesSupported;

  if (pageRangesSupported) {
    dom.pageRanges.placeholder = "例如 1-3,5,8-10";
    return;
  }

  dom.pageRanges.value = "";
  dom.pageRanges.placeholder = "当前打印机不支持页面范围";
}

function revokePreviewUrl() {
  if (state.previewUrl) {
    URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
  }
}

function clearPreview(message) {
  state.previewToken += 1;
  revokePreviewUrl();
  dom.previewPanel.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function getFileExtension(fileName) {
  const parts = String(fileName || "").toLowerCase().split(".");
  return parts.length > 1 ? `.${parts.pop()}` : "";
}

function isOfficeDocument(file) {
  if (!(file instanceof File)) {
    return false;
  }

  return [
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
  ].includes(getFileExtension(file.name));
}

async function renderOfficePreview(file) {
  if (!state.officePreviewAvailable) {
    clearPreview("服务器没有可用的 LibreOffice headless，Office 文件暂时无法预览。");
    return;
  }

  const token = ++state.previewToken;
  dom.previewPanel.innerHTML =
    '<div class="empty-state">正在把 Office 文件转换成 PDF 预览...</div>';

  const formData = new FormData();
  formData.append("document", file);

  try {
    const payload = await requestJson("/api/previews", {
      method: "POST",
      body: formData,
    });

    if (token !== state.previewToken) {
      return;
    }

    dom.previewPanel.innerHTML = `
      <iframe
        class="preview-frame"
        src="${escapeHtml(payload.url)}#toolbar=1&navpanes=0"
        title="Office PDF preview"
      ></iframe>
    `;
  } catch (error) {
    if (token !== state.previewToken) {
      return;
    }

    clearPreview(
      error.message || "Office 文件预览失败。请确认服务端已安装 LibreOffice。"
    );
  }
}

function renderPreview(file) {
  state.previewToken += 1;

  if (!(file instanceof File) || file.size === 0) {
    clearPreview("选择文件后，这里会显示预览。");
    return;
  }

  revokePreviewUrl();
  state.previewUrl = URL.createObjectURL(file);

  if (file.type === "application/pdf") {
    dom.previewPanel.innerHTML = `
      <iframe
        class="preview-frame"
        src="${escapeHtml(state.previewUrl)}#toolbar=1&navpanes=0"
        title="PDF preview"
      ></iframe>
    `;
    return;
  }

  if (file.type.startsWith("image/")) {
    dom.previewPanel.innerHTML = `
      <div class="preview-image-wrap">
        <img class="preview-image" src="${escapeHtml(state.previewUrl)}" alt="${escapeHtml(
          file.name
        )}" />
      </div>
    `;
    return;
  }

  if (isOfficeDocument(file)) {
    revokePreviewUrl();
    renderOfficePreview(file).catch(handleError);
    return;
  }

  dom.previewPanel.innerHTML = `
    <div class="preview-meta">
      <div class="preview-name">${escapeHtml(file.name)}</div>
      <div class="preview-note">这个文件类型暂不做浏览器内预览，但仍可直接提交到 CUPS 打印。</div>
      <div class="preview-note">MIME: ${escapeHtml(file.type || "unknown")}</div>
      <div class="preview-note">Size: ${escapeHtml(String(file.size))} bytes</div>
    </div>
  `;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }

  return payload;
}

function renderPrinterSelect() {
  if (state.printers.length === 0) {
    dom.printerSelect.innerHTML = '<option value="">暂无打印机</option>';
    return;
  }

  dom.printerSelect.innerHTML = state.printers
    .map((printer) => {
      const selected = printer.name === state.selectedPrinter ? "selected" : "";
      return `<option value="${escapeHtml(printer.name)}" ${selected}>${escapeHtml(
        printer.name
      )}</option>`;
    })
    .join("");
}

function renderPrinters() {
  dom.printerCount.textContent = String(state.printers.length);

  if (state.printers.length === 0) {
    dom.printerList.innerHTML =
      '<div class="empty-state">没有从远程 CUPS 读取到共享打印机。</div>';
    return;
  }

  dom.printerList.innerHTML = state.printers
    .map((printer) => {
      const badgeKind = badgeKindFromState(printer.state);
      const activeClass =
        printer.name === state.selectedPrinter ? "printer-card active" : "printer-card";
      const formats =
        printer.documentFormats && printer.documentFormats.length > 0
          ? printer.documentFormats.slice(0, 4).join(", ")
          : "server filters";

      return `
        <article class="${activeClass}" data-printer-name="${escapeHtml(printer.name)}">
          <div class="card-top">
            <div>
              <h3 class="card-title">${escapeHtml(printer.name)}</h3>
              <p class="card-subtitle">${escapeHtml(printer.info || "")}</p>
            </div>
            <span class="badge ${badgeKind}">${escapeHtml(printer.state)}</span>
          </div>
          <div class="meta-row">
            <span>Location: ${escapeHtml(printer.location || "-")}</span>
            <span>Queue: ${escapeHtml(String(printer.queuedJobCount))}</span>
            <span>${printer.acceptingJobs ? "Accepting jobs" : "Paused"}</span>
            <span>${printer.pageRangesSupported ? "Page ranges" : "Full document only"}</span>
          </div>
          <div class="meta-row">
            <span>Formats: ${escapeHtml(formats)}</span>
          </div>
        </article>
      `;
    })
    .join("");

  dom.printerList.querySelectorAll("[data-printer-name]").forEach((element) => {
    element.addEventListener("click", () => {
      state.selectedPrinter = element.dataset.printerName;
      renderPrinterSelect();
      renderPrinters();
      loadJobs().catch(handleError);
    });
  });
}

function renderJobs(jobs) {
  if (!state.selectedPrinter) {
    dom.jobList.innerHTML =
      '<div class="empty-state">先选择一个打印机，再查看队列任务。</div>';
    return;
  }

  if (jobs.length === 0) {
    dom.jobList.innerHTML =
      '<div class="empty-state">当前没有未完成任务。</div>';
    return;
  }

  dom.jobList.innerHTML = jobs
    .map((job) => {
      const badgeKind = badgeKindFromState(job.state);
      const reasons =
        job.stateReasons && job.stateReasons.length > 0
          ? job.stateReasons.join(", ")
          : "-";

      return `
        <article class="job-card">
          <div class="card-top">
            <div>
              <h3 class="card-title">#${escapeHtml(String(job.id))} ${escapeHtml(job.name)}</h3>
              <p class="card-subtitle">User: ${escapeHtml(job.user || "-")}</p>
            </div>
            <span class="badge ${badgeKind}">${escapeHtml(job.state)}</span>
          </div>
          <div class="meta-row">
            <span>Reasons: ${escapeHtml(reasons)}</span>
          </div>
          <div class="meta-row">
            <button class="job-action" data-kind="danger" data-job-id="${escapeHtml(
              String(job.id)
            )}" type="button">
              取消任务
            </button>
          </div>
        </article>
      `;
    })
    .join("");

  dom.jobList.querySelectorAll("[data-job-id]").forEach((button) => {
    button.addEventListener("click", () => {
      cancelJob(button.dataset.jobId).catch(handleError);
    });
  });
}

async function loadConfig() {
  const payload = await requestJson("/api/config");
  dom.cupsServer.textContent = payload.cupsServer;
  state.officePreviewAvailable = Boolean(payload.officePreviewAvailable);
}

async function loadPrinters() {
  const payload = await requestJson("/api/printers");
  state.printers = payload.printers || [];

  if (
    !state.selectedPrinter ||
    !state.printers.some((printer) => printer.name === state.selectedPrinter)
  ) {
    state.selectedPrinter = state.printers[0]?.name || null;
  }

  renderPrinterSelect();
  renderPrinters();
  syncPrintOptions();
  await loadJobs();
}

async function loadJobs() {
  if (!state.selectedPrinter) {
    renderJobs([]);
    return;
  }

  const payload = await requestJson(
    `/api/printers/${encodeURIComponent(state.selectedPrinter)}/jobs`
  );
  renderJobs(payload.jobs || []);
}

async function submitPrint(event) {
  event.preventDefault();

  if (!state.selectedPrinter) {
    setMessage("没有可用打印机。", true);
    return;
  }

  const formData = new FormData(dom.printForm);
  const documentFile = formData.get("document");

  if (!(documentFile instanceof File) || documentFile.size === 0) {
    setMessage("请选择要打印的文件。", true);
    return;
  }

  dom.submitButton.disabled = true;
  setMessage("正在提交打印任务...");

  try {
    const payload = await requestJson(
      `/api/printers/${encodeURIComponent(state.selectedPrinter)}/print`,
      {
        method: "POST",
        body: formData,
      }
    );
    setMessage(
      `已提交到 ${payload.printerName}，job id: ${payload.jobId ?? "unknown"}${
        payload.pageRangesText ? `，范围: ${payload.pageRangesText}` : ""
      }`
    );
    dom.printForm.reset();
    document.querySelector("#copies").value = "1";
    syncPrintOptions();
    clearPreview("选择文件后，这里会显示预览。");
    await loadJobs();
  } finally {
    dom.submitButton.disabled = false;
  }
}

async function cancelJob(jobId) {
  if (!state.selectedPrinter) {
    return;
  }

  await requestJson(
    `/api/printers/${encodeURIComponent(state.selectedPrinter)}/jobs/${encodeURIComponent(
      jobId
    )}/cancel`,
    {
      method: "POST",
    }
  );
  await loadJobs();
}

function handleError(error) {
  console.error(error);
  setMessage(error.message || "发生错误。", true);
}

dom.refreshPrinters.addEventListener("click", () => {
  loadPrinters().catch(handleError);
});

dom.refreshJobs.addEventListener("click", () => {
  loadJobs().catch(handleError);
});

dom.printerSelect.addEventListener("change", () => {
  state.selectedPrinter = dom.printerSelect.value;
  renderPrinters();
  syncPrintOptions();
  loadJobs().catch(handleError);
});

dom.printForm.addEventListener("submit", (event) => {
  submitPrint(event).catch(handleError);
});

dom.documentInput.addEventListener("change", () => {
  renderPreview(dom.documentInput.files?.[0]);
});

window.addEventListener("beforeunload", () => {
  revokePreviewUrl();
});

Promise.all([loadConfig(), loadPrinters()]).catch(handleError);
