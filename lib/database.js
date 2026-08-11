import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";

const nowIso = () => new Date().toISOString();

const QN_SERIES = new Set(["FP", "PAC", "ME"]);
const USER_ROLES = new Set([
  "ADMIN",
  "LOGISTICS",
  "SUPPORT",
  "PRESALES",
  "OPERATIONS_MANAGER",
]);
const WORKFLOW_STATUSES = new Set([
  "DRAFT",
  "WAITING_PRICE",
  "CALCULATION",
  "INTERNAL_REVIEW",
  "SENT",
  "FOLLOW_UP",
  "WON",
  "LOST",
  "CANCELLED",
]);
const APPROVAL_TYPES = new Set(["TECHNICAL", "PRICE", "MANAGER"]);
const APPROVAL_STATUSES = new Set(["PENDING", "APPROVED", "REJECTED"]);
const LOCKED_WORKFLOW_STATUSES = new Set([
  "SENT",
  "FOLLOW_UP",
  "WON",
  "LOST",
  "CANCELLED",
]);

function normalizeUsername(value) {
  const username = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) {
    throw new Error(
      "Username harus 3-40 karakter dan hanya boleh berisi huruf kecil, angka, titik, garis bawah, atau tanda hubung.",
    );
  }
  return username;
}

function validatePassword(value) {
  const password = String(value ?? "");
  if (
    password.length < 10 ||
    !/[A-Z]/.test(password) ||
    !/[a-z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  ) {
    throw new Error(
      "Password minimal 10 karakter dan harus memiliki huruf besar, huruf kecil, angka, serta simbol.",
    );
  }
  return password;
}

function passwordDigest(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

function passwordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: passwordDigest(password, salt) };
}

function passwordMatches(password, salt, expectedHash) {
  const actual = Buffer.from(passwordDigest(password, salt), "hex");
  const expected = Buffer.from(String(expectedHash || ""), "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const BOOTSTRAP_PASSWORD_ENV = {
  admin: "MNN_BOOTSTRAP_ADMIN_PASSWORD",
  logistik: "MNN_BOOTSTRAP_LOGISTICS_PASSWORD",
  support: "MNN_BOOTSTRAP_SUPPORT_PASSWORD",
  presales: "MNN_BOOTSTRAP_PRESALES_PASSWORD",
  manager: "MNN_BOOTSTRAP_MANAGER_PASSWORD",
};

function bootstrapPassword(username) {
  const environmentName = BOOTSTRAP_PASSWORD_ENV[username];
  const configured = environmentName ? process.env[environmentName] : "";
  if (configured) return validatePassword(configured);
  return `Mnn!${crypto.randomBytes(18).toString("base64url")}9aA`;
}

function seriesForPackage(packageName) {
  if (packageName === "FirePro") return "FP";
  if (packageName === "PAC") return "PAC";
  return "ME";
}

function normalizeSeries(value) {
  const series = String(value ?? "").trim().toUpperCase();
  if (!QN_SERIES.has(series)) {
    throw new Error("Buku nomor harus FP, PAC, atau ME.");
  }
  return series;
}

function normalizeInitials(value, fallback = "YN") {
  const initials = String(value || fallback).trim().toUpperCase();
  if (!/^[A-Z0-9]{2,5}$/.test(initials)) {
    throw new Error("Kode pembuat harus 2-5 huruf/angka, misalnya YN atau PL.");
  }
  return initials;
}

function parseQuotationNumber(value) {
  const quotationNumber = String(value ?? "").trim().toUpperCase();
  const match = quotationNumber.match(
    /^QN\/(FP|PAC|ME|FP-PAC)-[A-Z0-9]+\/(\d+)$/,
  );
  if (!match) return null;
  return {
    quotationNumber,
    series: match[1] === "FP-PAC" ? "ME" : match[1],
    sequenceNumber: Number(match[2]),
  };
}

function quotationValidityDate(quotation) {
  const date = String(quotation?.date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const validityDays = Math.max(1, Math.round(Number(quotation?.terms?.validityDays) || 14));
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + validityDays);
  return result.toISOString().slice(0, 10);
}

export function createStore({ dataDir, seedPath }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const databasePath = path.join(dataDir, "quotation-internal.db");
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS prices (
      code TEXT PRIMARY KEY,
      package_name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      unit TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      snapshot_date TEXT,
      needs_review INTEGER NOT NULL DEFAULT 0,
      price_origin TEXT NOT NULL DEFAULT 'PRICELIST',
      verification_status TEXT NOT NULL DEFAULT 'PERLU_REVIEW',
      supplier TEXT,
      evidence_ref TEXT,
      notes TEXT,
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prices_description ON prices(description);
    CREATE INDEX IF NOT EXISTS idx_prices_package ON prices(package_name);

    CREATE TABLE IF NOT EXISTS quotations (
      id TEXT PRIMARY KEY,
      qn TEXT NOT NULL,
      quotation_year INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL,
      package_name TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      project_name TEXT NOT NULL,
      validation_status TEXT NOT NULL,
      subtotal REAL NOT NULL,
      tax REAL NOT NULL,
      grand_total REAL NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by TEXT,
      follow_up_at TEXT,
      sent_at TEXT,
      validity_expires_at TEXT,
      outcome_reason TEXT NOT NULL DEFAULT '',
      UNIQUE(qn, quotation_year)
    );
    CREATE INDEX IF NOT EXISTS idx_quotations_updated ON quotations(updated_at DESC);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_id TEXT,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quotation_numbers (
      id TEXT PRIMARY KEY,
      quotation_id TEXT,
      quotation_date TEXT NOT NULL,
      creator_name TEXT NOT NULL,
      quotation_number TEXT NOT NULL,
      quotation_year INTEGER NOT NULL,
      series TEXT NOT NULL CHECK(series IN ('FP', 'PAC', 'ME')),
      sequence_number INTEGER NOT NULL CHECK(sequence_number > 0),
      customer_name TEXT NOT NULL,
      project_name TEXT NOT NULL DEFAULT '',
      pic_name TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'AUTO',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quotation_numbers_book
      ON quotation_numbers(series, sequence_number DESC);
    CREATE INDEX IF NOT EXISTS idx_quotation_numbers_customer
      ON quotation_numbers(customer_name);

    CREATE TABLE IF NOT EXISTS quotation_creators (
      id TEXT PRIMARY KEY,
      creator_name TEXT NOT NULL,
      creator_initials TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ADMIN', 'LOGISTICS', 'SUPPORT', 'PRESALES', 'OPERATIONS_MANAGER')),
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      updated_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role, active);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      ip_address TEXT,
      user_agent TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS quotation_workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      note TEXT,
      actor TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_events_quotation
      ON quotation_workflow_events(quotation_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      address TEXT NOT NULL DEFAULT '',
      pic_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      last_project_name TEXT NOT NULL DEFAULT '',
      last_project_location TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      updated_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_customers_active_name
      ON customers(active, name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS quotation_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT NOT NULL DEFAULT '',
      package_name TEXT NOT NULL,
      payload TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quotation_templates_active
      ON quotation_templates(active, package_name, name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS quotation_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(quotation_id, revision),
      FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_quotation_versions
      ON quotation_versions(quotation_id, revision DESC);

    CREATE TABLE IF NOT EXISTS quotation_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      approval_type TEXT NOT NULL CHECK(approval_type IN ('TECHNICAL', 'PRICE', 'MANAGER')),
      status TEXT NOT NULL CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED')),
      note TEXT NOT NULL DEFAULT '',
      actor TEXT,
      actor_role TEXT,
      requested_by TEXT,
      requested_at TEXT NOT NULL,
      decided_at TEXT,
      UNIQUE(quotation_id, revision, approval_type),
      FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_quotation_approvals
      ON quotation_approvals(quotation_id, revision, approval_type);

    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      package_name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      unit TEXT NOT NULL,
      price REAL NOT NULL,
      source TEXT NOT NULL,
      snapshot_date TEXT,
      price_origin TEXT NOT NULL,
      verification_status TEXT NOT NULL,
      supplier TEXT,
      evidence_ref TEXT,
      notes TEXT,
      change_reason TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      UNIQUE(code, price, source, snapshot_date, changed_at)
    );
    CREATE INDEX IF NOT EXISTS idx_price_history_code
      ON price_history(code, changed_at DESC);
  `);

  let quotationNumberColumns = new Map(
    db.prepare("PRAGMA table_info(quotation_numbers)").all().map((column) => [
      column.name,
      column,
    ]),
  );
  const quotationColumns = new Map(
    db.prepare("PRAGMA table_info(quotations)").all().map((column) => [
      column.name,
      column,
    ]),
  );
  const quotationSql = String(
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'quotations'").get()?.sql || "",
  );
  const quotationNumberSql = String(
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'quotation_numbers'").get()?.sql || "",
  );
  const needsYearMigration =
    !quotationNumberColumns.has("quotation_year") ||
    !quotationColumns.has("quotation_year") ||
    /qn\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(quotationSql) ||
    /UNIQUE\s*\(\s*series\s*,\s*quotation_year\s*,\s*sequence_number\s*\)/i.test(quotationNumberSql);

  if (needsYearMigration) {
    const numberYearExpression = quotationNumberColumns.has("quotation_year")
      ? "quotation_year"
      : "CAST(substr(quotation_date, 1, 4) AS INTEGER)";
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        DROP TABLE IF EXISTS quotations_year_migration;
        DROP TABLE IF EXISTS quotation_numbers_year_migration;
        CREATE TABLE quotations_year_migration (
          id TEXT PRIMARY KEY,
          qn TEXT NOT NULL,
          quotation_year INTEGER NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          mode TEXT NOT NULL,
          package_name TEXT NOT NULL,
          customer_name TEXT NOT NULL,
          project_name TEXT NOT NULL,
          validation_status TEXT NOT NULL,
          subtotal REAL NOT NULL,
          tax REAL NOT NULL,
          grand_total REAL NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(qn, quotation_year)
        );
        INSERT INTO quotations_year_migration (
          id, qn, quotation_year, revision, mode, package_name, customer_name,
          project_name, validation_status, subtotal, tax, grand_total, payload,
          created_at, updated_at
        )
        SELECT id, qn,
               CAST(substr(COALESCE(json_extract(payload, '$.date'), created_at), 1, 4) AS INTEGER),
               revision, mode, package_name, customer_name, project_name,
               validation_status, subtotal, tax, grand_total, payload,
               created_at, updated_at
        FROM quotations;

        CREATE TABLE quotation_numbers_year_migration (
          id TEXT PRIMARY KEY,
          quotation_id TEXT,
          quotation_date TEXT NOT NULL,
          creator_name TEXT NOT NULL,
          quotation_number TEXT NOT NULL,
          quotation_year INTEGER NOT NULL,
          series TEXT NOT NULL CHECK(series IN ('FP', 'PAC', 'ME')),
          sequence_number INTEGER NOT NULL CHECK(sequence_number > 0),
          customer_name TEXT NOT NULL,
          project_name TEXT NOT NULL DEFAULT '',
          pic_name TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'AUTO',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (quotation_id) REFERENCES quotations_year_migration(id) ON DELETE SET NULL
        );
        INSERT INTO quotation_numbers_year_migration (
          id, quotation_id, quotation_date, creator_name, quotation_number,
          quotation_year, series, sequence_number, customer_name, project_name,
          pic_name, source, created_at, updated_at
        )
        SELECT id, quotation_id, quotation_date, creator_name, quotation_number,
               ${numberYearExpression}, series, sequence_number, customer_name,
               project_name, pic_name, source, created_at, updated_at
        FROM quotation_numbers;

        DROP TABLE quotation_numbers;
        DROP TABLE quotations;
        ALTER TABLE quotations_year_migration RENAME TO quotations;
        ALTER TABLE quotation_numbers_year_migration RENAME TO quotation_numbers;
        CREATE INDEX idx_quotations_updated ON quotations(updated_at DESC);
        CREATE INDEX idx_quotation_numbers_book
          ON quotation_numbers(series, quotation_year DESC, sequence_number DESC);
        CREATE INDEX idx_quotation_numbers_customer ON quotation_numbers(customer_name);
      `);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
    quotationNumberColumns = new Map(
      db.prepare("PRAGMA table_info(quotation_numbers)").all().map((column) => [
        column.name,
        column,
      ]),
    );
  }

  const refreshedQuotationColumns = new Map(
    db.prepare("PRAGMA table_info(quotations)").all().map((column) => [
      column.name,
      column,
    ]),
  );
  const quotationWorkflowMigrations = [
    ["workflow_status", "TEXT NOT NULL DEFAULT 'DRAFT'"],
    ["workflow_note", "TEXT NOT NULL DEFAULT ''"],
    ["workflow_owner_name", "TEXT NOT NULL DEFAULT ''"],
    ["workflow_owner_role", "TEXT NOT NULL DEFAULT ''"],
    ["workflow_updated_at", "TEXT"],
    ["deleted_at", "TEXT"],
    ["deleted_by", "TEXT"],
    ["follow_up_at", "TEXT"],
    ["sent_at", "TEXT"],
    ["validity_expires_at", "TEXT"],
    ["outcome_reason", "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, definition] of quotationWorkflowMigrations) {
    if (!refreshedQuotationColumns.has(name)) {
      db.exec(`ALTER TABLE quotations ADD COLUMN ${name} ${definition}`);
    }
  }
  db.prepare(`
    UPDATE quotations
    SET workflow_status = CASE
          WHEN validation_status = 'SIAP DIBUAT' THEN 'INTERNAL_REVIEW'
          ELSE 'DRAFT'
        END,
        workflow_note = CASE
          WHEN validation_status = 'SIAP DIBUAT' THEN 'Data lama: siap direview internal.'
          ELSE 'Data lama: status awal hasil migrasi.'
        END,
        workflow_owner_name = COALESCE(NULLIF(workflow_owner_name, ''), 'Migrasi aplikasi'),
        workflow_owner_role = COALESCE(NULLIF(workflow_owner_role, ''), 'SYSTEM'),
        workflow_updated_at = COALESCE(workflow_updated_at, updated_at)
    WHERE workflow_updated_at IS NULL
  `).run();

  db.exec(`
    DROP INDEX IF EXISTS idx_quotation_numbers_book;
    CREATE INDEX idx_quotation_numbers_book
      ON quotation_numbers(series, quotation_year DESC, sequence_number DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_quotation_numbers_active_sequence
      ON quotation_numbers(series, quotation_year, sequence_number)
      WHERE source <> 'DIBATALKAN';
    CREATE INDEX IF NOT EXISTS idx_quotations_workflow
      ON quotations(workflow_status, workflow_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_quotations_deleted
      ON quotations(deleted_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_quotations_follow_up
      ON quotations(follow_up_at, workflow_status);
  `);

  const userColumns = new Map(
    db.prepare("PRAGMA table_info(users)").all().map((column) => [
      column.name,
      column,
    ]),
  );
  for (const [name, definition] of [
    ["created_by", "TEXT"],
    ["updated_by", "TEXT"],
  ]) {
    if (!userColumns.has(name)) {
      db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
    }
  }

  const priceColumns = new Map(
    db.prepare("PRAGMA table_info(prices)").all().map((column) => [
      column.name,
      column,
    ]),
  );
  const priceMigrations = [
    ["price_origin", "TEXT NOT NULL DEFAULT 'PRICELIST'"],
    ["verification_status", "TEXT NOT NULL DEFAULT 'PERLU_REVIEW'"],
    ["supplier", "TEXT"],
    ["evidence_ref", "TEXT"],
    ["notes", "TEXT"],
    ["created_by", "TEXT"],
    ["created_at", "TEXT"],
  ];
  for (const [name, definition] of priceMigrations) {
    if (!priceColumns.has(name)) {
      db.exec(`ALTER TABLE prices ADD COLUMN ${name} ${definition}`);
    }
  }
  db.prepare(`
    UPDATE prices
    SET created_at = COALESCE(created_at, updated_at),
        created_by = COALESCE(created_by, 'Migrasi aplikasi')
    WHERE created_at IS NULL OR created_by IS NULL
  `).run();
  db.prepare(`
    UPDATE prices
    SET price_origin = 'LOGISTIK_PRICELIST'
    WHERE price_origin IN ('PRICELIST', 'PRICELIST_RESMI')
      AND (
        source LIKE '%MATERIAL_SUPPORT%'
        OR (package_name = 'Material' AND category = 'Material Support')
      )
  `).run();
  db.prepare(`
    UPDATE prices
    SET price_origin = 'PRICELIST_RESMI'
    WHERE price_origin = 'PRICELIST'
  `).run();
  db.prepare(`
    UPDATE prices
    SET verification_status = CASE
          WHEN needs_review = 1 THEN 'PERLU_REVIEW'
          WHEN price_origin = 'LOGISTIK_PRICELIST' THEN 'TERVERIFIKASI_LOGISTIK'
          ELSE 'TERVERIFIKASI_SUMBER'
        END
    WHERE price_origin <> 'MANUAL_SUPPORT'
  `).run();

  const count = db.prepare("SELECT COUNT(*) AS total FROM prices").get().total;
  if (count === 0 && fs.existsSync(seedPath)) {
    const rows = JSON.parse(fs.readFileSync(seedPath, "utf8"));
    importPrices(rows, "seed");
  }

  const settings = {
    companyName: "PT. MATUR NUWUN NUSANTARA",
    signerName: "Eddy S. Ginting",
    signerTitle: "Direktur",
    initials: "YN",
    materialSnapshotDate: "2026-07-06",
    priceMaxAgeDays: "90",
    managerApprovalThreshold: "100000000",
    backupRetentionDays: "90",
  };
  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `);
  for (const [key, value] of Object.entries(settings)) {
    upsertSetting.run(key, String(value), nowIso());
  }

  const seedCreator = db.prepare(`
    INSERT OR IGNORE INTO quotation_creators (
      id, creator_name, creator_initials, active, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?)
  `);
  for (const [creatorName, creatorInitials] of [
    ["Yan", "YN"],
    ["Petrus Lawrence", "PL"],
    ["Enda", "EP"],
    ["Vero", "AD"],
  ]) {
    const createdAt = nowIso();
    seedCreator.run(`creator-${creatorInitials.toLowerCase()}`, creatorName, creatorInitials, createdAt, createdAt);
  }

  const seedUser = db.prepare(`
    INSERT OR IGNORE INTO users (
      id, username, display_name, role, password_hash, password_salt,
      active, must_change_password, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
  `);
  for (const account of [
    { username: "admin", displayName: "Administrator", role: "ADMIN" },
    { username: "logistik", displayName: "Tim Logistik", role: "LOGISTICS" },
    { username: "support", displayName: "Tim Support", role: "SUPPORT" },
    { username: "presales", displayName: "Tim Presales", role: "PRESALES" },
    { username: "manager", displayName: "Manager Operational", role: "OPERATIONS_MANAGER" },
  ]) {
    const createdAt = nowIso();
    const initialPassword = bootstrapPassword(account.username);
    const password = passwordRecord(initialPassword);
    const inserted = seedUser.run(
      `user-${account.username}`,
      account.username,
      account.displayName,
      account.role,
      password.hash,
      password.salt,
      createdAt,
      createdAt,
    );
    if (inserted.changes > 0) {
      console.warn(
        `[BOOTSTRAP] Akun ${account.username} dibuat dengan password sementara: ${initialPassword}\n` +
          "Ganti password setelah login pertama dan jangan menyimpan output ini.",
      );
    }
  }

  const backfillQuotationNumber = db.prepare(`
    INSERT OR IGNORE INTO quotation_numbers (
      id, quotation_id, quotation_date, creator_name, quotation_number,
      quotation_year, series, sequence_number, customer_name, project_name, pic_name,
      source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MIGRASI', ?, ?)
  `);
  for (const row of db
    .prepare(
      "SELECT id, qn, customer_name AS customerName, payload, created_at AS createdAt, updated_at AS updatedAt FROM quotations",
    )
    .all()) {
    const parsed = parseQuotationNumber(row.qn);
    if (!parsed) continue;
    let payload = {};
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = {};
    }
    backfillQuotationNumber.run(
      `migrasi-${row.id}`,
      row.id,
      String(payload.date || row.createdAt).slice(0, 10),
      "Migrasi quotation",
      row.qn,
      Number(String(payload.date || row.createdAt).slice(0, 4)),
      parsed.series,
      parsed.sequenceNumber,
      row.customerName || payload.customer?.name || "Customer tidak tercatat",
      payload.project?.name || "",
      payload.customer?.pic || "",
      row.createdAt,
      row.updatedAt,
    );
  }

  db.prepare(`
    INSERT OR IGNORE INTO customers (
      id, name, address, pic_name, email, phone,
      last_project_name, last_project_location, active,
      created_by, updated_by, created_at, updated_at
    )
    SELECT lower(hex(randomblob(16))), customer_name,
           COALESCE(json_extract(payload, '$.customer.address'), ''),
           COALESCE(json_extract(payload, '$.customer.pic'), ''), '', '',
           COALESCE(project_name, ''),
           COALESCE(json_extract(payload, '$.project.location'), ''),
           1, 'Migrasi aplikasi', 'Migrasi aplikasi', created_at, updated_at
    FROM quotations
    WHERE trim(customer_name) <> ''
      AND deleted_at IS NULL
  `).run();

  db.prepare(`
    INSERT OR IGNORE INTO price_history (
      code, package_name, category, description, unit, price,
      source, snapshot_date, price_origin, verification_status,
      supplier, evidence_ref, notes, change_reason, changed_by, changed_at
    )
    SELECT code, package_name, category, description, unit, price,
           source, snapshot_date, price_origin, verification_status,
           supplier, evidence_ref, notes, 'BASELINE_MIGRATION',
           COALESCE(created_by, 'Migrasi aplikasi'),
           COALESCE(updated_at, CURRENT_TIMESTAMP)
    FROM prices
  `).run();

  function recordPriceHistory(code, actor, changeReason, changedAt = nowIso()) {
    const current = db.prepare(`
      SELECT code, package_name AS packageName, category, description, unit,
             price, source, snapshot_date AS snapshotDate,
             price_origin AS priceOrigin,
             verification_status AS verificationStatus,
             supplier, evidence_ref AS evidenceRef, notes
      FROM prices WHERE code = ?
    `).get(String(code ?? ""));
    if (!current) return false;
    const latest = db.prepare(`
      SELECT price, source, snapshot_date AS snapshotDate,
             verification_status AS verificationStatus,
             supplier, evidence_ref AS evidenceRef
      FROM price_history WHERE code = ?
      ORDER BY changed_at DESC, id DESC LIMIT 1
    `).get(current.code);
    if (
      latest &&
      Number(latest.price) === Number(current.price) &&
      latest.source === current.source &&
      (latest.snapshotDate || "") === (current.snapshotDate || "") &&
      latest.verificationStatus === current.verificationStatus &&
      (latest.supplier || "") === (current.supplier || "") &&
      (latest.evidenceRef || "") === (current.evidenceRef || "")
    ) {
      return false;
    }
    db.prepare(`
      INSERT INTO price_history (
        code, package_name, category, description, unit, price,
        source, snapshot_date, price_origin, verification_status,
        supplier, evidence_ref, notes, change_reason, changed_by, changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      current.code,
      current.packageName,
      current.category,
      current.description,
      current.unit,
      current.price,
      current.source,
      current.snapshotDate || null,
      current.priceOrigin,
      current.verificationStatus,
      current.supplier || null,
      current.evidenceRef || null,
      current.notes || null,
      String(changeReason || "UPDATE").slice(0, 80),
      actor,
      changedAt,
    );
    return true;
  }

  function importPrices(rows, actor = "system") {
    const statement = db.prepare(`
      INSERT INTO prices (
        code, package_name, category, description, unit, price,
        source, snapshot_date, needs_review, price_origin,
        verification_status, supplier, evidence_ref, notes,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        package_name = excluded.package_name,
        category = excluded.category,
        description = excluded.description,
        unit = excluded.unit,
        price = excluded.price,
        source = excluded.source,
        snapshot_date = excluded.snapshot_date,
        needs_review = excluded.needs_review,
        price_origin = excluded.price_origin,
        verification_status = excluded.verification_status,
        supplier = excluded.supplier,
        evidence_ref = excluded.evidence_ref,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `);
    const importedAt = nowIso();
    db.exec("BEGIN");
    try {
      for (const row of rows) {
        if (!String(row.code ?? "").trim()) continue;
        const isLogisticsPricelist =
          /MATERIAL_SUPPORT/i.test(String(row.source ?? "")) ||
          (row.packageName === "Material" &&
            row.category === "Material Support");
        const needsReview = Boolean(row.needsReview);
        statement.run(
          String(row.code).trim(),
          row.packageName || "Material",
          row.category || "Material",
          row.description || row.code,
          row.unit || "unit",
          Number(row.price) || 0,
          row.source || "Import",
          row.snapshotDate || null,
          needsReview ? 1 : 0,
          row.priceOrigin ||
            (isLogisticsPricelist ? "LOGISTIK_PRICELIST" : "PRICELIST_RESMI"),
          row.verificationStatus ||
            (needsReview
              ? "PERLU_REVIEW"
              : isLogisticsPricelist
                ? "TERVERIFIKASI_LOGISTIK"
                : "TERVERIFIKASI_SUMBER"),
          row.supplier || null,
          row.evidenceRef || null,
          row.notes || null,
          actor,
          importedAt,
          importedAt,
        );
        recordPriceHistory(String(row.code).trim(), actor, "PRICE_IMPORT", importedAt);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    db.prepare(`
      INSERT INTO audit_log (quotation_id, action, actor, detail, created_at)
      VALUES (NULL, 'PRICE_IMPORT', ?, ?, ?)
    `).run(actor, JSON.stringify({ rows: rows.length }), nowIso());
    return { imported: rows.length };
  }

  function nextManualPriceCode() {
    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const prefix = `MS-${date}-`;
    const row = db
      .prepare(
        "SELECT code FROM prices WHERE code LIKE ? ORDER BY code DESC LIMIT 1",
      )
      .get(`${prefix}%`);
    const sequence = row
      ? Number.parseInt(String(row.code).slice(prefix.length), 10) + 1
      : 1;
    return `${prefix}${String(Number.isFinite(sequence) ? sequence : 1).padStart(3, "0")}`;
  }

  function createManualPrice(row, actor = "Operator") {
    const description = String(row.description ?? "").trim();
    const unit = String(row.unit ?? "").trim();
    const supplier = String(row.supplier ?? "").trim();
    const evidenceRef = String(row.evidenceRef ?? "").trim();
    const snapshotDate = String(row.snapshotDate ?? "").trim();
    const price = Number(row.price);
    if (!description) throw new Error("Nama material wajib diisi.");
    if (!unit) throw new Error("Satuan material wajib diisi.");
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("Harga manual harus lebih dari nol.");
    }
    if (!supplier) {
      throw new Error("Supplier atau sumber harga manual wajib diisi.");
    }
    if (!evidenceRef) {
      throw new Error("Bukti/referensi harga manual wajib diisi.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
      throw new Error("Tanggal harga manual wajib diisi dengan benar.");
    }

    const requestedCode = String(row.code ?? "")
      .trim()
      .toUpperCase();
    const code = requestedCode || nextManualPriceCode();
    if (!/^[A-Z0-9][A-Z0-9._/-]{1,49}$/.test(code)) {
      throw new Error(
        "Kode hanya boleh berisi huruf, angka, titik, garis miring, tanda hubung, atau garis bawah.",
      );
    }
    if (db.prepare("SELECT 1 FROM prices WHERE code = ?").get(code)) {
      throw new Error(
        `Kode ${code} sudah ada. Gunakan kode lain agar riwayat harga tidak tertimpa.`,
      );
    }

    const createdAt = nowIso();
    const packageName = ["FirePro", "PAC", "Material"].includes(row.packageName)
      ? row.packageName
      : "Material";
    const category = String(row.category ?? "").trim() || "Material Support";
    const source = `Manual Support - ${supplier}`;
    db.prepare(`
      INSERT INTO prices (
        code, package_name, category, description, unit, price,
        source, snapshot_date, needs_review, price_origin,
        verification_status, supplier, evidence_ref, notes,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'MANUAL_SUPPORT',
                'PERLU_VERIFIKASI_LOGISTIK', ?, ?, ?, ?, ?, ?)
    `).run(
      code,
      packageName,
      category,
      description,
      unit,
      price,
      source,
      snapshotDate,
      supplier,
      evidenceRef,
      String(row.notes ?? "").trim() || null,
      actor,
      createdAt,
      createdAt,
    );
    recordPriceHistory(code, actor, "MANUAL_SUPPORT_CREATE", createdAt);
    recordAudit(null, "PRICE_MANUAL_CREATE", actor, {
      code,
      description,
      price,
      supplier,
      evidenceRef,
      snapshotDate,
      verificationStatus: "PERLU_VERIFIKASI_LOGISTIK",
    });
    return getPrice(code);
  }

  function upsertLogisticsPrice(row, actor = "Logistik") {
    const code = String(row.code ?? "").trim().toUpperCase();
    const description = String(row.description ?? "").trim();
    const unit = String(row.unit ?? "").trim();
    const supplier = String(row.supplier ?? "").trim();
    const evidenceRef = String(row.evidenceRef ?? "").trim();
    const snapshotDate = String(row.snapshotDate ?? "").trim();
    const price = Number(row.price);
    if (!/^[A-Z0-9][A-Z0-9._/-]{1,49}$/.test(code)) {
      throw new Error("Kode Logistik wajib 2-50 karakter dan hanya boleh berisi huruf, angka, titik, garis miring, tanda hubung, atau garis bawah.");
    }
    if (!description) throw new Error("Nama material wajib diisi.");
    if (!unit) throw new Error("Satuan material wajib diisi.");
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("Harga Logistik harus lebih dari nol.");
    }
    if (!supplier) throw new Error("Supplier atau sumber harga wajib diisi.");
    if (!evidenceRef) throw new Error("Nomor bukti atau referensi pembelian wajib diisi.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
      throw new Error("Tanggal harga wajib diisi dengan benar.");
    }
    const packageName = ["FirePro", "PAC", "Material"].includes(row.packageName)
      ? row.packageName
      : "Material";
    const category = String(row.category ?? "").trim() || "Material Support";
    const notes = String(row.notes ?? "").trim() || null;
    const updatedAt = nowIso();
    const existing = db.prepare("SELECT code, created_at AS createdAt FROM prices WHERE code = ?").get(code);
    db.prepare(`
      INSERT INTO prices (
        code, package_name, category, description, unit, price,
        source, snapshot_date, needs_review, price_origin,
        verification_status, supplier, evidence_ref, notes,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'LOGISTIK_MASTER',
                'TERVERIFIKASI_LOGISTIK', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        package_name = excluded.package_name,
        category = excluded.category,
        description = excluded.description,
        unit = excluded.unit,
        price = excluded.price,
        source = excluded.source,
        snapshot_date = excluded.snapshot_date,
        needs_review = 0,
        price_origin = 'LOGISTIK_MASTER',
        verification_status = 'TERVERIFIKASI_LOGISTIK',
        supplier = excluded.supplier,
        evidence_ref = excluded.evidence_ref,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `).run(
      code,
      packageName,
      category,
      description,
      unit,
      price,
      `Master Logistik - ${supplier}`,
      snapshotDate,
      supplier,
      evidenceRef,
      notes,
      actor,
      existing?.createdAt || updatedAt,
      updatedAt,
    );
    recordPriceHistory(
      code,
      actor,
      existing ? "LOGISTICS_UPDATE" : "LOGISTICS_CREATE",
      updatedAt,
    );
    recordAudit(null, existing ? "PRICE_LOGISTICS_UPDATE" : "PRICE_LOGISTICS_CREATE", actor, {
      code,
      description,
      price,
      supplier,
      evidenceRef,
      snapshotDate,
    });
    return getPrice(code);
  }

  function publicUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
      active: Boolean(row.active),
      mustChangePassword: Boolean(row.mustChangePassword),
      createdBy: row.createdBy || "",
      updatedBy: row.updatedBy || "",
      createdAt: row.createdAt || "",
      updatedAt: row.updatedAt || "",
    };
  }

  function loginUser(username, password, metadata = {}) {
    const normalizedUsername = String(username ?? "").trim().toLowerCase();
    const row = db.prepare(`
      SELECT id, username, display_name AS displayName, role,
             password_hash AS passwordHash, password_salt AS passwordSalt,
             active, must_change_password AS mustChangePassword
      FROM users WHERE username = ? COLLATE NOCASE
    `).get(normalizedUsername);
    if (!row || !row.active || !passwordMatches(password, row.passwordSalt, row.passwordHash)) {
      throw new Error("Username atau password tidak sesuai.");
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const createdAt = nowIso();
    const sessionDurationMs = metadata.rememberMe === true
      ? 30 * 24 * 60 * 60 * 1000
      : 12 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + sessionDurationMs).toISOString();
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(createdAt);
    db.prepare(`
      INSERT INTO sessions (
        id, user_id, token_hash, ip_address, user_agent,
        expires_at, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `session-${crypto.randomUUID()}`,
      row.id,
      tokenHash,
      String(metadata.ipAddress ?? "").slice(0, 80) || null,
      String(metadata.userAgent ?? "").slice(0, 240) || null,
      expiresAt,
      createdAt,
      createdAt,
    );
    recordAudit(null, "AUTH_LOGIN", row.displayName, {
      role: row.role,
      remembered: metadata.rememberMe === true,
    });
    return { token, expiresAt, user: publicUser(row) };
  }

  function getSessionUser(token) {
    const value = String(token ?? "").trim();
    if (!value) return null;
    const tokenHash = crypto.createHash("sha256").update(value).digest("hex");
    const now = nowIso();
    const row = db.prepare(`
      SELECT s.id AS sessionId, u.id, u.username,
             u.display_name AS displayName, u.role, u.active,
             u.must_change_password AS mustChangePassword
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
    `).get(tokenHash, now);
    if (!row) return null;
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now, row.sessionId);
    return publicUser(row);
  }

  function logoutUser(token) {
    const value = String(token ?? "").trim();
    if (!value) return false;
    const tokenHash = crypto.createHash("sha256").update(value).digest("hex");
    return db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash).changes > 0;
  }

  function changeUserPassword(userId, currentPassword, newPassword) {
    const row = db.prepare(`
      SELECT id, username, display_name AS displayName, role,
             password_hash AS passwordHash, password_salt AS passwordSalt,
             active, must_change_password AS mustChangePassword
      FROM users WHERE id = ? AND active = 1
    `).get(String(userId ?? ""));
    if (!row || !passwordMatches(currentPassword, row.passwordSalt, row.passwordHash)) {
      throw new Error("Password saat ini tidak sesuai.");
    }
    const password = validatePassword(newPassword);
    const next = passwordRecord(password);
    const updatedAt = nowIso();
    db.prepare(`
      UPDATE users
      SET password_hash = ?, password_salt = ?, must_change_password = 0, updated_at = ?
      WHERE id = ?
    `).run(next.hash, next.salt, updatedAt, row.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.id);
    recordAudit(null, "AUTH_PASSWORD_CHANGE", row.displayName, { role: row.role });
    return true;
  }

  function listUsers() {
    return db.prepare(`
      SELECT id, username, display_name AS displayName, role, active,
             must_change_password AS mustChangePassword,
             created_by AS createdBy, updated_by AS updatedBy,
             created_at AS createdAt, updated_at AS updatedAt
      FROM users ORDER BY role, display_name COLLATE NOCASE
    `).all().map(publicUser);
  }

  function createUser(input, actor = "Administrator") {
    const username = normalizeUsername(input.username);
    const displayName = String(input.displayName ?? "").trim().slice(0, 100);
    const role = String(input.role ?? "").trim().toUpperCase();
    const password = validatePassword(input.password);
    if (displayName.length < 2) throw new Error("Nama pengguna minimal 2 karakter.");
    if (!USER_ROLES.has(role)) throw new Error("Role pengguna tidak valid.");
    const credential = passwordRecord(password);
    const createdAt = nowIso();
    const id = `user-${crypto.randomUUID()}`;
    try {
      db.prepare(`
        INSERT INTO users (
          id, username, display_name, role, password_hash, password_salt,
          active, must_change_password, created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)
      `).run(
        id,
        username,
        displayName,
        role,
        credential.hash,
        credential.salt,
        actor,
        actor,
        createdAt,
        createdAt,
      );
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error.message))) {
        throw new Error(`Username ${username} sudah digunakan.`);
      }
      throw error;
    }
    recordAudit(null, "USER_CREATE", actor, { username, displayName, role });
    return listUsers().find((item) => item.id === id);
  }

  function updateUser(id, input, actor = "Administrator") {
    const existing = db.prepare(`
      SELECT id, username, display_name AS displayName, role, active
      FROM users WHERE id = ?
    `).get(String(id ?? ""));
    if (!existing) throw new Error("Akun pengguna tidak ditemukan.");
    const username = normalizeUsername(input.username ?? existing.username);
    const displayName = String(input.displayName ?? existing.displayName).trim().slice(0, 100);
    const role = String(input.role ?? existing.role).trim().toUpperCase();
    const active = input.active === undefined ? Boolean(existing.active) : input.active === true;
    if (displayName.length < 2) throw new Error("Nama pengguna minimal 2 karakter.");
    if (!USER_ROLES.has(role)) throw new Error("Role pengguna tidak valid.");
    if (existing.role === "ADMIN" && (!active || role !== "ADMIN")) {
      const activeAdmins = Number(
        db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'ADMIN' AND active = 1").get().total,
      );
      if (activeAdmins <= 1) {
        throw new Error("Administrator aktif terakhir tidak dapat dinonaktifkan atau diubah rolenya.");
      }
    }
    const updatedAt = nowIso();
    try {
      db.prepare(`
        UPDATE users
        SET username = ?, display_name = ?, role = ?, active = ?,
            updated_by = ?, updated_at = ?
        WHERE id = ?
      `).run(username, displayName, role, active ? 1 : 0, actor, updatedAt, existing.id);
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error.message))) {
        throw new Error(`Username ${username} sudah digunakan.`);
      }
      throw error;
    }
    const usernameChanged = username !== existing.username;
    if (!active || role !== existing.role || usernameChanged) {
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(existing.id);
    }
    recordAudit(null, "USER_UPDATE", actor, {
      username,
      previousUsername: existing.username,
      usernameChanged,
      displayName,
      role,
      active,
      previousRole: existing.role,
    });
    return listUsers().find((item) => item.id === existing.id);
  }

  function resetUserPassword(id, newPassword, actor = "Administrator") {
    const existing = db.prepare(`
      SELECT id, username, display_name AS displayName, role
      FROM users WHERE id = ?
    `).get(String(id ?? ""));
    if (!existing) throw new Error("Akun pengguna tidak ditemukan.");
    const password = passwordRecord(validatePassword(newPassword));
    const updatedAt = nowIso();
    db.prepare(`
      UPDATE users
      SET password_hash = ?, password_salt = ?, must_change_password = 1,
          updated_by = ?, updated_at = ?
      WHERE id = ?
    `).run(password.hash, password.salt, actor, updatedAt, existing.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(existing.id);
    recordAudit(null, "USER_PASSWORD_RESET", actor, {
      username: existing.username,
      displayName: existing.displayName,
      role: existing.role,
    });
    return true;
  }

  function getSettings() {
    return Object.fromEntries(
      db
        .prepare("SELECT key, value FROM settings ORDER BY key")
        .all()
        .map((row) => [row.key, row.value]),
    );
  }

  function getDashboard() {
    const quotationStats = db
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN validation_status = 'SIAP DIBUAT' THEN 1 ELSE 0 END) AS ready,
          SUM(CASE WHEN validation_status = 'PERLU REVIEW' THEN 1 ELSE 0 END) AS review,
          SUM(CASE WHEN validation_status = 'BELUM SIAP' THEN 1 ELSE 0 END) AS blocked,
          COALESCE(SUM(grand_total), 0) AS value
        FROM quotations
        WHERE deleted_at IS NULL
      `)
      .get();
    const priceStats = db
      .prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN price > 0 THEN 1 ELSE 0 END) AS priced,
               SUM(CASE WHEN needs_review = 1 THEN 1 ELSE 0 END) AS review,
               SUM(CASE WHEN price_origin = 'MANUAL_SUPPORT' THEN 1 ELSE 0 END) AS manual
        FROM prices
      `)
      .get();
    const qnStats = Object.fromEntries(
      ["FP", "PAC", "ME"].map((series) => [series, 0]),
    );
    for (const row of db
      .prepare(
        "SELECT series, COUNT(*) AS total FROM quotation_numbers GROUP BY series",
      )
      .all()) {
      qnStats[row.series] = Number(row.total) || 0;
    }
    const workflowStats = Object.fromEntries(
      [...WORKFLOW_STATUSES].map((status) => [status, 0]),
    );
    for (const row of db.prepare(`
      SELECT workflow_status AS status, COUNT(*) AS total
      FROM quotations WHERE deleted_at IS NULL GROUP BY workflow_status
    `).all()) {
      workflowStats[row.status] = Number(row.total) || 0;
    }
    return {
      quotationStats,
      priceStats,
      qnStats,
      workflowStats,
      recent: listQuotations(8),
      settings: getSettings(),
    };
  }

  function getManagementReport(year = new Date().getFullYear()) {
    const reportYear = Number(year);
    if (!Number.isInteger(reportYear) || reportYear < 2000 || reportYear > 2200) {
      throw new Error("Tahun laporan tidak valid.");
    }
    const monthly = db.prepare(`
      SELECT CAST(strftime('%m', created_at) AS INTEGER) AS month,
             COUNT(*) AS quotationCount,
             COALESCE(SUM(grand_total), 0) AS quotationValue,
             SUM(CASE WHEN workflow_status = 'WON' THEN 1 ELSE 0 END) AS wonCount,
             COALESCE(SUM(CASE WHEN workflow_status = 'WON' THEN grand_total ELSE 0 END), 0) AS wonValue
      FROM quotations
      WHERE deleted_at IS NULL
        AND CAST(strftime('%Y', created_at) AS INTEGER) = ?
      GROUP BY strftime('%m', created_at)
      ORDER BY month
    `).all(reportYear);
    const totals = db.prepare(`
      SELECT COUNT(*) AS quotationCount,
             COALESCE(SUM(grand_total), 0) AS quotationValue,
             SUM(CASE WHEN workflow_status = 'WON' THEN 1 ELSE 0 END) AS wonCount,
             SUM(CASE WHEN workflow_status = 'LOST' THEN 1 ELSE 0 END) AS lostCount,
             COALESCE(SUM(CASE WHEN workflow_status = 'WON' THEN grand_total ELSE 0 END), 0) AS wonValue,
             ROUND(AVG(CASE WHEN sent_at IS NOT NULL
               THEN MAX(0, julianday(sent_at) - julianday(created_at)) END), 1) AS averageDaysToSend
      FROM quotations
      WHERE deleted_at IS NULL AND quotation_year = ?
    `).get(reportYear);
    const reasons = db.prepare(`
      SELECT outcome_reason AS reason, COUNT(*) AS total
      FROM quotations
      WHERE deleted_at IS NULL AND quotation_year = ?
        AND workflow_status IN ('LOST', 'CANCELLED')
        AND trim(outcome_reason) <> ''
      GROUP BY outcome_reason ORDER BY total DESC, outcome_reason
    `).all(reportYear);
    const today = new Date().toISOString().slice(0, 10);
    const followUps = db.prepare(`
      SELECT id, qn, customer_name AS customerName, project_name AS projectName,
             workflow_status AS workflowStatus, follow_up_at AS followUpAt,
             workflow_owner_name AS workflowOwnerName,
             grand_total AS grandTotal
      FROM quotations
      WHERE deleted_at IS NULL AND follow_up_at IS NOT NULL
        AND workflow_status NOT IN ('WON', 'LOST', 'CANCELLED')
      ORDER BY follow_up_at, grand_total DESC LIMIT 100
    `).all();
    const stalePrices = db.prepare(`
      SELECT COUNT(*) AS total
      FROM prices
      WHERE snapshot_date IS NULL OR trim(snapshot_date) = '' OR
            julianday(?) - julianday(snapshot_date) > ?
    `).get(today, Math.max(1, Number(getSettings().priceMaxAgeDays) || 90));
    const closed = Number(totals.wonCount || 0) + Number(totals.lostCount || 0);
    return {
      year: reportYear,
      totals: {
        ...totals,
        winRate: closed ? Math.round((Number(totals.wonCount || 0) / closed) * 1000) / 10 : 0,
      },
      monthly,
      outcomeReasons: reasons,
      followUps: followUps.map((item) => ({
        ...item,
        overdue: item.followUpAt < today,
        dueToday: item.followUpAt === today,
      })),
      stalePriceCount: Number(stalePrices.total || 0),
    };
  }

  function listQuotations(limit = 100) {
    return db
      .prepare(`
        SELECT id, qn, revision, mode, package_name AS packageName,
               customer_name AS customerName, project_name AS projectName,
               validation_status AS validationStatus, subtotal, tax,
               grand_total AS grandTotal, created_at AS createdAt,
               updated_at AS updatedAt, workflow_status AS workflowStatus,
               workflow_note AS workflowNote,
               workflow_owner_name AS workflowOwnerName,
               workflow_owner_role AS workflowOwnerRole,
               workflow_updated_at AS workflowUpdatedAt,
               follow_up_at AS followUpAt, sent_at AS sentAt,
               validity_expires_at AS validityExpiresAt,
               outcome_reason AS outcomeReason
        FROM quotations
        WHERE deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(Math.min(500, Math.max(1, Number(limit) || 100)));
  }

  function listQuotationTracking({ status = "", packageName = "", query = "", limit = 300 } = {}) {
    const workflowStatus = String(status ?? "").trim().toUpperCase();
    if (workflowStatus && !WORKFLOW_STATUSES.has(workflowStatus)) {
      throw new Error("Filter status progres tidak valid.");
    }
    const packageFilter = String(packageName ?? "").trim();
    const term = `%${String(query ?? "").trim()}%`;
    return db.prepare(`
      SELECT id, qn, package_name AS packageName,
             customer_name AS customerName, project_name AS projectName,
             validation_status AS validationStatus,
             grand_total AS grandTotal,
             workflow_status AS workflowStatus,
             workflow_note AS workflowNote,
             workflow_owner_name AS workflowOwnerName,
             workflow_owner_role AS workflowOwnerRole,
             workflow_updated_at AS workflowUpdatedAt,
             follow_up_at AS followUpAt, sent_at AS sentAt,
             validity_expires_at AS validityExpiresAt,
             outcome_reason AS outcomeReason,
             created_at AS createdAt, updated_at AS updatedAt
      FROM quotations
      WHERE deleted_at IS NULL
        AND (? = '' OR workflow_status = ?)
        AND (? = '' OR package_name = ?)
        AND (? = '%%' OR qn LIKE ? OR customer_name LIKE ? OR project_name LIKE ? OR workflow_owner_name LIKE ?)
      ORDER BY
        CASE workflow_status
          WHEN 'WAITING_PRICE' THEN 1
          WHEN 'INTERNAL_REVIEW' THEN 2
          WHEN 'FOLLOW_UP' THEN 3
          WHEN 'CALCULATION' THEN 4
          WHEN 'DRAFT' THEN 5
          WHEN 'SENT' THEN 6
          ELSE 7
        END,
        workflow_updated_at DESC
      LIMIT ?
    `).all(
      workflowStatus,
      workflowStatus,
      packageFilter,
      packageFilter,
      term,
      term,
      term,
      term,
      term,
      Math.min(500, Math.max(1, Number(limit) || 300)),
    );
  }

  function updateQuotationWorkflow(id, input, actor = "Operator", actorRole = "SUPPORT") {
    const quotation = db.prepare(`
      SELECT id, qn, workflow_status AS workflowStatus,
             workflow_note AS workflowNote, sent_at AS sentAt
      FROM quotations WHERE id = ? AND deleted_at IS NULL
    `).get(String(id ?? ""));
    if (!quotation) throw new Error("Quotation tidak ditemukan.");
    const status = String(input.status ?? "").trim().toUpperCase();
    if (!WORKFLOW_STATUSES.has(status)) {
      throw new Error("Status progres quotation tidak valid.");
    }
    const note = String(input.note ?? "").trim().slice(0, 500);
    if (["WAITING_PRICE", "FOLLOW_UP", "LOST", "CANCELLED"].includes(status) && !note) {
      throw new Error("Catatan wajib diisi untuk status progres tersebut.");
    }
    const followUpAt = String(input.followUpAt ?? "").trim();
    if (followUpAt && !/^\d{4}-\d{2}-\d{2}$/.test(followUpAt)) {
      throw new Error("Tanggal follow-up tidak valid.");
    }
    if (status === "FOLLOW_UP" && !followUpAt) {
      throw new Error("Tanggal follow-up wajib diisi untuk status Follow-up.");
    }
    const outcomeReason = String(input.outcomeReason ?? "").trim().slice(0, 160);
    if (["LOST", "CANCELLED"].includes(status) && !outcomeReason) {
      throw new Error("Alasan hasil wajib dipilih untuk status Kalah atau Dibatalkan.");
    }
    if (status === "SENT") {
      const approvals = listQuotationApprovals(quotation.id);
      if (approvals.length && approvals.some((item) => item.status !== "APPROVED")) {
        throw new Error("Quotation belum dapat ditandai Terkirim karena approval masih belum lengkap.");
      }
    }
    const updatedAt = nowIso();
    const sentAt = status === "SENT" ? quotation.sentAt || updatedAt : quotation.sentAt;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        UPDATE quotations
        SET workflow_status = ?, workflow_note = ?, workflow_updated_at = ?,
            follow_up_at = ?, sent_at = ?, outcome_reason = ?
        WHERE id = ?
      `).run(
        status,
        note,
        updatedAt,
        followUpAt || null,
        sentAt || null,
        outcomeReason,
        quotation.id,
      );
      db.prepare(`
        INSERT INTO quotation_workflow_events (
          quotation_id, from_status, to_status, note, actor, actor_role, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        quotation.id,
        quotation.workflowStatus,
        status,
        note || null,
        actor,
        String(actorRole || "SUPPORT"),
        updatedAt,
      );
      db.prepare(`
        INSERT INTO audit_log (quotation_id, action, actor, detail, created_at)
        VALUES (?, 'WORKFLOW_UPDATE', ?, ?, ?)
      `).run(
        quotation.id,
        actor,
        JSON.stringify({
          from: quotation.workflowStatus,
          to: status,
          note,
          followUpAt: followUpAt || null,
          outcomeReason,
        }),
        updatedAt,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return listQuotationTracking({ query: quotation.qn, limit: 20 }).find((item) => item.id === quotation.id);
  }

  function getQuotationWorkflowEvents(id, limit = 100) {
    return db.prepare(`
      SELECT id, from_status AS fromStatus, to_status AS toStatus,
             note, actor, actor_role AS actorRole, created_at AS createdAt
      FROM quotation_workflow_events
      WHERE quotation_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(String(id ?? ""), Math.min(200, Math.max(1, Number(limit) || 100)));
  }

  function getQuotation(id) {
    const row = db
      .prepare("SELECT payload FROM quotations WHERE id = ? AND deleted_at IS NULL")
      .get(id);
    return row ? JSON.parse(row.payload) : null;
  }

  function getQuotationByQn(qn, year = new Date().getFullYear()) {
    const row = db
      .prepare("SELECT payload FROM quotations WHERE qn = ? AND quotation_year = ? AND deleted_at IS NULL")
      .get(qn, Number(year));
    return row ? JSON.parse(row.payload) : null;
  }

  function getQuotationMeta(id) {
    return db.prepare(`
      SELECT id, qn, revision, workflow_status AS workflowStatus,
             workflow_note AS workflowNote, deleted_at AS deletedAt,
             follow_up_at AS followUpAt, sent_at AS sentAt,
             validity_expires_at AS validityExpiresAt,
             outcome_reason AS outcomeReason
      FROM quotations WHERE id = ?
    `).get(String(id ?? "")) || null;
  }

  function isQuotationLocked(id) {
    const meta = getQuotationMeta(id);
    return Boolean(
      meta && !meta.deletedAt && LOCKED_WORKFLOW_STATUSES.has(meta.workflowStatus),
    );
  }

  function nextQn(packageName, initials = "YN", year = new Date().getFullYear()) {
    const series = seriesForPackage(packageName);
    const creatorInitials = normalizeInitials(initials);
    const quotationYear = Number(year);
    if (!Number.isInteger(quotationYear) || quotationYear < 2000 || quotationYear > 2200) {
      throw new Error("Tahun quotation tidak valid.");
    }
    const row = db
      .prepare(
        "SELECT COALESCE(MAX(sequence_number), 0) AS latest FROM quotation_numbers WHERE series = ? AND quotation_year = ?",
      )
      .get(series, quotationYear);
    return `QN/${series}-${creatorInitials}/${String(Number(row.latest) + 1).padStart(3, "0")}`;
  }

  function listQuotationNumbers({ series = "", year = "", query = "", limit = 500 } = {}) {
    const book = String(series ?? "").trim().toUpperCase();
    if (book && !QN_SERIES.has(book)) {
      throw new Error("Filter buku nomor tidak valid.");
    }
    const quotationYear = year === "" || year == null ? "" : Number(year);
    if (quotationYear !== "" && (!Number.isInteger(quotationYear) || quotationYear < 2000 || quotationYear > 2200)) {
      throw new Error("Filter tahun tidak valid.");
    }
    const term = `%${String(query ?? "").trim()}%`;
    return db
      .prepare(`
        SELECT id, quotation_id AS quotationId,
               quotation_date AS quotationDate,
               creator_name AS creatorName,
               quotation_number AS quotationNumber,
               quotation_year AS quotationYear, series, sequence_number AS sequenceNumber,
               customer_name AS customerName,
               project_name AS projectName, pic_name AS picName, source,
               created_at AS createdAt, updated_at AS updatedAt
        FROM quotation_numbers
        WHERE (? = '' OR series = ?)
          AND (? = '' OR quotation_year = ?)
          AND (? = '%%' OR quotation_number LIKE ? OR customer_name LIKE ? OR creator_name LIKE ?)
        ORDER BY quotation_year DESC, sequence_number DESC, quotation_date DESC
        LIMIT ?
      `)
      .all(
        book,
        book,
        quotationYear,
        quotationYear,
        term,
        term,
        term,
        term,
        Math.min(1000, Math.max(1, Number(limit) || 500)),
      );
  }

  function getQuotationNumber(id) {
    return db.prepare(`
      SELECT id, quotation_id AS quotationId,
             quotation_date AS quotationDate,
             creator_name AS creatorName,
             quotation_number AS quotationNumber,
             quotation_year AS quotationYear, series,
             sequence_number AS sequenceNumber,
             customer_name AS customerName,
             project_name AS projectName, pic_name AS picName, source,
             created_at AS createdAt, updated_at AS updatedAt
      FROM quotation_numbers
      WHERE id = ?
    `).get(String(id ?? ""));
  }

  function listQuotationYears() {
    return db
      .prepare("SELECT DISTINCT quotation_year AS year FROM quotation_numbers ORDER BY quotation_year DESC")
      .all()
      .map((row) => Number(row.year));
  }

  function getQnStats(year = "") {
    const stats = Object.fromEntries(["FP", "PAC", "ME"].map((series) => [series, 0]));
    const quotationYear = year === "" || year == null ? "" : Number(year);
    for (const row of db.prepare(`
      SELECT series, COUNT(*) AS total
      FROM quotation_numbers
      WHERE (? = '' OR quotation_year = ?)
      GROUP BY series
    `).all(quotationYear, quotationYear)) {
      stats[row.series] = Number(row.total) || 0;
    }
    return stats;
  }

  function normalizeManualQuotationNumberInput(input, actor = "Operator") {
    const series = normalizeSeries(input.series);
    const sequenceNumber = Math.round(Number(input.sequenceNumber));
    if (!Number.isInteger(sequenceNumber) || sequenceNumber < 1) {
      throw new Error("Nomor urut QN harus berupa angka bulat minimal 1.");
    }
    const quotationDate = String(input.quotationDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(quotationDate)) {
      throw new Error("Tanggal quotation wajib diisi.");
    }
    const quotationYear = Number(quotationDate.slice(0, 4));
    const creatorName = String(input.creatorName ?? actor).trim().slice(0, 80);
    const customerName = String(input.customerName ?? "").trim().slice(0, 180);
    const projectName = String(input.projectName ?? "").trim().slice(0, 180);
    const picName = String(input.picName ?? "").trim().slice(0, 120);
    if (!creatorName) throw new Error("Nama pembuat quotation wajib diisi.");
    if (!customerName) throw new Error("Nama customer wajib diisi.");
    const initials = normalizeInitials(input.creatorInitials, getSettings().initials || "YN");
    return {
      series,
      sequenceNumber,
      quotationDate,
      quotationYear,
      creatorName,
      customerName,
      projectName,
      picName,
      initials,
      quotationNumber: `QN/${series}-${initials}/${String(sequenceNumber).padStart(3, "0")}`,
    };
  }

  function createManualQuotationNumber(input, actor = "Operator") {
    const item = normalizeManualQuotationNumberInput(input, actor);
    const createdAt = nowIso();
    const id = `manual-${createdAt.replace(/\D/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      db.prepare(`
        INSERT INTO quotation_numbers (
          id, quotation_id, quotation_date, creator_name, quotation_number,
          quotation_year, series, sequence_number, customer_name, project_name, pic_name,
          source, created_at, updated_at
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', ?, ?)
      `).run(
        id,
        item.quotationDate,
        item.creatorName,
        item.quotationNumber,
        item.quotationYear,
        item.series,
        item.sequenceNumber,
        item.customerName,
        item.projectName,
        item.picName,
        createdAt,
        createdAt,
      );
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error.message))) {
        throw new Error(`Nomor urut ${item.sequenceNumber} sudah tercatat di Buku ${item.series} tahun ${item.quotationYear}.`);
      }
      throw error;
    }
    return getQuotationNumber(id);
  }

  function updateManualQuotationNumber(id, input, actor = "Operator") {
    const existing = db.prepare("SELECT id, source, quotation_id AS quotationId FROM quotation_numbers WHERE id = ?").get(String(id ?? ""));
    if (!existing) throw new Error("Catatan Buku QN tidak ditemukan.");
    if (existing.source !== "MANUAL" || existing.quotationId) {
      throw new Error("Hanya catatan manual yang dapat diedit.");
    }
    const item = normalizeManualQuotationNumberInput(input, actor);
    const updatedAt = nowIso();
    try {
      db.prepare(`
        UPDATE quotation_numbers
        SET quotation_date = ?, creator_name = ?, quotation_number = ?,
            quotation_year = ?, series = ?, sequence_number = ?, customer_name = ?,
            project_name = ?, pic_name = ?, updated_at = ?
        WHERE id = ?
      `).run(item.quotationDate, item.creatorName, item.quotationNumber, item.quotationYear,
        item.series, item.sequenceNumber, item.customerName, item.projectName,
        item.picName, updatedAt, existing.id);
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error.message))) {
        throw new Error(`Nomor urut ${item.sequenceNumber} sudah tercatat di Buku ${item.series} tahun ${item.quotationYear}.`);
      }
      throw error;
    }
    return getQuotationNumber(existing.id);
  }

  function listQuotationCreators() {
    return db.prepare(`
      SELECT id, creator_name AS creatorName, creator_initials AS creatorInitials,
             active, created_at AS createdAt, updated_at AS updatedAt
      FROM quotation_creators
      WHERE active = 1
      ORDER BY creator_name COLLATE NOCASE
    `).all().map((row) => ({ ...row, active: Boolean(row.active) }));
  }

  function createQuotationCreator(input) {
    const creatorName = String(input.creatorName ?? "").trim().slice(0, 80);
    const creatorInitials = normalizeInitials(input.creatorInitials, "");
    if (!creatorName) throw new Error("Nama pembuat quotation wajib diisi.");
    const createdAt = nowIso();
    const id = `creator-${createdAt.replace(/\D/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      db.prepare(`
        INSERT INTO quotation_creators (
          id, creator_name, creator_initials, active, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?)
      `).run(id, creatorName, creatorInitials, createdAt, createdAt);
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error.message))) {
        throw new Error(`Kode pembuat ${creatorInitials} sudah ada.`);
      }
      throw error;
    }
    return listQuotationCreators().find((item) => item.id === id);
  }

  function deleteManualQuotationNumber(id) {
    const item = db
      .prepare(`
        SELECT id, quotation_id AS quotationId,
               quotation_number AS quotationNumber, series, source,
               customer_name AS customerName
        FROM quotation_numbers
        WHERE id = ?
      `)
      .get(String(id ?? ""));
    if (!item) throw new Error("Catatan Buku QN tidak ditemukan.");
    if (item.source !== "MANUAL" || item.quotationId) {
      throw new Error(
        "Nomor otomatis tidak dapat dihapus dari buku karena masih terhubung ke quotation.",
      );
    }
    db.prepare("DELETE FROM quotation_numbers WHERE id = ?").run(item.id);
    return item;
  }

  function registerQuotationNumber(payload, actor, createdAt, updatedAt) {
    const parsed = parseQuotationNumber(payload.qn);
    if (!parsed) return;
    const quotationDate = String(payload.date || createdAt).slice(0, 10);
    const quotationYear = Number(quotationDate.slice(0, 4));
    const existing = db
      .prepare("SELECT id FROM quotation_numbers WHERE series = ? AND quotation_year = ? AND sequence_number = ?")
      .get(parsed.series, quotationYear, parsed.sequenceNumber);
    if (existing) {
      db.prepare(`
        UPDATE quotation_numbers
        SET quotation_id = ?, quotation_date = ?,
            customer_name = ?, project_name = ?, pic_name = ?, updated_at = ?
        WHERE id = ?
      `).run(
        payload.id,
        quotationDate,
        payload.customer?.name || "Customer tidak tercatat",
        payload.project?.name || "",
        payload.customer?.pic || "",
        updatedAt,
        existing.id,
      );
      return;
    }
    try {
      db.prepare(`
        INSERT INTO quotation_numbers (
          id, quotation_id, quotation_date, creator_name, quotation_number,
          quotation_year, series, sequence_number, customer_name, project_name, pic_name,
          source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AUTO', ?, ?)
      `).run(
        `auto-${payload.id}-${parsed.series}-${parsed.sequenceNumber}`,
        payload.id,
        quotationDate,
        actor,
        payload.qn,
        quotationYear,
        parsed.series,
        parsed.sequenceNumber,
        payload.customer?.name || "Customer tidak tercatat",
        payload.project?.name || "",
        payload.customer?.pic || "",
        createdAt,
        updatedAt,
      );
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error.message))) {
        throw new Error(`${payload.qn} sudah tercatat di Buku ${parsed.series}.`);
      }
      throw error;
    }
  }

  function saveQuotation(quotation, actor = "Operator", workflowContext = {}) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db
        .prepare(`
          SELECT created_at, workflow_status AS workflowStatus,
                 workflow_note AS workflowNote,
                 workflow_owner_name AS workflowOwnerName,
                 workflow_owner_role AS workflowOwnerRole,
                 workflow_updated_at AS workflowUpdatedAt,
                 deleted_at AS deletedAt
          FROM quotations WHERE id = ?
        `)
        .get(quotation.id);
      if (existing?.deletedAt) {
        throw new Error("Quotation berada di Recycle Bin dan harus dipulihkan sebelum diedit.");
      }
      if (existing && LOCKED_WORKFLOW_STATUSES.has(existing.workflowStatus)) {
        throw new Error(
          "Quotation yang sudah dikirim atau ditutup terkunci. Buat revisi baru untuk melakukan perubahan.",
        );
      }
      const createdAt = existing?.created_at ?? nowIso();
      const updatedAt = nowIso();
      const payload = { ...quotation, createdAt, updatedAt };
      const quotationYear = Number(String(payload.date || createdAt).slice(0, 4));
      const validityExpiresAt = quotationValidityDate(payload);
      const workflowStatus = existing?.workflowStatus || "DRAFT";
      const workflowNote = existing?.workflowNote || "Quotation baru dibuat.";
      const workflowOwnerName = existing?.workflowOwnerName || String(workflowContext.ownerName || actor).slice(0, 80);
      const workflowOwnerRole = existing?.workflowOwnerRole || String(workflowContext.ownerRole || "SUPPORT").slice(0, 40);
      const workflowUpdatedAt = existing?.workflowUpdatedAt || updatedAt;
      db.prepare(`
      INSERT INTO quotations (
        id, qn, quotation_year, revision, mode, package_name, customer_name, project_name,
        validation_status, subtotal, tax, grand_total, payload, created_at, updated_at,
        workflow_status, workflow_note, workflow_owner_name, workflow_owner_role,
        workflow_updated_at, validity_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        qn = excluded.qn,
        quotation_year = excluded.quotation_year,
        revision = excluded.revision,
        mode = excluded.mode,
        package_name = excluded.package_name,
        customer_name = excluded.customer_name,
        project_name = excluded.project_name,
        validation_status = excluded.validation_status,
        subtotal = excluded.subtotal,
        tax = excluded.tax,
        grand_total = excluded.grand_total,
        payload = excluded.payload,
        validity_expires_at = excluded.validity_expires_at,
        updated_at = excluded.updated_at
      `).run(
        payload.id,
        payload.qn,
        quotationYear,
        Number(payload.revision) || 0,
        payload.mode,
        payload.packageName,
        payload.customer?.name || "",
        payload.project?.name || "",
        payload.validation.status,
        payload.totals.subtotal,
        payload.totals.tax,
        payload.totals.grandTotal,
        JSON.stringify(payload),
        createdAt,
        updatedAt,
        workflowStatus,
        workflowNote,
        workflowOwnerName,
        workflowOwnerRole,
        workflowUpdatedAt,
        validityExpiresAt,
      );
      registerQuotationNumber(payload, actor, createdAt, updatedAt);
      if (!workflowContext.autosave) upsertCustomerFromQuotation(payload, actor);
      if (!existing) {
        db.prepare(`
          INSERT INTO quotation_workflow_events (
            quotation_id, from_status, to_status, note, actor, actor_role, created_at
          ) VALUES (?, NULL, 'DRAFT', ?, ?, ?, ?)
        `).run(
          payload.id,
          workflowNote,
          actor,
          workflowOwnerRole,
          workflowUpdatedAt,
        );
      }
      if (!workflowContext.autosave) {
        db.prepare(`
        INSERT INTO audit_log (quotation_id, action, actor, detail, created_at)
        VALUES (?, ?, ?, ?, ?)
        `).run(
          payload.id,
          existing ? "UPDATE" : "CREATE",
          actor,
          JSON.stringify({
            qn: payload.qn,
            status: payload.validation.status,
            total: payload.totals.grandTotal,
          }),
          updatedAt,
        );
      }
      db.exec("COMMIT");
      return payload;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function deleteDraftQuotation(id, actor = "Operator") {
    const row = db
      .prepare(`
        SELECT id, qn, customer_name AS customerName,
               validation_status AS validationStatus
        FROM quotations
        WHERE id = ? AND deleted_at IS NULL
      `)
      .get(String(id ?? ""));
    if (!row) throw new Error("Draft quotation tidak ditemukan.");
    if (row.validationStatus === "SIAP DIBUAT") {
      throw new Error(
        "Quotation berstatus SIAP DIBUAT tidak dapat dihapus sebagai draft.",
      );
    }
    const deletedAt = nowIso();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        UPDATE quotation_numbers
        SET quotation_id = NULL, source = 'DIBATALKAN', updated_at = ?
        WHERE quotation_id = ?
      `).run(deletedAt, row.id);
      db.prepare(`
        UPDATE quotations
        SET deleted_at = ?, deleted_by = ?, updated_at = ?
        WHERE id = ?
      `).run(deletedAt, actor, deletedAt, row.id);
      db.prepare(`
        INSERT INTO audit_log (quotation_id, action, actor, detail, created_at)
        VALUES (?, 'DELETE_DRAFT', ?, ?, ?)
      `).run(
        row.id,
        actor,
        JSON.stringify({
          qn: row.qn,
          customerName: row.customerName,
          previousStatus: row.validationStatus,
        }),
        deletedAt,
      );
      db.exec("COMMIT");
      return row;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function listDeletedQuotations(limit = 100) {
    return db.prepare(`
      SELECT id, qn, revision, mode, package_name AS packageName,
             customer_name AS customerName, project_name AS projectName,
             validation_status AS validationStatus, grand_total AS grandTotal,
             deleted_at AS deletedAt, deleted_by AS deletedBy,
             created_at AS createdAt, updated_at AS updatedAt
      FROM quotations
      WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at DESC
      LIMIT ?
    `).all(Math.min(500, Math.max(1, Number(limit) || 100)));
  }

  function restoreDraftQuotation(id, actor = "Operator") {
    const row = db.prepare(`
      SELECT id, qn, customer_name AS customerName,
             validation_status AS validationStatus, payload
      FROM quotations
      WHERE id = ? AND deleted_at IS NOT NULL
    `).get(String(id ?? ""));
    if (!row) throw new Error("Draft tidak ditemukan di Recycle Bin.");
    const restoredAt = nowIso();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        UPDATE quotations
        SET deleted_at = NULL, deleted_by = NULL, updated_at = ?
        WHERE id = ?
      `).run(restoredAt, row.id);
      const bookRow = db.prepare(`
        SELECT id FROM quotation_numbers
        WHERE quotation_number = ? AND quotation_id IS NULL AND source = 'DIBATALKAN'
        ORDER BY updated_at DESC LIMIT 1
      `).get(row.qn);
      if (bookRow) {
        db.prepare(`
          UPDATE quotation_numbers
          SET quotation_id = ?, source = 'DIPULIHKAN', updated_at = ?
          WHERE id = ?
        `).run(row.id, restoredAt, bookRow.id);
      } else {
        const payload = JSON.parse(row.payload);
        registerQuotationNumber(payload, actor, payload.createdAt || restoredAt, restoredAt);
      }
      db.prepare(`
        INSERT INTO audit_log (quotation_id, action, actor, detail, created_at)
        VALUES (?, 'RESTORE_DRAFT', ?, ?, ?)
      `).run(
        row.id,
        actor,
        JSON.stringify({ qn: row.qn, customerName: row.customerName }),
        restoredAt,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return getQuotation(row.id);
  }

  function listCustomers({ query = "", includeInactive = false, limit = 500 } = {}) {
    const term = `%${String(query ?? "").trim()}%`;
    return db.prepare(`
      SELECT id, name, address, pic_name AS picName, email, phone,
             last_project_name AS lastProjectName,
             last_project_location AS lastProjectLocation,
             active, created_by AS createdBy, updated_by AS updatedBy,
             created_at AS createdAt, updated_at AS updatedAt
      FROM customers
      WHERE (? = 1 OR active = 1)
        AND (? = '%%' OR name LIKE ? OR pic_name LIKE ? OR
             last_project_name LIKE ? OR email LIKE ? OR phone LIKE ?)
      ORDER BY active DESC, name COLLATE NOCASE
      LIMIT ?
    `).all(
      includeInactive ? 1 : 0,
      term,
      term,
      term,
      term,
      term,
      term,
      Math.min(1000, Math.max(1, Number(limit) || 500)),
    ).map((row) => ({ ...row, active: Boolean(row.active) }));
  }

  function saveCustomer(input, actor = "Operator") {
    const id = String(input.id || `customer-${crypto.randomUUID()}`);
    const name = String(input.name ?? "").trim().slice(0, 180);
    if (!name) throw new Error("Nama customer wajib diisi.");
    const existing = input.id
      ? db.prepare("SELECT id, created_at AS createdAt, created_by AS createdBy FROM customers WHERE id = ?").get(id)
      : db.prepare("SELECT id, created_at AS createdAt, created_by AS createdBy FROM customers WHERE name = ? COLLATE NOCASE").get(name);
    const customerId = existing?.id || id;
    const updatedAt = nowIso();
    const values = {
      address: String(input.address ?? "").trim().slice(0, 500),
      picName: String(input.picName ?? input.pic ?? "").trim().slice(0, 120),
      email: String(input.email ?? "").trim().slice(0, 160),
      phone: String(input.phone ?? "").trim().slice(0, 80),
      lastProjectName: String(input.lastProjectName ?? input.projectName ?? "").trim().slice(0, 180),
      lastProjectLocation: String(input.lastProjectLocation ?? input.projectLocation ?? "").trim().slice(0, 180),
      active: input.active === false ? 0 : 1,
    };
    try {
      db.prepare(`
        INSERT INTO customers (
          id, name, address, pic_name, email, phone,
          last_project_name, last_project_location, active,
          created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          address = excluded.address,
          pic_name = excluded.pic_name,
          email = excluded.email,
          phone = excluded.phone,
          last_project_name = excluded.last_project_name,
          last_project_location = excluded.last_project_location,
          active = excluded.active,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `).run(
        customerId,
        name,
        values.address,
        values.picName,
        values.email,
        values.phone,
        values.lastProjectName,
        values.lastProjectLocation,
        values.active,
        existing?.createdBy || actor,
        actor,
        existing?.createdAt || updatedAt,
        updatedAt,
      );
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error.message))) {
        throw new Error(`Customer ${name} sudah ada.`);
      }
      throw error;
    }
    recordAudit(null, existing ? "CUSTOMER_UPDATE" : "CUSTOMER_CREATE", actor, {
      customerId,
      name,
    });
    return listCustomers({ includeInactive: true }).find((item) => item.id === customerId);
  }

  function upsertCustomerFromQuotation(quotation, actor = "Operator") {
    const name = String(quotation?.customer?.name ?? "").trim();
    if (!name) return null;
    const existing = db.prepare(`
      SELECT id, name, address, pic_name AS picName, email, phone,
             last_project_name AS lastProjectName,
             last_project_location AS lastProjectLocation,
             active, created_at AS createdAt, created_by AS createdBy
      FROM customers WHERE name = ? COLLATE NOCASE
    `).get(name);
    return saveCustomer({
      id: existing?.id,
      name,
      address: quotation.customer?.address || existing?.address || "",
      picName: quotation.customer?.pic || existing?.picName || "",
      email: quotation.customer?.email || existing?.email || "",
      phone: quotation.customer?.phone || existing?.phone || "",
      lastProjectName: quotation.project?.name || existing?.lastProjectName || "",
      lastProjectLocation: quotation.project?.location || existing?.lastProjectLocation || "",
      active: true,
    }, actor);
  }

  function templatePayloadFromQuotation(quotation) {
    const copy = JSON.parse(JSON.stringify(quotation || {}));
    delete copy.id;
    delete copy.qn;
    delete copy.createdAt;
    delete copy.updatedAt;
    delete copy.validation;
    copy.revision = 0;
    copy.customer = { name: "", address: "", pic: "", email: "", phone: "" };
    copy.project = { name: "", location: "" };
    if (copy.firepro) {
      copy.firepro.approvalStatus = "Belum disetujui";
      copy.firepro.acesAttachments = [];
      copy.firepro.aces = {
        ...(copy.firepro.aces || {}),
        referenceNumber: "",
        approvalResult: "",
        approvalNote: "",
        importedFrom: "",
        importedAt: "",
        attachments: [],
      };
    }
    if (copy.pac) {
      copy.pac.approvalStatus = "Belum disetujui";
      copy.pac.priceConfirmed = false;
    }
    return copy;
  }

  function listQuotationTemplates(includeInactive = false) {
    return db.prepare(`
      SELECT id, name, description, package_name AS packageName, payload,
             active, created_by AS createdBy,
             created_at AS createdAt, updated_at AS updatedAt
      FROM quotation_templates
      WHERE (? = 1 OR active = 1)
      ORDER BY active DESC, name COLLATE NOCASE
    `).all(includeInactive ? 1 : 0).map((row) => ({
      ...row,
      active: Boolean(row.active),
      payload: JSON.parse(row.payload),
    }));
  }

  function createQuotationTemplate(input, actor = "Operator") {
    const name = String(input.name ?? "").trim().slice(0, 120);
    if (name.length < 3) throw new Error("Nama template minimal 3 karakter.");
    const quotation = input.quotation || input.payload;
    if (!quotation || typeof quotation !== "object") {
      throw new Error("Data quotation untuk template tidak tersedia.");
    }
    const payload = templatePayloadFromQuotation(quotation);
    const id = `template-${crypto.randomUUID()}`;
    const createdAt = nowIso();
    try {
      db.prepare(`
        INSERT INTO quotation_templates (
          id, name, description, package_name, payload, active,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        id,
        name,
        String(input.description ?? "").trim().slice(0, 300),
        payload.packageName || "FirePro + PAC",
        JSON.stringify(payload),
        actor,
        createdAt,
        createdAt,
      );
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error.message))) {
        throw new Error(`Template ${name} sudah ada.`);
      }
      throw error;
    }
    recordAudit(null, "TEMPLATE_CREATE", actor, { id, name });
    return listQuotationTemplates(true).find((item) => item.id === id);
  }

  function setQuotationTemplateActive(id, active, actor = "Operator") {
    const existing = db.prepare("SELECT id, name FROM quotation_templates WHERE id = ?").get(String(id ?? ""));
    if (!existing) throw new Error("Template quotation tidak ditemukan.");
    db.prepare("UPDATE quotation_templates SET active = ?, updated_at = ? WHERE id = ?")
      .run(active ? 1 : 0, nowIso(), existing.id);
    recordAudit(null, active ? "TEMPLATE_RESTORE" : "TEMPLATE_ARCHIVE", actor, existing);
    return listQuotationTemplates(true).find((item) => item.id === existing.id);
  }

  function listQuotationVersions(id) {
    return db.prepare(`
      SELECT id, quotation_id AS quotationId, revision, snapshot, note,
             created_by AS createdBy, created_at AS createdAt
      FROM quotation_versions
      WHERE quotation_id = ?
      ORDER BY revision DESC
    `).all(String(id ?? "")).map((row) => ({
      ...row,
      snapshot: JSON.parse(row.snapshot),
    }));
  }

  function createQuotationRevision(id, note, actor = "Operator", actorRole = "SUPPORT") {
    const row = db.prepare(`
      SELECT id, qn, revision, payload, workflow_status AS workflowStatus,
             deleted_at AS deletedAt
      FROM quotations WHERE id = ?
    `).get(String(id ?? ""));
    if (!row || row.deletedAt) throw new Error("Quotation tidak ditemukan.");
    const revisionNote = String(note ?? "").trim().slice(0, 300);
    if (!revisionNote) throw new Error("Alasan pembuatan revisi wajib diisi.");
    const current = JSON.parse(row.payload);
    const nextRevision = Number(row.revision) + 1;
    const updatedAt = nowIso();
    const next = JSON.parse(JSON.stringify(current));
    next.revision = nextRevision;
    next.updatedAt = updatedAt;
    if (next.firepro) next.firepro.approvalStatus = "Belum disetujui";
    if (next.pac) {
      next.pac.approvalStatus = "Belum disetujui";
      next.pac.priceConfirmed = false;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        INSERT OR IGNORE INTO quotation_versions (
          quotation_id, revision, snapshot, note, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(row.id, Number(row.revision), JSON.stringify(current), revisionNote, actor, updatedAt);
      db.prepare(`
        UPDATE quotations
        SET revision = ?, payload = ?, validation_status = 'BELUM SIAP',
            workflow_status = 'DRAFT', workflow_note = ?,
            workflow_owner_name = ?, workflow_owner_role = ?,
            workflow_updated_at = ?, follow_up_at = NULL, sent_at = NULL,
            outcome_reason = '', updated_at = ?
        WHERE id = ?
      `).run(
        nextRevision,
        JSON.stringify(next),
        `Revisi ${nextRevision} dibuat: ${revisionNote}`,
        actor,
        actorRole,
        updatedAt,
        updatedAt,
        row.id,
      );
      db.prepare(`
        INSERT INTO quotation_workflow_events (
          quotation_id, from_status, to_status, note, actor, actor_role, created_at
        ) VALUES (?, ?, 'DRAFT', ?, ?, ?, ?)
      `).run(row.id, row.workflowStatus, `Revisi ${nextRevision}: ${revisionNote}`, actor, actorRole, updatedAt);
      db.prepare(`
        INSERT INTO audit_log (quotation_id, action, actor, detail, created_at)
        VALUES (?, 'REVISION_CREATE', ?, ?, ?)
      `).run(row.id, actor, JSON.stringify({ fromRevision: row.revision, toRevision: nextRevision, note: revisionNote }), updatedAt);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return getQuotation(row.id);
  }

  function listQuotationApprovals(id) {
    const meta = getQuotationMeta(id);
    if (!meta) return [];
    return db.prepare(`
      SELECT id, quotation_id AS quotationId, revision,
             approval_type AS approvalType, status, note, actor,
             actor_role AS actorRole, requested_by AS requestedBy,
             requested_at AS requestedAt, decided_at AS decidedAt
      FROM quotation_approvals
      WHERE quotation_id = ? AND revision = ?
      ORDER BY CASE approval_type
        WHEN 'TECHNICAL' THEN 1 WHEN 'PRICE' THEN 2 ELSE 3 END
    `).all(meta.id, meta.revision);
  }

  function requestQuotationApprovals(id, actor = "Operator", actorRole = "SUPPORT") {
    const row = db.prepare(`
      SELECT id, revision, payload, workflow_status AS workflowStatus,
             deleted_at AS deletedAt
      FROM quotations WHERE id = ?
    `).get(String(id ?? ""));
    if (!row || row.deletedAt) throw new Error("Quotation tidak ditemukan.");
    if (LOCKED_WORKFLOW_STATUSES.has(row.workflowStatus)) {
      throw new Error("Quotation terkunci. Buat revisi baru sebelum mengajukan approval.");
    }
    const quotation = JSON.parse(row.payload);
    const needsPriceApproval = (quotation.items || []).some((item) =>
      item.active !== false && (
        item.needsReview === true ||
        item.priceOrigin === "MANUAL_SUPPORT" ||
        (item.overridePrice !== "" && item.overridePrice != null) ||
        Number(item.discountPercent) > 0
      ),
    );
    const types = ["TECHNICAL", ...(needsPriceApproval ? ["PRICE"] : []), "MANAGER"];
    const requestedAt = nowIso();
    db.exec("BEGIN IMMEDIATE");
    try {
      const statement = db.prepare(`
        INSERT INTO quotation_approvals (
          quotation_id, revision, approval_type, status, note,
          actor, actor_role, requested_by, requested_at, decided_at
        ) VALUES (?, ?, ?, 'PENDING', '', NULL, NULL, ?, ?, NULL)
        ON CONFLICT(quotation_id, revision, approval_type) DO UPDATE SET
          status = 'PENDING', note = '', actor = NULL, actor_role = NULL,
          requested_by = excluded.requested_by,
          requested_at = excluded.requested_at, decided_at = NULL
      `);
      for (const type of types) statement.run(row.id, row.revision, type, actor, requestedAt);
      db.prepare(`
        UPDATE quotations
        SET workflow_status = 'INTERNAL_REVIEW',
            workflow_note = 'Menunggu approval internal.',
            workflow_owner_name = ?, workflow_owner_role = ?,
            workflow_updated_at = ?
        WHERE id = ?
      `).run(actor, actorRole, requestedAt, row.id);
      db.prepare(`
        INSERT INTO quotation_workflow_events (
          quotation_id, from_status, to_status, note, actor, actor_role, created_at
        ) VALUES (?, ?, 'INTERNAL_REVIEW', 'Approval internal diajukan.', ?, ?, ?)
      `).run(row.id, row.workflowStatus, actor, actorRole, requestedAt);
      db.prepare(`
        INSERT INTO audit_log (quotation_id, action, actor, detail, created_at)
        VALUES (?, 'APPROVAL_REQUEST', ?, ?, ?)
      `).run(row.id, actor, JSON.stringify({ revision: row.revision, types }), requestedAt);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return listQuotationApprovals(row.id);
  }

  function decideQuotationApproval(id, approvalType, input, actor = "Operator", actorRole = "SUPPORT") {
    const type = String(approvalType ?? "").trim().toUpperCase();
    const status = String(input.status ?? "").trim().toUpperCase();
    if (!APPROVAL_TYPES.has(type)) throw new Error("Jenis approval tidak valid.");
    if (!APPROVAL_STATUSES.has(status) || status === "PENDING") {
      throw new Error("Keputusan approval harus APPROVED atau REJECTED.");
    }
    const meta = getQuotationMeta(id);
    if (!meta || meta.deletedAt) throw new Error("Quotation tidak ditemukan.");
    const existing = db.prepare(`
      SELECT id FROM quotation_approvals
      WHERE quotation_id = ? AND revision = ? AND approval_type = ?
    `).get(meta.id, meta.revision, type);
    if (!existing) throw new Error("Approval tersebut belum diajukan.");
    const note = String(input.note ?? "").trim().slice(0, 500);
    if (status === "REJECTED" && !note) throw new Error("Alasan penolakan wajib diisi.");
    const decidedAt = nowIso();
    db.prepare(`
      UPDATE quotation_approvals
      SET status = ?, note = ?, actor = ?, actor_role = ?, decided_at = ?
      WHERE id = ?
    `).run(status, note, actor, actorRole, decidedAt, existing.id);
    recordAudit(meta.id, `APPROVAL_${status}`, actor, {
      revision: meta.revision,
      approvalType: type,
      actorRole,
      note,
    });
    return listQuotationApprovals(meta.id);
  }

  function searchPrices({ query = "", packageName = "", limit = 100 } = {}) {
    const term = `%${String(query).trim()}%`;
    const packageFilter = String(packageName).trim();
    const maxAgeDays = Math.max(1, Number(getSettings().priceMaxAgeDays) || 90);
    return db
      .prepare(`
        SELECT code, package_name AS packageName, category, description, unit,
               price, source, snapshot_date AS snapshotDate,
               needs_review AS needsReview, price_origin AS priceOrigin,
               verification_status AS verificationStatus, supplier,
               evidence_ref AS evidenceRef, notes,
               created_by AS createdBy, created_at AS createdAt,
               updated_at AS updatedAt
        FROM prices
        WHERE (? = '' OR package_name = ?)
          AND (? = '%%' OR code LIKE ? OR description LIKE ? OR
               COALESCE(supplier, '') LIKE ? OR COALESCE(evidence_ref, '') LIKE ?)
        ORDER BY CASE WHEN price > 0 THEN 0 ELSE 1 END, description
        LIMIT ?
      `)
      .all(
        packageFilter,
        packageFilter,
        term,
        term,
        term,
        term,
        term,
        Math.min(500, Math.max(1, Number(limit) || 100)),
      )
      .map((row) => enrichPriceRow(row, maxAgeDays));
  }

  function enrichPriceRow(row, maxAgeDays) {
    const snapshotTime = /^\d{4}-\d{2}-\d{2}$/.test(String(row.snapshotDate || ""))
      ? new Date(`${row.snapshotDate}T00:00:00Z`).getTime()
      : Number.NaN;
    const ageDays = Number.isFinite(snapshotTime)
      ? Math.max(0, Math.floor((Date.now() - snapshotTime) / 86_400_000))
      : null;
    return {
      ...row,
      needsReview: Boolean(row.needsReview),
      ageDays,
      isStale: ageDays == null || ageDays > maxAgeDays,
    };
  }

  function getPrice(code) {
    return searchPrices({ query: String(code ?? ""), limit: 500 }).find(
      (row) => row.code === code,
    );
  }

  function resolvePrices(codes = []) {
    const uniqueCodes = [
      ...new Set(codes.map((code) => String(code ?? "").trim()).filter(Boolean)),
    ].slice(0, 100);
    if (!uniqueCodes.length) return [];
    const maxAgeDays = Math.max(1, Number(getSettings().priceMaxAgeDays) || 90);
    const placeholders = uniqueCodes.map(() => "?").join(", ");
    return db
      .prepare(`
        SELECT code, package_name AS packageName, category, description, unit,
               price, source, snapshot_date AS snapshotDate,
               needs_review AS needsReview, price_origin AS priceOrigin,
               verification_status AS verificationStatus, supplier,
               evidence_ref AS evidenceRef, notes,
               created_by AS createdBy, created_at AS createdAt,
               updated_at AS updatedAt
        FROM prices
        WHERE code IN (${placeholders})
      `)
      .all(...uniqueCodes)
      .map((row) => enrichPriceRow(row, maxAgeDays));
  }

  function listPriceHistory(code, limit = 100) {
    return db.prepare(`
      SELECT id, code, package_name AS packageName, category, description,
             unit, price, source, snapshot_date AS snapshotDate,
             price_origin AS priceOrigin,
             verification_status AS verificationStatus,
             supplier, evidence_ref AS evidenceRef, notes,
             change_reason AS changeReason, changed_by AS changedBy,
             changed_at AS changedAt
      FROM price_history
      WHERE code = ?
      ORDER BY changed_at DESC, id DESC
      LIMIT ?
    `).all(
      String(code ?? "").trim(),
      Math.min(500, Math.max(1, Number(limit) || 100)),
    );
  }

  function recordAudit(
    quotationId,
    action,
    actor = "Operator",
    detail = null,
  ) {
    db.prepare(`
      INSERT INTO audit_log (quotation_id, action, actor, detail, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      quotationId || null,
      action,
      actor,
      detail == null
        ? null
        : typeof detail === "string"
          ? detail
          : JSON.stringify(detail),
      nowIso(),
    );
  }

  function recordExport(id, type, actor = "Operator") {
    recordAudit(id, `EXPORT_${type.toUpperCase()}`, actor);
  }

  function getAudit(id, limit = 50) {
    return db
      .prepare(`
        SELECT action, actor, detail, created_at AS createdAt
        FROM audit_log
        WHERE quotation_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(id, Math.min(200, Math.max(1, Number(limit) || 50)));
  }

  async function backupDatabase(targetPath) {
    const destination = path.resolve(String(targetPath ?? ""));
    if (!destination || destination === path.parse(destination).root) {
      throw new Error("Lokasi backup database tidak valid.");
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const pages = await backup(db, destination);
    return { destination, pages };
  }

  return {
    databasePath,
    close: () => db.close(),
    importPrices,
    getSettings,
    getDashboard,
    getManagementReport,
    listQuotations,
    listQuotationTracking,
    updateQuotationWorkflow,
    getQuotationWorkflowEvents,
    getQuotation,
    getQuotationByQn,
    getQuotationMeta,
    isQuotationLocked,
    nextQn,
    listQuotationNumbers,
    listQuotationYears,
    getQnStats,
    createManualQuotationNumber,
    updateManualQuotationNumber,
    deleteManualQuotationNumber,
    listQuotationCreators,
    createQuotationCreator,
    saveQuotation,
    deleteDraftQuotation,
    listDeletedQuotations,
    restoreDraftQuotation,
    listCustomers,
    saveCustomer,
    listQuotationTemplates,
    createQuotationTemplate,
    setQuotationTemplateActive,
    listQuotationVersions,
    createQuotationRevision,
    listQuotationApprovals,
    requestQuotationApprovals,
    decideQuotationApproval,
    searchPrices,
    getPrice,
    resolvePrices,
    listPriceHistory,
    createManualPrice,
    upsertLogisticsPrice,
    loginUser,
    getSessionUser,
    logoutUser,
    changeUserPassword,
    listUsers,
    createUser,
    updateUser,
    resetUserPassword,
    recordAudit,
    recordExport,
    getAudit,
    backupDatabase,
  };
}
