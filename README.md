# Kylo

Every tokenized US stock on BNB Chain in one searchable list. Open any stock to see **Kylo's take** (what the company is, reasons to consider it, reasons to hold off, and what's different about holding the token), add the ones you like, and buy the whole basket in one tap. Stocks halted for earnings, splits or dividends are left out automatically.

Built for [BNB Hack: Tokenized Stocks Edition](https://www.bnbchain.org/en/hackathons/tokenized-stocks).

## How it works

```
you ── "put $50 into AI stocks" ──▶ Claude + Agentic Wallet skill (client/)
                                         │ 1. POST /x402  → 402 Payment Required
                                         │ 2. baw x402-payment preview + sign (USDT on BSC)
                                         │ 3. replay with PAYMENT-SIGNATURE
                                         ▼
                              Kylo agent on BNB Agent Studio (app/agent/)
                              ERC-8004 identity, paid per request over x402
                              plan = Binance Web3 RWA data, deterministic code:
                                theme → tokenized tickers on BSC
                                → per-asset market status (skip paused / earnings)
                                → equal-weight legs, reference share price
                                         │
                                         ▼ basket plan (JSON)
                              baw market-order quote → (confirm) → swap → poll to FINISHED
```

- **Agent Studio:** the seller agent in `app/agent/`, scaffolded with `bag init`. The basket logic lives in `src/stocks.ts`. JSON requests skip the LLM entirely, and free-text requests go through the LLM, which may only call `plan_basket`.
- **One-tap app:** `client/server.mjs` + `client/web/index.html`.
  - Browse and search every Ondo tokenized stock on BSC (by company, ticker, industry or theme tag), sort by size or 24h move, and filter with theme presets (AI, semis, big tech, energy, dividends, crypto, EV).
  - **Kylo's take** per stock (free): a 90-day chart, 52-week range, P/E, dividend, company size, on-chain liquidity and holders, then plain-language "reasons to consider", "reasons to hold off" and token notes from visible rules in `client/data.mjs`, plus a quick read ("Looks steady", "Mixed picture", "Handle with care").
  - **Deeper take** (paid over x402 from Agentic Wallet): the Kylo agent's LLM explains the same live snapshot in plain English, with no price targets and no buy/sell instructions.
  - **Basket tray:** add stocks one by one or a whole theme, pick an amount, **Plan basket** (pays Kylo, shows legs, left-out stocks with reasons, and quotes), then **Buy basket**. The receipt shows each leg's final order status and a BscScan link.
- **Agentic Wallet / Wallet Skills:** `client/lib.mjs` (shared by the app and `client/kylo-buy.mjs`) pays the agent with `baw x402-payment` and buys each leg with `baw market-order`. `client/skills/kylo-basket/SKILL.md` lets Claude drive it from a sentence.
- **Binance Web3 API:** public RWA endpoints (token list, market status, per-asset status, dynamic price and multiplier), plus Agentic Wallet quotes and swaps.

## Run it

```bash
pnpm install
pnpm --dir app/agent test              # planner unit tests

# agent (see AGENTS.md / `bag doctor` for wallet + LLM setup)
cd app/agent && bag wallet new --generate-password && cd ../..
bag llm activate
bag dev                                # local; set payments.seller.price_usd = "0" for free local testing

# buyer
npm i -g @binance/agentic-wallet && baw auth signin

# one-tap web app (runs on your machine next to the signed-in baw; binds to localhost only)
KYLO_AGENT_URL=http://localhost:8080 node client/server.mjs   # open http://localhost:4402

# or the CLI
node client/kylo-buy.mjs --agent http://localhost:8080 --theme ai --usd 20             # quotes only
node client/kylo-buy.mjs --agent http://localhost:8080 --theme ai --usd 20 --execute   # buys
```

Every API and CLI call is timed into `dx/calls.jsonl` as raw material for the Developer Experience Report.
