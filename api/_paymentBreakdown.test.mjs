import test from "node:test"; import assert from "node:assert/strict";
import { paymentTotalsByMethod } from "./_paymentBreakdown.js";
test("split order is counted as cash + its online method, not 'split'", () => {
  const t = paymentTotalsByMethod([{ payMethod: "cash", total: 100 }, { payMethod: "split", total: 750, splitCash: 150, splitOnlineMethod: "gcash", splitOnlineAmount: 600 }, { payMethod: "gcash", total: 50 }]);
  assert.deepEqual(t, { cash: { count: 2, amt: 250 }, gcash: { count: 2, amt: 650 } });
  assert.equal(t.split, undefined);
});
test("totals still add up to the order totals", () => {
  const o = [{ payMethod: "split", total: 750, splitCash: 150, splitOnlineMethod: "maya", splitOnlineAmount: 600 }];
  const t = paymentTotalsByMethod(o); assert.equal(Object.values(t).reduce((s, v) => s + v.amt, 0), 750);
});
