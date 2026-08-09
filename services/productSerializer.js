function asObject(doc) {
  return doc && doc.toObject ? doc.toObject() : doc;
}

function summarizeProduct(product, options = {}) {
  const doc = asObject(product);
  if (!doc) return null;
  if (!options.admin && doc.pStatus && String(doc.pStatus).toLowerCase() !== "active") {
    return null;
  }
  return {
    _id: String(doc._id),
    pName: doc.pName,
    pPrice: doc.pPrice,
    pOffer: doc.pOffer,
    pImages: doc.pImages || [],
    pCategory: doc.pCategory,
    pBrand: doc.pBrand || null,
  };
}

function serializeProduct(product, options = {}) {
  const doc = asObject(product);
  if (!doc) return null;
  const includeAdmin = Boolean(options.admin);
  const response = {
    _id: String(doc._id),
    pName: doc.pName,
    pDescription: doc.pDescription,
    pPrice: doc.pPrice,
    pSold: doc.pSold || 0,
    pQuantity: doc.pQuantity || 0,
    pCategory: doc.pCategory,
    pImages: doc.pImages || [],
    pOffer: doc.pOffer,
    pRatingsReviews: doc.pRatingsReviews || [],
    pStatus: doc.pStatus,
    pBarcode: includeAdmin ? doc.pBarcode || null : undefined,
    pBrand: doc.pBrand || null,
    pVideo: doc.pVideo || null,
    pColors: doc.pColors || [],
    pSizes: doc.pSizes || [],
    pColorImages: doc.pColorImages || {},
    pCategoryOrder: doc.pCategoryOrder === undefined ? null : doc.pCategoryOrder,
    pRecommended: Boolean(doc.pRecommended),
    inventoryMode: doc.inventoryMode || "simple",
    relatedProducts: (doc.relatedProducts || []).map((product) => summarizeProduct(product, { admin: includeAdmin })).filter(Boolean),
    similarProducts: (doc.similarProducts || []).map((product) => summarizeProduct(product, { admin: includeAdmin })).filter(Boolean),
    suggestedProducts: (doc.suggestedProducts || []).map((product) => summarizeProduct(product, { admin: includeAdmin })).filter(Boolean),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };

  if (includeAdmin) {
    response.pCost = doc.pCost === undefined ? null : doc.pCost;
    response.pMerchantName = doc.pMerchantName || null;
  }

  Object.keys(response).forEach((key) => response[key] === undefined && delete response[key]);
  return response;
}

module.exports = {
  serializeProduct,
  summarizeProduct,
};
