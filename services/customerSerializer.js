const SENSITIVE_FIELDS = new Set([
  "password",
  "secretKey",
  "resetCodeHash",
  "resetCodeExpiresAt",
  "resetCodeAttempts",
  "resetCodeRequestedAt",
  "resetTokenHash",
  "resetTokenExpiresAt",
  "tokenVersion",
  "authProviders",
  "__v",
]);

function plain(value) {
  if (!value) return value;
  return typeof value.toObject === "function" ? value.toObject({ transform: false }) : { ...value };
}

function normalizedStatus(status) {
  return status === "disabled" ? "blocked" : status || "active";
}

function normalizePhone(user) {
  return user.phone || (user.phoneNumber === undefined || user.phoneNumber === null ? null : String(user.phoneNumber));
}

function cleanAddress(address) {
  const source = plain(address) || {};
  return {
    _id: source._id,
    label: source.label || "",
    fullName: source.fullName || "",
    phone: source.phone || "",
    alternatePhone: source.alternatePhone || "",
    governorate: source.governorate || "",
    city: source.city || "",
    area: source.area || "",
    street: source.street || "",
    building: source.building || "",
    floor: source.floor || "",
    apartment: source.apartment || "",
    landmark: source.landmark || "",
    postalCode: source.postalCode || "",
    notes: source.notes || "",
    isDefault: Boolean(source.isDefault),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function stripSensitive(source) {
  for (const key of SENSITIVE_FIELDS) {
    delete source[key];
  }
  return source;
}

function serializeCustomerSelf(user) {
  const source = stripSensitive(plain(user) || {});
  return {
    _id: source._id,
    id: source._id ? String(source._id) : undefined,
    name: source.name || "",
    email: source.email || "",
    phone: normalizePhone(source),
    phoneNumber: source.phoneNumber,
    userImage: source.userImage || "user.png",
    avatar: source.userImage || "user.png",
    userRole: source.userRole,
    role: source.userRole,
    status: normalizedStatus(source.status),
    verified: Boolean(source.verified),
    addresses: Array.isArray(source.addresses) ? source.addresses.map(cleanAddress) : [],
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function serializeAdminCustomer(user, options = {}) {
  const source = serializeCustomerSelf(user);
  const raw = plain(user) || {};
  return {
    ...source,
    ordersCount: options.ordersCount || 0,
    totalSpent: options.totalSpent || 0,
    lastOrderAt: options.lastOrderAt || null,
    recentOrders: options.recentOrders || [],
    accountStatusHistory: Array.isArray(raw.accountStatusHistory)
      ? raw.accountStatusHistory.map((entry) => ({
          from: normalizedStatus(entry.from),
          to: normalizedStatus(entry.to),
          changedBy: entry.changedBy,
          reason: entry.reason || "",
          changedAt: entry.changedAt,
        }))
      : [],
  };
}

function serializeCustomerListItem(user, stats = {}) {
  const source = serializeCustomerSelf(user);
  return {
    _id: source._id,
    id: source.id,
    name: source.name,
    email: source.email,
    phone: source.phone,
    phoneNumber: source.phoneNumber,
    userImage: source.userImage,
    avatar: source.avatar,
    userRole: source.userRole,
    role: source.role,
    status: source.status,
    verified: source.verified,
    createdAt: source.createdAt,
    ordersCount: stats.ordersCount || 0,
    totalSpent: stats.totalSpent || 0,
    lastOrderAt: stats.lastOrderAt || null,
  };
}

module.exports = {
  normalizedStatus,
  serializeAdminCustomer,
  serializeCustomerListItem,
  serializeCustomerSelf,
  stripSensitive,
};
