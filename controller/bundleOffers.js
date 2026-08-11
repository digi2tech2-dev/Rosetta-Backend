const bundleOfferService = require("../services/bundleOfferService");

function sendError(res, err) {
  return res.status(err.status || 500).json({
    success: false,
    code: err.code || "INTERNAL_ERROR",
    error: err.message || "Unable to process bundle offer request",
  });
}

class BundleOffersController {
  async listAdmin(req, res) {
    try {
      const offers = await bundleOfferService.listBundleOffers(req.query || {});
      return res.json({ success: true, offers });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async createAdmin(req, res) {
    try {
      const offer = await bundleOfferService.createBundleOffer(req.body || {}, req.auth.userId);
      return res.status(201).json({ success: true, offer });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async updateAdmin(req, res) {
    try {
      const offer = await bundleOfferService.updateBundleOffer(
        req.params.offerId,
        req.body || {},
        req.auth.userId
      );
      return res.json({ success: true, offer });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async deleteAdmin(req, res) {
    try {
      const deletedOffer = await bundleOfferService.deleteBundleOffer(req.params.offerId);
      return res.json({ success: true, deletedOffer });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async getByProduct(req, res) {
    try {
      const offer = await bundleOfferService.getPublicOfferByProduct(req.params.productId);
      return res.json({ success: true, offer });
    } catch (err) {
      return sendError(res, err);
    }
  }
}

module.exports = new BundleOffersController();
