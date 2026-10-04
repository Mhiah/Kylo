#!/usr/bin/env node
/**
 * Kylo buyer: pays the Kylo agent over x402 with a Binance Agentic Wallet,
 * gets a basket plan back, then quotes (and with --execute, buys) each leg
 * through `baw market-order`.
 *
 *   node client/kylo-buy.mjs --agent https://<agent-url> --theme ai --usd 50
 *   node client/kylo-buy.mjs --agent http://localhost:8080 --theme semis --usd 20 --execute
 *
 * Needs `baw` (npm i -g @binance/agentic-wallet) signed in (`baw auth signin`).
 * Every call's latency and outcome is appended to dx/calls.jsonl for the
 * Developer Experience Report.
 */
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";

const args = parseArgs(process.argv.slice(2));
if (!args.agent || !args.theme || !args.usd) {
  console.error("usage: kylo-buy --agent <url> --theme <ai|semis|bigtech|energy|dividends> --usd <n> [--execute] [--slippage 1] [--max-legs 5] [--allow-earnings]");
  process.exit(2);
}

mkdirSync("dx", { recursive: true });
function logCall(kind, startedMs, extra) {
  appendFileSync(
    "dx/calls.jsonl",
    JSON.stringify({ at: new Date().toISOString(), kind, ms: Date.now() - startedMs, ...extra }) + "\n",
  );
}

async function baw(...argv) {
  const t0 = Date.now();
  try {
    const { stdout } = await run("baw", [...argv, "--json"], { maxBuffer: 10 * 1024 * 1024 });
    const out = JSON.parse(stdout);
    logCall(`baw ${argv.slice(0, 2).join(" ")}`, t0, { success: out.success, code: out.code });
    if (!out.success) throw new Error(`baw ${argv.slice(0, 2).join(" ")} failed: ${stdout}`);
    return out.data;
  } catch (e) {
    logCall(`baw ${argv.slice(0, 2).join(" ")}`, t0, { error: String(e.message ?? e).slice(0, 500) });
    throw e;
  }
}

async function postAgent(body, headers = {}) {
  const t0 = Date.now();
  const url = args.agent.replace(/\/$/, "") + "/x402";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  logCall("agent /x402", t0, { status: res.status, paid: Boolean(headers["PAYMENT-SIGNATURE"]) });
  return res;
}

// 1. Ask the agent for a plan; pay with Agentic Wallet if it answers 402.
const request = {
  prompt: JSON.stringify({
    theme: args.theme,
    usd: Number(args.usd),
    maxLegs: args["max-legs"] ? Number(args["max-legs"]) : undefined,
    allowEarnings: Boolean(args["allow-earnings"]),
  }),
};
let res = await postAgent(request);
if (res.status === 402) {
  const required = res.headers.get("PAYMENT-REQUIRED") ?? JSON.stringify(await res.json());
  const preview = await baw("x402-payment", "preview", "--paymentRequirements", required);
  const option = preview.options.find((o) => o.status === "READY_TO_SIGN");
  if (!option) {
    console.error("No payment option is signable:", JSON.stringify(preview.options, null, 2));
    process.exit(1);
  }
  console.log(`Paying Kylo ${option.amount} ${option.tokenSymbol} (≈$${option.amountUsd}) from ${option.userWalletAddress}`);
  const signed = await baw("x402-payment", "sign", "--paymentId", preview.paymentId, "--selectedIndex", String(option.index));
  if (signed.approveTxHash) {
    console.log(`Waiting on Permit2 approve ${signed.approveTxHash}…`);
    await waitForTx(signed.approveTxHash);
  }
  res = await postAgent(request, { [signed.paymentHeaderName]: signed.paymentHeaderValue });
  const receipt = res.headers.get("PAYMENT-RESPONSE");
  if (receipt) console.log("Settlement:", Buffer.from(receipt, "base64").toString("utf8"));
}
if (!res.ok) {
  console.error(`Agent answered HTTP ${res.status}:`, await res.text());
  process.exit(1);
}
const { result } = await res.json();
const plan = typeof result === "string" ? JSON.parse(result) : result;

console.log(`\n${plan.label} basket, $${plan.totalUsd} across ${plan.legs.length} stocks`);
for (const l of plan.legs) console.log(`  ${l.ticker.padEnd(6)} $${l.usd.toFixed(2).padStart(8)}  ${l.symbol}  ${l.marketStatus}`);
for (const s of plan.skipped) console.log(`  skip ${s.ticker}: ${s.reason}`);
for (const n of plan.notes) console.log(`  note: ${n}`);
if (plan.legs.length === 0) process.exit(0);

// 2. Quote every leg; only buy when --execute is set.
const slippage = String(args.slippage ?? "auto");
for (const leg of plan.legs) {
  const common = ["--fromTokenQty", String(leg.usd), "--fromToken", USDT_BSC, "--toToken", leg.contractAddress, "--binanceChainId", plan.chainId, "--slippage", slippage];
  const q = await baw("market-order", "quote", ...common);
  console.log(`\nquote ${leg.ticker}: ${q.fromCoinAmount} ${q.fromCoinSymbol} → ${q.toCoinAmount} ${q.toCoinSymbol}`);
  if (!args.execute) continue;
  const { orderId } = await baw("market-order", "swap", ...common);
  console.log(`  submitted order ${orderId}, confirming…`);
  const final = await waitForOrder(orderId);
  console.log(`  ${final.status}${final.txHash ? ` tx ${final.txHash}` : ""}`);
}
if (!args.execute) console.log("\nDry run: quotes only. Re-run with --execute to buy.");

async function waitForOrder(orderId) {
  for (let i = 0; i < 30; i++) {
    const data = await baw("market-order", "list", "--orderId", orderId);
    const order = Array.isArray(data) ? data[0] : (data.list?.[0] ?? data);
    if (order && (order.status === "FINISHED" || order.status === "FAILED")) return order;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { status: "STILL PENDING (check `baw market-order list`)" };
}

async function waitForTx(hash) {
  for (let i = 0; i < 30; i++) {
    const data = await baw("wallet", "tx-history", "--tx", hash).catch(() => null);
    if (JSON.stringify(data ?? "").match(/SUCCESS|CONFIRMED|FINISHED/i)) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
