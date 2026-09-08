const { config } = require("../config/appConfig");

function providerError(code, message, retryable, status) {
  return Object.assign(new Error(message), { code, retryable, status });
}

function openwaUrl() {
  return `${String(config.openwaBaseUrl || "").replace(/\/+$/, "")}/api/sessions/${encodeURIComponent(config.openwaSessionId)}/messages/send-text`;
}

function responseMessage(data, fallback) {
  if (data && typeof data === "object") {
    if (Array.isArray(data.message)) return data.message.join("; ").slice(0, 500);
    if (data.message) return String(data.message).slice(0, 500);
    if (data.error) return String(data.error).slice(0, 500);
  }
  return fallback;
}

function providerMessageId(data) {
  return data && (data.id || data.messageId || data.message?.id) ? String(data.id || data.messageId || data.message.id) : null;
}

function classifyHttpFailure(status, body) {
  if (status === 401 || status === 403) return providerError("OPENWA_AUTH_FAILED", "OpenWA authentication or authorization failed", false, status);
  if (status === 400 || status === 404 || status === 422 || status === 501) return providerError("OPENWA_REQUEST_REJECTED", responseMessage(body, "OpenWA rejected the request"), false, status);
  if (status === 409 || status === 429 || status >= 500) return providerError("OPENWA_TEMPORARY_FAILURE", responseMessage(body, "OpenWA is temporarily unavailable"), true, status);
  return providerError("OPENWA_HTTP_FAILURE", responseMessage(body, "OpenWA request failed"), true, status);
}

async function sendText({ recipient, message }) {
  if (!config.openwaEnabled) throw providerError("OPENWA_DISABLED", "OpenWA is disabled", false);
  if (!recipient || !/^201[0125]\d{8}$/.test(recipient)) {
    throw providerError("INVALID_RECIPIENT", "Recipient is invalid", false);
  }
  if (!message || String(message).length > 4096) {
    throw providerError("INVALID_MESSAGE", "Message is invalid", false);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.openwaTimeoutMs);
  try {
    const response = await fetch(openwaUrl(), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "X-API-Key": config.openwaApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ chatId: `${recipient}@c.us`, text: String(message) }),
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (err) { data = null; }
    if (response.status !== 201) throw classifyHttpFailure(response.status, data);
    return { provider: "openwa", providerMessageId: providerMessageId(data), response: data };
  } catch (err) {
    if (err.name === "AbortError") throw providerError("OPENWA_TIMEOUT", "OpenWA timed out", true);
    if (err.code && err.retryable !== undefined) throw err;
    throw providerError("OPENWA_NETWORK_FAILURE", "OpenWA network request failed", true);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { classifyHttpFailure, sendText };
