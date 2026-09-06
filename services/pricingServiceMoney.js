// Kept separate to avoid a circular dependency between the pricing and packaging services.
function toCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw Object.assign(new Error("Invalid price"), { status: 409, code: "INVALID_PRICE" });
  return Math.round(amount * 100);
}
function fromCents(cents) { return Number((Number(cents || 0) / 100).toFixed(2)); }
module.exports = { toCents, fromCents };
