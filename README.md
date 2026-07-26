# @solinkify/mcp

MCP (Model Context Protocol) server that lets any AI agent — Claude Desktop,
Claude Code, Cursor, or your own MCP host — **pay for things on Solana through
Solinkify**, with hard spending caps. Agentic payments on the x402 standard,
as a set of tools your agent already knows how to call:

- **Gate (x402 paywalls):** preview prices, auto-pay HTTP 402 content, manage a
  pre-paid balance, buy subscriptions.
- **DataHub:** search the dataset marketplace and buy datasets (99% goes to the
  seller, download link returned).
- **Pay:** inspect and settle store checkout sessions (WooCommerce, OpenCart,
  PrestaShop, hosted checkout).
- **Social Commerce:** inspect and buy products from Blink links exactly as
  they circulate on X (share link, Actions URL, or raw id).

## Quick start

Add to your MCP host config (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "solinkify": {
      "command": "npx",
      "args": ["-y", "@solinkify/mcp"],
      "env": {
        "SOLINKIFY_WALLET_PATH": "/path/to/agent-keypair.json",
        "SOLINKIFY_MAX_PAYMENT_USD": "1",
        "SOLINKIFY_DAILY_CAP_USD": "10"
      }
    }
  }
}
```

The wallet is a standard Solana JSON keypair (`solana-keygen new -o agent-keypair.json`),
funded with a little SOL for fees and the stablecoin you want to spend
(USDC/USDT/PYUSD).

It is optional at startup: the server connects and lists its tools with no wallet
configured, and the read-only tools (price preview, dataset search, checkout
quotes) work as they are. Only the tools that spend ask for a keypair, and they
say so in the tool result rather than failing at launch.

### Docker

```bash
docker build -t solinkify-mcp .
docker run -i --rm solinkify-mcp                         # starts, tools listed
docker run -i --rm -v "$PWD/agent-keypair.json:/wallet.json:ro" \
  -e SOLINKIFY_WALLET_PATH=/wallet.json solinkify-mcp    # able to pay
```

`-i` is required: stdin and stdout carry the MCP protocol.

## Tools

| Tool | What it does |
|---|---|
| `wallet_status` | Address, SOL, stablecoin balances, prepaid balance, remaining budget |
| `gate_get_price` | Preview an x402 paywall without paying |
| `gate_fetch` | Fetch gated content, auto-paying (prepaid preferred, escrow otherwise) |
| `gate_prepaid_balance` / `gate_prepaid_deposit` | Manage the pre-paid balance (no per-request signing) |
| `gate_subscribe` | Buy a creator's subscription plan (price read on-chain first) |
| `datahub_search` | Search the DataHub marketplace (results carry `attested` + `quality_score`) |
| `datahub_buy` | Buy a dataset and get the download link |
| `datahub_review` | Rate a dataset you bought (verified-purchase gated server-side) |
| `datahub_subscribe` | Time-based access to a recurring dataset (on-chain plan; renew extends expiry) |
| `datahub_download` | Fresh download link via purchase receipt or active subscription (no payment) |
| `pay_get_session` | Inspect a checkout session (accepts the full checkout URL) |
| `pay_checkout` | Pay a pending checkout session; the merchant's order is marked paid |
| `social_get_blink` | Inspect a Blink product link (title, price, seller) without paying |
| `social_buy_blink` | Buy from a Blink link; returns the receipt + download link |

## Authorization model

Moving money was never the hard part; **scoped, revocable authority** is. The
agent never holds your main wallet: it runs on a dedicated keypair funded only
with what it is allowed to spend (the outer bound), and the server enforces
two hard caps **before any funds move**, on every tool:

- `SOLINKIFY_MAX_PAYMENT_USD` — max for a single payment (default `1`)
- `SOLINKIFY_DAILY_CAP_USD` — max total per UTC day (default `10`, persisted
  in `~/.solinkify/mcp-spend.json`, fail-closed)

For Gate paywalls there is an on-chain scoped budget too: a prepaid balance is
deposited once into a program-owned account and debited per request at
on-chain prices; `withdraw_prepaid` pulls the remainder back at any time — the
kill switch. Delegated on-chain spend authority (allowance + revoke enforced
by the program itself) is on the pre-mainnet contract roadmap.

Refusals come back as readable messages the agent can relay to the user. The
server also self-identifies as an AI agent via User-Agent (override with
`SOLINKIFY_USER_AGENT`), so Gate-protected sites answer with a clean 402
instead of being scraped.

## Environment

| Var | Default | Purpose |
|---|---|---|
| `SOLINKIFY_WALLET_PATH` / `SOLINKIFY_WALLET_BS58` | — (required) | Agent wallet |
| `SOLANA_RPC_URL` | devnet public RPC | Solana RPC |
| `SOLINKIFY_NETWORK` | `devnet` | `mainnet-beta` switches mints + default RPC |
| `SOLINKIFY_API_URL` | `https://api.solinkify.com` | Solinkify backend |
| `SOLINKIFY_MAX_PAYMENT_USD` | `1` | Per-payment cap |
| `SOLINKIFY_DAILY_CAP_USD` | `10` | Daily budget |

## QA

`scripts/qa-battery.mjs` drives every tool through a real MCP stdio client
against live devnet; `scripts/qa-guard-probe.mjs` proves both caps refuse.
