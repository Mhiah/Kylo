import assert from "node:assert/strict";
import { test } from "node:test";
import { blockReason, planBasket } from "../src/stocks.js";

const tokens = [
  { chainId: "56", contractAddress: "0xnvda", symbol: "NVDAon", ticker: "NVDA", type: 1, multiplier: "1.0" },
  { chainId: "56", contractAddress: "0xmsft", symbol: "MSFTon", ticker: "MSFT", type: 1, multiplier: "1.01" },
  { chainId: "56", contractAddress: "0xamd", symbol: "AMDon", ticker: "AMD", type: 1, multiplier: "1.0" },
  { chainId: "1", contractAddress: "0xgoog", symbol: "GOOGLon", ticker: "GOOGL", type: 1, multiplier: "1.0" },
];
const status: Record<string, object> = {
  "0xnvda": { openState: true, marketStatus: "regular", reasonCode: "TRADING", reasonMsg: null },
  "0xmsft": { openState: false, marketStatus: "pause", reasonCode: "ASSET_LIMITED", reasonMsg: "earnings" },
  "0xamd": { openState: true, marketStatus: "regular", reasonCode: "TRADING", reasonMsg: null },
};

globalThis.fetch = (async (input: URL) => {
  const u = new URL(String(input));
  const ok = (data: unknown) => new Response(JSON.stringify({ code: "000000", success: true, data }));
  if (u.pathname.endsWith("/stock/detail/list/ai")) return ok(tokens);
  if (u.pathname.endsWith("/rwa/market/status/ai")) return ok({ openState: true, reasonCode: "TRADING" });
  const addr = u.searchParams.get("contractAddress")!;
  if (u.pathname.endsWith("/asset/market/status/ai")) return ok(status[addr]);
  if (u.pathname.endsWith("/rwa/dynamic/ai")) return ok({ tokenInfo: { price: "101", sharesMultiplier: "1.01" }, statusInfo: {} });
  throw new Error("unexpected " + u);
}) as typeof fetch;

test("skips earnings-limited and non-BSC stocks, splits USD exactly", async () => {
  const plan = await planBasket({ theme: "ai", usd: 100 });
  assert.deepEqual(plan.legs.map((l) => l.ticker), ["NVDA", "AMD"]);
  assert.equal(plan.legs.reduce((s, l) => s + l.usd, 0), 100);
  assert.equal(plan.legs[0].referenceSharePrice, 100);
  const skipped = Object.fromEntries(plan.skipped.map((s) => [s.ticker, s.reason]));
  assert.equal(skipped.MSFT, "limited (earnings)");
  assert.equal(skipped.GOOGL, "no tokenized version on BSC");
});

test("allowEarnings keeps earnings-limited stocks", async () => {
  const plan = await planBasket({ theme: "ai", usd: 10, allowEarnings: true });
  assert.ok(plan.legs.some((l) => l.ticker === "MSFT"));
  assert.equal(Math.round(plan.legs.reduce((s, l) => s + l.usd, 0) * 100), 1000);
});

test("paused assets are always blocked", () => {
  assert.equal(
    blockReason({ openState: false, marketStatus: "pause", reasonCode: "ASSET_PAUSED", reasonMsg: "stock_split", nextOpenTime: null, nextCloseTime: null }, true),
    "paused (stock_split)",
  );
});

test("unknown theme is rejected", async () => {
  await assert.rejects(planBasket({ theme: "nope", usd: 5 }), /unknown theme/);
});

test("custom tickers build a hand-picked basket", async () => {
  const plan = await planBasket({ tickers: ["amd", "NVDA", "AMD"], usd: 9 });
  assert.equal(plan.label, "Custom basket");
  assert.equal(plan.theme, "custom");
  assert.deepEqual(plan.legs.map((l) => l.ticker), ["AMD", "NVDA"]);
  assert.equal(Math.round(plan.legs.reduce((s, l) => s + l.usd, 0) * 100), 900);
});
