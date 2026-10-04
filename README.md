# Kylo

One tap buys a themed basket of tokenized US stocks on BNB Chain, and stocks halted for earnings, splits or dividends are skipped automatically.

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
- **Agentic Wallet / Wallet Skills:** `client/kylo-buy.mjs` pays the agent with `baw x402-payment` and buys each leg with `baw market-order`. `client/skills/kylo-basket/SKILL.md` lets Claude drive it from a sentence.
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
node client/kylo-buy.mjs --agent http://localhost:8080 --theme ai --usd 20             # quotes only
node client/kylo-buy.mjs --agent http://localhost:8080 --theme ai --usd 20 --execute   # buys
```

Every API and CLI call is timed into `dx/calls.jsonl` as raw material for the Developer Experience Report.
