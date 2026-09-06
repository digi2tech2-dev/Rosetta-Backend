const STATUS_LABELS = {
  pending: "قيد المراجعة",
  confirmed: "تم تأكيد الطلب",
  processing: "جاري تجهيز الطلب",
  shipped: "تم شحن الطلب",
  delivered: "تم تسليم الطلب",
  cancelled: "تم إلغاء الطلب",
};

const PAYMENT_METHOD_LABELS = {
  cash_on_delivery: "الدفع عند الاستلام",
  paymob_card: "بطاقة بنكية",
  paymob_wallet: "محفظة إلكترونية",
};

function orderNumber(order = {}) {
  return String(order.orderNumber || "").trim() || "غير متاح";
}

function orderItems(order = {}) {
  return Array.isArray(order.items) ? order.items : [];
}

function money(value, currency) {
  const amount = Number(value || 0);
  return `${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${String(currency || "EGP").toUpperCase()}`;
}

function itemLines(order) {
  const items = orderItems(order);
  const visible = items.slice(0, 15).map((item) => {
    const name = String(item.name || "منتج").trim().slice(0, 140);
    return `• ${name} × ${Math.max(1, Number(item.quantity) || 1)}`;
  });
  if (items.length > visible.length) visible.push(`• و ${items.length - visible.length} منتجات أخرى`);
  return visible.length ? visible.join("\n") : "• تفاصيل المنتجات متاحة في الطلب";
}

function formatOrderCreated(order, { paymentPending = false } = {}) {
  const paymentMethod = PAYMENT_METHOD_LABELS[order.paymentMethod] || "غير محددة";
  const paymentLine = paymentPending
    ? "حالة الدفع: في انتظار إتمام الدفع."
    : `طريقة الدفع: ${paymentMethod}`;
  return [
    "تم استلام طلبك بنجاح ✅",
    "",
    `رقم الطلب: #${orderNumber(order)}`,
    "",
    "تفاصيل الطلب:",
    itemLines(order),
    "",
    `الإجمالي: ${money(order.total ?? order.amount, order.currency)}`,
    paymentLine,
    `حالة الطلب: ${STATUS_LABELS[order.orderStatus] || "قيد المراجعة"}`,
    "",
    "سنرسل لك تحديثًا عند تغيير حالة الطلب.",
  ].join("\n");
}

function formatOrderStatusChanged(order, nextStatus) {
  const label = STATUS_LABELS[nextStatus] || nextStatus;
  const extra = nextStatus === "cancelled" ? "نعتذر عن الإزعاج. تواصلي معنا إذا احتجتِ أي مساعدة." : "سنرسل لك أي تحديثات جديدة على نفس الرقم.";
  return [
    "تحديث على طلبك 📦",
    "",
    `رقم الطلب: #${orderNumber(order)}`,
    "",
    "تم تغيير حالة الطلب إلى:",
    label,
    "",
    extra,
  ].join("\n");
}

function formatOrderConfirmationRequest(order) {
  return [
    "📦 تأكيد الطلب",
    "",
    "أهلاً بحضرتك ❤️",
    "",
    `بخصوص طلبك رقم #${orderNumber(order)}، حابين نأكد مع حضرتك قبل الشحن.`,
    "",
    "⚠️ إحنا لا نطلب عربون أو أي مبلغ مقدم، وكل اللي بنطلبه إن حضرتك لو أكدت الطلب تكون ملتزم باستلامه، علشان ما نتسببش في خسارة تكلفة الشحن والتوصيل.",
    "",
    "من فضلك رد علينا بكلمة واحدة فقط:",
    "",
    "✅ تأكيد",
    "لو حضرتك موافق على الطلب وهتستلمه.",
    "",
    "❌ رفض",
    "لو مش محتاج الطلب أو مش هتقدر تستلمه.",
    "",
    "شكراً لثقتك في Rosetta ❤️",
  ].join("\n");
}

module.exports = {
  STATUS_LABELS,
  formatOrderCreated,
  formatOrderStatusChanged,
  formatOrderConfirmationRequest,
};
