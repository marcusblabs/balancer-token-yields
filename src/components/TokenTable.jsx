import React, { useMemo, useState } from 'react'

const CHAIN_SHORT = {
  MAINNET: 'ETH', BASE: 'BASE', ARBITRUM: 'ARB', OPTIMISM: 'OP', POLYGON: 'POLY',
  AVALANCHE: 'AVAX', GNOSIS: 'GNO', FANTOM: 'FTM', ZKEVM: 'ZKEVM',
  MONAD: 'MON', PLASMA: 'PLAS', HYPEREVM: 'HYPE',
}
const short = (c) => CHAIN_SHORT[c] || String(c).slice(0, 4)
const pct = (v, dp = 2) => (v == null ? null : v.toFixed(dp) + '%')

/**
 * Incentives attached to a token — for a DIFFERENT audience than a pool LP.
 *
 * These are informational, not losses. Merkl runs separate campaigns per
 * audience, and waMonAUSD has three at once:
 *   "Lend AUSD on Aave"                        6.25%  direct Aave suppliers
 *   "Hold Wrapped Aave Monad AUSD"             3.91%  wallet holders of the wrapper
 *   "Provide liquidity to Balancer avUSD-…"    7.37%  the pool's LPs
 * The pool's own campaign is the one an LP earns, and Balancer already reports
 * it as a MERKL apr item on the pool (8.64% there). So a token-level campaign
 * is not yield "leaking" away from LPs — it is simply aimed at someone else,
 * and an earlier version of this page wrongly struck it through as lost.
 *
 * Never summed: the same programme often appears under more than one target.
 */
const incentives = (t) => ({
  lending: t.lending?.reward || 0,
  merkl: t.merkl?.apr || 0,
})
const incentiveMax = (t) => {
  const i = incentives(t)
  return Math.max(i.lending, i.merkl)
}

const COLS = [
  { k: 'symbol', l: 'Vault token', a: 'l' },
  { k: 'underlying', l: 'Underlying', a: 'l' },
  { k: 'chain', l: 'Chain', a: 'l' },
  { k: 'source', l: 'Source', a: 'l' },
  { k: 'generates', l: 'Generates', a: 'r', t: 'The rate the token itself produces, before Balancer takes its share.' },
  { k: 'cut', l: 'Bal. cut', a: 'r', t: 'Balancer’s protocol yield fee (10%, or 0 where the token is exempt).' },
  { k: 'reaches', l: 'Reaches LP', a: 'r', key: true, t: 'What a liquidity provider actually earns from holding this token in a pool. Balancer’s own yield attribution, de-weighted to the token.' },
  { k: 'reward', l: 'Direct-supplier reward', a: 'r', t: 'Incentive for supplying the underlying to the lending market YOURSELF. Not earned by a pool position — the pool holds the wrapper, not a direct supply position.' },
  { k: 'merkl', l: 'Merkl on token', a: 'r', t: 'Merkl campaign targeting this token, for holding it directly. A pool\u2019s LPs are usually served by a SEPARATE pool-level campaign instead, which Balancer reports on the pool. Not additive with the direct-supplier reward — often the same programme under a different target.' },
]

function sortVal(t, k) {
  switch (k) {
    case 'symbol': return t.symbol?.toLowerCase()
    case 'underlying': return (t.underlying?.symbol || '~').toLowerCase()
    case 'chain': return short(t.chain).toLowerCase()
    case 'source': return (t.lending?.protocol || t.protocol || '~').toLowerCase()
    case 'generates': return t.generates
    case 'cut': return t.balancerCut
    case 'reaches': return t.reachesLp
    case 'reward': return incentives(t).lending
    case 'merkl': return incentives(t).merkl
    default: return null
  }
}

export default function TokenTable({ data }) {
  const tokens = data.tokens
  const [sort, setSort] = useState({ k: 'reaches', d: 'desc' })
  const [q, setQ] = useState('')
  const [under, setUnder] = useState('ALL')
  const [chain, setChain] = useState('ALL')
  const [onlyLost, setOnlyLost] = useState(false)

  const unders = useMemo(() => {
    const m = new Map()
    for (const t of tokens) {
      const u = t.underlying?.symbol
      if (u) m.set(u, (m.get(u) || 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [tokens])

  const chains = useMemo(() => {
    const m = new Map()
    for (const t of tokens) m.set(t.chain, (m.get(t.chain) || 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [tokens])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const out = tokens.filter(
      (t) =>
        (under === 'ALL' || t.underlying?.symbol === under) &&
        (chain === 'ALL' || t.chain === chain) &&
        (!onlyLost || incentiveMax(t) > 0) &&
        (!needle ||
          t.symbol?.toLowerCase().includes(needle) ||
          t.name?.toLowerCase().includes(needle) ||
          t.underlying?.symbol?.toLowerCase().includes(needle) ||
          t.address.includes(needle))
    )
    out.sort((a, b) => {
      const va = sortVal(a, sort.k)
      const vb = sortVal(b, sort.k)
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      if (typeof va === 'string') return sort.d === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va)
      return sort.d === 'asc' ? va - vb : vb - va
    })
    return out
  }, [tokens, q, under, chain, onlyLost, sort])

  const click = (k) =>
    setSort((s) => (s.k === k ? { k, d: s.d === 'asc' ? 'desc' : 'asc' } : { k, d: ['symbol', 'underlying', 'chain', 'source'].includes(k) ? 'asc' : 'desc' }))

  const totalLost = rows.filter((t) => incentiveMax(t) > 0).length

  return (
    <>
      <div className="statstrip">
        <div><span className="sl">Tokens</span><span className="sv">{rows.length}</span></div>
        <div><span className="sl">With extra incentives</span><span className="sv">{totalLost}</span></div>
        <div><span className="sl">Merkl on token</span><span className="sv">{data.counts.withMerkl}<span className="sv-sub"> · {data.counts.merklReachingLps} reach LPs</span></span></div>
        <div><span className="sl">Cross-checked</span><span className="sv">{data.counts.crosscheckAgree}<span className="sv-sub">/{data.counts.crosschecked}</span></span></div>
        <div><span className="sl">Updated</span><span className="sv sm">{String(data.generatedAt).slice(0, 10)}</span></div>
      </div>

      <div className="fbar">
        <span className="prompt">&gt;</span>
        <input className="fsearch" type="text" placeholder="search token, underlying or address…"
               value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
        <span className="fgroup">
          <span className="flabel">UNDERLYING</span>
          <select value={under} onChange={(e) => setUnder(e.target.value)}>
            <option value="ALL">ALL</option>
            {unders.map(([u, n]) => <option key={u} value={u}>{u} ({n})</option>)}
          </select>
        </span>
        <span className="fgroup">
          <span className="flabel">CHAIN</span>
          <select value={chain} onChange={(e) => setChain(e.target.value)}>
            <option value="ALL">ALL</option>
            {chains.map(([c, n]) => <option key={c} value={c}>{short(c)} ({n})</option>)}
          </select>
        </span>
        <button className={'fbtn' + (onlyLost ? ' on' : '')} onClick={() => setOnlyLost((v) => !v)}
                title="Only tokens that carry an incentive campaign of some kind">
          [ INCENTIVISED ]
        </button>
      </div>

      <div className="tablewrap">
        <table className="pooltable">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.k} className={`${c.a === 'r' ? 'r' : ''} ${sort.k === c.k ? 'sorted' : ''}`}
                    onClick={() => click(c.k)} title={c.t}>
                  {c.l}<span className="arrow">{sort.k === c.k ? (sort.d === 'asc' ? '▲' : '▼') : '·'}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const u = incentives(t)
              const overlap = u.lending > 0 && u.merkl > 0
              return (
                <tr key={t.key}>
                  <td className="pool">
                    <span className="plabel">{t.symbol}</span>
                    {t.exempt && <span className="mini" title="Exempt from Balancer's protocol yield fee — the LP keeps the full rate">exempt</span>}
                    {t.mixedExempt && <span className="mini warn" title="Exempt in some pools but not others">mixed</span>}
                  </td>
                  <td>
                    {t.underlying
                      ? <span className={'ut' + (t.underlying.inferred ? ' inferred' : '')}
                              title={t.underlying.inferred ? 'Inferred — this is a rate-provider token, so the API exposes no underlying' : 'From the Balancer API'}>
                          {t.underlying.symbol}{t.underlying.inferred ? ' ?' : ''}
                        </span>
                      : <span className="dim">—</span>}
                  </td>
                  <td><span className="chaintag">{short(t.chain)}</span></td>
                  <td><span className="srcpill">{t.lending?.protocol || t.protocol || '—'}</span></td>
                  <td className="r num">
                    {pct(t.generates) || <span className="dim">—</span>}
                    {t.crosscheck && (
                      <span className={'xc ' + (t.crosscheck.agrees ? 'ok' : 'no')}
                            title={t.crosscheck.agrees
                              ? `Matches ${t.lending.project}'s own quote of ${t.lending.base?.toFixed(2)}% — two independent derivations agreeing`
                              : `${t.lending.project} quotes ${t.lending.base?.toFixed(2)}%. A gap usually means the token stacks two yield sources (e.g. staking inside the wrapper plus the lending rate).`}>
                        {t.crosscheck.agrees ? '✓' : 'Δ'}
                      </span>
                    )}
                  </td>
                  <td className="r num cut">
                    {t.balancerCut == null
                      ? <span className="dim">—</span>
                      : t.balancerCut < 0.005
                        // exempt tokens lose nothing; "−0.00" reads like a rounding artefact
                        ? <span className="dim" title="No protocol yield fee on this token">none</span>
                        : '−' + t.balancerCut.toFixed(2)}
                  </td>
                  <td className="r num reach pos">{pct(t.reachesLp) || <span className="dim">—</span>}</td>
                  <td className="r num other">
                    {u.lending > 0
                      ? <span title={`${t.lending.project} pays this for supplying ${t.underlying?.symbol} directly. A pool holds the wrapper instead, so a pool position does not earn it.`}>
                          {u.lending.toFixed(2)}%
                        </span>
                      : <span className="dim">—</span>}
                  </td>
                  <td className="r num other">
                    {u.merkl > 0
                      ? <>
                          <span title={`${t.merkl.name} — for holding this token directly. LPs of a pool holding it are normally served by a separate pool-level campaign, which Balancer reports on the pool itself.`}>
                            {u.merkl.toFixed(2)}%
                          </span>
                          {overlap && <span className="mini warn" title="Often the same programme as the direct-supplier reward under a different target — never add them">≈</span>}
                        </>
                      : <span className="dim">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!rows.length && <div className="loading">No tokens match those filters.</div>}
      </div>

      <div className="legend2">
        <span><span className="xc ok">✓</span>cross-checked against the lending market’s own quote</span>
        <span><span className="xc no">Δ</span>differs — usually two stacked yield sources</span>
        <span><span className="ut inferred">ETH ?</span>underlying inferred, not from the API</span>
        <span><span className="mini warn">≈</span>often one programme under two targets — never add them</span>
      </div>
    </>
  )
}
