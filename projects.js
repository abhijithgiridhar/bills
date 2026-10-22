/* GFE Project cost tracker. Talks to window.DB (invoices, login) and window.PDB (projects). */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const rs = n => (n < 0 ? '−' : '') + '₹' + fmt(Math.abs(n));
  const pct = n => (n === null || n === undefined || !isFinite(n) ? '—' : (n < 0 ? '−' : '') + Math.abs(Math.round(n * 10) / 10).toFixed(1) + '%');
  const dmy = iso => (iso ? iso.split('-').reverse().join('.') : '');
  const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
  const sum = (a, f) => a.reduce((t, x) => t + (Number(f(x)) || 0), 0);
  const cls = n => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero');
  const STATUS = { planned: 'Planned', active: 'Active', completed: 'Completed', on_hold: 'On hold', cancelled: 'Cancelled' };
  const P = { user: null, invoices: [], clients: [], projects: [], expenses: [], income: [], pset: null, basis: 'received' };
  try { P.basis = localStorage.getItem('gfe-proj-basis') || 'received'; } catch {}

  /* ---------- ui helpers ---------- */
  function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 6000 : 2200); }
  const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { console.error(e); toast(e.message || String(e), true); } };
  function modal(html, wide) { const r = $('#modal-root'); r.innerHTML = `<div class="modal-bg"><div class="modal ${wide ? 'wide' : ''}">${html}</div></div>`; $('.modal-bg', r).addEventListener('mousedown', e => { if (e.target.classList.contains('modal-bg')) closeModal(); }); return $('.modal', r); }
  const closeModal = () => ($('#modal-root').innerHTML = '');
  const chip = s => `<span class="chip ${s}">${STATUS[s] || s}</span>`;
  const download = (text, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
  const csvRow = r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');

  /* ---------- the money maths ---------- */
  const receivedOf = i => (i.status === 'paid' ? Number(i.total) : Number(i.amount_paid || 0));
  function calc(p) {
    const inv = P.invoices.filter(i => i.project_id === p.id && !['draft', 'cancelled'].includes(i.status));
    const manual = P.income.filter(i => i.project_id === p.id), ex = P.expenses.filter(e => e.project_id === p.id);
    const manualTot = sum(manual, i => i.amount);
    const billed = sum(inv, i => i.total) + manualTot, received = sum(inv, receivedOf) + manualTot, cost = sum(ex, e => e.amount);
    const byCat = {}; ex.forEach(e => (byCat[e.category] = (byCat[e.category] || 0) + Number(e.amount)));
    const owed = {}; ex.filter(e => e.kind === 'spend' && e.paid_by && e.paid_by !== 'Company' && !e.reimbursed).forEach(e => (owed[e.paid_by] = (owed[e.paid_by] || 0) + Number(e.amount)));
    const pr = received - cost, pb = billed - cost;
    return { inv, manual, ex, billed, received, outstanding: billed - received, cost, byCat, owed, labour: sum(ex.filter(e => e.kind === 'labour'), e => e.amount),
      profitReceived: pr, marginReceived: received > 0 ? (pr / received) * 100 : null, profitBilled: pb, marginBilled: billed > 0 ? (pb / billed) * 100 : null };
  }
  const pick = c => (P.basis === 'received' ? { income: c.received, profit: c.profitReceived, margin: c.marginReceived } : { income: c.billed, profit: c.profitBilled, margin: c.marginBilled });
  const basisName = () => (P.basis === 'received' ? 'received' : 'billed');
  const basisSwitch = () => `<div class="seg" id="basis"><button data-b="received" class="${P.basis === 'received' ? 'on' : ''}">Received (cash in)</button><button data-b="billed" class="${P.basis === 'billed' ? 'on' : ''}">Billed (invoiced)</button></div>`;
  function wireBasis(redraw) { $('#basis').onclick = e => { const b = e.target.dataset.b; if (!b) return; P.basis = b; try { localStorage.setItem('gfe-proj-basis', b); } catch {} redraw(); }; }
  const meter = (spent, budget) => { const r = budget > 0 ? spent / budget : 0; return `<div class="meter ${r > 1 ? 'over' : r >= 0.9 ? 'warn' : ''}"><i style="width:${Math.min(100, r * 100)}%"></i></div>`; };

  /* ---------- data refresh ---------- */
  async function reload() {
    const d = await PDB.load(); Object.assign(P, { projects: d.projects, expenses: d.expenses, income: d.income, pset: d.settings });
    [P.invoices, P.clients] = await Promise.all([DB.listInvoices(), DB.listClients()]);
  }
  const redraw = async () => { await reload(); route(); };

  /* ---------- PROJECT LIST ---------- */
  function viewList() {
    const draw = () => {
      const q = ($('#q')?.value || '').trim().toLowerCase(), st = $('#st')?.value || '';
      const rows = P.projects.filter(p => (!q || p.name.toLowerCase().includes(q) || (p.client_name || '').toLowerCase().includes(q)) && (!st || p.status === st)).map(p => ({ p, c: calc(p) }));
      const tot = rows.reduce((a, { c }) => { const k = pick(c); a.income += k.income; a.cost += c.cost; return a; }, { income: 0, cost: 0 });
      const tp = tot.income - tot.cost, tm = tot.income > 0 ? (tp / tot.income) * 100 : null;
      $('#out').innerHTML = `<div class="kpis"><div class="kpi"><div class="l">Income (${basisName()})</div><div class="n">${rs(tot.income)}</div><div class="s">${rows.length} project${rows.length === 1 ? '' : 's'}</div></div>
        <div class="kpi"><div class="l">Costs</div><div class="n">${rs(tot.cost)}</div></div>
        <div class="kpi big"><div class="l">Profit / loss</div><div class="n ${cls(tp)}">${rs(tp)}</div><div class="s ${cls(tp)}">${pct(tm)} margin</div></div></div>
        ${rows.length ? `<table class="list"><tr><th>Project</th><th>Status</th><th class="r">Income</th><th class="r">Costs</th><th class="r">Profit / loss</th><th class="r">Margin</th><th>Budget used</th></tr>${rows.map(({ p, c }) => { const k = pick(c);
          return `<tr class="click" data-id="${p.id}"><td><b>${esc(p.name)}</b><div class="small muted">${esc(p.client_name || '')}</div></td><td>${chip(p.status)}</td>
          <td class="r nowrap">${rs(k.income)}</td><td class="r nowrap">${rs(c.cost)}</td><td class="r nowrap ${cls(k.profit)}"><b>${rs(k.profit)}</b></td><td class="r nowrap ${cls(k.profit)}">${pct(k.margin)}</td>
          <td style="min-width:130px">${p.budget > 0 ? `${meter(c.cost, p.budget)}<div class="small muted">${rs(c.cost)} of ${rs(p.budget)}</div>` : '<span class="muted small">no budget</span>'}</td></tr>`; }).join('')}</table>`
          : '<div class="empty">No projects yet. Click <b>+ New project</b> to start.</div>'}`;
      $$('#out tr.click').forEach(tr => (tr.onclick = () => (location.hash = '#project/' + tr.dataset.id)));
    };
    $('#view').innerHTML = `<div class="bar"><input id="q" class="grow" placeholder="Search projects or clients…"><select id="st"><option value="">All statuses</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>${basisSwitch()}<button class="btn primary" id="new">+ New project</button></div><div id="out"></div>`;
    $('#q').oninput = draw; $('#st').onchange = draw; $('#new').onclick = () => projectModal(null); wireBasis(draw); draw();
  }

  /* ---------- PROJECT DETAIL ---------- */
  function viewProject(id) {
    const p = P.projects.find(x => x.id === id); if (!p) { location.hash = '#list'; return; }
    const c = calc(p), k = pick(c), cats = [...new Set([...Object.keys(p.category_budgets || {}), ...Object.keys(c.byCat)])];
    const cf = viewProject.cat || '';
    const exRows = c.ex.filter(e => !cf || e.category === cf);
    const owedTotal = sum(Object.values(c.owed), x => x);
    $('#view').innerHTML = `<div class="crumbs"><a href="#list">← All projects</a></div>
      <div class="bar"><h2 style="margin:0" class="grow">${esc(p.name)} ${chip(p.status)}</h2>${basisSwitch()}<button class="btn" id="edit">Edit project</button><button class="btn" id="csv">Export CSV</button></div>
      <p class="muted small" style="margin-top:-6px">${esc(p.client_name || 'No client')}${p.start_date ? ' · ' + dmy(p.start_date) + (p.end_date ? ' → ' + dmy(p.end_date) : '') : ''}${p.contract_value > 0 ? ' · Contract value ' + rs(p.contract_value) : ''}${p.notes ? ' · ' + esc(p.notes) : ''}</p>
      <div class="kpis"><div class="kpi"><div class="l">Income (${basisName()})</div><div class="n">${rs(k.income)}</div><div class="s">Billed ${rs(c.billed)} · Received ${rs(c.received)}</div></div>
        <div class="kpi"><div class="l">Total costs</div><div class="n">${rs(c.cost)}</div><div class="s">incl. team time ${rs(c.labour)}</div></div>
        <div class="kpi big"><div class="l">Profit / loss</div><div class="n ${cls(k.profit)}">${rs(k.profit)}</div><div class="s ${cls(k.profit)}">on ${basisName()} income</div></div>
        <div class="kpi big"><div class="l">Margin</div><div class="n ${cls(k.profit)}">${pct(k.margin)}</div><div class="s">profit ÷ income</div></div></div>
      <div class="card"><table class="compare"><tr><th></th><th>Income</th><th>Costs</th><th>Profit / loss</th><th>Margin</th></tr>
        <tr><td><b>If you count what's received</b></td><td>${rs(c.received)}</td><td>${rs(c.cost)}</td><td class="${cls(c.profitReceived)}"><b>${rs(c.profitReceived)}</b></td><td class="${cls(c.profitReceived)}">${pct(c.marginReceived)}</td></tr>
        <tr><td><b>If you count what's billed</b></td><td>${rs(c.billed)}</td><td>${rs(c.cost)}</td><td class="${cls(c.profitBilled)}"><b>${rs(c.profitBilled)}</b></td><td class="${cls(c.profitBilled)}">${pct(c.marginBilled)}</td></tr>
        ${p.contract_value > 0 ? `<tr><td><b>At full contract value</b></td><td>${rs(p.contract_value)}</td><td>${rs(c.cost)}</td><td class="${cls(p.contract_value - c.cost)}"><b>${rs(p.contract_value - c.cost)}</b></td><td class="${cls(p.contract_value - c.cost)}">${pct(((p.contract_value - c.cost) / p.contract_value) * 100)}</td></tr>` : ''}</table>
        <p class="muted small" style="margin:8px 0 0">Still to collect from invoices: <b>${rs(c.outstanding)}</b>. Margin = profit ÷ income.</p></div>
      ${p.budget > 0 || cats.some(x => (p.category_budgets || {})[x]) ? `<div class="card"><h3>Budget vs spent</h3>
        ${p.budget > 0 ? `<div class="catrow"><b>Total budget</b>${meter(c.cost, p.budget)}<span class="${c.cost > p.budget ? 'neg' : ''}">${rs(c.cost)} of ${rs(p.budget)}${c.cost > p.budget ? ' — over by ' + rs(c.cost - p.budget) : ' — ' + rs(p.budget - c.cost) + ' left'}</span></div>` : ''}
        ${cats.map(x => { const b = Number((p.category_budgets || {})[x]) || 0, s = c.byCat[x] || 0; return `<div class="catrow"><span>${esc(x)}</span>${b > 0 ? meter(s, b) : '<span class="muted small">no budget set</span>'}<span class="${b > 0 && s > b ? 'neg' : ''}">${rs(s)}${b > 0 ? ' of ' + rs(b) : ''}</span></div>`; }).join('')}</div>` : ''}
      <div class="sect"><h3>Money in</h3><span class="grow"></span><button class="btn sm" id="link">Link invoices</button><button class="btn sm" id="add-inc">+ Other income</button></div>
      <div class="card" style="padding:0">${c.inv.length || c.manual.length ? `<table class="list" style="border:0"><tr><th>Source</th><th>Date</th><th class="r">Billed</th><th class="r">Received</th><th>Status</th><th></th></tr>
        ${c.inv.map(i => `<tr><td><b>Invoice ${esc(i.number)}</b><div class="small muted">${esc(i.client_name)}</div></td><td class="nowrap">${dmy(i.issue_date)}</td><td class="r nowrap">${rs(i.total)}</td><td class="r nowrap">${rs(receivedOf(i))}</td><td><span class="chip ${i.status}">${i.status === 'partial' ? 'Part-paid' : i.status[0].toUpperCase() + i.status.slice(1)}</span></td><td class="r"><button class="btn sm" data-unlink="${i.id}">Unlink</button></td></tr>`).join('')}
        ${c.manual.map(i => `<tr><td><b>${esc(i.source || 'Other income')}</b><div class="small muted">${esc([i.mode, i.notes].filter(Boolean).join(' · '))}</div></td><td class="nowrap">${dmy(i.received_on)}</td><td class="r nowrap">${rs(i.amount)}</td><td class="r nowrap">${rs(i.amount)}</td><td><span class="tag">Manual</span></td><td class="r nowrap"><button class="btn sm" data-edit-inc="${i.id}">Edit</button> <button class="btn sm danger" data-del-inc="${i.id}">Delete</button></td></tr>`).join('')}</table>` : '<div class="empty" style="padding:22px">No income yet. Link an invoice you have raised, or add other income.</div>'}</div>
      <div class="sect"><h3>Spends &amp; team time</h3><span class="grow"></span><button class="btn sm primary" id="add-exp">+ Add spend</button><button class="btn sm" id="add-time">+ Log team time</button></div>
      ${cats.length > 1 ? `<div class="filters"><button data-cat="" class="${!cf ? 'on' : ''}">All</button>${[...new Set(c.ex.map(e => e.category))].map(x => `<button data-cat="${esc(x)}" class="${cf === x ? 'on' : ''}">${esc(x)}</button>`).join('')}</div>` : ''}
      <div class="card" style="padding:0">${exRows.length ? `<table class="list" style="border:0"><tr><th>Date</th><th>What</th><th>Category</th><th>Paid by</th><th class="r">Amount</th><th></th></tr>
        ${exRows.map(e => `<tr><td class="nowrap">${dmy(e.spent_on)}</td><td><b>${esc(e.kind === 'labour' ? e.person : e.vendor || e.description || '—')}</b>${e.kind === 'labour' ? '<span class="tag time">Time</span>' : ''}
          <div class="small muted">${esc(e.kind === 'labour' ? `${fmt(e.units)} ${e.unit_label}${e.units == 1 ? '' : 's'} × ${rs(e.rate)}${e.description ? ' · ' + e.description : ''}` : [e.vendor && e.description ? e.description : '', e.notes].filter(Boolean).join(' · '))}</div></td>
          <td>${esc(e.category)}</td><td class="nowrap">${e.kind === 'labour' ? '<span class="muted">—</span>' : esc(e.paid_by) + (e.paid_by !== 'Company' ? (e.reimbursed ? '<span class="tag ok">Repaid</span>' : '<span class="tag owed">Owed</span>') : '')}</td>
          <td class="r nowrap"><b>${rs(e.amount)}</b></td><td class="r nowrap">${e.receipt_path ? `<button class="btn sm" data-receipt="${e.id}">Receipt</button> ` : ''}<button class="btn sm" data-edit-exp="${e.id}">Edit</button> <button class="btn sm danger" data-del-exp="${e.id}">Delete</button></td></tr>`).join('')}
        <tr><td colspan="4" class="r"><b>${cf ? esc(cf) + ' total' : 'Total'}</b></td><td class="r"><b>${rs(sum(exRows, e => e.amount))}</b></td><td></td></tr></table>` : '<div class="empty" style="padding:22px">No spends yet. Add the first one with <b>+ Add spend</b>.</div>'}</div>
      ${owedTotal > 0 ? `<div class="sect"><h3>Money owed back to the team</h3></div><div class="card">${Object.entries(c.owed).map(([who, amt]) => `<div class="pill-row" style="margin:4px 0"><b style="min-width:110px">${esc(who)}</b><span>${rs(amt)} paid out of pocket</span><button class="btn sm" data-repay="${esc(who)}">Mark as repaid</button></div>`).join('')}</div>` : ''}
      `;
    wireBasis(() => viewProject(id));
    $('#edit').onclick = () => projectModal(p); $('#csv').onclick = () => exportCsv(p, c);
    $('#link').onclick = () => linkModal(p); $('#add-inc').onclick = () => incomeModal(p, null);
    $('#add-exp').onclick = () => expenseModal(p, null); $('#add-time').onclick = () => timeModal(p, null);
    $$('.filters [data-cat]').forEach(b => (b.onclick = () => { viewProject.cat = b.dataset.cat; viewProject(id); }));
    $('#view').onclick = guard(async e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.unlink) { if (confirm('Unlink this invoice from the project? The invoice itself is not changed.')) { await PDB.linkInvoice(t.dataset.unlink, null); toast('Unlinked'); await redraw(); } }
      else if (t.dataset.editInc) incomeModal(p, P.income.find(x => x.id === t.dataset.editInc));
      else if (t.dataset.delInc) { if (confirm('Delete this income entry?')) { await PDB.deleteIncome(t.dataset.delInc); toast('Deleted'); await redraw(); } }
      else if (t.dataset.editExp) { const x = P.expenses.find(z => z.id === t.dataset.editExp); x.kind === 'labour' ? timeModal(p, x) : expenseModal(p, x); }
      else if (t.dataset.delExp) { const x = P.expenses.find(z => z.id === t.dataset.delExp); if (confirm('Delete this entry' + (x.receipt_path ? ' and its receipt' : '') + '?')) { if (x.receipt_path) await PDB.removeReceipt(x.receipt_path); await PDB.deleteExpense(x.id); toast('Deleted'); await redraw(); } }
      else if (t.dataset.receipt) { const x = P.expenses.find(z => z.id === t.dataset.receipt); window.open(await PDB.receiptUrl(x.receipt_path), '_blank', 'noopener'); }
      else if (t.dataset.repay) repayModal(p, t.dataset.repay, c);
    });
  }

  /* ---------- modals ---------- */
  function projectModal(p) {
    const isNew = !p, cb = p?.category_budgets || {}, cats = P.pset.categories;
    const m = modal(`<h3>${isNew ? 'New project' : 'Edit project'}</h3>
      <label>Project name</label><input id="p-name" value="${esc(p?.name || '')}" placeholder="e.g. SPV Delhi CHIP Camp">
      <label>Client / org</label><input id="p-client" list="cl" value="${esc(p?.client_name || '')}" autocomplete="off"><datalist id="cl">${P.clients.map(c => `<option value="${esc(c.name)}">`).join('')}</datalist>
      <div class="row c3"><div><label>Status</label><select id="p-status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${(p?.status || 'active') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div><label>Start</label><input id="p-start" type="date" value="${p?.start_date || ''}"></div><div><label>End</label><input id="p-end" type="date" value="${p?.end_date || ''}"></div></div>
      <div class="row c2"><div><label>Contract value ₹ (optional)</label><input id="p-contract" type="number" min="0" value="${p?.contract_value || ''}"></div><div><label>Total budget for costs ₹ (optional)</label><input id="p-budget" type="number" min="0" value="${p?.budget || ''}"></div></div>
      <details ${Object.values(cb).some(Boolean) ? 'open' : ''}><summary class="small muted" style="margin-top:10px;cursor:pointer">Budget by category (optional)</summary><div class="row c2">${[...cats, 'Team time'].map(x => `<div><label>${esc(x)}</label><input data-cb="${esc(x)}" type="number" min="0" value="${cb[x] || ''}"></div>`).join('')}</div></details>
      <label>Notes</label><textarea id="p-notes" rows="2">${esc(p?.notes || '')}</textarea>
      <div class="foot">${isNew ? '' : '<button class="btn danger" id="m-del" style="margin-right:auto">Delete project</button>'}<button class="btn" id="m-x">Cancel</button><button class="btn primary" id="m-ok">${isNew ? 'Create project' : 'Save'}</button></div>`);
    $('#m-x', m).onclick = closeModal;
    if (!isNew) $('#m-del', m).onclick = guard(async () => { if (!confirm(`Delete "${p.name}" with all its spends and income entries? Linked invoices stay, they are just unlinked. This cannot be undone.`)) return; (P.expenses.filter(e => e.project_id === p.id && e.receipt_path)).forEach(e => PDB.removeReceipt(e.receipt_path)); await PDB.deleteProject(p.id); closeModal(); toast('Project deleted'); location.hash = '#list'; await redraw(); });
    $('#m-ok', m).onclick = guard(async () => {
      const name = $('#p-name', m).value.trim(); if (!name) return toast('Give the project a name', true);
      const cname = $('#p-client', m).value.trim(), known = P.clients.find(c => c.name.toLowerCase() === cname.toLowerCase());
      const budgets = {}; $$('[data-cb]', m).forEach(i => { if (Number(i.value) > 0) budgets[i.dataset.cb] = Number(i.value); });
      const row = { ...(p || {}), name, client_name: cname, client_id: known ? known.id : p?.client_id || null, status: $('#p-status', m).value, start_date: $('#p-start', m).value || null, end_date: $('#p-end', m).value || null,
        contract_value: Number($('#p-contract', m).value) || 0, budget: Number($('#p-budget', m).value) || 0, category_budgets: budgets, notes: $('#p-notes', m).value, created_by: p?.created_by || P.user.name };
      const saved = await PDB.saveProject(row); closeModal(); toast(isNew ? 'Project created' : 'Saved'); await reload(); location.hash = '#project/' + saved.id; route();
    });
  }

  function expenseModal(p, e) {
    const isNew = !e, cats = P.pset.categories, payers = P.pset.payers;
    const m = modal(`<h3>${isNew ? 'Add a spend' : 'Edit spend'} — ${esc(p.name)}</h3>
      <div class="row c2"><div><label>Date</label><input id="e-date" type="date" value="${e?.spent_on || today()}"></div><div><label>Amount ₹</label><input id="e-amt" type="number" min="0" step="0.01" value="${e?.amount ?? ''}" autofocus></div></div>
      <div class="row c2"><div><label>Category</label><select id="e-cat">${[...new Set([...cats, ...(e?.category && e.kind === 'spend' && !cats.includes(e.category) ? [e.category] : [])])].map(x => `<option ${x === (e?.category || cats[0]) ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
        <div><label>Paid by</label><select id="e-by">${payers.map(x => `<option ${x === (e?.paid_by || 'Company') ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div></div>
      <label>Vendor / who you paid</label><input id="e-vendor" value="${esc(e?.vendor || '')}"><label>What it was for</label><input id="e-desc" value="${esc(e?.description || '')}">
      <label class="check" id="e-rb-row" ${!e || e.paid_by === 'Company' ? 'hidden' : ''}><input type="checkbox" id="e-rb" ${e?.reimbursed ? 'checked' : ''}> Already repaid to them</label>
      <label>Receipt / bill (photo or PDF, up to 10 MB)</label>${e?.receipt_path ? '<div class="small" id="e-cur">A receipt is attached. <label class="check" style="display:inline-flex;margin:0 0 0 8px"><input type="checkbox" id="e-rm"> remove it</label></div>' : ''}<input id="e-file" type="file" accept="image/*,application/pdf">
      <label>Notes</label><input id="e-notes" value="${esc(e?.notes || '')}">
      <div class="foot"><button class="btn" id="m-x">Cancel</button><button class="btn primary" id="m-ok">${isNew ? 'Add spend' : 'Save'}</button></div>`);
    $('#e-by', m).onchange = () => { $('#e-rb-row', m).hidden = $('#e-by', m).value === 'Company'; };
    $('#m-x', m).onclick = closeModal;
    $('#m-ok', m).onclick = guard(async () => {
      const amount = Number($('#e-amt', m).value); if (!(amount >= 0) || $('#e-amt', m).value === '') return toast('Enter the amount', true);
      const by = $('#e-by', m).value; let path = e?.receipt_path || null; const file = $('#e-file', m).files[0];
      $('#m-ok', m).disabled = true;
      try {
        if (path && ($('#e-rm', m)?.checked || file)) { await PDB.removeReceipt(path); path = null; }
        if (file) path = await PDB.uploadReceipt(p.id, file);
        await PDB.saveExpense({ ...(e || {}), project_id: p.id, kind: 'spend', spent_on: $('#e-date', m).value || today(), category: $('#e-cat', m).value, vendor: $('#e-vendor', m).value, description: $('#e-desc', m).value, amount,
          paid_by: by, reimbursed: by === 'Company' ? false : $('#e-rb', m).checked, reimbursed_on: by !== 'Company' && $('#e-rb', m).checked ? (e?.reimbursed_on || today()) : null, receipt_path: path, notes: $('#e-notes', m).value, created_by: e?.created_by || P.user.name });
      } catch (err) { $('#m-ok', m).disabled = false; throw err; }
      closeModal(); toast(isNew ? 'Spend added' : 'Saved'); await redraw();
    });
  }

  function timeModal(p, e) {
    const isNew = !e, people = P.pset.people;
    const m = modal(`<h3>${isNew ? 'Log team time' : 'Edit team time'} — ${esc(p.name)}</h3>
      <div class="row c2"><div><label>Person</label><input id="t-person" list="ppl" value="${esc(e?.person || '')}" autocomplete="off" placeholder="Pick or type a name"><datalist id="ppl">${people.map(x => `<option value="${esc(x.name)}">`).join('')}</datalist></div>
        <div><label>Date</label><input id="t-date" type="date" value="${e?.spent_on || today()}"></div></div>
      <div class="row c3"><div><label>How many</label><input id="t-units" type="number" min="0" step="0.25" value="${e?.units ?? ''}"></div>
        <div><label>Per</label><select id="t-unit">${['hour', 'day', 'week', 'session'].map(x => `<option ${x === (e?.unit_label || 'day') ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
        <div><label>Rate ₹ per unit</label><input id="t-rate" type="number" min="0" step="0.01" value="${e?.rate ?? ''}"></div></div>
      <p class="small">Cost: <b id="t-total">${rs(e?.amount || 0)}</b> <span class="muted">(how many × rate)</span></p>
      <label>What was done</label><input id="t-desc" value="${esc(e?.description || '')}">
      <div class="foot"><button class="btn" id="m-x">Cancel</button><button class="btn primary" id="m-ok">${isNew ? 'Log time' : 'Save'}</button></div>`);
    const total = () => (Number($('#t-units', m).value) || 0) * (Number($('#t-rate', m).value) || 0);
    const upd = () => ($('#t-total', m).textContent = rs(total()));
    $('#t-person', m).oninput = () => { const x = people.find(z => z.name.toLowerCase() === $('#t-person', m).value.trim().toLowerCase()); if (x && !$('#t-rate', m).value) { $('#t-rate', m).value = x.rate || ''; $('#t-unit', m).value = x.unit || 'day'; } upd(); };
    ['#t-units', '#t-rate'].forEach(s => ($(s, m).oninput = upd)); $('#m-x', m).onclick = closeModal;
    $('#m-ok', m).onclick = guard(async () => {
      const person = $('#t-person', m).value.trim(); if (!person) return toast('Who did the work?', true);
      if (!(total() > 0)) return toast('Enter how many and the rate', true);
      await PDB.saveExpense({ ...(e || {}), project_id: p.id, kind: 'labour', category: 'Team time', person, spent_on: $('#t-date', m).value || today(), units: Number($('#t-units', m).value), unit_label: $('#t-unit', m).value, rate: Number($('#t-rate', m).value),
        amount: total(), description: $('#t-desc', m).value, paid_by: 'Company', reimbursed: false, created_by: e?.created_by || P.user.name });
      closeModal(); toast(isNew ? 'Time logged' : 'Saved'); await redraw();
    });
  }

  function incomeModal(p, i) {
    const isNew = !i;
    const m = modal(`<h3>${isNew ? 'Add other income' : 'Edit income'} — ${esc(p.name)}</h3><p class="muted small">For money that has no invoice, such as an advance or a grant. Invoiced money should be linked instead.</p>
      <div class="row c2"><div><label>Date received</label><input id="i-date" type="date" value="${i?.received_on || today()}"></div><div><label>Amount ₹</label><input id="i-amt" type="number" min="0" step="0.01" value="${i?.amount ?? ''}" autofocus></div></div>
      <label>Source</label><input id="i-src" value="${esc(i?.source || '')}" placeholder="e.g. Advance from SPV"><label>Mode</label><select id="i-mode">${['Bank transfer', 'UPI', 'Cheque', 'Cash'].map(x => `<option ${x === (i?.mode || 'Bank transfer') ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <label>Notes</label><input id="i-notes" value="${esc(i?.notes || '')}"><div class="foot"><button class="btn" id="m-x">Cancel</button><button class="btn primary" id="m-ok">${isNew ? 'Add income' : 'Save'}</button></div>`);
    $('#m-x', m).onclick = closeModal;
    $('#m-ok', m).onclick = guard(async () => {
      const amount = Number($('#i-amt', m).value); if (!(amount > 0)) return toast('Enter the amount', true);
      await PDB.saveIncome({ ...(i || {}), project_id: p.id, received_on: $('#i-date', m).value || today(), amount, source: $('#i-src', m).value, mode: $('#i-mode', m).value, notes: $('#i-notes', m).value, created_by: i?.created_by || P.user.name });
      closeModal(); toast('Income saved'); await redraw();
    });
  }

  function linkModal(p) {
    const cand = P.invoices.filter(i => !i.project_id && !['draft', 'cancelled'].includes(i.status));
    const match = i => (p.client_name && i.client_name.toLowerCase().includes(p.client_name.toLowerCase())) || (p.client_id && i.client_id === p.client_id);
    const m = modal(`<h3>Link invoices to ${esc(p.name)}</h3><p class="muted small">Showing invoices not linked to any project. Invoices from this client are listed first.</p>
      <input id="l-q" placeholder="Search by number or client…"><div id="l-out" style="max-height:50vh;overflow:auto;margin-top:10px"></div>
      <div class="foot"><button class="btn" id="m-x">Cancel</button><button class="btn primary" id="m-ok">Link selected</button></div>`, true);
    const sel = new Set();
    const draw = () => {
      const q = $('#l-q', m).value.trim().toLowerCase();
      const rows = cand.filter(i => !q || i.number.toLowerCase().includes(q) || i.client_name.toLowerCase().includes(q)).sort((a, b) => (match(b) - match(a)) || b.issue_date.localeCompare(a.issue_date));
      $('#l-out', m).innerHTML = rows.length ? `<table class="list"><tr><th></th><th>Invoice</th><th>Client</th><th>Date</th><th class="r">Amount</th><th>Status</th></tr>${rows.map(i => `<tr><td><input type="checkbox" data-i="${i.id}" ${sel.has(i.id) ? 'checked' : ''} style="width:auto"></td><td><b>${esc(i.number)}</b>${match(i) ? '<span class="tag">Same client</span>' : ''}</td><td>${esc(i.client_name)}</td><td class="nowrap">${dmy(i.issue_date)}</td><td class="r nowrap">${rs(i.total)}</td><td><span class="chip ${i.status}">${i.status}</span></td></tr>`).join('')}</table>` : '<div class="empty">No unlinked invoices.</div>';
    };
    $('#l-q', m).oninput = draw; $('#l-out', m).onchange = e => { const id = e.target.dataset.i; if (!id) return; e.target.checked ? sel.add(id) : sel.delete(id); };
    $('#m-x', m).onclick = closeModal; draw();
    $('#m-ok', m).onclick = guard(async () => { if (!sel.size) return toast('Tick at least one invoice', true); for (const id of sel) await PDB.linkInvoice(id, p.id); closeModal(); toast(`${sel.size} invoice${sel.size === 1 ? '' : 's'} linked`); await redraw(); });
  }

  function repayModal(p, who, c) {
    const items = c.ex.filter(e => e.kind === 'spend' && e.paid_by === who && !e.reimbursed), total = sum(items, e => e.amount);
    const m = modal(`<h3>Repay ${esc(who)}?</h3><p>${items.length} spend${items.length === 1 ? '' : 's'} on <b>${esc(p.name)}</b>, ${rs(total)} in total, will be marked as repaid.</p>
      <label>Date repaid</label><input id="r-date" type="date" value="${today()}"><div class="foot"><button class="btn" id="m-x">Cancel</button><button class="btn primary" id="m-ok">Mark as repaid</button></div>`);
    $('#m-x', m).onclick = closeModal;
    $('#m-ok', m).onclick = guard(async () => { await PDB.markReimbursed(items.map(e => e.id), $('#r-date', m).value || today()); closeModal(); toast('Marked as repaid'); await redraw(); });
  }

  function exportCsv(p, c) {
    const rows = [['Type', 'Date', 'Description', 'Category / status', 'Paid by', 'Money in (₹)', 'Money out (₹)']];
    c.inv.forEach(i => rows.push(['Invoice', i.issue_date, `${i.number} ${i.client_name}`, i.status, '', i.total, '']));
    c.manual.forEach(i => rows.push(['Other income', i.received_on, i.source || '', i.mode || '', '', i.amount, '']));
    c.ex.forEach(e => rows.push([e.kind === 'labour' ? 'Team time' : 'Spend', e.spent_on, e.kind === 'labour' ? `${e.person}: ${e.units} ${e.unit_label} x ${e.rate}` : [e.vendor, e.description].filter(Boolean).join(' - '), e.category, e.kind === 'labour' ? '' : e.paid_by + (e.paid_by !== 'Company' ? (e.reimbursed ? ' (repaid)' : ' (owed)') : ''), '', e.amount]));
    rows.push([], ['Billed', '', '', '', '', c.billed, ''], ['Received', '', '', '', '', c.received, ''], ['Costs', '', '', '', '', '', c.cost], ['Profit on received', '', '', '', '', c.profitReceived, ''], ['Margin on received %', '', '', '', '', c.marginReceived === null ? '' : c.marginReceived.toFixed(1), ''], ['Profit on billed', '', '', '', '', c.profitBilled, ''], ['Margin on billed %', '', '', '', '', c.marginBilled === null ? '' : c.marginBilled.toFixed(1), '']);
    download(rows.map(csvRow).join('\n'), `Project ${p.name.replace(/[^\w]+/g, '_')}.csv`);
  }

  /* ---------- SETTINGS ---------- */
  function viewSettings() {
    const s = P.pset; const list = (id, items, ph) => `<div id="${id}">${items.map((x, n) => `<div class="pill-row" style="margin:4px 0"><input data-v="${n}" value="${esc(x)}" placeholder="${ph}" style="max-width:340px"><button class="btn sm danger" data-rm="${n}">×</button></div>`).join('')}</div>`;
    const cats = [...s.categories], payers = [...s.payers], people = s.people.map(x => ({ ...x }));
    const draw = () => {
      $('#view').innerHTML = `<h2>Tracker settings</h2>
        <div class="card"><h3>Spend categories</h3><p class="muted small">The choices in the Category dropdown. Renaming a category here does not change spends already saved under the old name.</p>${list('cats', cats, 'Category')}<button class="btn sm" id="add-cat">+ Add category</button></div>
        <div class="card"><h3>Who can pay</h3><p class="muted small">The Paid by dropdown. Keep <b>Company</b>. Anyone else paying out of pocket shows up as money owed back.</p>${list('payers', payers, 'Name')}<button class="btn sm" id="add-payer">+ Add person</button></div>
        <div class="card"><h3>Team time rates</h3><p class="muted small">Default rate when you log time. You can still change it on each entry.</p>
          ${people.map((x, n) => `<div class="row c3" style="grid-template-columns:1fr 130px 150px 40px;margin:4px 0"><input data-pn="${n}" value="${esc(x.name)}" placeholder="Name"><select data-pu="${n}">${['hour', 'day', 'week', 'session'].map(u => `<option ${u === x.unit ? 'selected' : ''}>${u}</option>`).join('')}</select><input data-pr="${n}" type="number" min="0" value="${x.rate || ''}" placeholder="₹ rate"><button class="btn sm danger" data-prm="${n}">×</button></div>`).join('')}<button class="btn sm" id="add-person">+ Add person</button></div>
        <div class="bar"><button class="btn primary" id="save">Save settings</button></div>`;
      $('#view').oninput = e => { const t = e.target; if (t.dataset.v !== undefined) (t.closest('#cats') ? cats : payers)[+t.dataset.v] = t.value; if (t.dataset.pn !== undefined) people[+t.dataset.pn].name = t.value; if (t.dataset.pr !== undefined) people[+t.dataset.pr].rate = Number(t.value) || 0; if (t.dataset.pu !== undefined) people[+t.dataset.pu].unit = t.value; };
      $('#view').onclick = guard(async e => {
        const t = e.target.closest('button'); if (!t) return;
        if (t.dataset.rm !== undefined) { (t.closest('#cats') ? cats : payers).splice(+t.dataset.rm, 1); draw(); }
        else if (t.dataset.prm !== undefined) { people.splice(+t.dataset.prm, 1); draw(); }
        else if (t.id === 'add-cat') { cats.push(''); draw(); } else if (t.id === 'add-payer') { payers.push(''); draw(); } else if (t.id === 'add-person') { people.push({ name: '', unit: 'day', rate: 0 }); draw(); }
        else if (t.id === 'save') {
          const c2 = [...new Set(cats.map(x => x.trim()).filter(Boolean))], p2 = [...new Set(payers.map(x => x.trim()).filter(Boolean))]; if (!p2.includes('Company')) p2.unshift('Company');
          if (!c2.length) return toast('Keep at least one category', true);
          P.pset = await PDB.saveSettings({ categories: c2, payers: p2, people: people.filter(x => x.name.trim()).map(x => ({ ...x, name: x.name.trim() })) }); toast('Settings saved'); viewSettings();
        }
      });
    };
    draw();
  }

  /* ---------- router + boot ---------- */
  function route() {
    const [tab, id] = location.hash.replace('#', '').split('/'), t = tab || 'list';
    closeModal(); $('#view').onclick = $('#view').oninput = null; viewProject.cat = id === viewProject.lastId ? viewProject.cat : '';
    $$('#nav a').forEach(x => x.classList.toggle('on', x.dataset.tab === (t === 'project' ? 'list' : t)));
    if (t === 'project') { viewProject.lastId = id; viewProject(id); } else if (t === 'settings') viewSettings(); else viewList();
  }
  async function start() {
    $('#boot').hidden = true;
    let me; try { me = await DB.init(); } catch (e) { $('#boot').hidden = false; $('#boot').textContent = e.message; return; }
    if (!me || me.denied) { location.href = DB.demo ? 'index.html?demo=1' : 'index.html'; return; }
    P.user = me; $('#who').textContent = me.name; $('#demo-banner').hidden = !DB.demo;
    $('#app').hidden = false;
    try { await reload(); } catch (e) {
      $('#view').innerHTML = `<div class="card setup"><h3>One-time setup needed</h3><p>${esc(e.message)}</p><ol><li>Open Supabase → <b>SQL Editor</b> → <b>New query</b>.</li><li>Paste the contents of <code>supabase/migration-projects.sql</code> and click <b>Run</b>.</li><li>Reload this page.</li></ol></div>`; return;
    }
    window.addEventListener('hashchange', route); route();
  }
  start();
})();
