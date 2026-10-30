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
  const P = { user: null, invoices: [], clients: [], projects: [], expenses: [], income: [], instalments: [], payments: [], instReady: false, pset: null, basis: 'received' };
  try { P.basis = localStorage.getItem('gfe-proj-basis') || 'received'; } catch {}

  /* ---------- ui helpers ---------- */
  function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 6000 : 2200); }
  const guard = fn => { let busy = false; return async (...a) => { if (busy) return; busy = true; try { return await fn(...a); } catch (e) { console.error(e); toast(e.message || String(e), true); } finally { busy = false; } }; }; // ignores a second click while the first is still saving
  function modal(html, wide) { const r = $('#modal-root'); r.innerHTML = `<div class="modal-bg"><div class="modal ${wide ? 'wide' : ''}">${html}</div></div>`; $('.modal-bg', r).addEventListener('mousedown', e => { if (e.target.classList.contains('modal-bg')) closeModal(); }); return $('.modal', r); }
  const closeModal = () => ($('#modal-root').innerHTML = '');
  const chip = s => `<span class="chip ${s}">${STATUS[s] || s}</span>`;
  const download = (text, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
  const csvRow = r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');

  /* ---------- the money maths ---------- */
  const receivedOf = i => (i.status === 'paid' ? Number(i.total) : Number(i.amount_paid || 0));
  const paidOfExp = e => (e.instalments ? sum(P.instalments.filter(i => i.expense_id === e.id), i => i.amount) : Number(e.amount));
  const tdsOfInv = i => sum(P.payments.filter(x => x.invoice_id === i.id), x => x.tds_amount);
  function calc(p) {
    const inv = P.invoices.filter(i => i.project_id === p.id && !['draft', 'cancelled'].includes(i.status));
    const manual = P.income.filter(i => i.project_id === p.id), ex = P.expenses.filter(e => e.project_id === p.id), insts = P.instalments.filter(i => i.project_id === p.id);
    const manualTot = sum(manual, i => i.amount);
    const billed = sum(inv, i => i.total) + manualTot, received = sum(inv, receivedOf) + manualTot, cost = sum(ex, e => e.amount), paidOut = sum(ex, paidOfExp), tds = sum(inv, tdsOfInv);
    const byCat = {}; ex.forEach(e => (byCat[e.category] = (byCat[e.category] || 0) + Number(e.amount)));
    const owed = {}; ex.filter(e => e.kind === 'spend' && !e.instalments && e.paid_by && e.paid_by !== 'Company' && !e.reimbursed).forEach(e => (owed[e.paid_by] = (owed[e.paid_by] || 0) + Number(e.amount)));
    insts.filter(i => i.paid_by && i.paid_by !== 'Company' && !i.reimbursed).forEach(i => (owed[i.paid_by] = (owed[i.paid_by] || 0) + Number(i.amount)));
    const pr = received - cost, pb = billed - cost;
    return { inv, manual, ex, insts, billed, received, tds, outstanding: billed - received, cost, paidOut, toPay: cost - paidOut, byCat, owed, labour: sum(ex.filter(e => e.kind === 'labour'), e => e.amount),
      profitReceived: pr, marginReceived: received > 0 ? (pr / received) * 100 : null, profitBilled: pb, marginBilled: billed > 0 ? (pb / billed) * 100 : null };
  }
  const pick = c => (P.basis === 'received' ? { income: c.received, profit: c.profitReceived, margin: c.marginReceived } : { income: c.billed, profit: c.profitBilled, margin: c.marginBilled });
  const basisName = () => (P.basis === 'received' ? 'received' : 'billed');
  const basisSwitch = () => `<div class="seg" id="basis"><button data-b="received" class="${P.basis === 'received' ? 'on' : ''}">Received (cash in)</button><button data-b="billed" class="${P.basis === 'billed' ? 'on' : ''}">Billed (invoiced)</button></div>`;
  function wireBasis(redraw) { $('#basis').onclick = e => { const b = e.target.dataset.b; if (!b) return; P.basis = b; try { localStorage.setItem('gfe-proj-basis', b); } catch {} redraw(); }; }
  const meter = (spent, budget) => { const r = budget > 0 ? spent / budget : 0; return `<div class="meter ${r > 1 ? 'over' : r >= 0.9 ? 'warn' : ''}"><i style="width:${Math.min(100, r * 100)}%"></i></div>`; };

  /* ---------- data refresh ---------- */
  async function reload() {
    const d = await PDB.load(); Object.assign(P, { projects: d.projects, expenses: d.expenses, income: d.income, pset: d.settings, instalments: d.instalments, instReady: d.instReady, payments: d.payments });
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
        ${rows.length ? `<table class="list rtable"><tr><th data-title>Project</th><th>Status</th><th class="r">Income</th><th class="r">Costs</th><th class="r">Profit / loss</th><th class="r">Margin</th><th>Budget used</th></tr>${rows.map(({ p, c }) => { const k = pick(c);
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
      <div class="kpis"><div class="kpi"><div class="l">Income (${basisName()})</div><div class="n">${rs(k.income)}</div><div class="s">Billed ${rs(c.billed)} · Received ${rs(c.received)}${c.tds > 0 ? ` (incl. ${rs(c.tds)} TDS)` : ''}</div></div>
        <div class="kpi"><div class="l">Total costs</div><div class="n">${rs(c.cost)}</div><div class="s">incl. team time ${rs(c.labour)}${c.toPay > 0.5 ? ` · <b>${rs(c.toPay)} still to pay</b>` : ''}</div></div>
        <div class="kpi big"><div class="l">Profit / loss</div><div class="n ${cls(k.profit)}">${rs(k.profit)}</div><div class="s ${cls(k.profit)}">on ${basisName()} income</div></div>
        <div class="kpi big"><div class="l">Margin</div><div class="n ${cls(k.profit)}">${pct(k.margin)}</div><div class="s">profit ÷ income</div></div></div>
      <div class="card"><table class="compare rtable"><tr><th data-title></th><th>Income</th><th>Costs</th><th>Profit / loss</th><th>Margin</th></tr>
        <tr><td><b>If you count what's received</b></td><td>${rs(c.received)}</td><td>${rs(c.cost)}</td><td class="${cls(c.profitReceived)}"><b>${rs(c.profitReceived)}</b></td><td class="${cls(c.profitReceived)}">${pct(c.marginReceived)}</td></tr>
        <tr><td><b>If you count what's billed</b></td><td>${rs(c.billed)}</td><td>${rs(c.cost)}</td><td class="${cls(c.profitBilled)}"><b>${rs(c.profitBilled)}</b></td><td class="${cls(c.profitBilled)}">${pct(c.marginBilled)}</td></tr>
        ${p.contract_value > 0 ? `<tr><td><b>At full contract value</b></td><td>${rs(p.contract_value)}</td><td>${rs(c.cost)}</td><td class="${cls(p.contract_value - c.cost)}"><b>${rs(p.contract_value - c.cost)}</b></td><td class="${cls(p.contract_value - c.cost)}">${pct(((p.contract_value - c.cost) / p.contract_value) * 100)}</td></tr>` : ''}</table>
        <p class="muted small" style="margin:8px 0 0">Still to collect from invoices: <b>${rs(c.outstanding)}</b>. Margin = profit ÷ income.</p>${c.tds > 0 ? `<p class="small" style="margin:6px 0 0">Of the ${rs(c.received)} received, <b>${rs(c.tds)}</b> was withheld by clients as TDS. It is counted as income, and you can claim it back (see the <a href="index.html${DB.demo ? '?demo=1' : ''}#tds">TDS tab</a>). Cash that reached the bank: <b>${rs(c.received - c.tds)}</b>.</p>` : ''}</div>
      ${p.budget > 0 || cats.some(x => (p.category_budgets || {})[x]) ? `<div class="card"><h3>Budget vs spent</h3>
        ${p.budget > 0 ? `<div class="catrow"><b>Total budget</b>${meter(c.cost, p.budget)}<span class="${c.cost > p.budget ? 'neg' : ''}">${rs(c.cost)} of ${rs(p.budget)}${c.cost > p.budget ? ' — over by ' + rs(c.cost - p.budget) : ' — ' + rs(p.budget - c.cost) + ' left'}</span></div>` : ''}
        ${cats.map(x => { const b = Number((p.category_budgets || {})[x]) || 0, s = c.byCat[x] || 0; return `<div class="catrow"><span>${esc(x)}</span>${b > 0 ? meter(s, b) : '<span class="muted small">no budget set</span>'}<span class="${b > 0 && s > b ? 'neg' : ''}">${rs(s)}${b > 0 ? ' of ' + rs(b) : ''}</span></div>`; }).join('')}</div>` : ''}
      <div class="sect"><h3>Money in</h3><span class="grow"></span><button class="btn sm" id="link">Link invoices</button><button class="btn sm" id="add-inc">+ Other income</button></div>
      <div class="card" style="padding:0">${c.inv.length || c.manual.length ? `<table class="list rtable" style="border:0"><tr><th data-title>Source</th><th>Date</th><th class="r">Billed</th><th class="r">Received</th><th>Status</th><th></th></tr>
        ${c.inv.map(i => `<tr><td><b>Invoice ${esc(i.number)}</b><div class="small muted">${esc(i.client_name)}</div></td><td class="nowrap">${dmy(i.issue_date)}</td><td class="r nowrap">${rs(i.total)}</td><td class="r nowrap">${rs(receivedOf(i))}</td><td><span class="chip ${i.status}">${i.status === 'partial' ? 'Part-paid' : i.status[0].toUpperCase() + i.status.slice(1)}</span>${tdsOfInv(i) > 0 ? `<span class="tag">TDS ${rs(tdsOfInv(i))}</span>` : ''}</td><td class="r"><button class="btn sm" data-unlink="${i.id}">Unlink</button></td></tr>`).join('')}
        ${c.manual.map(i => `<tr><td><b>${esc(i.source || 'Other income')}</b><div class="small muted">${esc([i.mode, i.notes].filter(Boolean).join(' · '))}</div></td><td class="nowrap">${dmy(i.received_on)}</td><td class="r nowrap">${rs(i.amount)}</td><td class="r nowrap">${rs(i.amount)}</td><td><span class="tag">Manual</span></td><td class="r nowrap"><button class="btn sm" data-edit-inc="${i.id}">Edit</button> <button class="btn sm danger" data-del-inc="${i.id}">Delete</button></td></tr>`).join('')}</table>` : '<div class="empty" style="padding:22px">No income yet. Link an invoice you have raised, or add other income.</div>'}</div>
      <div class="sect"><h3>Spends &amp; team time</h3><span class="grow"></span><button class="btn sm primary" id="add-exp">+ Add spend</button><button class="btn sm" id="add-time">+ Log team time</button></div>
      ${cats.length > 1 ? `<div class="filters"><button data-cat="" class="${!cf ? 'on' : ''}">All</button>${[...new Set(c.ex.map(e => e.category))].map(x => `<button data-cat="${esc(x)}" class="${cf === x ? 'on' : ''}">${esc(x)}</button>`).join('')}</div>` : ''}
      <div class="card" style="padding:0">${exRows.length ? `<table class="list rtable" style="border:0"><tr><th>Date</th><th data-title>What</th><th>Category</th><th>Paid by</th><th class="r">Amount</th><th></th></tr>
        ${exRows.map(e => { const paid = paidOfExp(e), bal = Number(e.amount) - paid, inst = !!e.instalments, late = inst && bal > 0.005 && e.pay_by && e.pay_by < today();
          return `<tr><td class="nowrap">${dmy(e.spent_on)}</td><td><b>${esc(e.kind === 'labour' ? e.person : e.vendor || e.description || '—')}</b>${e.kind === 'labour' ? '<span class="tag time">Time</span>' : ''}${inst ? `<span class="tag ${bal <= 0.005 ? 'ok' : paid > 0 ? '' : 'owed'}">${bal <= 0.005 ? 'Paid in full' : paid > 0 ? 'Part-paid' : 'Unpaid'}</span>` : ''}
          <div class="small muted">${esc(e.kind === 'labour' ? `${fmt(e.units)} ${e.unit_label}${e.units == 1 ? '' : 's'} × ${rs(e.rate)}${e.description ? ' · ' + e.description : ''}` : [e.vendor && e.description ? e.description : '', e.notes].filter(Boolean).join(' · '))}${inst && bal > 0.005 && e.pay_by ? `<span style="${late ? 'color:var(--bad);font-weight:600' : ''}"> · balance due by ${dmy(e.pay_by)}${late ? ' (overdue)' : ''}</span>` : ''}</div></td>
          <td>${esc(e.category)}</td><td class="nowrap">${e.kind === 'labour' ? '<span class="muted">—</span>' : inst ? '<span class="muted small">Instalments</span>' : esc(e.paid_by) + (e.paid_by !== 'Company' ? (e.reimbursed ? '<span class="tag ok">Repaid</span>' : '<span class="tag owed">Owed</span>') : '')}</td>
          <td class="r nowrap"><b>${rs(e.amount)}</b>${inst ? `<div class="small muted">Paid ${rs(paid)} · To pay ${rs(bal)}</div>` : ''}</td><td class="r nowrap">${inst ? `<button class="btn sm ${bal > 0.005 ? 'primary' : ''}" data-inst="${e.id}">${bal > 0.005 ? 'Pay' : 'Payments'}</button> ` : ''}${e.receipt_path ? `<button class="btn sm" data-receipt="${e.id}">Receipt</button> ` : ''}<button class="btn sm" data-edit-exp="${e.id}">Edit</button> <button class="btn sm danger" data-del-exp="${e.id}">Delete</button></td></tr>`; }).join('')}
        <tr><td colspan="4" class="r"><b>${cf ? esc(cf) + ' total' : 'Total'}</b>${!cf && c.toPay > 0.5 ? `<div class="small muted">Paid so far ${rs(c.paidOut)} · Still to pay ${rs(c.toPay)}</div>` : ''}</td><td class="r"><b>${rs(sum(exRows, e => e.amount))}</b></td><td></td></tr></table>` : '<div class="empty" style="padding:22px">No spends yet. Add the first one with <b>+ Add spend</b>.</div>'}</div>
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
      else if (t.dataset.inst) instalmentsModal(p, P.expenses.find(z => z.id === t.dataset.inst));
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
      <div class="row c2"><div><label>Date</label><input id="e-date" type="date" value="${e?.spent_on || today()}"></div><div><label id="e-amt-l">${e?.instalments ? 'Agreed total ₹' : 'Amount ₹'}</label><input id="e-amt" type="number" min="0" step="0.01" value="${e?.amount ?? ''}" autofocus></div></div>
      ${isNew ? `<label class="check"><input type="checkbox" id="e-inst" ${P.instReady ? '' : 'disabled'}> Pay this vendor / freelancer in instalments (part payments)</label>${P.instReady ? '' : '<p class="small muted" style="margin:-4px 0 6px">Part payments need a one-time database update: run supabase/migration-tds-vendor.sql.</p>'}
        <div id="e-ibox" hidden><div class="row c2"><div><label>First payment made now ₹ (optional)</label><input id="e-first" type="number" min="0" step="0.01"></div><div><label>Balance due by (optional)</label><input id="e-payby" type="date"></div></div><p class="small muted" style="margin:0 0 6px">The amount above is the full agreed total. You can record further payments later with the <b>Pay</b> button.</p></div>` : (e.instalments ? `<div class="row c2"><div><label>Balance due by (optional)</label><input id="e-payby" type="date" value="${e.pay_by || ''}"></div><div></div></div><p class="small muted" style="margin:0 0 6px">This spend is paid in instalments. Use the <b>Pay</b> / <b>Payments</b> button on its row to record or change payments.</p>` : '')}
      <div class="row c2"><div><label>Category</label><select id="e-cat">${[...new Set([...cats, ...(e?.category && e.kind === 'spend' && !cats.includes(e.category) ? [e.category] : [])])].map(x => `<option ${x === (e?.category || cats[0]) ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
        <div id="e-byrow" ${e?.instalments ? 'hidden' : ''}><label id="e-by-l">Paid by</label><select id="e-by">${payers.map(x => `<option ${x === (e?.paid_by || 'Company') ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div></div>
      <label>Vendor / who you paid</label><input id="e-vendor" value="${esc(e?.vendor || '')}"><label>What it was for</label><input id="e-desc" value="${esc(e?.description || '')}">
      <label class="check" id="e-rb-row" ${!e || e.paid_by === 'Company' ? 'hidden' : ''}><input type="checkbox" id="e-rb" ${e?.reimbursed ? 'checked' : ''}> Already repaid to them</label>
      <label>Receipt / bill (photo or PDF, up to 10 MB)</label>${e?.receipt_path ? '<div class="small" id="e-cur">A receipt is attached. <label class="check" style="display:inline-flex;margin:0 0 0 8px"><input type="checkbox" id="e-rm"> remove it</label></div>' : ''}<input id="e-file" type="file" accept="image/*,application/pdf">
      <label>Notes</label><input id="e-notes" value="${esc(e?.notes || '')}">
      <div class="foot"><button class="btn" id="m-x">Cancel</button><button class="btn primary" id="m-ok">${isNew ? 'Add spend' : 'Save'}</button></div>`);
    const syncRb = () => { $('#e-rb-row', m).hidden = $('#e-by', m).value === 'Company' || (e?.instalments); };
    $('#e-by', m).onchange = syncRb;
    if ($('#e-inst', m)) $('#e-inst', m).onchange = () => { const on = $('#e-inst', m).checked; $('#e-ibox', m).hidden = !on; $('#e-amt-l', m).textContent = on ? 'Agreed total ₹' : 'Amount ₹'; $('#e-by-l', m).textContent = on ? 'First payment paid by' : 'Paid by'; };
    $('#m-x', m).onclick = closeModal;
    $('#m-ok', m).onclick = guard(async () => {
      const amount = Number($('#e-amt', m).value); if (!(amount >= 0) || $('#e-amt', m).value === '') return toast('Enter the amount', true);
      const useInst = isNew ? !!$('#e-inst', m)?.checked : !!e.instalments, first = useInst && isNew ? Number($('#e-first', m).value) || 0 : 0;
      if (first > amount) return toast('The first payment cannot be more than the agreed total', true);
      if (e?.instalments && amount < paidOfExp(e) - 0.005) return toast(`₹${fmt(paidOfExp(e))} has already been paid, so the agreed total cannot be lower`, true);
      const by = $('#e-by', m).value; let path = e?.receipt_path || null; const file = $('#e-file', m).files[0];
      $('#m-ok', m).disabled = true;
      try {
        if (path && ($('#e-rm', m)?.checked || file)) { await PDB.removeReceipt(path); path = null; }
        if (file) path = await PDB.uploadReceipt(p.id, file);
        const rb = by !== 'Company' && $('#e-rb', m).checked;
        const saved = await PDB.saveExpense({ ...(e || {}), project_id: p.id, kind: 'spend', spent_on: $('#e-date', m).value || today(), category: $('#e-cat', m).value, vendor: $('#e-vendor', m).value, description: $('#e-desc', m).value, amount,
          ...(useInst ? { instalments: true, pay_by: $('#e-payby', m).value || null, paid_by: 'Company', reimbursed: false, reimbursed_on: null } : { paid_by: by, reimbursed: rb, reimbursed_on: rb ? (e?.reimbursed_on || today()) : null }),
          receipt_path: path, notes: $('#e-notes', m).value, created_by: e?.created_by || P.user.name });
        if (isNew && useInst && first > 0) await PDB.saveInstalment({ expense_id: saved.id, project_id: p.id, paid_on: $('#e-date', m).value || today(), amount: first, mode: 'Bank transfer', paid_by: by, reimbursed: rb, reimbursed_on: rb ? today() : null, created_by: P.user.name });
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

  function instalmentsModal(p, e) {
    const m = modal('', ''), payers = P.pset.payers;
    const render = () => {
      const ins = P.instalments.filter(i => i.expense_id === e.id).sort((a, b) => a.paid_on.localeCompare(b.paid_on)), paid = sum(ins, i => i.amount), bal = Number(e.amount) - paid;
      m.innerHTML = `<h3>Payments to ${esc(e.vendor || e.description || 'vendor')} — ${esc(p.name)}</h3>
        <p>Agreed <b>${rs(e.amount)}</b> · Paid <b>${rs(paid)}</b> · Still to pay <b class="${bal > 0.005 ? 'neg' : 'pos'}">${rs(Math.max(0, bal))}</b>${e.pay_by && bal > 0.005 ? ` · due by ${dmy(e.pay_by)}` : ''}</p>${meter(paid, Number(e.amount))}
        ${ins.length ? `<table class="list" style="margin-top:12px"><tr><th>Date</th><th class="r">Amount</th><th>Mode</th><th>Paid by</th><th></th></tr>${ins.map(i => `<tr><td class="nowrap">${dmy(i.paid_on)}</td><td class="r nowrap"><b>${rs(i.amount)}</b></td><td>${esc(i.mode || '')}${i.note ? `<div class="small muted">${esc(i.note)}</div>` : ''}</td><td class="nowrap">${esc(i.paid_by)}${i.paid_by !== 'Company' ? (i.reimbursed ? '<span class="tag ok">Repaid</span>' : '<span class="tag owed">Owed</span>') : ''}</td><td class="r"><button class="btn sm danger" data-del="${i.id}">Delete</button></td></tr>`).join('')}</table>` : '<p class="muted small" style="margin-top:12px">No payments recorded yet.</p>'}
        ${bal > 0.005 ? `<div class="card" style="margin:14px 0 0;background:#fafafd"><b>Record a payment</b>
          <div class="row c2"><div><label>Date paid</label><input id="i-date" type="date" value="${today()}"></div><div><label>Amount ₹ (balance is ${rs(bal)})</label><input id="i-amt" type="number" min="0" step="0.01" value="${bal}"></div></div>
          <div class="row c2"><div><label>Mode</label><select id="i-mode"><option>Bank transfer</option><option>UPI</option><option>Cheque</option><option>Cash</option></select></div><div><label>Paid by</label><select id="i-by">${payers.map(x => `<option>${esc(x)}</option>`).join('')}</select></div></div>
          <label class="check" id="i-rb-row" hidden><input type="checkbox" id="i-rb"> Already repaid to them</label><label>Note (optional)</label><input id="i-note" placeholder="UTR / reference"><p style="margin:10px 0 0"><button class="btn primary" id="i-save">Record payment</button></p></div>` : '<p style="margin-top:12px"><span class="tag ok">Fully paid</span></p>'}
        <div class="foot"><button class="btn" id="m-x">Close</button></div>`;
      $('#m-x', m).onclick = () => { closeModal(); route(); };
      if ($('#i-by', m)) $('#i-by', m).onchange = () => { $('#i-rb-row', m).hidden = $('#i-by', m).value === 'Company'; };
      if ($('#i-save', m)) $('#i-save', m).onclick = guard(async () => {
        const amount = Number($('#i-amt', m).value); if (!(amount > 0)) return toast('Enter the amount paid', true);
        if (amount > bal + 0.005) return toast(`That is more than the balance of ${rs(bal)}. Raise the agreed total first if the price went up.`, true);
        const by = $('#i-by', m).value, rb = by !== 'Company' && $('#i-rb', m).checked;
        await PDB.saveInstalment({ expense_id: e.id, project_id: p.id, paid_on: $('#i-date', m).value || today(), amount, mode: $('#i-mode', m).value, note: $('#i-note', m).value, paid_by: by, reimbursed: rb, reimbursed_on: rb ? today() : null, created_by: P.user.name });
        await reload(); toast('Payment recorded'); render();
      });
      $$('[data-del]', m).forEach(b => (b.onclick = guard(async () => { if (!confirm('Delete this payment?')) return; await PDB.deleteInstalment(b.dataset.del); await reload(); toast('Deleted'); render(); })));
    };
    render();
  }

  function repayModal(p, who, c) {
    const items = c.ex.filter(e => e.kind === 'spend' && !e.instalments && e.paid_by === who && !e.reimbursed), insts = c.insts.filter(i => i.paid_by === who && !i.reimbursed), total = sum(items, e => e.amount) + sum(insts, i => i.amount), n = items.length + insts.length;
    const m = modal(`<h3>Repay ${esc(who)}?</h3><p>${n} payment${n === 1 ? '' : 's'} on <b>${esc(p.name)}</b>, ${rs(total)} in total, will be marked as repaid.</p>
      <label>Date repaid</label><input id="r-date" type="date" value="${today()}"><div class="foot"><button class="btn" id="m-x">Cancel</button><button class="btn primary" id="m-ok">Mark as repaid</button></div>`);
    $('#m-x', m).onclick = closeModal;
    $('#m-ok', m).onclick = guard(async () => { const d = $('#r-date', m).value || today(); if (items.length) await PDB.markReimbursed(items.map(e => e.id), d); if (insts.length) await PDB.markInstalmentsReimbursed(insts.map(i => i.id), d); closeModal(); toast('Marked as repaid'); await redraw(); });
  }

  function exportCsv(p, c) {
    const rows = [['Type', 'Date', 'Description', 'Category / status', 'Paid by', 'Money in (₹)', 'Cost (₹)', 'Paid so far (₹)']];
    c.inv.forEach(i => rows.push(['Invoice', i.issue_date, `${i.number} ${i.client_name}`, i.status + (tdsOfInv(i) > 0 ? ` (TDS withheld ${tdsOfInv(i)})` : ''), '', i.total, '', '']));
    c.manual.forEach(i => rows.push(['Other income', i.received_on, i.source || '', i.mode || '', '', i.amount, '', '']));
    c.ex.forEach(e => {
      const who = e.kind === 'labour' ? '' : e.instalments ? 'Instalments' : e.paid_by + (e.paid_by !== 'Company' ? (e.reimbursed ? ' (repaid)' : ' (owed)') : '');
      rows.push([e.kind === 'labour' ? 'Team time' : e.instalments ? 'Spend (agreed total)' : 'Spend', e.spent_on, e.kind === 'labour' ? `${e.person}: ${e.units} ${e.unit_label} x ${e.rate}` : [e.vendor, e.description].filter(Boolean).join(' - '), e.category, who, '', e.amount, e.instalments ? '' : e.amount]);
      if (e.instalments) c.insts.filter(i => i.expense_id === e.id).forEach(i => rows.push(['  Instalment paid', i.paid_on, [e.vendor, i.note].filter(Boolean).join(' - '), i.mode || '', i.paid_by + (i.paid_by !== 'Company' ? (i.reimbursed ? ' (repaid)' : ' (owed)') : ''), '', '', i.amount]));
    });
    rows.push([], ['Billed', '', '', '', '', c.billed, '', ''], ['Received (incl. TDS)', '', '', '', '', c.received, '', ''], ['  of which TDS withheld', '', '', '', '', c.tds, '', ''], ['Costs (agreed)', '', '', '', '', '', c.cost, c.paidOut], ['  still to pay vendors', '', '', '', '', '', c.toPay, ''], ['Profit on received', '', '', '', '', c.profitReceived, '', ''], ['Margin on received %', '', '', '', '', c.marginReceived === null ? '' : c.marginReceived.toFixed(1), '', ''], ['Profit on billed', '', '', '', '', c.profitBilled, '', ''], ['Margin on billed %', '', '', '', '', c.marginBilled === null ? '' : c.marginBilled.toFixed(1), '', '']);
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
          ${people.map((x, n) => `<div class="row c3 prow" style="grid-template-columns:1fr 130px 150px 40px;margin:4px 0"><input data-pn="${n}" value="${esc(x.name)}" placeholder="Name"><select data-pu="${n}">${['hour', 'day', 'week', 'session'].map(u => `<option ${u === x.unit ? 'selected' : ''}>${u}</option>`).join('')}</select><input data-pr="${n}" type="number" min="0" value="${x.rate || ''}" placeholder="₹ rate"><button class="btn sm danger" data-prm="${n}">×</button></div>`).join('')}<button class="btn sm" id="add-person">+ Add person</button></div>
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

  /* On phones, .rtable tables become stacked cards. Each cell is labelled from its column header. */
  function labelTables() {
    $$('table.rtable').forEach(t => {
      const rows = $$('tr', t), ths = $$('th', rows[0] || t);
      rows.slice(1).forEach(tr => { const tds = $$(':scope > td', tr), span = tds.some(td => td.colSpan > 1);
        tds.forEach((td, i) => { if (span) td.dataset.l = ''; else if (ths[i] && !ths[i].hasAttribute('data-title')) td.dataset.l = ths[i].textContent.trim(); }); });
    });
  }
  new MutationObserver(() => labelTables()).observe(document.getElementById('view'), { childList: true, subtree: true });

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
