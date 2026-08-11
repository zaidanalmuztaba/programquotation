import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import multer from "multer";
import {
  calculateQuotation,
  createEmptyQuotation,
} from "./lib/calculation.js";
import { createStore } from "./lib/database.js";
import {
  buildDocxBuffer,
  buildPdfBuffer,
  safeDownloadName,
} from "./lib/exporters.js";
import { parseAcesDocx } from "./lib/aces-import.js";
import { parseSupportPricelist } from "./lib/xlsx-import.js";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(appDir, "public");
const seedPath = path.join(appDir, "seed", "price-master.json");
const dataDir = process.env.QUOTATION_DATA_DIR
  ? path.resolve(process.env.QUOTATION_DATA_DIR)
  : path.join(appDir, "data");
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3180);
const store = createStore({ dataDir, seedPath });
const priceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});
const acesUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 4 },
});
const acesDataDir = path.join(dataDir, "aces");
const backupsDataDir = path.join(dataDir, "backups");
const sessionCookieName = "mnn_quotation_session";
const standardSessionSeconds = 12 * 60 * 60;
const rememberedSessionSeconds = 30 * 24 * 60 * 60;
const loginAttempts = new Map();
let backupInProgress = null;

function backupTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function listBackups() {
  if (!fs.existsSync(backupsDataDir)) return [];
  return fs.readdirSync(backupsDataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = path.join(backupsDataDir, entry.name);
      const manifestPath = path.join(directory, "manifest.json");
      if (!fs.existsSync(manifestPath)) return null;
      try {
        return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

async function performBackup(reason = "MANUAL", actor = "System") {
  if (backupInProgress) return backupInProgress;
  backupInProgress = (async () => {
    const createdAt = new Date().toISOString();
    const backupId = `backup-${backupTimestamp(new Date(createdAt))}`;
    const directory = path.join(backupsDataDir, backupId);
    const databasePath = path.join(directory, "quotation-internal.db");
    fs.mkdirSync(directory, { recursive: true });
    const result = await store.backupDatabase(databasePath);
    const verification = new DatabaseSync(databasePath, { readOnly: true });
    const integrity = verification.prepare("PRAGMA integrity_check").get()?.integrity_check;
    const counts = {
      quotations: Number(verification.prepare("SELECT COUNT(*) AS total FROM quotations").get().total),
      prices: Number(verification.prepare("SELECT COUNT(*) AS total FROM prices").get().total),
      users: Number(verification.prepare("SELECT COUNT(*) AS total FROM users").get().total),
      quotationNumbers: Number(verification.prepare("SELECT COUNT(*) AS total FROM quotation_numbers").get().total),
    };
    verification.close();
    if (integrity !== "ok") throw new Error("Verifikasi integritas backup database gagal.");
    if (fs.existsSync(acesDataDir)) {
      fs.cpSync(acesDataDir, path.join(directory, "aces"), { recursive: true });
    }
    const databaseBuffer = fs.readFileSync(databasePath);
    const manifest = {
      id: backupId,
      createdAt,
      reason,
      actor,
      integrity,
      pages: result.pages,
      databaseBytes: databaseBuffer.length,
      databaseSha256: crypto.createHash("sha256").update(databaseBuffer).digest("hex"),
      counts,
    };
    fs.writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    store.recordAudit(null, "BACKUP_CREATE", actor, manifest);
    return manifest;
  })();
  try {
    return await backupInProgress;
  } finally {
    backupInProgress = null;
  }
}

async function ensureDailyBackup() {
  const today = new Date().toISOString().slice(0, 10);
  if (listBackups().some((item) => String(item.createdAt).startsWith(today))) return;
  try {
    await performBackup("AUTOMATIC_DAILY", "System");
  } catch (error) {
    console.error("Backup otomatis gagal:", error);
  }
}

function quoteAttachmentDir(quotationId) {
  const directoryName = crypto
    .createHash("sha256")
    .update(String(quotationId))
    .digest("hex")
    .slice(0, 32);
  return path.join(acesDataDir, directoryName);
}

function safeOriginalName(value, extension) {
  const cleaned = path
    .basename(String(value || `Hasil ACES${extension}`))
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_")
    .slice(0, 140)
    .trim();
  return cleaned || `Hasil ACES${extension}`;
}

function createDemoQuotation() {
  return calculateQuotation({
    id: "demo-firepro-pac",
    qn: "QN/FP-PAC-YN/DEMO",
    revision: 0,
    date: "2026-07-29",
    mode: "DEMO",
    packageName: "FirePro + PAC",
    sourceSnapshotDate: "2026-07-06",
    customer: {
      name: "PT CONTOH CUSTOMER",
      address: "Silakan ganti dengan alamat lengkap customer",
      pic: "Bpk./Ibu Contoh",
    },
    project: {
      name: "Proyek Gabungan FirePro dan PAC",
      location: "Jakarta / lokasi proyek",
    },
    terms: {
      ppnIncluded: false,
      ppnRate: 11,
      validityDays: 14,
      franco: "Lokasi proyek sesuai kesepakatan",
      payment: "Sesuai persetujuan komersial",
      delivery: "Setelah PO dan pembayaran sesuai kesepakatan",
      warranty: "1 tahun sejak BAST sesuai syarat pabrikan",
      notes:
        "Harga tidak mengikat dan dapat berubah mengikuti harga material, kurs, serta persetujuan akhir.",
    },
    firepro: {
      rooms: [
        {
          name: "Generator Room",
          length: 17,
          width: 2.438,
          height: 3.6,
          raisedFloor: 0,
          falseCeiling: 0,
          fireClass: 46,
          safetyFactor: 1.3,
        },
      ],
      approvedAgent: 9150,
      acesReference: "ACES-DEMO-2026",
      approvalStatus: "Disetujui - engineering",
      acesAttachments: [],
      aces: {
        projectName: "PT Contoh Customer",
        reportDate: "July 2026",
        referenceNumber: "ACES-DEMO-2026",
        roomName: "Generator Room",
        spaceType: "Power Generator Rooms",
        numberOfDoors: 1,
        shape: "rectangular",
        width: 2.438,
        height: 3.6,
        length: 17,
        calculatedVolume: 149.2056,
        classOfFire:
          "Class A Fire - Combustible Solids / Electrically Energized Equipment",
        ead: 46,
        streamRequired: "2.01m < 3.5m",
        safetyFactorPercent: 30,
        requiredMass: 8922.49,
        selectedMass: 9150,
        excessMass: 227.51,
        excessPercent: 2.55,
        approvalResult: "APPROVED",
        approvalNote: "Sufficient concentration.",
        importedFrom: "Contoh hasil ACES Project Genset Room",
        generators: [
          {
            code: "10318",
            model: "FP-3000T",
            dischargeTemperature: "T1/T2/T3",
            effectiveMass: 1830,
            quantity: 5,
            totalConcentration: 9150,
          },
        ],
        electronics: [
          {
            code: "10187",
            description: "Isolation Switch Blue RPBS11CL",
            category: "Control Panels - Switches",
            quantity: 1,
          },
          {
            code: "10990",
            description: "Apollo Series 65 Standard Base 45681-200APO",
            category: "Detection Items - Conventional Detectors",
            quantity: 5,
          },
          {
            code: "10991",
            description: "Apollo Series 65 Optical Smoke Detector 55000-317APO",
            category: "Detection Items - Conventional Detectors",
            quantity: 2,
          },
          {
            code: "10992",
            description: "Apollo Series 65 A1R Heat Detector 55000-122APO",
            category: "Detection Items - Conventional Detectors",
            quantity: 3,
          },
          {
            code: "11069",
            description: "Sounder/Beacon 24v",
            category: "Bells & Sounders",
            quantity: 1,
          },
          {
            code: "11070",
            description: "Bell 24v 6 inch",
            category: "Bells & Sounders",
            quantity: 1,
          },
          {
            code: "11411",
            description: "Gas Discharge Sign",
            category: "Bells & Sounders",
            quantity: 1,
          },
          {
            code: "11678",
            description: "Advanced ExGo Extinguishing Control Panel",
            category: "Control Panels - Releasing Panels",
            quantity: 1,
          },
          {
            code: "11769",
            description: "FirePro Advanced Sequential Activator",
            category: "Control Panel Accessories",
            quantity: 2,
          },
        ],
      },
    },
    pac: {
      approvedModel: "XOPB2055D",
      heatLoad: 54.9,
      totalCapacity: 54.9,
      quantity: 1,
      approvalStatus: "Disetujui - engineering",
      priceConfirmed: false,
    },
    items: [
      {
        active: true,
        packageName: "FirePro",
        category: "Equipment",
        code: "FP-PACKAGE",
        description: "Equipment FirePro setelah diskon",
        quantity: 1,
        unit: "lot",
        sourcePrice: 100000000,
        divisor: 1,
        markupPercent: 0,
        discountPercent: 20,
        source: "Data demo - ganti sebelum digunakan",
      },
      {
        active: true,
        packageName: "FirePro",
        category: "Material",
        code: "FP-MATERIAL",
        description: "Material dan accessories FirePro",
        quantity: 1,
        unit: "lot",
        sourcePrice: 10000000,
        divisor: 1,
        markupPercent: 0,
        discountPercent: 0,
        source: "Data demo - ganti sebelum digunakan",
      },
      {
        active: true,
        packageName: "FirePro",
        category: "Service",
        code: "FP-SERVICE",
        description: "Jasa, testing, transport, dan delivery FirePro",
        quantity: 1,
        unit: "lot",
        sourcePrice: 5000000,
        divisor: 1,
        markupPercent: 0,
        discountPercent: 0,
        source: "Data demo - ganti sebelum digunakan",
      },
      {
        active: true,
        packageName: "PAC",
        category: "Equipment",
        code: "PAC-XOPB2055D",
        description: "Precision Air Conditioning Montair XOPB2055D",
        quantity: 1,
        unit: "unit",
        sourcePrice: 200000000,
        divisor: 1,
        markupPercent: 0,
        discountPercent: 0,
        source: "Data demo - ganti sebelum digunakan",
      },
      {
        active: true,
        packageName: "PAC",
        category: "Material",
        code: "PAC-MATERIAL",
        description: "Material instalasi PAC",
        quantity: 1,
        unit: "lot",
        sourcePrice: 25000000,
        divisor: 1,
        markupPercent: 0,
        discountPercent: 0,
        source: "Data demo - ganti sebelum digunakan",
      },
      {
        active: true,
        packageName: "PAC",
        category: "Service",
        code: "PAC-SERVICE",
        description: "Jasa pemasangan, testing, dan commissioning PAC",
        quantity: 1,
        unit: "lot",
        sourcePrice: 10000000,
        divisor: 1,
        markupPercent: 0,
        discountPercent: 0,
        source: "Data demo - ganti sebelum digunakan",
      },
    ],
  });
}

if (store.listQuotations(1).length === 0) {
  store.saveQuotation(createDemoQuotation(), "System seed");
}

const app = express();
app.disable("x-powered-by");
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'",
  );
  next();
});
app.use(express.json({ limit: "2mb" }));
app.use(express.static(publicDir, { extensions: ["html"] }));

const actorFrom = (request) =>
  String(request.authUser?.displayName || "Operator").slice(0, 80);

function cookieValue(request, name) {
  const cookies = String(request.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function sessionCookie(request, token, maxAgeSeconds = standardSessionSeconds) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").toLowerCase();
  const secure = request.secure || forwardedProto === "https";
  return [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function requireAuth(request, response, next) {
  const token = cookieValue(request, sessionCookieName);
  const user = store.getSessionUser(token);
  if (!user) {
    return response.status(401).json({ error: "Silakan login untuk melanjutkan." });
  }
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    request.headers["x-requested-with"] !== "MNNQuotationDesk"
  ) {
    return response.status(403).json({ error: "Permintaan tidak memiliki penanda keamanan aplikasi." });
  }
  request.authUser = user;
  request.sessionToken = token;
  return next();
}

const allowRoles = (...roles) => (request, response, next) => {
  if (!roles.includes(request.authUser?.role)) {
    return response.status(403).json({ error: "Akun Anda tidak memiliki akses untuk tindakan ini." });
  }
  return next();
};

const operationalRoles = new Set(["LOGISTICS", "SUPPORT", "PRESALES"]);

function assertCanManageUser(requester, targetRole) {
  const role = String(targetRole || "").toUpperCase();
  if (requester.role === "ADMIN") return;
  if (requester.role === "OPERATIONS_MANAGER" && operationalRoles.has(role)) return;
  throw new Error("Manager Operational hanya dapat mengelola akun Support, Presales, dan Logistik.");
}

function approvalRoles(type) {
  if (type === "TECHNICAL") return ["ADMIN", "PRESALES", "OPERATIONS_MANAGER"];
  if (type === "PRICE") return ["ADMIN", "LOGISTICS"];
  if (type === "MANAGER") return ["ADMIN", "OPERATIONS_MANAGER"];
  return [];
}

function resetQuotationForReuse(source, { keepCustomer = true } = {}) {
  const quotation = JSON.parse(JSON.stringify(source));
  quotation.id = null;
  quotation.qn = "";
  quotation.revision = 0;
  quotation.date = new Date().toISOString().slice(0, 10);
  delete quotation.createdAt;
  delete quotation.updatedAt;
  delete quotation.validation;
  if (!keepCustomer) {
    quotation.customer = { name: "", address: "", pic: "", email: "", phone: "" };
    quotation.project = { name: "", location: "" };
  }
  if (quotation.firepro) {
    quotation.firepro.approvalStatus = "Belum disetujui";
    quotation.firepro.acesAttachments = [];
    quotation.firepro.aces = {
      ...(quotation.firepro.aces || {}),
      referenceNumber: "",
      approvalResult: "",
      approvalNote: "",
      importedFrom: "",
      importedAt: "",
      attachments: [],
    };
  }
  if (quotation.pac) {
    quotation.pac.approvalStatus = "Belum disetujui";
    quotation.pac.priceConfirmed = false;
  }
  return quotation;
}

function creatorInitialsFrom(value, fallback = "YN") {
  const initials = String(value || fallback).trim().toUpperCase();
  if (!/^[A-Z0-9]{2,5}$/.test(initials)) {
    throw new Error("Kode pembuat harus 2-5 huruf/angka, misalnya YN atau PL.");
  }
  return initials;
}

app.get("/api/health", (request, response) => {
  response.json({
    ok: true,
    service: "MNN Internal Quotation",
    version: "0.8.5",
    database: path.basename(store.databasePath),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/auth/session", (request, response) => {
  const user = store.getSessionUser(cookieValue(request, sessionCookieName));
  response.json({ authenticated: Boolean(user), user });
});

app.post("/api/auth/login", (request, response) => {
  const username = String(request.body?.username || "").trim().toLowerCase();
  const rememberMe = request.body?.rememberMe === true;
  const sessionSeconds = rememberMe ? rememberedSessionSeconds : standardSessionSeconds;
  const key = `${request.ip || request.socket.remoteAddress || "unknown"}:${username}`;
  const now = Date.now();
  const attempt = loginAttempts.get(key) || { count: 0, blockedUntil: 0 };
  if (attempt.blockedUntil > now) {
    return response.status(429).json({ error: "Terlalu banyak percobaan login. Coba kembali beberapa menit lagi." });
  }
  try {
    const session = store.loginUser(username, request.body?.password, {
      ipAddress: request.ip || request.socket.remoteAddress,
      userAgent: request.headers["user-agent"],
      rememberMe,
    });
    loginAttempts.delete(key);
    response.setHeader("Set-Cookie", sessionCookie(request, session.token, sessionSeconds));
    return response.json({ authenticated: true, user: session.user, expiresAt: session.expiresAt, remembered: rememberMe });
  } catch (error) {
    const nextCount = attempt.count + 1;
    loginAttempts.set(key, {
      count: nextCount,
      blockedUntil: nextCount >= 5 ? now + 15 * 60 * 1000 : 0,
    });
    return response.status(401).json({ error: error.message });
  }
});

app.post("/api/auth/logout", (request, response) => {
  store.logoutUser(cookieValue(request, sessionCookieName));
  response.setHeader("Set-Cookie", sessionCookie(request, "", 0));
  response.json({ ok: true });
});

app.use("/api", requireAuth);

app.post("/api/auth/change-password", (request, response) => {
  try {
    store.changeUserPassword(
      request.authUser.id,
      request.body?.currentPassword,
      request.body?.newPassword,
    );
    response.setHeader("Set-Cookie", sessionCookie(request, "", 0));
    return response.json({ ok: true, loginRequired: true });
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
});

app.get("/api/bootstrap", (request, response) => {
  const role = request.authUser.role;
  const canManageUsers = ["ADMIN", "OPERATIONS_MANAGER"].includes(role);
  const users = canManageUsers
    ? store.listUsers().filter((item) => role === "ADMIN" || operationalRoles.has(item.role))
    : [];
  response.json({
    user: request.authUser,
    capabilities: {
      editQuotations: ["ADMIN", "SUPPORT", "PRESALES"].includes(role),
      manageLogisticsPrices: ["ADMIN", "LOGISTICS"].includes(role),
      requestManualPrices: ["ADMIN", "SUPPORT", "PRESALES"].includes(role),
      updateWorkflow: ["ADMIN", "SUPPORT", "PRESALES", "OPERATIONS_MANAGER"].includes(role),
      manageUsers: canManageUsers,
      manageAllUsers: role === "ADMIN",
      manageBackups: ["ADMIN", "OPERATIONS_MANAGER"].includes(role),
      manageCustomers: ["ADMIN", "SUPPORT", "PRESALES"].includes(role),
      manageTemplates: ["ADMIN", "SUPPORT", "PRESALES"].includes(role),
      approveTechnical: approvalRoles("TECHNICAL").includes(role),
      approvePrice: approvalRoles("PRICE").includes(role),
      approveManager: approvalRoles("MANAGER").includes(role),
      viewReports: ["ADMIN", "OPERATIONS_MANAGER"].includes(role),
    },
    dashboard: store.getDashboard(),
    emptyQuotation: createEmptyQuotation(),
    quotationCreators: store.listQuotationCreators(),
    customers: store.listCustomers({ limit: 500 }),
    templates: store.listQuotationTemplates(false),
    users,
    backups: ["ADMIN", "OPERATIONS_MANAGER"].includes(role) ? listBackups().slice(0, 20) : [],
  });
});

app.get("/api/users", allowRoles("ADMIN", "OPERATIONS_MANAGER"), (request, response) => {
  const items = store.listUsers().filter(
    (item) => request.authUser.role === "ADMIN" || operationalRoles.has(item.role),
  );
  response.json({ items });
});

app.post("/api/users", allowRoles("ADMIN", "OPERATIONS_MANAGER"), (request, response) => {
  try {
    assertCanManageUser(request.authUser, request.body?.role);
    const user = store.createUser(request.body, actorFrom(request));
    return response.status(201).json({ user });
  } catch (error) {
    const status = /sudah digunakan/i.test(error.message) ? 409 : 400;
    return response.status(status).json({ error: error.message });
  }
});

app.put("/api/users/:id", allowRoles("ADMIN", "OPERATIONS_MANAGER"), (request, response) => {
  try {
    const existing = store.listUsers().find((item) => item.id === request.params.id);
    if (!existing) return response.status(404).json({ error: "Akun pengguna tidak ditemukan." });
    assertCanManageUser(request.authUser, existing.role);
    assertCanManageUser(request.authUser, request.body?.role || existing.role);
    if (request.params.id === request.authUser.id && request.body?.active === false) {
      throw new Error("Akun yang sedang digunakan tidak dapat dinonaktifkan.");
    }
    const user = store.updateUser(request.params.id, request.body, actorFrom(request));
    const usernameChanged = existing.username !== user.username;
    const loginRequired = usernameChanged && request.params.id === request.authUser.id;
    return response.json({ user, usernameChanged, loginRequired });
  } catch (error) {
    const status = /tidak ditemukan/i.test(error.message) ? 404 : /sudah digunakan/i.test(error.message) ? 409 : 400;
    return response.status(status).json({ error: error.message });
  }
});

app.post("/api/users/:id/reset-password", allowRoles("ADMIN", "OPERATIONS_MANAGER"), (request, response) => {
  try {
    const existing = store.listUsers().find((item) => item.id === request.params.id);
    if (!existing) return response.status(404).json({ error: "Akun pengguna tidak ditemukan." });
    assertCanManageUser(request.authUser, existing.role);
    store.resetUserPassword(request.params.id, request.body?.newPassword, actorFrom(request));
    return response.json({ ok: true, mustChangePassword: true });
  } catch (error) {
    const status = /tidak ditemukan/i.test(error.message) ? 404 : 400;
    return response.status(status).json({ error: error.message });
  }
});

app.get("/api/backups", allowRoles("ADMIN", "OPERATIONS_MANAGER"), (request, response) => {
  response.json({ items: listBackups() });
});

app.post("/api/backups", allowRoles("ADMIN", "OPERATIONS_MANAGER"), async (request, response) => {
  try {
    const item = await performBackup("MANUAL", actorFrom(request));
    return response.status(201).json({ item });
  } catch (error) {
    return response.status(500).json({ error: error.message });
  }
});

app.get("/api/reports/management", allowRoles("ADMIN", "OPERATIONS_MANAGER"), (request, response) => {
  try {
    return response.json({ report: store.getManagementReport(request.query.year) });
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
});

app.get("/api/quotations", (request, response) => {
  response.json({
    items: store.listQuotations(request.query.limit),
  });
});

app.get("/api/quotations-trash", (request, response) => {
  response.json({ items: store.listDeletedQuotations(request.query.limit) });
});

app.post(
  "/api/quotations/:id/restore",
  allowRoles("ADMIN", "SUPPORT", "PRESALES"),
  (request, response) => {
    try {
      const quotation = store.restoreDraftQuotation(request.params.id, actorFrom(request));
      return response.json({ quotation });
    } catch (error) {
      const status = /tidak ditemukan/i.test(error.message) ? 404 : 409;
      return response.status(status).json({ error: error.message });
    }
  },
);

app.post(
  "/api/quotations/:id/duplicate",
  allowRoles("ADMIN", "SUPPORT", "PRESALES"),
  (request, response) => {
    try {
      const source = store.getQuotation(request.params.id);
      if (!source) return response.status(404).json({ error: "Quotation sumber tidak ditemukan." });
      const draft = resetQuotationForReuse(source, { keepCustomer: request.body?.keepCustomer !== false });
      const settings = store.getSettings();
      const quotationYear = Number(draft.date.slice(0, 4));
      draft.id = crypto.randomUUID();
      draft.qnCreatorInitials = creatorInitialsFrom(
        request.body?.qnCreatorInitials || source.qnCreatorInitials,
        settings.initials,
      );
      draft.qn = store.nextQn(draft.packageName, draft.qnCreatorInitials, quotationYear);
      const calculated = calculateQuotation(draft);
      const quotation = store.saveQuotation(calculated, actorFrom(request), {
        ownerName: request.authUser.displayName,
        ownerRole: request.authUser.role,
      });
      store.recordAudit(source.id, "DUPLICATE_SOURCE", actorFrom(request), { duplicatedTo: quotation.id, qn: quotation.qn });
      store.recordAudit(quotation.id, "DUPLICATE_CREATE", actorFrom(request), { duplicatedFrom: source.id, qn: source.qn });
      return response.status(201).json({ quotation });
    } catch (error) {
      return response.status(400).json({ error: error.message });
    }
  },
);

app.get("/api/customers", (request, response) => {
  response.json({
    items: store.listCustomers({
      query: request.query.query,
      includeInactive: request.query.includeInactive === "true",
      limit: request.query.limit,
    }),
  });
});

app.post("/api/customers", allowRoles("ADMIN", "SUPPORT", "PRESALES"), (request, response) => {
  try {
    const customer = store.saveCustomer(request.body, actorFrom(request));
    return response.status(201).json({ customer });
  } catch (error) {
    const status = /sudah ada/i.test(error.message) ? 409 : 400;
    return response.status(status).json({ error: error.message });
  }
});

app.put("/api/customers/:id", allowRoles("ADMIN", "SUPPORT", "PRESALES"), (request, response) => {
  try {
    const customer = store.saveCustomer({ ...request.body, id: request.params.id }, actorFrom(request));
    return response.json({ customer });
  } catch (error) {
    const status = /sudah ada/i.test(error.message) ? 409 : 400;
    return response.status(status).json({ error: error.message });
  }
});

app.get("/api/templates", (request, response) => {
  response.json({ items: store.listQuotationTemplates(request.query.includeInactive === "true") });
});

app.post("/api/templates", allowRoles("ADMIN", "SUPPORT", "PRESALES"), (request, response) => {
  try {
    const template = store.createQuotationTemplate(request.body, actorFrom(request));
    return response.status(201).json({ template });
  } catch (error) {
    const status = /sudah ada/i.test(error.message) ? 409 : 400;
    return response.status(status).json({ error: error.message });
  }
});

app.put("/api/templates/:id", allowRoles("ADMIN", "SUPPORT", "PRESALES"), (request, response) => {
  try {
    const template = store.setQuotationTemplateActive(request.params.id, request.body?.active === true, actorFrom(request));
    return response.json({ template });
  } catch (error) {
    return response.status(404).json({ error: error.message });
  }
});

app.get("/api/quotations/:id/versions", (request, response) => {
  response.json({ items: store.listQuotationVersions(request.params.id) });
});

app.post(
  "/api/quotations/:id/revisions",
  allowRoles("ADMIN", "SUPPORT", "PRESALES"),
  (request, response) => {
    try {
      const quotation = store.createQuotationRevision(
        request.params.id,
        request.body?.note,
        actorFrom(request),
        request.authUser.role,
      );
      return response.status(201).json({ quotation: calculateQuotation(quotation) });
    } catch (error) {
      const status = /tidak ditemukan/i.test(error.message) ? 404 : 400;
      return response.status(status).json({ error: error.message });
    }
  },
);

app.get("/api/quotations/:id/approvals", (request, response) => {
  response.json({ items: store.listQuotationApprovals(request.params.id) });
});

app.post(
  "/api/quotations/:id/approvals/request",
  allowRoles("ADMIN", "SUPPORT", "PRESALES"),
  (request, response) => {
    try {
      const items = store.requestQuotationApprovals(
        request.params.id,
        actorFrom(request),
        request.authUser.role,
      );
      return response.status(201).json({ items });
    } catch (error) {
      return response.status(400).json({ error: error.message });
    }
  },
);

app.put("/api/quotations/:id/approvals/:type", (request, response) => {
  const type = String(request.params.type || "").toUpperCase();
  if (!approvalRoles(type).includes(request.authUser.role)) {
    return response.status(403).json({ error: "Role Anda tidak berwenang memberi approval tersebut." });
  }
  try {
    const items = store.decideQuotationApproval(
      request.params.id,
      type,
      request.body,
      actorFrom(request),
      request.authUser.role,
    );
    return response.json({ items });
  } catch (error) {
    const status = /tidak ditemukan/i.test(error.message) ? 404 : 400;
    return response.status(status).json({ error: error.message });
  }
});

app.get("/api/quotation-tracking", (request, response) => {
  try {
    response.json({
      items: store.listQuotationTracking({
        status: request.query.status,
        packageName: request.query.packageName,
        query: request.query.query,
        limit: request.query.limit,
      }),
    });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.put(
  "/api/quotations/:id/workflow",
  allowRoles("ADMIN", "SUPPORT", "PRESALES", "OPERATIONS_MANAGER"),
  (request, response) => {
    try {
      const item = store.updateQuotationWorkflow(
        request.params.id,
        request.body,
        actorFrom(request),
        request.authUser.role,
      );
      return response.json({ item });
    } catch (error) {
      const status = /tidak ditemukan/i.test(error.message) ? 404 : 400;
      return response.status(status).json({ error: error.message });
    }
  },
);

app.get("/api/quotations/:id/workflow", (request, response) => {
  response.json({ items: store.getQuotationWorkflowEvents(request.params.id) });
});

app.get("/api/quotation-numbers", (request, response) => {
  try {
    response.json({
      items: store.listQuotationNumbers({
        series: request.query.series,
        year: request.query.year,
        query: request.query.query,
        limit: request.query.limit,
      }),
      stats: store.getQnStats(request.query.year),
      years: store.listQuotationYears(),
    });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post("/api/quotation-numbers/manual", allowRoles("ADMIN", "SUPPORT", "PRESALES"), (request, response) => {
  try {
    const item = store.createManualQuotationNumber(
      request.body,
      actorFrom(request),
    );
    store.recordAudit(null, "QN_MANUAL_CREATE", actorFrom(request), {
      quotationNumber: item.quotationNumber,
      customerName: item.customerName,
      projectName: item.projectName,
    });
    response.status(201).json({ item });
  } catch (error) {
    const status = /sudah tercatat/i.test(error.message) ? 409 : 400;
    response.status(status).json({ error: error.message });
  }
});

app.put("/api/quotation-numbers/:id", allowRoles("ADMIN", "SUPPORT", "PRESALES"), (request, response) => {
  try {
    const item = store.updateManualQuotationNumber(
      request.params.id,
      request.body,
      actorFrom(request),
    );
    store.recordAudit(null, "QN_MANUAL_UPDATE", actorFrom(request), {
      quotationNumber: item.quotationNumber,
      quotationYear: item.quotationYear,
      customerName: item.customerName,
    });
    response.json({ item });
  } catch (error) {
    const status = /tidak ditemukan/i.test(error.message)
      ? 404
      : /sudah tercatat/i.test(error.message)
        ? 409
        : 400;
    response.status(status).json({ error: error.message });
  }
});

app.get("/api/quotation-creators", (request, response) => {
  response.json({ items: store.listQuotationCreators() });
});

app.post("/api/quotation-creators", allowRoles("ADMIN", "SUPPORT", "PRESALES"), (request, response) => {
  try {
    const item = store.createQuotationCreator(request.body);
    store.recordAudit(null, "QN_CREATOR_CREATE", actorFrom(request), {
      creatorName: item.creatorName,
      creatorInitials: item.creatorInitials,
    });
    response.status(201).json({ item });
  } catch (error) {
    const status = /sudah ada/i.test(error.message) ? 409 : 400;
    response.status(status).json({ error: error.message });
  }
});

app.delete("/api/quotation-numbers/:id", allowRoles("ADMIN", "SUPPORT", "PRESALES"), (request, response) => {
  try {
    const item = store.deleteManualQuotationNumber(request.params.id);
    store.recordAudit(null, "QN_MANUAL_DELETE", actorFrom(request), {
      quotationNumber: item.quotationNumber,
      customerName: item.customerName,
    });
    response.json({ item });
  } catch (error) {
    const status = /tidak ditemukan/i.test(error.message) ? 404 : 409;
    response.status(status).json({ error: error.message });
  }
});

app.get("/api/quotations/:id", (request, response) => {
  const stored = store.getQuotation(request.params.id);
  const quotation = stored ? calculateQuotation(stored) : null;
  if (!quotation) {
    return response.status(404).json({ error: "Quotation tidak ditemukan." });
  }
  return response.json({
    quotation,
    audit: store.getAudit(request.params.id),
    meta: store.getQuotationMeta(request.params.id),
    approvals: store.listQuotationApprovals(request.params.id),
    versions: store.listQuotationVersions(request.params.id),
  });
});

app.post(
  "/api/quotations/:id/aces/import",
  allowRoles("ADMIN", "SUPPORT", "PRESALES"),
  acesUpload.array("acesFiles", 4),
  (request, response, next) => {
    try {
      const existing = store.getQuotation(request.params.id);
      if (!existing) {
        return response.status(404).json({ error: "Quotation tidak ditemukan." });
      }
      const files = request.files ?? [];
      if (!files.length) {
        return response.status(400).json({
          error: "Pilih minimal satu file hasil ACES berformat DOCX atau PDF.",
        });
      }

      const importedAt = new Date().toISOString();
      const actor = actorFrom(request);
      const prepared = files.map((file) => {
        const extension = path.extname(file.originalname).toLowerCase();
        if (![".docx", ".pdf"].includes(extension)) {
          throw new Error("File ACES hanya boleh berformat .docx atau .pdf.");
        }
        let parsed = null;
        if (extension === ".docx") {
          parsed = parseAcesDocx(file.buffer);
          if (!parsed.referenceNumber && !parsed.generators.length) {
            throw new Error(
              `${file.originalname} tidak terlihat seperti hasil perhitungan ACES.`,
            );
          }
        } else if (file.buffer.subarray(0, 5).toString() !== "%PDF-") {
          throw new Error(`${file.originalname} bukan PDF yang valid.`);
        }
        const id = crypto.randomUUID();
        return {
          file,
          extension,
          parsed,
          attachment: {
            id,
            originalName: safeOriginalName(file.originalname, extension),
            storedName: `${id}${extension}`,
            type: extension.slice(1).toUpperCase(),
            size: file.size,
            uploadedAt: importedAt,
            uploadedBy: actor,
          },
        };
      });

      const directory = quoteAttachmentDir(existing.id);
      fs.mkdirSync(directory, { recursive: true });
      for (const item of prepared) {
        fs.writeFileSync(
          path.join(directory, item.attachment.storedName),
          item.file.buffer,
        );
      }

      const parsedDocuments = prepared.filter((item) => item.parsed);
      const parsedAces = parsedDocuments.reduce(
        (result, item) => ({
          ...result,
          ...item.parsed,
          importedFrom: item.attachment.originalName,
          importedAt,
        }),
        existing.firepro?.aces ?? {},
      );
      const previousAttachments = existing.firepro?.acesAttachments ?? [];
      const attachments = [
        ...previousAttachments,
        ...prepared.map((item) => item.attachment),
      ];
      let rooms = existing.firepro?.rooms ?? [];
      if (parsedDocuments.length) {
        const firstRoom = rooms[0] ?? {};
        const importedRoom = {
          ...firstRoom,
          name: firstRoom.name || parsedAces.roomName || "",
          length:
            Number(firstRoom.length) > 0
              ? firstRoom.length
              : parsedAces.length || 0,
          width:
            Number(firstRoom.width) > 0
              ? firstRoom.width
              : parsedAces.width || 0,
          height:
            Number(firstRoom.height) > 0
              ? firstRoom.height
              : parsedAces.height || 0,
          raisedFloor: Number(firstRoom.raisedFloor) || 0,
          falseCeiling: Number(firstRoom.falseCeiling) || 0,
          fireClass: Number(firstRoom.fireClass) || parsedAces.ead || 46,
          safetyFactor:
            Number(firstRoom.safetyFactor) ||
            1 + Number(parsedAces.safetyFactorPercent || 30) / 100,
        };
        rooms = [importedRoom, ...rooms.slice(1)];
      }

      const quotation = calculateQuotation({
        ...existing,
        firepro: {
          ...existing.firepro,
          rooms,
          aces: parsedAces,
          acesAttachments: attachments,
        },
      });
      const saved = store.saveQuotation(quotation, actor);
      store.recordAudit(existing.id, "ACES_IMPORT", actor, {
        files: prepared.map((item) => item.attachment.originalName),
        referenceNumber: saved.firepro.aces.referenceNumber,
        approvalResult: saved.firepro.aces.approvalResult,
      });
      return response.json({
        quotation: saved,
        imported: prepared.length,
        parsed: parsedDocuments.length,
      });
    } catch (error) {
      return response.status(400).json({ error: error.message });
    }
  },
);

app.get(
  "/api/quotations/:id/aces/:attachmentId",
  (request, response, next) => {
    try {
      const quotation = store.getQuotation(request.params.id);
      if (!quotation) {
        return response.status(404).json({ error: "Quotation tidak ditemukan." });
      }
      const attachment = (quotation.firepro?.acesAttachments ?? []).find(
        (item) => item.id === request.params.attachmentId,
      );
      if (!attachment) {
        return response
          .status(404)
          .json({ error: "Lampiran ACES tidak ditemukan." });
      }
      const filePath = path.join(
        quoteAttachmentDir(quotation.id),
        path.basename(attachment.storedName),
      );
      if (!fs.existsSync(filePath)) {
        return response.status(404).json({
          error: "Berkas lampiran ACES tidak tersedia pada penyimpanan server.",
        });
      }
      return response.download(filePath, attachment.originalName);
    } catch (error) {
      return next(error);
    }
  },
);

app.post("/api/quotations/calculate", (request, response) => {
  response.json({ quotation: calculateQuotation(request.body) });
});

app.post("/api/quotations", allowRoles("ADMIN", "SUPPORT", "PRESALES"), (request, response) => {
  try {
    const settings = store.getSettings();
    const id = request.body.id || crypto.randomUUID();
    const packageName = request.body.packageName || "FirePro + PAC";
    const quotationDate = request.body.date || new Date().toISOString().slice(0, 10);
    const quotationYear = Number(String(quotationDate).slice(0, 4));
    const qnCreatorInitials = creatorInitialsFrom(
      request.body.qnCreatorInitials,
      settings.initials,
    );
    const qn =
      String(request.body.qn || "").trim() ||
      store.nextQn(packageName, qnCreatorInitials, quotationYear);
    const existingByQn = store.getQuotationByQn(qn, quotationYear);
    if (existingByQn && existingByQn.id !== id) {
      return response
        .status(409)
        .json({ error: `Nomor ${qn} sudah dipakai quotation lain.` });
    }
    const quotation = calculateQuotation({
      ...request.body,
      id,
      qn,
      qnCreatorInitials,
      date: quotationDate,
    });
    const saved = store.saveQuotation(quotation, actorFrom(request), {
      ownerName: request.authUser.displayName,
      ownerRole: request.authUser.role,
    });
    return response.status(request.body.id ? 200 : 201).json({ quotation: saved });
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
});

app.put("/api/quotations/:id", allowRoles("ADMIN", "SUPPORT", "PRESALES"), (request, response) => {
  try {
    const existing = store.getQuotation(request.params.id);
    if (!existing) {
      return response.status(404).json({ error: "Quotation tidak ditemukan." });
    }
    if (store.isQuotationLocked(request.params.id)) {
      return response.status(423).json({
        error: "Quotation sudah terkunci karena telah dikirim atau ditutup. Buat revisi baru untuk mengeditnya.",
      });
    }
    const qn = String(request.body.qn || existing.qn).trim();
    const quotationDate = request.body.date || existing.date;
    const quotationYear = Number(String(quotationDate).slice(0, 4));
    const qnCreatorInitials = creatorInitialsFrom(
      request.body.qnCreatorInitials || existing.qnCreatorInitials,
      store.getSettings().initials,
    );
    const existingByQn = store.getQuotationByQn(qn, quotationYear);
    if (existingByQn && existingByQn.id !== request.params.id) {
      return response
        .status(409)
        .json({ error: `Nomor ${qn} sudah dipakai quotation lain.` });
    }
    const { _autosave, ...body } = request.body || {};
    const quotation = calculateQuotation({
      ...existing,
      ...body,
      id: request.params.id,
      qn,
      date: quotationDate,
      qnCreatorInitials,
    });
    const saved = store.saveQuotation(quotation, actorFrom(request), {
      ownerName: request.authUser.displayName,
      ownerRole: request.authUser.role,
      autosave: _autosave === true,
    });
    return response.json({
      quotation: saved,
      meta: store.getQuotationMeta(saved.id),
      approvals: store.listQuotationApprovals(saved.id),
      versions: store.listQuotationVersions(saved.id),
    });
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
});

app.delete("/api/quotations/:id", allowRoles("ADMIN", "SUPPORT", "PRESALES"), (request, response) => {
  try {
    const quotation = store.deleteDraftQuotation(
      request.params.id,
      actorFrom(request),
    );
    return response.json({ quotation });
  } catch (error) {
    const status = /tidak ditemukan/i.test(error.message) ? 404 : 409;
    return response.status(status).json({ error: error.message });
  }
});

async function exportQuotation(request, response, type) {
  const stored = store.getQuotation(request.params.id);
  if (!stored) {
    return response.status(404).json({ error: "Quotation tidak ditemukan." });
  }
  const quotation = calculateQuotation(stored);
  if (
    quotation.mode === "PRODUKSI" &&
    quotation.validation.status === "BELUM SIAP"
  ) {
    return response.status(422).json({
      error:
        "Quotation produksi belum boleh diekspor. Selesaikan seluruh ERROR pada panel validasi.",
      validation: quotation.validation,
    });
  }
  const approvals = store.listQuotationApprovals(quotation.id);
  if (
    quotation.mode === "PRODUKSI" &&
    approvals.length &&
    approvals.some((item) => item.status !== "APPROVED")
  ) {
    return response.status(422).json({
      error: "Dokumen produksi belum dapat diekspor karena approval internal belum lengkap.",
      approvals,
    });
  }
  const settings = store.getSettings();
  const buffer =
    type === "docx"
      ? await buildDocxBuffer(quotation, settings)
      : await buildPdfBuffer(quotation, settings);
  const contentType =
    type === "docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/pdf";
  response.setHeader("Content-Type", contentType);
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeDownloadName(quotation.qn, type)}"`,
  );
  if (quotation.validation.warnings.length) {
    response.setHeader(
      "X-Quotation-Warnings",
      encodeURIComponent(quotation.validation.warnings.join(" | ")),
    );
  }
  store.recordExport(quotation.id, type, actorFrom(request));
  return response.send(buffer);
}

app.get("/api/quotations/:id/export/docx", async (request, response, next) => {
  try {
    await exportQuotation(request, response, "docx");
  } catch (error) {
    next(error);
  }
});

app.get("/api/quotations/:id/export/pdf", async (request, response, next) => {
  try {
    await exportQuotation(request, response, "pdf");
  } catch (error) {
    next(error);
  }
});

app.get("/api/prices", (request, response) => {
  response.json({
    items: store.searchPrices({
      query: request.query.query,
      packageName: request.query.packageName,
      limit: request.query.limit,
    }),
  });
});

app.get("/api/prices/:code/history", (request, response) => {
  response.json({ items: store.listPriceHistory(request.params.code, request.query.limit) });
});

app.post(
  "/api/prices/import",
  allowRoles("ADMIN", "LOGISTICS"),
  priceUpload.single("pricelist"),
  async (request, response, next) => {
    try {
      if (!request.file) {
        return response.status(400).json({ error: "File pricelist belum dipilih." });
      }
      if (!request.file.originalname.toLowerCase().endsWith(".xlsx")) {
        return response
          .status(400)
          .json({ error: "MVP ini menerima pricelist berformat .xlsx." });
      }
      const snapshotDate =
        String(request.body.snapshotDate || "").trim() ||
        new Date().toISOString().slice(0, 10);
      const rows = parseSupportPricelist(request.file.buffer, {
        sourceName: request.file.originalname,
        snapshotDate,
      });
      const result = store.importPrices(rows, actorFrom(request));
      return response.json({ ...result, snapshotDate });
    } catch (error) {
      next(error);
    }
  },
);

app.post("/api/prices/manual", allowRoles("ADMIN", "SUPPORT", "PRESALES"), (request, response) => {
  try {
    const item = store.createManualPrice(request.body, actorFrom(request));
    return response.status(201).json({ item });
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
});

app.post("/api/prices/logistics", allowRoles("ADMIN", "LOGISTICS"), (request, response) => {
  try {
    const item = store.upsertLogisticsPrice(request.body, actorFrom(request));
    return response.status(201).json({ item });
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
});

app.put("/api/prices/:code/logistics", allowRoles("ADMIN", "LOGISTICS"), (request, response) => {
  try {
    const item = store.upsertLogisticsPrice(
      { ...request.body, code: request.params.code },
      actorFrom(request),
    );
    return response.json({ item });
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
});

app.post("/api/prices/resolve", (request, response) => {
  const codes = Array.isArray(request.body?.codes) ? request.body.codes : [];
  if (codes.length > 100) {
    return response
      .status(400)
      .json({ error: "Maksimal 100 kode dapat diperiksa sekaligus." });
  }
  return response.json({ items: store.resolvePrices(codes) });
});

app.use("/api", (request, response) => {
  response.status(404).json({ error: "Endpoint API tidak ditemukan." });
});

app.get("*splat", (request, response) => {
  response.sendFile(path.join(publicDir, "index.html"));
});

app.use((error, request, response, next) => {
  console.error(error);
  if (response.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    return response.status(400).json({
      error:
        error.code === "LIMIT_FILE_SIZE"
          ? "Ukuran file melebihi batas yang diizinkan."
          : "Jumlah atau format unggahan tidak sesuai.",
    });
  }
  return response.status(500).json({
    error: "Terjadi kesalahan pada server quotation.",
    detail: process.env.NODE_ENV === "production" ? undefined : error.message,
  });
});

const server = app.listen(port, host, () => {
  const urls = [`http://localhost:${port}`];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.push(`http://${address.address}:${port}`);
      }
    }
  }
  console.log("MNN Internal Quotation aktif:");
  for (const url of [...new Set(urls)]) console.log(`  ${url}`);
  console.log(`Database: ${store.databasePath}`);
  void ensureDailyBackup();
});

const backupTimer = setInterval(() => {
  void ensureDailyBackup();
}, 6 * 60 * 60 * 1000);
backupTimer.unref();

function shutdown() {
  clearInterval(backupTimer);
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
