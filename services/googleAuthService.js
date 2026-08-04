const { OAuth2Client } = require("google-auth-library");
const { config } = require("../config/appConfig");
const { normalizeEmail } = require("../utils/validation");

const MAX_CREDENTIAL_LENGTH = 8192;
const VALID_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

let oauthClient;

function authError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function cleanString(value, max = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function parseFakeCredential(credential) {
  if (config.nodeEnv !== "test" || config.googleAuthVerifier !== "fake") {
    throw authError("INVALID_GOOGLE_CREDENTIAL", "Invalid Google credential");
  }
  const raw = String(credential).startsWith("fake:")
    ? String(credential).slice(5)
    : String(credential);
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch (err) {
    throw authError("INVALID_GOOGLE_CREDENTIAL", "Invalid Google credential");
  }
}

async function getVerifiedPayload(credential) {
  if (config.googleAuthVerifier === "fake") {
    return parseFakeCredential(credential);
  }

  oauthClient = oauthClient || new OAuth2Client();
  const ticket = await oauthClient.verifyIdToken({
    idToken: credential,
    audience: config.googleClientId,
  });
  return ticket.getPayload();
}

function normalizeGoogleIdentity(payload) {
  if (!payload || typeof payload !== "object") {
    throw authError("INVALID_GOOGLE_CREDENTIAL", "Invalid Google credential");
  }
  if (payload.aud !== config.googleClientId) {
    throw authError("INVALID_GOOGLE_CREDENTIAL", "Invalid Google credential");
  }
  if (!VALID_ISSUERS.has(payload.iss)) {
    throw authError("INVALID_GOOGLE_CREDENTIAL", "Invalid Google credential");
  }
  if (payload.exp && Number(payload.exp) * 1000 <= Date.now()) {
    throw authError("INVALID_GOOGLE_CREDENTIAL", "Invalid Google credential");
  }

  const sub = cleanString(payload.sub, 255);
  const email = normalizeEmail(payload.email);
  if (!sub) {
    throw authError("INVALID_GOOGLE_CREDENTIAL", "Invalid Google credential");
  }
  if (!email) {
    throw authError("INVALID_GOOGLE_CREDENTIAL", "Invalid Google credential");
  }
  if (payload.email_verified !== true && payload.email_verified !== "true") {
    throw authError("GOOGLE_EMAIL_NOT_VERIFIED", "Google email is not verified");
  }

  return {
    sub,
    email,
    emailVerified: true,
    name: cleanString(payload.name, 120),
    givenName: cleanString(payload.given_name, 80),
    familyName: cleanString(payload.family_name, 80),
    picture: cleanString(payload.picture, 500),
  };
}

async function verifyGoogleCredential(credential) {
  if (typeof credential !== "string" || !credential.trim()) {
    throw authError("GOOGLE_CREDENTIAL_REQUIRED", "Google credential is required");
  }
  if (credential.length > MAX_CREDENTIAL_LENGTH) {
    throw authError("INVALID_GOOGLE_CREDENTIAL", "Invalid Google credential");
  }
  if (!config.googleAuthEnabled || !config.googleClientId) {
    throw authError("GOOGLE_AUTH_DISABLED", "Google sign-in is not enabled");
  }

  let payload;
  try {
    payload = await getVerifiedPayload(credential);
  } catch (err) {
    if (err && err.code && err.code.startsWith("GOOGLE_")) {
      throw err;
    }
    throw authError("INVALID_GOOGLE_CREDENTIAL", "Invalid Google credential");
  }
  return normalizeGoogleIdentity(payload);
}

module.exports = {
  MAX_CREDENTIAL_LENGTH,
  verifyGoogleCredential,
};
