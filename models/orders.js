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
    selectedColor: { type: String, default: null },
    selectedSize: { type: String, default: null },
    bundleOfferId: { type: String, default: null },
    bundleGroupId: { type: String, default: null },
    bundleRole: {
      type: String,
      enum: ["primary", "additional", null],
      default: null,
    },
    merchantName: { type: String, default: null },
  },
  { _id: false }
);

const customerSnapshotSchema = new mongoose.Schema(
  {
    fullName: String,
    email: String,
    phone: String,
  },
  { _id: false }
);

const shippingAddressSchema = new mongoose.Schema(
  {
    fullName: String,
    phone: String,
    alternatePhone: String,
    governorate: String,
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

const guestCustomerSchema = new mongoose.Schema(
  {
    fullName: String,
    email: String,
    phone: String,
    normalizedEmail: { type: String, select: false },
    normalizedPhone: { type: String, select: false },
  },
  { _id: false }
);

const couponSnapshotSchema = new mongoose.Schema(
  {
    couponId: String,
    code: String,
    type: String,
    value: Number,
    calculatedDiscount: Number,
  },
  { _id: false }
);

const firstOrderPromotionSnapshotSchema = new mongoose.Schema(
  {
    type: String,
    value: Number,
    calculatedDiscount: Number,
  },
  { _id: false }
);

const shippingSnapshotSchema = new mongoose.Schema(
  {
    ruleId: String,
    name: String,
    governorate: String,
    city: String,
    originalFee: Number,
    baseFee: Number,
    quantityDiscountPercent: Number,
    quantityDiscountAmount: Number,
    chargedFee: Number,
    finalFee: Number,
    freeShippingApplied: Boolean,
    thresholdFreeShippingApplied: Boolean,
    quantityPromotionApplied: Boolean,
    totalQuantity: Number,
    nextQuantityThreshold: Number,
    quantityNeededForNextThreshold: Number,
  },
  { _id: false }
);

const bundleSnapshotSchema = new mongoose.Schema(
  {
    bundleOfferId: String,
    bundleGroupId: String,
    primaryProductId: String,
    additionalProductId: String,
    quantity: Number,
    regularSubtotal: Number,
    bundleSubtotal: Number,
    bundleDiscount: Number,
    bundlePrice: Number,
    regularTotal: Number,
    memberProducts: [
      {
        productId: String,
        name: String,
        unitPrice: Number,
        quantity: Number,
        selectedColor: { type: String, default: null },
        selectedSize: { type: String, default: null },
        bundleRole: String,
      },
    ],
  },
  { _id: false }
);

const pricingSnapshotSchema = new mongoose.Schema(
  {
    currency: String,
    totalQuantity: Number,
    normalSubtotal: Number,
    merchandiseSubtotal: Number,
    bundleDiscountTotal: {
      type: Number,
      default: 0,
    },
    discountTotal: Number,
    shippingFee: Number,
    grandTotal: Number,
    discountSource: {
      type: String,
      enum: ["none", "coupon", "first_order"],
      default: "none",
    },
    couponSnapshot: { type: couponSnapshotSchema, default: null },
    firstOrderPromotionSnapshot: { type: firstOrderPromotionSnapshotSchema, default: null },
    bundleSnapshots: {
      type: [bundleSnapshotSchema],
      default: [],
    },
    shippingSnapshot: { type: shippingSnapshotSchema, default: null },
    pricingVersion: String,
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
      required: function () {
        return this.customerType !== "guest";
      },
    },
    customerType: {
      type: String,
      enum: ["registered", "guest"],
      default: "registered",
      index: true,
    },
    guestCustomer: {
      type: guestCustomerSchema,
      default: null,
    },
    customerSnapshot: {
      type: customerSnapshotSchema,
      default: null,
    },
    guestTrackingTokenHash: {
      type: String,
      select: false,
      default: null,
    },
    guestTrackingTokenCreatedAt: Date,
    orderNumber: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
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
    discountTotal: Number,
    discountSource: {
      type: String,
      enum: ["none", "coupon", "first_order"],
      default: "none",
    },
    total: Number,
    currency: {
      type: String,
      default: "USD",
    },
    shippingAddress: shippingAddressSchema,
    paymentMethod: {
      type: String,
      enum: ["cash_on_delivery", "legacy_braintree", "paymob_card", "paymob_wallet"],
    },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "pending", "paid", "refunded", "failed", "expired", "cancelled", "manual_review"],
    },
    paymentProvider: {
      type: String,
      enum: ["paymob", null],
      default: null,
    },
    paymentAttempt: { type: ObjectId, ref: "paymentAttempts", default: null },
    providerTransactionId: String,
    paymentExpiresAt: Date,
    orderStatus: {
      type: String,
      enum: ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"],
    },
    customerNote: String,
    coupon: { type: ObjectId, ref: "coupons", default: null },
    couponCode: String,
    couponRedemption: { type: ObjectId, ref: "couponRedemptions", default: null },
    pricingSnapshot: pricingSnapshotSchema,
    idempotencyKey: String,
    idempotencyScope: String,
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
    partialFilterExpression: {
      user: { $type: "objectId" },
      idempotencyKey: { $type: "string" },
    },
  }
);
orderSchema.index(
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

const orderModel = mongoose.model("orders", orderSchema);
module.exports = orderModel;
