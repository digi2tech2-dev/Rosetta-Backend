const cartService = require("../services/cartService");

function sendError(res, err) {
  return res.status(err.status || 500).json({
    success: false,
    code: err.code || "INTERNAL_ERROR",
    error: err.message || "Unable to process cart request",
  });
}

class CartController {
  async getCart(req, res) {
    try {
      const cart = await cartService.getCartForUser(req.auth.userId);
      return res.json({ success: true, cart });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async addItem(req, res) {
    try {
      const cart = await cartService.addItem(
        req.auth.userId,
        req.body.productId,
        req.body.quantity,
        {
          selectedColor: req.body.selectedColor,
          selectedSize: req.body.selectedSize,
        }
      );
      return res.status(201).json({ success: true, cart });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async updateItem(req, res) {
    try {
      const cart = await cartService.updateItem(
        req.auth.userId,
        req.params.productId,
        req.body.quantity,
        {
          selectedColor: req.body.selectedColor,
          selectedSize: req.body.selectedSize,
        }
      );
      return res.json({ success: true, cart });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async removeItem(req, res) {
    try {
      const selectedColor = req.query.selectedColor ?? req.body.selectedColor;
      const selectedSize = req.query.selectedSize ?? req.body.selectedSize;
      const cart = await cartService.removeItem(req.auth.userId, req.params.productId, {
        selectedColor,
        selectedSize,
      });
      return res.json({ success: true, cart });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async clearCart(req, res) {
    try {
      const cart = await cartService.clearCart(req.auth.userId);
      return res.json({ success: true, cart });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async sync(req, res) {
    try {
      const result = await cartService.syncGuestCart(req.auth.userId, req.body.items);
      return res.json({ success: true, cart: result.cart, warnings: result.warnings });
    } catch (err) {
      return sendError(res, err);
    }
  }
}

module.exports = new CartController();
