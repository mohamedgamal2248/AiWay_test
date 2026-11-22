# Pricing, credits and profit

Run `node scripts/pricing-report.mjs` for the live numbers (it reads the Pi price from OKX).

## How a token is priced

- **1 AiWay token = $0.00001 of Meta cost** (`TOKEN_USD`). Every request is charged exactly Meta's
  published price converted to tokens: `ceil(providerUsd / TOKEN_USD)`, minimum 1 token.
  Ember: $0.10 / $0.50 per million input / output tokens (×3 input above 200K, which AiWay avoids),
  web search $2.50 per 1,000 queries, Muse Image $0.01 per image. Reasoning tokens are billed as output.
- **Packages are sold at 2×** (`PROVIDER_BUDGET_SHARE = 0.5`): a $10 package gives 500,000 tokens, whose
  Meta cost is $5. Defaults (code): Lite $2, Starter $5, Plus $10, Pro $20. The `payment_packages`
  table in your database overrides them; edit packages in the admin panel.
- **Pi amount** = `usd / PI_USD × 1.05`. `PI_USD` comes from **OKX PI-USDT** (Gate.io, then MEXC, only if OKX
  is down; a quote up to 10 minutes old survives a total outage). The signed quote is valid 5 minutes. The 5%
  buffer is kept by you. The package cards show the exact amount rounded **up** to the cent (it used to be
  rounded down, e.g. "38 Pi" for a 38.34 Pi payment).

## Profit (live example, Pi = $0.0548)

| Package    | You pay        | Pi to pay | Meta cost if fully used | Gross profit |
| ---------- | -------------- | --------- | ----------------------- | ------------ |
| Lite $2    | 100,000 tokens | 38.34     | $1.00                   | $1.10 (52%)  |
| Starter $5 | 250,000        | 95.86     | $2.50                   | $2.75        |
| Plus $10   | 500,000        | 191.71    | $5.00                   | $5.50        |
| Pro $20    | 1,000,000      | 383.42    | $10.00                  | $11.00       |

Gross profit ≈ 52% of the USD value received. Tokens that are never used are 100% profit.

| Action                            | Meta cost | User pays |
| --------------------------------- | --------- | --------- |
| Short chat reply                  | $0.0003   | $0.0007   |
| Long answer / code                | $0.0026   | $0.0052   |
| Chat + web search                 | $0.0037   | $0.0075   |
| 1 image                           | $0.0100   | $0.0200   |
| Pi App Builder, small app         | $0.0112   | $0.0224   |
| General Agent, file → Excel + PDF | $0.0057   | $0.0114   |

## What is NOT covered by the margin (your real costs and risks)

- **Free trial:** each new user gets 10 free uses. Per run caps: chat $0.008, Pi App Builder $0.012,
  General Agent $0.010 → worst case **$0.12 per new user** (typical: a few cents). Change with
  `AGENT_TRIAL_BUDGET_USD`, or lower the trial count in the database.
- **Pi price risk:** you receive Pi, not dollars. If you hold it and it falls more than ~52% before you sell, a
  fully used package loses money; sell soon after purchases to remove the risk. Exchange/withdrawal fees on
  OKX and Pi Mainnet transfers are not modelled.
- **Failed runs:** if Meta answers but AiWay then fails (storage/database error) the user is not charged but you
  still pay Meta. A run can also never charge more than it reserved; any overrun is absorbed.
- **Fixed costs:** Vercel, Supabase and (optionally) Telegram are not in these numbers.
- **Expiry:** balances expire after 30 days (database policy); expired tokens are pure profit.
- **Affordability:** Lite is 38 Pi (~$2.10). Many Pi users hold only a few Pi, so consider a ~$0.50 package
  (~10 Pi, 25,000 tokens: about 35 chats or 12 small agent runs). Packages are a business decision, so the
  catalog was not changed.
