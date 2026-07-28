/**
 * Turn Balancer pools into one row per yield-bearing vault token.
 *
 * The load-bearing step is deriving a token's STANDALONE apr from a pool-level
 * figure. Balancer reports an `IB_YIELD` apr item per pool per token, but that
 * is the token's contribution to the whole pool — roughly its own rate scaled
 * by how much of the pool it represents. Dividing by its share of pool value
 * recovers the standalone rate:
 *
 *     standalone ≈ IB_YIELD_apr / (tokenBalanceUSD / poolTVL)
 *
 * That this is right is not an assumption: pools holding the same token
 * independently return the same answer (rETH 1.98% from two pools, waEthWETH
 * 1.33% and 1.35%). Where several pools disagree we take the median and record
 * the spread, so a bad pool cannot quietly move the number.
 */

import { CHAIN_META, INFERRED_UNDERLYING } from './sources.js'

// Below this share of pool value the division amplifies rounding badly — a
// token that is 0.5% of a pool would turn a 0.01% apr item into a 2% claim.
const MIN_VALUE_SHARE = 0.02
// A rate provider whose rate never exceeds 1 is not paying yield.
const RATE_EPSILON = 1.0000001

const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const isYieldBearing = (t) => t.isErc4626 || +t.priceRate > RATE_EPSILON

/** Group every yield-bearing token across pools, keeping per-pool observations. */
export function extractTokens(pools) {
  const byToken = new Map()

  for (const pool of pools) {
    const tvl = +pool.dynamicData?.totalLiquidity || 0
    if (!(tvl > 0)) continue
    const yieldFee = +pool.dynamicData?.aggregateYieldFee || 0
    const aprItems = pool.dynamicData?.aprItems || []

    for (const t of pool.poolTokens || []) {
      if (!isYieldBearing(t)) continue
      // A composable-stable pool holds its own BPT; that is not a yield token.
      if (t.address.toLowerCase() === pool.address.toLowerCase()) continue

      const key = `${pool.chain}:${t.address.toLowerCase()}`
      const entry = byToken.get(key) || {
        key,
        chain: pool.chain,
        address: t.address.toLowerCase(),
        symbol: t.symbol,
        name: t.name,
        isErc4626: !!t.isErc4626,
        underlying: t.underlyingToken
          ? { symbol: t.underlyingToken.symbol, address: t.underlyingToken.address.toLowerCase(), inferred: false }
          : null,
        rateProvider: t.priceRateProviderData?.name || null,
        priceRate: +t.priceRate || null,
        tvlInPools: 0,
        observations: [],
        pools: [],
      }

      entry.tvlInPools += +t.balanceUSD || 0
      entry.pools.push({ address: pool.address.toLowerCase(), name: pool.name, chain: pool.chain })

      const ib = aprItems.find(
        (a) => a.type === 'IB_YIELD' && a.rewardTokenAddress?.toLowerCase() === t.address.toLowerCase()
      )
      const share = (+t.balanceUSD || 0) / tvl
      if (ib && share >= MIN_VALUE_SHARE) {
        entry.observations.push({
          standalone: (+ib.apr / share) * 100,
          share,
          yieldFee,
          exempt: !!t.isExemptFromProtocolYieldFee,
          pool: pool.name,
        })
      }
      byToken.set(key, entry)
    }
  }
  return byToken
}

/**
 * Collapse a token's per-pool observations into the headline numbers.
 *
 * `reachesLp` is what Balancer's own attribution says an LP earns — already net
 * of the protocol yield fee. `generates` reverses that fee to recover the rate
 * the token itself produces. Exempt tokens keep the whole thing, and the
 * exemption is per token per pool, so it is read from the observations rather
 * than assumed pool-wide.
 */
export function summariseToken(entry) {
  const obs = entry.observations
  const reachesLp = median(obs.map((o) => o.standalone))
  const spread = obs.length > 1
    ? { min: Math.min(...obs.map((o) => o.standalone)), max: Math.max(...obs.map((o) => o.standalone)) }
    : null

  // If any pool exempts the token, that pool's LPs keep the gross rate; report
  // the dominant case and flag disagreement rather than averaging two regimes.
  const exemptCount = obs.filter((o) => o.exempt).length
  const exempt = obs.length ? exemptCount * 2 >= obs.length : false
  const mixedExempt = exemptCount > 0 && exemptCount < obs.length
  const yieldFee = median(obs.map((o) => o.yieldFee)) ?? 0

  const generates = reachesLp == null ? null : exempt ? reachesLp : reachesLp / (1 - yieldFee)
  const balancerCut = generates == null || reachesLp == null ? null : generates - reachesLp

  return {
    ...entry,
    reachesLp,
    generates,
    balancerCut,
    yieldFee,
    exempt,
    mixedExempt,
    spread,
    poolCount: new Set(entry.pools.map((p) => p.address)).size,
    observations: undefined,
    pools: undefined,
  }
}

/** Fill in the underlying for rate-provider tokens the API doesn't describe. */
export function withUnderlying(token) {
  if (token.underlying) return token
  const guess = INFERRED_UNDERLYING[String(token.symbol || '').toLowerCase()]
  return guess
    ? { ...token, underlying: { symbol: guess, address: null, inferred: true } }
    : token
}

/**
 * Which protocol actually produces this token's yield.
 *
 * Read from the wrapper/rate-provider identity, never guessed from the
 * underlying: waBasGHO earns Aave's GHO rate, and matching it to any lending
 * market quoting GHO picked Fluid at 3.44% against Aave's real 4.26%. The
 * underlying tells you WHAT is deposited, not WHERE.
 */
export function detectProtocol(token) {
  const hay = `${token.symbol || ''} ${token.name || ''} ${token.rateProvider || ''}`.toLowerCase()
  if (/\baave\b|stata|^wa[a-z]*[A-Z]?/i.test(hay) || /^wa(eth|bas|arb|opt|mon|pla|ava|gno)/i.test(token.symbol || '')) return 'aave'
  if (/euler|evkvault|^e[a-z]*-\d/i.test(hay)) return 'euler'
  if (/neverland|^wn[a-z]/i.test(hay)) return 'neverland'
  if (/rocket|^reth$/i.test(hay)) return 'rocket-pool'
  if (/stakewise|^oseth$/i.test(hay)) return 'stakewise'
  if (/swell|^sweth$/i.test(hay)) return 'swell'
  if (/lido|^wsteth$|^steth$/i.test(hay)) return 'lido'
  if (/stader|^ethx$/i.test(hay)) return 'stader'
  if (/spark|^sdai$|^susds$/i.test(hay)) return 'spark'
  if (/morpho/i.test(hay)) return 'morpho'
  if (/silo/i.test(hay)) return 'silo'
  if (/fluid/i.test(hay)) return 'fluid'
  if (/treehouse|^teth$|^thype$/i.test(hay)) return 'treehouse'
  return null
}

// DefiLlama `project` slugs that correspond to each protocol.
const LLAMA_PROJECTS = {
  aave: [/^aave-v3$/, /^aave-v2$/],
  euler: [/^euler-v2$/, /^euler$/],
  'rocket-pool': [/^rocket-pool$/],
  stakewise: [/^stakewise$/],
  swell: [/^swell/],
  lido: [/^lido$/],
  stader: [/^stader$/],
  spark: [/^spark/],
  morpho: [/^morpho/],
  silo: [/^silo/],
  fluid: [/^fluid/],
  neverland: [],   // not listed on DefiLlama
  treehouse: [],
}

/**
 * Attach the lending base rate and any lending-market incentives.
 *
 * FAILS CLOSED. A row with no confident protocol+symbol+chain match shows
 * nothing rather than a plausible-looking number from the wrong market — an
 * earlier version happily reported Fluid's rate for an Aave token and
 * SparkLend's 0.00% for wstETH.
 */
export function attachLlama(token, llamaByChain) {
  const meta = CHAIN_META[token.chain]
  const under = token.underlying
  const proto = detectProtocol(token)
  if (!meta || !under || !proto) return token
  const patterns = LLAMA_PROJECTS[proto]
  if (!patterns || !patterns.length) return token

  const wanted = String(under.symbol || '').toLowerCase()
  const pool = (llamaByChain.get(meta.llama) || []).find(
    (p) =>
      patterns.some((re) => re.test(p.project || '')) &&
      String(p.symbol || '').toLowerCase() === wanted
  )
  if (!pool) return token
  return {
    ...token,
    lending: {
      project: pool.project,
      protocol: proto,
      base: pool.apyBase == null ? null : +pool.apyBase,
      reward: pool.apyReward == null ? null : +pool.apyReward,
      tvlUsd: pool.tvlUsd,
    },
  }
}

/**
 * Attach Merkl campaigns that target the token itself.
 *
 * Only campaigns whose `identifier` IS this token count. Matching on the
 * underlying instead would pull in things like "Supply USDT0 on any Morpho
 * Market" — a real campaign, but one that rewards a different action entirely
 * and has nothing to do with holding the vault token in a Balancer pool.
 */
export function attachMerkl(token, merklByKey) {
  const hits = merklByKey.get(`${token.chain}:${token.address}`) || []
  if (!hits.length) return token
  const best = hits.reduce((a, b) => (+b.apr > +a.apr ? b : a))
  return {
    ...token,
    merkl: {
      apr: +best.apr,
      action: best.action,
      name: best.name,
      id: best.id,
      campaigns: hits.length,
      // filled in later by the forwarder lookup
      forwarders: null,
      reachesLp: null,
    },
  }
}
