/**
 * Minimal client for the official Binance Web3 API (https://web3.binance.com/build).
 *
 * Every call is signed: X-OC-SIGN = base64(HMAC-SHA256(secret,
 * timestamp + METHOD + "/build" + path + ("?" + query) + jsonBody)), the same
 * pre-hash as binance_common.web3_signature in the official Python connector.
 *
 * Keys come from the environment only (KYLO_W3_API_KEY / KYLO_W3_API_SECRET);
 * on Render they live in the service's private environment settings.
 *
 * Each call's latency and outcome goes to dx/calls.jsonl as raw material for
 * the Developer Experience Report. Keys and signatures are never logged.
 */
import { createHmac } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";

const BASE = (process.env.KYLO_W3_BASE ?? "https://web3.binance.com/build").replace(/\/$/, "");
const KEY = process.env.KYLO_W3_API_KEY ?? "";
const SECRET = process.env.KYLO_W3_API_SECRET ?? "";
export const BSC = "56";

export const hasKeys = () => Boolean(KEY && SECRET);

mkdirSync("dx", { recursive: true });
function logCall(method, path, t0, extra) {
  try {
    appendFileSync("dx/calls.jsonl", JSON.stringify({ at: new Date().toISOString(), api: `${method} ${path}`, ms: Date.now() - t0, ...extra }) + "\n");
  } catch {
    // logging must never break a request
  }
}

/** ISO-8601 with milliseconds, e.g. 2026-10-04T12:00:00.000Z. */
const isoNow = () => new Date().toISOString();

/** Query string in insertion order, skipping empty values; also what gets signed. */
function encodeQuery(query) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") p.append(k, String(v));
  return p.toString();
}

export function sign(secret, timestamp, method, path, queryString, bodyStr) {
  const preHash = `${timestamp}${method}/build${path}${queryString ? `?${queryString}` : ""}${bodyStr}`;
  return createHmac("sha256", secret).update(preHash, "utf8").digest("base64");
}

export class Web3ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// The API rate-limits bursts (HTTP 429), so calls go through a small queue:
// at most 2 in flight, at least 150 ms apart, with backoff retries on 429.
const MAX_IN_FLIGHT = 2, GAP_MS = 150;
let inFlight = 0, lastStart = 0;
const waiting = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function slot() {
  while (inFlight >= MAX_IN_FLIGHT) await new Promise((r) => waiting.push(r));
  inFlight++;
  const wait = lastStart + GAP_MS - Date.now();
  lastStart = Math.max(Date.now(), lastStart + GAP_MS);
  if (wait > 0) await sleep(wait);
}
function release() {
  inFlight--;
  waiting.shift()?.();
}

async function call(method, path, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    await slot();
    try {
      return await callOnce(method, path, opts);
    } catch (e) {
      if (!(e.status === 429 || /rate limit/i.test(e.message)) || attempt >= 3) throw e;
    } finally {
      release();
    }
    await sleep(800 * 2 ** attempt);
  }
}

async function callOnce(method, path, { query = {}, body } = {}) {
  if (!hasKeys()) throw new Web3ApiError("Binance Web3 API keys are not set (KYLO_W3_API_KEY / KYLO_W3_API_SECRET)", { status: 503 });
  const qs = encodeQuery(query);
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const ts = isoNow();
  const headers = {
    "Content-Type": "application/json",
    "X-OC-APIKEY": KEY,
    "X-OC-TIMESTAMP": ts,
    "X-OC-SIGN": sign(SECRET, ts, method, path, qs, bodyStr),
    "X-OC-RECV-WINDOW": "15000",
  };
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ""}`, { method, headers, body: bodyStr || undefined, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    logCall(method, path, t0, { error: String(e.message ?? e).slice(0, 300) });
    throw new Web3ApiError(`${path}: network error (${e.message ?? e})`, { status: 502 });
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  logCall(method, path, t0, { status: res.status, code: json?.code, msg: json?.code ? String(json?.msg ?? "").slice(0, 200) : undefined });
  if (!res.ok || !json || (json.code !== 0 && json.code !== "0") || json.success === false) {
    const msg = json?.msg ?? text.slice(0, 200) ?? `HTTP ${res.status}`;
    throw new Web3ApiError(`${path}: ${msg}`, { status: res.ok ? 502 : res.status, code: json?.code });
  }
  return json.data;
}

// ── RWA Data ───────────────────────────────────────────────────────────────
/** All Ondo tokenized stocks/ETFs on BSC, optionally one of Binance's sector tabs. */
export const rwaTokens = (tabId) => call("GET", "/api/v1/dex/market/rwa/tokens", { query: { binanceChainId: BSC, platformId: "ondo", tabId } });
export const rwaPrices = (addresses) => call("GET", "/api/v1/dex/market/rwa/price", { query: { binanceChainId: BSC, tokenContractAddresses: addresses.join(",") } });
export const rwaProfile = (address) => call("GET", "/api/v1/dex/market/rwa/underlying-profile", { query: { binanceChainId: BSC, tokenContractAddress: address } });
export const rwaMarket = (address) => call("GET", "/api/v1/dex/market/rwa/underlying-market", { query: { binanceChainId: BSC, tokenContractAddress: address } });

// ── General Data ───────────────────────────────────────────────────────────
/** Rows of [open, high, low, close, volume, timestampMs, tradeCount]. */
export const candles = (address, bar = "1d", limit = 90) => call("GET", "/api/v1/dex/market/candles", { query: { binanceChainId: BSC, tokenContractAddress: address, bar, limit } });
export const topPools = (address) => call("GET", "/api/v1/dex/market/token/top-liquidity", { query: { binanceChainId: BSC, tokenContractAddress: address } });
/** Batch on-chain trading info (24h change, liquidity, holders). Up to 100 tokens. */
export const tradingInfo = (addresses) => call("POST", "/api/v1/dex/market/price-info", { body: addresses.map((a) => ({ binanceChainId: BSC, tokenContractAddress: a })) });

// ── Trading ────────────────────────────────────────────────────────────────
export const quote = ({ from, to, amount, wallet }) => call("GET", "/api/v1/dex/aggregator/quote", {
  query: { binanceChainId: BSC, amount, fromTokenAddress: from, toTokenAddress: to, userWalletAddress: wallet },
});
export const buildSwap = ({ from, to, amount, wallet, quoteId, slippagePercent = "1" }) => call("GET", "/api/v1/dex/aggregator/swap", {
  query: { binanceChainId: BSC, amount, fromTokenAddress: from, toTokenAddress: to, userWalletAddress: wallet, quoteId, slippagePercent, approveTransaction: "true" },
});
export const approveTx = ({ token, amount, vendor }) => call("GET", "/api/v1/dex/aggregator/approve-transaction", {
  query: { binanceChainId: BSC, tokenContractAddress: token, approveAmount: amount, vendor },
});
export const submitRfq = ({ requestId, signature, vendor, quoteId, signingScheme }) => call("POST", "/api/v1/dex/aggregator/order/submit", {
  body: { requestId, userSignature: signature, vendor, quoteId, signingScheme },
});
export const rfqStatus = (orderId) => call("GET", `/api/v1/dex/aggregator/order/${encodeURIComponent(orderId)}`);

// ── Transaction ────────────────────────────────────────────────────────────
export const simulate = ({ from, to, data, value = "0" }) => call("POST", "/api/v1/dex/pre-transaction/simulate", {
  body: { binanceChainId: BSC, evmTx: { from, to, data, value } },
});
export const gasPrice = () => call("GET", "/api/v1/dex/pre-transaction/gas-price", { query: { binanceChainId: BSC } });
