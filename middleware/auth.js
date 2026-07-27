const jwt = require("jsonwebtoken");
const { config } = require("../config/appConfig");
const userModel = require("../models/users");
const { sanitizeUser } = require("../utils/sanitize");

const ROLE_NAMES = {
  customer: 0,
  admin: 1,
};

function roleValue(role) {
  if (typeof role === "number") {
    return role;
  }
  if (typeof role === "string" && ROLE_NAMES[role.toLowerCase()] !== undefined) {
    return ROLE_NAMES[role.toLowerCase()];
  }
  return role;
}

function extractBearerToken(req) {
  const authHeader = req.headers.authorization || req.headers.token;
  if (!authHeader || typeof authHeader !== "string") {
    return null;
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
    return false;
  }
  return parts[1];
}

async function requireAuth(req, res, next) {
  try {
    const token = extractBearerToken(req);
    if (token === null) {
      return res.status(401).json({
        success: false,
        error: "Authentication token is required",
      });
    }
    if (token === false) {
      return res.status(401).json({
        success: false,
        error: "Authentication token must use Bearer format",
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwtSecret);
    } catch (err) {
      return res.status(401).json({
        success: false,
        error: "Authentication token is invalid or expired",
      });
    }

    if (!decoded || !decoded._id) {
      return res.status(401).json({
        success: false,
        error: "Authentication token is invalid or expired",
      });
    }

    const currentUser = await userModel.findById(decoded._id);
    if (!currentUser || currentUser.status === "disabled") {
      return res.status(401).json({
        success: false,
        error: "Authentication token is invalid or expired",
      });
    }

    const safeUser = sanitizeUser(currentUser);
    req.user = safeUser;
    req.auth = {
      userId: String(currentUser._id),
      role: currentUser.userRole,
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

function requireRole(...roles) {
  const allowed = roles.map(roleValue);
  return function roleMiddleware(req, res, next) {
    if (!req.auth) {
      return res.status(401).json({
        success: false,
        error: "Authentication is required",
      });
    }
    if (!allowed.includes(req.auth.role)) {
      return res.status(403).json({
        success: false,
        error: "Access denied",
      });
    }
    return next();
  };
}

function requireSelfOrRole(getTargetUserId, ...roles) {
  const allowed = roles.map(roleValue);
  return function selfOrRoleMiddleware(req, res, next) {
    if (!req.auth) {
      return res.status(401).json({
        success: false,
        error: "Authentication is required",
      });
    }

    const targetUserId = getTargetUserId(req);
    const isOwner = targetUserId && String(targetUserId) === String(req.auth.userId);
    const isAllowedRole = allowed.includes(req.auth.role);
    if (!isOwner && !isAllowedRole) {
      return res.status(403).json({
        success: false,
        error: "Access denied",
      });
    }
    return next();
  };
}

module.exports = {
  requireAuth,
  requireRole,
  requireSelfOrRole,
  loginCheck: requireAuth,
  isAdmin: requireRole("admin"),
  isAuth: requireSelfOrRole((req) => req.body.loggedInUserId),
};
