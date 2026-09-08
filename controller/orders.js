const orderModel = require("../models/orders");
const { isValidObjectId } = require("../utils/validation");
const orderService = require("../services/orderService");
const { calculateAnalytics } = require("../services/analyticsService");
const { normalizeEgyptWhatsAppRecipient } = require("../utils/whatsappPhone");
const { enqueueAdminOrderConfirmation } = require("../services/orderNotificationService");

const disabledOrderResponse = {
  success: false,
  code: "LEGACY_ORDER_CREATION_DISABLED",
  message: "Order creation is temporarily unavailable while checkout security is being upgraded.",
};

class Order {
  sendServiceError(res, err) {
    return res.status(err.status || 500).json({
      success: false,
      code: err.code || "INTERNAL_ERROR",
      error: err.message || "Unable to process order request",
    });
  }

  async getAllOrders(req, res, next) {
    try {
      const Orders = await orderModel
        .find({})
        .populate("allProduct.id", "pName pImages pPrice pMerchantName")
        .populate("user", "name email")
        .sort({ _id: -1 });
      return res.json({ Orders: Orders.map((order) => orderService.normalizeOrder(order, { admin: true })) });
    } catch (err) {
      return next(err);
    }
  }

  async getOrderByUser(req, res, next) {
    try {
      let targetUserId = req.auth.userId;
      if (req.auth.role === 1 && req.body.uId) {
        targetUserId = req.body.uId;
      }
      if (!isValidObjectId(targetUserId)) {
        return res.status(400).json({ message: "uId must be a valid id" });
      }

      const Order = await orderModel
        .find({ user: targetUserId })
        .populate("allProduct.id", "pName pImages pPrice pMerchantName")
        .populate("user", "name email")
        .sort({ _id: -1 });
      return res.json({ Order: Order.map((order) => orderService.normalizeOrder(order, { admin: req.auth.role === 1 })) });
    } catch (err) {
      return next(err);
    }
  }

  async postCreateOrder(req, res) {
    return res.status(503).json(disabledOrderResponse);
  }

  async createCodOrder(req, res) {
    try {
      if (req.auth && Number(req.auth.role) !== 0) {
        throw Object.assign(new Error("Access denied"), { status: 403, code: "ACCESS_DENIED" });
      }
      const result = req.auth
        ? await orderService.createCodOrder(
            req.auth.userId,
            req.body,
            req.headers["idempotency-key"]
          )
        : await orderService.createGuestCodOrder(req.body, req.headers["idempotency-key"]);
      return res.status(result.reused ? 200 : 201).json({
        success: true,
        reused: result.reused,
        order: result.order,
        guestTracking: result.guestTracking || null,
      });
    } catch (err) {
      return this.sendServiceError(res, err);
    }
  }

  async trackGuestOrder(req, res) {
    try {
      const order = await orderService.getGuestOrderStatus(req.body || {});
      return res.json({ success: true, order });
    } catch (err) {
      return this.sendServiceError(res, err);
    }
  }

  async getMyOrders(req, res) {
    try {
      const result = await orderService.listMyOrders(req.auth.userId, req.query);
      return res.json({ success: true, orders: result.orders, pagination: result.pagination });
    } catch (err) {
      return res.status(err.status || 500).json({
        success: false,
        code: err.code || "INTERNAL_ERROR",
        error: err.message || "Unable to process order request",
      });
    }
  }

  async getMyOrder(req, res) {
    try {
      const order = await orderService.getMyOrder(req.auth.userId, req.params.orderId);
      return res.json({ success: true, order });
    } catch (err) {
      return this.sendServiceError(res, err);
    }
  }

  async getAdminOrders(req, res) {
    try {
      const result = await orderService.listAdminOrders(req.query);
      return res.json({ success: true, orders: result.orders, pagination: result.pagination });
    } catch (err) {
      return this.sendServiceError(res, err);
    }
  }

  async getAdminOrder(req, res) {
    try {
      const order = await orderService.getAdminOrder(req.params.orderId);
      return res.json({ success: true, order });
    } catch (err) {
      return this.sendServiceError(res, err);
    }
  }

  async getAdminAnalytics(req, res) {
    try {
      // Financial aggregation is deliberately server-authoritative. The
      // service uses only immutable order snapshots, never product catalog data.
      const orders = await orderModel.find({}).lean();
      return res.json(calculateAnalytics(orders, req.query));
    } catch (err) {
      return this.sendServiceError(res, err);
    }
  }

  async patchAdminOrderStatus(req, res) {
    try {
      const order = await orderService.updateStatus(
        req.params.orderId,
        req.body.orderStatus,
        req.auth.userId,
        { admin: true, restoreReturnedInventory: req.body.restoreReturnedInventory }
      );
      return res.json({ success: true, order });
    } catch (err) {
      return this.sendServiceError(res, err);
    }
  }

  async sendAdminWhatsappConfirmation(req, res) {
    const orderId = req.params.orderId;
    if (!isValidObjectId(orderId)) {
      return res.status(400).json({
        success: false,
        code: "VALIDATION_ERROR",
        error: "Order ID is invalid",
      });
    }

    try {
      const order = await orderModel.findById(orderId).lean();
      if (!order) {
        return res.status(404).json({
          success: false,
          code: "ORDER_NOT_FOUND",
          error: "Order not found",
        });
      }

      let recipient;
      try {
        recipient = normalizeEgyptWhatsAppRecipient(
          order.shippingAddress?.phone
          || order.phone
          || order.customerSnapshot?.phone
          || order.guestCustomer?.phone
        );
      } catch (err) {
        err.status = 400;
        throw err;
      }

      const queued = await enqueueAdminOrderConfirmation(order, { recipient });
      if (queued.skipped === "disabled") {
        throw Object.assign(new Error("OpenWA is disabled"), { status: 503, code: "OPENWA_DISABLED" });
      }
      if (queued.skipped) {
        throw Object.assign(new Error("Unable to queue WhatsApp confirmation"), { status: 503, code: "WHATSAPP_CONFIRMATION_QUEUE_FAILED" });
      }
      return res.status(queued.enqueued ? 202 : 200).json({
        success: true,
        queued: true,
        duplicate: Boolean(queued.duplicate),
        message: queued.duplicate
          ? "WhatsApp confirmation request is already queued for this order"
          : "WhatsApp confirmation request queued for sending",
      });
    } catch (err) {
      return this.sendServiceError(res, err);
    }
  }

  async postUpdateOrder(req, res, next) {
    try {
      const { oId, status, restoreReturnedInventory } = req.body;
      if (!isValidObjectId(oId) || !status) {
        return res.status(400).json({ message: "All filled must be required" });
      }

      const canonical = {
        "Not processed": "pending",
        Processing: "processing",
        Shipped: "shipped",
        Delivered: "delivered",
        Cancelled: "cancelled",
        Returned: "returned",
      }[status] || status;
      const order = await orderService.updateStatus(oId, canonical, req.auth.userId, { admin: true, restoreReturnedInventory });
      return res.json({ success: "Order updated successfully", order });
    } catch (err) {
      return this.sendServiceError(res, err);
    }
  }

  async postDeleteOrder(req, res, next) {
    try {
      const { oId } = req.body;
      if (!isValidObjectId(oId)) {
        return res.status(400).json({ error: "oId must be a valid id" });
      }

      const deleteOrder = await orderModel.findByIdAndDelete(oId);
      if (!deleteOrder) {
        return res.status(404).json({ error: "Order not found" });
      }
      return res.json({ success: "Order deleted successfully" });
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = {
  ordersController: new Order(),
  disabledOrderResponse,
};
