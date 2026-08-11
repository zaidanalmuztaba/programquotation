import fs from "node:fs";
import path from "node:path";
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeightRule,
  Packer,
  PageBreak,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import PDFDocument from "pdfkit";

const TWIPS_PER_CM = 567;
const PT_PER_CM = 28.3464567;
const PAGE_USABLE_DXA = 9412;
const money = new Intl.NumberFormat("id-ID", {
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});
const dateFormatter = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const borderNone = {
  style: BorderStyle.NONE,
  size: 0,
  color: "FFFFFF",
};
const bordersNone = {
  top: borderNone,
  bottom: borderNone,
  left: borderNone,
  right: borderNone,
  insideHorizontal: borderNone,
  insideVertical: borderNone,
};
const bordersThin = {
  top: { style: BorderStyle.SINGLE, size: 4, color: "222222" },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: "222222" },
  left: { style: BorderStyle.SINGLE, size: 4, color: "222222" },
  right: { style: BorderStyle.SINGLE, size: 4, color: "222222" },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "222222" },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "222222" },
};

const safeText = (value) => String(value ?? "").trim();
const rupiah = (value) => `Rp. ${money.format(Math.round(Number(value) || 0))},-`;
const quotationDate = (value) => {
  const date = value ? new Date(value) : new Date();
  return dateFormatter.format(Number.isNaN(date.getTime()) ? new Date() : date);
};

function textRun(text, options = {}) {
  return new TextRun({
    text: safeText(text),
    font: "Calibri",
    size: options.size ?? 22,
    bold: options.bold ?? false,
    italics: options.italics ?? false,
    underline: options.underline ? {} : undefined,
    color: options.color,
  });
}

function paragraph(text, options = {}) {
  return new Paragraph({
    children: [textRun(text, options)],
    alignment: options.alignment ?? AlignmentType.LEFT,
    spacing: {
      before: options.before ?? 0,
      after: options.after ?? 0,
      line: options.line ?? 240,
      lineRule: "auto",
    },
    indent: options.indent,
    keepNext: options.keepNext ?? false,
  });
}

function paragraphRuns(runs, options = {}) {
  return new Paragraph({
    children: runs.map((run) => textRun(run.text, { ...options, ...run })),
    alignment: options.alignment ?? AlignmentType.LEFT,
    spacing: {
      before: options.before ?? 0,
      after: options.after ?? 0,
      line: options.line ?? 240,
      lineRule: "auto",
    },
    indent: options.indent,
    keepNext: options.keepNext ?? false,
  });
}

function tableCell(text, options = {}) {
  return new TableCell({
    children: [
      paragraph(text, {
        size: options.size ?? 20,
        bold: options.bold,
        alignment: options.alignment,
        color: options.color,
        after: 0,
        line: 220,
      }),
    ],
    columnSpan: options.columnSpan,
    width: options.width
      ? { size: options.width, type: WidthType.DXA }
      : undefined,
    verticalAlign: options.verticalAlign ?? VerticalAlign.CENTER,
    shading: options.fill
      ? { type: ShadingType.CLEAR, color: "auto", fill: options.fill }
      : undefined,
    borders: options.borders ?? bordersThin,
    margins: options.margins ?? { top: 70, bottom: 70, left: 90, right: 90 },
  });
}

function activePackageItems(quotation) {
  const grouped = new Map();
  for (const item of quotation.items.filter((candidate) => candidate.active !== false)) {
    const packageName = item.packageName || quotation.packageName;
    grouped.set(packageName, (grouped.get(packageName) ?? 0) + item.lineTotal);
  }
  const items = [];
  if (quotation.packageName === "FirePro" || quotation.packageName === "FirePro + PAC") {
    const amount =
      grouped.get("FirePro") ??
      quotation.items
        .filter((item) => item.packageName === "FirePro")
        .reduce((sum, item) => sum + item.lineTotal, 0);
    items.push({
      description: "Pengadaan dan pemasangan Sistem Pemadam Kebakaran FirePro",
      amount,
    });
  }
  if (quotation.packageName === "PAC" || quotation.packageName === "FirePro + PAC") {
    const amount =
      grouped.get("PAC") ??
      quotation.items
        .filter((item) => item.packageName === "PAC")
        .reduce((sum, item) => sum + item.lineTotal, 0);
    items.push({
      description: "Pengadaan dan pemasangan Precision Air Conditioning Montair",
      amount,
    });
  }
  return items;
}

function commercialNotes(quotation) {
  const items = Array.isArray(quotation.terms?.noteItems)
    ? quotation.terms.noteItems.filter((item) => safeText(item?.text))
    : [];
  let mainNumber = 0;
  let subNumber = 0;
  return items.map((item) => {
    let level = Number(item.level) === 1 && mainNumber > 0 ? 1 : 0;
    if (level === 0) {
      mainNumber += 1;
      subNumber = 0;
    } else {
      subNumber += 1;
    }
    return {
      id: safeText(item.id),
      text: safeText(item.text),
      level,
      label: level === 1 ? `${mainNumber}.${subNumber}.` : `${mainNumber}.`,
    };
  });
}

function splitCommercialNoteColumns(notes) {
  if (notes.length < 7) return [notes, []];
  const groups = [];
  for (const note of notes) {
    if (note.level === 0 || !groups.length) groups.push([note]);
    else groups.at(-1).push(note);
  }
  const weights = groups.map((group) =>
    group.reduce((sum, note) => sum + 1 + Math.ceil(note.text.length / 85), 0),
  );
  const target = weights.reduce((sum, weight) => sum + weight, 0) / 2;
  let leftWeight = 0;
  let splitIndex = 0;
  while (splitIndex < groups.length - 1 && leftWeight + weights[splitIndex] <= target) {
    leftWeight += weights[splitIndex];
    splitIndex += 1;
  }
  return [groups.slice(0, splitIndex).flat(), groups.slice(splitIndex).flat()];
}

function buildDocxCommercialNotes(quotation) {
  const notes = commercialNotes(quotation);
  const [leftNotes, rightNotes] = splitCommercialNoteColumns(notes);
  const twoColumns = rightNotes.length > 0;
  const rows = Array.from({ length: Math.max(leftNotes.length, rightNotes.length, 1) }, (_, index) => {
    const leftNote = leftNotes[index];
    const rightNote = rightNotes[index];
    const noteCell = (note, width) =>
      tableCell(note?.text || "", {
        width,
        size: 18,
        borders: bordersNone,
        verticalAlign: VerticalAlign.TOP,
        margins: { top: 0, bottom: 30, left: 20, right: 90 },
      });
    const labelCell = (note, width) =>
      tableCell(note?.label || "", {
        width,
        size: 18,
        alignment: AlignmentType.RIGHT,
        borders: bordersNone,
        verticalAlign: VerticalAlign.TOP,
        margins: { top: 0, bottom: 30, left: 0, right: 35 },
      });
    return new TableRow({
      children: twoColumns
        ? [labelCell(leftNote, 430), noteCell(leftNote, 4130), labelCell(rightNote, 430), noteCell(rightNote, 4422)]
        : [labelCell(leftNote, 430), noteCell(leftNote, 8982)],
    });
  });
  return new Table({
    width: { size: PAGE_USABLE_DXA, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: twoColumns ? [430, 4130, 430, 4422] : [430, 8982],
    borders: bordersNone,
    rows,
  });
}

const RAB_SECTIONS = [
  { key: "equipment", number: "I", label: "MAIN & SUPPORT EQUIPMENT" },
  { key: "material", number: "II", label: "MATERIAL INSTALASI" },
  { key: "service", number: "III", label: "JASA" },
];

function rabSectionKey(item) {
  const category = safeText(item.category).toLowerCase();
  const description = safeText(item.description).toLowerCase();
  const combined = `${category} ${description}`;
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

function customerRabSections(quotation) {
  const activeItems = quotation.items.filter(
    (item) => item.active !== false && Number(item.quantity) > 0,
  );
  const groupDefinitions = Array.isArray(quotation.rabGroups)
    ? quotation.rabGroups
    : [];
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
      description: safeText(item.description || item.code),
      unit: safeText(item.unit || "unit"),
      quantity,
      unitPrice,
      grossTotal,
      netTotal,
      discount: Math.max(0, grossTotal - netTotal),
      groupId: group?.id || "",
      sectionKey: group?.section || rabSectionKey(item),
    };
  });
  return RAB_SECTIONS.map((section) => {
    const sectionItems = normalizedItems.filter(
      (item) => item.sectionKey === section.key,
    );
    const groups = groupDefinitions
      .filter((group) => group.section === section.key)
      .map((group) => ({
        id: group.id,
        title: safeText(group.title),
        items: sectionItems.filter((item) => item.groupId === group.id),
      }))
      .filter((group) => group.items.length > 0);
    const ungroupedItems = sectionItems.filter((item) => !item.groupId);
    if (ungroupedItems.length) {
      groups.push({ id: "", title: "", items: ungroupedItems });
    }
    return {
      ...section,
      groups,
      items: sectionItems,
      grossTotal: sectionItems.reduce((total, item) => total + item.grossTotal, 0),
      discount: sectionItems.reduce((total, item) => total + item.discount, 0),
      subtotal: sectionItems.reduce((total, item) => total + item.netTotal, 0),
    };
  }).filter((section) => section.items.length > 0);
}

function rabTechnicalSummary(quotation) {
  const details = [];
  if (
    quotation.packageName === "FirePro" ||
    quotation.packageName === "FirePro + PAC"
  ) {
    const aces = quotation.firepro?.aces ?? {};
    const generators = (aces.generators ?? [])
      .filter((item) => Number(item.quantity) > 0)
      .map(
        (item) =>
          `${safeText(item.model || item.code)} (${Number(item.quantity)} unit)`,
      )
      .join(", ");
    if (safeText(aces.referenceNumber) || Number(aces.selectedMass) > 0) {
      details.push(
        `FirePro - ACES ${safeText(aces.referenceNumber || "-")}; volume ${Number(aces.calculatedVolume || 0).toLocaleString("id-ID", { maximumFractionDigits: 2 })} m3; selected mass ${Number(aces.selectedMass || 0).toLocaleString("id-ID")} gram${generators ? `; generator ${generators}` : ""}.`,
      );
    }
  }
  if (
    quotation.packageName === "PAC" ||
    quotation.packageName === "FirePro + PAC"
  ) {
    details.push(
      `PAC - model ${safeText(quotation.pac?.approvedModel || "-")}; kapasitas ${Number(quotation.pac?.totalCapacity || 0).toLocaleString("id-ID", { maximumFractionDigits: 2 })} kW; heat load ${Number(quotation.pac?.heatLoad || 0).toLocaleString("id-ID", { maximumFractionDigits: 2 })} kW.`,
    );
  }
  return details;
}

function buildDocxRabChildren(quotation) {
  const columns = [520, 4070, 820, 720, 1500, 1782];
  const sectionRows = [];
  const sections = customerRabSections(quotation);
  for (const section of sections) {
    sectionRows.push(
      new TableRow({
        children: [
          tableCell(`${section.number}.`, {
            width: columns[0],
            bold: true,
            alignment: AlignmentType.CENTER,
            fill: "DCE5E8",
          }),
          tableCell(section.label, {
            columnSpan: 5,
            bold: true,
            fill: "DCE5E8",
          }),
        ],
      }),
    );
    section.groups.forEach((group, groupIndex) => {
      if (group.title) {
        sectionRows.push(
          new TableRow({
            children: [
              tableCell(`${groupIndex + 1}.`, {
                width: columns[0],
                bold: true,
                alignment: AlignmentType.CENTER,
                fill: "EEF1F2",
              }),
              tableCell(group.title.toUpperCase(), {
                columnSpan: 5,
                bold: true,
                fill: "EEF1F2",
              }),
            ],
          }),
        );
      }
      group.items.forEach((item, index) => {
        sectionRows.push(
          new TableRow({
            children: [
              tableCell(`${index + 1}`, {
                width: columns[0],
                alignment: AlignmentType.CENTER,
              }),
              tableCell(item.description, { width: columns[1] }),
              tableCell(item.unit, {
                width: columns[2],
                alignment: AlignmentType.CENTER,
              }),
              tableCell(money.format(item.quantity), {
                width: columns[3],
                alignment: AlignmentType.CENTER,
              }),
              tableCell(money.format(item.unitPrice), {
                width: columns[4],
                alignment: AlignmentType.RIGHT,
              }),
              tableCell(money.format(item.grossTotal), {
                width: columns[5],
                alignment: AlignmentType.RIGHT,
              }),
            ],
          }),
        );
      });
    });
    if (section.discount > 0) {
      sectionRows.push(
        new TableRow({
          children: [
            tableCell("Diskon", {
              columnSpan: 5,
              bold: true,
              alignment: AlignmentType.RIGHT,
            }),
            tableCell(`(${money.format(section.discount)})`, {
              bold: true,
              alignment: AlignmentType.RIGHT,
            }),
          ],
        }),
      );
    }
    sectionRows.push(
      new TableRow({
        children: [
          tableCell(`Sub Total ${section.number}`, {
            columnSpan: 5,
            bold: true,
            alignment: AlignmentType.RIGHT,
            fill: "F2F5F6",
          }),
          tableCell(money.format(section.subtotal), {
            bold: true,
            alignment: AlignmentType.RIGHT,
            fill: "F2F5F6",
          }),
        ],
      }),
    );
  }

  if (!sectionRows.length) {
    sectionRows.push(
      new TableRow({
        children: [
          tableCell("Belum ada item detail pada quotation.", {
            columnSpan: 6,
            alignment: AlignmentType.CENTER,
          }),
        ],
      }),
    );
  }

  const summaryRows = [
    ["Subtotal RAB", quotation.totals.subtotal],
    [`PPN ${quotation.totals.ppnRate}%`, quotation.totals.tax],
    ["TOTAL PENAWARAN", quotation.totals.grandTotal],
  ].map(
    ([label, value], index) =>
      new TableRow({
        children: [
          tableCell(label, {
            columnSpan: 5,
            bold: true,
            alignment: AlignmentType.RIGHT,
            fill: index === 2 ? "DCE5E8" : undefined,
          }),
          tableCell(money.format(value), {
            bold: true,
            alignment: AlignmentType.RIGHT,
            fill: index === 2 ? "DCE5E8" : undefined,
          }),
        ],
      }),
  );

  return [
    new Paragraph({ children: [new PageBreak()] }),
    paragraph("LAMPIRAN 1", {
      size: 20,
      bold: true,
      alignment: AlignmentType.CENTER,
      after: 20,
    }),
    paragraph("DETAIL PENAWARAN / RAB", {
      size: 26,
      bold: true,
      alignment: AlignmentType.CENTER,
      after: 120,
    }),
    paragraph(`No. Quotation : ${safeText(quotation.qn)}`, {
      size: 20,
      after: 15,
    }),
    paragraph(`Customer : ${safeText(quotation.customer.name)}`, {
      size: 20,
      after: 15,
    }),
    paragraph(`Project : ${safeText(quotation.project.name)}`, {
      size: 20,
      after: 80,
    }),
    ...rabTechnicalSummary(quotation).map((detail) =>
      paragraph(detail, { size: 18, after: 25 }),
    ),
    new Table({
      width: { size: PAGE_USABLE_DXA, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      columnWidths: columns,
      rows: [
        new TableRow({
          tableHeader: true,
          children: [
            tableCell("No.", {
              width: columns[0],
              bold: true,
              alignment: AlignmentType.CENTER,
              fill: "16364A",
              color: "FFFFFF",
            }),
            tableCell("Description", {
              width: columns[1],
              bold: true,
              alignment: AlignmentType.CENTER,
              fill: "16364A",
              color: "FFFFFF",
            }),
            tableCell("Unit", {
              width: columns[2],
              bold: true,
              alignment: AlignmentType.CENTER,
              fill: "16364A",
              color: "FFFFFF",
            }),
            tableCell("Qty", {
              width: columns[3],
              bold: true,
              alignment: AlignmentType.CENTER,
              fill: "16364A",
              color: "FFFFFF",
            }),
            tableCell("Unit Price (Rp.)", {
              width: columns[4],
              bold: true,
              alignment: AlignmentType.CENTER,
              fill: "16364A",
              color: "FFFFFF",
            }),
            tableCell("Total (Rp.)", {
              width: columns[5],
              bold: true,
              alignment: AlignmentType.CENTER,
              fill: "16364A",
              color: "FFFFFF",
            }),
          ],
        }),
        ...sectionRows,
        ...summaryRows,
      ],
    }),
    paragraph(
      "Catatan: harga pada lampiran ini merupakan harga jual customer. Harga sumber dan perhitungan internal tidak ditampilkan.",
      { size: 17, italics: true, before: 70, after: 0 },
    ),
  ];
}

export async function buildDocxBuffer(quotation, settings) {
  const packageItems = activePackageItems(quotation);
  const priceRows = packageItems.map(
    (item, index) =>
      new TableRow({
        children: [
          tableCell(`${index + 1}.`, {
            width: 563,
            alignment: AlignmentType.CENTER,
          }),
          tableCell(item.description, { width: 3547 }),
          tableCell("1 lot", {
            width: 1134,
            alignment: AlignmentType.CENTER,
          }),
          tableCell(rupiah(item.amount), {
            width: 2127,
            alignment: AlignmentType.RIGHT,
          }),
        ],
      }),
  );
  const summaryRows = [["Total Penawaran", quotation.totals.grandTotal]].map(
    ([label, value]) =>
      new TableRow({
        children: [
          tableCell(label, {
            columnSpan: 3,
            bold: true,
            alignment: AlignmentType.RIGHT,
          }),
          tableCell(rupiah(value), {
            bold: true,
            alignment: AlignmentType.RIGHT,
          }),
        ],
      }),
  );

  const children = [
    new Table({
      width: { size: PAGE_USABLE_DXA, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      columnWidths: [4706, 4706],
      borders: bordersNone,
      rows: [
        new TableRow({
          children: [
            tableCell(`Jakarta, ${quotationDate(quotation.date)}`, {
              width: 4706,
              size: 22,
              borders: bordersNone,
            }),
            tableCell(`No. ${quotation.qn}`, {
              width: 4706,
              size: 22,
              alignment: AlignmentType.RIGHT,
              borders: bordersNone,
            }),
          ],
        }),
      ],
    }),
  ];

  if (quotation.mode === "DEMO") {
    children.push(
      paragraph("DRAFT - DATA CONTOH. JANGAN DIKIRIM KE CUSTOMER.", {
        size: 22,
        bold: true,
        color: "D40000",
        alignment: AlignmentType.CENTER,
        before: 160,
        after: 160,
      }),
    );
  }

  children.push(
    paragraph(safeText(quotation.customer.name).toUpperCase(), {
      size: 24,
      bold: true,
      before: quotation.mode === "DEMO" ? 0 : 330,
      after: 40,
    }),
  );
  for (const [index, line] of safeText(quotation.customer.address)
    .split(/\r?\n/)
    .filter(Boolean)
    .entries()) {
    children.push(
      paragraph(line, {
        size: 22,
        after:
          index ===
          safeText(quotation.customer.address).split(/\r?\n/).filter(Boolean)
            .length -
            1
            ? 330
            : 0,
      }),
    );
  }
  if (!safeText(quotation.customer.address)) {
    children.push(paragraph("", { size: 22, after: 330 }));
  }

  children.push(
    paragraphRuns(
      [
        { text: "Up. Yth. : " },
        { text: safeText(quotation.customer.pic), bold: true },
      ],
      { size: 22, after: 330 },
    ),
    paragraphRuns(
      [
        { text: "Perihal : " },
        { text: `Penawaran Harga ${quotation.packageName}`, bold: true },
      ],
      { size: 22, after: 0, keepNext: true },
    ),
    paragraph(safeText(quotation.project.name), {
      size: 22,
      bold: true,
      indent: { left: 1040 },
      after: 440,
    }),
    paragraph("Dengan hormat,", { size: 22, after: 120 }),
    paragraph(
      "Sesuai dengan perihal di atas, maka bersama ini kami sampaikan sebagai berikut :",
      { size: 22, after: 160 },
    ),
    new Table({
      width: { size: 7371, type: WidthType.DXA },
      alignment: AlignmentType.CENTER,
      layout: TableLayoutType.FIXED,
      columnWidths: [563, 3547, 1134, 2127],
      rows: [
        new TableRow({
          tableHeader: true,
          height: { value: 360, rule: HeightRule.ATLEAST },
          children: [
            tableCell("No.", {
              width: 563,
              bold: true,
              alignment: AlignmentType.CENTER,
            }),
            tableCell("Deskripsi", {
              width: 3547,
              bold: true,
              alignment: AlignmentType.CENTER,
            }),
            tableCell("Qty", {
              width: 1134,
              bold: true,
              alignment: AlignmentType.CENTER,
            }),
            tableCell("Total Harga (Rp.)", {
              width: 2127,
              bold: true,
              alignment: AlignmentType.CENTER,
            }),
          ],
        }),
        ...priceRows,
        ...summaryRows,
      ],
    }),
    paragraph("Catatan :", {
      size: 22,
      bold: true,
      before: 80,
      after: 35,
      keepNext: true,
    }),
    buildDocxCommercialNotes(quotation),
    paragraph(
      "Demikian surat ini kami sampaikan dan atas perhatian serta kerjasamanya kami mengucapkan terima kasih.",
      { size: 22, after: 440 },
    ),
    paragraph("Hormat kami,", { size: 22, after: 0 }),
    paragraph(safeText(settings.companyName).toUpperCase(), {
      size: 24,
      bold: true,
      after: 880,
    }),
    paragraph(settings.signerName, {
      size: 22,
      bold: true,
      underline: true,
      after: 0,
    }),
    paragraph(settings.signerTitle, {
      size: 22,
      italics: true,
      after: 0,
    }),
  );
  children.push(...buildDocxRabChildren(quotation));

  const document = new Document({
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22 },
          paragraph: { spacing: { line: 240, lineRule: "auto" } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            orientation: PageOrientation.PORTRAIT,
            size: { width: 11906, height: 16838 },
            margin: {
              top: Math.round(3.6 * TWIPS_PER_CM),
              bottom: Math.round(1.2 * TWIPS_PER_CM),
              left: Math.round(2.2 * TWIPS_PER_CM),
              right: Math.round(2.2 * TWIPS_PER_CM),
              header: 709,
              footer: 709,
            },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}

function resolvePdfFonts() {
  const windowsFontDir = process.env.WINDIR
    ? path.join(process.env.WINDIR, "Fonts")
    : "C:\\Windows\\Fonts";
  const candidates = {
    regular: path.join(windowsFontDir, "calibri.ttf"),
    bold: path.join(windowsFontDir, "calibrib.ttf"),
    italic: path.join(windowsFontDir, "calibrii.ttf"),
  };
  return Object.fromEntries(
    Object.entries(candidates).map(([key, value]) => [
      key,
      fs.existsSync(value)
        ? value
        : key === "bold"
          ? "Helvetica-Bold"
          : key === "italic"
            ? "Helvetica-Oblique"
            : "Helvetica",
    ]),
  );
}

export function buildPdfBuffer(quotation, settings) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const fonts = resolvePdfFonts();
    const doc = new PDFDocument({
      size: "A4",
      margins: {
        top: 3.6 * PT_PER_CM,
        bottom: 1.2 * PT_PER_CM,
        left: 2.2 * PT_PER_CM,
        right: 2.2 * PT_PER_CM,
      },
      info: {
        Title: `Quotation ${quotation.qn}`,
        Author: settings.companyName,
      },
      compress: true,
    });
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (fonts.regular.endsWith(".ttf")) doc.registerFont("Calibri", fonts.regular);
    if (fonts.bold.endsWith(".ttf")) doc.registerFont("CalibriBold", fonts.bold);
    if (fonts.italic.endsWith(".ttf")) doc.registerFont("CalibriItalic", fonts.italic);
    const regularFont = fonts.regular.endsWith(".ttf") ? "Calibri" : fonts.regular;
    const boldFont = fonts.bold.endsWith(".ttf") ? "CalibriBold" : fonts.bold;
    const italicFont = fonts.italic.endsWith(".ttf")
      ? "CalibriItalic"
      : fonts.italic;
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;
    let y = doc.page.margins.top;

    const write = (text, options = {}) => {
      const font = options.bold
        ? boldFont
        : options.italic
          ? italicFont
          : regularFont;
      doc.font(font).fontSize(options.size ?? 11).fillColor(options.color ?? "#111111");
      const textHeight = doc.heightOfString(safeText(text), {
        width: options.width ?? width,
        align: options.align ?? "left",
        lineGap: options.lineGap ?? 0,
      });
      doc.text(safeText(text), options.x ?? left, y, {
        width: options.width ?? width,
        align: options.align ?? "left",
        lineGap: options.lineGap ?? 0,
        underline: options.underline ?? false,
      });
      y += textHeight + (options.after ?? 0);
    };

    doc.font(regularFont).fontSize(11).fillColor("#111111");
    doc.text(`Jakarta, ${quotationDate(quotation.date)}`, left, y, {
      width: width / 2,
    });
    doc.text(`No. ${quotation.qn}`, left + width / 2, y, {
      width: width / 2,
      align: "right",
    });
    y += 11 + 16.5;

    if (quotation.mode === "DEMO") {
      write("DRAFT - DATA CONTOH. JANGAN DIKIRIM KE CUSTOMER.", {
        size: 11,
        bold: true,
        color: "#D40000",
        align: "center",
        after: 8,
      });
    }
    write(safeText(quotation.customer.name).toUpperCase(), {
      size: 12,
      bold: true,
      after: 2,
    });
    const addressLines = safeText(quotation.customer.address)
      .split(/\r?\n/)
      .filter(Boolean);
    if (addressLines.length) {
      addressLines.forEach((line, index) =>
        write(line, { size: 11, after: index === addressLines.length - 1 ? 16.5 : 0 }),
      );
    } else {
      y += 11 + 16.5;
    }
    write(`Up. Yth. : ${safeText(quotation.customer.pic)}`, {
      size: 11,
      after: 16.5,
    });
    write(`Perihal : Penawaran Harga ${quotation.packageName}`, {
      size: 11,
      bold: true,
      after: 0,
    });
    write(`             ${safeText(quotation.project.name)}`, {
      size: 11,
      bold: true,
      after: 22,
    });
    write("Dengan hormat,", { size: 11, after: 6 });
    write(
      "Sesuai dengan perihal di atas, maka bersama ini kami sampaikan sebagai berikut :",
      { size: 11, after: 8 },
    );

    const quotationTableWidth = width * 0.783;
    const quotationTableLeft = left + (width - quotationTableWidth) / 2;
    const columns = [
      quotationTableWidth * (563 / 7371),
      quotationTableWidth * (3547 / 7371),
      quotationTableWidth * (1134 / 7371),
      quotationTableWidth * (2127 / 7371),
    ];
    const cellPadding = 5;
    const drawTableRow = (values, options = {}) => {
      doc.font(options.bold ? boldFont : regularFont).fontSize(options.size ?? 9);
      const heights = values.map((value, index) =>
        doc.heightOfString(safeText(value), {
          width: columns[index] - cellPadding * 2,
          align: options.alignments?.[index] ?? "left",
        }),
      );
      const rowHeight = Math.max(options.minHeight ?? 18, ...heights.map((h) => h + 6));
      let x = quotationTableLeft;
      for (let index = 0; index < values.length; index += 1) {
        if (options.fill) {
          doc.save().fillColor(options.fill).rect(x, y, columns[index], rowHeight).fill().restore();
        }
        doc.rect(x, y, columns[index], rowHeight).lineWidth(0.5).stroke("#222222");
        doc
          .font(options.bold ? boldFont : regularFont)
          .fontSize(options.size ?? 9)
          .fillColor("#111111")
          .text(safeText(values[index]), x + cellPadding, y + 3, {
            width: columns[index] - cellPadding * 2,
            align: options.alignments?.[index] ?? "left",
          });
        x += columns[index];
      }
      y += rowHeight;
    };
    const drawSummaryRow = (label, value, options = {}) => {
      const labelWidth = columns[0] + columns[1] + columns[2];
      const valueWidth = columns[3];
      const rowHeight = options.minHeight ?? 20;
      const fill = options.fill;
      if (fill) {
        doc
          .save()
          .fillColor(fill)
          .rect(quotationTableLeft, y, labelWidth + valueWidth, rowHeight)
          .fill()
          .restore();
      }
      doc
        .rect(quotationTableLeft, y, labelWidth, rowHeight)
        .lineWidth(0.5)
        .stroke("#222222");
      doc
        .rect(quotationTableLeft + labelWidth, y, valueWidth, rowHeight)
        .lineWidth(0.5)
        .stroke("#222222");
      doc
        .font(boldFont)
        .fontSize(9)
        .fillColor("#111111")
        .text(safeText(label), quotationTableLeft + cellPadding, y + 4, {
          width: labelWidth - cellPadding * 2,
          align: "right",
        });
      doc.text(safeText(value), quotationTableLeft + labelWidth + cellPadding, y + 4, {
        width: valueWidth - cellPadding * 2,
        align: "right",
      });
      y += rowHeight;
    };
    drawTableRow(["No.", "Deskripsi", "Qty", "Total Harga (Rp.)"], {
      bold: true,
      alignments: ["center", "center", "center", "center"],
    });
    activePackageItems(quotation).forEach((item, index) => {
      drawTableRow(
        [`${index + 1}.`, item.description, "1 lot", rupiah(item.amount)],
        { alignments: ["center", "left", "center", "right"] },
      );
    });
    drawSummaryRow("Total Penawaran", rupiah(quotation.totals.grandTotal));

    y += 6;
    const noteColumns = splitCommercialNoteColumns(commercialNotes(quotation));
    const noteGap = noteColumns[1].length ? 16 : 0;
    const noteColumnWidth = noteColumns[1].length ? (width - noteGap) / 2 : width;
    const noteHeight = (notes) => {
      doc.font(regularFont).fontSize(9);
      return notes.reduce(
        (sum, note) =>
          sum +
          Math.max(
            10,
            doc.heightOfString(note.text, { width: noteColumnWidth - 26 }),
          ) +
          2,
        0,
      );
    };
    const estimatedNotesHeight = Math.max(
      noteHeight(noteColumns[0]),
      noteHeight(noteColumns[1]),
    );
    if (
      y + estimatedNotesHeight + 145 >
      doc.page.height - doc.page.margins.bottom
    ) {
      doc.addPage({
        size: "A4",
        margins: {
          top: 3.6 * PT_PER_CM,
          bottom: 1.2 * PT_PER_CM,
          left: 2.2 * PT_PER_CM,
          right: 2.2 * PT_PER_CM,
        },
      });
      y = doc.page.margins.top;
    }
    write("Catatan :", { size: 11, bold: true, after: 3 });
    const notesStartY = y;
    const drawNoteColumn = (notes, x) => {
      let noteY = notesStartY;
      for (const note of notes) {
        doc.font(regularFont).fontSize(9).fillColor("#111111");
        const textHeight = Math.max(
          10,
          doc.heightOfString(note.text, { width: noteColumnWidth - 26 }),
        );
        doc.text(note.label, x, noteY, { width: 22, align: "right" });
        doc.text(note.text, x + 26, noteY, { width: noteColumnWidth - 26 });
        noteY += textHeight + 2;
      }
      return noteY;
    };
    y = Math.max(
      drawNoteColumn(noteColumns[0], left),
      noteColumns[1].length
        ? drawNoteColumn(noteColumns[1], left + noteColumnWidth + noteGap)
        : notesStartY,
    );
    y += 8;
    write(
      "Demikian surat ini kami sampaikan dan atas perhatian serta kerjasamanya kami mengucapkan terima kasih.",
      { size: 11, after: 22 },
    );
    write("Hormat kami,", { size: 11, after: 0 });
    write(safeText(settings.companyName).toUpperCase(), {
      size: 12,
      bold: true,
      after: 44,
    });
    write(settings.signerName, {
      size: 11,
      bold: true,
      underline: true,
      after: 0,
    });
    write(settings.signerTitle, { size: 11, italic: true });

    const rabSections = customerRabSections(quotation);
    const rabColumns = [
      width * 0.07,
      width * 0.43,
      width * 0.1,
      width * 0.08,
      width * 0.16,
      width * 0.16,
    ];
    const rabPadding = 4;
    let rabPage = 0;

    const rawRabRow = (values, options = {}) => {
      doc.font(options.bold ? boldFont : regularFont).fontSize(options.size ?? 8);
      const heights = values.map((value, index) =>
        doc.heightOfString(safeText(value), {
          width: rabColumns[index] - rabPadding * 2,
          align: options.alignments?.[index] ?? "left",
        }),
      );
      const rowHeight = Math.max(options.minHeight ?? 18, ...heights.map((h) => h + 7));
      let x = left;
      values.forEach((value, index) => {
        if (options.fill) {
          doc
            .save()
            .fillColor(options.fill)
            .rect(x, y, rabColumns[index], rowHeight)
            .fill()
            .restore();
        }
        doc.rect(x, y, rabColumns[index], rowHeight).lineWidth(0.45).stroke("#263A46");
        doc
          .font(options.bold ? boldFont : regularFont)
          .fontSize(options.size ?? 8)
          .fillColor(options.color ?? "#111111")
          .text(safeText(value), x + rabPadding, y + 4, {
            width: rabColumns[index] - rabPadding * 2,
            align: options.alignments?.[index] ?? "left",
          });
        x += rabColumns[index];
      });
      y += rowHeight;
      return rowHeight;
    };

    const rabTableHeader = () =>
      rawRabRow(
        ["No.", "Description", "Unit", "Qty", "Unit Price (Rp.)", "Total (Rp.)"],
        {
          bold: true,
          size: 7.5,
          minHeight: 22,
          fill: "#16364A",
          color: "#FFFFFF",
          alignments: ["center", "center", "center", "center", "center", "center"],
        },
      );

    const startRabPage = (continued = false) => {
      doc.addPage({
        size: "A4",
        margins: {
          top: 3.6 * PT_PER_CM,
          bottom: 1.2 * PT_PER_CM,
          left: 2.2 * PT_PER_CM,
          right: 2.2 * PT_PER_CM,
        },
      });
      rabPage += 1;
      y = doc.page.margins.top;
      doc
        .font(boldFont)
        .fontSize(9)
        .fillColor("#315A67")
        .text(`LAMPIRAN 1${continued ? " - LANJUTAN" : ""}`, left, y, {
          width,
          align: "center",
        });
      y += 13;
      doc
        .font(boldFont)
        .fontSize(13)
        .fillColor("#111111")
        .text("DETAIL PENAWARAN / RAB", left, y, {
          width,
          align: "center",
        });
      y += 24;
      if (!continued) {
        doc.font(regularFont).fontSize(8.5).fillColor("#111111");
        doc.text(`No. Quotation : ${safeText(quotation.qn)}`, left, y, { width });
        y += 13;
        doc.text(`Customer : ${safeText(quotation.customer.name)}`, left, y, {
          width,
        });
        y += 13;
        doc.text(`Project : ${safeText(quotation.project.name)}`, left, y, {
          width,
        });
        y += 17;
        for (const detail of rabTechnicalSummary(quotation)) {
          const detailHeight = doc.heightOfString(detail, { width });
          doc.font(regularFont).fontSize(8).fillColor("#43535D").text(detail, left, y, {
            width,
          });
          y += detailHeight + 5;
        }
        y += 4;
      } else {
        doc
          .font(regularFont)
          .fontSize(8)
          .fillColor("#43535D")
          .text(`${safeText(quotation.qn)} - ${safeText(quotation.customer.name)}`, left, y, {
            width,
          });
        y += 17;
      }
      rabTableHeader();
    };

    const ensureRabSpace = (height = 24) => {
      const bottom = doc.page.height - doc.page.margins.bottom;
      if (y + height > bottom) startRabPage(true);
    };

    const drawRabRow = (values, options = {}) => {
      doc.font(options.bold ? boldFont : regularFont).fontSize(options.size ?? 8);
      const heights = values.map((value, index) =>
        doc.heightOfString(safeText(value), {
          width: rabColumns[index] - rabPadding * 2,
          align: options.alignments?.[index] ?? "left",
        }),
      );
      const estimated = Math.max(
        options.minHeight ?? 18,
        ...heights.map((height) => height + 7),
      );
      ensureRabSpace(estimated);
      rawRabRow(values, options);
    };

    startRabPage(false);
    if (!rabSections.length) {
      drawRabRow(["", "Belum ada item detail pada quotation.", "", "", "", ""], {
        alignments: ["center", "center", "center", "center", "center", "center"],
      });
    }
    for (const section of rabSections) {
      drawRabRow([`${section.number}.`, section.label, "", "", "", ""], {
        bold: true,
        fill: "#DCE5E8",
        alignments: ["center", "left", "center", "center", "right", "right"],
      });
      section.groups.forEach((group, groupIndex) => {
        if (group.title) {
          drawRabRow(
            [`${groupIndex + 1}.`, group.title.toUpperCase(), "", "", "", ""],
            {
              bold: true,
              fill: "#EEF1F2",
              alignments: ["center", "left", "center", "center", "right", "right"],
            },
          );
        }
        group.items.forEach((item, index) => {
          drawRabRow(
            [
              `${index + 1}`,
              item.description,
              item.unit,
              money.format(item.quantity),
              money.format(item.unitPrice),
              money.format(item.grossTotal),
            ],
            {
              alignments: ["center", "left", "center", "center", "right", "right"],
            },
          );
        });
      });
      if (section.discount > 0) {
        drawRabRow(["", "", "", "", "Diskon", `(${money.format(section.discount)})`], {
          bold: true,
          alignments: ["center", "left", "center", "center", "right", "right"],
        });
      }
      drawRabRow(
        ["", "", "", "", `Sub Total ${section.number}`, money.format(section.subtotal)],
        {
          bold: true,
          fill: "#F2F5F6",
          alignments: ["center", "left", "center", "center", "right", "right"],
        },
      );
    }
    [
      ["Subtotal RAB", quotation.totals.subtotal],
      [`PPN ${quotation.totals.ppnRate}%`, quotation.totals.tax],
      ["TOTAL PENAWARAN", quotation.totals.grandTotal],
    ].forEach(([label, value], index) => {
      drawRabRow(["", "", "", "", label, money.format(value)], {
        bold: true,
        fill: index === 2 ? "#DCE5E8" : undefined,
        alignments: ["center", "left", "center", "center", "right", "right"],
      });
    });
    ensureRabSpace(36);
    y += 7;
    doc
      .font(italicFont)
      .fontSize(7.5)
      .fillColor("#43535D")
      .text(
        "Catatan: harga pada lampiran ini merupakan harga jual customer. Harga sumber dan perhitungan internal tidak ditampilkan.",
        left,
        y,
        { width },
      );
    doc.end();
  });
}

export function safeDownloadName(qn, extension) {
  const safe = safeText(qn).replace(/[\\/:*?"<>|]/g, "_") || "Quotation";
  return `Quotation_${safe}.${extension}`;
}
