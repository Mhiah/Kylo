# Developer experience raw notes

Raw observations for the Developer Experience Report (25% of the score). The report itself must be written by a human, so these notes are just evidence: what happened, when, and where. Add yours with timestamps as you go.

## 2026-10-04 — first session (cloud container, scaffolding)

- `bag init` (studio-cli 0.0.14): the generated `studio.toml` has comments in Chinese under `[payments.seller]` and nowhere else, which is confusing for an English-language template.
- The `bag init` project name has to be ASCII alphanumeric. Hyphens are rejected rather than auto-renamed, which `--help` says but the hackathon page doesn't.
- **The x402 seller rail needs B402 merchant credentials that are "issued per environment after manual approval"** (`.studio/.env.local`, apply at https://developers.binance.com/en/docs/products/onchainpay-x402/basics/6.apply-developer-account). This is the critical path for a paid demo, and neither the hackathon page nor the Agent Studio landing page mentions it.
- **Network mismatch:** the managed Agent Studio trial (and the hackathon's runtime credits) is testnet only. Agentic Wallet x402 and swaps support BSC mainnet (56), Ethereum, Base and Solana, but not BSC testnet. So "Agentic Wallet pays an Agent Studio agent" can't run end to end on the free trial. Either self-deploy on bsc-mainnet or demo the free path on testnet.
- The RWA token list (`stock/detail/list/ai`) only supports `type=1` (Ondo). bStocks and xStocks aren't in it, even though the hackathon names all three.
- `tokenInfo.volume24h` in RWA Dynamic V2 is US stock volume in USD, not on-chain volume (documented in the skill notes, but the field name is misleading).
- `tokenInfo.price` is per token and not per share. You have to divide by `sharesMultiplier`, and multipliers drift with reinvested dividends.
- The `binance-skills-hub` GitHub tree page is blocked by robots.txt for automated fetchers. `git clone` works.
- Still the first session: the cloud container's egress proxy blocks `www.binance.com`, so live calls must run on a local machine.
