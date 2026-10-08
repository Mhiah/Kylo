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
import { SECTORS, marketStatus, sectorSource, tokenList } from "./data.mjs";

/** BSC-USD (USDT), 18 decimals: what every basket is paid in. */
export const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";
const USDT_DECIMALS = 18;
/**
 * Smallest amount per stock. Binance says "Minimum order amount is 5 USD" but
 * rejects exactly $5.00 too (fees seem to come off first), so keep a margin.
 */
export const MIN_LEG_USD = 6;
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
  // Binance rejects orders under $5, so a small basket holds fewer stocks.
  const fit = Math.min(cap, Math.floor(total / MIN_LEG_USD));
  if (buyable.length && fit < 1) throw Object.assign(new Error(`the smallest basket is $${MIN_LEG_USD} (Binance needs a bit over $5 per stock)`), { status: 400 });
  const chosen = buyable.slice(0, fit);
  const notes = [];
  if (sector && buyable.length > chosen.length) {
    notes.push(`Picked the ${chosen.length} biggest of ${buyable.length} buyable stocks in this theme${fit < cap ? ` (each stock needs at least $${MIN_LEG_USD})` : ""}.`);
  } else {
    for (const t of buyable.slice(fit)) skipped.push({ ticker: t.ticker, reason: fit < cap ? `needs at least $${MIN_LEG_USD} per stock` : `over max stocks (${cap})` });
  }

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
  if (market && !market.openState) {
    notes.push(`The tokenized-stock market is closed right now${market.nextOpenTime ? ` (opens ${new Date(market.nextOpenTime).toUTCString()})` : ""}, so orders may not fill until it reopens.`);
  }
  if (!legs.length) notes.push("None of these stocks can be bought right now.");
  return {
    theme: sector?.id ?? "custom", label: sector?.label ?? "Your basket", source: sector ? (sectorSource.get(sector.id) === "kylo" ? "Kylo's list (Binance tab was empty)" : `Binance sector tab ${sector.tabId}`) : "hand-picked",
    chainId: BSC, fundingToken: USDT_BSC, totalUsd: allocated, legs, skipped, marketOpen: market?.openState ?? null, generatedAt: new Date().toISOString(), notes,
  };
}

/** Best route for one swap; RFQ routes (Ondo) need the trader's wallet address. */
async function bestRoute({ from, to, amount, wallet }) {
  const routes = await quote({ from, to, amount, wallet });
  const list = Array.isArray(routes) ? routes : [];
  const best = list.find((r) => r.isBest) ?? list[0];
  if (!best) throw new Error("no route");
  return best;
}
const bestQuote = (leg, wallet) => bestRoute({ from: USDT_BSC, to: leg.contractAddress, amount: usdToUnits(leg.usd), wallet });

export async function quoteLegs(plan, wallet) {
  // One at a time: the API rate-limits bursts of quotes.
  const out = [];
  for (const leg of plan.legs) {
    out.push(await (async () => { try {
      const r = await bestQuote(leg, wallet);
      return {
        ticker: leg.ticker, ok: true, vendor: r.vendorName, mode: r.executionMode,
        receive: formatUnits(r.toTokenAmount, leg.decimals, 6), symbol: leg.symbol,
        priceImpactPct: r.priceImpactPercent ?? null, feeUsd: r.tradeFee ?? null,
      };
    } catch (e) {
      return { ticker: leg.ticker, ok: false, error: String(e.message ?? e).slice(0, 200) };
    } })());
  }
  return out;
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
  return tokenBalance(USDT_BSC, wallet);
}
async function tokenBalance(token, wallet) {
  return BigInt(await rpc("eth_call", [{ to: token, data: `0x70a08231${pad(wallet)}` }, "latest"]));
}
async function allowance(token, owner, spender) {
  return BigInt(await rpc("eth_call", [{ to: token, data: `0xdd62ed3e${pad(owner)}${pad(spender)}` }, "latest"]));
}

/** balanceOf for many tokens, as JSON-RPC batches (one request per 100 tokens). */
async function balancesOf(tokens, wallet) {
  const out = new Map();
  for (let i = 0; i < tokens.length; i += 100) {
    const chunk = tokens.slice(i, i + 100);
    const res = await fetch(RPC, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify(chunk.map((t, j) => ({ jsonrpc: "2.0", id: i + j, method: "eth_call", params: [{ to: t, data: `0x70a08231${pad(wallet)}` }, "latest"] }))),
    });
    const list = await res.json().catch(() => null);
    if (!Array.isArray(list)) throw new Error("couldn't read your wallet's balances from BNB Chain; try again");
    for (const r of list) {
      if (r?.result && r.result !== "0x") out.set(tokens[r.id].toLowerCase(), BigInt(r.result));
    }
  }
  return out;
}

/** The tokenized stocks this wallet holds, with a rough USD value from the live token price. */
export async function holdings(wallet) {
  const all = await tokenList();
  const bal = await balancesOf(all.map((t) => t.contractAddress), wallet);
  return all
    .map((t) => {
      const units = bal.get(t.contractAddress.toLowerCase()) ?? 0n;
      if (units === 0n) return null;
      const amount = formatUnits(units, t.decimals, 6);
      return { ticker: t.ticker, symbol: t.symbol, name: t.name, icon: t.icon, contractAddress: t.contractAddress, decimals: t.decimals,
        amount, usd: t.tokenPrice != null ? Math.round(Number(amount) * t.tokenPrice * 100) / 100 : null };
    })
    .filter(Boolean)
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
}

/**
 * Build one swap for the browser wallet: a fresh quote (they live ~30s), the
 * order, and an approval of the token being paid only if the current
 * allowance is too low. Any approval is simulated first so the user sees what
 * it will do. Buying pays USDT for a stock; selling pays the stock for USDT.
 */
async function prepareSwap({ ticker, from, fromDecimals, to, toDecimals, amount, approveAmount, wallet, slippagePercent = "1" }) {
  const route = await bestRoute({ from, to, amount, wallet });
  const built = await buildSwap({ from, to, amount, wallet, quoteId: route.quoteId, slippagePercent });
  const mode = built.executionMode ?? route.executionMode;

  let spender = null, approveData = null;
  if (mode === "RFQ") {
    const extra = (built.rfq?.signatureData ?? []).map((s) => { try { return JSON.parse(s); } catch { return null; } }).find(Boolean);
    spender = extra?.approveContract ?? null;
    approveData = extra?.approveTxCalldata ?? null;
    // The vendor-specific approval endpoint lets us approve the whole basket;
    // the calldata bundled with the order only covers this one stock.
    const a = (await approveTx({ token: from, amount: approveAmount, vendor: built.rfq?.vendor ?? route.vendorName }).catch(() => null))?.[0];
    if (a?.dexContractAddress && a?.data && (!spender || a.dexContractAddress.toLowerCase() === spender.toLowerCase())) {
      spender = a.dexContractAddress;
      approveData = a.data;
    }
  } else {
    // DEX route: the router to approve is in tx.signatureData[0] or the quote's
    // approveTarget; the approve endpoint also names it, so fall back to that.
    spender = [built.tx?.signatureData?.[0], route.approveTarget].find(isAddress) ?? null;
    const a = (await approveTx({ token: from, amount: approveAmount }))?.[0];
    if (a?.data && (!spender || !isAddress(a.dexContractAddress) || a.dexContractAddress.toLowerCase() === spender.toLowerCase())) {
      spender = spender ?? a.dexContractAddress;
      approveData = a.data;
    }
    if (!spender || !approveData) throw new Error("couldn't find which contract to approve for this swap");
  }

  let approve = null;
  const current = spender ? await allowance(from, wallet, spender).catch(() => 0n) : 0n;
  if (spender && approveData && current < BigInt(amount)) {
    const sim = await simulate({ from: wallet, to: from, data: approveData }).catch((e) => ({ status: "UNKNOWN", failReason: String(e.message ?? e) }));
    approve = { to: from, data: approveData, spender, simulation: { status: sim?.status ?? null, failReason: sim?.failReason ?? null } };
  }

  const out = {
    ticker, mode, vendor: built.rfq?.vendor ?? built.routerResult?.vendorName ?? route.vendorName, approve,
    allowance: spender ? { spender, current: formatUnits(current, fromDecimals, 2), needed: formatUnits(amount, fromDecimals, 2) } : null,
    receive: formatUnits(built.routerResult?.toTokenAmount ?? route.toTokenAmount, toDecimals, 6),
  };
  if (mode === "RFQ") {
    out.rfq = { typedData: decodeTypedData(built.rfq?.typedDataToSign), vendor: built.rfq?.vendor, orderId: built.rfq?.orderId ?? route.quoteId, signingScheme: built.rfq?.signingScheme ?? null };
  } else {
    const tx = built.tx ?? {};
    out.tx = { from: wallet, to: tx.to, data: tx.data, value: tx.value ?? "0", gas: tx.gas ?? null };
  }
  return out;
}

/** One basket leg: pay `leg.usd` of USDT for the stock token. */
export function prepareLeg(leg, wallet, slippagePercent = "1", approveUsd = leg.usd) {
  return prepareSwap({
    ticker: leg.ticker, from: USDT_BSC, fromDecimals: USDT_DECIMALS, to: leg.contractAddress, toDecimals: leg.decimals,
    amount: usdToUnits(leg.usd),
    // Approve the rest of the basket at once, so it is one approval, not one per stock.
    approveAmount: usdToUnits(Math.max(approveUsd, leg.usd)),
    wallet, slippagePercent,
  });
}

/**
 * Sell a wallet's whole holding of one stock token back to USDT. Binance
 * won't route an order of $5 or less, so tiny holdings are refused up front.
 */
export async function prepareSell(ticker, wallet, slippagePercent = "1") {
  const t = (await tokenList()).find((x) => x.ticker === String(ticker ?? "").toUpperCase());
  if (!t) throw Object.assign(new Error("unknown stock"), { status: 400 });
  const units = await tokenBalance(t.contractAddress, wallet);
  if (units === 0n) throw Object.assign(new Error(`this wallet holds no ${t.symbol}`), { status: 400 });
  const usd = t.tokenPrice != null ? Number(formatUnits(units, t.decimals, 6)) * t.tokenPrice : null;
  if (usd != null && usd <= 5) throw Object.assign(new Error(`this holding is worth about ${usd.toFixed(2)} USD, and Binance only routes orders over 5 USD`), { status: 400 });
  const leg = { ticker: t.ticker, symbol: t.symbol, contractAddress: t.contractAddress, decimals: t.decimals, usd: usd != null ? Math.round(usd * 100) / 100 : null };
  const prepared = await prepareSwap({
    ticker: t.ticker, from: t.contractAddress, fromDecimals: t.decimals, to: USDT_BSC, toDecimals: USDT_DECIMALS,
    amount: units.toString(), approveAmount: units.toString(), wallet, slippagePercent,
  });
  return { leg, prepared: { ...prepared, sellAmount: formatUnits(units, t.decimals, 6), symbol: t.symbol } };
}

export function submitLeg({ requestId, signature, vendor, orderId, signingScheme }) {
  return submitRfq({ requestId, signature, vendor, quoteId: orderId, signingScheme: signingScheme ?? undefined });
}

export const orderStatus = (orderId) => rfqStatus(orderId);
