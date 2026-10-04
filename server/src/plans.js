// Prices are set here on the server, never sent by the browser, so a user
// cannot change what they pay. Amounts are in the smallest currency unit:
// 5000 = GH₵ 50.00 (or ₦50.00 / $50.00 depending on CURRENCY).
export const PLANS = {
  // Daily packages: each purchase covers one day and is renewed by buying again.
  vip: { id: "vip", name: "VIP", amount: 5000, days: 1, rank: 1 },
  vvip: { id: "vvip", name: "VVIP", amount: 10000, days: 1, rank: 2 },
};

export function getPlan(planId) {
  return Object.hasOwn(PLANS, planId) ? PLANS[planId] : null;
}
