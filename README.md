# Kylo

Every tokenized US stock on BNB Chain in one searchable list. Pick a theme (Binance's own sectors: AI chips, Magnificent 7, Energy, Buffett picks…), open any stock to see **Kylo's take** (what the company is, reasons to consider it, reasons to hold off, and what's different about holding the token), and buy the whole basket from your own wallet. Stocks halted for earnings, splits or dividends are left out automatically.

Built for [BNB Hack: Tokenized Stocks Edition](https://www.bnbchain.org/en/hackathons/tokenized-stocks).

## How it works

```
browser (any wallet: MetaMask, Trust, Binance Wallet…)
   │  browse, Kylo's take, plan basket
   ▼
Kylo web server (client/, hosted on Render in Singapore, holds only API keys)
   │  official Binance Web3 API, signed with HMAC (client/web3api.mjs)
   │    RWA Data     token list + sector tabs, underlying profile & market data
   │    General Data candles, on-chain trading info, top liquidity pools
   │    Trading      quote → build order (RFQ for Ondo stocks) → submit → status
   │    Transaction  simulate the USDT approval before the user signs it
   ▼
plan = deterministic code: theme → Binance sector tab → skip paused/earnings
       → equal-weight legs to the cent
   │
   ▼  per stock: user signs one EIP-712 order in their wallet
      (plus one USDT approval for the whole basket, if needed)
Binance RFQ vendor settles on BNB Chain → receipt with BscScan links

Kylo agent on BNB Agent Studio (app/agent/): ERC-8004 identity, writes the
plain-English "written take" with its LLM from facts the server passes in.
```

- **Web app:** `client/server.mjs` + `client/web/index.html`.
  - Browse and search every Ondo tokenized stock and ETF on BSC, sort by size or 24h move, and filter by Binance's sector tabs.
  - **Kylo's take** per stock (free): a 90-day chart, 52-week range, P/E, dividend, company size, on-chain liquidity and holders, then plain-language "reasons to consider", "reasons to hold off" and token notes from visible rules in `client/data.mjs`, plus a quick read ("Looks steady", "Mixed picture", "Handle with care").
  - **Written take:** the Kylo agent's LLM explains the same live data in plain English, with no price targets and no buy/sell instructions. Shown when `KYLO_AGENT_URL` is set.
  - **Basket tray:** add stocks one by one or a whole theme, pick an amount, **Plan basket** (legs, left-out stocks with reasons, live quotes, your USDT balance), then **Buy basket**. The receipt shows each order's final settlement status and a BscScan link.
- **Never holds keys:** the server only has Binance Web3 API keys. Every purchase is signed in the user's own wallet, and the user can reject any order.
- **Agent Studio:** the seller agent in `app/agent/`, scaffolded with `bag init`. JSON requests skip the LLM for planning (`src/stocks.ts`), and the insight route accepts facts from the web server so the agent works wherever it is hosted.

## Run it

```bash
# web app (needs a Binance Web3 API key from https://web3.binance.com/en/dev-portal)
KYLO_W3_API_KEY=… KYLO_W3_API_SECRET=… node client/server.mjs   # open http://localhost:4402
node --test client/test/*.test.mjs                               # client unit tests

# agent (see AGENTS.md / `bag doctor` for wallet + LLM setup)
pnpm install
pnpm --dir app/agent test
cd app/agent && bag wallet new --generate-password && cd ../..
bag llm activate
bag dev        # local; then set KYLO_AGENT_URL=http://localhost:8080 for the web app
```

### Deploy the web app on Render (free)

`render.yaml` is a Render Blueprint: free plan, Singapore region (the Binance Web3 API isn't reachable from every country). In Render choose **New → Blueprint**, pick this repo and branch, and paste `KYLO_W3_API_KEY` and `KYLO_W3_API_SECRET` when asked. Leave `KYLO_AGENT_URL` empty until the agent is deployed.

Every Binance Web3 API call is timed into `dx/calls.jsonl` (never with keys or signatures) as raw material for the Developer Experience Report.
