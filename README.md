# Balancer Token Yields

For every yield-bearing token Balancer pools hold in its **vault form**: the rate it generates,
the share Balancer's protocol yield fee takes, and — the point of the page — **what actually
reaches a liquidity provider**.

Live: https://marcusblabs.github.io/balancer-token-yields/

## The finding

Yield advertised on a token does not all arrive.

- **Base lending/staking yield compounds into the token's exchange rate.** `waBasGHO` becomes
  worth more GHO over time, so a pool holding it benefits automatically. This *does* reach LPs,
  less Balancer's 10% protocol yield fee (0% where the token is exempt).
- **Lending-market rewards (`apyReward`) and Merkl campaigns do not.** Both are claimable
  distributions rather than rate accrual. They are credited to whoever *holds* the token — which
  for a pool is the Balancer **Vault** — and no Merkl `forwarder` is configured on any campaign
  checked, so nothing routes them onward to LPs.

`waMonAUSD` is the clearest case: **1.87% reaches an LP** while **10.07% is advertised and never
arrives** (6.25% Aave reward + 3.82% Merkl). `wnUSDT0` advertises ~2.5% and delivers 0.54%.

## Why the numbers can be trusted

"Reaches LP" is Balancer's own `IB_YIELD` attribution divided by the token's share of pool value,
which recovers its standalone rate. Two independent confirmations:

1. **Pools agree with each other.** The same token in different pools returns the same number
   (`rETH` 1.98% from two pools, `waEthWETH` 1.33%/1.35%).
2. **It agrees with the lending market's own quote.** Reversing Balancer's yield fee out of the
   net figure reproduces DefiLlama's `apyBase` to ~0.03pp across eight Aave tokens — e.g.
   `waBasGHO` 4.26% vs 4.27%, `waArbWETH` 0.88% vs 0.88%.

Crucially it reproduces `apyBase` **only**, never `apyBase + apyReward` — which is the evidence
that lending rewards never reach the pool.

## Data

- **Balancer API** — pools, per-token `IB_YIELD`, `aggregateYieldFee`, `isExemptFromProtocolYieldFee`.
- **DefiLlama yields** — splits the lending side into `apyBase` and `apyReward`. Matched on the
  protocol the token actually wraps, never on the underlying alone: matching `waBasGHO` to any
  market quoting GHO picked Fluid's 3.44% over Aave's real 4.26%. **Fails closed** — no confident
  protocol+symbol+chain match shows nothing rather than a wrong number.
- **Merkl v4** — campaigns whose `identifier` IS the token. Campaigns matched via the *underlying*
  are excluded: "Supply USDT0 on any Morpho Market" is real but rewards a different action.
  Each campaign's `forwarders` list decides whether it can reach LPs.

Precomputed nightly into `public/tokens.json` — the Balancer API rate-limits bursty callers and
DefiLlama's payload is ~11 MB; neither belongs in a page load.

## Caveats

- Underlying is only exposed by the API for ERC4626 wrappers. For rate-provider tokens (LSTs) it
  is inferred from a small table and marked `?` in the UI.
- Lending coverage is partial (19 of 64) by design — protocols like Neverland aren't on DefiLlama,
  and a blank is better than a wrong match.
- A `Δ` on the cross-check usually means the token stacks two yield sources (e.g. Lido staking
  inside the wrapper *plus* an Aave supply rate), not that either figure is wrong.

## Run

```bash
npm install
npm run scan     # refresh public/tokens.json
npm run dev
npm run build
npm run deploy
```
