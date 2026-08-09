const productModel = require("../models/products");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const { isValidObjectId } = require("../utils/validation");
const { uploadFolderPath } = require("../utils/uploadPaths");
const { normalizeProductPayload } = require("../services/productNormalizationService");
const { serializeProduct } = require("../services/productSerializer");

const MAX_PAGE_LIMIT = 100;
const DEFAULT_CATALOG_LIMIT = 100;
const DEFAULT_CATEGORY_LIMIT = 16;
const MAX_SORT_ORDER = Number.MAX_SAFE_INTEGER;

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

  static parsePagination(query, defaultLimit = DEFAULT_CATALOG_LIMIT) {
    const hasPage = query.page !== undefined;
    const hasLimit = query.limit !== undefined;
    const rawPage = hasPage ? String(query.page).trim() : "1";
    const rawLimit = hasLimit ? String(query.limit).trim() : String(defaultLimit);
    if (!/^\d+$/.test(rawPage) || !/^\d+$/.test(rawLimit)) {
      throw Object.assign(new Error("page and limit must be positive whole numbers"), {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }
    const page = Number(rawPage);
    const limit = Number(rawLimit);
    if (!Number.isSafeInteger(page) || !Number.isSafeInteger(limit) || page < 1 || limit < 1 || limit > MAX_PAGE_LIMIT) {
      throw Object.assign(new Error(`page must be >= 1 and limit must be from 1 to ${MAX_PAGE_LIMIT}`), {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }
    return { page, limit };
  }

  static paginationMeta(page, limit, totalItems) {
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const currentPage = totalItems > 0
      ? Math.min(Math.max(page, 1), totalPages)
      : 1;
    return {
      currentPage,
      pageSize: limit,
      totalItems,
      totalPages,
      hasNextPage: currentPage < totalPages,
      hasPreviousPage: currentPage > 1,
      page: currentPage,
      limit,
      total: totalItems,
    };
  }

  static categoryOrderValue(product) {
    const rawOrder = Number(product && (product.pCategoryOrder ?? product.categoryOrder ?? product.displayOrder));
    return Number.isFinite(rawOrder) && rawOrder >= 1 ? rawOrder : MAX_SORT_ORDER;
  }

  static compareCategoryProducts(left, right) {
    const leftOrder = Product.categoryOrderValue(left);
    const rightOrder = Product.categoryOrderValue(right);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    const leftCreated = new Date(left && left.createdAt ? left.createdAt : 0).getTime();
    const rightCreated = new Date(right && right.createdAt ? right.createdAt : 0).getTime();
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;
    return String(left && left._id ? left._id : "").localeCompare(String(right && right._id ? right._id : ""));
  }

  static categoryOrderedSort() {
    return {
      __categoryOrder: 1,
      createdAt: 1,
      _id: 1,
    };
  }

  static categoryOrderStages() {
    return [
      {
        $addFields: {
          __categoryOrder: {
            $cond: [
              { $gt: ["$pCategoryOrder", 0] },
              "$pCategoryOrder",
              MAX_SORT_ORDER,
            ],
          },
        },
      },
    ];
  }

  static async queryProducts({ filter, page, limit, sort, categoryOrder = false }) {
    const stages = [{ $match: filter }];
    if (categoryOrder) stages.push(...Product.categoryOrderStages());
    stages.push({ $sort: categoryOrder ? Product.categoryOrderedSort() : sort });
    stages.push({
      $facet: {
        rows: [
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $lookup: {
              from: "categories",
              localField: "pCategory",
              foreignField: "_id",
              as: "pCategory",
            },
          },
          { $unwind: { path: "$pCategory", preserveNullAndEmptyArrays: true } },
          { $project: { __categoryOrder: 0 } },
        ],
        count: [{ $count: "total" }],
      },
    });
    const [result] = await productModel.aggregate(stages);
    const rows = result ? result.rows : [];
    const total = result && result.count[0] ? result.count[0].total : 0;
    return { rows, total };
  }

  static parseRetainedImages(value, currentImages) {
    if (value === undefined || value === null) {
      return { retained: currentImages, explicit: false, legacyCommaList: false };
    }
    const raw = String(value).trim();
    if (!raw) return { retained: [], explicit: true, legacyCommaList: false };
    let parsed;
    let legacyCommaList = false;
    if (raw.startsWith("[") || raw.startsWith("{")) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw Object.assign(new Error("pImages contains malformed JSON"), {
          status: 400,
          code: "VALIDATION_ERROR",
        });
      }
    } else {
      parsed = raw.split(",");
      legacyCommaList = true;
    }
    if (!Array.isArray(parsed)) {
      throw Object.assign(new Error("pImages must be an array"), { status: 400, code: "VALIDATION_ERROR" });
    }
    const currentSet = new Set(currentImages.map((image) => path.basename(String(image || ""))));
    const retained = [];
    for (const item of parsed) {
      const image = path.basename(String(item || "").replace(/\\/g, "/"));
      if (!image) continue;
      if (!currentSet.has(image)) {
        throw Object.assign(new Error("pImages contains an image not owned by this product"), {
          status: 400,
          code: "VALIDATION_ERROR",
        });
      }
      if (!retained.includes(image)) retained.push(image);
    }
    return { retained, explicit: true, legacyCommaList };
  }

  static productImageReferences(product) {
    const references = new Set((product && product.pImages || []).map((image) => path.basename(String(image || ""))).filter(Boolean));
    const colorImages = product && product.pColorImages && typeof product.pColorImages === "object" ? product.pColorImages : {};
    Object.values(colorImages).forEach((value) => {
      const fileName = value && typeof value === "object" ? value.fileName : value;
      const safeFileName = path.basename(String(fileName || ""));
      if (safeFileName) references.add(safeFileName);
    });
    return references;
  }

  static async deleteUnreferencedProductImages(imageNames, currentProductId) {
    const uniqueNames = [...new Set((imageNames || []).map((image) => path.basename(String(image || ""))).filter(Boolean))];
    if (!uniqueNames.length) return;
    const otherProducts = await productModel.find({ _id: { $ne: currentProductId } }).select("pImages pColorImages");
    const referencedElsewhere = new Set();
    otherProducts.forEach((product) => {
      Product.productImageReferences(product).forEach((image) => referencedElsewhere.add(image));
    });
    const safeToDelete = uniqueNames.filter((image) => !referencedElsewhere.has(image));
    Product.deleteImages(safeToDelete, "string");
  }

  static inferMainImageCount(body, files) {
    const colorMap = Product.parseColorImageBody(body.pColorImages);
    const indexes = Object.values(colorMap)
      .map((value) => value && Number.isInteger(value.uploadIndex) ? value.uploadIndex : null)
      .filter((value) => value !== null);
    if (!indexes.length) return files.length;
    return Math.max(0, Math.min(...indexes));
  }

  static mapUploadedColorFiles(body, files, currentProduct) {
    const colorMap = Product.parseColorImageBody(body.pColorImages);
    const byOriginalName = new Map(files.map((file, index) => [file.originalname, { file, index }]));
    const currentColorImages = currentProduct && currentProduct.pColorImages && typeof currentProduct.pColorImages === "object"
      ? currentProduct.pColorImages
      : {};
    const retainedColorFileNames = new Set(Object.values(currentColorImages).map((currentValue) => path.basename(String(
      currentValue && typeof currentValue === "object"
        ? currentValue.fileName || currentValue.image || currentValue.url || ""
        : currentValue || ""
    ).replace(/\\/g, "/"))).filter(Boolean));
    let changed = false;
    for (const [color, value] of Object.entries(colorMap)) {
      if (!value || typeof value !== "object" || Number.isInteger(value.uploadIndex)) continue;
      const currentValue = currentColorImages[color];
      const currentFileName = path.basename(String(
        currentValue && typeof currentValue === "object"
          ? currentValue.fileName || currentValue.image || currentValue.url || ""
          : currentValue || ""
      ).replace(/\\/g, "/"));
      const nextFileName = path.basename(String(value.fileName || value.image || value.url || "").replace(/\\/g, "/"));
      if (nextFileName && (nextFileName === currentFileName || retainedColorFileNames.has(nextFileName))) continue;
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
      price_asc: { pPrice: 1, createdAt: -1, _id: -1 },
      price_desc: { pPrice: -1, createdAt: -1, _id: -1 },
      newest: { createdAt: -1, _id: -1 },
      name_asc: { pName: 1, _id: -1 },
    };
    return sorts[sort] || { createdAt: -1, _id: -1 };
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

  static normalizeProductIdList(value) {
    if (!Array.isArray(value)) {
      throw Object.assign(new Error("productArray must be an array"), {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }
    const unique = [];
    const seen = new Set();
    for (const item of value) {
      const raw = typeof item === "object" && item !== null
        ? item.productId || item.id || item._id || item.product
        : item;
      const id = String(raw || "").trim();
      if (!id) continue;
      if (!isValidObjectId(id)) {
        throw Object.assign(new Error("product ids must be valid"), {
          status: 400,
          code: "VALIDATION_ERROR",
        });
      }
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(mongoose.Types.ObjectId(id));
      }
    }
    return unique.slice(0, config.maxCartItems);
  }

  static async cartRecommendationProducts(productIds, limit = 6) {
    const max = Math.min(Math.max(Number.parseInt(limit, 10) || 6, 1), 6);
    if (!productIds.length) return [];
    const excluded = new Set(productIds.map((id) => String(id)));
    const selected = [];
    const pushProduct = (product) => {
      if (!product) return;
      const id = String(product._id);
      if (excluded.has(id)) return;
      if (String(product.pStatus || "").toLowerCase() !== "active") return;
      if (Number(product.pQuantity || 0) <= 0) return;
      excluded.add(id);
      selected.push(product);
    };

    const cartProducts = await productModel
      .find({ _id: { $in: productIds } })
      .populate("relatedProducts", "_id pName pPrice pOffer pImages pCategory pBrand pStatus pQuantity pRecommended")
      .populate("pCategory", "_id cName")
      .sort({ _id: 1 });
    const cartOrder = new Map(productIds.map((id, index) => [String(id), index]));
    cartProducts.sort((left, right) => (cartOrder.get(String(left._id)) || 0) - (cartOrder.get(String(right._id)) || 0));

    cartProducts.forEach((product) => {
      (product.relatedProducts || []).forEach(pushProduct);
    });
    if (selected.length >= max) return selected.slice(0, max);

    const categoryIds = [...new Set(cartProducts
      .map((product) => product.pCategory && (product.pCategory._id || product.pCategory))
      .filter(Boolean)
      .map((id) => String(id)))].map((id) => mongoose.Types.ObjectId(id));
    if (categoryIds.length) {
      const categoryProducts = await productModel
        .find({
          _id: { $nin: Array.from(excluded) },
          pCategory: { $in: categoryIds },
          pStatus: "Active",
          pQuantity: { $gt: 0 },
        })
        .populate("pCategory", "_id cName")
        .sort({ pCategoryOrder: 1, createdAt: -1, _id: -1 })
        .limit(max * 3);
      categoryProducts.forEach(pushProduct);
    }
    if (selected.length >= max) return selected.slice(0, max);

    const recommendedProducts = await productModel
      .find({
        _id: { $nin: Array.from(excluded) },
        pRecommended: true,
        pStatus: "Active",
        pQuantity: { $gt: 0 },
      })
      .populate("pCategory", "_id cName")
      .sort({ createdAt: -1, _id: -1 })
      .limit(max * 2);
    recommendedProducts.forEach(pushProduct);
    return selected.slice(0, max);
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
      const filter = Product.buildCatalogFilter(req.query, isAdmin);
      const useCategoryOrder = Boolean(req.query.category) && !req.query.sort;
      const hasPaginationQuery = req.query.page !== undefined || req.query.limit !== undefined;
      if (!hasPaginationQuery) {
        const rows = await Product.relationPopulate(productModel.find(filter)).exec();
        const orderedRows = useCategoryOrder
          ? rows.sort(Product.compareCategoryProducts)
          : rows.sort((left, right) => {
            const sort = Product.catalogSort(req.query.sort);
            const [field, direction] = Object.entries(sort)[0] || ["createdAt", -1];
            const leftValue = left ? left[field] : undefined;
            const rightValue = right ? right[field] : undefined;
            if (leftValue === rightValue) {
              const leftCreated = new Date(left && left.createdAt ? left.createdAt : 0).getTime();
              const rightCreated = new Date(right && right.createdAt ? right.createdAt : 0).getTime();
              if (leftCreated !== rightCreated) return leftCreated - rightCreated;
              return String(left && left._id ? left._id : "").localeCompare(String(right && right._id ? right._id : ""));
            }
            if (leftValue > rightValue) return direction;
            if (leftValue < rightValue) return -direction;
            return 0;
          });
        return res.json({
          Products: orderedRows.map((product) => serializeProduct(product, { admin: isAdmin })),
          pagination: Product.paginationMeta(1, orderedRows.length || 1, orderedRows.length),
        });
      }
      const { page, limit } = Product.parsePagination(req.query, DEFAULT_CATALOG_LIMIT);
      const { rows, total } = await Product.queryProducts({
        filter,
        page,
        limit,
        sort: Product.catalogSort(req.query.sort),
        categoryOrder: useCategoryOrder,
      });
      return res.json({
        Products: rows.map((product) => serializeProduct(product, { admin: isAdmin })),
        pagination: Product.paginationMeta(page, limit, total),
      });
    } catch (err) {
      return Product.sendProductError(res, err);
    }
  }

  async postAddProduct(req, res, next) {
    const { pName, pDescription, pPrice, pQuantity, pCategory, pOffer, pStatus, pCategoryOrder } =
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
      const createdProduct = await productModel.create({
        pImages: allImages,
        pName,
        pDescription,
        pPrice: Number(pPrice),
        pQuantity: Number(pQuantity),
        pCategory,
        pOffer,
        pStatus,
        pCategoryOrder: extraData.pCategoryOrder,
        ...extraData,
      });
      const populated = await productModel.findById(createdProduct._id).populate("pCategory", "_id cName");
      return res.json({ success: "Product created successfully", Product: serializeProduct(populated, { admin: true }) });
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
      pCategoryOrder,
      pImages,
    } = req.body;
    const editImages = req.files || [];

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
    let currentProduct;
    let retainedInfo;
    try {
      currentProduct = await productModel.findById(pId);
      if (!currentProduct) {
        Product.deleteImages(editImages, "file");
        return res.status(404).json({ error: "Product not found" });
      }
      Product.mapUploadedColorFiles(req.body, editImages, currentProduct);
      retainedInfo = Product.parseRetainedImages(pImages, currentProduct.pImages || []);
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
      pCategoryOrder: extraData.pCategoryOrder,
      ...extraData,
      updatedAt: Date.now(),
    };
    const colorUploadIndexes = Product.colorUploadIndexes(req.body);
    const mainUploadedImages = editImages
      .map((img, index) => ({ img, index }))
      .filter(({ index }) => !colorUploadIndexes.has(index))
      .map(({ img }) => img.filename);
    if (retainedInfo.explicit && retainedInfo.legacyCommaList && mainUploadedImages.length >= 2 && colorUploadIndexes.size === 0) {
      editData.pImages = mainUploadedImages;
    } else if (retainedInfo.explicit || mainUploadedImages.length) {
      editData.pImages = [...retainedInfo.retained, ...mainUploadedImages];
    }
    if (editData.pImages && editData.pImages.length < 1) {
      Product.deleteImages(editImages, "file");
      return res.status(400).json({ error: "Product must have at least one image" });
    }

    try {
      const editProduct = await productModel
        .findByIdAndUpdate(pId, editData, { new: true, runValidators: true })
        .populate("pCategory", "_id cName");
      if (!editProduct) {
        Product.deleteImages(editImages, "file");
        return res.status(404).json({ error: "Product not found" });
      }
      const previousReferences = Product.productImageReferences(currentProduct);
      const currentReferences = Product.productImageReferences(editProduct);
      const removedImages = [...previousReferences].filter((image) => !currentReferences.has(image));
      await Product.deleteUnreferencedProductImages(removedImages, editProduct._id);
      return res.json({ success: "Product edit successfully", Product: serializeProduct(editProduct, { admin: true }) });
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
      const { page, limit } = Product.parsePagination({ ...req.query, ...req.body }, DEFAULT_CATEGORY_LIMIT);
      if (!isValidObjectId(catId)) {
        return res.status(400).json({ error: "catId must be a valid id" });
      }

      const { rows, total } = await Product.queryProducts({
        filter: { pCategory: mongoose.Types.ObjectId(catId), pStatus: "Active" },
        page,
        limit,
        categoryOrder: true,
      });
      return res.json({
        Products: rows.map((product) => serializeProduct(product)),
        pagination: Product.paginationMeta(page, limit, total),
      });
    } catch (err) {
      return next(err);
    }
  }

  async getRecommendedProducts(req, res, next) {
    try {
      const { page, limit } = Product.parsePagination(req.query, DEFAULT_CATEGORY_LIMIT);
      const filter = { pRecommended: true, pStatus: "Active", pQuantity: { $gt: 0 } };
      const { rows, total } = await Product.queryProducts({
        filter,
        page,
        limit,
        sort: { createdAt: -1, _id: -1 },
      });
      return res.json({
        Products: rows.map((product) => serializeProduct(product)),
        pagination: Product.paginationMeta(page, limit, total),
      });
    } catch (err) {
      return Product.sendProductError(res, err);
    }
  }

  async postToggleRecommended(req, res, next) {
    try {
      const { pId } = req.body;
      if (!isValidObjectId(pId)) {
        return res.status(400).json({ success: false, code: "VALIDATION_ERROR", error: "pId must be a valid id" });
      }
      const update = {};
      if (req.body.recommended === undefined) {
        const current = await productModel.findById(pId).select("pRecommended");
        if (!current) return res.status(404).json({ success: false, code: "NOT_FOUND", error: "Product not found" });
        update.pRecommended = !current.pRecommended;
      } else {
        update.pRecommended = req.body.recommended === true || req.body.recommended === "true";
      }
      const product = await productModel
        .findByIdAndUpdate(pId, update, { new: true, runValidators: true })
        .populate("pCategory", "_id cName");
      if (!product) {
        return res.status(404).json({ success: false, code: "NOT_FOUND", error: "Product not found" });
      }
      return res.json({ success: true, Product: serializeProduct(product, { admin: true }) });
    } catch (err) {
      return Product.sendProductError(res, err);
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

  async getCartRecommendations(req, res, next) {
    try {
      const productIds = Product.normalizeProductIdList(req.body.productArray || req.body.productIds || req.body.cartItems || []);
      const limit = req.body.limit;
      const products = await Product.cartRecommendationProducts(productIds, limit);
      return res.json({
        success: true,
        Products: products.map((product) => serializeProduct(product)),
      });
    } catch (err) {
      return Product.sendProductError(res, err);
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
