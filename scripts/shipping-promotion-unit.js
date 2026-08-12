const assert = require("assert");
const mongoose = require("mongoose");
const {
  calculateQuantityShippingDiscount,
  calculateQuantityShippingDiscountCents,
  calculateQuantityShippingPromotionMetadata,
} = require("../services/pricingService");
const {
  normalizeOrder,
} = require("../services/orderService");
const {
  normalizeGuestCartItems,
} = require("../services/guestCheckoutService");

function expectDiscount(totalQuantity, baseShippingCost, expected) {
  const result = calculateQuantityShippingDiscount({ totalQuantity, baseShippingCost });
  assert.strictEqual(result.totalQuantity, expected.totalQuantity ?? totalQuantity, `quantity ${totalQuantity}: totalQuantity`);
  assert.strictEqual(result.discountPercent, expected.discountPercent, `quantity ${totalQuantity}: percent`);
  assert.strictEqual(result.discountAmount, expected.discountAmount, `quantity ${totalQuantity}: discountAmount`);
  assert.strictEqual(result.shippingAfterQuantityDiscount, expected.finalShipping, `quantity ${totalQuantity}: final shipping`);
  assert.strictEqual(result.nextThreshold, expected.nextThreshold, `quantity ${totalQuantity}: next threshold`);
  assert.strictEqual(
    result.quantityNeededForNextThreshold,
    expected.quantityNeededForNextThreshold,
    `quantity ${totalQuantity}: quantity needed`
  );
}

function expectCents(totalQuantity, baseShippingCents, expected) {
  const result = calculateQuantityShippingDiscountCents({ totalQuantity, baseShippingCents });
  assert.strictEqual(result.discountPercent, expected.discountPercent, `quantity ${totalQuantity}: cents percent`);
  assert.strictEqual(result.discountAmountCents, expected.discountAmountCents, `quantity ${totalQuantity}: cents discount`);
  assert.strictEqual(result.finalShippingCents, expected.finalShippingCents, `quantity ${totalQuantity}: cents final`);
  assert.strictEqual(
    result.discountAmountCents + result.finalShippingCents,
    Math.max(0, Math.round(baseShippingCents)),
    `quantity ${totalQuantity}: cents conserve base shipping`
  );
}

function testThresholds() {
  [
    [1, 0, 0, 90, 3, 2],
    [2, 0, 0, 90, 3, 1],
    [3, 50, 45, 45, 5, 2],
    [4, 50, 45, 45, 5, 1],
    [5, 100, 90, 0, null, 0],
    [6, 100, 90, 0, null, 0],
    [10, 100, 90, 0, null, 0],
    [20, 100, 90, 0, null, 0],
  ].forEach(([quantity, discountPercent, discountAmount, finalShipping, nextThreshold, quantityNeededForNextThreshold]) => {
    expectDiscount(quantity, 90, {
      discountPercent,
      discountAmount,
      finalShipping,
      nextThreshold,
      quantityNeededForNextThreshold,
    });
  });
}

function testExampleTotals() {
  const subtotal = 1305;
  assert.strictEqual(subtotal + calculateQuantityShippingDiscount({ totalQuantity: 2, baseShippingCost: 90 }).shippingAfterQuantityDiscount, 1395);
  assert.strictEqual(subtotal + calculateQuantityShippingDiscount({ totalQuantity: 3, baseShippingCost: 90 }).shippingAfterQuantityDiscount, 1350);
  assert.strictEqual(subtotal + calculateQuantityShippingDiscount({ totalQuantity: 4, baseShippingCost: 90 }).shippingAfterQuantityDiscount, 1350);
  assert.strictEqual(subtotal + calculateQuantityShippingDiscount({ totalQuantity: 5, baseShippingCost: 90 }).shippingAfterQuantityDiscount, 1305);
  assert.strictEqual(subtotal + calculateQuantityShippingDiscount({ totalQuantity: 6, baseShippingCost: 90 }).shippingAfterQuantityDiscount, 1305);
}

function testBaseShippingEdgeCases() {
  expectDiscount(3, 0, {
    discountPercent: 50,
    discountAmount: 0,
    finalShipping: 0,
    nextThreshold: 5,
    quantityNeededForNextThreshold: 2,
  });
  expectDiscount(5, 0, {
    discountPercent: 100,
    discountAmount: 0,
    finalShipping: 0,
    nextThreshold: null,
    quantityNeededForNextThreshold: 0,
  });
  expectCents(3, 9075, {
    discountPercent: 50,
    discountAmountCents: 4538,
    finalShippingCents: 4537,
  });
  expectCents(5, 9075, {
    discountPercent: 100,
    discountAmountCents: 9075,
    finalShippingCents: 0,
  });
  expectCents(3, -500, {
    discountPercent: 50,
    discountAmountCents: 0,
    finalShippingCents: 0,
  });
}

function testQuantityCombinations() {
  const oneItemQuantityThree = [{ quantity: 3 }];
  const oneItemQuantityFive = [{ quantity: 5 }];
  const threeItemsQuantityOne = [{ quantity: 1 }, { quantity: 1 }, { quantity: 1 }];
  const mixedQuantityThree = [{ quantity: 1 }, { quantity: 2 }];
  const mixedQuantityFive = [{ quantity: 2 }, { quantity: 1 }, { quantity: 2 }];
  const bundleMembersQuantityThree = [
    { quantity: 1, bundleGroupId: "bundle-a", bundleRole: "primary" },
    { quantity: 1, bundleGroupId: "bundle-a", bundleRole: "additional" },
    { quantity: 1 },
  ];
  const bundleMembersQuantityFive = [
    { quantity: 1, bundleGroupId: "bundle-a", bundleRole: "primary" },
    { quantity: 1, bundleGroupId: "bundle-a", bundleRole: "additional" },
    { quantity: 1, bundleGroupId: "bundle-b", bundleRole: "primary" },
    { quantity: 1, bundleGroupId: "bundle-b", bundleRole: "additional" },
    { quantity: 1 },
  ];
  const sum = (items) => items.reduce((total, item) => total + item.quantity, 0);

  assert.strictEqual(calculateQuantityShippingDiscount({ totalQuantity: sum(oneItemQuantityThree), baseShippingCost: 90 }).discountPercent, 50);
  assert.strictEqual(calculateQuantityShippingDiscount({ totalQuantity: sum(oneItemQuantityFive), baseShippingCost: 90 }).discountPercent, 100);
  assert.strictEqual(calculateQuantityShippingDiscount({ totalQuantity: sum(threeItemsQuantityOne), baseShippingCost: 90 }).discountPercent, 50);
  assert.strictEqual(calculateQuantityShippingDiscount({ totalQuantity: sum(mixedQuantityThree), baseShippingCost: 90 }).shippingAfterQuantityDiscount, 45);
  assert.strictEqual(calculateQuantityShippingDiscount({ totalQuantity: sum(mixedQuantityFive), baseShippingCost: 90 }).shippingAfterQuantityDiscount, 0);
  assert.strictEqual(calculateQuantityShippingDiscount({ totalQuantity: sum(bundleMembersQuantityThree), baseShippingCost: 90 }).discountPercent, 50);
  assert.strictEqual(calculateQuantityShippingDiscount({ totalQuantity: sum(bundleMembersQuantityFive), baseShippingCost: 90 }).shippingAfterQuantityDiscount, 0);
}

function testPromotionMetadata() {
  assert.deepStrictEqual(calculateQuantityShippingPromotionMetadata(2), {
    type: "quantity",
    totalQuantity: 2,
    discountPercent: 0,
    discountAmount: 0,
    nextThreshold: 3,
    quantityNeededForNextThreshold: 1,
  });
  assert.deepStrictEqual(calculateQuantityShippingPromotionMetadata(3), {
    type: "quantity",
    totalQuantity: 3,
    discountPercent: 50,
    discountAmount: 0,
    nextThreshold: 5,
    quantityNeededForNextThreshold: 2,
  });
  assert.deepStrictEqual(calculateQuantityShippingPromotionMetadata(5), {
    type: "quantity",
    totalQuantity: 5,
    discountPercent: 100,
    discountAmount: 0,
    nextThreshold: null,
    quantityNeededForNextThreshold: 0,
  });
}

function testInvalidGuestQuantityRejected() {
  const productId = new mongoose.Types.ObjectId().toString();
  assert.throws(
    () => normalizeGuestCartItems([{ productId, quantity: 0 }]),
    (err) => err.code === "VALIDATION_ERROR"
  );
  assert.throws(
    () => normalizeGuestCartItems([{ productId, quantity: 1.5 }]),
    (err) => err.code === "VALIDATION_ERROR"
  );
  assert.throws(
    () => normalizeGuestCartItems([{ productId, quantity: "not-a-number" }]),
    (err) => err.code === "VALIDATION_ERROR"
  );
}

function testOrderSerialization() {
  const productId = new mongoose.Types.ObjectId();
  const order = normalizeOrder({
    _id: new mongoose.Types.ObjectId(),
    customerType: "guest",
    guestCustomer: { fullName: "Guest Customer", email: null, phone: "01000000000" },
    customerSnapshot: { fullName: "Guest Customer", email: "", phone: "01000000000" },
    orderNumber: "RSHIPUNIT1",
    items: [{
      product: productId,
      name: "Snapshot Product",
      image: "product.png",
      unitPrice: 326.25,
      quantity: 4,
      lineTotal: 1305,
      merchantName: "Supplier A",
    }],
    subtotal: 1305,
    discountTotal: 0,
    shippingFee: 45,
    total: 1350,
    amount: 1350,
    currency: "EGP",
    paymentMethod: "cash_on_delivery",
    paymentStatus: "unpaid",
    orderStatus: "pending",
    pricingSnapshot: {
      currency: "EGP",
      totalQuantity: 4,
      merchandiseSubtotal: 1305,
      discountTotal: 0,
      shippingFee: 45,
      grandTotal: 1350,
      shippingSnapshot: {
        originalFee: 90,
        baseFee: 90,
        quantityDiscountPercent: 50,
        quantityDiscountAmount: 45,
        chargedFee: 45,
        finalFee: 45,
        freeShippingApplied: false,
        thresholdFreeShippingApplied: false,
        quantityPromotionApplied: true,
        totalQuantity: 4,
        nextQuantityThreshold: 5,
        quantityNeededForNextThreshold: 1,
      },
    },
  }, { admin: true });

  assert.strictEqual(order.totalQuantity, 4);
  assert.strictEqual(order.shippingBaseCost, 90);
  assert.strictEqual(order.shippingDiscountPercent, 50);
  assert.strictEqual(order.shippingDiscountAmount, 45);
  assert.strictEqual(order.shippingFee, 45);
  assert.strictEqual(order.finalShippingCost, 45);
  assert.strictEqual(order.items[0].merchantName, "Supplier A");

  const legacy = normalizeOrder({
    _id: new mongoose.Types.ObjectId(),
    customerType: "guest",
    guestCustomer: {},
    orderNumber: "RSHIPLEGACY",
    allProduct: [{
      id: { _id: productId, pName: "Legacy Product", pPrice: 100, pImages: ["legacy.png"] },
      quantitiy: 2,
    }],
    shippingFee: 90,
    total: 290,
    amount: 290,
    currency: "EGP",
    paymentMethod: "cash_on_delivery",
    status: "Not processed",
  }, { admin: true });

  assert.strictEqual(legacy.totalQuantity, 2);
  assert.strictEqual(legacy.shippingDiscountPercent, 0);
  assert.strictEqual(legacy.shippingDiscountAmount, 0);
  assert.strictEqual(legacy.shippingFee, 90);
  assert.strictEqual(legacy.customer.name, "زائر");
}

testThresholds();
testExampleTotals();
testBaseShippingEdgeCases();
testQuantityCombinations();
testPromotionMetadata();
testInvalidGuestQuantityRejected();
testOrderSerialization();

console.log("SHIPPING_PROMOTION_UNIT_PASS");
