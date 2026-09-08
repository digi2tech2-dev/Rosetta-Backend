const mongoose = require("mongoose");

const notificationDispatcherLeaseSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    ownerToken: { type: String, default: null, select: false },
    acquiredAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null, index: true },
    lastAttemptAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("notificationDispatcherLease", notificationDispatcherLeaseSchema);
