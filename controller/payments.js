const paymentService = require("../services/payments/paymentService");

function sendError(res, err) {
  const status = err.status === 202 ? 202 : err.status || 500;
  return res.status(status).json({
    success: status === 202,
    code: err.code || "INTERNAL_ERROR",
    error: err.message || "Unable to process payment request",
  });
}

class PaymentsController {
  async createPaymobIntention(req, res) {
    try {
      if (req.auth && Number(req.auth.role) !== 0) {
        const err = Object.assign(new Error("Access denied"), { status: 403, code: "ACCESS_DENIED" });
        throw err;
      }
      const result = req.auth
        ? await paymentService.createPaymobIntention(
            req.auth.userId,
            req.body || {},
            req.headers["idempotency-key"]
          )
        : await paymentService.createGuestPaymobIntention(req.body || {}, req.headers["idempotency-key"]);
      return res.status(result.reused ? 200 : 201).json({ success: true, reused: result.reused, payment: result });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async paymobWebhook(req, res) {
    try {
      await paymentService.processPaymobWebhook(req.body || {}, req.query || {});
      return res.json({ success: true });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async getStatus(req, res) {
    try {
      const status = await paymentService.getPaymentStatus(req.auth, req.params.paymentAttemptId);
      return res.json({ success: true, payment: status });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async getGuestStatus(req, res) {
    try {
      const status = await paymentService.getGuestPaymentStatus(req.body || {});
      return res.json({ success: true, payment: status });
    } catch (err) {
      return sendError(res, err);
    }
  }
}

module.exports = {
  paymentsController: new PaymentsController(),
};
