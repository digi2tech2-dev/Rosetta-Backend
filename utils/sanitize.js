const { serializeCustomerSelf } = require("../services/customerSerializer");

function sanitizeUser(user) {
  if (!user) {
    return user;
  }

  return serializeCustomerSelf(user);
}

function sanitizeUsers(users) {
  return Array.isArray(users) ? users.map(sanitizeUser) : [];
}

module.exports = {
  sanitizeUser,
  sanitizeUsers,
};
