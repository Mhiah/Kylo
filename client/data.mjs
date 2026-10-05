/**
 * Tokenized-stock data for the Kylo web app, all from the official Binance
 * Web3 API (RWA Data + General Data modules): the full BSC list, Binance's
 * own sector tabs as one-tap themes, per-stock detail, and Kylo's rule-based
 * insight box.
 */
import { BSC, candles, rwaMarket, rwaProfile, rwaTokens, topPools, tradingInfo } from "./web3api.mjs";

export { BSC };

/**
 * Binance's sector tabs (RWA token list `tabId`), shown as Kylo's themes.
 * The composition comes straight from Binance, so every basket is
 * transparent and reproducible: same tab, same stocks.
 */
export const SECTORS = [
  { tabId: 4, id: "ai-chips", label: "AI chips", fallback: ["NVDA", "AMD", "AVGO", "TSM", "INTC", "QCOM", "MU", "ARM", "ASML", "MRVL"] },
  { tabId: 9, id: "mag7", label: "Magnificent 7", fallback: ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] },
  { tabId: 12, id: "tech", label: "Tech leaders", fallback: ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "ORCL", "CRM", "ADBE", "NFLX"] },
  { tabId: 6, id: "energy", label: "Energy", fallback: ["XOM", "CVX", "COP", "OXY", "SLB", "NEE"] },
  { tabId: 13, id: "buffett", label: "Buffett picks", fallback: ["AAPL", "KO", "BAC", "AXP", "CVX", "OXY", "KHC", "MCO"] },
  { tabId: 10, id: "crypto", label: "Crypto stocks", fallback: ["COIN", "MSTR", "HOOD", "CRCL", "IBIT", "MARA", "RIOT"] },
  { tabId: 11, id: "etf", label: "ETFs", fallback: ["SPY", "QQQ", "IVV", "VOO", "IBIT", "GLD", "TLT"] },
  { tabId: 7, id: "metals", label: "Precious metals", fallback: ["GLD", "SLV", "IAU"] },
  { tabId: 5, id: "storage", label: "Storage", fallback: ["MU", "WDC", "STX", "SNDK"] },
  { tabId: 2, id: "space", label: "Space", fallback: ["RKLB", "ASTS", "LUNR"] },
  { tabId: 8, id: "china", label: "China ADRs", fallback: ["BABA", "PDD", "JD", "BIDU", "NIO"] },
];

const cache = new Map(); // key → { at, value }
async function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export function shareStatus(s) {
  if (!s) return { label: "Unknown", tone: "muted" };
  if (s.reasonCode === "ASSET_PAUSED") return { label: `Paused · ${s.reasonMsg ?? "corporate action"}`, tone: "bad" };
  if (s.reasonCode === "ASSET_LIMITED") return { label: /earning/i.test(s.reasonMsg ?? "") ? "Earnings" : "Limited", tone: "warn" };
  if (s.reasonCode === "MARKET_MAINTENANCE") return { label: "Maintenance", tone: "bad" };
  if (s.openState) {
    // Binance's session names → plain words (US market hours are 9:30am–4pm New York time)
    const session = { premarket: "before hours", postmarket: "after hours", overnight: "overnight" }[String(s.marketStatus).toLowerCase()];
    return { label: s.marketStatus === "regular" || !s.marketStatus ? "Open" : `Open · ${session ?? s.marketStatus}`, tone: "good" };
  }
  return { label: "Closed", tone: "muted" };
}

/** Shares per token: from the two prices when present, else the published ratio. */
function shareRatio(r) {
  const tp = num(r.tokenPrice), rp = num(r.referencePrice);
  if (tp && rp) return tp / rp;
  return num(r.tokenToShareRatio) || 1;
}

const baseList = () => cached("list", 5 * 60_000, async () =>
  (await rwaTokens()).filter((r) => r.binanceChainId === BSC && (r.assetType === 1 || r.assetType === 3)));

/**
 * ticker → [sector ids], from one RWA list call per Binance sector tab.
 * A tab whose answer is (nearly) the whole list means the filter wasn't
 * applied, so that sector falls back to Kylo's own short list instead of
 * putting every stock in every theme. `sectorSource` records which was used.
 */
export const sectorSource = new Map(); // sector id → "binance" | "kylo"
const sectorMembers = () => cached("sectors", 30 * 60_000, async () => {
  const all = await baseList();
  const out = new Map();
  const add = (ticker, id) => out.set(ticker, [...(out.get(ticker) ?? []), id]);
  for (const s of SECTORS) {
    const rows = await rwaTokens(s.tabId).catch(() => null);
    const tickers = (rows ?? []).filter((r) => r.binanceChainId === BSC).map((r) => r.underlyingTicker?.toUpperCase()).filter(Boolean);
    const filtered = tickers.length > 0 && tickers.length < all.length * 0.5;
    sectorSource.set(s.id, filtered ? "binance" : "kylo");
    for (const t of filtered ? tickers : s.fallback) add(t, s.id);
  }
  return out;
});

export const sectorsInfo = () => SECTORS.map(({ id, label }) => ({ id, label, source: sectorSource.get(id) ?? null }));

/** On-chain 24h change / liquidity / holders, best effort (batch of 100). */
const onchain = (addresses) => cached(`onchain:${addresses.length}:${addresses[0] ?? ""}`, 60_000, async () => {
  const out = new Map();
  for (const part of chunks(addresses, 100)) {
    const rows = await tradingInfo(part).catch(() => []);
    for (const r of rows ?? []) out.set(String(r.tokenContractAddress).toLowerCase(), r);
  }
  return out;
});

function rowToToken(r, sectors, chain) {
  const ticker = String(r.underlyingTicker ?? r.tokenSymbol).toUpperCase();
  const ratio = shareRatio(r);
  const tokenPrice = num(r.tokenPrice);
  return {
    ticker,
    symbol: r.tokenSymbol,
    contractAddress: r.tokenContractAddress,
    decimals: num(r.decimals) ?? 18,
    name: r.underlyingName || r.tokenName || ticker,
    icon: r.tokenLogoUrl || null,
    assetType: r.assetType === 3 ? "ETF" : "Stock",
    sectors: sectors.get(ticker) ?? [],
    tags: r.tags ?? [],
    tokenPrice,
    sharesPerToken: ratio,
    sharePrice: num(r.referencePrice) ?? (tokenPrice !== null ? tokenPrice / ratio : null),
    change24hPct: num(chain?.priceChange24H),
    stockMarketCap: num(r.marketCap),
    pe: num(r.peRatioTTM),
    status: shareStatus(r.statusInfo),
    statusRaw: r.statusInfo ?? null,
  };
}

/** The browsable list: every Ondo stock and ETF on BSC, with Binance's sectors. */
export async function tokenList() {
  const rows = await baseList();
  const [sectors, chain] = await Promise.all([
    sectorMembers().catch(() => new Map()),
    onchain(rows.map((r) => r.tokenContractAddress)).catch(() => new Map()),
  ]);
  return rows.map((r) => rowToToken(r, sectors, chain.get(String(r.tokenContractAddress).toLowerCase())));
}

export async function findToken(ticker) {
  const t = (await tokenList()).find((x) => x.ticker === String(ticker).toUpperCase());
  if (!t) throw Object.assign(new Error(`no tokenized ${ticker} on BSC`), { status: 404 });
  return t;
}

/** Overall market state, read from the first token's status. */
export async function marketStatus() {
  const rows = await baseList();
  const s = rows.find((r) => r.statusInfo)?.statusInfo;
  return s ? { openState: Boolean(s.openState), marketStatus: s.marketStatus, reasonCode: s.reasonCode, nextOpenTime: s.nextOpenTime ?? null } : null;
}

/** Full detail for one token plus Kylo's rule-based insight box. */
export async function tokenDetail(ticker) {
  const t = await findToken(ticker);
  const a = t.contractAddress;
  const [p, m, k, chainRows, pools] = await Promise.all([
    cached(`profile:${a}`, 24 * 3600_000, () => rwaProfile(a)).catch(() => null),
    cached(`market:${a}`, 60_000, () => rwaMarket(a)).catch(() => null),
    cached(`candles:${a}`, 30 * 60_000, () => candles(a, "1d", 90)).catch(() => null),
    cached(`chain:${a}`, 60_000, () => tradingInfo([a])).catch(() => null),
    cached(`pools:${a}`, 10 * 60_000, () => topPools(a)).catch(() => null),
  ]);
  const md = m?.marketData ?? {};
  const c = (chainRows ?? [])[0] ?? null;
  const poolLiquidity = (pools ?? []).reduce((s, x) => s + (num(x.liquidityUsd) ?? 0), 0) || null;
  // Candles are oldest-last or newest-first depending on the source; sort by time.
  const closes = (Array.isArray(k) ? [...k] : [])
    .filter((row) => Array.isArray(row) && row.length >= 6)
    .sort((x, y) => x[5] - y[5])
    .map((row) => num(row[3]))
    .filter((x) => x !== null)
    .map((px) => px / t.sharesPerToken);
  const protections = Object.entries(p?.protections ?? {})
    .filter(([, v]) => v?.supported && v?.url)
    .map(([name, v]) => ({ name: humanize(name), url: v.url }));
  const facts = {
    ...t,
    description: p?.companyInfo?.descriptionEn ?? null,
    ceo: p?.companyInfo?.ceo ?? null,
    industry: p?.companyInfo?.industry ?? null,
    concepts: p?.companyInfo?.conceptsEn ?? [],
    protections,
    high52w: num(md.high52W),
    low52w: num(md.low52W),
    pe: num(md.peRatioTTM) ?? t.pe,
    pb: num(md.pbRatio),
    dividendYieldPct: num(md.dividendYield),
    stockMarketCap: num(md.marketCap) ?? t.stockMarketCap,
    holders: num(c?.holders),
    onchainLiquidityUsd: num(c?.liquidity) ?? poolLiquidity,
    onchainVolume24hUsd: num(c?.volume24H),
    change24hPct: num(c?.priceChange24H) ?? t.change24hPct,
    statusRaw: m?.statusInfo ?? t.statusRaw,
    status: shareStatus(m?.statusInfo ?? t.statusRaw),
    closes90d: closes,
  };
  return { ...facts, insight: insightFor(facts) };
}

const humanize = (s) => String(s).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, (c) => c.toUpperCase());

const usd = (n) => n >= 1e12 ? `$${(n / 1e12).toFixed(1)}T` : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`;

/**
 * Plain rules over live numbers. Each line says what the number is and why it
 * matters; nothing here is a prediction or a recommendation.
 */
export function insightFor(f) {
  const consider = [];
  const holdOff = [];
  const token = [];

  // Trading status first: it decides whether you can buy at all right now.
  const s = f.statusRaw;
  if (s?.reasonCode === "ASSET_PAUSED") holdOff.push(`Trading is paused for a ${s.reasonMsg ?? "corporate action"}, so you can't buy it right now.`);
  else if (s?.reasonCode === "ASSET_LIMITED" && /earning/i.test(s.reasonMsg ?? "")) holdOff.push("Earnings are being released, so trading is restricted and the price can jump either way.");
  else if (s && !s.openState) token.push("The tokenized market is closed right now. Prices may move when it reopens.");

  // Where the price sits in its 52-week range.
  if (f.sharePrice !== null && f.high52w && f.low52w && f.high52w > f.low52w) {
    const pos = (f.sharePrice - f.low52w) / (f.high52w - f.low52w);
    if (pos >= 0.9) {
      consider.push("Trading near its 52-week high, so the recent trend has been strong.");
      holdOff.push("Near its 52-week high, so you'd be buying after a big run-up.");
    } else if (pos <= 0.2) {
      consider.push("Near its 52-week low, so it's cheaper than for most of the past year.");
      holdOff.push("Near its 52-week low. Prices that fall that far sometimes keep falling.");
    }
  }

  // Momentum over the last ~90 days of on-chain closes.
  if (f.closes90d.length >= 20) {
    const first = f.closes90d[0], last = f.closes90d[f.closes90d.length - 1];
    const chg = ((last - first) / first) * 100;
    if (chg >= 15) consider.push(`Up ${chg.toFixed(1)}% over the last ${f.closes90d.length} days.`);
    if (chg <= -15) holdOff.push(`Down ${Math.abs(chg).toFixed(1)}% over the last ${f.closes90d.length} days.`);
  }

  // Valuation and income.
  if (f.pe !== null && f.assetType !== "ETF") {
    if (f.pe <= 0) holdOff.push("Not currently profitable (no positive P/E).");
    else if (f.pe < 15) consider.push(`P/E of ${f.pe.toFixed(0)}: priced low relative to its earnings.`);
    else if (f.pe > 40) holdOff.push(`P/E of ${f.pe.toFixed(0)}: priced high relative to its earnings, so expectations are high.`);
  }
  if (f.dividendYieldPct !== null && f.dividendYieldPct >= 2) {
    consider.push(`Pays dividends (${f.dividendYieldPct.toFixed(1)}% a year). On-chain, those are reinvested into the token.`);
  }
  if (f.stockMarketCap !== null && f.stockMarketCap >= 200e9) consider.push(`One of the largest companies in the US (${usd(f.stockMarketCap)}).`);
  if (f.assetType === "ETF") consider.push("It's an ETF, so one token spreads your money across many companies.");

  // Things specific to holding the token rather than the share.
  if (f.onchainLiquidityUsd !== null) {
    if (f.onchainLiquidityUsd < 50_000) holdOff.push(`Thin on-chain liquidity (${usd(f.onchainLiquidityUsd)}). Even small buys can move the price.`);
    else if (f.onchainLiquidityUsd >= 1_000_000) consider.push(`Deep on-chain liquidity (${usd(f.onchainLiquidityUsd)}), so buys fill close to the quoted price.`);
  }
  if (f.holders !== null && f.holders < 100) token.push(`Only ${f.holders} on-chain holders so far.`);
  if (f.sharesPerToken && Math.abs(f.sharesPerToken - 1) > 0.001) token.push(`One token = ${f.sharesPerToken.toFixed(4)} shares (dividends and splits are built in).`);

  const score = consider.length - holdOff.length;
  const blocked = s?.reasonCode === "ASSET_PAUSED";
  const read = blocked
    ? { label: "Can't buy right now", tone: "bad" }
    : score >= 2 ? { label: "Looks steady", tone: "good" }
    : score <= -2 ? { label: "Handle with care", tone: "warn" }
    : { label: "Mixed picture", tone: "muted" };

  return { read, consider, holdOff, token };
}
