/**
 * Shared buyer logic: pay the Kylo agent over x402 with a Binance Agentic
 * Wallet (`baw`), then quote / buy each basket leg with `baw market-order`.
 * Used by the CLI (kylo-buy.mjs) and the one-tap web server (server.mjs).
 *
 * Every call's latency and outcome is appended to dx/calls.jsonl as raw
 * material for the Developer Experience Report.
 */
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
export const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";
const BAW = process.env.KYLO_BAW ?? "baw";

mkdirSync("dx", { recursive: true });
function logCall(kind, startedMs, extra) {
  appendFileSync(
    "dx/calls.jsonl",
    JSON.stringify({ at: new Date().toISOString(), kind, ms: Date.now() - startedMs, ...extra }) + "\n",
  );
}

export async function baw(...argv) {
  const t0 = Date.now();
  const kind = `baw ${argv.slice(0, 2).join(" ")}`;
  try {
    const { stdout } = await run(BAW, [...argv, "--json"], { maxBuffer: 10 * 1024 * 1024 });
    const out = JSON.parse(stdout);
    logCall(kind, t0, { success: out.success, code: out.code });
    if (!out.success) throw new Error(`${kind} failed: ${stdout}`);
    return out.data;
  } catch (e) {
    logCall(kind, t0, { error: String(e.message ?? e).slice(0, 500) });
    throw e;
  }
}

async function postAgent(agentUrl, body, headers = {}) {
  const t0 = Date.now();
  const res = await fetch(agentUrl.replace(/\/$/, "") + "/x402", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  logCall("agent /x402", t0, { status: res.status, paid: Object.keys(headers).length > 0 });
  return res;
}

/**
 * Send one request to Kylo's x402 route, paying its fee from the Agentic
 * Wallet if it answers 402. Returns { result, payment }; payment is null when
 * the agent is free (price 0, local dev).
 */
export async function callAgent(agentUrl, promptObj) {
  const request = { prompt: JSON.stringify(promptObj) };
  let res = await postAgent(agentUrl, request);
  let payment = null;
  if (res.status === 402) {
    const required = res.headers.get("PAYMENT-REQUIRED") ?? JSON.stringify(await res.json());
    const preview = await baw("x402-payment", "preview", "--paymentRequirements", required);
    const option = preview.options.find((o) => o.status === "READY_TO_SIGN");
    if (!option) {
      const reasons = preview.options.flatMap((o) => o.reasons ?? []).join(", ") || "none signable";
      throw new Error(`Agentic Wallet can't pay Kylo's fee: ${reasons}`);
    }
    const signed = await baw("x402-payment", "sign", "--paymentId", preview.paymentId, "--selectedIndex", String(option.index));
    if (signed.approveTxHash) await waitForTx(signed.approveTxHash);
    res = await postAgent(agentUrl, request, { [signed.paymentHeaderName]: signed.paymentHeaderValue });
    const receipt = res.headers.get("PAYMENT-RESPONSE");
    payment = {
      amount: option.amount,
      token: option.tokenSymbol,
      amountUsd: option.amountUsd,
      from: option.userWalletAddress,
      payTo: option.payTo,
      settlement: receipt ? safeJson(Buffer.from(receipt, "base64").toString("utf8")) : null,
    };
  }
  if (!res.ok) throw new Error(`Kylo answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const { result } = await res.json();
  return { result: typeof result === "string" ? safeJson(result) : result, payment };
}

/** A basket plan for a preset theme or a hand-picked list of tickers. */
export async function getPlan(agentUrl, { theme, tickers, usd, maxLegs, allowEarnings }) {
  const { result, payment } = await callAgent(agentUrl, {
    ...(tickers?.length ? { tickers } : { theme }),
    usd: Number(usd),
    maxLegs,
    allowEarnings: Boolean(allowEarnings),
  });
  return { plan: result, payment };
}

/** Kylo's paid, LLM-written deeper take on one ticker. */
export async function getTake(agentUrl, ticker) {
  const { result, payment } = await callAgent(agentUrl, { action: "insight", ticker });
  return { take: result, payment };
}

function legArgs(plan, leg, slippage) {
  return ["--fromTokenQty", String(leg.usd), "--fromToken", USDT_BSC, "--toToken", leg.contractAddress, "--binanceChainId", plan.chainId, "--slippage", String(slippage ?? "auto")];
}

/** Quote every leg. A failed quote is reported on that leg, not thrown. */
export async function quoteLegs(plan, slippage) {
  return Promise.all(
    plan.legs.map(async (leg) => {
      try {
        const q = await baw("market-order", "quote", ...legArgs(plan, leg, slippage));
        return { ticker: leg.ticker, ok: true, from: `${q.fromCoinAmount} ${q.fromCoinSymbol}`, to: `${q.toCoinAmount} ${q.toCoinSymbol}`, toAmount: q.toCoinAmount };
      } catch (e) {
        return { ticker: leg.ticker, ok: false, error: String(e.message ?? e).slice(0, 300) };
      }
    }),
  );
}

/** Buy every leg one after another and wait for each to reach FINISHED or FAILED. */
export async function buyLegs(plan, slippage, onProgress = () => {}) {
  const results = [];
  for (const leg of plan.legs) {
    onProgress({ ticker: leg.ticker, status: "SUBMITTING" });
    try {
      const { orderId } = await baw("market-order", "swap", ...legArgs(plan, leg, slippage));
      onProgress({ ticker: leg.ticker, status: "PENDING", orderId });
      const order = await waitForOrder(orderId);
      const r = { ticker: leg.ticker, usd: leg.usd, orderId, status: order.status, txHash: order.txHash ?? null, received: order.toTokenAmount ?? order.toCoinAmount ?? null };
      results.push(r);
      onProgress(r);
    } catch (e) {
      const r = { ticker: leg.ticker, usd: leg.usd, status: "FAILED", error: String(e.message ?? e).slice(0, 300) };
      results.push(r);
      onProgress(r);
    }
  }
  return results;
}

export async function waitForOrder(orderId) {
  for (let i = 0; i < 30; i++) {
    const data = await baw("market-order", "list", "--orderId", orderId);
    const order = Array.isArray(data) ? data[0] : (data.list?.[0] ?? data);
    if (order && (order.status === "FINISHED" || order.status === "FAILED")) return order;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { status: "PENDING" };
}

async function waitForTx(hash) {
  for (let i = 0; i < 30; i++) {
    const data = await baw("wallet", "tx-history", "--tx", hash).catch(() => null);
    if (JSON.stringify(data ?? "").match(/SUCCESS|CONFIRMED|FINISHED/i)) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}
