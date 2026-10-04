#!/usr/bin/env node
/**
 * Kylo buyer CLI: pays the Kylo agent over x402 with a Binance Agentic
 * Wallet, prints the basket plan and quotes, and with --execute buys each leg.
 *
 *   node client/kylo-buy.mjs --agent https://<agent-url> --theme ai --usd 50
 *   node client/kylo-buy.mjs --agent http://localhost:8080 --theme semis --usd 20 --execute
 *
 * Needs `baw` (npm i -g @binance/agentic-wallet) signed in (`baw auth signin`).
 */
import { buyLegs, getPlan, quoteLegs } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.agent || !(args.theme || args.tickers) || !args.usd) {
  console.error("usage: kylo-buy --agent <url> (--theme <ai|semis|bigtech|energy|dividends> | --tickers NVDA,AAPL) --usd <n> [--execute] [--slippage 1] [--max-legs 5] [--allow-earnings]");
  process.exit(2);
}

const { plan, payment } = await getPlan(args.agent, {
  theme: args.theme,
  tickers: args.tickers ? String(args.tickers).split(",") : undefined,
  usd: args.usd,
  maxLegs: args["max-legs"] ? Number(args["max-legs"]) : undefined,
  allowEarnings: args["allow-earnings"],
});
if (payment) console.log(`Paid Kylo ${payment.amount} ${payment.token} (≈$${payment.amountUsd}) from ${payment.from}`);

console.log(`\n${plan.label} basket, $${plan.totalUsd} across ${plan.legs.length} stocks`);
for (const l of plan.legs) console.log(`  ${l.ticker.padEnd(6)} $${l.usd.toFixed(2).padStart(8)}  ${l.symbol}  ${l.marketStatus}`);
for (const s of plan.skipped) console.log(`  skip ${s.ticker}: ${s.reason}`);
for (const n of plan.notes) console.log(`  note: ${n}`);
if (plan.legs.length === 0) process.exit(0);

for (const q of await quoteLegs(plan, args.slippage)) {
  console.log(q.ok ? `quote ${q.ticker}: ${q.from} → ${q.to}` : `quote ${q.ticker} failed: ${q.error}`);
}
if (!args.execute) {
  console.log("\nDry run: quotes only. Re-run with --execute to buy.");
  process.exit(0);
}
await buyLegs(plan, args.slippage, (p) => {
  if (p.status === "PENDING") console.log(`  ${p.ticker}: submitted order ${p.orderId}, confirming…`);
  else if (p.status !== "SUBMITTING") console.log(`  ${p.ticker}: ${p.status}${p.txHash ? ` tx ${p.txHash}` : ""}${p.error ? ` (${p.error})` : ""}`);
});

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
