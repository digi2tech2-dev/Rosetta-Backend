function sanitizeUser(user) {
  if (!user) {
    return user;
  }

  const source = typeof user.toObject === "function" ? user.toObject() : { ...user };
  delete source.password;
  delete source.secretKey;
  delete source.__v;

  if (source._id && !source.id) {
    source.id = String(source._id);
  }
  if (source.userRole !== undefined && source.role === undefined) {
    source.role = source.userRole;
  }

  return source;
}

function sanitizeUsers(users) {
  return Array.isArray(users) ? users.map(sanitizeUser) : [];
}

module.exports = {
  sanitizeUser,
  sanitizeUsers,
};
