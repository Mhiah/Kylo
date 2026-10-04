import assert from "node:assert/strict";
import { test } from "node:test";
import { sign } from "../web3api.mjs";
import { blockReason, decodeTypedData, formatUnits, usdToUnits } from "../trade.mjs";
import { insightFor } from "../data.mjs";

const TS = "2026-10-04T12:00:00.000Z";

// Expected values computed independently with Python's hmac, using the
// pre-hash from binance_common.web3_signature in the official connector.
test("signs GET requests like the official connector", () => {
  assert.equal(
    sign("sec", TS, "GET", "/api/v1/dex/market/rwa/underlying-market", "binanceChainId=56&tokenContractAddress=0xabc", ""),
    "YsIp1+x20JCfH3ALt+YVbgPlVqNnH7/tWgMwPecTp84=",
  );
});

test("signs POST bodies as compact JSON", () => {
  const body = JSON.stringify({ binanceChainId: "56", evmTx: { from: "0x1", to: "0x2", data: "0x", value: "0" } });
  assert.equal(sign("sec", TS, "POST", "/api/v1/dex/pre-transaction/simulate", "", body), "nI+O90+iychLq2ZoRXC5LUg2azadl3hcVPU4ZBP0ygo=");
});

test("USD amounts convert to exact USDT units", () => {
  assert.equal(usdToUnits(6.25), "6250000000000000000");
  assert.equal(usdToUnits(0.1), "100000000000000000");
  assert.equal(formatUnits("34196000000000000", 18, 6), "0.034196");
  assert.equal(formatUnits("1000000000000000000", 18), "1");
});

test("typed data decodes from JSON or hex-encoded JSON, never a raw digest", () => {
  const td = { primaryType: "Order", message: { a: 1 } };
  assert.deepEqual(decodeTypedData(JSON.stringify(td)), td);
  assert.deepEqual(decodeTypedData("0x" + Buffer.from(JSON.stringify(td)).toString("hex")), td);
  assert.throws(() => decodeTypedData("0x1901" + "ab".repeat(64)), /isn't supported/);
});

test("paused and limited stocks are kept out of baskets", () => {
  assert.match(blockReason({ reasonCode: "ASSET_PAUSED", reasonMsg: "stock split" }, false), /paused/);
  assert.match(blockReason({ reasonCode: "ASSET_LIMITED", reasonMsg: "earnings" }, false), /limited/);
  assert.equal(blockReason({ reasonCode: "ASSET_LIMITED", reasonMsg: "earnings" }, true), null);
  assert.equal(blockReason({ openState: false, reasonCode: "MARKET_CLOSED" }, false), null);
});

test("insight rules explain thin liquidity and paused trading", () => {
  const base = { sharePrice: 10, high52w: null, low52w: null, closes90d: [], pe: null, dividendYieldPct: null, stockMarketCap: null,
    onchainLiquidityUsd: 20_000, holders: 50, sharesPerToken: 1, assetType: "Stock", statusRaw: { openState: false, reasonCode: "ASSET_PAUSED", reasonMsg: "stock split" } };
  const i = insightFor(base);
  assert.equal(i.read.label, "Can't buy right now");
  assert.ok(i.holdOff.some((x) => /Thin on-chain liquidity/.test(x)));
  assert.ok(i.token.some((x) => /50 on-chain holders/.test(x)));
});
