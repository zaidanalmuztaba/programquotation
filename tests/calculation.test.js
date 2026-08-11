import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { calculateQuotation } from "../lib/calculation.js";
import { createStore } from "../lib/database.js";
import { buildDocxBuffer, buildPdfBuffer } from "../lib/exporters.js";

process.env.MNN_BOOTSTRAP_LOGISTICS_PASSWORD = "Logistik@MNN2026";

function sampleQuotation(mode = "DEMO") {
  return calculateQuotation({
    id: "test-qn",
    qn: "QN/FP-PAC-YN/001",
    date: "2026-07-29",
    mode,
    packageName: "FirePro + PAC",
    sourceSnapshotDate: "2026-07-06",
    customer: {
      name: "PT TEST",
      address: "Jakarta",
      pic: "Bpk. Test",
    },
    project: { name: "Test Project", location: "Jakarta" },
    terms: {
      ppnIncluded: false,
      ppnRate: 11,
      validityDays: 14,
      franco: "Jakarta",
      payment: "Sesuai PO",
      delivery: "Setelah PO",
      warranty: "1 tahun",
      notes: "",
    },
    firepro: {
      rooms: [
        {
          name: "Room 1",
          length: 17,
          width: 2.44,
          height: 3.6,
          raisedFloor: 0.3,
          falseCeiling: 0,
          fireClass: 46,
          safetyFactor: 1.3,
        },
      ],
      approvedAgent: 9150,
      acesReference: "ACES-01",
      approvalStatus: "Disetujui - final",
      acesAttachments: [
        {
          id: "attachment-test",
          originalName: "Hasil ACES.docx",
          storedName: "attachment-test.docx",
          type: "DOCX",
        },
      ],
      aces: {
        projectName: "PT TEST",
        reportDate: "July 2026",
        referenceNumber: "ACES-01",
        roomName: "Room 1",
        spaceType: "Power Generator Rooms",
        width: 2.44,
        height: 3.6,
        length: 17,
        calculatedVolume: 161.772,
        classOfFire: "Class A Fire",
        ead: 46,
        safetyFactorPercent: 30,
        requiredMass: 8922.49,
        selectedMass: 9150,
        excessMass: 227.51,
        excessPercent: 2.55,
        approvalResult: "APPROVED",
        generators: [
          {
            code: "10318",
            model: "FP-3000T",
            effectiveMass: 1830,
            quantity: 5,
            totalConcentration: 9150,
          },
        ],
        electronics: [],
      },
    },
    pac: {
      approvedModel: "XOPB2055D",
      heatLoad: 54.9,
      totalCapacity: 54.9,
      quantity: 1,
      approvalStatus: "Disetujui - final",
      priceConfirmed: true,
    },
    items: [
      {
        active: true,
        packageName: "FirePro",
        description: "FirePro package",
        quantity: 1,
        unit: "lot",
        sourcePrice: 100000000,
        discountPercent: 20,
      },
      {
        active: true,
        packageName: "FirePro",
        description: "FirePro materials",
        quantity: 1,
        unit: "lot",
        sourcePrice: 10000000,
      },
      {
        active: true,
        packageName: "FirePro",
        description: "FirePro services",
        quantity: 1,
        unit: "lot",
        sourcePrice: 5000000,
      },
      {
        active: true,
        packageName: "PAC",
        description: "PAC package",
        quantity: 1,
        unit: "lot",
        sourcePrice: 200000000,
      },
    ],
  });
}

test("combined totals reconcile with the reference examples", () => {
  const quotation = sampleQuotation();
  assert.equal(quotation.totals.subtotal, 295000000);
  assert.equal(quotation.totals.tax, 0);
  assert.equal(quotation.totals.grandTotal, 295000000);
  assert.equal(quotation.validation.status, "PERLU REVIEW");
  assert.equal(quotation.validation.errors.length, 0);
});

test("production quotation with confirmed data is ready", () => {
  const quotation = sampleQuotation("PRODUKSI");
  quotation.sourceSnapshotDate = new Date().toISOString().slice(0, 10);
  const recalculated = calculateQuotation(quotation);
  assert.equal(recalculated.validation.status, "SIAP DIBUAT");
});

test("manual Support price stays usable but requires Logistics review", () => {
  const quotation = sampleQuotation("PRODUKSI");
  quotation.sourceSnapshotDate = new Date().toISOString().slice(0, 10);
  quotation.items[0].priceOrigin = "MANUAL_SUPPORT";
  quotation.items[0].verificationStatus = "PERLU_VERIFIKASI_LOGISTIK";
  quotation.items[0].needsReview = true;
  const recalculated = calculateQuotation(quotation);
  assert.equal(recalculated.validation.errors.length, 0);
  assert.equal(recalculated.validation.status, "PERLU REVIEW");
  assert.match(
    recalculated.validation.warnings.join(" "),
    /belum diverifikasi Logistik/i,
  );
});

test("commercial quantity is normalized to a whole number", () => {
  const quotation = sampleQuotation();
  quotation.items[0].quantity = 1.01;
  const recalculated = calculateQuotation(quotation);
  assert.equal(recalculated.items[0].quantity, 1);
  assert.equal(recalculated.items[0].lineTotal, 80000000);
});

test("legacy terms become an editable customer note list", () => {
  const quotation = sampleQuotation();
  assert.ok(Array.isArray(quotation.terms.noteItems));
  assert.equal(quotation.terms.noteItems.length, 5);
  assert.match(quotation.terms.noteItems[0].text, /Franco Jakarta/i);
  assert.match(quotation.terms.noteItems[0].text, /belum termasuk PPN 11%/i);
});

test("legacy quotation remains compatible without RAB groups", () => {
  const quotation = sampleQuotation();
  assert.deepEqual(quotation.rabGroups, []);
  assert.equal(quotation.items[0].rabGroupId, "");
});

test("RAB group titles organize items in customer Word output", async () => {
  const quotation = sampleQuotation();
  quotation.rabGroups = [
    { id: "all-room", section: "equipment", title: "FIRE ALARM SYSTEM (FOR ALL ROOM)" },
    { id: "storage-1", section: "equipment", title: "RUANG STORAGE BINS 1" },
  ];
  quotation.items[0].rabGroupId = "all-room";
  quotation.items[1].rabGroupId = "storage-1";
  const recalculated = calculateQuotation(quotation);
  const docx = await buildDocxBuffer(recalculated, {
    companyName: "PT. MATUR NUWUN NUSANTARA",
    signerName: "Eddy S. Ginting",
    signerTitle: "Direktur",
  });
  const documentXml = strFromU8(unzipSync(docx)["word/document.xml"]);
  assert.match(documentXml, /MAIN &amp; SUPPORT EQUIPMENT/);
  assert.match(documentXml, /FIRE ALARM SYSTEM \(FOR ALL ROOM\)/);
  assert.match(documentXml, /RUANG STORAGE BINS 1/);
  assert.ok(
    documentXml.indexOf("FIRE ALARM SYSTEM (FOR ALL ROOM)") <
      documentXml.indexOf("RUANG STORAGE BINS 1"),
  );
});

test("custom notes and subnotes are the single source for customer exports", async () => {
  const quotation = sampleQuotation();
  quotation.terms.noteItems = [
    { id: "a", level: 0, text: "Ketentuan utama khusus customer." },
    { id: "b", level: 1, text: "Rincian pertama." },
    { id: "c", level: 1, text: "Rincian kedua." },
    { id: "d", level: 0, text: "Catatan terakhir." },
  ];
  const recalculated = calculateQuotation(quotation);
  const docx = await buildDocxBuffer(recalculated, {
    companyName: "PT. MATUR NUWUN NUSANTARA",
    signerName: "Eddy S. Ginting",
    signerTitle: "Direktur",
  });
  const documentXml = strFromU8(unzipSync(docx)["word/document.xml"]);
  assert.match(documentXml, /Ketentuan utama khusus customer/);
  assert.match(documentXml, /2\.1\.|1\.1\./);
  assert.doesNotMatch(documentXml, /Approval engineering FirePro/);
  assert.doesNotMatch(documentXml, /Dasar desain FirePro/);
});

test("document exporters return valid file signatures", async () => {
  const quotation = sampleQuotation();
  const settings = {
    companyName: "PT. MATUR NUWUN NUSANTARA",
    signerName: "Eddy S. Ginting",
    signerTitle: "Direktur",
  };
  const docx = await buildDocxBuffer(quotation, settings);
  const pdf = await buildPdfBuffer(quotation, settings);
  assert.equal(docx.subarray(0, 2).toString(), "PK");
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  assert.ok(docx.length > 5000);
  assert.ok(pdf.length > 5000);
  const documentXml = strFromU8(unzipSync(docx)["word/document.xml"]);
  assert.match(documentXml, /DETAIL PENAWARAN \/ RAB/);
  assert.match(documentXml, /MAIN &amp; SUPPORT EQUIPMENT/);
});

test("SQLite store persists and reopens a quotation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnn-qn-test-"));
  const seedPath = path.join(tempDir, "empty-seed.json");
  fs.writeFileSync(seedPath, "[]");
  try {
    const store = createStore({ dataDir: tempDir, seedPath });
    const quotation = sampleQuotation();
    store.saveQuotation(quotation, "Test");
    const reopened = store.getQuotation(quotation.id);
    assert.equal(reopened.qn, quotation.qn);
    assert.equal(reopened.totals.grandTotal, 295000000);
    assert.equal(store.listQuotations(10).length, 1);
    store.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Buku QN keeps FP, PAC, and ME numbering independent", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnn-qn-book-test-"));
  const seedPath = path.join(tempDir, "empty-seed.json");
  fs.writeFileSync(seedPath, "[]");
  try {
    const store = createStore({ dataDir: tempDir, seedPath });
    const manual = store.createManualQuotationNumber(
      {
        quotationDate: "2026-07-15",
        creatorName: "Support Satu",
        creatorInitials: "PL",
        series: "FP",
        sequenceNumber: 27,
        customerName: "PT CUSTOMER LAMA",
        projectName: "Project Gudang",
        picName: "Ibu Dina",
      },
      "Support Satu",
    );
    assert.equal(manual.quotationNumber, "QN/FP-PL/027");
    assert.equal(manual.projectName, "Project Gudang");
    assert.equal(manual.picName, "Ibu Dina");
    assert.equal(store.nextQn("FirePro"), "QN/FP-YN/028");
    assert.equal(store.nextQn("FirePro", "PL"), "QN/FP-PL/028");
    assert.equal(store.nextQn("PAC"), "QN/PAC-YN/001");
    assert.equal(store.nextQn("FirePro + PAC"), "QN/ME-YN/001");

    const pacQuotation = calculateQuotation({
      ...sampleQuotation(),
      id: "pac-book-test",
      qn: store.nextQn("PAC", "PL"),
      qnCreatorInitials: "PL",
      packageName: "PAC",
      customer: { name: "PT PAC TEST", address: "Jakarta", pic: "Bpk. Ari" },
      project: { name: "Project PAC", location: "Jakarta" },
    });
    store.saveQuotation(pacQuotation, "Support Dua");
    const pacBook = store.listQuotationNumbers({ series: "PAC" });
    assert.equal(pacBook.length, 1);
    assert.equal(pacBook[0].quotationNumber, "QN/PAC-PL/001");
    assert.equal(pacBook[0].creatorName, "Support Dua");
    assert.equal(pacBook[0].customerName, "PT PAC TEST");
    assert.equal(pacBook[0].projectName, "Project PAC");
    assert.equal(pacBook[0].picName, "Bpk. Ari");
    assert.equal(store.nextQn("PAC"), "QN/PAC-YN/002");
    assert.throws(() => store.nextQn("PAC", "P"), /2-5 huruf\/angka/i);
    assert.throws(
      () =>
        store.createManualQuotationNumber({
          quotationDate: "2026-07-16",
          creatorName: "Support Tiga",
          series: "FP",
          sequenceNumber: 27,
          customerName: "PT DUPLIKAT",
        }),
      /sudah tercatat/i,
    );
    assert.throws(
      () => store.deleteManualQuotationNumber(pacBook[0].id),
      /Nomor otomatis tidak dapat dihapus/i,
    );
    const deletedManual = store.deleteManualQuotationNumber(manual.id);
    assert.equal(deletedManual.quotationNumber, "QN/FP-PL/027");
    assert.equal(store.listQuotationNumbers({ series: "FP" }).length, 0);
    assert.throws(
      () => store.deleteManualQuotationNumber(manual.id),
      /tidak ditemukan/i,
    );
    store.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("legacy combined QN is listed in the ME book without renaming it", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnn-qn-legacy-test-"));
  const seedPath = path.join(tempDir, "empty-seed.json");
  fs.writeFileSync(seedPath, "[]");
  try {
    let store = createStore({ dataDir: tempDir, seedPath });
    const legacy = sampleQuotation();
    legacy.id = "legacy-combined";
    legacy.qn = "QN/FP-PAC-YN/014";
    store.saveQuotation(legacy, "Migrasi Test");
    store.close();

    store = createStore({ dataDir: tempDir, seedPath });
    const meBook = store.listQuotationNumbers({ series: "ME" });
    assert.equal(meBook.length, 1);
    assert.equal(meBook[0].quotationNumber, "QN/FP-PAC-YN/014");
    assert.equal(store.nextQn("FirePro + PAC"), "QN/ME-YN/015");
    store.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Buku QN resets numbering by year and manual rows can be corrected", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnn-qn-year-test-"));
  const seedPath = path.join(tempDir, "empty-seed.json");
  fs.writeFileSync(seedPath, "[]");
  try {
    const store = createStore({ dataDir: tempDir, seedPath });
    store.createManualQuotationNumber({
      quotationDate: "2025-12-31",
      creatorName: "Yan",
      creatorInitials: "YN",
      series: "FP",
      sequenceNumber: 198,
      customerName: "Customer 2025",
    });
    const current = store.createManualQuotationNumber({
      quotationDate: "2026-01-02",
      creatorName: "Enda",
      creatorInitials: "EP",
      series: "FP",
      sequenceNumber: 1,
      customerName: "Customer 2026",
    });

    assert.equal(store.nextQn("FirePro", "YN", 2025), "QN/FP-YN/199");
    assert.equal(store.nextQn("FirePro", "YN", 2026), "QN/FP-YN/002");
    assert.deepEqual(store.listQuotationYears(), [2026, 2025]);
    assert.equal(store.listQuotationNumbers({ series: "FP", year: 2025 }).length, 1);
    assert.equal(store.listQuotationNumbers({ series: "FP", year: 2026 }).length, 1);

    const edited = store.updateManualQuotationNumber(current.id, {
      quotationDate: "2026-01-03",
      creatorName: "Vero",
      creatorInitials: "AD",
      series: "FP",
      sequenceNumber: 1,
      customerName: "Customer diperbaiki",
      projectName: "Project diperbaiki",
      picName: "PIC diperbaiki",
    });
    assert.equal(edited.quotationNumber, "QN/FP-AD/001");
    assert.equal(edited.customerName, "Customer diperbaiki");
    assert.equal(edited.projectName, "Project diperbaiki");
    assert.equal(edited.picName, "PIC diperbaiki");

    const seededCodes = store.listQuotationCreators().map((item) => item.creatorInitials);
    assert.deepEqual(new Set(seededCodes), new Set(["YN", "PL", "EP", "AD"]));
    const creator = store.createQuotationCreator({
      creatorName: "Pembuat Baru",
      creatorInitials: "PB",
    });
    assert.equal(creator.creatorInitials, "PB");
    store.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cancelled app number can coexist with the matching physical-book number", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnn-qn-cancelled-duplicate-test-"));
  const seedPath = path.join(tempDir, "empty-seed.json");
  fs.writeFileSync(seedPath, "[]");
  let store;
  try {
    store = createStore({ dataDir: tempDir, seedPath });
    const draft = calculateQuotation({
      ...sampleQuotation(),
      id: "draft-before-book-import",
      qn: "QN/FP-YN/001",
      date: "2026-07-01",
      packageName: "FirePro",
    });
    store.saveQuotation(draft, "Support Test");
    store.deleteDraftQuotation(draft.id, "Support Test");
    const physical = store.createManualQuotationNumber({
      quotationDate: "2026-01-06",
      creatorName: "Yan",
      creatorInitials: "YN",
      series: "FP",
      sequenceNumber: 1,
      customerName: "PT Bima Asri Internitra",
    });
    const rows = store.listQuotationNumbers({ series: "FP", year: 2026 });
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((item) => item.source === "DIBATALKAN").length, 1);
    assert.equal(physical.customerName, "PT Bima Asri Internitra");
    assert.throws(
      () =>
        store.createManualQuotationNumber({
          quotationDate: "2026-02-01",
          creatorName: "Yan",
          creatorInitials: "YN",
          series: "FP",
          sequenceNumber: 1,
          customerName: "Duplikat aktif",
        }),
      /sudah tercatat/i,
    );
    store.close();
    store = null;
  } finally {
    store?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("draft deletion preserves its QN as cancelled and protects ready quotations", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnn-delete-draft-test-"));
  const seedPath = path.join(tempDir, "empty-seed.json");
  fs.writeFileSync(seedPath, "[]");
  try {
    const store = createStore({ dataDir: tempDir, seedPath });
    const draft = calculateQuotation({
      ...sampleQuotation(),
      id: "draft-to-delete",
      qn: "QN/FP-PL/050",
      packageName: "FirePro",
    });
    assert.notEqual(draft.validation.status, "SIAP DIBUAT");
    store.saveQuotation(draft, "Support Draft");
    const deleted = store.deleteDraftQuotation(draft.id, "Support Draft");
    assert.equal(deleted.qn, "QN/FP-PL/050");
    assert.equal(store.getQuotation(draft.id), null);
    assert.equal(store.listQuotations(10).length, 0);
    const fpBook = store.listQuotationNumbers({ series: "FP" });
    assert.equal(fpBook.length, 1);
    assert.equal(fpBook[0].source, "DIBATALKAN");
    assert.equal(fpBook[0].quotationId, null);
    assert.equal(store.nextQn("FirePro", "YN"), "QN/FP-YN/051");

    let ready = sampleQuotation("PRODUKSI");
    ready.sourceSnapshotDate = new Date().toISOString().slice(0, 10);
    ready = calculateQuotation({
      ...ready,
      id: "ready-protected",
      qn: "QN/ME-YN/060",
    });
    assert.equal(ready.validation.status, "SIAP DIBUAT");
    store.saveQuotation(ready, "Support Ready");
    assert.throws(
      () => store.deleteDraftQuotation(ready.id, "Support Ready"),
      /SIAP DIBUAT tidak dapat dihapus/i,
    );
    assert.ok(store.getQuotation(ready.id));
    store.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("manual price master records source evidence and review status", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnn-price-test-"));
  const seedPath = path.join(tempDir, "empty-seed.json");
  fs.writeFileSync(seedPath, "[]");
  try {
    const store = createStore({ dataDir: tempDir, seedPath });
    const item = store.createManualPrice(
      {
        description: "Material baru untuk pengujian",
        packageName: "Material",
        category: "Material Support",
        unit: "bh",
        price: 125000,
        supplier: "PT Supplier Test",
        evidenceRef: "Email quotation 29-07-2026",
        snapshotDate: "2026-07-29",
        notes: "Menunggu kode Logistik",
      },
      "Support Test",
    );
    assert.match(item.code, /^MS-\d{8}-\d{3}$/);
    assert.equal(item.priceOrigin, "MANUAL_SUPPORT");
    assert.equal(item.verificationStatus, "PERLU_VERIFIKASI_LOGISTIK");
    assert.equal(item.needsReview, true);
    assert.equal(item.supplier, "PT Supplier Test");
    assert.equal(store.getDashboard().priceStats.manual, 1);
    store.importPrices(
      [
        {
          code: item.code,
          packageName: "Material",
          category: "Material Support",
          description: "Material baru untuk pengujian",
          unit: "bh",
          price: 120000,
          source: "PRICELIST MATERIAL_SUPPORT.xlsx",
          snapshotDate: "2026-07-30",
          needsReview: false,
        },
      ],
      "Logistik Test",
    );
    const official = store.getPrice(item.code);
    assert.equal(official.priceOrigin, "LOGISTIK_PRICELIST");
    assert.equal(official.verificationStatus, "TERVERIFIKASI_LOGISTIK");
    assert.equal(official.needsReview, false);
    assert.equal(store.getDashboard().priceStats.manual, 0);
    store.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("legacy price database migrates verified Logistics metadata safely", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnn-migrate-test-"));
  const databasePath = path.join(tempDir, "quotation-internal.db");
  const seedPath = path.join(tempDir, "empty-seed.json");
  fs.writeFileSync(seedPath, "[]");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE prices (
      code TEXT PRIMARY KEY,
      package_name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      unit TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      snapshot_date TEXT,
      needs_review INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    INSERT INTO prices VALUES (
      'I-LEGACY', 'Material', 'Material Support', 'Legacy item', 'bh',
      50000, 'uploaded-pricelist.xlsx', '2026-07-06', 0,
      '2026-07-06T00:00:00.000Z'
    );
  `);
  legacy.close();
  try {
    const store = createStore({ dataDir: tempDir, seedPath });
    const item = store.getPrice("I-LEGACY");
    assert.equal(item.priceOrigin, "LOGISTIK_PRICELIST");
    assert.equal(item.verificationStatus, "TERVERIFIKASI_LOGISTIK");
    assert.equal(item.needsReview, false);
    store.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("role accounts create secure sessions and require login again after password change", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnn-auth-test-"));
  const seedPath = path.join(tempDir, "empty-seed.json");
  fs.writeFileSync(seedPath, "[]");
  try {
    const store = createStore({ dataDir: tempDir, seedPath });
    const session = store.loginUser("logistik", "Logistik@MNN2026", {
      ipAddress: "127.0.0.1",
      userAgent: "test",
    });
    assert.equal(session.user.role, "LOGISTICS");
    assert.equal(store.getSessionUser(session.token).displayName, "Tim Logistik");
    assert.ok(new Date(session.expiresAt).getTime() - Date.now() <= 12 * 60 * 60 * 1000);
    const rememberedSession = store.loginUser("logistik", "Logistik@MNN2026", {
      ipAddress: "127.0.0.1",
      userAgent: "test",
      rememberMe: true,
    });
    assert.ok(new Date(rememberedSession.expiresAt).getTime() - Date.now() > 29 * 24 * 60 * 60 * 1000);
    store.changeUserPassword(
      session.user.id,
      "Logistik@MNN2026",
      "Logistik#Baru2026",
    );
    assert.equal(store.getSessionUser(session.token), null);
    assert.equal(store.getSessionUser(rememberedSession.token), null);
    assert.equal(store.loginUser("logistik", "Logistik#Baru2026").user.mustChangePassword, false);
    store.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Logistics can create and replace an official price without Excel", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnn-logistics-price-test-"));
  const seedPath = path.join(tempDir, "empty-seed.json");
  fs.writeFileSync(seedPath, "[]");
  try {
    const store = createStore({ dataDir: tempDir, seedPath });
    const first = store.upsertLogisticsPrice({
      code: "MAT-CABLE-001",
      packageName: "Material",
      category: "Kabel",
      description: "Kabel power 3 x 2,5 mm",
      unit: "m",
      price: 25000,
      supplier: "PT Supplier Test",
      evidenceRef: "PO-001",
      snapshotDate: "2026-08-10",
    }, "Tim Logistik");
    assert.equal(first.priceOrigin, "LOGISTIK_MASTER");
    assert.equal(first.verificationStatus, "TERVERIFIKASI_LOGISTIK");
    assert.equal(first.needsReview, false);
    const updated = store.upsertLogisticsPrice({
      ...first,
      price: 27500,
      evidenceRef: "PO-002",
      snapshotDate: "2026-08-11",
    }, "Tim Logistik");
    assert.equal(updated.price, 27500);
    assert.equal(store.searchPrices({ query: "MAT-CABLE-001" }).length, 1);
    store.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("quotation workflow is tracked independently from technical validation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnn-workflow-test-"));
  const seedPath = path.join(tempDir, "empty-seed.json");
  fs.writeFileSync(seedPath, "[]");
  try {
    const store = createStore({ dataDir: tempDir, seedPath });
    const quotation = calculateQuotation({
      ...sampleQuotation(),
      id: "workflow-test",
      qn: "QN/ME-YN/099",
    });
    store.saveQuotation(quotation, "Tim Support", {
      ownerName: "Tim Support",
      ownerRole: "SUPPORT",
    });
    const tracked = store.updateQuotationWorkflow(
      quotation.id,
      { status: "WAITING_PRICE", note: "Menunggu harga kabel dari Logistik." },
      "Tim Support",
      "SUPPORT",
    );
    assert.equal(tracked.workflowStatus, "WAITING_PRICE");
    assert.equal(tracked.validationStatus, quotation.validation.status);
    assert.equal(store.getQuotationWorkflowEvents(quotation.id).length, 2);
    assert.throws(
      () => store.updateQuotationWorkflow(quotation.id, { status: "LOST", note: "" }),
      /Catatan wajib/i,
    );
    store.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
