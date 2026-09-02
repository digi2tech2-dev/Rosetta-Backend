const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const notificationOutboxSchema = new mongoose.Schema(
  {
    eventKey: { type: String, required: true, unique: true, index: true },
    channel: { type: String, enum: ["whatsapp"], required: true, default: "whatsapp" },
    eventType: { type: String, enum: ["order_created", "order_status_changed"], required: true },
    order: { type: ObjectId, ref: "orders", required: true, index: true },
    recipient: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    message: { type: String, required: true, maxlength: 4096 },
    status: { type: String, enum: ["pending", "processing", "sent", "failed", "dead"], default: "pending", index: true },
    attempts: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, required: true, min: 1 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    lockedAt: { type: Date, default: null, index: true },
    lockToken: { type: String, default: null, select: false },
    lastAttemptAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    provider: { type: String, enum: ["openwa"], default: "openwa" },
    providerMessageId: { type: String, default: null },
    lastErrorCode: { type: String, default: null },
    lastErrorMessage: { type: String, default: null },
  },
  { timestamps: true }
);

notificationOutboxSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });

module.exports = mongoose.model("notificationOutbox", notificationOutboxSchema);
