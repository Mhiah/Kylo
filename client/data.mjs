/**
 * Public tokenized-stock data for the one-tap app (no API key, no payment):
 * the full BSC token list with company info and live prices, plus the
 * rule-based "insight box" for each token.
 *
 * Mirrors the endpoints in app/agent/src/stocks.ts; kept separate because the
 * agent is deployed on its own and this runs on the user's machine.
 */

const BAPI = process.env.KYLO_BAPI ?? "https://www.binance.com/bapi/defi";
const WEB3 = process.env.KYLO_WEB3 ?? "https://web3.binance.com/bapi/defi";
const HEADERS = { "Accept-Encoding": "identity", "User-Agent": "binance-web3/1.1 (Skill)" };
export const BSC = "56";
const ICON_BASE = "https://bin.bnbstatic.com";

const cache = new Map(); // key → { at, value }
async function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function getJson(base, path, query = {}) {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  const body = await res.json();
  if (body.success === false || (body.code && body.code !== "000000")) {
    throw new Error(`${path} → code ${body.code} ${body.message ?? ""}`.trim());
  }
  return body.data;
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]).catch(() => null);
    }
  }));
  return out;
}

const q = (t) => ({ chainId: t.chainId, contractAddress: t.contractAddress });
const listTokens = () => cached("list", 10 * 60_000, () =>
  getJson(BAPI, "/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai", { type: "1" }));
const meta = (t) => cached(`meta:${t.contractAddress}`, 24 * 3600_000, () =>
  getJson(BAPI, "/v1/public/wallet-direct/buw/wallet/market/token/rwa/meta/ai", q(t)));
const rwaDynamic = (t) => cached(`dyn:${t.contractAddress}`, 60_000, () =>
  getJson(BAPI, "/v2/public/wallet-direct/buw/wallet/market/token/rwa/dynamic/ai", q(t)));
const assetStatus = (t) => cached(`status:${t.contractAddress}`, 60_000, () =>
  getJson(BAPI, "/v1/public/wallet-direct/buw/wallet/market/token/rwa/asset/market/status/ai", q(t)));
const onchain = (t) => cached(`chain:${t.contractAddress}`, 60_000, () =>
  getJson(WEB3, "/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info/ai", q(t)));
const kline = (t) => cached(`kline:${t.contractAddress}`, 30 * 60_000, () =>
  getJson(BAPI, "/v1/public/wallet-direct/buw/wallet/dex/market/token/kline/ai", { ...q(t), interval: "1d", limit: "90" }));
export const marketStatus = () => cached("market", 60_000, () =>
  getJson(BAPI, "/v1/public/wallet-direct/buw/wallet/market/token/rwa/market/status/ai"));

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

async function bscTokens() {
  return (await listTokens()).filter((t) => t.chainId === BSC);
}

async function findToken(ticker) {
  const t = (await bscTokens()).find((x) => x.ticker.toUpperCase() === String(ticker).toUpperCase());
  if (!t) throw Object.assign(new Error(`no tokenized ${ticker} on BSC`), { status: 404 });
  return t;
}

function shareStatus(s) {
  if (!s) return { label: "Unknown", tone: "muted" };
  if (s.reasonCode === "ASSET_PAUSED") return { label: `Paused · ${s.reasonMsg ?? "corporate action"}`, tone: "bad" };
  if (s.reasonCode === "ASSET_LIMITED") return { label: s.reasonMsg === "earnings" ? "Earnings" : "Limited", tone: "warn" };
  if (s.reasonCode === "MARKET_MAINTENANCE") return { label: "Maintenance", tone: "bad" };
  if (s.openState) return { label: s.marketStatus === "regular" ? "Open" : `Open · ${s.marketStatus}`, tone: "good" };
  return { label: "Closed", tone: "muted" };
}

/** The browsable list: every Ondo token on BSC with name, tags and live price. */
export async function tokenList() {
  const tokens = await bscTokens();
  const [metas, dyns] = await Promise.all([pool(tokens, 8, meta), pool(tokens, 8, rwaDynamic)]);
  return tokens.map((t, i) => {
    const m = metas[i], d = dyns[i];
    const mult = num(d?.tokenInfo?.sharesMultiplier ?? t.multiplier) || 1;
    const price = num(d?.tokenInfo?.price);
    return {
      ticker: t.ticker,
      symbol: t.symbol,
      contractAddress: t.contractAddress,
      name: m?.companyInfo?.companyName || m?.name || t.ticker,
      icon: m?.icon ? ICON_BASE + m.icon : null,
      industry: m?.companyInfo?.industry ?? null,
      tags: m?.companyInfo?.conceptsEn ?? [],
      sharePrice: price !== null ? price / mult : null,
      change24hPct: num(d?.tokenInfo?.priceChangePct24h),
      stockMarketCap: num(d?.stockInfo?.marketCap),
      status: shareStatus(d?.statusInfo?.reasonCode ? d.statusInfo : null),
    };
  });
}

/** Full detail for one token plus Kylo's rule-based insight box. */
export async function tokenDetail(ticker) {
  const t = await findToken(ticker);
  const [m, d, s, c, k] = await Promise.all([meta(t), rwaDynamic(t), assetStatus(t), onchain(t).catch(() => null), kline(t).catch(() => null)]);
  const mult = num(d?.tokenInfo?.sharesMultiplier ?? t.multiplier) || 1;
  const tokenPrice = num(d?.tokenInfo?.price);
  const closes = (k?.klineInfos ?? []).map((row) => num(row[4])).filter((x) => x !== null).map((p) => p / mult);
  const facts = {
    ticker: t.ticker,
    symbol: t.symbol,
    contractAddress: t.contractAddress,
    multiplier: mult,
    name: m?.companyInfo?.companyName || m?.name || t.ticker,
    icon: m?.icon ? ICON_BASE + m.icon : null,
    description: m?.companyInfo?.description ?? null,
    ceo: m?.companyInfo?.ceo ?? null,
    industry: m?.companyInfo?.industry ?? null,
    tags: m?.companyInfo?.conceptsEn ?? [],
    homepage: m?.companyInfo?.homepageUrl || null,
    attestation: m?.monthlyAttestationReports ? ICON_BASE + m.monthlyAttestationReports : null,
    sharePrice: tokenPrice !== null ? tokenPrice / mult : null,
    stockPrice: num(d?.stockInfo?.price),
    change24hPct: num(d?.tokenInfo?.priceChangePct24h),
    high52w: num(d?.stockInfo?.priceHigh52w),
    low52w: num(d?.stockInfo?.priceLow52w),
    pe: num(d?.stockInfo?.priceToEarnings),
    dividendYieldPct: num(d?.stockInfo?.dividendYield),
    stockMarketCap: num(d?.stockInfo?.marketCap),
    holders: num(d?.tokenInfo?.totalHolders),
    onchainLiquidityUsd: num(c?.liquidity),
    onchainVolume24hUsd: num(c?.volume24h),
    status: shareStatus(s),
    statusRaw: s,
    closes90d: closes,
  };
  return { ...facts, insight: insightFor(facts) };
}

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
  else if (s?.reasonCode === "ASSET_LIMITED" && s.reasonMsg === "earnings") holdOff.push("Earnings are being released, so trading is restricted and the price can jump either way.");
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
  if (f.pe !== null) {
    if (f.pe <= 0) holdOff.push("Not currently profitable (no positive P/E).");
    else if (f.pe < 15) consider.push(`P/E of ${f.pe.toFixed(0)}: priced low relative to its earnings.`);
    else if (f.pe > 40) holdOff.push(`P/E of ${f.pe.toFixed(0)}: priced high relative to its earnings, so expectations are high.`);
  }
  if (f.dividendYieldPct !== null && f.dividendYieldPct >= 2) {
    consider.push(`Pays dividends (${f.dividendYieldPct.toFixed(1)}% a year). On-chain, those are reinvested into the token.`);
  }
  if (f.stockMarketCap !== null && f.stockMarketCap >= 200e9) consider.push(`One of the largest companies in the US (${usd(f.stockMarketCap)}).`);

  // Things specific to holding the token rather than the share.
  if (f.onchainLiquidityUsd !== null) {
    if (f.onchainLiquidityUsd < 50_000) holdOff.push(`Thin on-chain liquidity (${usd(f.onchainLiquidityUsd)}). Even small buys can move the price.`);
    else if (f.onchainLiquidityUsd >= 1_000_000) consider.push(`Deep on-chain liquidity (${usd(f.onchainLiquidityUsd)}), so buys fill close to the quoted price.`);
  }
  if (f.holders !== null && f.holders < 100) token.push(`Only ${f.holders} on-chain holders so far.`);
  if (f.sharePrice !== null && f.stockPrice) {
    const gap = ((f.sharePrice - f.stockPrice) / f.stockPrice) * 100;
    if (Math.abs(gap) >= 0.5) token.push(`The token trades ${gap > 0 ? "above" : "below"} the real share price by ${Math.abs(gap).toFixed(1)}%.`);
  }
  if (f.multiplier > 1.0001) token.push(`One token = ${f.multiplier.toFixed(4)} shares (dividends and splits are built in).`);

  const score = consider.length - holdOff.length;
  const blocked = s?.reasonCode === "ASSET_PAUSED";
  const read = blocked
    ? { label: "Can't buy right now", tone: "bad" }
    : score >= 2 ? { label: "Looks steady", tone: "good" }
    : score <= -2 ? { label: "Handle with care", tone: "warn" }
    : { label: "Mixed picture", tone: "muted" };

  return { read, consider, holdOff, token };
}
