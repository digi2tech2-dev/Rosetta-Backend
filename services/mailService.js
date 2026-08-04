const nodemailer = require("nodemailer");
const { config } = require("../config/appConfig");

const fakeMessages = [];

function shouldUseFakeTransport() {
  return config.nodeEnv === "test";
}

function getFakeMessages() {
  return fakeMessages;
}

function clearFakeMessages() {
  fakeMessages.length = 0;
}

async function sendPasswordResetCode({ to, code }) {
  if (shouldUseFakeTransport()) {
    fakeMessages.push({
      type: "password-reset",
      to,
      subject: "Rosetta password reset code",
      code,
      createdAt: new Date(),
    });
    return { accepted: [to] };
  }

  if (!config.smtpHost) {
    const err = new Error("SMTP_HOST is not configured");
    err.status = 503;
    throw err;
  }

  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser || config.smtpPass ? {
      user: config.smtpUser,
      pass: config.smtpPass,
    } : undefined,
  });

  return transport.sendMail({
    from: config.mailFrom,
    to,
    subject: "Rosetta password reset code",
    text: `Use this Rosetta password reset code within ${config.passwordResetCodeTtlMinutes} minutes: ${code}`,
  });
}

module.exports = {
  clearFakeMessages,
  getFakeMessages,
  sendPasswordResetCode,
};
