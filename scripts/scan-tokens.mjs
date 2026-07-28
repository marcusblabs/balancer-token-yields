/**
 * Build the token-yield table: public/tokens.json.
 *
 * Precomputed rather than fetched in the browser for two reasons — the Balancer
 * API rate-limits bursty callers behind Cloudflare, and DefiLlama's yields
 * payload is ~11 MB. Both are fine once a night in CI; neither belongs in a
 * page load.
 *
 * Run: npm run scan
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const LIB = pathToFileURL(path.join(ROOT, 'src/lib/')).href

const S = await import(LIB + 'sources.js')
const T = await import(LIB + 'tokens.js')

const started = Date.now()
const pct = (v, dp = 2) => (v == null ? '—' : (v >= 0 ? '' : '') + v.toFixed(dp) + '%')

console.log('fetching Balancer pools…')
const pools = await S.fetchBalancerPools()
console.log(`  ${pools.length} pools (TVL ≥ $${S.MIN_TVL_USD.toLocaleString()}, blacklist applied)`)

const raw = T.extractTokens(pools)
console.log(`  ${raw.size} yield-bearing vault tokens`)

let tokens = [...raw.values()].map(T.summariseToken).map(T.withUnderlying)

// ---- DefiLlama: base rate vs lending incentives ----
console.log('fetching DefiLlama yields…')
let llamaByChain = new Map()
try {
  const all = await S.fetchLlamaYields()
  for (const p of all) {
    if (!llamaByChain.has(p.chain)) llamaByChain.set(p.chain, [])
    llamaByChain.get(p.chain).push(p)
  }
  console.log(`  ${all.length} pools across ${llamaByChain.size} chains`)
} catch (e) {
  console.log(`  ! DefiLlama unavailable (${e.message}) — base/reward split will be blank`)
}
tokens = tokens.map((t) => T.attachLlama(t, llamaByChain))

// Two independent derivations of the same quantity: ours (Balancer's yield
// attribution, de-weighted and un-netted) and DefiLlama's quote from the
// lending market itself. Where both exist, agreement is real evidence the
// chain is sound — and disagreement is worth surfacing rather than hiding.
for (const t of tokens) {
  if (t.generates == null || t.lending?.base == null) continue
  const diff = Math.abs(t.generates - t.lending.base)
  const rel = diff / Math.max(0.25, Math.abs(t.lending.base))
  t.crosscheck = { diff: +diff.toFixed(3), agrees: rel <= 0.25 }
}

// ---- Merkl: campaigns targeting the token itself ----
console.log('fetching Merkl campaigns…')
const chains = [...new Set(tokens.map((t) => t.chain))]
const opps = await S.fetchMerklOpportunities(chains, { log: (m) => console.log(m) })
const merklByKey = new Map()
for (const o of opps) {
  const k = `${o.balChain}:${String(o.identifier || '').toLowerCase()}`
  if (!merklByKey.has(k)) merklByKey.set(k, [])
  merklByKey.get(k).push(o)
}
tokens = tokens.map((t) => T.attachMerkl(t, merklByKey))

// Whether a campaign can reach LPs is the whole point, so resolve forwarders
// for every matched token rather than sampling.
const withMerkl = tokens.filter((t) => t.merkl)
console.log(`  ${withMerkl.length} tokens have a direct Merkl campaign — checking forwarders`)
for (const t of withMerkl) {
  const fwd = await S.fetchMerklForwarders(t.merkl.id)
  if (fwd) {
    t.merkl.forwarders = fwd.forwarders
    t.merkl.whitelist = fwd.whitelist
    t.merkl.reachesLp = fwd.forwarders > 0
  }
  await new Promise((r) => setTimeout(r, 120))
}

tokens.sort((a, b) => b.tvlInPools - a.tvlInPools)

const out = {
  generatedAt: new Date().toISOString(),
  minTvl: S.MIN_TVL_USD,
  excludedChains: S.EXCLUDED_CHAINS,
  counts: {
    pools: pools.length,
    tokens: tokens.length,
    withReachesLp: tokens.filter((t) => t.reachesLp != null).length,
    withLending: tokens.filter((t) => t.lending).length,
    crosschecked: tokens.filter((t) => t.crosscheck).length,
    crosscheckAgree: tokens.filter((t) => t.crosscheck?.agrees).length,
    withMerkl: withMerkl.length,
    merklReachingLps: tokens.filter((t) => t.merkl?.reachesLp).length,
  },
  tokens,
}

const dest = path.join(ROOT, 'public/tokens.json')
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.writeFileSync(dest, JSON.stringify(out))

// ---------------------------------------------------------------- validation
console.log(`\n${'token'.padEnd(15)}${'under'.padEnd(9)}${'chain'.padEnd(7)}${'generates'.padStart(10)}${'cut'.padStart(8)}${'reachesLP'.padStart(11)}${'merkl'.padStart(9)}  flow   lending(base/reward)`)
for (const t of tokens.slice(0, 26)) {
  const u = t.underlying ? t.underlying.symbol + (t.underlying.inferred ? '*' : '') : '—'
  const mk = t.merkl ? t.merkl.apr.toFixed(2) + '%' : '—'
  const flow = t.merkl ? (t.merkl.reachesLp ? 'YES' : 'no ') : '   '
  const lend = t.lending
    ? `${t.lending.project} ${t.lending.base?.toFixed(2) ?? '—'}/${t.lending.reward?.toFixed(2) ?? '—'}` +
      (t.crosscheck ? (t.crosscheck.agrees ? ' ✓' : ` ✗Δ${t.crosscheck.diff}`) : '')
    : '—'
  console.log(
    t.symbol.slice(0, 14).padEnd(15) +
    u.slice(0, 8).padEnd(9) +
    (S.CHAIN_META[t.chain]?.short || t.chain).padEnd(7) +
    pct(t.generates).padStart(10) +
    (t.balancerCut == null ? '—' : '-' + t.balancerCut.toFixed(2)).padStart(8) +
    pct(t.reachesLp).padStart(11) +
    mk.padStart(9) + '  ' + flow + '   ' + lend
  )
}

const c = out.counts
console.log(`\nwrote public/tokens.json — ${tokens.length} tokens, ${(fs.statSync(dest).size / 1024).toFixed(0)} KB, ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log(`  reaches-LP figure:    ${c.withReachesLp}/${c.tokens}`)
console.log(`  lending base/reward:  ${c.withLending}/${c.tokens}`)
console.log(`  cross-check vs ours:  ${c.crosscheckAgree}/${c.crosschecked} agree within 25%`)
console.log(`  Merkl on token:       ${c.withMerkl}  —  reaching LPs: ${c.merklReachingLps}`)
console.log('  * = underlying inferred (rate-provider token, not an ERC4626 wrapper)')
