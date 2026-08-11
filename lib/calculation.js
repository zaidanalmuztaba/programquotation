const money = (value) => Math.round(Number(value) || 0);
const numeric = (value, fallback = 0) => {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
};

export function packageIncludes(packageName, target) {
  return packageName === target || packageName === "FirePro + PAC";
}

function normalizeAces(firepro = {}) {
  const source = firepro.aces ?? {};
  const generators = (source.generators ?? []).map((item) => ({
    ...item,
    code: String(item.code ?? "").trim(),
    model: String(item.model ?? "").trim(),
    dischargeTemperature: String(item.dischargeTemperature ?? "").trim(),
    effectiveMass: Math.max(0, numeric(item.effectiveMass)),
    quantity: Math.max(0, Math.round(numeric(item.quantity))),
    totalConcentration: Math.max(0, numeric(item.totalConcentration)),
  }));
  const electronics = (source.electronics ?? []).map((item) => ({
    ...item,
    code: String(item.code ?? "").trim(),
    description: String(item.description ?? "").trim(),
    category: String(item.category ?? "").trim(),
    quantity: Math.max(0, Math.round(numeric(item.quantity))),
  }));
  const attachments = (firepro.acesAttachments ?? []).filter(
    (attachment) => attachment?.id && attachment?.originalName,
  );
  const structured =
    Boolean(source.referenceNumber) ||
    numeric(source.selectedMass) > 0 ||
    generators.some((item) => item.model || item.code);
  const legacyApproved =
    String(firepro.approvalStatus ?? "").startsWith("Disetujui") &&
    Boolean(String(firepro.acesReference ?? "").trim()) &&
    numeric(firepro.approvedAgent) > 0;

  return {
    projectName: String(source.projectName ?? "").trim(),
    reportDate: String(source.reportDate ?? "").trim(),
    referenceNumber: String(
      source.referenceNumber ?? firepro.acesReference ?? "",
    ).trim(),
    roomName: String(source.roomName ?? "").trim(),
    spaceType: String(source.spaceType ?? "").trim(),
    numberOfDoors: Math.max(0, Math.round(numeric(source.numberOfDoors))),
    shape: String(source.shape ?? "").trim(),
    width: Math.max(0, numeric(source.width)),
    height: Math.max(0, numeric(source.height)),
    length: Math.max(0, numeric(source.length)),
    calculatedVolume: Math.max(0, numeric(source.calculatedVolume)),
    classOfFire: String(source.classOfFire ?? "").trim(),
    ead: Math.max(0, numeric(source.ead)),
    streamRequired: String(source.streamRequired ?? "").trim(),
    safetyFactorPercent: Math.max(0, numeric(source.safetyFactorPercent, 30)),
    requiredMass: Math.max(0, numeric(source.requiredMass)),
    selectedMass: Math.max(
      0,
      numeric(source.selectedMass, numeric(firepro.approvedAgent)),
    ),
    excessMass: numeric(source.excessMass),
    excessPercent: numeric(source.excessPercent),
    approvalResult: String(
      source.approvalResult || (!structured && legacyApproved ? "LEGACY" : ""),
    )
      .trim()
      .toUpperCase(),
    approvalNote: String(source.approvalNote ?? "").trim(),
    importedFrom: String(source.importedFrom ?? "").trim(),
    importedAt: String(source.importedAt ?? "").trim(),
    generators,
    electronics,
    attachments,
    structured,
  };
}

export function computeLine(item = {}) {
  const quantity = Math.max(0, Math.round(numeric(item.quantity)));
  const divisor = Math.max(0.000001, numeric(item.divisor, 1));
  const sourcePrice = Math.max(0, numeric(item.sourcePrice));
  const manualCost =
    item.manualCost === "" || item.manualCost == null
      ? null
      : Math.max(0, numeric(item.manualCost));
  const baseCost = manualCost ?? sourcePrice;
  const effectiveCost = baseCost / divisor;
  const markupPercent = numeric(item.markupPercent);
  const computedUnitPrice = money(effectiveCost * (1 + markupPercent / 100));
  const overridePrice =
    item.overridePrice === "" || item.overridePrice == null
      ? null
      : Math.max(0, numeric(item.overridePrice));
  const approvedUnitPrice = money(overridePrice ?? computedUnitPrice);
  const discountPercent = Math.min(
    100,
    Math.max(0, numeric(item.discountPercent)),
  );
  const lineTotal = money(
    quantity * approvedUnitPrice * (1 - discountPercent / 100),
  );

  return {
    ...item,
    active: item.active !== false,
    rabGroupId: String(item.rabGroupId ?? ""),
    quantity,
    divisor,
    sourcePrice,
    manualCost,
    effectiveCost: money(effectiveCost),
    markupPercent,
    computedUnitPrice,
    overridePrice,
    approvedUnitPrice,
    discountPercent,
    lineTotal: item.active === false ? 0 : lineTotal,
  };
}

export function computeFireProEngineering(firepro = {}) {
  const rooms = (firepro.rooms ?? []).map((room, index) => {
    const length = Math.max(0, numeric(room.length));
    const width = Math.max(0, numeric(room.width));
    const height = Math.max(0, numeric(room.height));
    const raisedFloor = Math.max(0, numeric(room.raisedFloor));
    const falseCeiling = Math.max(0, numeric(room.falseCeiling));
    const fireClass = Math.max(0, numeric(room.fireClass, 46));
    const safetyFactor = Math.max(0, numeric(room.safetyFactor, 1.3));
    const mainVolume = length * width * height;
    const raisedFloorVolume = length * width * raisedFloor;
    const falseCeilingVolume = length * width * falseCeiling;
    const totalVolume = mainVolume + raisedFloorVolume + falseCeilingVolume;
    const mainRequirement = mainVolume * fireClass * safetyFactor;
    const raisedFloorRequirement =
      raisedFloorVolume * fireClass * safetyFactor;
    const falseCeilingRequirement =
      falseCeilingVolume * fireClass * safetyFactor;

    return {
      ...room,
      index: index + 1,
      length,
      width,
      height,
      raisedFloor,
      falseCeiling,
      fireClass,
      safetyFactor,
      mainVolume,
      raisedFloorVolume,
      falseCeilingVolume,
      totalVolume,
      mainRequirement,
      raisedFloorRequirement,
      falseCeilingRequirement,
      totalRequirement:
        mainRequirement + raisedFloorRequirement + falseCeilingRequirement,
    };
  });

  const aces = normalizeAces(firepro);
  const totalProtectedVolume = rooms.reduce(
    (total, room) => total + room.totalVolume,
    0,
  );
  const acesVolumeDifference =
    aces.calculatedVolume > 0
      ? totalProtectedVolume - aces.calculatedVolume
      : 0;
  const acesVolumeDifferencePercent =
    aces.calculatedVolume > 0
      ? (acesVolumeDifference / aces.calculatedVolume) * 100
      : 0;

  return {
    ...firepro,
    rooms,
    aces,
    acesAttachments: aces.attachments,
    totalProtectedVolume,
    acesVolumeDifference,
    acesVolumeDifferencePercent,
    totalRequirement: rooms.reduce(
      (total, room) => total + room.totalRequirement,
      0,
    ),
    approvedAgent: aces.selectedMass,
    acesReference: aces.referenceNumber,
  };
}

export function computePacEngineering(pac = {}) {
  const heatLoad = Math.max(0, numeric(pac.heatLoad));
  const totalCapacity = Math.max(0, numeric(pac.totalCapacity));
  const quantity = Math.max(1, numeric(pac.quantity, 1));
  return {
    ...pac,
    heatLoad,
    totalCapacity,
    quantity,
    capacityMargin: totalCapacity - heatLoad,
    capacitySufficient: totalCapacity >= heatLoad && heatLoad > 0,
  };
}

export function validateQuotation(quotation) {
  const errors = [];
  const warnings = [];
  const packageName = quotation.packageName;
  const items = quotation.items ?? [];

  if (!String(quotation.qn ?? "").trim()) {
    errors.push("Nomor QN belum terisi.");
  }
  if (!String(quotation.customer?.name ?? "").trim()) {
    errors.push("Nama customer belum terisi.");
  }
  if (!String(quotation.project?.name ?? "").trim()) {
    errors.push("Nama project belum terisi.");
  }
  if (!["FirePro", "PAC", "FirePro + PAC"].includes(packageName)) {
    errors.push("Paket quotation belum dipilih.");
  }
  if (!items.some((item) => item.active !== false)) {
    errors.push("Belum ada item komersial aktif.");
  }

  for (const item of items.filter((candidate) => candidate.active !== false)) {
    if (!String(item.description ?? "").trim()) {
      errors.push("Ada item komersial tanpa deskripsi.");
    }
    if (numeric(item.quantity) <= 0) {
      errors.push(`Qty item ${item.description || "(tanpa nama)"} harus lebih dari nol.`);
    }
    if (numeric(item.approvedUnitPrice) <= 0) {
      errors.push(`Harga item ${item.description || "(tanpa nama)"} masih nol.`);
    }
    if (
      item.overridePrice != null &&
      item.overridePrice !== "" &&
      !String(item.overrideReason ?? "").trim()
    ) {
      errors.push(`Override harga ${item.description || "(tanpa nama)"} belum memiliki alasan.`);
    }
    if (item.priceOrigin === "MANUAL_SUPPORT") {
      warnings.push(
        `Harga manual Support untuk ${item.description || item.code || "(tanpa nama)"} belum diverifikasi Logistik.`,
      );
    } else if (
      item.verificationStatus === "PERLU_VERIFIKASI_LOGISTIK"
    ) {
      warnings.push(
        `Harga untuk ${item.description || item.code || "(tanpa nama)"} belum tersedia atau belum diverifikasi Logistik.`,
      );
    } else if (item.needsReview === true && numeric(item.approvedUnitPrice) > 0) {
      warnings.push(
        `Sumber harga ${item.description || item.code || "(tanpa nama)"} masih berstatus review.`,
      );
    }
  }

  if (packageIncludes(packageName, "FirePro")) {
    if (!(quotation.firepro?.rooms ?? []).length) {
      errors.push("Data ruang FirePro belum diisi.");
    }
    const firepro = quotation.firepro ?? {};
    const aces = firepro.aces ?? {};
    if (!String(aces.referenceNumber ?? "").trim()) {
      errors.push("Nomor referensi hasil ACES belum diisi.");
    }
    if (aces.approvalResult === "LEGACY") {
      warnings.push(
        "Data FirePro masih memakai format ACES lama; lengkapi ringkasan dan BOM ACES.",
      );
    } else if (aces.approvalResult !== "APPROVED") {
      errors.push("Status hasil ACES belum APPROVED.");
    }
    if (numeric(aces.selectedMass) <= 0) {
      errors.push("Effective mass terpilih dari ACES belum diisi.");
    }
    if (
      !(aces.generators ?? []).some(
        (item) =>
          (String(item.model ?? "").trim() || String(item.code ?? "").trim()) &&
          numeric(item.quantity) > 0,
      )
    ) {
      if (aces.approvalResult === "LEGACY") {
        warnings.push("Model dan quantity generator dari BOM ACES belum dicatat.");
      } else {
        errors.push("Model dan quantity generator dari BOM ACES belum diisi.");
      }
    }
    if (!String(firepro.approvalStatus ?? "").startsWith("Disetujui")) {
      errors.push("Approval engineering FirePro belum disetujui.");
    }
    if (!(firepro.acesAttachments ?? []).length) {
      warnings.push("File hasil ACES DOCX/PDF belum dilampirkan pada quotation.");
    }
    if (
      numeric(aces.calculatedVolume) > 0 &&
      Math.abs(numeric(firepro.acesVolumeDifferencePercent)) > 2
    ) {
      warnings.push(
        `Volume awal berbeda ${Math.abs(numeric(firepro.acesVolumeDifferencePercent)).toFixed(2)}% dari volume ACES; periksa main room/raised floor/false ceiling.`,
      );
    }
  }

  if (packageIncludes(packageName, "PAC")) {
    if (!String(quotation.pac?.approvedModel ?? "").trim()) {
      errors.push("Model PAC yang disetujui belum diisi.");
    }
    if (!quotation.pac?.capacitySufficient) {
      errors.push("Kapasitas PAC belum mencukupi heat load.");
    }
    if (!String(quotation.pac?.approvalStatus ?? "").startsWith("Disetujui")) {
      errors.push("Approval engineering PAC belum disetujui.");
    }
    if (quotation.pac?.priceConfirmed !== true) {
      warnings.push("Harga PAC wajib dikonfirmasi terhadap pricelist terbaru.");
    }
  }

  if (quotation.mode === "DEMO") {
    warnings.push("Mode masih DEMO. Dokumen ekspor akan diberi tanda DRAFT.");
  }
  const snapshot = quotation.sourceSnapshotDate;
  if (snapshot) {
    const ageDays = Math.floor(
      (Date.now() - new Date(snapshot).getTime()) / 86_400_000,
    );
    if (Number.isFinite(ageDays) && ageDays > 45) {
      warnings.push(`Snapshot material berumur ${ageDays} hari; periksa pembaruan harga.`);
    }
  }

  return {
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    status:
      errors.length > 0
        ? "BELUM SIAP"
        : warnings.length > 0
          ? "PERLU REVIEW"
          : "SIAP DIBUAT",
  };
}

export function calculateQuotation(input = {}) {
  const items = (input.items ?? []).map(computeLine);
  const rabGroups = (input.rabGroups ?? []).map((group, index) => ({
    id: String(group?.id || `rab-group-${index + 1}`),
    title: String(group?.title ?? "").trim(),
    section: ["equipment", "material", "service"].includes(group?.section)
      ? group.section
      : "equipment",
  }));
  const firepro = computeFireProEngineering(input.firepro);
  const pac = computePacEngineering(input.pac);
  const subtotal = money(
    items.reduce((total, item) => total + item.lineTotal, 0),
  );
  const ppnRate = Math.max(0, numeric(input.terms?.ppnRate, 11));
  const ppnIncluded = input.terms?.ppnIncluded === true;
  const tax = ppnIncluded ? money(subtotal * (ppnRate / 100)) : 0;
  const grandTotal = subtotal + tax;

  const sourceTerms = input.terms ?? {};
  const noteItems = Array.isArray(sourceTerms.noteItems)
    ? sourceTerms.noteItems.map((item, index) => ({
        id: String(item?.id || `note-${index + 1}`),
        text: String(item?.text ?? ""),
        level: Number(item?.level) === 1 ? 1 : 0,
        source: String(item?.source ?? ""),
      }))
    : legacyCommercialNotes(sourceTerms);

  const calculated = {
    ...input,
    mode: input.mode === "PRODUKSI" ? "PRODUKSI" : "DEMO",
    packageName: input.packageName || "FirePro + PAC",
    sourceSnapshotDate: input.sourceSnapshotDate || "2026-07-06",
    items,
    rabGroups,
    firepro,
    pac,
    terms: {
      ...sourceTerms,
      ppnIncluded,
      ppnRate,
      noteItems,
    },
    totals: {
      subtotal,
      tax,
      grandTotal,
      ppnRate,
      ppnIncluded,
    },
  };
  return {
    ...calculated,
    validation: validateQuotation(calculated),
  };
}

function legacyCommercialNotes(terms = {}) {
  const ppnRate = Math.max(0, numeric(terms.ppnRate, 11));
  const franco = String(terms.franco || "Lokasi proyek sesuai kesepakatan").trim();
  const notes = [
    {
      id: "note-franco-ppn",
      source: "franco_ppn",
      level: 0,
      text: `Harga Franco ${franco} dan ${terms.ppnIncluded === true ? "sudah" : "belum"} termasuk PPN ${ppnRate}%.`,
    },
    {
      id: "note-payment",
      source: "payment",
      level: 0,
      text: `Cara Pembayaran: ${String(terms.payment || "Sesuai persetujuan komersial").trim()}`,
    },
    {
      id: "note-delivery",
      source: "delivery",
      level: 0,
      text: `Delivery: ${String(terms.delivery || "Setelah PO dan pembayaran sesuai kesepakatan").trim()}`,
    },
    {
      id: "note-warranty",
      source: "warranty",
      level: 0,
      text: `Garansi: ${String(terms.warranty || "1 tahun sejak BAST sesuai syarat pabrikan").trim()}`,
    },
    {
      id: "note-validity",
      source: "validity",
      level: 0,
      text: `Masa berlaku penawaran: ${Math.max(1, Math.round(numeric(terms.validityDays, 14)))} hari.`,
    },
  ];
  if (String(terms.notes || "").trim()) {
    notes.push({
      id: "note-legacy-additional",
      source: "legacy",
      level: 0,
      text: String(terms.notes).trim(),
    });
  }
  return notes;
}

export function createEmptyQuotation() {
  return calculateQuotation({
    id: null,
    qn: "",
    qnCreatorInitials: "YN",
    revision: 0,
    mode: "DEMO",
    packageName: "FirePro + PAC",
    customer: { name: "", address: "", pic: "" },
    project: { name: "", location: "" },
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
      rooms: [],
      approvedAgent: 0,
      acesReference: "",
      approvalStatus: "Belum disetujui",
      acesAttachments: [],
      aces: {
        projectName: "",
        reportDate: "",
        referenceNumber: "",
        roomName: "",
        spaceType: "",
        numberOfDoors: 0,
        shape: "",
        width: 0,
        height: 0,
        length: 0,
        calculatedVolume: 0,
        classOfFire: "",
        ead: 0,
        streamRequired: "",
        safetyFactorPercent: 30,
        requiredMass: 0,
        selectedMass: 0,
        excessMass: 0,
        excessPercent: 0,
        approvalResult: "",
        approvalNote: "",
        importedFrom: "",
        importedAt: "",
        generators: [],
        electronics: [],
      },
    },
    pac: {
      approvedModel: "",
      heatLoad: 0,
      totalCapacity: 0,
      quantity: 1,
      approvalStatus: "Belum disetujui",
      priceConfirmed: false,
    },
    rabGroups: [],
    items: [],
  });
}
