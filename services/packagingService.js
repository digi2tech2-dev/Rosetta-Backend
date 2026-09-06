const packagingOptionModel = require("../models/packagingOptions");
const { isValidObjectId } = require("../utils/validation");
const { toCents, fromCents } = require("./pricingServiceMoney");

// Seed only an empty catalog. Existing administrator changes are never overwritten.
const INITIAL_OPTIONS = [
  { nameAr: "علبة كرتون", nameEn: "Cardboard Box", price: 0, costPrice: 10, displayOrder: 1, isDefault: true },
  { nameAr: "علبة مخمل", nameEn: "Velvet Box", price: 100, costPrice: 35, displayOrder: 2, isDefault: false },
  { nameAr: "علبة مخمل مضيئة", nameEn: "Lighted Velvet Box", price: 300, costPrice: 75, displayOrder: 3, isDefault: false },
];

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

async function ensureCatalog() {
  const count = await packagingOptionModel.countDocuments();
  if (count) return;
  try {
    await packagingOptionModel.insertMany(INITIAL_OPTIONS, { ordered: true });
  } catch (err) {
    // A concurrent first checkout may have seeded the catalog first.
    if ((await packagingOptionModel.countDocuments()) === 0) throw err;
  }
}

function serializePackagingOption(option) {
  const source = option && option.toObject ? option.toObject({ transform: false }) : option;
  if (!source) return null;
  return {
    _id: String(source._id), id: String(source._id), nameAr: source.nameAr, nameEn: source.nameEn,
    descriptionAr: source.descriptionAr || "", descriptionEn: source.descriptionEn || "",
    image: source.image || "", price: Number(source.price) || 0, costPrice: Number(source.costPrice) || 0, active: Boolean(source.active),
    displayOrder: Number(source.displayOrder) || 0, isDefault: Boolean(source.isDefault),
    createdAt: source.createdAt, updatedAt: source.updatedAt,
  };
}

async function listActivePackagingOptions() {
  await ensureCatalog();
  const options = await packagingOptionModel.find({ active: true }).sort({ displayOrder: 1, createdAt: 1 });
  return options.map(serializePackagingOption);
}

function selectionInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { mode: "default" };
  const mode = raw.mode === "per_unit" ? "per_unit" : raw.mode === "same" ? "same" : "default";
  return { mode, optionId: raw.optionId || raw.packagingOptionId, assignments: raw.assignments || raw.units };
}

async function resolvePackagingSelections(raw, items) {
  await ensureCatalog();
  const requested = selectionInput(raw);
  const defaultOption = await packagingOptionModel.findOne({ active: true, isDefault: true }).sort({ displayOrder: 1, createdAt: 1 });
  if (!defaultOption) throw httpError(409, "PACKAGING_DEFAULT_UNAVAILABLE", "No active default packaging option is configured");

  const assignments = [];
  if (requested.mode === "default") {
    items.forEach((item, itemIndex) => {
      for (let unitIndex = 1; unitIndex <= item.quantity; unitIndex += 1) assignments.push({ itemIndex, unitIndex, optionId: String(defaultOption._id) });
    });
  } else if (requested.mode === "same") {
    if (!isValidObjectId(requested.optionId)) throw httpError(400, "INVALID_PACKAGING_SELECTION", "A valid packaging option is required");
    items.forEach((item, itemIndex) => {
      for (let unitIndex = 1; unitIndex <= item.quantity; unitIndex += 1) assignments.push({ itemIndex, unitIndex, optionId: String(requested.optionId) });
    });
  } else {
    if (!Array.isArray(requested.assignments)) throw httpError(400, "INVALID_PACKAGING_SELECTION", "Packaging assignments are required");
    const seen = new Set();
    for (const assignment of requested.assignments) {
      const itemIndex = Number(assignment?.itemIndex);
      const unitIndex = Number(assignment?.unitIndex);
      const optionId = assignment?.optionId || assignment?.packagingOptionId;
      if (!Number.isInteger(itemIndex) || !Number.isInteger(unitIndex) || !isValidObjectId(optionId) || !items[itemIndex] || unitIndex < 1 || unitIndex > items[itemIndex].quantity) {
        throw httpError(400, "INVALID_PACKAGING_SELECTION", "Packaging assignments do not match cart quantities");
      }
      const key = `${itemIndex}:${unitIndex}`;
      if (seen.has(key)) throw httpError(400, "INVALID_PACKAGING_SELECTION", "Each purchased unit must have one packaging option");
      seen.add(key); assignments.push({ itemIndex, unitIndex, optionId: String(optionId) });
    }
    const expected = items.reduce((total, item) => total + item.quantity, 0);
    if (seen.size !== expected) throw httpError(400, "INVALID_PACKAGING_SELECTION", "Each purchased unit must have one packaging option");
  }

  const optionIds = [...new Set(assignments.map((entry) => entry.optionId))];
  const options = await packagingOptionModel.find({ _id: { $in: optionIds }, active: true });
  const byId = new Map(options.map((option) => [String(option._id), option]));
  if (byId.size !== optionIds.length) throw httpError(409, "PACKAGING_OPTION_UNAVAILABLE", "One or more packaging options are inactive or unavailable");

  let totalCents = 0;
  const snapshotAssignments = assignments.map((entry) => {
    const option = byId.get(entry.optionId);
    const priceCents = toCents(option.price);
    const costCents = toCents(option.costPrice || 0);
    totalCents += priceCents;
    const item = items[entry.itemIndex];
    return {
      itemIndex: entry.itemIndex, product: String(item.productId), productName: item.name, unitIndex: entry.unitIndex,
      packagingOptionId: String(option._id), nameAr: option.nameAr, nameEn: option.nameEn,
      image: option.image || "", unitPrice: fromCents(priceCents), costPrice: fromCents(costCents), quantity: 1,
    };
  });
  return { mode: requested.mode === "default" ? "same" : requested.mode, assignments: snapshotAssignments, total: fromCents(totalCents), totalCents };
}

module.exports = { ensureCatalog, listActivePackagingOptions, resolvePackagingSelections, serializePackagingOption };
