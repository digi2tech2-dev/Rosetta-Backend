const productModel = require("../models/products");
const fs = require("fs");
const path = require("path");
const { isValidObjectId } = require("../utils/validation");

class Product {
  static deleteImages(images, mode) {
    const basePath = path.resolve(__dirname, "..", "public", "uploads", "products");
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

  async getAllProduct(req, res, next) {
    try {
      const Products = await productModel
        .find({})
        .populate("pCategory", "_id cName")
        .sort({ _id: -1 });
      return res.json({ Products });
    } catch (err) {
      return next(err);
    }
  }

  async postAddProduct(req, res, next) {
    const { pName, pDescription, pPrice, pQuantity, pCategory, pOffer, pStatus } =
      req.body;
    const images = req.files || [];

    if (
      !pName ||
      !pDescription ||
      !pPrice ||
      !pQuantity ||
      !pCategory ||
      !pOffer ||
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
    if (images.length !== 2) {
      Product.deleteImages(images, "file");
      return res.status(400).json({ error: "Must need to provide 2 images" });
    }

    try {
      const allImages = images.map((img) => img.filename);
      await productModel.create({
        pImages: allImages,
        pName,
        pDescription,
        pPrice,
        pQuantity,
        pCategory,
        pOffer,
        pStatus,
      });
      return res.json({ success: "Product created successfully" });
    } catch (err) {
      Product.deleteImages(images, "file");
      return next(err);
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

    if (
      !pId ||
      !pName ||
      !pDescription ||
      !pPrice ||
      !pQuantity ||
      !pCategory ||
      !pOffer ||
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
    if (editImages.length === 1) {
      Product.deleteImages(editImages, "file");
      return res.status(400).json({ error: "Must need to provide 2 images" });
    }

    const editData = {
      pName,
      pDescription,
      pPrice,
      pQuantity,
      pCategory,
      pOffer,
      pStatus,
      updatedAt: Date.now(),
    };
    if (editImages.length === 2) {
      editData.pImages = editImages.map((img) => img.filename);
    }

    try {
      const editProduct = await productModel.findByIdAndUpdate(pId, editData);
      if (!editProduct) {
        Product.deleteImages(editImages, "file");
        return res.status(404).json({ error: "Product not found" });
      }
      if (editImages.length === 2 && pImages) {
        Product.deleteImages(String(pImages).split(","), "string");
      }
      return res.json({ success: "Product edit successfully" });
    } catch (err) {
      Product.deleteImages(editImages, "file");
      return next(err);
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
        .populate("pRatingsReviews.user", "name email userImage");
      if (!singleProduct) {
        return res.status(404).json({ error: "Product not found" });
      }
      return res.json({ Product: singleProduct });
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
        .find({ pCategory: catId })
        .populate("pCategory", "cName");
      return res.json({ Products });
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
        .find({ pPrice: { $lt: price } })
        .populate("pCategory", "cName")
        .sort({ pPrice: -1 });
      return res.json({ Products });
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
      const Products = await productModel.find({ _id: { $in: productArray } });
      return res.json({ Products });
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
      const Products = await productModel.find({ _id: { $in: productArray } });
      return res.json({ Products });
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
