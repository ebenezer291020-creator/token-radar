// Token Launch Radar: renders window.RADAR (written by main.ts from the sealed snapshot) entirely
// offline. Every number, name and rank on this page comes from the data; nothing is hardcoded.
(() => {
  const R = window.RADAR;
  if (!R || !Array.isArray(R.rows)) return;

  const $ = (id) => document.getElementById(id);
  const fmtUSD = (n) => {
    if (n >= 1e9) return `$${(n / 1e9).toFixed(n >= 1e10 ? 1 : 2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
    return `$${n}`;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const sign = (v) => v === null || v === undefined ? '<span class="flat">—</span>'
    : `<span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</span>`;

  // ---- header ----
  const watchSet = new Set(R.watchlist);
  $('tagline').textContent =
    `${R.board_size} pre-token protocols ranked by an implied value priced from ${R.live.length} live comparables in this snapshot — snapshot ${R.as_of}.`;
  $('stats').innerHTML = [
    [R.board_size, 'rows ranked'],
    [R.watchlist_size, 'watchlist covered'],
    [`${R.comparables.length}`, 'category prices'],
    [fmtUSD(R.floor_usd), 'watchlist floor'],
  ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');

  // ---- tabs ----
  const views = { board: 'view-board', detail: 'view-detail', method: 'view-method', market: 'view-market' };
  function show(name) {
    for (const [tab, id] of Object.entries(views)) $(id).hidden = tab !== name;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    window.scrollTo(0, 0);
  }
  $('tabs').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) show(t.dataset.tab); });

  // ---- board ----
  const PER = 50;
  let sortKey = 'rank', sortDir = 1, page = 0;
  let current = R.rows;

  function applyFilters() {
    const q = $('q').value.trim().toLowerCase();
    const cat = $('f-category').value;
    const chain = $('f-chain').value;
    const watchOnly = $('f-watch').checked;
    current = R.rows.filter((r) => {
      if (cat && (r.category ?? 'Uncategorized') !== cat) return false;
      if (chain && !r.chains.includes(chain)) return false;
      if (watchOnly && !r.on_watchlist) return false;
      if (q) {
        const hay = `${r.name} ${r.slug} ${r.chains.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    page = 0;
    renderTable();
  }

  function sortedRows() {
    const rows = [...current].sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      let cmp;
      if (sortKey === 'chains') cmp = a.chains.length - b.chains.length;
      else if (typeof va === 'string') cmp = va.localeCompare(vb);
      else cmp = (va ?? -1) - (vb ?? -1);
      return cmp * sortDir;
    });
    return rows;
  }

  function renderTable() {
    const rows = sortedRows();
    const start = page * PER;
    const slice = rows.slice(start, start + PER);
    $('tbody').innerHTML = slice.map((r) => `
      <tr data-slug="${esc(r.slug)}" class="${r.on_watchlist ? 'watch' : ''}">
        <td class="num">${r.rank}</td>
        <td><span class="pname">${esc(r.name)}</span><span class="pslug">${esc(r.slug)}</span>${r.on_watchlist ? '<span class="wbadge">WATCHLIST</span>' : ''}</td>
        <td class="cat">${esc(r.category ?? 'Uncategorized')}</td>
        <td class="chains">${r.chains.slice(0, 3).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}${r.chains.length > 3 ? `<span class="chip">+${r.chains.length - 3}</span>` : ''}</td>
        <td class="num">${fmtUSD(r.tvl_usd)}</td>
        <td class="num">${sign(r.change_7d)}</td>
        <td class="num">${r.age_days === null ? '—' : `${r.age_days}d`}</td>
        <td class="num iv">${fmtUSD(r.implied_value_usd)}</td>
      </tr>`).join('');
    $('count').textContent = `${rows.length} of ${R.rows.length} rows`;
    $('pageinfo').textContent = rows.length === 0 ? '' : `Page ${page + 1} of ${Math.ceil(rows.length / PER)}`;
    $('prev').disabled = page === 0;
    $('next').disabled = start + PER >= rows.length;
    document.querySelectorAll('#board th').forEach((th) => {
      const key = th.dataset.key;
      if (!key) return;
      th.innerHTML = th.textContent.replace(/ [▲▼]$/, '') + (key === sortKey ? ` <span class="arrow">${sortDir > 0 ? '▲' : '▼'}</span>` : '');
    });
  }

  // sortable headers
  document.querySelectorAll('#board th[data-key]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (sortKey === key) sortDir = -sortDir;
      else { sortKey = key; sortDir = key === 'rank' ? 1 : (key === 'name' || key === 'category' ? 1 : -1); }
      renderTable();
    });
  });

  $('q').addEventListener('input', applyFilters);
  for (const id of ['f-category', 'f-chain']) $(id).addEventListener('change', applyFilters);
  $('f-watch').addEventListener('change', applyFilters);
  $('prev').addEventListener('click', () => { page--; renderTable(); });
  $('next').addEventListener('click', () => { page++; renderTable(); });
  $('tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (tr) openDetail(tr.dataset.slug);
  });
  $('back').addEventListener('click', () => show('board'));

  // filter options, derived from the data
  const cats = [...new Set(R.rows.map((r) => r.category ?? 'Uncategorized'))].sort();
  $('f-category').innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  $('f-chain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

  // ---- detail ----
  function openDetail(slug) {
    const r = R.rows.find((x) => x.slug === slug);
    if (!r) return;
    const m = r;
    const comp = m.comparable_sample > 0
      ? `category median from ${m.comparable_sample} live tokens`
      : 'global median (no clean comparable in its category)';
    const steps = r.farm_steps.map((s, i) => {
      const mt = s.match(/^(.*?)(?:\s*Cost:\s*(.*?))?\.\s*Time:\s*(.*?)\.?$/s);
      const text = mt ? mt[1] : s;
      const cost = mt && mt[2] ? mt[2] : '';
      const time = mt && mt[3] ? mt[3] : '';
      return `<div class="step"><div class="stepnum">${i + 1}</div><div class="steptext">${esc(text)}<div class="stepmeta">${cost ? `<span><b>Cost</b> ${esc(cost)}</span>` : ''}${time ? `<span><b>Time</b> ${esc(time)}</span>` : ''}</div></div></div>`;
    }).join('');
    $('detail').innerHTML = `
      <div class="detail-head">
        <h2>${esc(r.name)} ${r.on_watchlist ? '<span class="wbadge">WATCHLIST</span>' : ''}</h2>
        <div class="meta">rank #${r.rank} of ${R.rows.length} · ${esc(r.category ?? 'Uncategorized')} · listed ${r.listed_at ?? 'date unreported'} (${r.age_days === null ? 'age unreported' : `${r.age_days} days`}) · ${r.chains.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
      </div>
      <div class="cards">
        <div class="card"><b>${fmtUSD(r.tvl_usd)}</b><span>TVL today</span></div>
        <div class="card"><b>${fmtUSD(r.implied_value_usd)}</b><span>implied value</span></div>
        <div class="card"><b>${m.comparable_multiple.toFixed(2)}×</b><span>mcap/TVL comparable — ${comp}</span></div>
        <div class="card"><b>${r.change_7d === null ? '—' : `${r.change_7d >= 0 ? '+' : ''}${r.change_7d.toFixed(1)}%`}</b><span>TVL, 7 days</span></div>
      </div>
      <div class="formula">
        <code>implied = TVL × comparable × momentum × window × scale × chains</code><br>
        = ${fmtUSD(r.tvl_usd)} ×
        <span class="mult">${m.comparable_multiple.toFixed(2)}</span> ×
        <span class="mult">${m.growth_multiplier.toFixed(2)}</span> ×
        <span class="mult">${m.window_multiplier.toFixed(2)}</span> ×
        <span class="mult">${m.scale_multiplier.toFixed(2)}</span> ×
        <span class="mult">${m.chain_multiplier.toFixed(2)}</span>
        = <b class="iv">${fmtUSD(r.implied_value_usd)}</b>
        <div class="muted" style="margin-top:6px">momentum ${m.growth_multiplier.toFixed(2)}× from the 7-day change · window ${m.window_multiplier.toFixed(2)}× from ${r.age_days === null ? 'an unreported age' : `${r.age_days} days without a token`} · scale ${m.scale_multiplier.toFixed(2)}× · ${r.chains.length} chain${r.chains.length === 1 ? '' : 's'} → ${m.chain_multiplier.toFixed(2)}×</div>
      </div>
      <h3>How to farm it before a token</h3>
      <div class="steps">${steps}</div>`;
    show('detail');
  }

  // ---- method ----
  const M = R.model;
  $('method').innerHTML = `
    <div class="method">
      <h2>How the implied value is built (model ${esc(R.model_version)})</h2>
      <p>Every figure comes from this snapshot (${esc(R.as_of)}); nothing is hardcoded and no name is special-cased.</p>
      <p><b>1. The comparable anchor.</b> For each category the radar reads the live-token protocols the snapshot already carries and takes the <b>median market cap per dollar of TVL</b> their tokens actually trade at — the market's own answer to "what is a token on this kind of record worth". Clean comparables hold at least ${fmtUSD(M.comp_min_tvl)} of TVL and an mcap/TVL between ${M.comp_ratio_min} and ${M.comp_ratio_max}; a category needs ${M.global_min_sample} of them before its own median is trusted, otherwise the global median applies.</p>
      <p><b>2. Momentum (${M.growth_weight.toFixed(2)}× weight).</b> The 7-day TVL change, clamped between ${M.growth_floor}% and ${M.growth_cap}%, is worth a fraction of itself: <code>1 + growth/100 × ${M.growth_weight.toFixed(2)}</code>.</p>
      <p><b>3. The launch window.</b> A protocol that has run ${M.window_peak_days} days with no token sits at the peak multiplier (${M.window_peak_mult}×): long enough to have earned a launch, young enough for one to still be coming. Younger protocols ramp from ${M.window_floor_mult}×, past the peak the model discounts to ${M.window_old_mult}×. An unreported age is scored at three-quarters of the peak.</p>
      <p><b>4. Scale.</b> Above ${fmtUSD(M.scale_soft_cap)} of TVL a category multiple stops meaning anything, so the model discounts logarithmically toward 0.6×.</p>
      <p><b>5. Distribution.</b> A token that lands on several chains has more holders on day one: up to ${M.chain_bonus_max}× at ${M.chain_full} chains.</p>
      <p>The board covers every watchlist protocol (the floor) plus every other pre-token protocol the snapshot records that is not a wrapped, staked, bridged or custodial product of a token that already trades. Live-token protocols never enter the ranking: they are the comparables.</p>
      <h3>Category pricing from this snapshot</h3>
      <div class="tablewrap"><table><thead><tr><th>Category</th><th class="num">Sample</th><th class="num">Median mcap/TVL</th><th class="num">25th pct</th><th class="num">75th pct</th></tr></thead><tbody>
        ${R.comparables.map((c) => `<tr><td>${esc(c.category)}</td><td class="num">${c.sample}</td><td class="num">${c.median_multiple.toFixed(3)}×</td><td class="num">${c.p25.toFixed(3)}×</td><td class="num">${c.p75.toFixed(3)}×</td></tr>`).join('')}
      </tbody></table></div>
    </div>`;

  // ---- live market ----
  $('livebody').innerHTML = R.live.map((p, i) => {
    const ratio = p.mcap_usd && p.tvl_usd ? p.mcap_usd / p.tvl_usd : null;
    return `<tr>
      <td class="num">${i + 1}</td>
      <td><span class="pname">${esc(p.name)}</span></td>
      <td class="cat">${esc(p.category ?? 'Uncategorized')}</td>
      <td class="num">${fmtUSD(p.mcap_usd ?? 0)}</td>
      <td class="num">${fmtUSD(p.tvl_usd)}</td>
      <td class="num">${ratio === null ? '—' : `${ratio.toFixed(2)}×`}</td>
      <td class="num">${sign(p.change_7d)}</td>
    </tr>`;
  }).join('');

  $('srcline').textContent = `Source: ${esc(R.source)}`;
  renderTable();
})();
