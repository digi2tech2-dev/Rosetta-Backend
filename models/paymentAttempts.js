const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const webhookEventSchema = new mongoose.Schema(
  {
    providerEventId: String,
    transactionId: String,
    receivedAt: { type: Date, default: Date.now },
    result: String,
    payloadDigest: String,
  },
  { _id: false }
);

const paymentAttemptSchema = new mongoose.Schema(
  {
    customer: { type: ObjectId, ref: "users", default: null },
    customerType: { type: String, enum: ["registered", "guest"], default: "registered", index: true },
    order: { type: ObjectId, ref: "orders", required: true },
    provider: { type: String, enum: ["paymob"], required: true },
    method: { type: String, enum: ["card", "wallet"], required: true },
    status: {
      type: String,
      enum: ["creating", "pending", "paid", "failed", "expired", "cancelled", "manual_review"],
      default: "creating",
    },
    idempotencyKey: { type: String, required: true },
    idempotencyScope: String,
    requestFingerprint: { type: String, required: true },
    internalReference: { type: String, required: true, unique: true },
    amountMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },
    providerIntentionId: String,
    providerOrderId: String,
    providerTransactionId: String,
    checkoutReferenceProtected: String,
    checkoutUrl: String,
    expiresAt: { type: Date, required: true, index: true },
    webhookEvents: { type: [webhookEventSchema], default: [] },
    failureCode: String,
    failureMessageSafe: String,
    paidAt: Date,
    failedAt: Date,
    expiredAt: Date,
    reservationReleased: { type: Boolean, default: false },
    reservationReleasedAt: Date,
  },
  { timestamps: true }
);

paymentAttemptSchema.index(
  { customer: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      customer: { $type: "objectId" },
      idempotencyKey: { $type: "string" },
    },
  }
);
paymentAttemptSchema.index(
  { idempotencyScope: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      customerType: "guest",
      idempotencyScope: { $type: "string" },
      idempotencyKey: { $type: "string" },
    },
  }
);
paymentAttemptSchema.index(
  { providerTransactionId: 1 },
  { unique: true, partialFilterExpression: { providerTransactionId: { $type: "string" } } }
);
paymentAttemptSchema.index({ "webhookEvents.providerEventId": 1 });
paymentAttemptSchema.index({ order: 1 });

const paymentAttemptModel = mongoose.model("paymentAttempts", paymentAttemptSchema);
module.exports = paymentAttemptModel;
