import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { calculateQuotation, createEmptyQuotation } from "../lib/calculation.js";
import { createStore } from "../lib/database.js";

function withStore(prefix, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const seedPath = path.join(tempDir, "empty-seed.json");
  fs.writeFileSync(seedPath, "[]");
  const store = createStore({ dataDir: tempDir, seedPath });
  try {
    return callback(store, tempDir);
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function draftQuotation(id = "roadmap-qn", qn = "QN/FP-YN/901") {
  const quotation = createEmptyQuotation();
  quotation.id = id;
  quotation.qn = qn;
  quotation.date = "2026-08-10";
  quotation.mode = "DEMO";
  quotation.packageName = "FirePro";
  quotation.customer = { name: "PT ROADMAP TEST", address: "Jakarta", pic: "Ibu Test" };
  quotation.project = { name: "Project Otomasi", location: "Jakarta" };
  quotation.items = [
    {
      packageName: "FirePro",
      code: "MANUAL-001",
      description: "Material uji",
      quantity: 1,
      unit: "unit",
      sourcePrice: 100000,
      markupPercent: 0,
      overridePrice: "",
      discountPercent: 0,
      priceOrigin: "MANUAL_SUPPORT",
      needsReview: true,
      source: "Penawaran supplier",
      active: true,
    },
  ];
  return calculateQuotation(quotation);
}

test("administrator user management creates, edits, resets, and invalidates sessions", () => {
  withStore("mnn-roadmap-users-", (store) => {
    assert.throws(
      () => store.createUser({ username: "baru", displayName: "Akun Baru", role: "SUPPORT", password: "lemah" }),
      /10 karakter/i,
    );
    const user = store.createUser({
      username: "support.baru",
      displayName: "Support Baru",
      role: "SUPPORT",
      password: "Support#Baru2026",
    }, "Administrator");
    assert.equal(user.role, "SUPPORT");
    const sessionBeforeRename = store.loginUser("support.baru", "Support#Baru2026");
    const updated = store.updateUser(user.id, {
      username: "presales.baru",
      displayName: "Support Baru 2",
      role: "PRESALES",
      active: true,
    }, "Administrator");
    assert.equal(updated.role, "PRESALES");
    assert.equal(updated.username, "presales.baru");
    assert.equal(store.getSessionUser(sessionBeforeRename.token), null);
    assert.throws(() => store.loginUser("support.baru", "Support#Baru2026"), /tidak sesuai/i);
    const session = store.loginUser("presales.baru", "Support#Baru2026");
    store.resetUserPassword(user.id, "Reset#Aman2026", "Manager Operational");
    assert.equal(store.getSessionUser(session.token), null);
    assert.equal(store.loginUser("presales.baru", "Reset#Aman2026").user.mustChangePassword, true);
  });
});

test("soft-deleted draft enters Recycle Bin and can be restored", () => {
  withStore("mnn-roadmap-trash-", (store) => {
    const quotation = draftQuotation();
    store.saveQuotation(quotation, "Support Test");
    store.deleteDraftQuotation(quotation.id, "Support Test");
    assert.equal(store.getQuotation(quotation.id), null);
    assert.equal(store.listDeletedQuotations().length, 1);
    const restored = store.restoreDraftQuotation(quotation.id, "Support Test");
    assert.equal(restored.qn, quotation.qn);
    assert.equal(store.listDeletedQuotations().length, 0);
  });
});

test("customer master and reusable quotation template preserve operational data", () => {
  withStore("mnn-roadmap-template-", (store) => {
    const quotation = draftQuotation("template-source", "QN/FP-YN/902");
    store.saveQuotation(quotation, "Support Test");
    const customers = store.listCustomers();
    assert.equal(customers[0].name, "PT ROADMAP TEST");
    const template = store.createQuotationTemplate({
      name: "FirePro Standard Test",
      description: "Paket berulang",
      quotation,
    }, "Support Test");
    assert.equal(template.payload.customer.name, "");
    assert.equal(template.payload.items[0].description, "Material uji");
    assert.equal(store.setQuotationTemplateActive(template.id, false, "Support Test").active, false);
  });
});

test("revision snapshots, formal approvals, and workflow lock form one audit chain", () => {
  withStore("mnn-roadmap-approval-", (store) => {
    const quotation = draftQuotation("approval-source", "QN/FP-YN/903");
    store.saveQuotation(quotation, "Support Test", { ownerName: "Support Test", ownerRole: "SUPPORT" });
    const requested = store.requestQuotationApprovals(quotation.id, "Support Test", "SUPPORT");
    assert.deepEqual(requested.map((item) => item.approvalType), ["TECHNICAL", "PRICE", "MANAGER"]);
    store.decideQuotationApproval(quotation.id, "TECHNICAL", { status: "APPROVED", note: "Teknis sesuai" }, "Presales Test", "PRESALES");
    store.decideQuotationApproval(quotation.id, "PRICE", { status: "APPROVED", note: "Harga sesuai" }, "Logistik Test", "LOGISTICS");
    store.decideQuotationApproval(quotation.id, "MANAGER", { status: "APPROVED", note: "Disetujui" }, "Manager Test", "OPERATIONS_MANAGER");
    store.updateQuotationWorkflow(quotation.id, { status: "SENT", note: "Dikirim ke customer" }, "Support Test", "SUPPORT");
    assert.equal(store.isQuotationLocked(quotation.id), true);
    assert.throws(() => store.saveQuotation(quotation, "Support Test"), /terkunci/i);
    const revision = store.createQuotationRevision(quotation.id, "Customer meminta perubahan", "Support Test", "SUPPORT");
    assert.equal(revision.revision, 1);
    assert.equal(store.isQuotationLocked(quotation.id), false);
    assert.equal(store.listQuotationVersions(quotation.id).length, 1);
    assert.equal(store.listQuotationApprovals(quotation.id).length, 0);
  });
});

test("price history, stale price signal, management report, and verified backup are available", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnn-roadmap-report-"));
  const seedPath = path.join(tempDir, "empty-seed.json");
  fs.writeFileSync(seedPath, "[]");
  const store = createStore({ dataDir: tempDir, seedPath });
  try {
    store.upsertLogisticsPrice({ code: "MAT-HISTORY-1", packageName: "Material", category: "Support", description: "Material histori", unit: "unit", price: 10000, supplier: "Supplier A", evidenceRef: "PO-1", snapshotDate: "2025-01-01" }, "Logistik Test");
    store.upsertLogisticsPrice({ code: "MAT-HISTORY-1", packageName: "Material", category: "Support", description: "Material histori", unit: "unit", price: 12000, supplier: "Supplier B", evidenceRef: "PO-2", snapshotDate: "2026-08-10" }, "Logistik Test");
    assert.equal(store.listPriceHistory("MAT-HISTORY-1").length, 2);
    assert.equal(store.searchPrices({ query: "MAT-HISTORY-1" })[0].isStale, false);
    const quotation = draftQuotation("report-source", "QN/FP-YN/904");
    store.saveQuotation(quotation, "Support Test");
    store.updateQuotationWorkflow(quotation.id, { status: "FOLLOW_UP", note: "Hubungi customer", followUpAt: "2026-08-15" }, "Support Test", "SUPPORT");
    const report = store.getManagementReport(2026);
    assert.equal(report.totals.quotationCount, 1);
    assert.equal(report.followUps.length, 1);
    const destination = path.join(tempDir, "backup", "quotation.sqlite");
    await store.backupDatabase(destination);
    assert.equal(fs.existsSync(destination), true);
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
