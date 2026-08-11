import { strFromU8, unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";

const monthPattern =
  /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/i;
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
  trimValues: false,
});
const array = (value) => {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
};

function decodeXml(value = "") {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function fragmentText(fragment = "", separator = "") {
  return [...String(fragment).matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXml(match[1]))
    .join(separator)
    .replace(/\s+/g, " ")
    .trim();
}

function paragraphTexts(xml) {
  return [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)]
    .map((match) => fragmentText(match[0]))
    .filter(Boolean);
}

function collectWordText(value, output = []) {
  if (value == null) return output;
  if (typeof value === "string" || typeof value === "number") {
    output.push(String(value));
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectWordText(item, output);
    return output;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("@")) continue;
      collectWordText(child, output);
    }
  }
  return output;
}

function cellText(cell) {
  return collectWordText(cell)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function tableRows(table) {
  return array(table?.["w:tr"])
    .map((row) => array(row?.["w:tc"]).map(cellText))
    .filter((row) => row.some(Boolean));
}

function documentTables(xml) {
  const document = xmlParser.parse(xml);
  const body = document?.["w:document"]?.["w:body"];
  return array(body?.["w:tbl"]).map(tableRows);
}

function numberFrom(value, fallback = 0) {
  const match = String(value ?? "")
    .replace(",", ".")
    .match(/-?\d+(?:\.\d+)?/);
  const number = match ? Number(match[0]) : fallback;
  return Number.isFinite(number) ? number : fallback;
}

function valueAfterLabel(lines, label) {
  const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(
    `^(?:[•\\-]\\s*)?(?:\\d+(?:\\.\\d+)*\\.\\s*)?${escaped}\\s*:`,
    "i",
  );
  const line = lines.find((candidate) => expression.test(candidate.trim()));
  if (!line) return "";
  return line.trim().replace(expression, "").trim();
}

function nextValueAfter(lines, pattern) {
  const index = lines.findIndex((line) => pattern.test(line.trim()));
  if (index < 0) return "";
  for (let offset = 1; offset <= 3; offset += 1) {
    const candidate = lines[index + offset];
    if (candidate && /-?\d+(?:[.,]\d+)?\s*g\b/i.test(candidate)) {
      return candidate;
    }
  }
  return "";
}

function parseGeneratorRows(tables) {
  const table = tables.find((rows) => {
    const header = rows[0]?.join(" ").toLowerCase() ?? "";
    return (
      header.includes("model") &&
      header.includes("effective mass") &&
      header.includes("total concentration")
    );
  });
  if (!table) return [];
  return table
    .slice(1)
    .filter((row) => row.length >= 6 && row[0] && row[1])
    .map((row) => ({
      code: row[0].trim(),
      model: row[1].trim(),
      dischargeTemperature: row[2].replace(/\s+/g, " ").trim(),
      effectiveMass: numberFrom(row[3]),
      quantity: Math.max(0, Math.round(numberFrom(row[4]))),
      totalConcentration: numberFrom(row[5]),
    }));
}

function parseElectronicRows(tables) {
  const table = tables.find((rows) => {
    const header = rows[0]?.join(" ").toLowerCase() ?? "";
    return (
      header.includes("electronic") &&
      header.includes("category") &&
      header.includes("quantity")
    );
  });
  if (!table) return [];
  return table
    .slice(1)
    .filter((row) => row.length >= 4 && row[0] && row[1])
    .map((row) => ({
      code: row[0].trim(),
      description: row[1].replace(/\n+/g, " / ").trim(),
      category: row[2].replace(/\n+/g, " / ").trim(),
      quantity: Math.max(0, Math.round(numberFrom(row[3]))),
    }));
}

export function parseAcesDocx(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    throw new Error("File ACES DOCX kosong atau tidak valid.");
  }
  if (buffer.subarray(0, 2).toString() !== "PK") {
    throw new Error("File ACES bukan dokumen DOCX yang valid.");
  }

  const archive = unzipSync(new Uint8Array(buffer));
  const documentXml = archive["word/document.xml"];
  if (!documentXml) {
    throw new Error("Struktur word/document.xml tidak ditemukan.");
  }

  const xml = strFromU8(documentXml);
  const lines = paragraphTexts(xml);
  const tables = documentTables(xml);
  const roomLines = lines.filter((line) => /\bRoom:\s*/i.test(line));
  const roomName = (roomLines.at(-1) ?? "")
    .replace(/^.*?\bRoom:\s*/i, "")
    .replace(/\s+\d+$/, "")
    .trim();
  const classLine =
    lines.find((line) => line.toLowerCase().includes("class of fire:")) ?? "";
  const excessLine =
    lines.find((line) => /\bexcess\b/i.test(line) && /%/.test(line)) ?? "";
  const approvalResult =
    lines.find((line) => /^(APPROVED|NOT APPROVED|REVIEW)$/i.test(line.trim())) ??
    "";

  const requiredMassText = nextValueAfter(
    lines,
    /^effective mass.*required:\s*$/i,
  );
  const selectedMassText = nextValueAfter(
    lines,
    /^effective mass.*selected:\s*$/i,
  );

  return {
    projectName: valueAfterLabel(lines, "Project"),
    reportDate: lines.find((line) => monthPattern.test(line.trim())) ?? "",
    referenceNumber: valueAfterLabel(lines, "Reference number"),
    roomName,
    spaceType: valueAfterLabel(lines, "Space type"),
    numberOfDoors: Math.max(
      0,
      Math.round(numberFrom(valueAfterLabel(lines, "Number of doors"))),
    ),
    shape: valueAfterLabel(lines, "Shape"),
    width: numberFrom(valueAfterLabel(lines, "Width")),
    height: numberFrom(valueAfterLabel(lines, "Height")),
    length: numberFrom(valueAfterLabel(lines, "Length")),
    calculatedVolume: numberFrom(valueAfterLabel(lines, "Calculated volume")),
    classOfFire: classLine
      .replace(/^.*?Class of fire:\s*/i, "")
      .replace(/\s*-\s*EAD:.*$/i, "")
      .trim(),
    ead: numberFrom(classLine.match(/EAD:\s*([\d.,]+)/i)?.[1]),
    streamRequired: valueAfterLabel(lines, "Stream required"),
    safetyFactorPercent: numberFrom(valueAfterLabel(lines, "Safety factor"), 30),
    requiredMass: numberFrom(requiredMassText),
    selectedMass: numberFrom(selectedMassText),
    excessMass: numberFrom(excessLine),
    excessPercent: numberFrom(excessLine.match(/\(([+-]?[\d.,]+)%\)/)?.[1]),
    approvalResult: approvalResult.toUpperCase(),
    approvalNote:
      lines.find((line) => /sufficient concentration/i.test(line)) ?? "",
    generators: parseGeneratorRows(tables),
    electronics: parseElectronicRows(tables),
  };
}
