import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(testDir, "..", "public", "app.js"), "utf8");
const loginSource = fs.readFileSync(path.join(testDir, "..", "public", "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(testDir, "..", "public", "styles.css"), "utf8");

test("commercial quantity, markup, and VAT spinners advance by whole numbers", () => {
  assert.match(
    appSource,
    /step="1" inputmode="numeric" data-item-index="\$\{index\}" data-item-field="quantity"/,
  );
  assert.match(
    appSource,
    /step="1" inputmode="numeric" data-item-index="\$\{index\}" data-item-field="markupPercent"/,
  );
  assert.match(
    appSource,
    /field\("Tarif PPN \(%\)",[\s\S]*?step: 1,[\s\S]*?column: "col-2"/,
  );
});

test("engineering measurements retain decimal precision", () => {
  assert.match(appSource, /field\("Panjang ACES \(m\)"[\s\S]*?step: 0\.001/);
  assert.match(appSource, /field\("Heat load \(kW\)"[\s\S]*?step: 0\.1/);
});

test("remember login stores only username while the password stays with the secure session", () => {
  assert.match(loginSource, /name="rememberMe" type="checkbox"/);
  assert.match(appSource, /mnn-quotation-remembered-username/);
  assert.doesNotMatch(appSource, /localStorage\.setItem\([^\n]*password/i);
});

test("submit routing cannot be shadowed by a form field named id", () => {
  assert.doesNotMatch(appSource, /form\.id\s*===/);
  assert.match(appSource, /form\.matches\("#user-management-form"\)/);
  assert.match(appSource, /form\.matches\("#customer-management-form"\)/);
  assert.match(appSource, /form\.matches\("#manual-qn-form"\)/);
});

test("password visibility is accessible and never persists the password", () => {
  assert.match(appSource, /function enhancePasswordControls/);
  assert.match(appSource, /enhancePasswordControls\(loginForm\)/);
  assert.match(appSource, /enhancePasswordControls\(appView\)/);
  assert.match(appSource, /dataset\.togglePassword/);
  assert.match(appSource, /aria-pressed/);
  assert.match(appSource, /visibilitychange/);
  assert.doesNotMatch(appSource, /localStorage\.setItem\([^\n]*password/i);
});

test("recent quotation rows reserve enough room for complete action buttons", () => {
  assert.match(stylesSource, /\.quotation-row-actions\s*\{[\s\S]*?min-width:\s*150px/);
  assert.match(stylesSource, /\.quotation-row-actions \.row-arrow\s*\{[\s\S]*?display:\s*none/);
  assert.match(stylesSource, /grid-template-columns:[\s\S]*?minmax\(150px, auto\)/);
});
