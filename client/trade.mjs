/**
 * Basket planning and buying through the Binance Web3 API Trading and
 * Transaction modules, for a wallet the user connects in their own browser.
 *
 * The server never holds a private key. It plans the basket (fixed code, no
 * LLM), gets quotes, builds each order and simulates any approval. The
 * user's wallet then signs: one EIP-712 order per stock (RFQ route, which is
 * how Ondo stock tokens trade), or a normal transaction on a DEX route.
 */
import { BSC, approveTx, buildSwap, quote, rfqStatus, simulate, submitRfq } from "./web3api.mjs";
import { SECTORS, marketStatus, tokenList } from "./data.mjs";

/** BSC-USD (USDT), 18 decimals: what every basket is paid in. */
export const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";
const USDT_DECIMALS = 18;
const RPC = process.env.KYLO_BSC_RPC ?? "https://bsc-dataseed.bnbchain.org";

export const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** "12.34" USD → USDT smallest units, exactly (no float rounding). */
export function usdToUnits(usd, decimals = USDT_DECIMALS) {
  const [whole, frac = ""] = Number(usd).toFixed(2).split(".");
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0").slice(0, decimals))).toString();
}

/** Smallest units → decimal string with up to `dp` places. */
export function formatUnits(units, decimals, dp = 6) {
  if (units === null || units === undefined) return null;
  const v = BigInt(units);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, dp).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Why a stock cannot be bought right now, or null if it can. */
export function blockReason(s, allowEarnings) {
  if (!s) return null;
  if (s.reasonCode === "ASSET_PAUSED") return `paused (${s.reasonMsg ?? "corporate action"})`;
  if (s.reasonCode === "ASSET_LIMITED") {
    if (/earning/i.test(s.reasonMsg ?? "") && allowEarnings) return null;
    return `limited (${s.reasonMsg ?? "restricted"})`;
  }
  if (s.reasonCode === "UNSUPPORTED") return "unsupported";
  if (s.reasonCode === "MARKET_MAINTENANCE") return "maintenance";
  return null;
}

/**
 * Deterministic equal-weight plan. `theme` is a Binance sector id (see
 * SECTORS) or omit it and pass `tickers`. The last leg absorbs rounding so
 * the legs add up to the cent.
 */
export async function planBasket({ theme, tickers, usd, maxLegs, allowEarnings = false }) {
  if (!(Number(usd) > 0)) throw Object.assign(new Error("usd must be positive"), { status: 400 });
  const total = Math.round(Number(usd) * 100) / 100;
  const all = await tokenList();
  const sector = theme ? SECTORS.find((s) => s.id === theme) : null;
  if (theme && !sector) throw Object.assign(new Error(`unknown theme "${theme}"`), { status: 400 });
  const wanted = sector
    ? all.filter((t) => t.sectors.includes(sector.id)).sort((a, b) => (b.stockMarketCap ?? 0) - (a.stockMarketCap ?? 0)).map((t) => t.ticker)
    : [...new Set((tickers ?? []).map((t) => String(t).trim().toUpperCase()).filter(Boolean))];
  if (!wanted.length) throw Object.assign(new Error("pick at least one stock"), { status: 400 });
  if (wanted.length > 20 && !sector) throw Object.assign(new Error("at most 20 stocks per basket"), { status: 400 });
  const cap = Math.max(1, Math.min(maxLegs ?? (sector ? 5 : wanted.length), 20));
  const byTicker = new Map(all.map((t) => [t.ticker, t]));

  const skipped = [];
  const buyable = [];
  for (const tk of wanted) {
    const t = byTicker.get(tk);
    if (!t) { skipped.push({ ticker: tk, reason: "no tokenized version on BSC" }); continue; }
    const reason = blockReason(t.statusRaw, allowEarnings);
    if (reason) skipped.push({ ticker: tk, reason });
    else buyable.push(t);
  }
  const chosen = buyable.slice(0, cap);
  for (const t of buyable.slice(cap)) skipped.push({ ticker: t.ticker, reason: `over max stocks (${cap})` });

  let allocated = 0;
  const legs = chosen.map((t, i) => {
    const legUsd = i === chosen.length - 1
      ? Math.round((total - allocated) * 100) / 100
      : Math.floor((total / chosen.length) * 100) / 100;
    allocated = Math.round((allocated + legUsd) * 100) / 100;
    return {
      ticker: t.ticker, symbol: t.symbol, name: t.name, contractAddress: t.contractAddress, decimals: t.decimals,
      weight: Math.round((1 / chosen.length) * 1e4) / 1e4, usd: legUsd, sharePrice: t.sharePrice, marketStatus: t.statusRaw?.marketStatus ?? null,
    };
  });

  const market = await marketStatus().catch(() => null);
  const notes = [];
  if (market && !market.openState) {
    notes.push(`The tokenized-stock market is closed right now${market.nextOpenTime ? ` (opens ${new Date(market.nextOpenTime).toUTCString()})` : ""}, so orders may not fill until it reopens.`);
  }
  if (!legs.length) notes.push("None of these stocks can be bought right now.");
  return {
    theme: sector?.id ?? "custom", label: sector?.label ?? "Your basket", source: sector ? `Binance sector tab ${sector.tabId}` : "hand-picked",
    chainId: BSC, fundingToken: USDT_BSC, totalUsd: allocated, legs, skipped, marketOpen: market?.openState ?? null, generatedAt: new Date().toISOString(), notes,
  };
}

/** Best route for one leg; RFQ routes (Ondo) need the buyer's wallet address. */
async function bestQuote(leg, wallet) {
  const routes = await quote({ from: USDT_BSC, to: leg.contractAddress, amount: usdToUnits(leg.usd), wallet });
  const list = Array.isArray(routes) ? routes : [];
  const best = list.find((r) => r.isBest) ?? list[0];
  if (!best) throw new Error("no route");
  return best;
}

export async function quoteLegs(plan, wallet) {
  return Promise.all(plan.legs.map(async (leg) => {
    try {
      const r = await bestQuote(leg, wallet);
      return {
        ticker: leg.ticker, ok: true, vendor: r.vendorName, mode: r.executionMode,
        receive: formatUnits(r.toTokenAmount, leg.decimals, 6), symbol: leg.symbol,
        priceImpactPct: r.priceImpactPercent ?? null, feeUsd: r.tradeFee ?? null,
      };
    } catch (e) {
      return { ticker: leg.ticker, ok: false, error: String(e.message ?? e).slice(0, 200) };
    }
  }));
}

/** Typed data comes as JSON or hex-encoded JSON; anything else is a raw digest we can't hand to a wallet. */
export function decodeTypedData(v) {
  if (v && typeof v === "object") return v;
  const s = String(v ?? "").trim();
  if (s.startsWith("{")) return JSON.parse(s);
  if (/^0x[0-9a-fA-F]+$/.test(s)) {
    const text = Buffer.from(s.slice(2), "hex").toString("utf8");
    if (text.trim().startsWith("{")) return JSON.parse(text);
  }
  throw new Error("this order type isn't supported for browser wallets yet");
}

async function rpc(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

export async function usdtBalance(wallet) {
  return BigInt(await rpc("eth_call", [{ to: USDT_BSC, data: `0x70a08231${pad(wallet)}` }, "latest"]));
}
async function allowance(owner, spender) {
  return BigInt(await rpc("eth_call", [{ to: USDT_BSC, data: `0xdd62ed3e${pad(owner)}${pad(spender)}` }, "latest"]));
}

/**
 * Build one leg for the browser wallet: a fresh quote (they live ~30s), the
 * order, and an approval only if the current allowance is too low. Any
 * approval is simulated first so the user sees what it will do.
 */
export async function prepareLeg(leg, wallet, slippagePercent = "1", approveUsd = leg.usd) {
  const amount = usdToUnits(leg.usd);
  // Approve the rest of the basket at once, so it is one approval, not one per stock.
  const approveAmount = usdToUnits(Math.max(approveUsd, leg.usd));
  const route = await bestQuote(leg, wallet);
  const built = await buildSwap({ from: USDT_BSC, to: leg.contractAddress, amount, wallet, quoteId: route.quoteId, slippagePercent });
  const mode = built.executionMode ?? route.executionMode;

  let spender = null, approveData = null;
  if (mode === "RFQ") {
    const extra = (built.rfq?.signatureData ?? []).map((s) => { try { return JSON.parse(s); } catch { return null; } }).find(Boolean);
    spender = extra?.approveContract ?? null;
    approveData = extra?.approveTxCalldata ?? null;
    // The vendor-specific approval endpoint lets us approve the whole basket;
    // the calldata bundled with the order only covers this one stock.
    const a = (await approveTx({ token: USDT_BSC, amount: approveAmount, vendor: built.rfq?.vendor ?? route.vendorName }).catch(() => null))?.[0];
    if (a?.dexContractAddress && a?.data && (!spender || a.dexContractAddress.toLowerCase() === spender.toLowerCase())) {
      spender = a.dexContractAddress;
      approveData = a.data;
    }
  } else {
    spender = built.tx?.signatureData?.[0] ?? route.approveTarget ?? null;
    if (spender && !isAddress(spender)) spender = null;
    if (spender) approveData = (await approveTx({ token: USDT_BSC, amount: approveAmount }))?.[0]?.data ?? null;
  }

  let approve = null;
  if (spender && approveData && (await allowance(wallet, spender).catch(() => 0n)) < BigInt(amount)) {
    const sim = await simulate({ from: wallet, to: USDT_BSC, data: approveData }).catch((e) => ({ status: "UNKNOWN", failReason: String(e.message ?? e) }));
    approve = { to: USDT_BSC, data: approveData, spender, simulation: { status: sim?.status ?? null, failReason: sim?.failReason ?? null } };
  }

  const out = {
    ticker: leg.ticker, mode, vendor: built.rfq?.vendor ?? route.vendorName, approve,
    receive: formatUnits(built.routerResult?.toTokenAmount ?? route.toTokenAmount, leg.decimals, 6),
  };
  if (mode === "RFQ") {
    out.rfq = { typedData: decodeTypedData(built.rfq?.typedDataToSign), vendor: built.rfq?.vendor, orderId: built.rfq?.orderId ?? route.quoteId, signingScheme: built.rfq?.signingScheme ?? null };
  } else {
    const tx = built.tx ?? {};
    out.tx = { from: wallet, to: tx.to, data: tx.data, value: tx.value ?? "0", gas: tx.gas ?? null };
  }
  return out;
}

export function submitLeg({ requestId, signature, vendor, orderId, signingScheme }) {
  return submitRfq({ requestId, signature, vendor, quoteId: orderId, signingScheme: signingScheme ?? undefined });
}

export const orderStatus = (orderId) => rfqStatus(orderId);
