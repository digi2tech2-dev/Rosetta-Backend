const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

// This is deliberately a catalog, rather than a frontend enum: prices and labels
// are resolved on the server and copied into each order at purchase time.
const packagingOptionSchema = new mongoose.Schema(
  {
    nameAr: { type: String, required: true, trim: true, maxlength: 120 },
    nameEn: { type: String, required: true, trim: true, maxlength: 120 },
    descriptionAr: { type: String, default: "", trim: true, maxlength: 300 },
    descriptionEn: { type: String, default: "", trim: true, maxlength: 300 },
    image: { type: String, default: "", trim: true, maxlength: 500 },
    price: { type: Number, required: true, min: 0 },
    active: { type: Boolean, default: true },
    displayOrder: { type: Number, default: 0 },
    isDefault: { type: Boolean, default: false },
    createdBy: { type: ObjectId, ref: "users", default: null },
    updatedBy: { type: ObjectId, ref: "users", default: null },
  },
  { timestamps: true }
);

packagingOptionSchema.index({ active: 1, displayOrder: 1, createdAt: 1 });
packagingOptionSchema.index({ isDefault: 1 });

module.exports = mongoose.model("packagingOptions", packagingOptionSchema);
