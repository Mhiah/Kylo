#!/usr/bin/env node
/**
 * Kylo one-tap web app. Runs on YOUR machine next to the signed-in `baw`
 * CLI, serves the page in client/web/, and turns taps into wallet actions:
 *
 *   GET  /api/wallet            → Agentic Wallet status + address
 *   POST /api/plan  {theme,usd} → pays Kylo over x402, returns plan + quotes
 *   POST /api/buy   {planId}    → buys every leg of that plan, returns receipt
 *
 *   KYLO_AGENT_URL=https://<agent> node client/server.mjs   # then open http://localhost:4402
 *
 * Binds to 127.0.0.1 only: anything that can reach this port can spend from
 * the wallet (within its Binance limits), so it must never be exposed.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baw, buyLegs, getPlan, quoteLegs } from "./lib.mjs";

const PORT = Number(process.env.PORT ?? 4402);
const AGENT = process.env.KYLO_AGENT_URL ?? "http://localhost:8080";
const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "web");
const PLAN_TTL_MS = 5 * 60 * 1000;
const plans = new Map(); // planId → { plan, slippage, at, bought }

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const routes = {
  "GET /api/wallet": async () => {
    const status = await baw("wallet", "status");
    const address = await baw("wallet", "address").catch(() => null);
    return { status, address, agent: AGENT };
  },
  "POST /api/plan": async (body) => {
    const { theme, usd, maxLegs, allowEarnings, slippage } = body;
    if (!theme || !(Number(usd) > 0)) throw httpError(400, "theme and a positive usd are required");
    const { plan, payment } = await getPlan(AGENT, { theme, usd, maxLegs, allowEarnings });
    const quotes = plan.legs.length ? await quoteLegs(plan, slippage) : [];
    const planId = randomUUID();
    plans.set(planId, { plan, slippage, at: Date.now(), bought: false });
    return { planId, plan, payment, quotes, expiresInSec: PLAN_TTL_MS / 1000 };
  },
  "POST /api/buy": async (body) => {
    const entry = plans.get(body.planId);
    if (!entry) throw httpError(404, "plan not found; plan again");
    if (entry.bought) throw httpError(409, "this plan was already bought");
    if (Date.now() - entry.at > PLAN_TTL_MS) throw httpError(410, "plan expired; prices and halts may have changed, plan again");
    entry.bought = true; // one tap = one buy, even if the button is double-clicked
    const results = await buyLegs(entry.plan, entry.slippage);
    return { results };
  },
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = routes[`${req.method} ${url.pathname}`];
  try {
    if (route) {
      const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
      return send(res, 200, JSON.stringify(await route(body)), "application/json");
    }
    if (req.method !== "GET") return send(res, 405, "method not allowed");
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (file.includes("..")) return send(res, 400, "bad path");
    const data = await readFile(join(WEB, file)).catch(() => null);
    if (!data) return send(res, 404, "not found");
    return send(res, 200, data, TYPES[extname(file)] ?? "application/octet-stream");
  } catch (e) {
    return send(res, e.status ?? 500, JSON.stringify({ error: String(e.message ?? e).slice(0, 500) }), "application/json");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Kylo one-tap app on http://localhost:${PORT} (agent: ${AGENT})`);
});

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function send(res, status, body, type = "text/plain") {
  res.writeHead(status, { "Content-Type": type });
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
