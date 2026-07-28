/**
 * The three data sources behind the token table, and why each is needed.
 *
 *  Balancer  — what an LP actually receives. `IB_YIELD` divided by the token's
 *              share of pool value gives that token's standalone APR, and it is
 *              self-validating: independent pools holding the same token return
 *              the same number (rETH 1.98% from two pools, waEthWETH 1.33/1.35).
 *              It is already NET of the protocol yield fee — confirmed twice by
 *              comparing against measured wrapper rate growth (ratio ~0.9,
 *              matching aggregateYieldFee = 0.1).
 *  DefiLlama — splits the lending side into apyBase (the real rate) and
 *              apyReward (incentives on the lending market). Balancer gives one
 *              blended figure, so this is the only way to separate them.
 *  Merkl     — campaigns that reward HOLDING the token. Invisible to both of the
 *              above: not compounded into the wrapper's rate, and not a lending
 *              supply reward. Crucially their `forwarders` list says whether the
 *              reward can reach the LPs of a pool holding the token.
 */

const BAL_API = 'https://api-v3.balancer.fi/graphql'
const LLAMA_YIELDS = 'https://yields.llama.fi/pools'
const MERKL_API = 'https://api.merkl.xyz/v4/opportunities'

export const MIN_TVL_USD = 20000
export const EXCLUDED_CHAINS = ['SONIC', 'MODE', 'FRAXTAL', 'SEPOLIA']

// Balancer chain enum → Merkl numeric chain id / DefiLlama chain label.
export const CHAIN_META = {
  MAINNET:   { short: 'ETH',   name: 'Ethereum',  merkl: 1,     llama: 'Ethereum' },
  BASE:      { short: 'BASE',  name: 'Base',      merkl: 8453,  llama: 'Base' },
  ARBITRUM:  { short: 'ARB',   name: 'Arbitrum',  merkl: 42161, llama: 'Arbitrum' },
  OPTIMISM:  { short: 'OP',    name: 'Optimism',  merkl: 10,    llama: 'Optimism' },
  POLYGON:   { short: 'POLY',  name: 'Polygon',   merkl: 137,   llama: 'Polygon' },
  AVALANCHE: { short: 'AVAX',  name: 'Avalanche', merkl: 43114, llama: 'Avalanche' },
  GNOSIS:    { short: 'GNO',   name: 'Gnosis',    merkl: 100,   llama: 'Gnosis' },
  FANTOM:    { short: 'FTM',   name: 'Fantom',    merkl: 250,   llama: 'Fantom' },
  ZKEVM:     { short: 'ZKEVM', name: 'zkEVM',     merkl: 1101,  llama: 'Polygon zkEVM' },
  MONAD:     { short: 'MON',   name: 'Monad',     merkl: 143,   llama: 'Monad' },
  PLASMA:    { short: 'PLAS',  name: 'Plasma',    merkl: 9745,  llama: 'Plasma' },
  HYPEREVM:  { short: 'HYPE',  name: 'HyperEVM',  merkl: 999,   llama: 'Hyperliquid L1' },
}

/**
 * Liquid staking / savings tokens carry a rate provider rather than an ERC4626
 * wrapper, so the API exposes no `underlyingToken` for them. Without this the
 * "show me everything backed by ETH" filter — the most useful one — silently
 * misses every LST. Values are marked `inferred` in the UI so they never read
 * as sourced data.
 */
export const INFERRED_UNDERLYING = {
  reth: 'ETH', oseth: 'ETH', sweth: 'ETH', wsteth: 'ETH', steth: 'ETH',
  cbeth: 'ETH', ankreth: 'ETH', sfrxeth: 'ETH', frxeth: 'ETH', ethx: 'ETH',
  weeth: 'ETH', rseth: 'ETH', teth: 'ETH', theth: 'ETH', msteth: 'ETH',
  sdai: 'DAI', susde: 'USDe', susds: 'USDS', sfrax: 'FRAX',
  savax: 'AVAX', savax_: 'AVAX', ggavax: 'AVAX',
  thype: 'HYPE', sthype: 'HYPE', wsthype: 'HYPE',
  shmon: 'MON', gmon: 'MON', smon: 'MON',
}

async function gql(query, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res
    try {
      res = await fetch(BAL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
    } catch (e) {
      if (attempt >= retries) throw e
      await new Promise((r) => setTimeout(r, Math.min(8000, 600 * 2 ** attempt)))
      continue
    }
    if (res.status === 429 || res.status === 503) {
      if (attempt >= retries) throw new Error('Balancer API is rate-limiting requests.')
      await new Promise((r) => setTimeout(r, Math.min(8000, 600 * 2 ** attempt)))
      continue
    }
    if (!res.ok) throw new Error(`Balancer API ${res.status}`)
    const json = await res.json()
    if (json.errors?.length) throw new Error(`Balancer API: ${json.errors[0].message}`)
    return json.data
  }
}

/** Pools across every protocol version, minus Balancer's own blacklist. */
export async function fetchBalancerPools() {
  const data = await gql(`{
    poolGetPools(first: 1000, orderBy: totalLiquidity, orderDirection: desc,
                 where: {protocolVersionIn: [1, 2, 3], minTvl: ${MIN_TVL_USD},
                         chainNotIn: [${EXCLUDED_CHAINS.join(', ')}],
                         tagNotIn: ["BLACK_LISTED"]}) {
      address chain name protocolVersion
      dynamicData {
        totalLiquidity aggregateYieldFee
        aprItems { type apr rewardTokenAddress rewardTokenSymbol }
      }
      poolTokens {
        symbol address name balanceUSD isErc4626 priceRate isExemptFromProtocolYieldFee
        underlyingToken { address symbol }
        priceRateProviderData { name }
      }
    }
  }`)
  return data.poolGetPools || []
}

/**
 * Every live Merkl opportunity on the chains we cover.
 * `items` is capped at 100 by the API, so this pages through.
 */
export async function fetchMerklOpportunities(chains, { log = () => {} } = {}) {
  const out = []
  for (const chain of chains) {
    const id = CHAIN_META[chain]?.merkl
    if (!id) continue
    let got = 0
    for (let page = 0; page < 12; page++) {
      let res
      try {
        res = await fetch(`${MERKL_API}?chainId=${id}&items=100&page=${page}&status=LIVE`, {
          headers: { accept: 'application/json' },
        })
      } catch {
        break
      }
      if (!res.ok) break
      const arr = await res.json().catch(() => [])
      const list = Array.isArray(arr) ? arr : Object.values(arr)
      for (const o of list) out.push({ ...o, balChain: chain })
      got += list.length
      if (list.length < 100) break
    }
    log(`  merkl ${chain}: ${got} live`)
  }
  return out
}

/** Campaign detail, for the `forwarders` list that decides flow-through. */
export async function fetchMerklForwarders(opportunityId) {
  try {
    const res = await fetch(`${MERKL_API}/${opportunityId}?campaigns=true`, {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const j = await res.json()
    const camps = j.campaigns || []
    let forwarders = 0
    let whitelist = 0
    for (const c of camps) {
      forwarders += (c.params?.forwarders || []).length
      whitelist += (c.params?.whitelist || []).length
    }
    return { campaigns: camps.length, forwarders, whitelist }
  } catch {
    return null
  }
}

/** DefiLlama yields — the only source that splits base rate from incentives. */
export async function fetchLlamaYields() {
  const res = await fetch(LLAMA_YIELDS, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`DefiLlama ${res.status}`)
  const j = await res.json()
  return j.data || j.pools || []
}
