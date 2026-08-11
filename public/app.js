const appView = document.querySelector("#app-view");
const pageTitle = document.querySelector("#page-title");
const serverState = document.querySelector("#server-state");
const loginScreen = document.querySelector("#login-screen");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const logisticsPriceModal = document.querySelector("#logistics-price-modal");
const logisticsPriceForm = document.querySelector("#logistics-price-form");
const workflowModal = document.querySelector("#workflow-modal");
const workflowForm = document.querySelector("#workflow-form");
const priceModal = document.querySelector("#price-modal");
const priceModalResults = document.querySelector("#modal-price-results");
const priceModalSearch = document.querySelector("#modal-price-search");
const priceModalPackage = document.querySelector("#modal-price-package");
const manualPriceModal = document.querySelector("#manual-price-modal");
const manualPriceForm = document.querySelector("#manual-price-form");
const documentPreviewModal = document.querySelector("#document-preview-modal");
const documentPreviewBody = document.querySelector("#document-preview-body");
const recordModal = document.querySelector("#record-modal");
const recordModalBody = document.querySelector("#record-modal-body");

const state = {
  bootstrap: null,
  user: null,
  current: null,
  currentMeta: null,
  currentApprovals: [],
  currentVersions: [],
  view: "dashboard",
  priceResults: [],
  pricePageResults: [],
  calculationTimer: null,
  manualPriceForQuotation: false,
  manualPriceReturnModal: false,
  previewTab: "letter",
  activeRabGroupId: "",
  qnBook: { series: "FP", year: new Date().getFullYear(), query: "" },
  qnBookItems: [],
  qnEditItem: null,
  trackingItems: [],
  trackingFilter: { status: "", packageName: "", query: "" },
  logisticsPriceEditCode: "",
  autosaveTimer: null,
  autosaveSaving: false,
  autosaveState: "idle",
  customerEditId: "",
  userEditId: "",
  reportYear: new Date().getFullYear(),
};

const titles = {
  dashboard: "Ringkasan quotation",
  editor: "Buat dan review penawaran",
  history: "Buku Nomor QN",
  tracking: "Tracking progres quotation",
  prices: "Master harga terpusat",
  settings: "Pengaturan aplikasi",
  reports: "Laporan manajemen",
};

const roleLabels = {
  ADMIN: "Administrator",
  LOGISTICS: "Logistik",
  SUPPORT: "Support",
  PRESALES: "Presales",
  OPERATIONS_MANAGER: "Manager Operational",
};

const rupiah = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});
const dateDisplay = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const localDraftPrefix = "mnn-quotation-local-draft";
const rememberedUsernameKey = "mnn-quotation-remembered-username";
const approvalLabels = {
  TECHNICAL: "Teknis",
  PRICE: "Harga",
  MANAGER: "Manager Operational",
};

function localDraftKey() {
  return `${localDraftPrefix}:${state.user?.id || "anonymous"}`;
}

function currentIsLocked() {
  return Boolean(
    state.current?.id &&
      ["SENT", "FOLLOW_UP", "WON", "LOST", "CANCELLED"].includes(
        state.currentMeta?.workflowStatus,
      ),
  );
}

function formatDateTime(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? String(value)
    : new Intl.DateTimeFormat("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(parsed);
}

function updateAutosaveBadge(label, tone = "idle") {
  state.autosaveState = tone;
  const badge = document.querySelector("#autosave-state");
  if (!badge) return;
  badge.className = `autosave-state autosave-${tone}`;
  badge.textContent = label;
}

function persistLocalDraft() {
  if (!state.current || state.current.id || currentIsLocked()) return;
  localStorage.setItem(
    localDraftKey(),
    JSON.stringify({ quotation: state.current, savedAt: new Date().toISOString() }),
  );
  updateAutosaveBadge("Tersimpan di perangkat", "saved");
}

async function autosaveCurrentQuotation() {
  if (
    !state.current?.id ||
    currentIsLocked() ||
    !state.bootstrap?.capabilities?.editQuotations ||
    state.autosaveSaving
  ) {
    return;
  }
  state.autosaveSaving = true;
  updateAutosaveBadge("Menyimpan...", "saving");
  try {
    const result = await api(`/api/quotations/${encodeURIComponent(state.current.id)}`, {
      method: "PUT",
      body: JSON.stringify({ ...state.current, _autosave: true }),
    });
    state.current = result.quotation;
    state.currentMeta = result.meta;
    state.currentApprovals = result.approvals || [];
    state.currentVersions = result.versions || [];
    updateAutosaveBadge(`Tersimpan ${new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`, "saved");
  } catch (error) {
    updateAutosaveBadge("Autosave gagal", "error");
  } finally {
    state.autosaveSaving = false;
  }
}

function scheduleAutosave() {
  window.clearTimeout(state.autosaveTimer);
  if (!state.current || currentIsLocked()) return;
  updateAutosaveBadge("Ada perubahan", "dirty");
  state.autosaveTimer = window.setTimeout(() => {
    if (state.current.id) autosaveCurrentQuotation();
    else persistLocalDraft();
  }, 900);
}

document.querySelector("#today-chip").textContent = dateDisplay.format(new Date());

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatMoney(value) {
  return rupiah.format(Number(value) || 0).replace(/\s/g, " ");
}

function formatNumber(value, digits = 2) {
  return new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: digits,
  }).format(Number(value) || 0);
}

function previewPackageItems(quotation) {
  const grouped = new Map();
  for (const item of quotation.items.filter((candidate) => candidate.active !== false)) {
    const packageName = item.packageName || quotation.packageName;
    grouped.set(packageName, (grouped.get(packageName) ?? 0) + (Number(item.lineTotal) || 0));
  }
  const items = [];
  if (includesPackage(quotation.packageName, "FirePro")) {
    items.push({
      description: "Pengadaan dan pemasangan Sistem Pemadam Kebakaran FirePro",
      amount: grouped.get("FirePro") ?? 0,
    });
  }
  if (includesPackage(quotation.packageName, "PAC")) {
    items.push({
      description: "Pengadaan dan pemasangan Precision Air Conditioning Montair",
      amount: grouped.get("PAC") ?? 0,
    });
  }
  return items;
}

const previewRabDefinitions = [
  { key: "equipment", number: "I", label: "MAIN & SUPPORT EQUIPMENT" },
  { key: "material", number: "II", label: "MATERIAL INSTALASI" },
  { key: "service", number: "III", label: "JASA" },
];

function previewRabSectionKey(item) {
  const combined = `${item.category || ""} ${item.description || ""}`.toLowerCase();
  if (
    /(jasa|service|labour|labor|testing|commission|transport|akomodasi|delivery|freight|supervisi|manpower)/i.test(
      combined,
    )
  ) {
    return "service";
  }
  if (
    /(material instalasi|installation material|pemipaan|piping|drainage|elektrikal|electrical material|ducting|mounting|hanger|refrigerant|humidifier|kabel|cable|pipa|conduit)/i.test(
      combined,
    )
  ) {
    return "material";
  }
  return "equipment";
}

function previewRabSections(quotation) {
  const activeItems = quotation.items.filter(
    (item) => item.active !== false && Number(item.quantity) > 0,
  );
  const groupDefinitions = quotation.rabGroups ?? [];
  const groupById = new Map(groupDefinitions.map((group) => [group.id, group]));
  const normalizedItems = activeItems.map((item) => {
    const quantity = Math.max(0, Number(item.quantity) || 0);
    const unitPrice = Math.max(
      0,
      Number(item.approvedUnitPrice ?? item.computedUnitPrice) || 0,
    );
    const grossTotal = Math.round(quantity * unitPrice);
    const netTotal = Math.max(0, Number(item.lineTotal) || 0);
    const group = groupById.get(item.rabGroupId);
    return {
      description: item.description || item.code || "-",
      unit: item.unit || "unit",
      quantity,
      unitPrice,
      grossTotal,
      netTotal,
      discount: Math.max(0, grossTotal - netTotal),
      groupId: group?.id || "",
      sectionKey: group?.section || previewRabSectionKey(item),
    };
  });
  return previewRabDefinitions
    .map((section) => {
      const items = normalizedItems.filter((item) => item.sectionKey === section.key);
      const groups = groupDefinitions
        .filter((group) => group.section === section.key)
        .map((group) => ({
          id: group.id,
          title: group.title || "",
          items: items.filter((item) => item.groupId === group.id),
        }))
        .filter((group) => group.items.length > 0);
      const ungroupedItems = items.filter((item) => !item.groupId);
      if (ungroupedItems.length) groups.push({ id: "", title: "", items: ungroupedItems });
      return {
        ...section,
        items,
        groups,
        discount: items.reduce((total, item) => total + item.discount, 0),
        subtotal: items.reduce((total, item) => total + item.netTotal, 0),
      };
    })
    .filter((section) => section.items.length > 0);
}

function previewTechnicalSummary(quotation) {
  const details = [];
  if (includesPackage(quotation.packageName, "FirePro")) {
    const aces = quotation.firepro?.aces ?? {};
    const generators = (aces.generators ?? [])
      .filter((item) => Number(item.quantity) > 0)
      .map((item) => `${item.model || item.code || "-"} (${Number(item.quantity)} unit)`)
      .join(", ");
    if (aces.referenceNumber || Number(aces.selectedMass) > 0) {
      details.push(
        `FirePro — ACES ${aces.referenceNumber || "-"}; volume ${formatNumber(aces.calculatedVolume)} m³; selected mass ${formatNumber(aces.selectedMass, 0)} gram${generators ? `; generator ${generators}` : ""}.`,
      );
    }
  }
  if (includesPackage(quotation.packageName, "PAC")) {
    details.push(
      `PAC — model ${quotation.pac?.approvedModel || "-"}; kapasitas ${formatNumber(quotation.pac?.totalCapacity)} kW; heat load ${formatNumber(quotation.pac?.heatLoad)} kW.`,
    );
  }
  return details;
}

function previewDocumentDate(value) {
  const parsed = value ? new Date(value) : new Date();
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(Number.isNaN(parsed.getTime()) ? new Date() : parsed);
}

function customerNoteItems(quotation) {
  const items = Array.isArray(quotation.terms?.noteItems)
    ? quotation.terms.noteItems.filter((item) => String(item?.text || "").trim())
    : [];
  let mainNumber = 0;
  let subNumber = 0;
  return items.map((item) => {
    const level = Number(item.level) === 1 && mainNumber > 0 ? 1 : 0;
    if (level === 0) {
      mainNumber += 1;
      subNumber = 0;
    } else {
      subNumber += 1;
    }
    return {
      text: String(item.text).trim(),
      level,
      label: level === 1 ? `${mainNumber}.${subNumber}.` : `${mainNumber}.`,
    };
  });
}

function splitPreviewNoteColumns(notes) {
  if (notes.length < 7) return [notes, []];
  const groups = [];
  notes.forEach((note) => {
    if (note.level === 0 || !groups.length) groups.push([note]);
    else groups.at(-1).push(note);
  });
  const totalWeight = groups.reduce(
    (sum, group) =>
      sum + group.reduce((weight, note) => weight + 1 + Math.ceil(note.text.length / 85), 0),
    0,
  );
  let weight = 0;
  let splitIndex = 0;
  while (splitIndex < groups.length - 1 && weight < totalWeight / 2) {
    weight += groups[splitIndex].reduce(
      (sum, note) => sum + 1 + Math.ceil(note.text.length / 85),
      0,
    );
    splitIndex += 1;
  }
  return [groups.slice(0, splitIndex).flat(), groups.slice(splitIndex).flat()];
}

function previewNoteColumn(notes) {
  return notes
    .map(
      (note) => `
        <div class="preview-note-row ${note.level ? "is-subnote" : ""}">
          <span>${escapeHtml(note.label)}</span>
          <p>${escapeHtml(note.text)}</p>
        </div>`,
    )
    .join("");
}

function renderLetterPreview(quotation) {
  const packageRows = previewPackageItems(quotation);
  const noteColumns = splitPreviewNoteColumns(customerNoteItems(quotation));
  const addressLines = String(quotation.customer.address || "Alamat Customer")
    .split(/\r?\n/)
    .filter(Boolean);
  return `
    <article class="document-sheet letter-sheet">
      <div class="document-letterhead-space" aria-label="Ruang kosong untuk kop surat"></div>
      <div class="document-topline">
        <span>Jakarta, ${escapeHtml(previewDocumentDate(quotation.date))}</span>
        <span>No. ${escapeHtml(quotation.qn || "Dibuat saat disimpan")}</span>
      </div>
      <div class="document-recipient">
        <strong>${escapeHtml(quotation.customer.name || "Nama Customer")}</strong>
        ${addressLines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
      </div>
      <p class="document-attention">Up. Yth. : <strong>${escapeHtml(quotation.customer.pic || "-")}</strong></p>
      <div class="document-subject">
        <p>Perihal : <strong>Penawaran Harga ${escapeHtml(quotation.packageName)}</strong></p>
        <p><strong>${escapeHtml(quotation.project.name || "Nama project")}</strong></p>
      </div>
      <p>Dengan hormat,</p>
      <p>Sesuai dengan perihal di atas, maka bersama ini kami sampaikan sebagai berikut :</p>
      <table class="preview-letter-table">
        <thead>
          <tr><th>No.</th><th>Deskripsi</th><th>Qty</th><th>Total Harga (Rp.)</th></tr>
        </thead>
        <tbody>
          ${packageRows
            .map(
              (item, index) => `
                <tr>
                  <td>${index + 1}</td>
                  <td>${escapeHtml(item.description)}</td>
                  <td>1 lot</td>
                  <td>${escapeHtml(formatMoney(item.amount))}</td>
                </tr>`,
            )
            .join("")}
          <tr class="preview-total-row">
            <td colspan="3">Total Penawaran</td>
            <td>${escapeHtml(formatMoney(quotation.totals.grandTotal))}</td>
          </tr>
        </tbody>
      </table>
      <div class="preview-terms">
        <strong>Catatan :</strong>
        <div class="preview-note-columns ${noteColumns[1].length ? "is-two-columns" : ""}">
          <div>${previewNoteColumn(noteColumns[0]) || "<p>Belum ada catatan.</p>"}</div>
          ${noteColumns[1].length ? `<div>${previewNoteColumn(noteColumns[1])}</div>` : ""}
        </div>
      </div>
      <p>Demikian surat ini kami sampaikan dan atas perhatian serta kerjasamanya kami mengucapkan terima kasih.</p>
      <div class="preview-signature">
        <p>Hormat kami,</p>
        <strong>${escapeHtml(
          state.bootstrap?.dashboard?.settings?.companyName ||
            "PT. MATUR NUWUN NUSANTARA",
        )}</strong>
        <div></div>
        <p>
          <u>${escapeHtml(state.bootstrap?.dashboard?.settings?.signerName || "-")}</u><br />
          <em>${escapeHtml(state.bootstrap?.dashboard?.settings?.signerTitle || "-")}</em>
        </p>
      </div>
    </article>`;
}

function renderRabPreview(quotation) {
  const sections = previewRabSections(quotation);
  return `
    <article class="document-sheet rab-sheet">
      <header class="preview-rab-heading">
        <span>LAMPIRAN 1</span>
        <h3>DETAIL PENAWARAN / RAB</h3>
        <dl>
          <div><dt>No. Penawaran</dt><dd>${escapeHtml(quotation.qn || "Dibuat saat disimpan")}</dd></div>
          <div><dt>Customer</dt><dd>${escapeHtml(quotation.customer.name || "-")}</dd></div>
          <div><dt>Project</dt><dd>${escapeHtml(quotation.project.name || "-")}</dd></div>
        </dl>
      </header>
      ${previewTechnicalSummary(quotation)
        .map((detail) => `<p class="preview-technical-note">${escapeHtml(detail)}</p>`)
        .join("")}
      <div class="preview-rab-scroll">
        <table class="preview-rab-table">
          <thead>
            <tr>
              <th>No.</th><th>Description</th><th>Unit</th><th>Qty</th>
              <th>Unit Price (Rp.)</th><th>Total (Rp.)</th>
            </tr>
          </thead>
          <tbody>
            ${sections
              .map(
                (section) => `
                  <tr class="preview-section-row">
                    <td>${section.number}.</td><td colspan="5">${escapeHtml(section.label)}</td>
                  </tr>
                  ${section.groups
                    .map(
                      (group, groupIndex) => `
                        ${
                          group.title
                            ? `<tr class="preview-group-row"><td>${groupIndex + 1}.</td><td colspan="5">${escapeHtml(group.title.toUpperCase())}</td></tr>`
                            : ""
                        }
                        ${group.items
                          .map(
                            (item, index) => `
                              <tr>
                                <td>${index + 1}</td>
                                <td>${escapeHtml(item.description)}</td>
                                <td>${escapeHtml(item.unit)}</td>
                                <td>${escapeHtml(formatNumber(item.quantity, 0))}</td>
                                <td>${escapeHtml(formatNumber(item.unitPrice, 0))}</td>
                                <td>${escapeHtml(formatNumber(item.grossTotal, 0))}</td>
                              </tr>`,
                          )
                          .join("")}`,
                    )
                    .join("")}
                  ${
                    section.discount > 0
                      ? `<tr class="preview-subtotal-row"><td colspan="5">Diskon</td><td>(${escapeHtml(formatNumber(section.discount, 0))})</td></tr>`
                      : ""
                  }
                  <tr class="preview-subtotal-row">
                    <td colspan="5">Sub Total ${section.number}</td>
                    <td>${escapeHtml(formatNumber(section.subtotal, 0))}</td>
                  </tr>`,
              )
              .join("")}
            <tr class="preview-grand-row">
              <td colspan="5">Subtotal RAB</td>
              <td>${escapeHtml(formatNumber(quotation.totals.subtotal, 0))}</td>
            </tr>
            <tr class="preview-grand-row">
              <td colspan="5">PPN</td>
              <td>${escapeHtml(formatNumber(quotation.totals.tax, 0))}</td>
            </tr>
            <tr class="preview-grand-row is-final">
              <td colspan="5">Total Penawaran</td>
              <td>${escapeHtml(formatNumber(quotation.totals.grandTotal, 0))}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="preview-rab-caption">
        Nilai pada lampiran ini adalah harga penawaran customer dan sama dengan
        total pada surat penawaran.
      </p>
    </article>`;
}

function renderDocumentPreview() {
  if (!state.current || !documentPreviewBody) return;
  documentPreviewBody.innerHTML =
    state.previewTab === "rab"
      ? renderRabPreview(state.current)
      : renderLetterPreview(state.current);
  documentPreviewModal
    .querySelectorAll("[data-preview-tab]")
    .forEach((button) =>
      button.classList.toggle("is-active", button.dataset.previewTab === state.previewTab),
    );
}

async function openDocumentPreview() {
  const { quotation } = await api("/api/quotations/calculate", {
    method: "POST",
    body: JSON.stringify(state.current),
  });
  state.current = quotation;
  state.previewTab = "letter";
  renderDocumentPreview();
  documentPreviewModal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeDocumentPreview() {
  documentPreviewModal.hidden = true;
  document.body.classList.remove("modal-open");
}

function statusClass(status) {
  if (status === "SIAP DIBUAT") return "status-ready";
  if (status === "PERLU REVIEW") return "status-review";
  if (status === "BELUM SIAP") return "status-blocked";
  return "status-demo";
}

function includesPackage(packageName, target) {
  return packageName === target || packageName === "FirePro + PAC";
}

async function api(url, options = {}) {
  const headers = {
    ...(options.body instanceof FormData
      ? {}
      : { "Content-Type": "application/json" }),
    "X-Requested-With": "MNNQuotationDesk",
    ...options.headers,
  };
  const response = await fetch(url, { ...options, headers });
  const type = response.headers.get("content-type") || "";
  const result = type.includes("application/json")
    ? await response.json()
    : await response.blob();
  if (!response.ok) {
    const error = new Error(result?.error || `Permintaan gagal (${response.status}).`);
    error.result = result;
    error.status = response.status;
    if (response.status === 401 && !url.startsWith("/api/auth/")) {
      showLogin("Sesi Anda berakhir. Silakan masuk kembali.");
    }
    throw error;
  }
  return result;
}

function showLogin(message = "") {
  enhancePasswordControls(loginForm);
  concealPasswordFields(loginForm);
  loginScreen.hidden = false;
  loginError.hidden = !message;
  loginError.textContent = message;
  document.body.classList.add("login-required");
  const rememberedUsername = localStorage.getItem(rememberedUsernameKey) || "";
  const usernameInput = loginForm.querySelector('input[name="username"]');
  const rememberInput = loginForm.querySelector('input[name="rememberMe"]');
  if (rememberedUsername && !usernameInput.value) usernameInput.value = rememberedUsername;
  if (rememberInput) rememberInput.checked = Boolean(rememberedUsername);
  window.setTimeout(() => {
    const target = rememberedUsername
      ? loginForm.querySelector('input[name="password"]')
      : usernameInput;
    target?.focus();
  }, 50);
}

function enhancePasswordControls(root = document) {
  root.querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.closest(".password-input-wrap")) return;
    const wrapper = document.createElement("div");
    wrapper.className = "password-input-wrap";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.append(input);
    const label = input.closest("label")?.querySelector("span")?.textContent?.trim() || "password";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "password-visibility-button";
    button.dataset.togglePassword = "";
    button.dataset.passwordLabel = label;
    button.setAttribute("aria-label", `Lihat ${label.toLowerCase()}`);
    button.setAttribute("aria-pressed", "false");
    button.textContent = "Lihat";
    wrapper.append(button);
  });
}

function concealPasswordFields(root = document) {
  root.querySelectorAll(".password-input-wrap").forEach((wrapper) => {
    const input = wrapper.querySelector("input");
    const button = wrapper.querySelector("[data-toggle-password]");
    if (!input || !button) return;
    input.type = "password";
    button.textContent = "Lihat";
    button.setAttribute("aria-pressed", "false");
    button.setAttribute(
      "aria-label",
      `Lihat ${(button.dataset.passwordLabel || "password").toLowerCase()}`,
    );
    wrapper.classList.remove("is-visible");
  });
}

function applyRoleUi() {
  const user = state.user;
  document.querySelector("#user-name").textContent = user?.displayName || "Pengguna";
  document.querySelector("#user-role").textContent = roleLabels[user?.role] || user?.role || "Divisi";
  document.querySelector("#user-avatar").textContent = (user?.displayName || "M").trim().charAt(0).toUpperCase();
  document.querySelectorAll("[data-roles]").forEach((element) => {
    const roles = String(element.dataset.roles || "").split(",");
    element.hidden = !roles.includes(user?.role);
  });
}

async function loadWorkspace() {
  state.bootstrap = await api("/api/bootstrap");
  state.user = state.bootstrap.user;
  applyRoleUi();
  loginScreen.hidden = true;
  document.body.classList.remove("login-required");
  serverState.textContent = "Server aktif";
  document.querySelector(".pulse-dot").classList.add("is-online");
  renderDashboard();
  if (state.user.mustChangePassword) {
    toast("Password awal masih aktif", "Buka Pengaturan dan ganti password akun divisi.", "error");
  }
}

function toast(title, message = "", type = "success") {
  const container = document.querySelector("#toast-stack");
  const element = document.createElement("div");
  element.className = `toast ${type === "error" ? "is-error" : ""}`;
  element.innerHTML = `<strong>${escapeHtml(title)}</strong>${
    message ? `<small>${escapeHtml(message)}</small>` : ""
  }`;
  container.append(element);
  window.setTimeout(() => element.remove(), 4300);
}

function openRecordModal({ eyebrow = "DETAIL", title = "Detail catatan", subtitle = "", body = "" }) {
  document.querySelector("#record-modal-eyebrow").textContent = eyebrow;
  document.querySelector("#record-modal-title").textContent = title;
  document.querySelector("#record-modal-subtitle").textContent = subtitle;
  recordModalBody.innerHTML = body;
  recordModal.hidden = false;
  recordModal.querySelector("[data-close-record-modal]")?.focus();
}

function closeRecordModal() {
  recordModal.hidden = true;
  recordModalBody.innerHTML = "";
}

function setLoading(message = "Memuat data...") {
  appView.innerHTML = `
    <div class="loading-state">
      <div class="loading-mark"></div>
      <p>${escapeHtml(message)}</p>
    </div>`;
}

function changeView(view, options = {}) {
  state.view = view;
  pageTitle.textContent = titles[view] || titles.dashboard;
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
  document.body.classList.remove("menu-open");
  if (view === "dashboard") renderDashboard();
  if (view === "editor") {
    if (options.newQuotation || !state.current) createNewQuotation();
    else renderEditor();
  }
  if (view === "history") renderHistory();
  if (view === "tracking") renderTracking();
  if (view === "prices") renderPrices();
  if (view === "settings") renderSettings();
  if (view === "reports") renderReports();
  appView.focus({ preventScroll: true });
}

function recentQuotationMarkup(item) {
  const canDeleteDraft = state.bootstrap.capabilities.editQuotations && item.validationStatus !== "SIAP DIBUAT";
  const canDuplicate = state.bootstrap.capabilities.editQuotations;
  return `
    <article class="quotation-row" data-open-quotation="${escapeHtml(item.id)}">
      <div>
        <strong>${escapeHtml(item.qn)}</strong>
        <small>${escapeHtml(item.packageName)}</small>
      </div>
      <div>
        <strong>${escapeHtml(item.customerName || "Customer belum diisi")}</strong>
        <small>${escapeHtml(item.projectName || "Project belum diisi")}</small>
      </div>
      <span class="status-badge ${statusClass(item.validationStatus)}">${escapeHtml(item.validationStatus)}</span>
      <strong class="money-cell">${formatMoney(item.grandTotal)}</strong>
      <div class="quotation-row-actions">
        ${canDuplicate ? `<button class="quotation-delete-button" type="button" data-duplicate-quotation="${escapeHtml(item.id)}">Duplikat</button>` : ""}
        <span class="row-arrow">→</span>
        ${
          canDeleteDraft
            ? `<button class="quotation-delete-button" type="button" data-delete-draft="${escapeHtml(item.id)}" data-delete-draft-qn="${escapeHtml(item.qn)}" aria-label="Hapus draft ${escapeHtml(item.qn)}">Hapus draft</button>`
            : ""
        }
      </div>
    </article>`;
}

function renderDashboard() {
  const dashboard = state.bootstrap.dashboard;
  const quote = dashboard.quotationStats;
  const prices = dashboard.priceStats;
  const workflow = dashboard.workflowStats || {};
  const reviewCount = Number(quote.review || 0) + Number(quote.blocked || 0);
  const openProgress = ["DRAFT", "WAITING_PRICE", "CALCULATION", "INTERNAL_REVIEW", "SENT", "FOLLOW_UP"]
    .reduce((total, status) => total + Number(workflow[status] || 0), 0);
  appView.innerHTML = `
    <div class="view-enter">
      <section class="hero-panel">
        <div class="hero-copy">
          <span class="eyebrow">CONTROL DESK • FIREPRO + PAC</span>
          <h1>Penawaran lebih cepat, jejak keputusan tetap jelas.</h1>
          <p>
            Satu tempat untuk identitas customer, engineering, harga, validasi,
            riwayat revisi, serta ekspor Word dan PDF sesuai standar kantor.
          </p>
          <div class="hero-actions">
            ${state.bootstrap.capabilities.editQuotations ? `<button class="button button-amber" data-new-quotation>Buat quotation baru</button>` : ""}
            <button class="button button-ghost" data-view-jump="tracking">Pantau progres</button>
            ${state.bootstrap.capabilities.manageLogisticsPrices ? `<button class="button button-ghost" data-view-jump="prices">Kelola harga</button>` : ""}
          </div>
        </div>
        <div class="hero-side">
          <span class="hero-side-label">STATUS HARI INI</span>
          <strong>${reviewCount} perlu perhatian</strong>
          <p>
            ${Number(prices.review || 0)} item harga masih perlu review.
            ${Number(prices.manual || 0)} di antaranya merupakan harga manual Support
            yang menunggu verifikasi Logistik.
          </p>
        </div>
      </section>

      <div class="section-heading">
        <h2>Ringkasan operasional</h2>
        <p>Angka di bawah berasal dari database lokal aplikasi, bukan tampilan contoh statis.</p>
      </div>
      <section class="kpi-grid">
        <article class="kpi-card" data-index="01">
          <span>Total quotation</span>
          <strong>${Number(quote.total || 0)}</strong>
          <small>Tersimpan dan dapat dibuka ulang</small>
        </article>
        <article class="kpi-card" data-index="02">
          <span>Siap dibuat</span>
          <strong>${Number(quote.ready || 0)}</strong>
          <small>Lolos pemeriksaan tanpa peringatan</small>
        </article>
        <article class="kpi-card" data-index="03">
          <span>Nilai quotation</span>
          <strong>${formatMoney(quote.value || 0)}</strong>
          <small>Akumulasi total customer</small>
        </article>
        <article class="kpi-card" data-index="04">
          <span>Progres aktif</span>
          <strong>${openProgress}</strong>
          <small>${Number(workflow.WAITING_PRICE || 0)} sedang menunggu harga</small>
        </article>
      </section>

      <div class="section-heading">
        <h2>Aktivitas terakhir</h2>
        <p>Buka kembali quotation untuk revisi, pemeriksaan, atau ekspor ulang.</p>
      </div>
      <section class="content-grid">
        <div class="panel">
          <header class="panel-header">
            <h3>Quotation terbaru</h3>
            <button class="button button-small button-secondary" data-view-jump="history">Semua riwayat</button>
          </header>
          <div class="quotation-list">
            ${
              dashboard.recent.length
                ? dashboard.recent.map(recentQuotationMarkup).join("")
                : `<div class="empty-panel"><strong>Belum ada quotation</strong>Mulai dari quotation pertama Anda.</div>`
            }
          </div>
        </div>
        <aside class="panel risk-card">
          <span class="eyebrow">PAGAR PENGAMAN</span>
          <h3>Yang tidak boleh dilewati</h3>
          <ul class="risk-list">
            <li>Jumlah dan model FirePro tetap mengikuti ACES serta approval engineering.</li>
            <li>Kapasitas PAC harus mencukupi heat load dan model wajib disetujui.</li>
            <li>Harga manual boleh dipakai, tetapi sumber dan bukti wajib dicatat.</li>
            <li>Override harga harus memiliki alasan yang dapat diaudit.</li>
            <li>Dokumen DEMO selalu membawa tanda DRAFT.</li>
          </ul>
        </aside>
      </section>
    </div>`;
}

function createNewQuotation() {
  const stored = localStorage.getItem(localDraftKey());
  let recovered = null;
  if (stored) {
    try {
      recovered = JSON.parse(stored);
    } catch {
      localStorage.removeItem(localDraftKey());
    }
  }
  state.current = recovered?.quotation || structuredClone(state.bootstrap.emptyQuotation);
  state.current.id = null;
  state.current.qn = "";
  state.currentMeta = null;
  state.currentApprovals = [];
  state.currentVersions = [];
  state.activeRabGroupId = "";
  if (!recovered) {
    state.current.date = new Date().toISOString().slice(0, 10);
    state.current.firepro.rooms = [
      {
        name: "",
        length: 0,
        width: 0,
        height: 0,
        raisedFloor: 0,
        falseCeiling: 0,
        fireClass: 46,
        safetyFactor: 1.3,
      },
    ];
  }
  renderEditor();
  if (recovered) {
    updateAutosaveBadge(`Draft dipulihkan - ${formatDateTime(recovered.savedAt)}`, "saved");
    toast("Draft belum tersimpan dipulihkan", "Lanjutkan pekerjaan atau pilih Buang draft lokal.");
  }
}

function field(label, path, value, options = {}) {
  const type = options.type || "text";
  const column = options.column || "col-4";
  const attributes = [
    `data-path="${escapeHtml(path)}"`,
    `type="${escapeHtml(type)}"`,
    options.step ? `step="${escapeHtml(options.step)}"` : "",
    options.min != null ? `min="${escapeHtml(options.min)}"` : "",
    options.maxlength != null
      ? `maxlength="${escapeHtml(options.maxlength)}"`
      : "",
    options.pattern ? `pattern="${escapeHtml(options.pattern)}"` : "",
    options.placeholder
      ? `placeholder="${escapeHtml(options.placeholder)}"`
      : "",
    options.readonly ? "readonly" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `
    <label class="field ${column} ${options.warning ? "field-warn" : ""}">
      <span>${escapeHtml(label)}</span>
      ${
        options.textarea
          ? `<textarea data-path="${escapeHtml(path)}" ${options.placeholder ? `placeholder="${escapeHtml(options.placeholder)}"` : ""}>${escapeHtml(value)}</textarea>`
          : `<input ${attributes} value="${escapeHtml(value ?? "")}" />`
      }
      ${options.help ? `<small>${escapeHtml(options.help)}</small>` : ""}
    </label>`;
}

function sectionHeader(index, title, description, action = "") {
  return `
    <header class="form-section-header">
      <div class="form-section-title">
        <span class="form-section-index">${index}</span>
        <div>
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(description)}</p>
        </div>
      </div>
      ${action}
    </header>`;
}

function editableNoteLabels(items) {
  let mainNumber = 0;
  let subNumber = 0;
  return items.map((item) => {
    const level = Number(item.level) === 1 && mainNumber > 0 ? 1 : 0;
    if (level === 0) {
      mainNumber += 1;
      subNumber = 0;
    } else {
      subNumber += 1;
    }
    return level === 1 ? `${mainNumber}.${subNumber}` : `${mainNumber}`;
  });
}

function renderCommercialNoteEditor(quotation) {
  const items = Array.isArray(quotation.terms.noteItems)
    ? quotation.terms.noteItems
    : [];
  const labels = editableNoteLabels(items);
  return `
    <div class="terms-note-editor col-12">
      <div class="terms-note-toolbar">
        <div>
          <strong>Catatan yang tampil ke customer</strong>
          <p>Nomor dibuat otomatis. Pilih Subcatatan untuk nomor seperti 2.1, 2.2, dan seterusnya.</p>
        </div>
        <div class="terms-note-actions">
          <button type="button" class="button button-small button-secondary" data-add-note="main">+ Catatan utama</button>
          <button type="button" class="button button-small button-secondary" data-add-note="sub">+ Subcatatan</button>
        </div>
      </div>
      <div class="terms-note-list">
        ${
          items.length
            ? items
                .map(
                  (item, index) => `
                    <article class="terms-note-item ${Number(item.level) === 1 ? "is-subnote" : ""}">
                      <div class="terms-note-number">${escapeHtml(labels[index])}</div>
                      <label class="terms-note-kind">
                        <span>Jenis</span>
                        <select data-note-index="${index}" data-note-field="level">
                          <option value="0" ${Number(item.level) === 1 ? "" : "selected"}>Catatan utama</option>
                          <option value="1" ${Number(item.level) === 1 ? "selected" : ""}>Subcatatan</option>
                        </select>
                      </label>
                      <label class="terms-note-text">
                        <span>Isi catatan</span>
                        <textarea data-note-index="${index}" data-note-field="text" placeholder="Ketik ketentuan penawaran...">${escapeHtml(item.text)}</textarea>
                      </label>
                      <div class="terms-note-controls" aria-label="Atur catatan ${escapeHtml(labels[index])}">
                        <button type="button" title="Pindah ke atas" data-move-note="-1" data-note-action-index="${index}" ${index === 0 ? "disabled" : ""}>↑</button>
                        <button type="button" title="Pindah ke bawah" data-move-note="1" data-note-action-index="${index}" ${index === items.length - 1 ? "disabled" : ""}>↓</button>
                        <button type="button" class="is-danger" title="Hapus catatan" data-remove-note="${index}">Hapus</button>
                      </div>
                    </article>`,
                )
                .join("")
            : `<div class="terms-note-empty"><strong>Belum ada catatan.</strong><span>Tambahkan catatan utama agar ketentuan muncul pada surat.</span></div>`
        }
      </div>
    </div>`;
}

function packageSegments(current) {
  return `
    <div class="segment-group">
      ${["FirePro", "PAC", "FirePro + PAC"]
        .map(
          (option) => `
          <label class="segment-option">
            <input type="radio" name="packageName" data-package-option value="${option}" ${current === option ? "checked" : ""} />
            <span>${option}</span>
          </label>`,
        )
        .join("")}
    </div>`;
}

function modeSegments(current) {
  return `
    <div class="segment-group">
      ${["DEMO", "PRODUKSI"]
        .map(
          (option) => `
          <label class="segment-option">
            <input type="radio" name="mode" data-mode-option value="${option}" ${current === option ? "checked" : ""} />
            <span>${option}</span>
          </label>`,
        )
        .join("")}
    </div>`;
}

function acesResultClass(result) {
  if (result === "APPROVED") return "status-ready";
  if (result === "LEGACY" || result === "REVIEW") return "status-review";
  return "status-blocked";
}

function acesGeneratorRows(generators) {
  if (!generators.length) {
    return `<tr><td colspan="7"><div class="empty-panel"><strong>Generator belum tercatat</strong>Unggah DOCX ACES atau tambahkan model dan quantity secara manual.</div></td></tr>`;
  }
  return generators
    .map(
      (item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td><input class="table-input" data-aces-generator-index="${index}" data-aces-generator-field="code" value="${escapeHtml(item.code || "")}" /></td>
        <td><input class="table-input table-input-wide" data-aces-generator-index="${index}" data-aces-generator-field="model" value="${escapeHtml(item.model || "")}" /></td>
        <td><input class="table-input number-cell" type="number" min="0" step="0.01" data-aces-generator-index="${index}" data-aces-generator-field="effectiveMass" value="${escapeHtml(item.effectiveMass ?? 0)}" /></td>
        <td><input class="table-input number-cell" type="number" min="0" step="1" data-aces-generator-index="${index}" data-aces-generator-field="quantity" value="${escapeHtml(item.quantity ?? 0)}" /></td>
        <td><input class="table-input number-cell" type="number" min="0" step="0.01" data-aces-generator-index="${index}" data-aces-generator-field="totalConcentration" value="${escapeHtml(item.totalConcentration ?? 0)}" /></td>
        <td><button class="button button-small button-danger" data-remove-aces-generator="${index}">Hapus</button></td>
      </tr>`,
    )
    .join("");
}

function acesElectronicRows(electronics) {
  if (!electronics.length) {
    return `<tr><td colspan="5"><div class="empty-panel"><strong>BOM elektronik belum tersedia</strong>BOM akan terbaca otomatis dari file DOCX ACES.</div></td></tr>`;
  }
  return electronics
    .map(
      (item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td><span class="price-code">${escapeHtml(item.code)}</span></td>
        <td>${escapeHtml(item.description)}</td>
        <td>${escapeHtml(item.category)}</td>
        <td class="number-cell">${formatNumber(item.quantity, 0)}</td>
      </tr>`,
    )
    .join("");
}

function acesAttachmentMarkup(quotation) {
  const attachments = quotation.firepro.acesAttachments ?? [];
  if (!attachments.length) {
    return `<div class="empty-attachment">Belum ada file ACES yang tersimpan.</div>`;
  }
  return attachments
    .map(
      (attachment) => `
      <a class="attachment-chip" href="/api/quotations/${encodeURIComponent(quotation.id)}/aces/${encodeURIComponent(attachment.id)}">
        <span>${escapeHtml(attachment.type || "FILE")}</span>
        <strong>${escapeHtml(attachment.originalName)}</strong>
      </a>`,
    )
    .join("");
}

function fireProSection(quotation) {
  if (!includesPackage(quotation.packageName, "FirePro")) return "";
  const aces = quotation.firepro.aces ?? {};
  const rooms = quotation.firepro.rooms ?? [];
  const rows = rooms
    .map(
      (room, index) => `
      <tr>
        <td>${index + 1}</td>
        <td><input class="table-input table-input-wide" data-room-index="${index}" data-room-field="name" value="${escapeHtml(room.name || "")}" placeholder="Nama ruang / zona" /></td>
        ${["length", "width", "height", "raisedFloor", "falseCeiling"]
          .map(
            (key) => `<td><input class="table-input number-cell" type="number" min="0" step="0.01" data-room-index="${index}" data-room-field="${key}" value="${escapeHtml(room[key] ?? 0)}" /></td>`,
          )
          .join("")}
        <td class="number-cell room-volume" data-room-volume="${index}">${formatNumber(room.totalVolume || 0)}</td>
        <td class="number-cell room-requirement" data-room-requirement="${index}">${formatNumber(room.totalRequirement || 0)}</td>
        <td><button class="button button-small button-danger" data-remove-room="${index}" ${rooms.length <= 1 ? "disabled" : ""}>Hapus</button></td>
      </tr>`,
    )
    .join("");
  const difference = Number(quotation.firepro.acesVolumeDifferencePercent) || 0;
  return `
    <section class="form-section">
      ${sectionHeader(
        "02",
        "Engineering FirePro + hasil ACES",
        "Bandingkan data ruang awal dengan hasil resmi ACES sebelum menentukan penawaran.",
        `<button class="button button-small button-secondary" data-add-room>+ Ruang</button>`,
      )}
      <div class="form-section-body">
        <div class="engineering-callout">
          <div>
            <span class="eyebrow">LANGKAH 1 • DATA AWAL</span>
            <strong>Hitung volume yang akan diproteksi</strong>
            <p>Main room, raised floor, dan false ceiling dipisahkan agar perbedaannya terlihat.</p>
          </div>
          <div class="engineering-metric">
            <span>Total volume awal</span>
            <strong data-firepro-total-volume>${formatNumber(quotation.firepro.totalProtectedVolume)} m³</strong>
          </div>
        </div>
        <div class="data-table-wrap" style="margin-top: 14px">
          <table class="data-table">
            <thead>
              <tr>
                <th>No.</th><th>Ruang / Zona</th><th>P (m)</th><th>L (m)</th>
                <th>T (m)</th><th>RF (m)</th><th>FC (m)</th><th>Total m³</th>
                <th>Kebutuhan (g)</th><th></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>

        <div class="aces-divider">
          <div>
            <span class="eyebrow">LANGKAH 2 • ACES RESMI</span>
            <h4>Unggah hasil dari portal.firepro.com</h4>
            <p>DOCX dibaca otomatis; PDF disimpan sebagai bukti pendamping.</p>
          </div>
          <form class="aces-upload-form" id="aces-import-form">
            <input type="file" name="acesFiles" accept=".docx,.pdf" multiple required />
            <button class="button button-amber" type="submit">Unggah ACES</button>
          </form>
        </div>
        <div class="attachment-list">${acesAttachmentMarkup(quotation)}</div>

        <div class="aces-result-grid">
          <article class="aces-result-card">
            <span>Hasil ACES</span>
            <strong class="status-badge ${acesResultClass(aces.approvalResult)}" data-aces-result-status>${escapeHtml(aces.approvalResult || "BELUM DIISI")}</strong>
          </article>
          <article class="aces-result-card">
            <span>Volume ACES</span>
            <strong>${formatNumber(aces.calculatedVolume)} m³</strong>
          </article>
          <article class="aces-result-card ${Math.abs(difference) > 2 ? "is-warning" : ""}">
            <span>Selisih volume</span>
            <strong data-aces-volume-difference>${difference >= 0 ? "+" : ""}${formatNumber(difference)}%</strong>
          </article>
          <article class="aces-result-card">
            <span>Selected mass</span>
            <strong data-aces-selected-mass>${formatNumber(aces.selectedMass)} g</strong>
          </article>
        </div>

        <div class="form-grid" style="margin-top: 16px">
          ${field("Nomor referensi ACES", "firepro.aces.referenceNumber", aces.referenceNumber, {
            column: "col-5",
            placeholder: "Contoh: CUSTOMER-13706-2026",
          })}
          ${field("Tanggal laporan", "firepro.aces.reportDate", aces.reportDate, {
            column: "col-3",
            placeholder: "July 2026",
          })}
          <label class="field col-4">
            <span>Hasil perhitungan ACES</span>
            <select data-path="firepro.aces.approvalResult">
              ${["", "APPROVED", "REVIEW", "NOT APPROVED"]
                .map(
                  (option) =>
                    `<option value="${option}" ${aces.approvalResult === option ? "selected" : ""}>${option || "Belum diisi"}</option>`,
                )
                .join("")}
            </select>
          </label>
          ${field("Project pada ACES", "firepro.aces.projectName", aces.projectName, {
            column: "col-4",
          })}
          ${field("Nama ruang ACES", "firepro.aces.roomName", aces.roomName, {
            column: "col-4",
          })}
          ${field("Space type", "firepro.aces.spaceType", aces.spaceType, {
            column: "col-4",
          })}
          ${field("Panjang ACES (m)", "firepro.aces.length", aces.length, {
            type: "number", min: 0, step: 0.001, column: "col-2",
          })}
          ${field("Lebar ACES (m)", "firepro.aces.width", aces.width, {
            type: "number", min: 0, step: 0.001, column: "col-2",
          })}
          ${field("Tinggi ACES (m)", "firepro.aces.height", aces.height, {
            type: "number", min: 0, step: 0.001, column: "col-2",
          })}
          ${field("Volume ACES (m³)", "firepro.aces.calculatedVolume", aces.calculatedVolume, {
            type: "number", min: 0, step: 0.0001, column: "col-2",
          })}
          ${field("Required mass (g)", "firepro.aces.requiredMass", aces.requiredMass, {
            type: "number", min: 0, step: 0.01, column: "col-2",
          })}
          ${field("Selected mass (g)", "firepro.aces.selectedMass", aces.selectedMass, {
            type: "number", min: 0, step: 0.01, column: "col-2",
          })}
        </div>

        <div class="subsection-heading">
          <div>
            <h4>Generator terpilih</h4>
            <p>Model dan quantity ini harus sama dengan BOM ACES.</p>
          </div>
          <button class="button button-small button-secondary" data-add-aces-generator>+ Generator</button>
        </div>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead>
              <tr><th>No.</th><th>Kode</th><th>Model</th><th>Mass/unit (g)</th><th>Qty</th><th>Total (g)</th><th></th></tr>
            </thead>
            <tbody>${acesGeneratorRows(aces.generators ?? [])}</tbody>
          </table>
        </div>

        <div class="subsection-heading">
          <div>
            <h4>BOM elektronik ACES</h4>
            <p>Gunakan tombol berikut untuk menarik BOM ke kalkulasi komersial dan mencocokkan master harga.</p>
          </div>
          <button class="button button-small button-primary" data-add-aces-bom ${(aces.generators?.length || aces.electronics?.length) ? "" : "disabled"}>Tambahkan BOM ke komersial</button>
        </div>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead><tr><th>No.</th><th>Kode</th><th>Deskripsi</th><th>Kategori</th><th>Qty</th></tr></thead>
            <tbody>${acesElectronicRows(aces.electronics ?? [])}</tbody>
          </table>
        </div>

        <div class="approval-strip">
          <div>
            <span class="eyebrow">LANGKAH 3 • APPROVAL INTERNAL</span>
            <strong>ACES APPROVED belum sama dengan approval Engineering kantor.</strong>
          </div>
          <label class="field">
            <span>Status approval Engineering</span>
            <select data-path="firepro.approvalStatus">
              ${["Belum disetujui", "Disetujui - engineering", "Disetujui - final"]
                .map(
                  (option) =>
                    `<option ${quotation.firepro.approvalStatus === option ? "selected" : ""}>${option}</option>`,
                )
                .join("")}
            </select>
          </label>
        </div>
      </div>
    </section>`;
}

function pacSection(quotation) {
  if (!includesPackage(quotation.packageName, "PAC")) return "";
  return `
    <section class="form-section">
      ${sectionHeader(
        includesPackage(quotation.packageName, "FirePro") ? "03" : "02",
        "Engineering PAC",
        "Model dan kapasitas ditetapkan berdasarkan heat load serta approval engineering.",
      )}
      <div class="form-section-body">
        <div class="form-grid">
          ${field("Model disetujui", "pac.approvedModel", quotation.pac.approvedModel, {
            column: "col-4",
            placeholder: "Contoh: XOPB2055D",
          })}
          ${field("Heat load (kW)", "pac.heatLoad", quotation.pac.heatLoad, {
            type: "number",
            min: 0,
            step: 0.1,
            column: "col-2",
          })}
          ${field("Total kapasitas (kW)", "pac.totalCapacity", quotation.pac.totalCapacity, {
            type: "number",
            min: 0,
            step: 0.1,
            column: "col-2",
          })}
          ${field("Jumlah unit", "pac.quantity", quotation.pac.quantity, {
            type: "number",
            min: 1,
            step: 1,
            column: "col-2",
          })}
          <label class="field col-2">
            <span>Status approval</span>
            <select data-path="pac.approvalStatus">
              ${["Belum disetujui", "Disetujui - engineering", "Disetujui - final"]
                .map(
                  (option) =>
                    `<option ${quotation.pac.approvalStatus === option ? "selected" : ""}>${option}</option>`,
                )
                .join("")}
            </select>
          </label>
          <label class="field col-4">
            <span>Konfirmasi harga terbaru</span>
            <select data-path="pac.priceConfirmed" data-boolean>
              <option value="false" ${quotation.pac.priceConfirmed ? "" : "selected"}>Belum dikonfirmasi</option>
              <option value="true" ${quotation.pac.priceConfirmed ? "selected" : ""}>Sudah dikonfirmasi</option>
            </select>
            <small>Harga contoh PAC lama selalu memunculkan peringatan.</small>
          </label>
          <div class="field col-8">
            <span>Pemeriksaan kapasitas</span>
            <div class="inline-note" id="pac-capacity-note">
              ${quotation.pac.capacitySufficient ? `Mencukupi dengan margin ${formatNumber(quotation.pac.capacityMargin, 1)} kW.` : "Belum mencukupi heat load."}
            </div>
          </div>
        </div>
      </div>
    </section>`;
}

function itemRows(quotation) {
  if (!quotation.items.length) {
    return `<div class="empty-panel"><strong>Belum ada item komersial</strong>Tambahkan dari master harga atau masukkan item manual.</div>`;
  }
  return quotation.items
    .map(
      (item, index) => `
      <article class="commercial-item-card">
        <header class="commercial-item-head">
          <div class="commercial-item-title">
            <span class="commercial-item-number">ITEM ${String(index + 1).padStart(2, "0")}</span>
            <small class="item-source-line">
              ${escapeHtml(item.source || "Manual")}
              ${
                item.priceOrigin === "MANUAL_SUPPORT" ||
                item.verificationStatus === "PERLU_VERIFIKASI_LOGISTIK"
                  ? `<span class="source-badge is-manual">Perlu verifikasi Logistik</span>`
                  : item.needsReview
                    ? `<span class="source-badge">Review</span>`
                    : ""
              }
            </small>
          </div>
          <div class="commercial-item-total">
            <span>Total item</span>
            <strong data-line-total="${index}">${formatMoney(item.lineTotal)}</strong>
          </div>
          <button class="button button-small button-danger" data-remove-item="${index}" aria-label="Hapus item ${index + 1}">Hapus</button>
        </header>
        <div class="commercial-item-grid">
          <label class="commercial-field commercial-col-12 commercial-rab-group-field">
            <span>Judul area / subbagian RAB</span>
            <select class="table-input" data-item-index="${index}" data-item-field="rabGroupId">
              <option value="">Tanpa subjudul (langsung di bagian utama)</option>
              ${(quotation.rabGroups ?? [])
                .map(
                  (group) =>
                    `<option value="${escapeHtml(group.id)}" ${item.rabGroupId === group.id ? "selected" : ""}>${escapeHtml(rabSectionShortLabel(group.section))} â€¢ ${escapeHtml(group.title || "Judul belum diisi")}</option>`,
                )
                .join("")}
            </select>
          </label>
          <label class="commercial-field commercial-col-2">
            <span>Paket</span>
            <select class="table-input" data-item-index="${index}" data-item-field="packageName">
              ${["FirePro", "PAC"].map((option) => `<option ${item.packageName === option ? "selected" : ""}>${option}</option>`).join("")}
            </select>
          </label>
          <label class="commercial-field commercial-col-2">
            <span>Kode</span>
            <input class="table-input" data-item-index="${index}" data-item-field="code" value="${escapeHtml(item.code || "")}" />
          </label>
          <label class="commercial-field commercial-col-5">
            <span>Deskripsi</span>
            <input class="table-input" data-item-index="${index}" data-item-field="description" value="${escapeHtml(item.description || "")}" />
          </label>
          <label class="commercial-field commercial-col-1">
            <span>Qty</span>
            <input class="table-input number-cell" type="number" min="1" step="1" inputmode="numeric" data-item-index="${index}" data-item-field="quantity" value="${escapeHtml(item.quantity ?? 1)}" />
          </label>
          <label class="commercial-field commercial-col-2">
            <span>Unit</span>
            <input class="table-input" data-item-index="${index}" data-item-field="unit" value="${escapeHtml(item.unit || "unit")}" />
          </label>
          <label class="commercial-field commercial-col-3">
            <span>Harga sumber</span>
            <input class="table-input money-cell" type="number" min="0" step="1" data-item-index="${index}" data-item-field="sourcePrice" value="${escapeHtml(item.sourcePrice ?? 0)}" />
          </label>
          <label class="commercial-field commercial-col-2">
            <span>Markup %</span>
            <input class="table-input number-cell" type="number" min="0" step="1" inputmode="numeric" data-item-index="${index}" data-item-field="markupPercent" value="${escapeHtml(item.markupPercent ?? 0)}" />
          </label>
          <label class="commercial-field commercial-col-3">
            <span>Harga override <em>opsional</em></span>
            <input class="table-input money-cell" type="number" min="0" step="1" data-item-index="${index}" data-item-field="overridePrice" value="${escapeHtml(item.overridePrice ?? "")}" placeholder="Kosongkan bila tidak dipakai" />
          </label>
          <label class="commercial-field commercial-col-4">
            <span>Alasan override</span>
            <input class="table-input" data-item-index="${index}" data-item-field="overrideReason" value="${escapeHtml(item.overrideReason || "")}" placeholder="Wajib hanya jika harga override diisi" />
          </label>
        </div>
      </article>`,
    )
    .join("");
}

function rabSectionShortLabel(section) {
  if (section === "material") return "II Material Instalasi";
  if (section === "service") return "III Jasa";
  return "I Main & Support Equipment";
}

function rabGroupManager(quotation) {
  const groups = quotation.rabGroups ?? [];
  const active = groups.find((group) => group.id === state.activeRabGroupId);
  return `
    <section class="rab-group-manager">
      <header class="rab-group-manager-head">
        <div>
          <span class="eyebrow">STRUKTUR LAMPIRAN RAB</span>
          <strong>Kelompokkan item berdasarkan ruangan atau sistem</strong>
          <p>Contoh: Fire Alarm System (For All Room), Ruang Storage Bins 1, Koridor.</p>
        </div>
        <div class="rab-group-manager-actions">
          ${includesPackage(quotation.packageName, "FirePro") ? `<button type="button" class="button button-small button-secondary" data-import-room-groups>Ambil nama ruang</button>` : ""}
          <button type="button" class="button button-small button-primary" data-add-rab-group>+ Judul RAB</button>
        </div>
      </header>
      <div class="rab-active-group">
        <span>Item baru akan masuk ke</span>
        <strong>${escapeHtml(active?.title || "Tanpa subjudul")}</strong>
        ${active ? `<button type="button" data-clear-active-rab-group>Lepaskan</button>` : ""}
      </div>
      <div class="rab-group-list">
        ${
          groups.length
            ? groups
                .map(
                  (group, index) => `
                    <article class="rab-group-row ${group.id === state.activeRabGroupId ? "is-active" : ""}">
                      <span class="rab-group-order">${index + 1}</span>
                      <label>
                        <span>Bagian utama</span>
                        <select data-rab-group-index="${index}" data-rab-group-field="section">
                          <option value="equipment" ${group.section === "equipment" ? "selected" : ""}>I â€¢ Main &amp; Support Equipment</option>
                          <option value="material" ${group.section === "material" ? "selected" : ""}>II â€¢ Material Instalasi</option>
                          <option value="service" ${group.section === "service" ? "selected" : ""}>III â€¢ Jasa</option>
                        </select>
                      </label>
                      <label class="rab-group-title-field">
                        <span>Judul area / subbagian</span>
                        <input data-rab-group-index="${index}" data-rab-group-field="title" value="${escapeHtml(group.title)}" placeholder="Contoh: RUANG STORAGE BINS 1" />
                      </label>
                      <button type="button" class="rab-group-use" data-use-rab-group="${escapeHtml(group.id)}">${group.id === state.activeRabGroupId ? "Aktif" : "Pakai untuk item baru"}</button>
                      <div class="rab-group-controls">
                        <button type="button" title="Pindah ke atas" data-move-rab-group="-1" data-rab-group-action-index="${index}" ${index === 0 ? "disabled" : ""}>â†‘</button>
                        <button type="button" title="Pindah ke bawah" data-move-rab-group="1" data-rab-group-action-index="${index}" ${index === groups.length - 1 ? "disabled" : ""}>â†“</button>
                        <button type="button" class="is-danger" title="Hapus judul tanpa menghapus item" data-remove-rab-group="${index}">Hapus</button>
                      </div>
                    </article>`,
                )
                .join("")
            : `<div class="rab-group-empty"><strong>Belum ada judul RAB.</strong><span>Item lama tetap tampil seperti biasa sampai Anda membuat pengelompokan.</span></div>`
        }
      </div>
    </section>`;
}

function commercialSection(quotation) {
  const sectionIndex =
    includesPackage(quotation.packageName, "FirePro") &&
    includesPackage(quotation.packageName, "PAC")
      ? "04"
      : "03";
  return `
    <section class="form-section">
      ${sectionHeader(
        sectionIndex,
        "Kalkulasi komersial",
        "Harga dihitung ulang di server; setiap override harus memiliki alasan.",
        `<div class="header-actions">
          <button class="button button-small button-secondary" data-open-price-modal>+ Dari master</button>
          <button class="button button-small button-amber" data-open-manual-price>+ Harga baru</button>
        </div>`,
      )}
      <div class="form-section-body">
        ${rabGroupManager(quotation)}
        <div class="commercial-keyboard-strip keyboard-hint">
          <strong>Mode keyboard</strong>
          <span><kbd>Enter</kbd> kolom berikutnya</span>
          <span><kbd>Shift</kbd> + <kbd>Enter</kbd> kolom sebelumnya</span>
          <span><kbd>Tab</kbd> juga aktif</span>
        </div>
        <div class="commercial-list" id="commercial-items-body">
          ${itemRows(quotation)}
        </div>
        <div class="table-actions">
          <span class="table-meta">${quotation.items.length} item • perhitungan server-side</span>
          <button class="button button-small button-ghost" data-add-custom-item>+ Item bebas (review)</button>
        </div>
      </div>
    </section>`;
}

function renderSummaryPanel(quotation) {
  return `
    <section class="summary-panel">
      <header><h3>Ringkasan customer</h3></header>
      <div class="summary-lines">
        <div class="summary-line"><span>Subtotal</span><strong id="summary-subtotal">${formatMoney(quotation.totals.subtotal)}</strong></div>
        <div class="summary-line"><span>PPN ${quotation.totals.ppnRate}%</span><strong id="summary-tax">${formatMoney(quotation.totals.tax)}</strong></div>
        <div class="summary-line is-total"><span>Total</span><strong id="summary-total">${formatMoney(quotation.totals.grandTotal)}</strong></div>
      </div>
    </section>`;
}

function renderValidationPanel(quotation) {
  const messages = [
    ...quotation.validation.errors.map((message) => ({
      message,
      error: true,
    })),
    ...quotation.validation.warnings.map((message) => ({
      message,
      error: false,
    })),
  ];
  return `
    <section class="validation-panel">
      <div class="validation-head">
        <span class="status-badge ${statusClass(quotation.validation.status)}" id="side-status">${escapeHtml(quotation.validation.status)}</span>
        <strong style="margin-top: 10px">Pemeriksaan otomatis</strong>
        <small>${quotation.validation.errors.length} error • ${quotation.validation.warnings.length} peringatan</small>
      </div>
      <div class="validation-body" id="validation-messages">
        ${
          messages.length
            ? messages
                .map(
                  (item) =>
                    `<div class="validation-item ${item.error ? "is-error" : ""}">${escapeHtml(item.message)}</div>`,
                )
                .join("")
            : `<div class="validation-item">Semua pemeriksaan lulus.</div>`
        }
      </div>
    </section>`;
}

function renderWorkflowControlPanel() {
  if (!state.current?.id) {
    return `<section class="validation-panel"><div class="validation-head"><strong>Kontrol versi & approval</strong><small>Tersedia setelah quotation pertama kali disimpan.</small></div></section>`;
  }
  const approvals = state.currentApprovals || [];
  const versions = state.currentVersions || [];
  const canApprove = (type) =>
    (type === "TECHNICAL" && state.bootstrap.capabilities.approveTechnical) ||
    (type === "PRICE" && state.bootstrap.capabilities.approvePrice) ||
    (type === "MANAGER" && state.bootstrap.capabilities.approveManager);
  return `
    <section class="validation-panel workflow-control-panel">
      <div class="validation-head">
        <strong>Versi & approval</strong>
        <small>Revisi ${Number(state.current.revision || 0)} · ${state.currentMeta?.workflowStatus ? workflowLabels[state.currentMeta.workflowStatus] || state.currentMeta.workflowStatus : "Draft"}</small>
      </div>
      <div class="validation-body">
        ${approvals.length
          ? approvals.map((item) => `<div class="approval-row"><div><strong>${escapeHtml(approvalLabels[item.approvalType] || item.approvalType)}</strong><small>${escapeHtml(item.actor || item.requestedBy || "Menunggu keputusan")}${item.note ? ` · ${escapeHtml(item.note)}` : ""}</small></div><span class="approval-status approval-${String(item.status).toLowerCase()}">${escapeHtml(item.status)}</span>${item.status === "PENDING" && canApprove(item.approvalType) ? `<div class="approval-actions"><button type="button" data-approval-decision="APPROVED" data-approval-type="${item.approvalType}">Setujui</button><button type="button" data-approval-decision="REJECTED" data-approval-type="${item.approvalType}">Tolak</button></div>` : ""}</div>`).join("")
          : `<div class="validation-item">Approval formal belum diajukan.</div>`}
        <button class="record-link" type="button" data-show-versions>Riwayat ${versions.length} versi tersimpan</button>
      </div>
    </section>`;
}

function renderEditor() {
  const quotation = state.current;
  const canEdit = state.bootstrap.capabilities.editQuotations && !currentIsLocked();
  const canModify = state.bootstrap.capabilities.editQuotations;
  const quotationCreators = state.bootstrap?.quotationCreators || [];
  const selectedCreatorCode = String(quotation.qnCreatorInitials || "YN").toUpperCase();
  const hasSelectedCreator = quotationCreators.some(
    (item) => item.creatorInitials === selectedCreatorCode,
  );
  const creatorCodeOptions = [
    ...(!hasSelectedCreator
      ? [{ creatorName: "Kode tersimpan", creatorInitials: selectedCreatorCode }]
      : []),
    ...quotationCreators,
  ]
    .map(
      (item) => `<option value="${escapeHtml(item.creatorInitials)}" ${item.creatorInitials === selectedCreatorCode ? "selected" : ""}>${escapeHtml(item.creatorName)} (${escapeHtml(item.creatorInitials)})</option>`,
    )
    .join("");
  const customerOptions = (state.bootstrap.customers || [])
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`)
    .join("");
  const templateOptions = (state.bootstrap.templates || [])
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.packageName)}</option>`)
    .join("");
  const identity = `
    <section class="form-section">
      ${sectionHeader("01", "Identitas quotation", "Data yang akan tampil pada Word dan PDF.")}
      <div class="form-section-body">
        <div class="form-grid">
          <label class="field col-12 customer-master-picker">
            <span>Isi cepat dari master customer</span>
            <select data-load-customer><option value="">Pilih customer tersimpan...</option>${customerOptions}</select>
            <small>Alamat, PIC, project terakhir, dan lokasi akan diisi otomatis; tetap dapat diedit.</small>
          </label>
          ${field("Nomor QN", "qn", quotation.qn, {
            column: "col-4",
            placeholder: "Otomatis saat disimpan",
            help: quotation.id ? "Nomor tersimpan dapat direvisi bila belum dipakai." : "Kosongkan untuk nomor otomatis.",
          })}
          <label class="field col-2">
            <span>Pembuat QN</span>
            <select data-path="qnCreatorInitials">${creatorCodeOptions}</select>
            <small>${quotation.qn ? "Nomor yang sudah terisi tetap mengikuti teks Nomor QN." : "Dipakai saat nomor dibuat otomatis."}</small>
          </label>
          ${field("Tanggal", "date", quotation.date, {
            type: "date",
            column: "col-2",
          })}
          ${field("Revisi", "revision", quotation.revision, {
            type: "number",
            min: 0,
            step: 1,
            column: "col-1",
          })}
          <div class="field col-3">
            <span>Mode dokumen</span>
            ${modeSegments(quotation.mode)}
          </div>
          ${field("Nama customer", "customer.name", quotation.customer.name, {
            column: "col-6",
            placeholder: "PT NAMA CUSTOMER",
          })}
          ${field("PIC / Up. Yth.", "customer.pic", quotation.customer.pic, {
            column: "col-6",
            placeholder: "Bpk./Ibu ...",
          })}
          ${field("Alamat customer", "customer.address", quotation.customer.address, {
            column: "col-12",
            textarea: true,
            placeholder: "Alamat lengkap customer",
          })}
          ${field("Nama project", "project.name", quotation.project.name, {
            column: "col-7",
          })}
          ${field("Lokasi project", "project.location", quotation.project.location, {
            column: "col-5",
          })}
          <div class="field col-12">
            <span>Paket penawaran</span>
            ${packageSegments(quotation.packageName)}
          </div>
        </div>
      </div>
    </section>`;

  const termsIndex =
    includesPackage(quotation.packageName, "FirePro") &&
    includesPackage(quotation.packageName, "PAC")
      ? "05"
      : "04";
  const terms = `
    <section class="form-section">
      ${sectionHeader(termsIndex, "Ketentuan penawaran", "Ketentuan komersial yang akan dicetak pada surat.")}
      <div class="form-section-body">
        <div class="form-grid">
          <label class="field col-3">
            <span>PPN masuk total?</span>
            <select data-path="terms.ppnIncluded" data-boolean>
              <option value="false" ${quotation.terms.ppnIncluded ? "" : "selected"}>Tidak</option>
              <option value="true" ${quotation.terms.ppnIncluded ? "selected" : ""}>Ya</option>
            </select>
          </label>
          ${field("Tarif PPN (%)", "terms.ppnRate", quotation.terms.ppnRate, {
            type: "number",
            min: 0,
            step: 1,
            column: "col-2",
          })}
          <div class="terms-tax-help col-7">
            <strong>Nilai PPN mengatur perhitungan total.</strong>
            <span>Kalimat PPN, Franco, pembayaran, delivery, garansi, dan ketentuan lain dapat diedit langsung pada daftar di bawah.</span>
          </div>
          ${renderCommercialNoteEditor(quotation)}
        </div>
      </div>
    </section>`;

  appView.innerHTML = `
    <div class="view-enter">
      <div class="editor-toolbar">
        <div class="editor-toolbar-info">
          <span class="status-badge ${statusClass(quotation.validation.status)}" id="toolbar-status">${escapeHtml(quotation.validation.status)}</span>
          <div>
            <strong id="toolbar-qn">${escapeHtml(quotation.qn || "QN baru — nomor dibuat saat simpan")}</strong>
            <small id="toolbar-customer">${escapeHtml(quotation.customer.name || "Customer belum diisi")}</small>
          </div>
        </div>
        <span class="autosave-state autosave-${escapeHtml(state.autosaveState)}" id="autosave-state">${currentIsLocked() ? "Terkunci" : state.current.id ? "Autosave aktif" : "Draft lokal aktif"}</span>
        ${canEdit ? `<button class="button button-secondary" data-save-quotation>Simpan</button>` : `<span class="readonly-chip">${currentIsLocked() ? "Terkunci · buat revisi untuk mengedit" : "Mode lihat saja"}</span>`}
        ${!quotation.id && canEdit && templateOptions ? `<label class="toolbar-select"><span>Template</span><select data-apply-template><option value="">Mulai dari template...</option>${templateOptions}</select></label>` : ""}
        ${quotation.id && canModify ? `<button class="button button-secondary" data-duplicate-quotation="${escapeHtml(quotation.id)}">Duplikat</button>` : ""}
        ${quotation.id && canEdit ? `<button class="button button-secondary" data-save-template>Simpan template</button><button class="button button-secondary" data-request-approvals>Ajukan approval</button>` : ""}
        ${quotation.id && currentIsLocked() && canModify ? `<button class="button button-amber" data-create-revision>Buat revisi baru</button>` : ""}
        ${!quotation.id && canEdit ? `<button class="button button-ghost" data-discard-local-draft>Buang draft lokal</button>` : ""}
        <button class="button button-primary" data-open-document-preview>
          Preview &amp; Generate
        </button>
      </div>
      <div class="editor-layout">
        <div class="editor-main">
          ${identity}
          ${fireProSection(quotation)}
          ${pacSection(quotation)}
          ${commercialSection(quotation)}
          ${terms}
        </div>
        <aside class="editor-side">
          ${renderSummaryPanel(quotation)}
          ${renderValidationPanel(quotation)}
          ${renderWorkflowControlPanel()}
        </aside>
      </div>
    </div>`;
  if (!canEdit) {
    appView.querySelectorAll("input, select, textarea").forEach((control) => {
      control.disabled = true;
    });
    appView.querySelectorAll(".editor-main button, [data-save-quotation], [data-save-template], [data-request-approvals]").forEach((button) => {
      button.hidden = true;
    });
  }
}

function getByPath(target, path) {
  return path.split(".").reduce((value, key) => value?.[key], target);
}

function setByPath(target, path, value) {
  const keys = path.split(".");
  const finalKey = keys.pop();
  const parent = keys.reduce((current, key) => {
    if (current[key] == null) current[key] = {};
    return current[key];
  }, target);
  parent[finalKey] = value;
}

function inputValue(element) {
  if (element.dataset.boolean !== undefined) return element.value === "true";
  if (element.type === "number") {
    return element.value === "" ? 0 : Number(element.value);
  }
  return element.value;
}

function scheduleCalculation() {
  window.clearTimeout(state.calculationTimer);
  state.calculationTimer = window.setTimeout(async () => {
    try {
      const { quotation } = await api("/api/quotations/calculate", {
        method: "POST",
        body: JSON.stringify(state.current),
      });
      state.current = quotation;
      refreshCalculatedFields();
      scheduleAutosave();
    } catch (error) {
      toast("Perhitungan gagal", error.message, "error");
    }
  }, 220);
}

function refreshCalculatedFields() {
  const quotation = state.current;
  const subtotal = document.querySelector("#summary-subtotal");
  if (!subtotal) return;
  subtotal.textContent = formatMoney(quotation.totals.subtotal);
  document.querySelector("#summary-tax").textContent = formatMoney(quotation.totals.tax);
  document.querySelector("#summary-total").textContent = formatMoney(quotation.totals.grandTotal);
  document.querySelector("#toolbar-status").className =
    `status-badge ${statusClass(quotation.validation.status)}`;
  document.querySelector("#toolbar-status").textContent = quotation.validation.status;
  document.querySelector("#side-status").className =
    `status-badge ${statusClass(quotation.validation.status)}`;
  document.querySelector("#side-status").textContent = quotation.validation.status;
  document.querySelector("#toolbar-qn").textContent =
    quotation.qn || "QN baru — nomor dibuat saat simpan";
  document.querySelector("#toolbar-customer").textContent =
    quotation.customer.name || "Customer belum diisi";

  const validationMessages = document.querySelector("#validation-messages");
  const messages = [
    ...quotation.validation.errors.map((message) => ({ message, error: true })),
    ...quotation.validation.warnings.map((message) => ({ message, error: false })),
  ];
  validationMessages.innerHTML = messages.length
    ? messages
        .map(
          (item) =>
            `<div class="validation-item ${item.error ? "is-error" : ""}">${escapeHtml(item.message)}</div>`,
        )
        .join("")
    : `<div class="validation-item">Semua pemeriksaan lulus.</div>`;
  const validationHeadSmall = document.querySelector(".validation-head small");
  if (validationHeadSmall) {
    validationHeadSmall.textContent = `${quotation.validation.errors.length} error • ${quotation.validation.warnings.length} peringatan`;
  }
  quotation.items.forEach((item, index) => {
    const cell = document.querySelector(`[data-line-total="${index}"]`);
    if (cell) cell.textContent = formatMoney(item.lineTotal);
  });
  quotation.firepro?.rooms?.forEach((room, index) => {
    const volume = document.querySelector(`[data-room-volume="${index}"]`);
    const requirement = document.querySelector(
      `[data-room-requirement="${index}"]`,
    );
    if (volume) volume.textContent = formatNumber(room.totalVolume);
    if (requirement) requirement.textContent = formatNumber(room.totalRequirement);
  });
  const totalVolume = document.querySelector("[data-firepro-total-volume]");
  if (totalVolume) {
    totalVolume.textContent = `${formatNumber(quotation.firepro.totalProtectedVolume)} m³`;
  }
  const acesDifference = document.querySelector("[data-aces-volume-difference]");
  if (acesDifference) {
    const difference = Number(quotation.firepro.acesVolumeDifferencePercent) || 0;
    acesDifference.textContent = `${difference >= 0 ? "+" : ""}${formatNumber(difference)}%`;
  }
  const acesStatus = document.querySelector("[data-aces-result-status]");
  if (acesStatus) {
    const result = quotation.firepro.aces?.approvalResult || "BELUM DIISI";
    acesStatus.className = `status-badge ${acesResultClass(result)}`;
    acesStatus.textContent = result;
  }
  const selectedMass = document.querySelector("[data-aces-selected-mass]");
  if (selectedMass) {
    selectedMass.textContent = `${formatNumber(quotation.firepro.aces?.selectedMass)} g`;
  }
  const pacNote = document.querySelector("#pac-capacity-note");
  if (pacNote) {
    pacNote.textContent = quotation.pac.capacitySufficient
      ? `Mencukupi dengan margin ${formatNumber(quotation.pac.capacityMargin, 1)} kW.`
      : "Belum mencukupi heat load.";
  }
}

async function saveCurrentQuotation() {
  if (!state.bootstrap.capabilities.editQuotations) {
    if (!state.current?.id) throw new Error("Akun ini hanya dapat melihat quotation tersimpan.");
    return state.current;
  }
  const isExisting = Boolean(state.current.id);
  const endpoint = isExisting
    ? `/api/quotations/${encodeURIComponent(state.current.id)}`
    : "/api/quotations";
  const method = isExisting ? "PUT" : "POST";
  const result = await api(endpoint, {
    method,
    body: JSON.stringify(state.current),
  });
  const quotation = result.quotation;
  state.current = quotation;
  state.currentMeta = result.meta || state.currentMeta;
  state.currentApprovals = result.approvals || state.currentApprovals;
  state.currentVersions = result.versions || state.currentVersions;
  localStorage.removeItem(localDraftKey());
  window.clearTimeout(state.autosaveTimer);
  state.autosaveState = "saved";
  await reloadBootstrap(false);
  if (!result.meta && quotation.id) {
    const fresh = await api(`/api/quotations/${encodeURIComponent(quotation.id)}`);
    state.currentMeta = fresh.meta;
    state.currentApprovals = fresh.approvals || [];
    state.currentVersions = fresh.versions || [];
  }
  renderEditor();
  toast("Quotation tersimpan", `${quotation.qn} • ${quotation.validation.status}`);
  return quotation;
}

async function exportCurrent(type) {
  try {
    const quotation = await saveCurrentQuotation();
    const response = await fetch(
      `/api/quotations/${encodeURIComponent(quotation.id)}/export/${type}`,
      {
        headers: {
          "X-Requested-With": "MNNQuotationDesk",
        },
      },
    );
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || "Ekspor gagal.");
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const fileName =
      disposition.match(/filename="([^"]+)"/)?.[1] ||
      `Quotation.${type}`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    toast(
      `${type.toUpperCase()} + RAB berhasil dibuat`,
      quotation.mode === "DEMO"
        ? "Dokumen memiliki tanda DRAFT."
        : "Surat dan Lampiran RAB sudah tergabung dalam satu file.",
    );
    closeDocumentPreview();
  } catch (error) {
    toast("Ekspor gagal", error.message, "error");
  }
}

async function printCurrentDocument() {
  try {
    const quotation = await saveCurrentQuotation();
    document.querySelector("#print-document-package")?.remove();
    const packageElement = document.createElement("main");
    packageElement.id = "print-document-package";
    packageElement.className = "print-document-package";
    packageElement.setAttribute("aria-hidden", "true");
    packageElement.innerHTML = `${renderLetterPreview(quotation)}${renderRabPreview(quotation)}`;
    document.body.append(packageElement);

    const cleanup = () => {
      document.body.classList.remove("printing-document");
      packageElement.remove();
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup, { once: true });
    document.body.classList.add("printing-document");
    window.requestAnimationFrame(() => window.print());
    window.setTimeout(() => {
      if (packageElement.isConnected) cleanup();
    }, 120000);
  } catch (error) {
    toast("Dokumen belum dapat dicetak", error.message, "error");
  }
}

async function openQuotation(id) {
  setLoading("Membuka quotation...");
  try {
    const result = await api(`/api/quotations/${encodeURIComponent(id)}`);
    state.current = result.quotation;
    state.currentMeta = result.meta || null;
    state.currentApprovals = result.approvals || [];
    state.currentVersions = result.versions || [];
    state.autosaveState = "saved";
    state.activeRabGroupId = "";
    changeView("editor");
  } catch (error) {
    toast("Quotation tidak dapat dibuka", error.message, "error");
    changeView("history");
  }
}

async function renderHistory() {
  setLoading("Memuat riwayat...");
  try {
    const canEdit = state.bootstrap.capabilities.editQuotations;
    const [result, book, creatorResult, trashResult] = await Promise.all([
      api("/api/quotations?limit=300"),
      api(
        `/api/quotation-numbers?series=${encodeURIComponent(state.qnBook.series)}&year=${encodeURIComponent(state.qnBook.year)}&query=${encodeURIComponent(state.qnBook.query)}&limit=500`,
      ),
      api("/api/quotation-creators"),
      api("/api/quotations-trash?limit=100"),
    ]);
    const items = result.items;
    state.qnBookItems = book.items;
    const bookLabels = {
      FP: "FirePro",
      PAC: "Precision Air Conditioning",
      ME: "Mechanical Electrical",
    };
    const years = [...new Set([new Date().getFullYear(), ...(book.years || [])])].sort(
      (a, b) => b - a,
    );
    if (!years.includes(Number(state.qnBook.year))) state.qnBook.year = years[0];
    const editItem = state.qnEditItem;
    const defaultCreator =
      creatorResult.items.find((item) => item.creatorInitials === "YN") ||
      creatorResult.items[0];
    const editInitials =
      editItem?.quotationNumber?.match(/-([A-Z0-9]+)\//)?.[1] ||
      defaultCreator?.creatorInitials ||
      "YN";
    const selectedCreatorName =
      editItem?.creatorName || defaultCreator?.creatorName || "";
    const creatorChoices = [
      ...creatorResult.items,
      ...(!creatorResult.items.some((item) => item.creatorName === selectedCreatorName) && selectedCreatorName
        ? [{ creatorName: selectedCreatorName, creatorInitials: editInitials }]
        : []),
    ];
    const creatorOptions = creatorChoices
      .map(
        (item) => `<option value="${escapeHtml(item.creatorName)}" data-initials="${escapeHtml(item.creatorInitials)}" ${item.creatorName === selectedCreatorName ? "selected" : ""}>${escapeHtml(item.creatorName)} (${escapeHtml(item.creatorInitials)})</option>`,
      )
      .join("");
    const bookRows = book.items
      .map(
        (item) => `
          <article class="qn-book-row ${item.quotationId ? "is-linked" : ""}" ${item.quotationId ? `data-open-quotation="${escapeHtml(item.quotationId)}"` : ""}>
            <time>${escapeHtml(dateDisplay.format(new Date(`${item.quotationDate}T00:00:00`)))}</time>
            <div><strong>${escapeHtml(item.quotationNumber)}</strong><small>${item.source === "MANUAL" ? "Catatan buku lama" : item.source === "DIBATALKAN" ? "Nomor dibatalkan" : "Tercatat otomatis"}</small></div>
            <div><strong>${escapeHtml(item.customerName)}</strong><small>${escapeHtml(item.projectName || "Project belum dicatat")}</small></div>
            <div><strong>${escapeHtml(item.picName || "PIC belum dicatat")}</strong><small>Dibuat oleh ${escapeHtml(item.creatorName)}</small></div>
            ${
              item.quotationId
                ? '<span class="row-arrow">→</span>'
                : item.source === "MANUAL"
                  ? canEdit
                    ? `<div class="qn-row-actions"><button class="qn-edit-button" type="button" data-edit-qn="${escapeHtml(item.id)}">Ubah</button><button class="qn-delete-button" type="button" data-delete-qn="${escapeHtml(item.id)}" data-delete-qn-number="${escapeHtml(item.quotationNumber)}" aria-label="Hapus ${escapeHtml(item.quotationNumber)}">Hapus</button></div>`
                    : '<span class="readonly-chip">CATATAN</span>'
                  : '<span class="qn-cancelled-badge">BATAL</span>'
            }
          </article>`,
      )
      .join("");
    appView.innerHTML = `
      <div class="view-enter">
        <div class="section-heading" style="margin-top: 0">
          <h2>Buku Nomor QN digital</h2>
          <p>Tiga buku tetap terpisah. Nomor urut dihitung ulang dari 001 setiap pergantian tahun.</p>
        </div>
        <section class="qn-book-tabs" aria-label="Pilih buku nomor quotation">
          ${["FP", "PAC", "ME"]
            .map(
              (series) => `<button class="qn-book-tab ${state.qnBook.series === series ? "is-active" : ""}" type="button" data-qn-book="${series}"><span>Buku ${series}</span><strong>${Number(book.stats?.[series] || 0)}</strong><small>${bookLabels[series]}</small></button>`,
            )
            .join("")}
        </section>
        <section class="panel qn-creator-panel">
          <div>
            <strong>Master pembuat QN</strong>
            <p>${creatorResult.items.map((item) => `<span class="qn-creator-chip">${escapeHtml(item.creatorName)} <b>${escapeHtml(item.creatorInitials)}</b></span>`).join("")}</p>
          </div>
          ${canEdit ? `<form id="creator-master-form" class="qn-creator-form">
            <input name="creatorName" placeholder="Nama pembuat baru" required />
            <input name="creatorInitials" maxlength="5" pattern="[A-Za-z0-9]{2,5}" placeholder="Kode, mis. EP" required />
            <button class="button button-secondary" type="submit">+ Tambah pembuat</button>
          </form>` : `<span class="readonly-chip">Lihat saja</span>`}
        </section>
        <section class="panel qn-book-panel">
          <header class="panel-header qn-book-header">
            <div><h3>Buku ${state.qnBook.series} — ${state.qnBook.year}</h3><p>${book.items.length} nomor ditampilkan; nomor terbaru berada paling atas.</p></div>
            <div class="qn-book-filters">
              <label><span>Tahun</span><select id="qn-year-filter">${years.map((year) => `<option value="${year}" ${Number(state.qnBook.year) === year ? "selected" : ""}>${year}</option>`).join("")}</select></label>
              <label class="qn-book-search"><span>Cari nomor, customer, atau pembuat</span><input id="qn-book-search" type="search" value="${escapeHtml(state.qnBook.query)}" placeholder="Ketik untuk mencari..." /></label>
            </div>
          </header>
          <div class="qn-book-column-head"><span>Tanggal</span><span>Nomor quotation</span><span>Customer / Project</span><span>PIC / Pembuat</span><span></span></div>
          <div class="qn-book-list">${bookRows || '<div class="empty-panel"><strong>Belum ada nomor di buku ini</strong>Nomor baru akan masuk otomatis saat quotation disimpan, atau masukkan catatan buku lama di bawah.</div>'}</div>
        </section>
        ${canEdit ? `<details class="panel qn-manual-panel" ${editItem ? "open" : ""}>
          <summary><span><strong>${editItem ? "Edit catatan Buku QN" : "Input catatan buku lama"}</strong><small>${editItem ? "Perbaiki data yang kurang terbaca atau salah input." : "Nomor tahun lain dapat sama karena penghitungannya reset setiap tahun."}</small></span><span>${editItem ? "Mode edit" : "+ Tambah manual"}</span></summary>
          <form id="manual-qn-form" class="qn-manual-form">
            <label><span>Tanggal</span><input type="date" name="quotationDate" value="${escapeHtml(editItem?.quotationDate || `${state.qnBook.year}-01-01`)}" required /></label>
            <label><span>Nama pembuat quotation</span><select id="manual-qn-creator" name="creatorName" required>${creatorOptions}</select></label>
            <label><span>Buku nomor</span><select name="series" required>${["FP", "PAC", "ME"].map((series) => `<option value="${series}" ${series === (editItem?.series || state.qnBook.series) ? "selected" : ""}>${series} — ${bookLabels[series]}</option>`).join("")}</select></label>
            <label><span>Kode pembuat</span><input id="manual-qn-initials" name="creatorInitials" value="${escapeHtml(editInitials)}" maxlength="5" pattern="[A-Za-z0-9]{2,5}" placeholder="YN / PL / EP / AD" required /></label>
            <label><span>Nomor urut</span><input type="number" name="sequenceNumber" min="1" step="1" value="${editItem?.sequenceNumber || ""}" placeholder="Contoh: 145" required /></label>
            <label class="span-2"><span>Customer</span><input name="customerName" value="${escapeHtml(editItem?.customerName || "")}" placeholder="Nama perusahaan/customer" required /></label>
            <label class="span-2"><span>Project</span><input name="projectName" value="${escapeHtml(editItem?.projectName || "")}" placeholder="Nama project (opsional)" /></label>
            <label class="span-2"><span>PIC</span><input name="picName" value="${escapeHtml(editItem?.picName || "")}" placeholder="Nama PIC customer (opsional)" /></label>
            <div class="qn-manual-submit"><p>Format: <strong id="manual-qn-format">QN/${editItem?.series || state.qnBook.series}-${editInitials}/${editItem ? String(editItem.sequenceNumber).padStart(3, "0") : "..."}</strong> — tahun mengikuti tanggal.</p><div>${editItem ? '<button class="button button-secondary" type="button" data-cancel-qn-edit>Batal</button>' : ""}<button class="button button-amber" type="submit">${editItem ? "Simpan perubahan" : "Simpan ke Buku QN"}</button></div></div>
          </form>
        </details>` : ""}
        <div class="section-heading">
          <h2>File quotation tersimpan</h2>
          <p>Draft, review, dan quotation siap produksi yang dapat dibuka kembali.</p>
        </div>
        <div class="panel">
          <header class="panel-header">
            <h3>${items.length} quotation tersimpan</h3>
            ${canEdit ? `<button class="button button-primary" data-new-quotation>+ Quotation baru</button>` : ""}
          </header>
          <div class="quotation-list">
            ${items.length ? items.map(recentQuotationMarkup).join("") : `<div class="empty-panel"><strong>Belum ada quotation</strong>Buat quotation pertama Anda.</div>`}
          </div>
        </div>
        <details class="panel recycle-panel">
          <summary><span><strong>Recycle Bin</strong><small>${trashResult.items.length} draft dihapus dan masih dapat dipulihkan.</small></span><span>Buka</span></summary>
          <div class="quotation-list recycle-list">
            ${trashResult.items.length ? trashResult.items.map((item) => `<article class="quotation-row"><div><strong>${escapeHtml(item.qn || "Tanpa nomor")}</strong><small>Dihapus ${formatDateTime(item.deletedAt)} oleh ${escapeHtml(item.deletedBy || "-")}</small></div><div><strong>${escapeHtml(item.customerName || "Customer belum diisi")}</strong><small>${escapeHtml(item.projectName || "Project belum diisi")}</small></div><span class="status-badge status-review">DIHAPUS</span><strong class="money-cell">${formatMoney(item.grandTotal)}</strong><div class="quotation-row-actions">${canEdit ? `<button class="button button-small button-secondary" type="button" data-restore-quotation="${escapeHtml(item.id)}">Pulihkan</button>` : ""}</div></article>`).join("") : `<div class="empty-panel"><strong>Recycle Bin kosong</strong>Draft yang dihapus akan muncul di sini.</div>`}
          </div>
        </details>
      </div>`;
  } catch (error) {
    toast("Riwayat gagal dimuat", error.message, "error");
  }
}

const workflowLabels = {
  DRAFT: "Draft",
  WAITING_PRICE: "Menunggu Harga",
  CALCULATION: "Perhitungan",
  INTERNAL_REVIEW: "Review Internal",
  SENT: "Terkirim",
  FOLLOW_UP: "Follow-up",
  WON: "Menang / PO",
  LOST: "Kalah",
  CANCELLED: "Dibatalkan",
};

function workflowBadge(status) {
  return `<span class="workflow-badge workflow-${String(status || "DRAFT").toLowerCase()}">${escapeHtml(workflowLabels[status] || status || "Draft")}</span>`;
}

function trackingRowMarkup(item) {
  const updated = item.workflowUpdatedAt || item.updatedAt;
  const ageDays = Math.max(0, Math.floor((Date.now() - new Date(updated).getTime()) / 86400000));
  const followUpDate = item.followUpAt ? new Date(`${String(item.followUpAt).slice(0, 10)}T23:59:59`) : null;
  const followUpOverdue = followUpDate && followUpDate.getTime() < Date.now() && !["WON", "LOST", "CANCELLED"].includes(item.workflowStatus);
  return `
    <article class="tracking-row">
      <div class="tracking-identity">
        <strong>${escapeHtml(item.qn)}</strong>
        <small>${escapeHtml(item.packageName)} · ${escapeHtml(item.workflowOwnerName || "Belum ada owner")}</small>
      </div>
      <div class="tracking-customer">
        <strong>${escapeHtml(item.customerName || "Customer belum diisi")}</strong>
        <small>${escapeHtml(item.projectName || "Project belum diisi")}</small>
      </div>
      <div class="tracking-progress">
        ${workflowBadge(item.workflowStatus)}
        <small>${escapeHtml(item.workflowNote || "Belum ada catatan progres")}</small>
        ${item.followUpAt ? `<small class="follow-up-chip ${followUpOverdue ? "is-overdue" : ""}">${followUpOverdue ? "TERLAMBAT · " : "Follow-up · "}${escapeHtml(dateDisplay.format(new Date(`${String(item.followUpAt).slice(0, 10)}T00:00:00`)))}</small>` : ""}
        ${item.outcomeReason ? `<small>Alasan hasil: ${escapeHtml(item.outcomeReason)}</small>` : ""}
      </div>
      <div class="tracking-age ${ageDays >= 7 ? "is-aging" : ""}"><strong>${ageDays}</strong><small>hari sejak update</small></div>
      <div class="tracking-actions">
        <button class="button button-small button-secondary" data-open-quotation="${escapeHtml(item.id)}">Buka</button>
        ${state.bootstrap.capabilities.updateWorkflow ? `<button class="button button-small button-primary" data-update-workflow="${escapeHtml(item.id)}">Update</button>` : ""}
      </div>
    </article>`;
}

async function loadTracking() {
  const params = new URLSearchParams({
    status: state.trackingFilter.status,
    packageName: state.trackingFilter.packageName,
    query: state.trackingFilter.query,
    limit: "300",
  });
  const result = await api(`/api/quotation-tracking?${params}`);
  state.trackingItems = result.items;
  const list = document.querySelector("#tracking-list");
  if (list) {
    list.innerHTML = result.items.length
      ? result.items.map(trackingRowMarkup).join("")
      : `<div class="empty-panel"><strong>Tidak ada quotation</strong>Ubah filter atau kata pencarian.</div>`;
  }
  const count = document.querySelector("#tracking-count");
  if (count) count.textContent = `${result.items.length} quotation`;
}

async function renderTracking() {
  const workflow = state.bootstrap.dashboard.workflowStats || {};
  const active = ["DRAFT", "WAITING_PRICE", "CALCULATION", "INTERNAL_REVIEW", "SENT", "FOLLOW_UP"]
    .reduce((total, status) => total + Number(workflow[status] || 0), 0);
  appView.innerHTML = `
    <div class="view-enter">
      <section class="tracking-headline">
        <div><span class="eyebrow">PIPELINE QUOTATION</span><h2>Progress yang bisa dilihat semua divisi.</h2><p>Validasi teknis dan progres bisnis dipisahkan, sehingga kendala harga atau follow-up customer terlihat jelas.</p></div>
        <div class="tracking-summary"><strong>${active}</strong><span>quotation aktif</span><small>${Number(workflow.WAITING_PRICE || 0)} menunggu harga · ${Number(workflow.FOLLOW_UP || 0)} follow-up</small></div>
      </section>
      <div class="tracking-toolbar">
        <input id="tracking-search" type="search" value="${escapeHtml(state.trackingFilter.query)}" placeholder="Cari QN, customer, project, atau pembuat..." />
        <select id="tracking-status"><option value="">Semua status</option>${Object.entries(workflowLabels).map(([value, label]) => `<option value="${value}" ${state.trackingFilter.status === value ? "selected" : ""}>${label}</option>`).join("")}</select>
        <select id="tracking-package"><option value="">Semua paket</option><option value="FirePro">FirePro</option><option value="PAC">PAC</option><option value="FirePro + PAC">FirePro + PAC</option></select>
        <span id="tracking-count">Memuat...</span>
      </div>
      <section class="tracking-list" id="tracking-list"><div class="loading-state" style="min-height:280px"><div class="loading-mark"></div></div></section>
    </div>`;
  document.querySelector("#tracking-package").value = state.trackingFilter.packageName;
  try {
    await loadTracking();
  } catch (error) {
    document.querySelector("#tracking-list").innerHTML = `<div class="empty-panel"><strong>Tracking gagal dimuat</strong>${escapeHtml(error.message)}</div>`;
  }
}

function openWorkflowEditor(id) {
  const item = state.trackingItems.find((candidate) => candidate.id === id);
  if (!item) return;
  workflowForm.elements.quotationId.value = item.id;
  workflowForm.elements.status.value = item.workflowStatus || "DRAFT";
  workflowForm.elements.note.value = item.workflowNote || "";
  workflowForm.elements.followUpAt.value = String(item.followUpAt || "").slice(0, 10);
  workflowForm.elements.outcomeReason.value = item.outcomeReason || "";
  document.querySelector("#workflow-modal-subtitle").textContent = `${item.qn} · ${item.customerName || "Customer belum diisi"}`;
  workflowModal.hidden = false;
  workflowForm.elements.status.focus();
}

function priceRowMarkup(item, selectable = false) {
  const manual =
    item.priceOrigin === "MANUAL_SUPPORT" ||
    item.verificationStatus === "PERLU_VERIFIKASI_LOGISTIK";
  const logistics =
    item.priceOrigin === "LOGISTIK_MASTER" ||
    item.verificationStatus === "TERVERIFIKASI_LOGISTIK";
  const statusText = item.isStale
    ? `Usang ${Number(item.ageDays || 0)} hari`
    : manual
    ? "Perlu verifikasi"
    : logistics
      ? "Logistik"
      : item.needsReview
        ? "Review"
        : "Aktif";
  return `
    <article class="${selectable ? "modal-price-row" : "price-result"}">
      <span class="price-code">${escapeHtml(item.code)}</span>
      <div class="price-description">
        <strong>${escapeHtml(item.description)}</strong>
        <small>${escapeHtml(item.packageName)} • ${escapeHtml(item.source)}</small>
        ${manual ? `<small>Bukti: ${escapeHtml(item.evidenceRef || "belum dicatat")} • ${escapeHtml(item.snapshotDate || "tanpa tanggal")}</small>` : ""}
      </div>
      <span>${escapeHtml(item.unit)}</span>
      <span class="price-value ${Number(item.price) <= 0 ? "is-zero" : ""}">${Number(item.price) > 0 ? formatMoney(item.price) : "Belum ada harga"}</span>
      ${
        selectable
          ? `<button class="button button-small button-primary" data-select-price="${escapeHtml(item.code)}">Tambah</button>`
          : `<div class="price-row-actions"><span class="status-badge ${item.isStale || manual || item.needsReview ? "status-review" : "status-ready"}">${statusText}</span><button class="button button-small button-secondary" data-price-history="${escapeHtml(item.code)}">Riwayat</button>${state.bootstrap.capabilities.manageLogisticsPrices ? `<button class="button button-small button-secondary" data-edit-logistics-price="${escapeHtml(item.code)}">${manual ? "Verifikasi" : "Edit"}</button>` : ""}</div>`
      }
    </article>`;
}

async function searchPricePage() {
  const query = document.querySelector("#price-page-search")?.value || "";
  const packageName =
    document.querySelector("#price-page-package")?.value || "";
  const result = await api(
    `/api/prices?query=${encodeURIComponent(query)}&packageName=${encodeURIComponent(packageName)}&limit=200`,
  );
  state.pricePageResults = result.items;
  const container = document.querySelector("#price-page-results");
  if (container) {
    container.innerHTML = result.items.length
      ? result.items.map((item) => priceRowMarkup(item)).join("")
      : `<div class="empty-panel"><strong>Tidak ada hasil</strong>Coba kata kunci atau filter lain.</div>`;
  }
}

async function renderPrices() {
  const stats = state.bootstrap.dashboard.priceStats;
  const canManage = state.bootstrap.capabilities.manageLogisticsPrices;
  const canRequest = state.bootstrap.capabilities.requestManualPrices;
  appView.innerHTML = `
    <div class="view-enter">
      <div class="section-heading" style="margin-top: 0">
        <h2>${canManage ? "Master harga Logistik" : "Master harga terpusat"}</h2>
        <p>${Number(stats.total || 0)} kode tersedia; ${Number(stats.manual || 0)} harga manual menunggu verifikasi Logistik.</p>
      </div>
      ${canManage ? `<section class="logistics-command-panel">
        <div><span class="eyebrow">TANPA EXCEL</span><h3>Tambah atau perbarui harga stok langsung.</h3><p>Kode, supplier, tanggal, dan bukti pembelian tersimpan sebagai jejak sumber harga resmi.</p></div>
        <button class="button button-primary" data-open-logistics-price>+ Harga Logistik</button>
      </section>
      <section class="upload-panel">
        <div>
          <h3>Masih dapat impor file lama</h3>
          <p>Gunakan hanya untuk migrasi massal. Input harian sekarang dapat dilakukan langsung dari program.</p>
        </div>
        <form class="upload-form" id="price-import-form">
          <input type="date" name="snapshotDate" value="${new Date().toISOString().slice(0, 10)}" aria-label="Tanggal snapshot" />
          <input type="file" name="pricelist" accept=".xlsx" required />
          <button class="button button-amber" type="submit">Import .xlsx</button>
        </form>
      </section>` : ""}
      ${canRequest ? `<section class="manual-price-banner">
        <div>
          <span class="eyebrow">MATERIAL BELUM PERNAH DIBELI?</span>
          <h3>Catat harga baru tanpa menunggu kode Logistik</h3>
          <p>Supplier, tanggal, dan bukti harga wajib dicatat. Statusnya tetap terlihat sampai pricelist resmi diperbarui.</p>
        </div>
        <button class="button button-amber" data-open-manual-price>+ Input harga manual</button>
      </section>` : ""}
      <div class="search-toolbar">
        <input id="price-page-search" type="search" placeholder="Cari kode atau deskripsi material..." />
        <select id="price-page-package">
          <option value="">Semua sumber</option>
          <option value="FirePro">FirePro</option>
          <option value="PAC">PAC</option>
          <option value="Material">Material</option>
        </select>
      </div>
      <section class="panel">
        <div id="price-page-results"><div class="loading-state" style="min-height: 280px"><div class="loading-mark"></div></div></div>
      </section>
    </div>`;
  await searchPricePage();
}

function renderSettingsLegacy() {
  const settings = state.bootstrap.dashboard.settings;
  appView.innerHTML = `
    <div class="view-enter">
      <div class="section-heading" style="margin-top: 0">
        <h2>Pengaturan dan keamanan akun</h2>
        <p>Anda masuk sebagai ${escapeHtml(state.user.displayName)} · ${escapeHtml(roleLabels[state.user.role] || state.user.role)}.</p>
      </div>
      <section class="settings-grid">
        <article class="settings-card">
          <span class="eyebrow">IDENTITAS DOKUMEN</span>
          <h3>Standar surat aktif</h3>
          <dl class="definition-list">
            <dt>Perusahaan</dt><dd>${escapeHtml(settings.companyName)}</dd>
            <dt>Penandatangan</dt><dd>${escapeHtml(settings.signerName)}</dd>
            <dt>Jabatan</dt><dd>${escapeHtml(settings.signerTitle)}</dd>
            <dt>Font</dt><dd>Calibri 11 / perusahaan 12</dd>
            <dt>Margin</dt><dd>3,6 / 1,2 / 2,2 / 2,2 cm</dd>
          </dl>
        </article>
        <article class="settings-card">
          <span class="eyebrow">PENYIMPANAN</span>
          <h3>Database lokal terpusat</h3>
          <p>
            Quotation, master harga, dan audit tersimpan pada server aplikasi.
            Untuk pemakaian produksi bersama, folder data wajib masuk jadwal backup kantor.
          </p>
        </article>
        <article class="settings-card">
          <span class="eyebrow">KEAMANAN AKTIF</span>
          <h3>Login dan hak akses per divisi</h3>
          <p>
            Sesi login berakhir otomatis setelah 12 jam. Logistik, Support, Presales,
            Manager Operational, dan Administrator memiliki hak akses yang berbeda.
          </p>
        </article>
        <article class="settings-card">
          <span class="eyebrow">ENGINEERING GATE</span>
          <h3>ACES tersimpan, approval tetap terpisah</h3>
          <p>
            DOCX ACES dibaca untuk volume, selected mass, generator, dan BOM. Model final tetap harus
            disetujui Engineering sebelum mode PRODUKSI.
          </p>
        </article>
        <article class="settings-card">
          <span class="eyebrow">KONTROL HARGA BARU</span>
          <h3>Manual bukan harga Logistik</h3>
          <p>
            Material baru boleh dicatat oleh Support dengan supplier, bukti, dan tanggal.
            Status “Perlu Verifikasi Logistik” ikut terbawa sampai Logistik memverifikasinya langsung di program.
          </p>
        </article>
        <article class="settings-card settings-password-card">
          <span class="eyebrow">PASSWORD AKUN</span>
          <h3>${state.user.mustChangePassword ? "Ganti password awal" : "Perbarui password"}</h3>
          <form id="change-password-form" class="password-form">
            <label><span>Password saat ini</span><input name="currentPassword" type="password" autocomplete="current-password" required /></label>
            <label><span>Password baru</span><input name="newPassword" type="password" autocomplete="new-password" minlength="10" required /></label>
            <small>Minimal 10 karakter, berisi huruf, angka, dan simbol. Setelah diganti Anda perlu login kembali.</small>
            <button class="button button-primary" type="submit">Ganti password</button>
          </form>
        </article>
      </section>
    </div>`;
}

function renderSettings() {
  const settings = state.bootstrap.dashboard.settings;
  const capabilities = state.bootstrap.capabilities;
  const users = state.bootstrap.users || [];
  const customers = state.bootstrap.customers || [];
  const templates = state.bootstrap.templates || [];
  const backups = state.bootstrap.backups || [];
  const backupConfig = state.bootstrap.backupConfig || {
    backupMirrorPath: "",
    mirrorRoot: "",
    mirrorConfigured: false,
    mirrorStatus: "NONAKTIF",
    mirrorError: "",
    backupRetentionDays: 90,
  };
  const editUser = users.find((item) => item.id === state.userEditId);
  const editCustomer = customers.find((item) => item.id === state.customerEditId);
  const allowedRoles = capabilities.manageAllUsers
    ? ["ADMIN", "OPERATIONS_MANAGER", "SUPPORT", "PRESALES", "LOGISTICS"]
    : ["SUPPORT", "PRESALES", "LOGISTICS"];
  const roleOptions = allowedRoles.map((role) => `<option value="${role}" ${editUser?.role === role ? "selected" : ""}>${escapeHtml(roleLabels[role])}</option>`).join("");
  appView.innerHTML = `
    <div class="view-enter">
      <div class="section-heading" style="margin-top: 0"><h2>Pengaturan, master data, dan keamanan</h2><p>Anda masuk sebagai ${escapeHtml(state.user.displayName)} · ${escapeHtml(roleLabels[state.user.role] || state.user.role)}.</p></div>
      <section class="settings-grid settings-summary-grid">
        <article class="settings-card"><span class="eyebrow">IDENTITAS DOKUMEN</span><h3>Standar surat aktif</h3><dl class="definition-list"><dt>Perusahaan</dt><dd>${escapeHtml(settings.companyName)}</dd><dt>Penandatangan</dt><dd>${escapeHtml(settings.signerName)}</dd><dt>Jabatan</dt><dd>${escapeHtml(settings.signerTitle)}</dd><dt>Font</dt><dd>Calibri 11 / perusahaan 12</dd><dt>Margin</dt><dd>3,6 / 1,2 / 2,2 / 2,2 cm</dd></dl></article>
        <article class="settings-card settings-password-card"><span class="eyebrow">PASSWORD SAYA</span><h3>${state.user.mustChangePassword ? "Ganti password awal" : "Perbarui password"}</h3><form id="change-password-form" class="password-form"><label><span>Password saat ini</span><input name="currentPassword" type="password" autocomplete="current-password" required /></label><label><span>Password baru</span><input name="newPassword" type="password" autocomplete="new-password" minlength="10" required /></label><small>Minimal 10 karakter: huruf besar, huruf kecil, angka, dan simbol.</small><button class="button button-primary" type="submit">Ganti password</button></form></article>
      </section>

      ${capabilities.manageUsers ? `<section class="management-section panel"><header class="panel-header"><div><span class="eyebrow">AKUN & ROLE</span><h3>Manajemen pengguna</h3><p>${capabilities.manageAllUsers ? "Administrator dapat mengelola seluruh role." : "Manager Operational dapat mengelola Support, Presales, dan Logistik."}</p></div></header><div class="management-split"><form id="user-management-form" class="management-form"><input type="hidden" name="id" value="${escapeHtml(editUser?.id || "")}" /><label><span>Nama lengkap</span><input name="displayName" value="${escapeHtml(editUser?.displayName || "")}" required /></label><label><span>Username</span><input name="username" value="${escapeHtml(editUser?.username || "")}" pattern="[A-Za-z0-9._-]{3,40}" required /></label><label><span>Role</span><select name="role" required>${roleOptions}</select></label><label><span>Status</span><select name="active"><option value="true" ${editUser?.active === false ? "" : "selected"}>Aktif</option><option value="false" ${editUser?.active === false ? "selected" : ""}>Nonaktif</option></select></label><label class="span-2"><span>${editUser ? "Password (tidak diubah dari form ini)" : "Password awal"}</span><input name="password" type="password" minlength="10" ${editUser ? "disabled placeholder=\"Gunakan tombol Reset password\"" : "required"} /></label><div class="form-actions span-2">${editUser ? `<button class="button button-ghost" type="button" data-cancel-user-edit>Batal edit</button>` : ""}<button class="button button-primary" type="submit">${editUser ? "Simpan perubahan" : "+ Buat akun"}</button></div></form><div class="management-list">${users.map((item) => `<article class="management-row"><div><strong>${escapeHtml(item.displayName)}</strong><small>@${escapeHtml(item.username)} · ${escapeHtml(roleLabels[item.role] || item.role)}</small></div><span class="status-badge ${item.active ? "status-ready" : "status-review"}">${item.active ? "AKTIF" : "NONAKTIF"}</span><div class="management-actions"><button type="button" data-edit-user="${escapeHtml(item.id)}">Ubah</button><button type="button" data-reset-user-password="${escapeHtml(item.id)}" data-reset-user-name="${escapeHtml(item.displayName)}">Reset password</button></div></article>`).join("") || `<div class="empty-panel"><strong>Belum ada akun</strong></div>`}</div></div></section>` : ""}

      ${capabilities.manageCustomers ? `<section class="management-section panel"><header class="panel-header"><div><span class="eyebrow">DATA CUSTOMER</span><h3>Master customer</h3><p>Dipakai untuk mengisi identitas quotation lebih cepat.</p></div></header><div class="management-split"><form id="customer-management-form" class="management-form"><input type="hidden" name="id" value="${escapeHtml(editCustomer?.id || "")}" /><label class="span-2"><span>Nama customer</span><input name="name" value="${escapeHtml(editCustomer?.name || "")}" required /></label><label class="span-2"><span>Alamat</span><textarea name="address">${escapeHtml(editCustomer?.address || "")}</textarea></label><label><span>PIC</span><input name="picName" value="${escapeHtml(editCustomer?.picName || "")}" /></label><label><span>Telepon</span><input name="phone" value="${escapeHtml(editCustomer?.phone || "")}" /></label><label><span>Email</span><input name="email" type="email" value="${escapeHtml(editCustomer?.email || "")}" /></label><label><span>Status</span><select name="active"><option value="true" ${editCustomer?.active === false ? "" : "selected"}>Aktif</option><option value="false" ${editCustomer?.active === false ? "selected" : ""}>Nonaktif</option></select></label><label><span>Project terakhir</span><input name="lastProjectName" value="${escapeHtml(editCustomer?.lastProjectName || "")}" /></label><label><span>Lokasi terakhir</span><input name="lastProjectLocation" value="${escapeHtml(editCustomer?.lastProjectLocation || "")}" /></label><div class="form-actions span-2">${editCustomer ? `<button class="button button-ghost" type="button" data-cancel-customer-edit>Batal edit</button>` : ""}<button class="button button-primary" type="submit">${editCustomer ? "Simpan perubahan" : "+ Tambah customer"}</button></div></form><div class="management-list compact-list">${customers.slice(0, 100).map((item) => `<article class="management-row"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.picName || "PIC belum diisi")} · ${escapeHtml(item.lastProjectName || "Project belum diisi")}</small></div><span class="status-badge ${item.active ? "status-ready" : "status-review"}">${item.active ? "AKTIF" : "ARSIP"}</span><div class="management-actions"><button type="button" data-edit-customer="${escapeHtml(item.id)}">Ubah</button></div></article>`).join("")}</div></div></section>` : ""}

      ${capabilities.manageTemplates ? `<section class="management-section panel"><header class="panel-header"><div><span class="eyebrow">TEMPLATE</span><h3>Template quotation aktif</h3><p>Simpan template dari editor agar paket pekerjaan berulang tidak dimulai dari nol.</p></div></header><div class="management-list horizontal-list">${templates.map((item) => `<article class="management-row"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.packageName)} · oleh ${escapeHtml(item.createdBy)}</small></div><div class="management-actions"><button type="button" data-use-template="${escapeHtml(item.id)}">Gunakan</button><button type="button" data-template-active="false" data-template-id="${escapeHtml(item.id)}">Arsipkan</button></div></article>`).join("") || `<div class="empty-panel"><strong>Belum ada template</strong>Simpan quotation yang sering dipakai dari editor.</div>`}</div></section>` : ""}

      ${capabilities.manageBackups ? `<section class="management-section panel"><header class="panel-header"><div><span class="eyebrow">BACKUP OTOMATIS</span><h3>Cadangan database & lampiran</h3><p>Pemeriksaan harian berjalan di server; backup manual dapat dibuat sebelum perubahan penting.</p></div><button class="button button-primary" type="button" data-create-backup>Buat backup sekarang</button></header><div class="management-list horizontal-list">${backups.slice(0, 10).map((item) => `<article class="management-row"><div><strong>${escapeHtml(item.name || item.fileName || "Backup")}</strong><small>${formatDateTime(item.createdAt)} · ${escapeHtml(item.kind || item.reason || "OTOMATIS")}</small></div><span class="status-badge status-ready">TERVERIFIKASI</span></article>`).join("") || `<div class="empty-panel"><strong>Belum ada backup terdaftar</strong>Backup otomatis pertama dibuat saat server aktif.</div>`}</div></section>` : ""}
      ${capabilities.manageBackups ? `<section class="management-section panel backup-protection-panel">
        <header class="panel-header"><div><span class="eyebrow">SALINAN KEDUA & RESTORE</span><h3>Proteksi ketika server atau disk bermasalah</h3><p>Backup lokal disalin ke jaringan dan dapat dipulihkan oleh Administrator dengan safety backup otomatis.</p></div></header>
        <div class="backup-health-strip">
          <div><span>LOKAL</span><strong>Aktif & terverifikasi</strong><small>Database dan lampiran ACES</small></div>
          <div class="${backupConfig.mirrorStatus === "GAGAL" ? "has-error" : ""}"><span>JARINGAN</span><strong>${backupConfig.mirrorConfigured ? escapeHtml(backupConfig.mirrorStatus === "TERVERIFIKASI" ? "Terverifikasi" : backupConfig.mirrorStatus === "GAGAL" ? "Gagal tersalin" : "Siap diuji") : "Belum diatur"}</strong><small>${escapeHtml(backupConfig.mirrorRoot || "Atur lokasi UNC untuk salinan kedua")}</small></div>
          <div><span>RETENSI</span><strong>${Number(backupConfig.backupRetentionDays || 90)} hari</strong><small>Minimal 3 backup terbaru selalu disimpan</small></div>
        </div>
        ${backupConfig.mirrorError ? `<p class="backup-warning">Salinan jaringan terakhir gagal: ${escapeHtml(backupConfig.mirrorError)}</p>` : ""}
        ${capabilities.manageBackupSettings ? `<form id="backup-settings-form" class="backup-settings-form"><label><span>Folder jaringan / UNC</span><input name="backupMirrorPath" value="${escapeHtml(backupConfig.backupMirrorPath || "")}" placeholder="\\\\server\\share\\folder" /></label><label><span>Retensi (hari)</span><input name="backupRetentionDays" type="number" min="7" max="3650" step="1" value="${Number(backupConfig.backupRetentionDays || 90)}" required /></label><button class="button button-secondary" type="submit">Simpan & uji lokasi</button></form>` : ""}
        <div class="management-list horizontal-list backup-restore-list">${backups.slice(0, 20).map((item) => `<article class="management-row backup-restore-row"><div><strong>${escapeHtml(item.id || "Backup")}</strong><small>${formatDateTime(item.createdAt)} · ${escapeHtml(item.reason || "OTOMATIS")} · ${Number(item.counts?.quotations || 0)} quotation</small></div><div class="backup-badges"><span class="status-badge status-ready">LOKAL OK</span>${backupConfig.mirrorConfigured ? `<span class="status-badge ${item.mirror?.status === "TERVERIFIKASI" ? "status-ready" : "status-review"}">${item.mirror?.status === "TERVERIFIKASI" ? "JARINGAN OK" : "LOKAL SAJA"}</span>` : ""}</div>${capabilities.restoreBackups ? `<button class="button button-small button-danger" type="button" data-restore-backup="${escapeHtml(item.id)}">Pulihkan</button>` : ""}</article>`).join("") || `<div class="empty-panel"><strong>Belum ada titik pemulihan</strong>Buat backup pertama sebelum mencoba pemulihan.</div>`}</div>
      </section>` : ""}
    </div>`;
  const managedUsernameInput = document.querySelector('#user-management-form input[name="username"]');
  if (managedUsernameInput) {
    managedUsernameInput.title = "3-40 karakter: huruf, angka, titik, garis bawah, atau tanda minus. Tanpa spasi.";
    managedUsernameInput.autocomplete = "off";
    managedUsernameInput.spellcheck = false;
    const helper = document.createElement("small");
    helper.textContent = "3-40 karakter tanpa spasi. Perubahan username akan mengeluarkan pengguna dari sesi lamanya.";
    managedUsernameInput.closest("label")?.append(helper);
  }
  enhancePasswordControls(appView);
}

async function renderReports() {
  if (!state.bootstrap.capabilities.viewReports) {
    changeView("dashboard");
    return;
  }
  setLoading("Menyusun laporan manajemen...");
  try {
    const { report } = await api(`/api/reports/management?year=${encodeURIComponent(state.reportYear)}`);
    const totals = report.totals || {};
    const monthLabels = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
    const byMonth = new Map((report.monthly || []).map((item) => [Number(item.month), item]));
    const maxValue = Math.max(1, ...(report.monthly || []).map((item) => Number(item.quotationValue || 0)));
    appView.innerHTML = `
      <div class="view-enter">
        <section class="report-hero"><div><span class="eyebrow">MANAGEMENT CONTROL</span><h2>Pipeline, hasil, dan risiko quotation.</h2><p>Ringkasan ini berasal dari status quotation yang dicatat tim, termasuk follow-up dan alasan kalah.</p></div><label><span>Tahun laporan</span><select id="report-year">${[0, 1, 2, 3, 4].map((offset) => { const year = new Date().getFullYear() - offset; return `<option value="${year}" ${Number(report.year) === year ? "selected" : ""}>${year}</option>`; }).join("")}</select></label></section>
        <section class="kpi-grid report-kpis"><article class="kpi-card" data-index="01"><span>Total quotation</span><strong>${Number(totals.quotationCount || 0)}</strong><small>${formatMoney(totals.quotationValue || 0)}</small></article><article class="kpi-card" data-index="02"><span>Menang / PO</span><strong>${Number(totals.wonCount || 0)}</strong><small>${formatMoney(totals.wonValue || 0)}</small></article><article class="kpi-card" data-index="03"><span>Win rate</span><strong>${formatNumber(totals.winRate || 0, 1)}%</strong><small>Dari quotation yang sudah diputuskan</small></article><article class="kpi-card" data-index="04"><span>Kecepatan kirim</span><strong>${formatNumber(totals.averageDaysToSend || 0, 1)} hari</strong><small>${Number(report.stalePriceCount || 0)} harga perlu diperbarui</small></article></section>
        <section class="report-grid"><article class="panel"><header class="panel-header"><div><h3>Nilai quotation per bulan</h3><p>Perbandingan nilai seluruh quotation yang dibuat.</p></div></header><div class="monthly-bars">${monthLabels.map((label, index) => { const item = byMonth.get(index + 1) || {}; const height = Math.max(3, Math.round((Number(item.quotationValue || 0) / maxValue) * 100)); return `<div class="month-bar"><div class="month-bar-track"><span style="height:${height}%" title="${formatMoney(item.quotationValue || 0)}"></span></div><strong>${label}</strong><small>${Number(item.quotationCount || 0)}</small></div>`; }).join("")}</div></article><article class="panel"><header class="panel-header"><div><h3>Alasan kalah / batal</h3><p>Dasar perbaikan harga, spesifikasi, dan proses follow-up.</p></div></header><div class="reason-list">${(report.outcomeReasons || []).map((item) => `<div><span>${escapeHtml(item.reason)}</span><strong>${Number(item.total || 0)}</strong></div>`).join("") || `<div class="empty-panel"><strong>Belum ada alasan tercatat</strong>Isi alasan ketika status Kalah atau Dibatalkan.</div>`}</div></article></section>
        <section class="panel"><header class="panel-header"><div><h3>Agenda follow-up</h3><p>Yang terlambat ditampilkan paling awal.</p></div><span class="status-badge status-review">${(report.followUps || []).filter((item) => item.overdue).length} terlambat</span></header><div class="management-list horizontal-list">${(report.followUps || []).map((item) => `<article class="management-row"><div><strong>${escapeHtml(item.qn)} · ${escapeHtml(item.customerName || "Customer belum diisi")}</strong><small>${escapeHtml(item.projectName || "Project belum diisi")} · owner ${escapeHtml(item.workflowOwnerName || "-")}</small></div><span class="follow-up-chip ${item.overdue ? "is-overdue" : ""}">${item.overdue ? "TERLAMBAT · " : item.dueToday ? "HARI INI · " : ""}${escapeHtml(dateDisplay.format(new Date(`${item.followUpAt}T00:00:00`)))}</span><button class="button button-small button-secondary" data-open-quotation="${escapeHtml(item.id)}">Buka</button></article>`).join("") || `<div class="empty-panel"><strong>Tidak ada follow-up aktif</strong></div>`}</div></section>
      </div>`;
  } catch (error) {
    appView.innerHTML = `<div class="empty-panel"><strong>Laporan gagal dimuat</strong>${escapeHtml(error.message)}</div>`;
  }
}

async function openPriceModal() {
  priceModal.hidden = false;
  priceModalSearch.value = "";
  priceModalPackage.value =
    state.current.packageName === "FirePro + PAC"
      ? ""
      : state.current.packageName;
  await searchModalPrices();
  priceModalSearch.focus();
}

function closePriceModal() {
  priceModal.hidden = true;
}

function openManualPrice() {
  state.manualPriceForQuotation = Boolean(
    state.current && (state.view === "editor" || !priceModal.hidden),
  );
  state.manualPriceReturnModal = !priceModal.hidden;
  priceModal.hidden = true;
  manualPriceForm.reset();
  manualPriceForm.elements.snapshotDate.value = new Date()
    .toISOString()
    .slice(0, 10);
  manualPriceForm.elements.category.value = "Material Support";
  manualPriceForm.elements.packageName.value =
    state.current?.packageName === "PAC"
      ? "PAC"
      : state.current?.packageName === "FirePro"
        ? "FirePro"
        : "Material";
  manualPriceModal.hidden = false;
  manualPriceForm.elements.description.focus();
}

function closeManualPrice({ restorePriceModal = true } = {}) {
  manualPriceModal.hidden = true;
  if (restorePriceModal && state.manualPriceReturnModal) {
    priceModal.hidden = false;
  }
  state.manualPriceReturnModal = false;
}

function openLogisticsPrice(code = "") {
  if (!state.bootstrap.capabilities.manageLogisticsPrices) return;
  const item = state.pricePageResults.find((candidate) => candidate.code === code);
  state.logisticsPriceEditCode = item?.code || "";
  logisticsPriceForm.reset();
  logisticsPriceForm.elements.snapshotDate.value = new Date().toISOString().slice(0, 10);
  logisticsPriceForm.elements.category.value = "Material Support";
  if (item) {
    for (const field of ["code", "packageName", "category", "description", "unit", "price", "snapshotDate", "supplier", "evidenceRef", "notes"]) {
      if (logisticsPriceForm.elements[field]) logisticsPriceForm.elements[field].value = item[field] ?? "";
    }
    logisticsPriceForm.elements.code.readOnly = true;
    document.querySelector("#logistics-price-title").textContent =
      item.priceOrigin === "MANUAL_SUPPORT" ? "Verifikasi harga dari Support" : "Perbarui harga stok";
  } else {
    logisticsPriceForm.elements.code.readOnly = false;
    document.querySelector("#logistics-price-title").textContent = "Tambah harga stok";
  }
  logisticsPriceModal.hidden = false;
  (item ? logisticsPriceForm.elements.price : logisticsPriceForm.elements.code).focus();
}

function closeLogisticsPrice() {
  logisticsPriceModal.hidden = true;
  state.logisticsPriceEditCode = "";
}

async function searchModalPrices() {
  priceModalResults.innerHTML = `<div class="loading-state" style="min-height: 220px"><div class="loading-mark"></div></div>`;
  try {
    const result = await api(
      `/api/prices?query=${encodeURIComponent(priceModalSearch.value)}&packageName=${encodeURIComponent(priceModalPackage.value)}&limit=100`,
    );
    state.priceResults = result.items;
    priceModalResults.innerHTML = result.items.length
      ? result.items.map((item) => priceRowMarkup(item, true)).join("")
      : `<div class="empty-panel"><strong>Tidak ada hasil</strong>Coba kata kunci lain.</div>`;
  } catch (error) {
    priceModalResults.innerHTML = `<div class="empty-panel"><strong>Pencarian gagal</strong>${escapeHtml(error.message)}</div>`;
  }
}

function addPriceItem(code) {
  const price = state.priceResults.find((item) => item.code === code);
  if (!price) return;
  const packageName =
    price.packageName === "FirePro" || price.packageName === "PAC"
      ? price.packageName
      : state.current.packageName === "PAC"
        ? "PAC"
        : "FirePro";
  state.current.items.push({
    active: true,
    packageName,
    category: price.category,
    code: price.code,
    description: price.description,
    quantity: 1,
    unit: price.unit,
    sourcePrice: Number(price.price) || 0,
    divisor: 1,
    markupPercent: 0,
    discountPercent: 0,
    overridePrice: "",
    overrideReason: "",
    source: `${price.source} • ${price.snapshotDate || "tanpa tanggal"}`,
    priceOrigin: price.priceOrigin,
    verificationStatus: price.verificationStatus,
    needsReview: Boolean(price.needsReview),
    supplier: price.supplier || "",
    evidenceRef: price.evidenceRef || "",
    sourceSnapshotDate: price.snapshotDate || "",
    rabGroupId: state.activeRabGroupId || "",
  });
  closePriceModal();
  renderEditor();
  scheduleCalculation();
}

function addCustomItem() {
  state.current.items.push({
    active: true,
    packageName: state.current.packageName === "PAC" ? "PAC" : "FirePro",
    category: "Manual",
    code: "",
    description: "",
    quantity: 1,
    unit: "unit",
    sourcePrice: 0,
    divisor: 1,
    markupPercent: 0,
    discountPercent: 0,
    overridePrice: "",
    overrideReason: "",
    source: "Item bebas pada quotation",
    priceOrigin: "MANUAL_SUPPORT",
    verificationStatus: "PERLU_VERIFIKASI_LOGISTIK",
    needsReview: true,
    rabGroupId: state.activeRabGroupId || "",
  });
  renderEditor();
}

function normalizedProductText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

async function addAcesBomToCommercial() {
  const aces = state.current.firepro?.aces ?? {};
  const sourceRows = [
    ...(aces.generators ?? []).map((item) => ({
      key: `generator:${item.code || item.model}`,
      type: "Generator",
      code: item.code,
      model: item.model,
      description: `FirePro Generator ${item.model || item.code}`,
      category: "Equipment",
      quantity: item.quantity,
    })),
    ...(aces.electronics ?? []).map((item) => ({
      key: `electronic:${item.code || item.description}`,
      type: "Electronic",
      code: item.code,
      description: item.description,
      category: item.category || "Equipment",
      quantity: item.quantity,
    })),
  ].filter((item) => item.code || item.description);
  if (!sourceRows.length) {
    toast("BOM ACES masih kosong", "Unggah DOCX ACES atau isi generator terlebih dahulu.", "error");
    return;
  }

  const exactResult = await api("/api/prices/resolve", {
    method: "POST",
    body: JSON.stringify({ codes: sourceRows.map((item) => item.code) }),
  });
  const exactPrices = new Map(exactResult.items.map((item) => [item.code, item]));
  const generatorMatches = new Map();
  await Promise.all(
    sourceRows
      .filter((row) => row.type === "Generator" && !exactPrices.has(row.code))
      .map(async (row) => {
        const searchTerm = String(row.model || "")
          .replace(/([0-9])T$/i, "$1")
          .trim();
        if (!searchTerm) return;
        const result = await api(
          `/api/prices?query=${encodeURIComponent(searchTerm)}&packageName=FirePro&limit=30`,
        );
        const modelKey = normalizedProductText(row.model);
        const match = result.items.find((item) =>
          normalizedProductText(`${item.code} ${item.description}`).includes(modelKey),
        );
        if (match) generatorMatches.set(row.key, match);
      }),
  );

  let matchedCount = 0;
  let missingCount = 0;
  let skippedCount = 0;
  for (const row of sourceRows) {
    if (state.current.items.some((item) => item.acesBomKey === row.key)) {
      skippedCount += 1;
      continue;
    }
    const matched = exactPrices.get(row.code) || generatorMatches.get(row.key);
    if (matched) matchedCount += 1;
    else missingCount += 1;
    state.current.items.push({
      active: true,
      packageName: "FirePro",
      category: matched?.category || row.category,
      code: matched?.code || row.code || "",
      description: matched?.description || row.description,
      quantity: Number(row.quantity) || 1,
      unit: matched?.unit || "unit",
      sourcePrice: Number(matched?.price) || 0,
      divisor: 1,
      markupPercent: 0,
      discountPercent: 0,
      overridePrice: "",
      overrideReason: "",
      source: matched
        ? `${matched.source} • ${matched.snapshotDate || "tanpa tanggal"}`
        : `BOM ACES ${aces.referenceNumber || ""} • harga belum ada di master`,
      priceOrigin: matched?.priceOrigin || "ACES_BOM_BELUM_HARGA",
      verificationStatus:
        matched?.verificationStatus || "PERLU_VERIFIKASI_LOGISTIK",
      needsReview: matched ? Boolean(matched.needsReview) : true,
      supplier: matched?.supplier || "",
      evidenceRef: matched?.evidenceRef || "",
      acesBomKey: row.key,
      acesBomCode: row.code || "",
      rabGroupId: state.activeRabGroupId || "",
    });
  }
  renderEditor();
  scheduleCalculation();
  toast(
    "BOM ACES ditambahkan",
    `${matchedCount} harga cocok • ${missingCount} perlu harga baru${skippedCount ? ` • ${skippedCount} sudah ada` : ""}`,
    missingCount ? "error" : "success",
  );
}

async function importAcesFiles(form) {
  const input = form.elements.acesFiles;
  const files = [...(input?.files ?? [])];
  if (!files.length) {
    throw new Error("Pilih file DOCX atau PDF hasil ACES.");
  }
  const formData = new FormData();
  for (const file of files) formData.append("acesFiles", file);
  await saveCurrentQuotation();
  const result = await api(
    `/api/quotations/${encodeURIComponent(state.current.id)}/aces/import`,
    { method: "POST", body: formData },
  );
  state.current = result.quotation;
  await reloadBootstrap(false);
  renderEditor();
  toast(
    "Hasil ACES tersimpan",
    `${result.imported} file • ${result.parsed ? "data DOCX terbaca otomatis" : "PDF disimpan sebagai bukti"}`,
  );
}

async function reloadBootstrap(render = true) {
  state.bootstrap = await api("/api/bootstrap");
  state.user = state.bootstrap.user;
  applyRoleUi();
  if (render) changeView(state.view);
}

function newCommercialNote(level = 0) {
  return {
    id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    text: "",
    level: level === 1 ? 1 : 0,
    source: "",
  };
}

function newRabGroup(title = "", section = "equipment") {
  return {
    id: `rab-group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    section,
  };
}

function syncManagedTaxNote() {
  const terms = state.current?.terms;
  if (!terms || !Array.isArray(terms.noteItems)) return;
  const note = terms.noteItems.find((item) => item.source === "franco_ppn");
  if (!note) return;
  const franco = String(terms.franco || "Lokasi proyek sesuai kesepakatan").trim();
  note.text = `Harga Franco ${franco} dan ${terms.ppnIncluded ? "sudah" : "belum"} termasuk PPN ${formatNumber(terms.ppnRate)}%.`;
}

document.addEventListener("click", async (event) => {
  const passwordToggle = event.target.closest("[data-toggle-password]");
  if (passwordToggle) {
    const wrapper = passwordToggle.closest(".password-input-wrap");
    const input = wrapper?.querySelector("input");
    if (!input) return;
    const willShow = input.type === "password";
    input.type = willShow ? "text" : "password";
    passwordToggle.textContent = willShow ? "Sembunyikan" : "Lihat";
    passwordToggle.setAttribute("aria-pressed", String(willShow));
    passwordToggle.setAttribute(
      "aria-label",
      `${willShow ? "Sembunyikan" : "Lihat"} ${(passwordToggle.dataset.passwordLabel || "password").toLowerCase()}`,
    );
    wrapper.classList.toggle("is-visible", willShow);
    input.focus();
    return;
  }
  if (event.target === recordModal || event.target.closest("[data-close-record-modal]")) {
    closeRecordModal();
    return;
  }
  if (event.target.closest("#logout-button")) {
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
    } finally {
      state.user = null;
      state.bootstrap = null;
      showLogin("Anda sudah keluar dari aplikasi.");
    }
    return;
  }
  if (event.target === logisticsPriceModal || event.target.closest("[data-close-logistics-price]")) {
    closeLogisticsPrice();
    return;
  }
  if (event.target === workflowModal || event.target.closest("[data-close-workflow]")) {
    workflowModal.hidden = true;
    return;
  }
  if (event.target.closest("[data-open-logistics-price]")) {
    openLogisticsPrice();
    return;
  }
  const editLogisticsPrice = event.target.closest("[data-edit-logistics-price]");
  if (editLogisticsPrice) {
    openLogisticsPrice(editLogisticsPrice.dataset.editLogisticsPrice);
    return;
  }
  const priceHistory = event.target.closest("[data-price-history]");
  if (priceHistory) {
    try {
      const code = priceHistory.dataset.priceHistory;
      const result = await api(`/api/prices/${encodeURIComponent(code)}/history`);
      openRecordModal({ eyebrow: "RIWAYAT HARGA", title: code, subtitle: `${result.items.length} perubahan tercatat`, body: result.items.length ? result.items.map((item) => `<article class="record-row"><div><strong>${formatMoney(item.price)}</strong><small>${escapeHtml(item.source || item.priceOrigin || "Sumber") } · ${formatDateTime(item.createdAt || item.snapshotDate)}</small></div><p>${escapeHtml(item.description || item.supplier || "")}${item.actor ? ` · oleh ${escapeHtml(item.actor)}` : ""}</p></article>`).join("") : `<div class="empty-panel"><strong>Belum ada perubahan harga</strong></div>` });
    } catch (error) {
      toast("Riwayat harga gagal dimuat", error.message, "error");
    }
    return;
  }
  const updateWorkflow = event.target.closest("[data-update-workflow]");
  if (updateWorkflow) {
    openWorkflowEditor(updateWorkflow.dataset.updateWorkflow);
    return;
  }
  const editUser = event.target.closest("[data-edit-user]");
  if (editUser) {
    state.userEditId = editUser.dataset.editUser;
    renderSettings();
    document.querySelector("#user-management-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (event.target.closest("[data-cancel-user-edit]")) {
    state.userEditId = "";
    renderSettings();
    return;
  }
  const resetUser = event.target.closest("[data-reset-user-password]");
  if (resetUser) {
    const password = window.prompt(`Password awal baru untuk ${resetUser.dataset.resetUserName}:\nMinimal 10 karakter dengan huruf besar, huruf kecil, angka, dan simbol.`);
    if (!password) return;
    try {
      await api(`/api/users/${encodeURIComponent(resetUser.dataset.resetUserPassword)}/reset-password`, { method: "POST", body: JSON.stringify({ newPassword: password }) });
      await reloadBootstrap(false);
      renderSettings();
      toast("Password direset", "Pengguna wajib mengganti password setelah login berikutnya.");
    } catch (error) {
      toast("Password belum dapat direset", error.message, "error");
    }
    return;
  }
  const editCustomer = event.target.closest("[data-edit-customer]");
  if (editCustomer) {
    state.customerEditId = editCustomer.dataset.editCustomer;
    renderSettings();
    document.querySelector("#customer-management-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (event.target.closest("[data-cancel-customer-edit]")) {
    state.customerEditId = "";
    renderSettings();
    return;
  }
  const useTemplate = event.target.closest("[data-use-template]");
  if (useTemplate) {
    const template = (state.bootstrap.templates || []).find((item) => item.id === useTemplate.dataset.useTemplate);
    if (template) {
      localStorage.removeItem(localDraftKey());
      state.current = structuredClone(template.payload);
      state.current.id = null;
      state.current.qn = "";
      state.current.date = new Date().toISOString().slice(0, 10);
      state.currentMeta = null;
      state.currentApprovals = [];
      state.currentVersions = [];
      changeView("editor");
      scheduleCalculation();
      toast("Template diterapkan", template.name);
    }
    return;
  }
  const templateActive = event.target.closest("[data-template-active]");
  if (templateActive) {
    try {
      await api(`/api/templates/${encodeURIComponent(templateActive.dataset.templateId)}`, { method: "PUT", body: JSON.stringify({ active: templateActive.dataset.templateActive === "true" }) });
      await reloadBootstrap(false);
      renderSettings();
      toast("Template diarsipkan");
    } catch (error) {
      toast("Template belum diperbarui", error.message, "error");
    }
    return;
  }
  const restoreBackupButton = event.target.closest("[data-restore-backup]");
  if (restoreBackupButton) {
    const backupId = restoreBackupButton.dataset.restoreBackup;
    const confirmation = window.prompt(
      `Pemulihan akan mengganti seluruh data aplikasi dengan kondisi ${backupId}.\n\nSafety backup dibuat otomatis. Ketik ID backup berikut untuk melanjutkan:\n${backupId}`,
    );
    if (confirmation == null) return;
    if (confirmation.trim() !== backupId) {
      toast("Pemulihan dibatalkan", "ID backup yang diketik tidak cocok.", "error");
      return;
    }
    if (!window.confirm("Semua pengguna akan dikeluarkan setelah restore. Lanjutkan pemulihan sekarang?")) return;
    restoreBackupButton.disabled = true;
    restoreBackupButton.textContent = "Memulihkan...";
    try {
      const result = await api(`/api/backups/${encodeURIComponent(backupId)}/restore`, {
        method: "POST",
        body: JSON.stringify({ confirmation: backupId }),
      });
      state.user = null;
      state.bootstrap = null;
      showLogin(`Backup ${result.restoredBackupId} berhasil dipulihkan. Safety backup: ${result.safetyBackupId}. Silakan login kembali.`);
    } catch (error) {
      restoreBackupButton.disabled = false;
      restoreBackupButton.textContent = "Pulihkan";
      toast("Pemulihan gagal", error.message, "error");
    }
    return;
  }
  if (event.target.closest("[data-create-backup]")) {
    const button = event.target.closest("[data-create-backup]");
    button.disabled = true;
    try {
      const { item } = await api("/api/backups", { method: "POST", body: "{}" });
      await reloadBootstrap(false);
      renderSettings();
      if (item.mirror?.status === "GAGAL") {
        toast("Backup lokal tersimpan", `Salinan jaringan gagal: ${item.mirror.error}`, "error");
      } else {
        toast(
          "Backup terverifikasi dibuat",
          item.mirror?.status === "TERVERIFIKASI"
            ? "Database dan lampiran ACES tersimpan lokal serta di jaringan."
            : "Database dan lampiran ACES sudah dicadangkan secara lokal.",
        );
      }
    } catch (error) {
      button.disabled = false;
      toast("Backup gagal", error.message, "error");
    }
    return;
  }
  if (event.target === documentPreviewModal) {
    closeDocumentPreview();
    return;
  }
  const nav = event.target.closest("[data-view]");
  if (nav) {
    changeView(nav.dataset.view, { newQuotation: nav.dataset.view === "editor" });
    return;
  }
  const jump = event.target.closest("[data-view-jump]");
  if (jump) {
    changeView(jump.dataset.viewJump);
    return;
  }
  if (event.target.closest("[data-new-quotation]")) {
    state.current = null;
    changeView("editor", { newQuotation: true });
    return;
  }
  if (event.target.closest("[data-discard-local-draft]")) {
    localStorage.removeItem(localDraftKey());
    state.current = null;
    createNewQuotation();
    toast("Draft lokal dibuang", "Form baru sudah disiapkan.");
    return;
  }
  const duplicateQuotation = event.target.closest("[data-duplicate-quotation]");
  if (duplicateQuotation) {
    event.stopPropagation();
    duplicateQuotation.disabled = true;
    try {
      const { quotation } = await api(`/api/quotations/${encodeURIComponent(duplicateQuotation.dataset.duplicateQuotation)}/duplicate`, { method: "POST", body: JSON.stringify({ keepCustomer: true }) });
      await reloadBootstrap(false);
      toast("Quotation diduplikasi", `${quotation.qn} siap disesuaikan.`);
      await openQuotation(quotation.id);
    } catch (error) {
      duplicateQuotation.disabled = false;
      toast("Quotation belum dapat diduplikasi", error.message, "error");
    }
    return;
  }
  const restoreQuotation = event.target.closest("[data-restore-quotation]");
  if (restoreQuotation) {
    restoreQuotation.disabled = true;
    try {
      const { quotation } = await api(`/api/quotations/${encodeURIComponent(restoreQuotation.dataset.restoreQuotation)}/restore`, { method: "POST", body: "{}" });
      await reloadBootstrap(false);
      await renderHistory();
      toast("Draft dipulihkan", quotation.qn || "Draft tanpa nomor");
    } catch (error) {
      restoreQuotation.disabled = false;
      toast("Draft belum dapat dipulihkan", error.message, "error");
    }
    return;
  }
  const deleteDraft = event.target.closest("[data-delete-draft]");
  if (deleteDraft) {
    event.stopPropagation();
    const qn = deleteDraft.dataset.deleteDraftQn;
    const confirmed = window.confirm(
      `Hapus draft ${qn}?\n\nDraft akan hilang dari daftar. Jika sudah memiliki nomor resmi, nomor tersebut tetap tercatat sebagai BATAL agar tidak digunakan ulang.`,
    );
    if (!confirmed) return;
    deleteDraft.disabled = true;
    try {
      const result = await api(
        `/api/quotations/${encodeURIComponent(deleteDraft.dataset.deleteDraft)}`,
        { method: "DELETE" },
      );
      if (state.current?.id === deleteDraft.dataset.deleteDraft) {
        state.current = null;
      }
      await reloadBootstrap(false);
      changeView(state.view === "editor" ? "history" : state.view);
      toast("Draft quotation dihapus", `${result.quotation.qn} • nomor tidak akan dipakai ulang`);
    } catch (error) {
      deleteDraft.disabled = false;
      toast("Draft tidak dapat dihapus", error.message, "error");
    }
    return;
  }
  const open = event.target.closest("[data-open-quotation]");
  if (open) {
    await openQuotation(open.dataset.openQuotation);
    return;
  }
  if (event.target.closest("[data-save-quotation]")) {
    try {
      await saveCurrentQuotation();
    } catch (error) {
      toast("Gagal menyimpan", error.message, "error");
    }
    return;
  }
  if (event.target.closest("[data-save-template]")) {
    const name = window.prompt("Nama template quotation:", `${state.current.packageName} - ${state.current.project?.name || "Template"}`);
    if (!name) return;
    const description = window.prompt("Keterangan singkat template (opsional):", "") || "";
    try {
      await api("/api/templates", { method: "POST", body: JSON.stringify({ name, description, quotation: state.current }) });
      await reloadBootstrap(false);
      renderEditor();
      toast("Template disimpan", name);
    } catch (error) {
      toast("Template belum tersimpan", error.message, "error");
    }
    return;
  }
  if (event.target.closest("[data-create-revision]")) {
    const note = window.prompt("Alasan membuat revisi baru:", "Perubahan kebutuhan customer");
    if (!note) return;
    try {
      const result = await api(`/api/quotations/${encodeURIComponent(state.current.id)}/revisions`, { method: "POST", body: JSON.stringify({ note }) });
      state.current = result.quotation;
      const fresh = await api(`/api/quotations/${encodeURIComponent(state.current.id)}`);
      state.currentMeta = fresh.meta;
      state.currentApprovals = fresh.approvals || [];
      state.currentVersions = fresh.versions || [];
      await reloadBootstrap(false);
      renderEditor();
      toast("Revisi baru dibuat", `Sekarang revisi ${state.current.revision}.`);
    } catch (error) {
      toast("Revisi belum dapat dibuat", error.message, "error");
    }
    return;
  }
  if (event.target.closest("[data-request-approvals]")) {
    try {
      const result = await api(`/api/quotations/${encodeURIComponent(state.current.id)}/approvals/request`, { method: "POST", body: "{}" });
      state.currentApprovals = result.items || [];
      const fresh = await api(`/api/quotations/${encodeURIComponent(state.current.id)}`);
      state.currentMeta = fresh.meta;
      await reloadBootstrap(false);
      renderEditor();
      toast("Approval diajukan", "Status berpindah ke Review Internal.");
    } catch (error) {
      toast("Approval belum dapat diajukan", error.message, "error");
    }
    return;
  }
  const approvalDecision = event.target.closest("[data-approval-decision]");
  if (approvalDecision) {
    const decision = approvalDecision.dataset.approvalDecision;
    const type = approvalDecision.dataset.approvalType;
    const note = window.prompt(decision === "REJECTED" ? "Alasan penolakan (wajib):" : "Catatan approval (opsional):", "");
    if (decision === "REJECTED" && !note) return;
    try {
      const result = await api(`/api/quotations/${encodeURIComponent(state.current.id)}/approvals/${encodeURIComponent(type)}`, { method: "PUT", body: JSON.stringify({ status: decision, note: note || "" }) });
      state.currentApprovals = result.items || [];
      renderEditor();
      toast("Keputusan approval tersimpan", `${approvalLabels[type] || type} · ${decision}`);
    } catch (error) {
      toast("Approval belum tersimpan", error.message, "error");
    }
    return;
  }
  if (event.target.closest("[data-show-versions]")) {
    openRecordModal({ eyebrow: "RIWAYAT REVISI", title: state.current.qn || "Quotation", subtitle: `Revisi aktif ${state.current.revision || 0}`, body: state.currentVersions.length ? state.currentVersions.map((item) => `<article class="record-row"><div><strong>Revisi ${Number(item.revision || 0)}</strong><small>${formatDateTime(item.createdAt)} · ${escapeHtml(item.createdBy)}</small></div><p>${escapeHtml(item.note || "Snapshot sebelum revisi berikutnya")}</p></article>`).join("") : `<div class="empty-panel"><strong>Belum ada versi lama</strong>Versi tersimpan saat revisi baru dibuat.</div>` });
    return;
  }
  if (event.target.closest("[data-open-document-preview]")) {
    try {
      await openDocumentPreview();
    } catch (error) {
      toast("Preview belum dapat dibuat", error.message, "error");
    }
    return;
  }
  if (event.target.closest("[data-close-document-preview]")) {
    closeDocumentPreview();
    return;
  }
  const previewTab = event.target.closest("[data-preview-tab]");
  if (previewTab) {
    state.previewTab = previewTab.dataset.previewTab;
    renderDocumentPreview();
    return;
  }
  const exportButton = event.target.closest("[data-export]");
  if (exportButton) {
    await exportCurrent(exportButton.dataset.export);
    return;
  }
  if (event.target.closest("[data-print-document]")) {
    await printCurrentDocument();
    return;
  }
  const qnBook = event.target.closest("[data-qn-book]");
  if (qnBook) {
    state.qnBook.series = qnBook.dataset.qnBook;
    state.qnBook.query = "";
    state.qnEditItem = null;
    await renderHistory();
    return;
  }
  const editQn = event.target.closest("[data-edit-qn]");
  if (editQn) {
    event.stopPropagation();
    state.qnEditItem = state.qnBookItems.find(
      (item) => item.id === editQn.dataset.editQn,
    );
    await renderHistory();
    document.querySelector("#manual-qn-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (event.target.closest("[data-cancel-qn-edit]")) {
    state.qnEditItem = null;
    await renderHistory();
    return;
  }
  const deleteQn = event.target.closest("[data-delete-qn]");
  if (deleteQn) {
    event.stopPropagation();
    const quotationNumber = deleteQn.dataset.deleteQnNumber;
    const confirmed = window.confirm(
      `Hapus ${quotationNumber} dari Buku QN?\n\nGunakan hanya jika catatan manual ini memang salah input.`,
    );
    if (!confirmed) return;
    deleteQn.disabled = true;
    try {
      const result = await api(
        `/api/quotation-numbers/${encodeURIComponent(deleteQn.dataset.deleteQn)}`,
        { method: "DELETE" },
      );
      await reloadBootstrap(false);
      await renderHistory();
      toast("Catatan Buku QN dihapus", result.item.quotationNumber);
    } catch (error) {
      deleteQn.disabled = false;
      toast("Catatan tidak dapat dihapus", error.message, "error");
    }
    return;
  }
  if (event.target.closest("[data-add-room]")) {
    state.current.firepro.rooms.push({
      name: "",
      length: 0,
      width: 0,
      height: 0,
      raisedFloor: 0,
      falseCeiling: 0,
      fireClass: 46,
      safetyFactor: 1.3,
    });
    renderEditor();
    return;
  }
  const removeRoom = event.target.closest("[data-remove-room]");
  if (removeRoom) {
    state.current.firepro.rooms.splice(Number(removeRoom.dataset.removeRoom), 1);
    renderEditor();
    scheduleCalculation();
    return;
  }
  if (event.target.closest("[data-add-aces-generator]")) {
    state.current.firepro.aces.generators.push({
      code: "",
      model: "",
      dischargeTemperature: "",
      effectiveMass: 0,
      quantity: 1,
      totalConcentration: 0,
    });
    renderEditor();
    return;
  }
  const removeGenerator = event.target.closest("[data-remove-aces-generator]");
  if (removeGenerator) {
    state.current.firepro.aces.generators.splice(
      Number(removeGenerator.dataset.removeAcesGenerator),
      1,
    );
    renderEditor();
    scheduleCalculation();
    return;
  }
  if (event.target.closest("[data-add-aces-bom]")) {
    try {
      await addAcesBomToCommercial();
    } catch (error) {
      toast("BOM belum dapat ditambahkan", error.message, "error");
    }
    return;
  }
  if (event.target.closest("[data-open-price-modal]")) {
    await openPriceModal();
    return;
  }
  if (event.target.closest("[data-open-manual-price]")) {
    openManualPrice();
    return;
  }
  if (event.target.closest("[data-add-custom-item]")) {
    addCustomItem();
    return;
  }
  if (event.target.closest("[data-add-rab-group]")) {
    const group = newRabGroup();
    state.current.rabGroups.push(group);
    state.activeRabGroupId = group.id;
    renderEditor();
    document.querySelector(`[data-rab-group-index="${state.current.rabGroups.length - 1}"][data-rab-group-field="title"]`)?.focus();
    scheduleCalculation();
    return;
  }
  if (event.target.closest("[data-import-room-groups]")) {
    const knownTitles = new Set(
      state.current.rabGroups.map((group) => group.title.trim().toLowerCase()),
    );
    const roomNames = (state.current.firepro?.rooms ?? [])
      .map((room) => String(room.name || "").trim())
      .filter(Boolean);
    let added = 0;
    for (const roomName of roomNames) {
      if (knownTitles.has(roomName.toLowerCase())) continue;
      const group = newRabGroup(roomName.toUpperCase(), "equipment");
      state.current.rabGroups.push(group);
      state.activeRabGroupId = group.id;
      knownTitles.add(roomName.toLowerCase());
      added += 1;
    }
    renderEditor();
    scheduleCalculation();
    toast(
      added ? "Judul ruang ditambahkan" : "Tidak ada judul baru",
      added ? `${added} nama ruang masuk ke struktur RAB.` : "Isi nama ruang FirePro atau periksa judul yang sudah ada.",
      added ? "success" : "error",
    );
    return;
  }
  const useRabGroup = event.target.closest("[data-use-rab-group]");
  if (useRabGroup) {
    state.activeRabGroupId = useRabGroup.dataset.useRabGroup;
    renderEditor();
    return;
  }
  if (event.target.closest("[data-clear-active-rab-group]")) {
    state.activeRabGroupId = "";
    renderEditor();
    return;
  }
  const moveRabGroup = event.target.closest("[data-move-rab-group]");
  if (moveRabGroup) {
    const sourceIndex = Number(moveRabGroup.dataset.rabGroupActionIndex);
    const targetIndex = sourceIndex + Number(moveRabGroup.dataset.moveRabGroup);
    const groups = state.current.rabGroups;
    if (targetIndex >= 0 && targetIndex < groups.length) {
      [groups[sourceIndex], groups[targetIndex]] = [groups[targetIndex], groups[sourceIndex]];
      renderEditor();
      scheduleCalculation();
    }
    return;
  }
  const removeRabGroup = event.target.closest("[data-remove-rab-group]");
  if (removeRabGroup) {
    const index = Number(removeRabGroup.dataset.removeRabGroup);
    const [removed] = state.current.rabGroups.splice(index, 1);
    state.current.items.forEach((item) => {
      if (item.rabGroupId === removed?.id) item.rabGroupId = "";
    });
    if (state.activeRabGroupId === removed?.id) state.activeRabGroupId = "";
    renderEditor();
    scheduleCalculation();
    toast("Judul RAB dihapus", "Itemnya tetap ada dan dipindahkan ke bagian utama.");
    return;
  }
  const addNote = event.target.closest("[data-add-note]");
  if (addNote) {
    const noteItems = state.current.terms.noteItems;
    const requestedSubnote = addNote.dataset.addNote === "sub";
    const hasMainNote = noteItems.some((item) => Number(item.level) !== 1);
    noteItems.push(newCommercialNote(requestedSubnote && hasMainNote ? 1 : 0));
    renderEditor();
    document.querySelector('.terms-note-item:last-child [data-note-field="text"]')?.focus();
    scheduleCalculation();
    return;
  }
  const removeNote = event.target.closest("[data-remove-note]");
  if (removeNote) {
    state.current.terms.noteItems.splice(Number(removeNote.dataset.removeNote), 1);
    renderEditor();
    scheduleCalculation();
    return;
  }
  const moveNote = event.target.closest("[data-move-note]");
  if (moveNote) {
    const sourceIndex = Number(moveNote.dataset.noteActionIndex);
    const targetIndex = sourceIndex + Number(moveNote.dataset.moveNote);
    const items = state.current.terms.noteItems;
    if (targetIndex >= 0 && targetIndex < items.length) {
      [items[sourceIndex], items[targetIndex]] = [items[targetIndex], items[sourceIndex]];
      renderEditor();
      scheduleCalculation();
    }
    return;
  }
  const removeItem = event.target.closest("[data-remove-item]");
  if (removeItem) {
    state.current.items.splice(Number(removeItem.dataset.removeItem), 1);
    renderEditor();
    scheduleCalculation();
    return;
  }
  const selectedPrice = event.target.closest("[data-select-price]");
  if (selectedPrice) {
    addPriceItem(selectedPrice.dataset.selectPrice);
    return;
  }
  if (event.target.closest("[data-close-modal]") || event.target === priceModal) {
    closePriceModal();
    return;
  }
  if (
    event.target.closest("[data-close-manual-price]") ||
    event.target === manualPriceModal
  ) {
    closeManualPrice();
  }
});

document.addEventListener("input", (event) => {
  const rabGroupInput = event.target.closest(
    "[data-rab-group-index][data-rab-group-field]",
  );
  if (rabGroupInput && state.current) {
    const group = state.current.rabGroups[Number(rabGroupInput.dataset.rabGroupIndex)];
    if (!group) return;
    group[rabGroupInput.dataset.rabGroupField] = rabGroupInput.value;
    scheduleCalculation();
    return;
  }
  const noteInput = event.target.closest("[data-note-index][data-note-field]");
  if (noteInput && state.current) {
    const index = Number(noteInput.dataset.noteIndex);
    const note = state.current.terms.noteItems[index];
    if (!note) return;
    if (noteInput.dataset.noteField === "level") {
      const hasParent = state.current.terms.noteItems
        .slice(0, index)
        .some((item) => Number(item.level) !== 1);
      note.level = noteInput.value === "1" && hasParent ? 1 : 0;
      if (String(note.level) !== noteInput.value) noteInput.value = String(note.level);
      renderEditor();
    } else {
      note.text = noteInput.value;
      note.source = "";
    }
    scheduleCalculation();
    return;
  }
  const pathInput = event.target.closest("[data-path]");
  if (pathInput && state.current) {
    if (pathInput.dataset.path === "qnCreatorInitials") {
      pathInput.value = pathInput.value
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 5);
    }
    setByPath(state.current, pathInput.dataset.path, inputValue(pathInput));
    if (
      pathInput.dataset.path === "terms.ppnIncluded" ||
      pathInput.dataset.path === "terms.ppnRate"
    ) {
      syncManagedTaxNote();
    }
    scheduleCalculation();
    return;
  }
  const generatorInput = event.target.closest("[data-aces-generator-index]");
  if (generatorInput && state.current) {
    const generator =
      state.current.firepro.aces.generators[
        Number(generatorInput.dataset.acesGeneratorIndex)
      ];
    const fieldName = generatorInput.dataset.acesGeneratorField;
    generator[fieldName] =
      generatorInput.type === "number"
        ? Number(generatorInput.value) || 0
        : generatorInput.value;
    if (fieldName === "effectiveMass" || fieldName === "quantity") {
      generator.totalConcentration =
        (Number(generator.effectiveMass) || 0) *
        (Number(generator.quantity) || 0);
      const totalInput = document.querySelector(
        `[data-aces-generator-index="${generatorInput.dataset.acesGeneratorIndex}"][data-aces-generator-field="totalConcentration"]`,
      );
      if (totalInput) totalInput.value = generator.totalConcentration;
    }
    scheduleCalculation();
    return;
  }
  const itemInput = event.target.closest("[data-item-index]");
  if (itemInput && state.current) {
    const item = state.current.items[Number(itemInput.dataset.itemIndex)];
    const fieldName = itemInput.dataset.itemField;
    item[fieldName] =
      itemInput.type === "number"
        ? itemInput.value === ""
          ? ""
          : Number(itemInput.value)
        : itemInput.value;
    scheduleCalculation();
    return;
  }
  const roomInput = event.target.closest("[data-room-index]");
  if (roomInput && state.current) {
    const room = state.current.firepro.rooms[Number(roomInput.dataset.roomIndex)];
    room[roomInput.dataset.roomField] =
      roomInput.type === "number"
        ? Number(roomInput.value) || 0
        : roomInput.value;
    scheduleCalculation();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !recordModal.hidden) {
    closeRecordModal();
    return;
  }
  if (event.key === "Escape" && !logisticsPriceModal.hidden) {
    closeLogisticsPrice();
    return;
  }
  if (event.key === "Escape" && !workflowModal.hidden) {
    workflowModal.hidden = true;
    return;
  }
  if (event.key === "Escape" && !documentPreviewModal.hidden) {
    closeDocumentPreview();
    return;
  }
  const itemControl = event.target.closest(
    "#commercial-items-body [data-item-index][data-item-field]",
  );
  if (
    !itemControl ||
    event.key !== "Enter" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  ) {
    return;
  }

  const controls = [
    ...document.querySelectorAll(
      "#commercial-items-body [data-item-index][data-item-field]",
    ),
  ].filter((control) => !control.disabled && control.tabIndex !== -1);
  const currentIndex = controls.indexOf(itemControl);
  const targetIndex = currentIndex + (event.shiftKey ? -1 : 1);
  const target = controls[targetIndex];
  if (!target) return;

  event.preventDefault();
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (target instanceof HTMLInputElement) {
    target.select();
  }
});

document.addEventListener("change", (event) => {
  const quantityInput = event.target.closest(
    '[data-item-field="quantity"][data-item-index]',
  );
  if (quantityInput && state.current) {
    const quantity = Math.max(1, Math.round(Number(quantityInput.value) || 1));
    quantityInput.value = String(quantity);
    state.current.items[Number(quantityInput.dataset.itemIndex)].quantity =
      quantity;
    scheduleCalculation();
    return;
  }
  if (event.target.matches("[data-package-option]")) {
    state.current.packageName = event.target.value;
    renderEditor();
    scheduleCalculation();
    return;
  }
  if (event.target.matches("[data-mode-option]")) {
    state.current.mode = event.target.value;
    scheduleCalculation();
    return;
  }
  if (event.target.matches("[data-load-customer]")) {
    const customer = (state.bootstrap.customers || []).find((item) => item.id === event.target.value);
    if (customer && state.current) {
      state.current.customer = {
        ...state.current.customer,
        name: customer.name || "",
        address: customer.address || "",
        pic: customer.picName || "",
        email: customer.email || "",
        phone: customer.phone || "",
      };
      state.current.project = {
        ...state.current.project,
        name: customer.lastProjectName || state.current.project?.name || "",
        location: customer.lastProjectLocation || state.current.project?.location || "",
      };
      renderEditor();
      scheduleCalculation();
    }
    return;
  }
  if (event.target.matches("[data-apply-template]")) {
    const template = (state.bootstrap.templates || []).find((item) => item.id === event.target.value);
    if (template) {
      state.current = structuredClone(template.payload);
      state.current.id = null;
      state.current.qn = "";
      state.current.date = new Date().toISOString().slice(0, 10);
      state.currentMeta = null;
      state.currentApprovals = [];
      state.currentVersions = [];
      renderEditor();
      scheduleCalculation();
      toast("Template diterapkan", template.name);
    }
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.matches("#login-form")) {
    event.preventDefault();
    const button = form.querySelector("button[type='submit']");
    loginError.hidden = true;
    button.disabled = true;
    button.textContent = "Memeriksa akun...";
    try {
      const payload = Object.fromEntries(new FormData(form));
      payload.rememberMe = form.elements.rememberMe.checked;
      const result = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      state.user = result.user;
      if (payload.rememberMe) {
        localStorage.setItem(
          rememberedUsernameKey,
          String(payload.username || "").trim().toLowerCase(),
        );
      } else {
        localStorage.removeItem(rememberedUsernameKey);
      }
      form.reset();
      await loadWorkspace();
    } catch (error) {
      loginError.textContent = error.message;
      loginError.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = "Masuk";
    }
    return;
  }
  if (form.matches("#logistics-price-form")) {
    event.preventDefault();
    const button = form.querySelector("button[type='submit']");
    button.disabled = true;
    button.textContent = "Menyimpan...";
    try {
      const payload = Object.fromEntries(new FormData(form));
      payload.price = Number(payload.price);
      const endpoint = state.logisticsPriceEditCode
        ? `/api/prices/${encodeURIComponent(state.logisticsPriceEditCode)}/logistics`
        : "/api/prices/logistics";
      const result = await api(endpoint, {
        method: state.logisticsPriceEditCode ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      closeLogisticsPrice();
      await reloadBootstrap(false);
      await renderPrices();
      toast("Master harga Logistik tersimpan", `${result.item.code} · ${formatMoney(result.item.price)}`);
    } catch (error) {
      toast("Harga Logistik belum tersimpan", error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "Simpan ke master Logistik";
    }
    return;
  }
  if (form.matches("#workflow-form")) {
    event.preventDefault();
    const button = form.querySelector("button[type='submit']");
    button.disabled = true;
    try {
      const payload = Object.fromEntries(new FormData(form));
      const result = await api(`/api/quotations/${encodeURIComponent(payload.quotationId)}/workflow`, {
        method: "PUT",
        body: JSON.stringify({
          status: payload.status,
          note: payload.note,
          followUpAt: payload.followUpAt,
          outcomeReason: payload.outcomeReason,
        }),
      });
      workflowModal.hidden = true;
      await reloadBootstrap(false);
      await renderTracking();
      toast("Progres quotation diperbarui", `${result.item.qn} · ${workflowLabels[result.item.workflowStatus]}`);
    } catch (error) {
      toast("Progres belum tersimpan", error.message, "error");
    } finally {
      button.disabled = false;
    }
    return;
  }
  if (form.matches("#backup-settings-form")) {
    event.preventDefault();
    const button = form.querySelector("button[type='submit']");
    button.disabled = true;
    button.textContent = "Menguji lokasi...";
    try {
      const payload = Object.fromEntries(new FormData(form));
      payload.backupRetentionDays = Number(payload.backupRetentionDays);
      const { config } = await api("/api/backups/settings", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      await reloadBootstrap(false);
      renderSettings();
      toast(
        "Pengaturan backup tersimpan",
        config.mirrorConfigured
          ? "Folder jaringan dapat ditulis. Buat backup untuk menguji salinan lengkap."
          : "Salinan jaringan dinonaktifkan; backup lokal tetap berjalan.",
      );
    } catch (error) {
      button.disabled = false;
      button.textContent = "Simpan & uji lokasi";
      toast("Lokasi backup belum tersimpan", error.message, "error");
    }
    return;
  }
  if (form.matches("#user-management-form")) {
    event.preventDefault();
    const button = form.querySelector("button[type='submit']");
    button.disabled = true;
    try {
      const payload = Object.fromEntries(new FormData(form));
      const id = payload.id;
      delete payload.id;
      payload.active = payload.active === "true";
      const result = await api(id ? `/api/users/${encodeURIComponent(id)}` : "/api/users", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      if (result.loginRequired) {
        localStorage.setItem(rememberedUsernameKey, result.user.username);
        state.user = null;
        state.bootstrap = null;
        showLogin(`Username berhasil diubah menjadi @${result.user.username}. Silakan login kembali.`);
        return;
      }
      state.userEditId = "";
      await reloadBootstrap(false);
      renderSettings();
      toast(
        id ? "Akun diperbarui" : "Akun dibuat",
        result.usernameChanged
          ? `Username baru @${result.user.username}. Sesi lama pengguna sudah dicabut.`
          : "Hak akses langsung mengikuti role yang dipilih.",
      );
    } catch (error) {
      button.disabled = false;
      toast("Akun belum tersimpan", error.message, "error");
    }
    return;
  }
  if (form.matches("#customer-management-form")) {
    event.preventDefault();
    const button = form.querySelector("button[type='submit']");
    button.disabled = true;
    try {
      const payload = Object.fromEntries(new FormData(form));
      const id = payload.id;
      delete payload.id;
      payload.active = payload.active === "true";
      await api(id ? `/api/customers/${encodeURIComponent(id)}` : "/api/customers", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      state.customerEditId = "";
      await reloadBootstrap(false);
      renderSettings();
      toast(id ? "Customer diperbarui" : "Customer ditambahkan");
    } catch (error) {
      button.disabled = false;
      toast("Customer belum tersimpan", error.message, "error");
    }
    return;
  }
  if (form.matches("#change-password-form")) {
    event.preventDefault();
    const button = form.querySelector("button[type='submit']");
    button.disabled = true;
    try {
      const payload = Object.fromEntries(new FormData(form));
      await api("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      state.user = null;
      state.bootstrap = null;
      showLogin("Password berhasil diganti. Silakan login menggunakan password baru.");
    } catch (error) {
      toast("Password belum diganti", error.message, "error");
      button.disabled = false;
    }
    return;
  }
  if (form.matches("#manual-qn-form")) {
    event.preventDefault();
    const button = form.querySelector("button[type='submit']");
    button.disabled = true;
    button.textContent = "Menyimpan...";
    try {
      const payload = Object.fromEntries(new FormData(form));
      payload.sequenceNumber = Number(payload.sequenceNumber);
      const editId = state.qnEditItem?.id;
      const result = await api(
        editId
          ? `/api/quotation-numbers/${encodeURIComponent(editId)}`
          : "/api/quotation-numbers/manual",
        {
        method: editId ? "PUT" : "POST",
        body: JSON.stringify(payload),
        },
      );
      state.qnBook.series = result.item.series;
      state.qnBook.year = result.item.quotationYear;
      state.qnBook.query = "";
      state.qnEditItem = null;
      await reloadBootstrap(false);
      await renderHistory();
      toast(editId ? "Catatan QN diperbarui" : "Nomor QN tersimpan", `${result.item.quotationNumber} • ${result.item.customerName}`);
    } catch (error) {
      toast("Nomor QN belum tersimpan", error.message, "error");
      button.disabled = false;
      button.textContent = state.qnEditItem ? "Simpan perubahan" : "Simpan ke Buku QN";
    }
    return;
  }
  if (form.matches("#creator-master-form")) {
    event.preventDefault();
    const button = form.querySelector("button[type='submit']");
    button.disabled = true;
    try {
      const payload = Object.fromEntries(new FormData(form));
      payload.creatorInitials = String(payload.creatorInitials || "").toUpperCase();
      const result = await api("/api/quotation-creators", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await reloadBootstrap(false);
      await renderHistory();
      toast("Pembuat QN ditambahkan", `${result.item.creatorName} • ${result.item.creatorInitials}`);
    } catch (error) {
      button.disabled = false;
      toast("Pembuat QN belum ditambahkan", error.message, "error");
    }
    return;
  }
  if (form.matches("#aces-import-form")) {
    event.preventDefault();
    const button = form.querySelector("button[type='submit']");
    button.disabled = true;
    button.textContent = "Membaca ACES...";
    try {
      await importAcesFiles(form);
    } catch (error) {
      toast("Import ACES gagal", error.message, "error");
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = "Unggah ACES";
      }
    }
    return;
  }

  if (form.matches("#manual-price-form")) {
    event.preventDefault();
    const button = form.querySelector("button[type='submit']");
    button.disabled = true;
    button.textContent = "Menyimpan...";
    try {
      const payload = Object.fromEntries(new FormData(form));
      payload.price = Number(payload.price);
      const result = await api("/api/prices/manual", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const addToQuotation = state.manualPriceForQuotation;
      closeManualPrice({ restorePriceModal: false });
      await reloadBootstrap(false);
      if (addToQuotation && state.current) {
        state.priceResults = [result.item];
        addPriceItem(result.item.code);
        toast(
          "Harga manual ditambahkan",
          `${result.item.code} • tetap perlu verifikasi Logistik`,
        );
      } else {
        await renderPrices();
        toast(
          "Harga manual tersimpan",
          `${result.item.code} • perlu verifikasi Logistik`,
        );
      }
    } catch (error) {
      toast("Harga manual belum tersimpan", error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "Simpan harga manual";
    }
    return;
  }

  if (form.matches("#price-import-form")) {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    button.textContent = "Mengimpor...";
    try {
      const result = await api("/api/prices/import", {
        method: "POST",
        body: new FormData(form),
      });
      toast("Pricelist diperbarui", `${result.imported} baris • snapshot ${result.snapshotDate}`);
      await reloadBootstrap(false);
      await renderPrices();
    } catch (error) {
      toast("Import gagal", error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "Import .xlsx";
    }
  }
});

let modalSearchTimer;
let qnBookSearchTimer;
let trackingSearchTimer;
priceModalSearch.addEventListener("input", () => {
  window.clearTimeout(modalSearchTimer);
  modalSearchTimer = window.setTimeout(searchModalPrices, 220);
});
priceModalPackage.addEventListener("change", searchModalPrices);

document.addEventListener("input", (event) => {
  if (event.target.id === "tracking-search") {
    state.trackingFilter.query = event.target.value;
    window.clearTimeout(trackingSearchTimer);
    trackingSearchTimer = window.setTimeout(loadTracking, 260);
  }
  if (event.target.id === "price-page-search") {
    window.clearTimeout(modalSearchTimer);
    modalSearchTimer = window.setTimeout(searchPricePage, 220);
  }
  if (event.target.id === "qn-book-search") {
    state.qnBook.query = event.target.value;
    window.clearTimeout(qnBookSearchTimer);
    qnBookSearchTimer = window.setTimeout(renderHistory, 260);
  }
  if (event.target.id === "manual-qn-initials") {
    event.target.value = event.target.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 5);
    const preview = document.querySelector("#manual-qn-format");
    if (preview) {
      const form = event.target.form;
      const series = form?.elements.series?.value || state.qnBook.series;
      const sequence = Number(form?.elements.sequenceNumber?.value);
      preview.textContent = `QN/${series}-${event.target.value || "..."}/${sequence > 0 ? String(sequence).padStart(3, "0") : "..."}`;
    }
  }
  if (event.target.matches('#manual-qn-form input[name="sequenceNumber"]')) {
    const form = event.target.form;
    const preview = document.querySelector("#manual-qn-format");
    if (preview) {
      const sequence = Number(event.target.value);
      preview.textContent = `QN/${form.elements.series.value}-${form.elements.creatorInitials.value || "..."}/${sequence > 0 ? String(sequence).padStart(3, "0") : "..."}`;
    }
  }
});
document.addEventListener("change", (event) => {
  if (event.target.id === "report-year") {
    state.reportYear = Number(event.target.value);
    renderReports();
  }
  if (event.target.id === "tracking-status") {
    state.trackingFilter.status = event.target.value;
    loadTracking();
  }
  if (event.target.id === "tracking-package") {
    state.trackingFilter.packageName = event.target.value;
    loadTracking();
  }
  if (event.target.id === "price-page-package") searchPricePage();
  if (event.target.id === "qn-year-filter") {
    state.qnBook.year = Number(event.target.value);
    state.qnBook.query = "";
    state.qnEditItem = null;
    renderHistory();
  }
  if (event.target.id === "manual-qn-creator") {
    const selected = event.target.selectedOptions[0];
    const initialsInput = document.querySelector("#manual-qn-initials");
    if (initialsInput && selected?.dataset.initials) {
      initialsInput.value = selected.dataset.initials;
      initialsInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  if (event.target.matches('#manual-qn-form select[name="series"]')) {
    const initials = document.querySelector("#manual-qn-initials")?.value || "...";
    const preview = document.querySelector("#manual-qn-format");
    if (preview) {
      preview.textContent = `QN/${event.target.value}-${initials}/...`;
    }
  }
});

document.querySelector("#mobile-menu").addEventListener("click", () => {
  document.body.classList.toggle("menu-open");
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) concealPasswordFields(document);
});

async function init() {
  enhancePasswordControls(loginForm);
  try {
    const session = await api("/api/auth/session");
    if (!session.authenticated) {
      showLogin();
      return;
    }
    state.user = session.user;
    await loadWorkspace();
  } catch (error) {
    serverState.textContent = "Server tidak terhubung";
    showLogin(`Server belum dapat dihubungi: ${error.message}`);
  }
}

init();
