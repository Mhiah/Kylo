#!/usr/bin/env node
/**
 * Kylo web app server. Serves the page in client/web/ and talks to the
 * official Binance Web3 API with the keys in its environment. It runs on a
 * cloud host (Render, Singapore region) so users anywhere can reach it, and
 * it never holds a private key: buying is signed in the user's own browser
 * wallet.
 *
 *   GET  /api/config                    → chain, agent on/off, data source
 *   GET  /api/tokens                    → every tokenized stock on BSC + Binance sectors
 *   GET  /api/token?ticker=NVDA         → detail + Kylo's rule-based take
 *   POST /api/take   {ticker}           → Kylo agent's written take (LLM)
 *   POST /api/plan   {tickers|theme, usd, wallet?} → plan + live quotes
 *   POST /api/leg    {planId, index}    → one order to sign (+ approval if needed)
 *   POST /api/submit {planId, index, signature} → hand a signed order to Binance
 *   GET  /api/order?id=…                → order settlement status
 *   GET  /api/holdings?wallet=0x…       → the stock tokens a wallet holds
 *   POST /api/sell   {ticker, wallet}   → sell a whole holding back to USDT (order to sign)
 *
 *   KYLO_W3_API_KEY=… KYLO_W3_API_SECRET=… node client/server.mjs   # http://localhost:4402
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marketStatus, sectorsInfo, tokenDetail, tokenList } from "./data.mjs";
import { holdings, isAddress, orderStatus, planBasket, prepareLeg, prepareSell, quoteLegs, submitLeg, usdtBalance, formatUnits } from "./trade.mjs";
import { hasKeys } from "./web3api.mjs";

const PORT = Number(process.env.PORT ?? 4402);
// Render sets RENDER=true; a public host must listen on all interfaces.
const HOST = process.env.HOST ?? (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const AGENT = process.env.KYLO_AGENT_URL ?? "";
const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "web");
const PLAN_TTL_MS = 10 * 60 * 1000;
const plans = new Map(); // planId → { plan, wallet, at, legs: [{ requestId, prepared, orderId }] }

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

function planEntry(planId, index) {
  const entry = plans.get(planId);
  if (!entry) throw httpError(404, "plan not found; plan again");
  if (Date.now() - entry.at > PLAN_TTL_MS) throw httpError(410, "plan expired; prices may have changed, plan again");
  const leg = entry.plan.legs[index];
  if (!leg) throw httpError(400, "no such stock in this plan");
  return { entry, leg, state: entry.legs[index] };
}

const routes = {
  "GET /api/config": async () => ({
    chainId: 56, chainHex: "0x38", dataSource: "Binance Web3 API", keys: hasKeys(), agent: Boolean(AGENT), sectors: sectorsInfo(),
  }),
  "GET /api/tokens": async () => ({ tokens: await tokenList(), sectors: sectorsInfo(), market: await marketStatus().catch(() => null) }),
  "GET /api/token": async (_b, url) => tokenDetail(url.searchParams.get("ticker") ?? ""),
  "POST /api/take": async (body) => {
    if (!AGENT) throw httpError(503, "Kylo's agent isn't switched on yet");
    if (!body.ticker) throw httpError(400, "ticker is required");
    const facts = await tokenDetail(body.ticker);
    delete facts.closes90d; // keep the prompt small; the rules already summarise the trend
    const take = await askAgent({ action: "insight", ticker: facts.ticker, facts });
    if (take?.error) throw httpError(502, take.error);
    return { take };
  },
  "POST /api/plan": async (body) => {
    const { theme, tickers, usd, maxLegs, allowEarnings } = body;
    const wallet = isAddress(body.wallet) ? body.wallet : null;
    const plan = await planBasket({ theme, tickers, usd, maxLegs, allowEarnings });
    const quotes = wallet && plan.legs.length ? await quoteLegs(plan, wallet) : [];
    const balance = wallet ? await usdtBalance(wallet).then((b) => formatUnits(b, 18, 2)).catch(() => null) : null;
    const planId = randomUUID();
    plans.set(planId, { plan, wallet, at: Date.now(), legs: plan.legs.map(() => ({ requestId: randomUUID(), prepared: null, orderId: null })) });
    for (const [id, e] of plans) if (Date.now() - e.at > PLAN_TTL_MS) plans.delete(id);
    return { planId, plan, quotes, wallet, usdtBalance: balance, expiresInSec: PLAN_TTL_MS / 1000 };
  },
  "POST /api/leg": async (body) => {
    const { entry, leg, state } = planEntry(body.planId, Number(body.index));
    if (!entry.wallet) throw httpError(400, "connect a wallet and plan again");
    if (state.orderId) throw httpError(409, "this stock was already ordered");
    const index = Number(body.index);
    const restUsd = entry.plan.legs.slice(index).reduce((sum, l) => sum + l.usd, 0);
    state.prepared = await prepareLeg(leg, entry.wallet, body.slippagePercent, restUsd);
    return state.prepared;
  },
  "POST /api/submit": async (body) => {
    const { state } = planEntry(body.planId, Number(body.index));
    if (!state.prepared?.rfq) throw httpError(400, "prepare this order first");
    if (state.orderId) return { orderId: state.orderId, status: "ALREADY_SUBMITTED" };
    if (!/^0x[0-9a-fA-F]{130}$/.test(body.signature ?? "")) throw httpError(400, "bad signature");
    const r = await submitLeg({ requestId: state.requestId, signature: body.signature, ...state.prepared.rfq });
    state.orderId = r?.orderId ?? null;
    return r;
  },
  "GET /api/order": async (_b, url) => orderStatus(url.searchParams.get("id") ?? ""),
  "GET /api/holdings": async (_b, url) => {
    const wallet = url.searchParams.get("wallet");
    if (!isAddress(wallet)) throw httpError(400, "connect a wallet first");
    return { wallet, holdings: await holdings(wallet) };
  },
  "POST /api/sell": async (body) => {
    if (!isAddress(body.wallet)) throw httpError(400, "connect a wallet first");
    const { leg, prepared } = await prepareSell(body.ticker, body.wallet, body.slippagePercent);
    // A one-leg "plan", so a signed sell order goes through the same /api/submit.
    const planId = randomUUID();
    plans.set(planId, { plan: { legs: [leg] }, wallet: body.wallet, at: Date.now(), legs: [{ requestId: randomUUID(), prepared, orderId: null }] });
    return { planId, index: 0, ...prepared };
  },
};

async function askAgent(promptObj) {
  const res = await fetch(AGENT.replace(/\/$/, "") + "/x402", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: JSON.stringify(promptObj) }),
    signal: AbortSignal.timeout(120_000), // the free model can take a minute
  });
  const text = await res.text();
  if (!res.ok) throw httpError(502, `Kylo's agent answered ${res.status}`);
  let out = text;
  try { const j = JSON.parse(text); out = j.result ?? j.output ?? j.text ?? j; } catch { /* plain text */ }
  if (typeof out === "string") { try { return JSON.parse(out); } catch { return { summary: out }; } }
  return out;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = routes[`${req.method} ${url.pathname}`];
  try {
    if (route) {
      const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
      return send(res, 200, JSON.stringify(await route(body, url)), "application/json");
    }
    if (url.pathname === "/healthz") return send(res, 200, "ok");
    if (url.pathname === "/api/logo" && req.method === "GET") return sendLogo(res, url.searchParams.get("u"));
    if (req.method !== "GET") return send(res, 405, "method not allowed");
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (file.includes("..")) return send(res, 400, "bad path");
    const data = await readFile(join(WEB, file)).catch(() => null);
    if (!data) return send(res, 404, "not found");
    return send(res, 200, data, TYPES[extname(file)] ?? "application/octet-stream");
  } catch (e) {
    return send(res, e.status ?? 500, JSON.stringify({ error: String(e.message ?? e).slice(0, 500) }), "application/json");
  }
}).listen(PORT, HOST, () => {
  console.log(`Kylo on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT} (Web3 API keys ${hasKeys() ? "set" : "MISSING"}, agent ${AGENT || "off"})`);
});

// Stock logos live on Binance's image host, which some ISPs block.
// Kylo's server fetches them instead, from Binance's image hosts only.
const LOGO_HOSTS = new Set(["onchainos.bnbstatic.com", "bin.bnbstatic.com", "public.bnbstatic.com"]);
const LOGO_MAX_BYTES = 512 * 1024;
const logoCache = new Map(); // url → { type, body }, oldest first
async function sendLogo(res, raw) {
  let u;
  try { u = new URL(String(raw ?? "")); } catch { return send(res, 400, "bad logo url"); }
  if (u.protocol !== "https:" || !LOGO_HOSTS.has(u.hostname)) return send(res, 400, "logo host not allowed");
  const key = u.href;
  let hit = logoCache.get(key);
  if (!hit) {
    const r = await fetch(key, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r?.ok) return send(res, 404, "no logo");
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > LOGO_MAX_BYTES) return send(res, 404, "logo too big");
    // Some logos come back as application/octet-stream, so trust the file's own bytes.
    const type = imageType(body);
    if (!type) return send(res, 404, "no logo");
    hit = { type, body };
    logoCache.set(key, hit);
    if (logoCache.size > 600) logoCache.delete(logoCache.keys().next().value);
  }
  res.writeHead(200, { "Content-Type": hit.type, "Cache-Control": "public, max-age=604800, immutable", "X-Content-Type-Options": "nosniff" });
  res.end(hit.body);
}

function imageType(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function send(res, status, body, type = "text/plain") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}
