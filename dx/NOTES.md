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

## 2026-10-04 — one-tap app

- Agentic Wallet is a CLI (`baw`), so a browser page cannot call it directly. The one-tap web app needs a small local server next to the signed-in CLI. A browser or WalletConnect-style SDK for Agentic Wallet would remove that step.
- The RWA Dynamic API has no on-chain liquidity. You need a second API on a different host (`web3.binance.com` `.../token/dynamic/info/ai`) for liquidity and on-chain volume, and its kline lives on a third host (`dquery.sintral.io`) with a different candle format from the RWA kline.
- `companyInfo.homepageUrl` can be an empty string rather than null.
- The B402 merchant application needs the agent wallet address, an RSA public key (1024-bit, per the Studio skill reference) and a fixed egress IP allowlist, and production and sandbox are separate applications. None of this is on the hackathon page. A self-hosted AgentCore deploy has floating egress, so it needs a separate fixed-IP relay just to be allowlisted.
- The developer docs page never says how to generate the RSA key. Only the Studio CLI's bundled skill reference (`bnbagent-studio-selling-via-b402.md`) has the openssl commands.

## 2026-10-04 — testing from Nigeria, then moving to the official Web3 API

- **Country access:** from Nigeria (home Wi-Fi and a mobile hotspot), `www.binance.com` and `web3.binance.com` don't resolve at all (ISP DNS block). `baw auth signin` fails with `[50001004] Host not found (www.binance.com)`. BSC RPCs (`*.bnbchain.org`) work fine. Nigeria isn't on the hackathon's restricted list, yet a builder there can't use Agentic Wallet or call the Web3 API from their own machine. We gave up the Agentic Wallet prize for this reason and host the API-calling server in Singapore.
- **Agentic Wallet sign-in has one path only:** a QR/pairing code confirmed in the Binance Wallet app, through binance.com. There is no email, key or offline option.
- `baw` installs `@github/keytar`, whose install script npm skips by default ("npm warn install-scripts"). It isn't clear whether credentials then fall back to a file.
- **Web3 API docs vs SDK:** the official Python connector (`binance-web3-connector-python`) is the clearest reference for paths and signing. The signing pre-hash lives in a different package (`binance_common.web3_signature`): `timestamp + METHOD + "/build" + path + "?" + query + compactJsonBody`.
- The Python connector sends GET signing correctly, but its `get_token_trading_info` (`POST /dex/market/price-info`) passes an empty body. The request body shape for batch endpoints isn't in the generated method, so we guessed an array of `{binanceChainId, tokenContractAddress}`.
- RWA token list `tabId` (1–13) gives Binance's own sectors (AI Chips, Energy, Magnificent 7, Buffett Portfolio…). That's a great fit for theme baskets, and it's undocumented outside the SDK docstrings.
- Field description bug in the SDK: `underlyingTicker` is described as "Token decimals."; `isHoneyPot` also as "Token decimals."; `gasPrice` as "Gas limit estimate."
- Ondo tokens trade through **RFQ** routes: `/quote` needs `userWalletAddress`, `/swap` returns EIP-712 `typedDataToSign` described as "a hex string (or JSON-encoded string)". The test fixture shows `0x1901…`, which looks like a raw digest, not typed data, and browser wallets can't sign that with `eth_signTypedData_v4`. Our code accepts JSON or hex-encoded JSON and refuses a raw digest.
- RFQ approval data comes back as a JSON string inside `rfq.signatureData[0]` (`{"approveContract","approveTxCalldata"}`), sized for one swap only. The separate `/approve-transaction?vendor=` endpoint lets you approve a whole basket once.
