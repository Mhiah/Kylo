---
name: kylo-basket
description: Buy a themed basket of tokenized US stocks (AI, semis, big tech, energy, dividends) on BNB Chain with the user's Binance Agentic Wallet, using the Kylo agent's paid basket plan.
---

# Kylo basket

Use when the user asks to buy, plan or price a themed basket of tokenized stocks, e.g. "put $50 into AI stocks" or "what would a $20 semis basket look like?".

Requires the `binance-agentic-wallet` skill and a signed-in `baw` CLI (`baw wallet status --json`).

## Steps

1. Map the request to a theme (`ai`, `semis`, `bigtech`, `energy`, `dividends`) and a USD amount. Ask only if the amount is missing.
2. Check the wallet: `baw wallet status --json`, then `baw wallet balance --json`. The basket is funded in USDT on BSC (chain 56); if the balance is below the amount plus the Kylo fee, stop and say so.
3. Get a dry-run plan and quotes (this pays Kylo's small x402 fee from the Agentic Wallet, nothing else):
   `node client/kylo-buy.mjs --agent "$KYLO_AGENT_URL" --theme <theme> --usd <amount>`
4. Show the user the legs, every skipped stock with its reason (earnings, split, dividend, not on BSC), and any market-closed note. Tokenized stocks trade 24/7 but price gaps widen while US markets are closed.
5. Only after the user explicitly confirms, buy: re-run with `--execute`. Report each leg from its terminal order status (`FINISHED` or `FAILED`), never from the submit response.

## Rules

- Never execute without the user's confirmation in this conversation.
- Never change the theme's tickers or invent contract addresses; they come from Kylo's plan.
- Spending stays inside the daily limit and token scope the user set in the Binance app; if `baw` reports the limit is reached, say so and stop.
- The plan is information, not investment advice.
