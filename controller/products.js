const productModel = require("../models/products");
const fs = require("fs");
const path = require("path");
const { isValidObjectId } = require("../utils/validation");
const { uploadFolderPath } = require("../utils/uploadPaths");
const { normalizeProductPayload } = require("../services/productNormalizationService");
const { serializeProduct } = require("../services/productSerializer");

class Product {
  static deleteImages(images, mode) {
    const basePath = uploadFolderPath("products");
    const imageList = Array.isArray(images) ? images : [];

    for (let i = 0; i < imageList.length; i++) {
      const rawName = mode === "file" ? imageList[i].filename : imageList[i];
      const safeFileName = path.basename(String(rawName || ""));
      const filePath = path.join(basePath, safeFileName);

      if (!filePath.startsWith(basePath) || !safeFileName) {
        continue;
      }

      fs.unlink(filePath, () => {});
    }
  }

  static sendProductError(res, err) {
    const status = err.status || (err.code === 11000 ? 409 : 500);
    const code = err.code === 11000 ? "DUPLICATE_BARCODE" : err.code || "INTERNAL_ERROR";
    return res.status(status).json({
      success: false,
      code,
      error: code === "DUPLICATE_BARCODE" ? "Product barcode already exists" : err.message || "Product request failed",
    });
  }

  static isAdminRequest(req) {
    return req.auth && req.auth.role === 1;
  }

  static relationPopulate(query) {
    return query
      .populate("pCategory", "_id cName")
      .populate("relatedProducts", "_id pName pPrice pOffer pImages pCategory pBrand pStatus")
      .populate("similarProducts", "_id pName pPrice pOffer pImages pCategory pBrand pStatus")
      .populate("suggestedProducts", "_id pName pPrice pOffer pImages pCategory pBrand pStatus");
  }

  static parseColorImageBody(value) {
    if (!value) return {};
    if (typeof value === "object" && !Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  static inferMainImageCount(body, files) {
    const colorMap = Product.parseColorImageBody(body.pColorImages);
    const indexes = Object.values(colorMap)
      .map((value) => value && Number.isInteger(value.uploadIndex) ? value.uploadIndex : null)
      .filter((value) => value !== null);
    if (!indexes.length) return files.length;
    return Math.max(0, Math.min(...indexes));
  }

  static mapUploadedColorFiles(body, files) {
    const colorMap = Product.parseColorImageBody(body.pColorImages);
    const byOriginalName = new Map(files.map((file, index) => [file.originalname, { file, index }]));
    let changed = false;
    for (const [color, value] of Object.entries(colorMap)) {
      if (!value || typeof value !== "object" || Number.isInteger(value.uploadIndex)) continue;
      const match = byOriginalName.get(value.fileName);
      if (match) {
        colorMap[color] = { ...value, uploadIndex: match.index };
        changed = true;
      }
    }
    if (changed) body.pColorImages = JSON.stringify(colorMap);
  }

  static colorUploadIndexes(body) {
    const colorMap = Product.parseColorImageBody(body.pColorImages);
    return new Set(Object.values(colorMap)
      .map((value) => value && Number.isInteger(value.uploadIndex) ? value.uploadIndex : null)
      .filter((value) => value !== null));
  }

  static buildCatalogFilter(query, isAdmin) {
    const filter = {};
    if (!isAdmin) filter.pStatus = "Active";
    if (query.status && isAdmin) filter.pStatus = query.status;
    if (query.category) {
      if (!isValidObjectId(query.category)) {
        throw Object.assign(new Error("category must be a valid id"), { status: 400, code: "VALIDATION_ERROR" });
      }
      filter.pCategory = query.category;
    }
    if (query.brand) filter.pBrand = String(query.brand).trim();
    if (query.hasOffer !== undefined) {
      filter.pOffer = query.hasOffer === "true" || query.hasOffer === true
        ? { $nin: [null, "", "0", 0] }
        : { $in: [null, "", "0", 0] };
    }
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      const min = query.minPrice === undefined ? 0 : Number(query.minPrice);
      const max = query.maxPrice === undefined ? Number.MAX_SAFE_INTEGER : Number(query.maxPrice);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
        throw Object.assign(new Error("Invalid price range"), { status: 400, code: "VALIDATION_ERROR" });
      }
      filter.pPrice = { $gte: min, $lte: max };
    }
    if (query.q) {
      const escaped = String(query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (escaped) {
        filter.$or = [
          { pName: new RegExp(escaped, "i") },
          { pDescription: new RegExp(escaped, "i") },
          { pBrand: new RegExp(escaped, "i") },
        ];
      }
    }
    return filter;
  }

  static catalogSort(sort) {
    const sorts = {
      price_asc: { pPrice: 1, _id: -1 },
      price_desc: { pPrice: -1, _id: -1 },
      newest: { createdAt: -1, _id: -1 },
      name_asc: { pName: 1, _id: -1 },
    };
    return sorts[sort] || { _id: -1 };
  }

  static async fillRecommendations(serialized, sourceProduct) {
    const productId = String(sourceProduct._id);
    const categoryId = sourceProduct.pCategory && sourceProduct.pCategory._id
      ? sourceProduct.pCategory._id
      : sourceProduct.pCategory;
    if (!serialized.similarProducts.length) {
      const sourcePrice = Number(sourceProduct.pPrice) || 0;
      const filter = {
        _id: { $ne: sourceProduct._id },
        pStatus: "Active",
      };
      if (categoryId) filter.pCategory = categoryId;
      const similar = await productModel
        .find(filter)
        .sort({ _id: -1 })
        .limit(40)
        .populate("pCategory", "_id cName");
      serialized.similarProducts = similar
        .filter((product) => String(product._id) !== productId)
        .sort((a, b) => {
          const brandA = sourceProduct.pBrand && a.pBrand === sourceProduct.pBrand ? 0 : 1;
          const brandB = sourceProduct.pBrand && b.pBrand === sourceProduct.pBrand ? 0 : 1;
          if (brandA !== brandB) return brandA - brandB;
          return Math.abs((Number(a.pPrice) || 0) - sourcePrice) - Math.abs((Number(b.pPrice) || 0) - sourcePrice);
        })
        .slice(0, 8)
        .map((product) => serializeProduct(product));
    }
    if (!serialized.suggestedProducts.length) {
      const excluded = new Set([productId, ...serialized.similarProducts.map((product) => String(product._id))]);
      const filter = {
        _id: { $nin: Array.from(excluded) },
        pStatus: "Active",
      };
      if (categoryId) filter.pCategory = categoryId;
      const suggested = await productModel
        .find(filter)
        .sort({ _id: -1 })
        .limit(8)
        .populate("pCategory", "_id cName");
      serialized.suggestedProducts = suggested.map((product) => serializeProduct(product));
    }
    return serialized;
  }

  static async validateRelations(extraData) {
    const relationFields = ["relatedProducts", "similarProducts", "suggestedProducts"];
    const ids = new Set();
    for (const field of relationFields) {
      for (const id of extraData[field] || []) {
        ids.add(String(id));
      }
    }
    if (!ids.size) return;
    const found = await productModel.countDocuments({ _id: { $in: Array.from(ids) } });
    if (found !== ids.size) {
      throw Object.assign(new Error("Product relationships contain missing products"), {
        status: 400,
        code: "INVALID_RELATED_PRODUCT",
      });
    }
  }

  static async validateUniqueBarcode(pBarcode, currentProductId) {
    if (!pBarcode) return;
    const filter = { pBarcode };
    if (currentProductId) filter._id = { $ne: currentProductId };
    const existing = await productModel.exists(filter);
    if (existing) {
      throw Object.assign(new Error("Product barcode already exists"), {
        status: 409,
        code: "DUPLICATE_BARCODE",
      });
    }
  }

  async getAllProduct(req, res, next) {
    try {
      const isAdmin = Product.isAdminRequest(req);
      const page = Math.max(Number.parseInt(req.query.page || "1", 10) || 1, 1);
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit || "100", 10) || 100, 1), 100);
      const filter = Product.buildCatalogFilter(req.query, isAdmin);
      const Products = await productModel
        .find(filter)
        .populate("pCategory", "_id cName")
        .sort(Product.catalogSort(req.query.sort))
        .skip((page - 1) * limit)
        .limit(limit);
      const total = await productModel.countDocuments(filter);
      return res.json({
        Products: Products.map((product) => serializeProduct(product, { admin: isAdmin })),
        pagination: { page, limit, total },
      });
    } catch (err) {
      return Product.sendProductError(res, err);
    }
  }

  async postAddProduct(req, res, next) {
    const { pName, pDescription, pPrice, pQuantity, pCategory, pOffer, pStatus } =
      req.body;
    const images = req.files || [];

    if (
      !pName ||
      !pDescription ||
      pPrice === undefined ||
      pPrice === "" ||
      pQuantity === undefined ||
      pQuantity === "" ||
      !pCategory ||
      pOffer === undefined ||
      pOffer === "" ||
      !pStatus
    ) {
      Product.deleteImages(images, "file");
      return res.status(400).json({ error: "All filled must be required" });
    }
    if (!isValidObjectId(pCategory)) {
      Product.deleteImages(images, "file");
      return res.status(400).json({ error: "pCategory must be a valid id" });
    }
    if (pName.length > 255 || pDescription.length > 3000) {
      Product.deleteImages(images, "file");
      return res.status(400).json({
        error: "Name 255 & Description must not be 3000 charecter long",
      });
    }
    if (images.length < 2) {
      Product.deleteImages(images, "file");
      return res.status(400).json({ error: "Must need to provide at least 2 images" });
    }

    try {
      const mainImageCount = Product.inferMainImageCount(req.body, images);
      const allImages = images.map((img) => img.filename);
      const extraData = normalizeProductPayload(req.body, {
        files: images,
        mainImageCount,
      });
      await Product.validateRelations(extraData);
      await Product.validateUniqueBarcode(extraData.pBarcode);
      await productModel.create({
        pImages: allImages,
        pName,
        pDescription,
        pPrice: Number(pPrice),
        pQuantity: Number(pQuantity),
        pCategory,
        pOffer,
        pStatus,
        ...extraData,
      });
      return res.json({ success: "Product created successfully" });
    } catch (err) {
      Product.deleteImages(images, "file");
      return Product.sendProductError(res, err);
    }
  }

  async postEditProduct(req, res, next) {
    const {
      pId,
      pName,
      pDescription,
      pPrice,
      pQuantity,
      pCategory,
      pOffer,
      pStatus,
      pImages,
    } = req.body;
    const editImages = req.files || [];
    Product.mapUploadedColorFiles(req.body, editImages);

    if (
      !pId ||
      !pName ||
      !pDescription ||
      pPrice === undefined ||
      pPrice === "" ||
      pQuantity === undefined ||
      pQuantity === "" ||
      !pCategory ||
      pOffer === undefined ||
      pOffer === "" ||
      !pStatus
    ) {
      Product.deleteImages(editImages, "file");
      return res.status(400).json({ error: "All filled must be required" });
    }
    if (!isValidObjectId(pId) || !isValidObjectId(pCategory)) {
      Product.deleteImages(editImages, "file");
      return res.status(400).json({ error: "pId and pCategory must be valid ids" });
    }
    if (pName.length > 255 || pDescription.length > 3000) {
      Product.deleteImages(editImages, "file");
      return res.status(400).json({
        error: "Name 255 & Description must not be 3000 charecter long",
      });
    }
    if (editImages.length === 1 && !req.body.pColorImages) {
      Product.deleteImages(editImages, "file");
      return res.status(400).json({ error: "Must need to provide 2 images" });
    }

    let extraData;
    try {
      extraData = normalizeProductPayload(req.body, {
        currentProductId: pId,
        files: editImages,
        mainImageCount: 0,
      });
      await Product.validateRelations(extraData);
      await Product.validateUniqueBarcode(extraData.pBarcode, pId);
    } catch (err) {
      Product.deleteImages(editImages, "file");
      return Product.sendProductError(res, err);
    }

    const editData = {
      pName,
      pDescription,
      pPrice: Number(pPrice),
      pQuantity: Number(pQuantity),
      pCategory,
      pOffer,
      pStatus,
      ...extraData,
      updatedAt: Date.now(),
    };
    const colorUploadIndexes = Product.colorUploadIndexes(req.body);
    if (editImages.length >= 2 && colorUploadIndexes.size === 0) {
      editData.pImages = editImages.map((img) => img.filename);
    }

    try {
      const editProduct = await productModel.findByIdAndUpdate(pId, editData);
      if (!editProduct) {
        Product.deleteImages(editImages, "file");
        return res.status(404).json({ error: "Product not found" });
      }
      if (editData.pImages && pImages) {
        Product.deleteImages(String(pImages).split(","), "string");
      }
      return res.json({ success: "Product edit successfully" });
    } catch (err) {
      Product.deleteImages(editImages, "file");
      return Product.sendProductError(res, err);
    }
  }

  async getDeleteProduct(req, res, next) {
    try {
      const { pId } = req.body;
      if (!isValidObjectId(pId)) {
        return res.status(400).json({ error: "pId must be a valid id" });
      }

      const deleteProduct = await productModel.findByIdAndDelete(pId);
      if (!deleteProduct) {
        return res.status(404).json({ error: "Product not found" });
      }
      Product.deleteImages(deleteProduct.pImages, "string");
      return res.json({ success: "Product deleted successfully" });
    } catch (err) {
      return next(err);
    }
  }

  async getSingleProduct(req, res, next) {
    try {
      const { pId } = req.body;
      if (!isValidObjectId(pId)) {
        return res.status(400).json({ error: "pId must be a valid id" });
      }

      const singleProduct = await productModel
        .findById(pId)
        .populate("pCategory", "cName")
        .populate("relatedProducts", "_id pName pPrice pOffer pImages pCategory pBrand pStatus")
        .populate("similarProducts", "_id pName pPrice pOffer pImages pCategory pBrand pStatus")
        .populate("suggestedProducts", "_id pName pPrice pOffer pImages pCategory pBrand pStatus")
        .populate("pRatingsReviews.user", "name email userImage");
      if (!singleProduct) {
        return res.status(404).json({ error: "Product not found" });
      }
      const serialized = serializeProduct(singleProduct, { admin: Product.isAdminRequest(req) });
      return res.json({ Product: await Product.fillRecommendations(serialized, singleProduct) });
    } catch (err) {
      return next(err);
    }
  }

  async getProductByCategory(req, res, next) {
    try {
      const { catId } = req.body;
      if (!isValidObjectId(catId)) {
        return res.status(400).json({ error: "catId must be a valid id" });
      }

      const Products = await productModel
        .find({ pCategory: catId, pStatus: "Active" })
        .populate("pCategory", "cName");
      return res.json({ Products: Products.map((product) => serializeProduct(product)) });
    } catch (err) {
      return next(err);
    }
  }

  async getProductByPrice(req, res, next) {
    try {
      const { price } = req.body;
      if (!price) {
        return res.status(400).json({ error: "All filled must be required" });
      }

      const Products = await productModel
        .find({ pPrice: { $lt: price }, pStatus: "Active" })
        .populate("pCategory", "cName")
        .sort({ pPrice: -1 });
      return res.json({ Products: Products.map((product) => serializeProduct(product)) });
    } catch (err) {
      return next(err);
    }
  }

  async getWishProduct(req, res, next) {
    try {
      const { productArray } = req.body;
      if (!Array.isArray(productArray)) {
        return res.status(400).json({ error: "All filled must be required" });
      }
      const Products = await productModel.find({ _id: { $in: productArray }, pStatus: "Active" });
      return res.json({ Products: Products.map((product) => serializeProduct(product)) });
    } catch (err) {
      return next(err);
    }
  }

  async getCartProduct(req, res, next) {
    try {
      const { productArray } = req.body;
      if (!Array.isArray(productArray)) {
        return res.status(400).json({ error: "All filled must be required" });
      }
      const Products = await productModel.find({ _id: { $in: productArray }, pStatus: "Active" });
      return res.json({ Products: Products.map((product) => serializeProduct(product)) });
    } catch (err) {
      return next(err);
    }
  }

  async postAddReview(req, res, next) {
    try {
      const { pId, rating, review } = req.body;
      if (!isValidObjectId(pId) || !rating || !review) {
        return res.status(400).json({ error: "All filled must be required" });
      }

      const product = await productModel.findById(pId);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }

      const alreadyReviewed = product.pRatingsReviews.some(
        (item) => String(item.user) === String(req.auth.userId)
      );
      if (alreadyReviewed) {
        return res.status(409).json({ error: "Your already reviewd the product" });
      }

      product.pRatingsReviews.push({
        review,
        user: req.auth.userId,
        rating,
      });
      await product.save();
      return res.json({ success: "Thanks for your review" });
    } catch (err) {
      return next(err);
    }
  }

  async deleteReview(req, res, next) {
    try {
      const { rId, pId } = req.body;
      if (!isValidObjectId(rId) || !isValidObjectId(pId)) {
        return res.status(400).json({ message: "All filled must be required" });
      }

      const product = await productModel.findById(pId);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }

      const review = product.pRatingsReviews.id(rId);
      if (!review) {
        return res.status(404).json({ error: "Review not found" });
      }
      if (String(review.user) !== String(req.auth.userId) && req.auth.role !== 1) {
        return res.status(403).json({ error: "Access denied" });
      }

      review.remove();
      await product.save();
      return res.json({ success: "Your review is deleted" });
    } catch (err) {
      return next(err);
    }
  }
}

const productController = new Product();
module.exports = productController;
