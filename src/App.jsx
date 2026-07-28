import React, { useEffect, useState } from 'react'
import TokenTable from './components/TokenTable'

// Precomputed nightly by scripts/scan-tokens.mjs. 'no-cache' revalidates via
// ETag so a refreshed file is picked up immediately instead of a stale copy
// sitting in the browser until it expires.
const DATA_URL = `${import.meta.env?.BASE_URL ?? '/'}tokens.json`

export default function App() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let on = true
    fetch(DATA_URL, { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`tokens.json ${r.status}`)
        return r.json()
      })
      .then((d) => on && setData(d))
      .catch((e) => on && setErr(e))
    return () => { on = false }
  }, [])

  return (
    <>
      <div className="head">
        <h1>
          Balancer Token Yields
          <span className="tag">every yield-bearing token, every chain</span>
        </h1>
        <p>
          For each token Balancer pools hold in its <b>vault form</b>: the rate it generates, the
          share Balancer’s protocol yield fee takes, and <b>what actually reaches a liquidity
          provider</b>. Rewards advertised on the token — lending-market incentives and Merkl
          campaigns — are shown separately, because they are claimable distributions rather than
          rate accrual and so never arrive in the pool.
        </p>
      </div>

      {err && <div className="err">{String(err.message || err)}</div>}
      {!data && !err && <div className="loading">Loading token data…</div>}
      {data && <TokenTable data={data} />}

      {data && (
        <p className="foot">
          <b>Method.</b> “Reaches LP” is Balancer’s own <code>IB_YIELD</code> attribution divided by
          the token’s share of pool value, which recovers its standalone rate — pools holding the
          same token independently return the same number. That figure is already net of the
          protocol yield fee, so “Generates” reverses the fee back out.{' '}
          <b>Why the split matters.</b> Base lending and staking yield compounds into the token’s
          exchange rate, so a pool holding it benefits automatically — that is the “Reaches LP”
          column, and it matches Aave’s own Protocol APY (2.07% for waMonAUSD against 2.06% here).
          Incentives work differently: Merkl runs a separate campaign per audience. waMonAUSD
          carries three at once — 6.25% for lending AUSD directly on Aave, 3.91% for holding the
          wrapper, and 7.37% for providing liquidity to the Balancer pool that holds it. Only the
          last is an LP’s, and Balancer already reports it on the pool. A campaign in these columns
          is therefore <b>not</b> yield leaking away from LPs; it belongs to someone else.{' '}
          Sources: Balancer API, DefiLlama yields, Merkl v4.
          {' '}Data refreshed {String(data.generatedAt).slice(0, 10)}; tokens in pools above $
          {data.minTvl.toLocaleString()} TVL.
        </p>
      )}
    </>
  )
}
