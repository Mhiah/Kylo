/**
 * Kylo basket engine: tokenized-stock data from the Binance Web3 RWA API and
 * a deterministic thematic-basket planner.
 *
 * Everything here is read-only and public (no API key). The planner is plain
 * code, not LLM output, so the same inputs always give the same plan and a
 * halted stock can never slip into a basket because a model said so.
 */

const RWA_BASE = "https://www.binance.com/bapi/defi";
const HEADERS = {
  "Accept-Encoding": "identity",
  "User-Agent": "binance-web3/1.1 (Skill)",
};

/** BSC mainnet. Agentic Wallet trades here; the RWA API reports Ondo tokens on 1 and 56. */
export const BSC_CHAIN_ID = "56";
/** BSC-USD (USDT) — the default funding token for a basket. */
export const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";

export const THEMES: Record<string, { label: string; tickers: string[] }> = {
  ai: {
    label: "AI leaders",
    tickers: ["NVDA", "MSFT", "GOOGL", "META", "AMD", "PLTR", "AVGO"],
  },
  semis: {
    label: "Semiconductors",
    tickers: ["NVDA", "AMD", "AVGO", "TSM", "INTC", "QCOM", "MU", "ARM"],
  },
  bigtech: {
    label: "Big Tech",
    tickers: ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA"],
  },
  energy: {
    label: "Energy",
    tickers: ["XOM", "CVX", "COP", "OXY", "SLB", "NEE"],
  },
  dividends: {
    label: "Dividend payers",
    tickers: ["KO", "PEP", "JNJ", "PG", "XOM", "CVX", "ABBV"],
  },
};

export interface StockToken {
  chainId: string;
  contractAddress: string;
  symbol: string;
  ticker: string;
  type: number;
  multiplier: string;
}

export interface AssetStatus {
  openState: boolean;
  marketStatus: string;
  reasonCode: string;
  reasonMsg: string | null;
  nextOpenTime: number | null;
  nextCloseTime: number | null;
}

export interface BasketLeg {
  ticker: string;
  symbol: string;
  contractAddress: string;
  weight: number;
  usd: number;
  tokenPrice: number | null;
  referenceSharePrice: number | null;
  marketStatus: string;
}

export interface SkippedLeg {
  ticker: string;
  reason: string;
}

export interface BasketPlan {
  theme: string;
  label: string;
  chainId: string;
  fundingToken: string;
  totalUsd: number;
  legs: BasketLeg[];
  skipped: SkippedLeg[];
  marketOpen: boolean;
  generatedAt: string;
  notes: string[];
}

async function getJson<T>(path: string, query: Record<string, string> = {}): Promise<T> {
  const url = new URL(RWA_BASE + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`RWA API ${path} → HTTP ${res.status}`);
  const body = (await res.json()) as { code: string; data: T; success: boolean; message?: string };
  if (!body.success || body.code !== "000000") {
    throw new Error(`RWA API ${path} → code ${body.code} ${body.message ?? ""}`.trim());
  }
  return body.data;
}

export function listStockTokens(): Promise<StockToken[]> {
  return getJson("/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai", {
    type: "1",
  });
}

export function marketStatus(): Promise<AssetStatus> {
  return getJson("/v1/public/wallet-direct/buw/wallet/market/token/rwa/market/status/ai");
}

export function assetStatus(chainId: string, contractAddress: string): Promise<AssetStatus> {
  return getJson("/v1/public/wallet-direct/buw/wallet/market/token/rwa/asset/market/status/ai", {
    chainId,
    contractAddress,
  });
}

export function assetDynamic(chainId: string, contractAddress: string): Promise<{
  symbol: string;
  ticker: string;
  tokenInfo: { price: string | null; sharesMultiplier: string | null };
  statusInfo: Partial<AssetStatus>;
}> {
  return getJson("/v2/public/wallet-direct/buw/wallet/market/token/rwa/dynamic/ai", {
    chainId,
    contractAddress,
  });
}

export function assetMeta(chainId: string, contractAddress: string): Promise<{
  name: string;
  ticker: string;
  companyInfo?: { companyName?: string; description?: string; industry?: string; ceo?: string; conceptsEn?: string[] };
}> {
  return getJson("/v1/public/wallet-direct/buw/wallet/market/token/rwa/meta/ai", { chainId, contractAddress });
}

/** Everything Kylo knows about one ticker on BSC, for the LLM's deeper take. */
export async function tokenSnapshot(ticker: string): Promise<Record<string, unknown>> {
  const tokens = await listStockTokens();
  const t = tokens.find((x) => x.chainId === BSC_CHAIN_ID && x.ticker.toUpperCase() === ticker.toUpperCase());
  if (!t) throw new Error(`no tokenized ${ticker} on BSC`);
  const [meta, dynamic, status] = await Promise.all([
    assetMeta(t.chainId, t.contractAddress).catch(() => null),
    assetDynamic(t.chainId, t.contractAddress).catch(() => null),
    assetStatus(t.chainId, t.contractAddress).catch(() => null),
  ]);
  return { token: t, company: meta?.companyInfo ?? null, market: dynamic, status };
}

/** Why a leg cannot be bought right now, or null if it can. */
export function blockReason(s: AssetStatus, allowEarnings: boolean): string | null {
  if (s.reasonCode === "ASSET_PAUSED") return `paused (${s.reasonMsg ?? "corporate action"})`;
  if (s.reasonCode === "ASSET_LIMITED") {
    if (s.reasonMsg === "earnings" && allowEarnings) return null;
    return `limited (${s.reasonMsg ?? "restricted"})`;
  }
  if (s.reasonCode === "UNSUPPORTED") return "unsupported";
  if (s.reasonCode === "MARKET_MAINTENANCE") return "maintenance";
  return null;
}

export interface BasketRequest {
  /** A preset theme id, or omit and pass `tickers` for a hand-picked basket. */
  theme?: string;
  tickers?: string[];
  usd: number;
  maxLegs?: number;
  allowEarnings?: boolean;
  exclude?: string[];
}

export async function planBasket(req: BasketRequest): Promise<BasketPlan> {
  const custom = (req.tickers ?? []).map((t) => t.trim().toUpperCase()).filter(Boolean);
  const theme = custom.length
    ? { label: "Custom basket", tickers: [...new Set(custom)] }
    : THEMES[(req.theme ?? "").toLowerCase()];
  if (!theme) {
    throw new Error(`unknown theme "${req.theme}"; choose one of ${Object.keys(THEMES).join(", ")} or pass tickers`);
  }
  if (theme.tickers.length > 20) throw new Error("at most 20 tickers per basket");
  if (!(req.usd > 0)) throw new Error("usd must be positive");
  const maxLegs = Math.max(1, Math.min(req.maxLegs ?? (custom.length || 5), 20));
  const exclude = new Set((req.exclude ?? []).map((t) => t.toUpperCase()));

  const [tokens, market] = await Promise.all([listStockTokens(), marketStatus()]);
  const onBsc = new Map(
    tokens.filter((t) => t.chainId === BSC_CHAIN_ID).map((t) => [t.ticker.toUpperCase(), t]),
  );

  const skipped: SkippedLeg[] = [];
  const candidates: StockToken[] = [];
  for (const ticker of theme.tickers) {
    if (exclude.has(ticker)) skipped.push({ ticker, reason: "excluded by request" });
    else if (!onBsc.has(ticker)) skipped.push({ ticker, reason: "no tokenized version on BSC" });
    else candidates.push(onBsc.get(ticker)!);
  }

  const checked = await Promise.all(
    candidates.map(async (t) => {
      const [status, dyn] = await Promise.all([
        assetStatus(t.chainId, t.contractAddress),
        assetDynamic(t.chainId, t.contractAddress).catch(() => null),
      ]);
      return { t, status, dyn };
    }),
  );

  const buyable = [];
  for (const c of checked) {
    const reason = blockReason(c.status, req.allowEarnings ?? false);
    if (reason) skipped.push({ ticker: c.t.ticker, reason });
    else buyable.push(c);
  }
  const chosen = buyable.slice(0, maxLegs);
  for (const c of buyable.slice(maxLegs)) {
    skipped.push({ ticker: c.t.ticker, reason: `over max legs (${maxLegs})` });
  }

  // Equal weight, rounded to cents; the last leg absorbs the rounding.
  const legs: BasketLeg[] = [];
  let allocated = 0;
  chosen.forEach((c, i) => {
    const weight = 1 / chosen.length;
    const usd =
      i === chosen.length - 1
        ? Math.round((req.usd - allocated) * 100) / 100
        : Math.floor(req.usd * weight * 100) / 100;
    allocated += usd;
    const price = num(c.dyn?.tokenInfo.price);
    const mult = num(c.dyn?.tokenInfo.sharesMultiplier ?? c.t.multiplier);
    legs.push({
      ticker: c.t.ticker,
      symbol: c.t.symbol,
      contractAddress: c.t.contractAddress,
      weight: round(weight, 4),
      usd,
      tokenPrice: price,
      referenceSharePrice: price !== null && mult ? round(price / mult, 4) : null,
      marketStatus: c.status.marketStatus,
    });
  });

  const notes: string[] = [];
  if (!market.openState) {
    notes.push(
      `Tokenized-stock market is not open (${market.reasonCode ?? "closed"}); swaps may fail or fill at a gap until ${
        market.nextOpenTime ? new Date(market.nextOpenTime).toISOString() : "next open"
      }.`,
    );
  }
  if (legs.length === 0) notes.push("No leg is buyable right now; nothing to execute.");

  return {
    theme: custom.length ? "custom" : (req.theme ?? "").toLowerCase(),
    label: theme.label,
    chainId: BSC_CHAIN_ID,
    fundingToken: USDT_BSC,
    totalUsd: round(allocated, 2),
    legs,
    skipped,
    marketOpen: market.openState,
    generatedAt: new Date().toISOString(),
    notes,
  };
}

function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
