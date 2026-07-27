const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const orderItemSnapshotSchema = new mongoose.Schema(
  {
    product: { type: ObjectId, ref: "products", required: true },
    name: { type: String, required: true },
    image: { type: String },
    unitPrice: { type: Number, required: true },
    quantity: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
  },
  { _id: false }
);

const shippingAddressSchema = new mongoose.Schema(
  {
    fullName: String,
    phone: String,
    city: String,
    area: String,
    street: String,
    building: String,
    apartment: String,
    postalCode: String,
    notes: String,
  },
  { _id: false }
);

const statusHistorySchema = new mongoose.Schema(
  {
    status: String,
    paymentStatus: String,
    changedBy: { type: ObjectId, ref: "users" },
    changedAt: { type: Date, default: Date.now },
    note: String,
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    allProduct: [
      {
        id: { type: ObjectId, ref: "products" },
        quantitiy: Number,
      },
    ],
    user: {
      type: ObjectId,
      ref: "users",
      required: true,
    },
    amount: {
      type: Number,
    },
    transactionId: {
      type: String,
    },
    address: {
      type: String,
    },
    phone: {
      type: Number,
    },
    status: {
      type: String,
      default: "Not processed",
      enum: [
        "Not processed",
        "Processing",
        "Shipped",
        "Delivered",
        "Cancelled",
      ],
    },
    items: {
      type: [orderItemSnapshotSchema],
      default: undefined,
    },
    subtotal: Number,
    shippingFee: Number,
    total: Number,
    currency: {
      type: String,
      default: "USD",
    },
    shippingAddress: shippingAddressSchema,
    paymentMethod: {
      type: String,
      enum: ["cash_on_delivery", "legacy_braintree"],
    },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "paid", "refunded", "failed"],
    },
    orderStatus: {
      type: String,
      enum: ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"],
    },
    customerNote: String,
    idempotencyKey: String,
    idempotencyPayloadHash: String,
    inventoryApplied: {
      type: Boolean,
      default: false,
    },
    inventoryRestored: {
      type: Boolean,
      default: false,
    },
    statusHistory: {
      type: [statusHistorySchema],
      default: undefined,
    },
  },
  { timestamps: true }
);

orderSchema.index(
  { user: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  }
);

const orderModel = mongoose.model("orders", orderSchema);
module.exports = orderModel;
