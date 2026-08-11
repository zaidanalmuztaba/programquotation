import { XMLParser } from "fast-xml-parser";
import { unzipSync } from "fflate";

const decoder = new TextDecoder("utf-8");
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
});

const array = (value) => {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
};

function xmlText(entries, name, required = true) {
  const entry = entries[name];
  if (!entry) {
    if (required) throw new Error(`Bagian XLSX tidak ditemukan: ${name}`);
    return null;
  }
  return decoder.decode(entry);
}

function richText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value.t != null) return richText(value.t);
  if (value.r != null) {
    return array(value.r)
      .map((run) => richText(run.t))
      .join("");
  }
  return "";
}

function cellColumn(reference) {
  return String(reference || "")
    .replace(/[0-9]/g, "")
    .toUpperCase();
}

function cellValue(cell, sharedStrings) {
  const type = cell?.["@t"];
  if (type === "inlineStr") return richText(cell.is);
  const value = cell?.v ?? "";
  if (type === "s") {
    return sharedStrings[Number(value)] ?? "";
  }
  if (type === "b") return value === "1";
  return value;
}

export function parseSupportPricelist(
  buffer,
  {
    sourceName = "PRICELIST MATERIAL_SUPPORT.xlsx",
    snapshotDate = new Date().toISOString().slice(0, 10),
  } = {},
) {
  const entries = unzipSync(new Uint8Array(buffer));
  const workbook = parser.parse(xmlText(entries, "xl/workbook.xml"));
  const relationships = parser.parse(
    xmlText(entries, "xl/_rels/workbook.xml.rels"),
  );
  const sheets = array(workbook.workbook?.sheets?.sheet);
  const targetSheet = sheets.find((sheet) => sheet["@name"] === "2026") ?? sheets[0];
  if (!targetSheet) throw new Error("Workbook tidak memiliki sheet.");

  const relationId = targetSheet["@r:id"];
  const relationship = array(
    relationships.Relationships?.Relationship,
  ).find((item) => item["@Id"] === relationId);
  if (!relationship) {
    throw new Error("Relasi sheet pada workbook tidak ditemukan.");
  }
  const rawTarget = String(relationship["@Target"] || "").replace(/^\/+/, "");
  const worksheetPath = rawTarget.startsWith("xl/")
    ? rawTarget
    : `xl/${rawTarget.replace(/^\.\//, "")}`;
  const worksheet = parser.parse(xmlText(entries, worksheetPath));

  const sharedStringsXml = xmlText(
    entries,
    "xl/sharedStrings.xml",
    false,
  );
  const sharedStrings = sharedStringsXml
    ? array(parser.parse(sharedStringsXml).sst?.si).map(richText)
    : [];

  const rows = [];
  for (const row of array(worksheet.worksheet?.sheetData?.row)) {
    const rowNumber = Number(row["@r"] || 0);
    if (rowNumber < 6) continue;
    const values = Object.fromEntries(
      array(row.c).map((cell) => [
        cellColumn(cell["@r"]),
        cellValue(cell, sharedStrings),
      ]),
    );
    const code = String(values.B ?? "").trim();
    if (!code) continue;
    const price = Number(values.E);
    rows.push({
      code,
      packageName: "Material",
      category: "Material Support",
      description: String(values.C ?? code).trim() || code,
      unit: String(values.D ?? "unit").trim() || "unit",
      price: Number.isFinite(price) ? price : 0,
      source: sourceName,
      snapshotDate,
      needsReview: !(Number.isFinite(price) && price > 0),
    });
  }
  return rows;
}
