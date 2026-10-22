/* GFE Invoices — UI. Talks to the backend only through window.DB (data.js or data-demo.js). */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const dmy = iso => (iso ? iso.split('-').reverse().join('.') : '');
  const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const S = { user: null, settings: null, brands: [], clients: [], invoices: [], unlocked: false };
  const DB = window.DB;

  /* ---------- money ---------- */
  const lineTotal = i => (i.total !== undefined && i.total !== null && i.total !== '' ? Number(i.total) : (Number(i.qty) || 0) * (Number(i.unit) || 0));
  function totals(inv) {
    const subtotal = inv.items.reduce((a, i) => a + lineTotal(i), 0);
    const discount = Number(inv.discount) || 0;
    const tax = S.settings.gst_enabled ? Math.round((subtotal - discount) * (Number(inv.tax_rate) || 0)) / 100 : 0;
    return { subtotal, discount, tax, total: subtotal - discount + tax };
  }
  const balance = inv => Math.max(0, Number(inv.total) - Number(inv.amount_paid || 0));
  const isOverdue = inv => ['pending', 'partial'].includes(inv.status) && inv.due_date && inv.due_date < today();
  const chip = inv => (isOverdue(inv) ? '<span class="chip overdue">Overdue</span> ' : '') + `<span class="chip ${inv.status}">${{ draft: 'Draft', pending: 'Pending', partial: 'Part-paid', paid: 'Paid', cancelled: 'Cancelled' }[inv.status]}</span>`;

  /* ---------- ui helpers ---------- */
  function toast(msg, err) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 5000 : 2200);
  }
  const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { console.error(e); toast(e.message || String(e), true); } };
  function modal(html, { wide } = {}) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-bg"><div class="modal ${wide ? 'wide' : ''}">${html}</div></div>`;
    $('.modal-bg', root).addEventListener('mousedown', e => { if (e.target.classList.contains('modal-bg')) closeModal(); });
    return $('.modal', root);
  }
  const closeModal = () => ($('#modal-root').innerHTML = '');
  const brandOf = id => S.brands.find(b => b.id === id) || S.brands.find(b => b.is_default) || S.brands[0];
  const logoOf = b => b.logo_url || (b.is_default || /games for ed/i.test(b.name) ? 'assets/logo-gfe.png' : '');

  /* ---------- the invoice paper ---------- */
  function paperHTML(inv) {
    const b = brandOf(inv.brand_id), st = S.settings, t = totals(inv);
    const logo = logoOf(b);
    const rows = inv.items.map((i, n) => {
      const showUnit = !(Number(i.unit) === 0 && Number(i.qty) === 0) && i.unit !== '' && i.unit !== null;
      return `<tr class="${n === 0 ? 'first' : ''}"><td>${esc(i.desc)}</td><td>${showUnit ? fmt(i.unit) : '-'}</td><td>${i.qty === '' || i.qty === null || (!Number(i.qty) && !showUnit) ? '-' : fmt(i.qty)}</td><td>${fmt(lineTotal(i))}</td></tr>`;
    }).join('');
    const extra = [];
    if (st.discount_enabled && Number(inv.discount)) extra.push(`<div><span>SUBTOTAL</span><span>${fmt(t.subtotal)}</span></div><div><span>DISCOUNT</span><span>- ${fmt(t.discount)}</span></div>`);
    if (st.gst_enabled && t.tax) extra.push(`<div><span>GST @ ${fmt(inv.tax_rate)}%</span><span>${fmt(t.tax)}</span></div>`);
    return `<div class="paper">
      ${inv.status === 'cancelled' ? '<div class="stamp">CANCELLED</div>' : inv.status === 'draft' ? '<div class="stamp draft">DRAFT</div>' : ''}
      <div class="body">
        <div class="head">${logo ? `<img src="${esc(logo)}" crossorigin="anonymous" alt="">` : `<div class="nologo">${esc(b.name)}</div>`}
          <div class="title">${esc(b.title_line).replace(/(Plot Twist Games)\s/, '$1<br>')}</div></div>
        <div class="meta">
          <div><div class="lbl">Issued to:</div><div class="txt">${esc(inv.client_name)}${inv.client_address ? '\n' + esc(inv.client_address) : ''}${inv.client_gst ? '\nGST No: ' + esc(inv.client_gst) : ''}</div></div>
          <div class="no"><div><span class="lbl">Invoice no:</span><b class="v">${esc(inv.number || 'DRAFT')}</b></div><div><span class="lbl">Date:</span><span class="v">${dmy(inv.issue_date)}</span></div></div>
        </div>
        <div class="payto"><div class="lbl">Pay to:</div><div class="txt">${esc(st.bank_name)}\nAccount Name: ${esc(st.account_name)}\nAccount No.: ${esc(st.account_no)}\nIFSC Code: ${esc(st.ifsc)}\nGST : ${esc(st.gst_no)}</div></div>
        <table><thead><tr><th>Description</th><th>Unit price</th><th>Qty</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="sum">${extra.join('')}<div class="tot"><span class="lbl">Total</span><b>${fmt(t.total)}</b></div></div>
        ${inv.notes ? `<div class="notes">${esc(inv.notes)}</div>` : ''}
      </div>
      <div class="band"><span>THANK YOU</span></div>
      <div class="contact"><div>${esc(b.email)}<br>${esc(b.phone)}</div><div class="rt">${esc(inv.signed_by || st.signer_name)}<br>${esc(st.signer_company)}</div></div>
      <div class="fine">${esc(b.footer_text)}</div>
    </div>`;
  }

  // Renders the invoice inside its own iframe so page scroll / window size / browser quirks cannot shift or clip it.
  async function renderPDF(inv) {
    const fr = document.createElement('iframe');
    fr.setAttribute('aria-hidden', 'true');
    fr.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:1200px;border:0;opacity:0;pointer-events:none;z-index:-1';
    document.body.appendChild(fr);
    try {
      const doc = fr.contentDocument, win = fr.contentWindow;
      doc.open();
      doc.write(`<!doctype html><html><head><meta charset="utf-8"><base href="${location.href}">
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500&family=Open+Sans:wght@400;500;600;700&family=Red+Hat+Display:wght@700;800&display=swap">
        <link rel="stylesheet" href="style.css"><style>html,body{margin:0;background:#fff}</style></head><body>${paperHTML(inv)}</body></html>`);
      doc.close();
      const until = async (ok, ms = 8000) => { const t0 = Date.now(); while (!ok() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 50)); };
      await until(() => $$('link', doc).every(l => l.sheet));
      await Promise.all(['400 14px "Open Sans"', '600 14px "Open Sans"', '700 14px "Open Sans"', '400 14px Montserrat', '800 20px "Red Hat Display"'].map(f => doc.fonts.load(f).catch(() => 0)));
      await doc.fonts.ready;
      await Promise.all($$('img', doc).map(im => (im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; }))));
      const paper = $('.paper', doc);
      const canvas = await html2canvas(paper, { scale: 2, useCORS: true, backgroundColor: '#fff', scrollX: 0, scrollY: 0, windowWidth: 900, windowHeight: Math.max(1200, paper.offsetHeight) });
      const pdf = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
      const img = canvas.toDataURL('image/jpeg', 0.97), h = 210 * canvas.height / canvas.width;
      const pages = Math.max(1, Math.ceil((h - 1) / 297));
      for (let p = 0; p < pages; p++) { if (p) pdf.addPage(); pdf.addImage(img, 'JPEG', 0, -297 * p, 210, h); }
      return pdf.output('blob');
    } finally { fr.remove(); }
  }
  const pdfName = inv => inv.status === 'draft' ? `GFE_DRAFT_${(inv.client_name || 'invoice').replace(/[^\w]+/g, '_')}.pdf` : `GFE_Invoice_${inv.number}${inv.status === 'cancelled' ? '_CANCELLED' : ''}.pdf`;
  function saveBlob(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const downloadPDF = guard(async inv => { toast('Preparing PDF…'); saveBlob(await renderPDF(inv), pdfName(inv)); toast('Downloaded'); });
  async function printInvoice(inv) {
    const p = document.createElement('div'); p.id = 'print-root'; p.innerHTML = paperHTML(inv); document.body.appendChild(p);
    await document.fonts.ready; await new Promise(r => setTimeout(r, 300));
    window.print(); setTimeout(() => p.remove(), 500);
  }
  function shareInvoice(inv) {
    const st = S.settings, cli = S.clients.find(c => c.id === inv.client_id) || {};
    const msg = `Hello, please find invoice ${inv.number} dated ${dmy(inv.issue_date)} for ₹${fmt(inv.total)} from ${st.signer_company}.\n\nPay to: ${st.bank_name}, A/c ${st.account_no}, IFSC ${st.ifsc}.\n\nThank you.`;
    const phone = (cli.phone || '').replace(/\D/g, '');
    const m = modal(`<h3>Share ${esc(inv.number)}</h3>
      <p class="muted small">Links can't attach files: download the PDF first, then attach it in the email or WhatsApp that opens.</p>
      <div class="bar"><button class="btn" id="s-pdf">Download PDF</button></div>
      <div class="bar"><a class="btn" target="_blank" rel="noopener" href="https://wa.me/${phone}?text=${encodeURIComponent(msg)}">WhatsApp</a>
      <a class="btn" href="mailto:${esc(cli.email || '')}?subject=${encodeURIComponent('Invoice ' + inv.number + ' — ' + st.signer_company)}&body=${encodeURIComponent(msg)}">Email</a></div>
      <div class="foot"><button class="btn" id="m-close">Close</button></div>`);
    $('#s-pdf', m).onclick = () => downloadPDF(inv); $('#m-close', m).onclick = closeModal;
  }

  /* ---------- data refresh ---------- */
  const refresh = async () => {
    [S.settings, S.brands, S.clients, S.invoices] = await Promise.all([DB.getSettings(), DB.listBrands(), DB.listClients(), DB.listInvoices()]);
    try { S.projects = await DB.listProjectsLite(); } catch { S.projects = null; } // null = project tables not set up yet
    const n = S.invoices.filter(i => ['pending', 'partial'].includes(i.status)).length;
    $('#pending-count').textContent = n || '';
  };

  /* ---------- invoice actions (shared by history / pending / view) ---------- */
  const afterChange = async () => { await refresh(); route(); };
  function paymentModal(inv) {
    const m = modal(`<h3>Record payment — ${esc(inv.number)}</h3>
      <p class="muted">${esc(inv.client_name)} · Total ₹${fmt(inv.total)} · Balance ₹${fmt(balance(inv))}</p>
      <label>Amount received (₹)</label><input id="p-amt" type="number" min="0" step="0.01" value="${balance(inv)}">
      <div class="row c2"><div><label>Date received</label><input id="p-date" type="date" value="${today()}"></div>
      <div><label>Mode</label><select id="p-mode"><option>Bank transfer</option><option>UPI</option><option>Cheque</option><option>Cash</option></select></div></div>
      <label>Note / reference (optional)</label><input id="p-note" placeholder="UTR / cheque no.">
      <div class="foot"><button class="btn" id="m-cancel">Cancel</button><button class="btn primary" id="m-ok">Save payment</button></div>`);
    $('#m-cancel', m).onclick = closeModal;
    $('#m-ok', m).onclick = guard(async () => {
      const amount = Number($('#p-amt', m).value);
      if (!(amount > 0)) return toast('Enter an amount', true);
      await DB.recordPayment(inv, { amount, paid_on: $('#p-date', m).value, mode: $('#p-mode', m).value, note: $('#p-note', m).value }, S.user.name);
      closeModal(); toast(amount >= balance(inv) ? 'Marked as paid' : 'Part payment recorded'); afterChange();
    });
  }
  function cancelModal(inv) {
    const m = modal(`<h3>Cancel invoice ${esc(inv.number)}?</h3>
      <p class="muted">The number stays in history marked <b>Cancelled</b> and is not reused. You can reopen it later.</p>
      <label>Reason (e.g. no payment received)</label><input id="c-reason">
      <div class="foot"><button class="btn" id="m-cancel">Keep invoice</button><button class="btn danger" id="m-ok">Cancel invoice</button></div>`);
    $('#m-cancel', m).onclick = closeModal;
    $('#m-ok', m).onclick = guard(async () => {
      await DB.updateInvoice(inv.id, { status: 'cancelled', cancel_reason: $('#c-reason', m).value });
      closeModal(); toast('Invoice cancelled'); afterChange();
    });
  }
  const reopen = guard(async inv => {
    const paid = Number(inv.amount_paid || 0);
    await DB.updateInvoice(inv.id, { status: paid >= Number(inv.total) ? 'paid' : paid > 0 ? 'partial' : 'pending', cancel_reason: null });
    toast('Invoice reopened'); afterChange();
  });
  const markUnpaid = guard(async inv => {
    if (!confirm(`Reset ${inv.number} to unpaid? Recorded payments stay in the log but the balance is cleared.`)) return;
    await DB.updateInvoice(inv.id, { status: 'pending', amount_paid: 0, paid_date: null }); toast('Marked unpaid'); afterChange();
  });
  const deleteDraft = guard(async inv => {
    if (!confirm(`Delete this draft${inv.client_name ? ' for ' + inv.client_name : ''}? Drafts have no invoice number, so nothing else is affected.`)) return;
    await DB.deleteInvoice(inv.id); closeModal(); toast('Draft deleted'); afterChange();
  });
  function duplicate(inv) { closeModal(); location.hash = '#new/dup/' + inv.id; }
  function actions(inv, small) {
    const c = small ? 'btn sm' : 'btn';
    const out = [];
    if (inv.status === 'draft') return `<button class="${c} primary" data-act="edit" data-id="${inv.id}">Finalise…</button> <button class="${c} danger" data-act="deldraft" data-id="${inv.id}">Delete</button>`;
    if (['pending', 'partial'].includes(inv.status)) out.push(`<button class="${c} primary" data-act="pay" data-id="${inv.id}">${inv.status === 'partial' ? 'Record payment' : 'Mark paid'}</button>`);
    if (inv.status === 'paid') out.push(`<button class="${c}" data-act="unpay" data-id="${inv.id}">Mark unpaid</button>`);
    if (inv.status === 'cancelled') out.push(`<button class="${c}" data-act="reopen" data-id="${inv.id}">Reopen</button>`);
    else out.push(`<button class="${c} danger" data-act="cancel" data-id="${inv.id}">Cancel</button>`);
    return out.join(' ');
  }
  function wireActions(root) {
    root.onclick = e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      e.stopPropagation();
      const inv = S.invoices.find(i => i.id === b.dataset.id); if (!inv) return;
      ({ pay: paymentModal, cancel: cancelModal, reopen, unpay: markUnpaid, deldraft: deleteDraft, pdf: downloadPDF, print: printInvoice, share: shareInvoice, dup: duplicate,
         edit: i => { closeModal(); location.hash = '#new/' + i.id; }, view: viewInvoice }[b.dataset.act])(inv);
    };
  }

  /* ---------- view one invoice ---------- */
  async function viewInvoice(inv) {
    const pays = await DB.listPayments(inv.id);
    const m = modal(`<div class="bar"><h3 style="margin:0" class="grow">${esc(inv.number || 'Draft')} · ${esc(inv.client_name)} ${chip(inv)}</h3><button class="btn" id="m-close">Close</button></div>
      <div class="bar">
        ${inv.status === 'draft' ? '' : `<button class="btn" data-act="edit" data-id="${inv.id}">Edit</button>`}
        <button class="btn" data-act="dup" data-id="${inv.id}">Duplicate</button>
        <button class="btn" data-act="pdf" data-id="${inv.id}">Download PDF</button>
        <button class="btn" data-act="print" data-id="${inv.id}">Print</button>
        ${inv.status === 'draft' ? '' : `<button class="btn" data-act="share" data-id="${inv.id}">Share</button>`}
        ${actions(inv)}
      </div>
      ${inv.status === 'draft' ? `<p class="muted small">Draft · no invoice number yet (assigned when you finalise) · Total ₹${fmt(inv.total)}${inv.created_by ? ' · Started by ' + esc(inv.created_by) : ''}</p>` : `<p class="muted small">Total ₹${fmt(inv.total)} · Received ₹${fmt(inv.amount_paid)} · Balance ₹${fmt(balance(inv))}${inv.due_date ? ' · Due ' + dmy(inv.due_date) : ''}${inv.cancel_reason ? ' · Cancelled: ' + esc(inv.cancel_reason) : ''}${inv.created_by ? ' · Created by ' + esc(inv.created_by) : ''}${inv.project_id && S.projects ? ' · Project: ' + esc((S.projects.find(p => p.id === inv.project_id) || {}).name || '') : ''}</p>`}
      ${pays.length ? `<p class="small"><b>Payments:</b> ${pays.map(p => `₹${fmt(p.amount)} on ${dmy(p.paid_on)} (${esc(p.mode || '')}${p.note ? ', ' + esc(p.note) : ''})`).join(' · ')}</p>` : ''}
      <div class="previewwrap"><div class="scale" id="vscale">${paperHTML(inv)}</div></div>`, { wide: true });
    $('#m-close', m).onclick = closeModal;
    wireActions(m);
    const w = $('.previewwrap', m); const z = Math.min(1, (w.clientWidth - 40) / 794); $('#vscale', m).style.zoom = z;
  }

  /* ---------- NEW / EDIT ---------- */
  let E = null; // working invoice
  async function viewEditor(arg1, arg2) {
    const st = S.settings;
    let src = null, isEdit = false;
    if (arg1 === 'dup') src = S.invoices.find(i => i.id === arg2);
    else if (arg1) { src = S.invoices.find(i => i.id === arg1); isEdit = !!src; }
    const isDraft = !!(isEdit && src.status === 'draft'), isReal = isEdit && !isDraft;
    const def = brandOf();
    E = src ? JSON.parse(JSON.stringify(src)) : {
      brand_id: def.id, client_id: null, client_name: '', client_address: '', client_gst: '', issue_date: today(), due_date: addDays(today(), st.default_due_days),
      items: [{ desc: '', qty: 1, unit: '' }], discount: 0, tax_rate: st.gst_rate, notes: '', status: 'pending', amount_paid: 0,
    };
    if (src && !isEdit) { // duplicate: fresh number/date/status
      Object.assign(E, { id: undefined, number: undefined, issue_date: today(), due_date: addDays(today(), st.default_due_days), status: 'pending', amount_paid: 0, paid_date: null, cancel_reason: null, imported: false, signed_by: null });
    }
    E.signed_by = isEdit ? (E.signed_by || st.signer_name) : (st.sign_by_login ? S.user.name : st.signer_name);
    const peek = isReal ? E.number : await DB.peekNumber();
    E.number_preview = peek; if (!isReal) E.number = peek + ' (auto)';
    const cli = S.clients.find(c => c.id === E.client_id) || {};
    $('#view').innerHTML = `<div class="editor"><div class="form">
      <div class="card"><h3>${isDraft ? 'Draft' : isEdit ? 'Edit invoice ' + esc(E.number) : src ? 'Duplicate of ' + esc(src.number || 'draft') : 'New invoice'}</h3>
        <div class="row c2"><div><label>Brand</label><select id="f-brand">${S.brands.map(b => `<option value="${b.id}" ${b.id === E.brand_id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
        <div><label>Invoice no.</label><input id="f-number" value="${esc(E.number)}" disabled></div></div>
        ${S.projects && S.projects.length ? `<label>Project (optional, for the cost tracker)</label><select id="f-project"><option value="">— none —</option>${S.projects.map(p => `<option value="${p.id}" ${p.id === E.project_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
        <div class="row c2"><div><label>Invoice date</label><input type="date" id="f-date" value="${E.issue_date}"></div>
        <div><label>Due date</label><input type="date" id="f-due" value="${E.due_date || ''}"></div></div>
      </div>
      <div class="card"><h3>Client / vendor</h3>
        <label>Name — pick an existing client or type a new one</label>
        <input id="f-client" list="client-list" autocomplete="off" value="${esc(E.client_name)}" placeholder="Start typing…">
        <datalist id="client-list">${S.clients.map(c => `<option value="${esc(c.name)}">`).join('')}</datalist>
        <label>Address</label><textarea id="f-addr">${esc(E.client_address)}</textarea>
        <div class="row c3"><div><label>GST no. (optional)</label><input id="f-gst" value="${esc(E.client_gst)}"></div>
        <div><label>Email (not printed)</label><input id="f-email" value="${esc(cli.email || '')}"></div>
        <div><label>Phone (not printed)</label><input id="f-phone" value="${esc(cli.phone || '')}"></div></div>
        <p class="muted small" id="client-hint"></p>
      </div>
      <div class="card"><h3>Line items</h3><div id="items"></div>
        <button class="btn sm" id="add-item">+ Add line</button>
        ${st.discount_enabled ? `<label>Discount (₹)</label><input id="f-disc" type="number" min="0" step="0.01" value="${E.discount || 0}">` : ''}
        ${st.gst_enabled ? `<label>GST rate (%)</label><input id="f-tax" type="number" min="0" step="0.01" value="${E.tax_rate}">` : ''}
        <p style="font-size:16px;font-weight:700;margin:14px 0 0">Total: ₹<span id="grand"></span></p>
      </div>
      <div class="card"><h3>Notes (printed under the total, optional)</h3><textarea id="f-notes">${esc(E.notes)}</textarea>
        <label>Signed by</label><input id="f-signed" value="${esc(E.signed_by)}"></div>
      <div class="bar">${isReal ? '<button class="btn primary big" id="save">Save changes</button>' : '<button class="btn primary big" id="save">Create invoice</button><button class="btn big" id="save-draft">Save as draft</button>'}${isDraft ? '<button class="btn danger" id="del-draft">Delete draft</button>' : ''}<button class="btn" id="discard">Cancel</button></div>
      ${isReal ? '' : '<p class="muted small">A draft keeps your work without using an invoice number. The number is assigned when you click Create invoice.</p>'}
    </div>
    <div><div class="bar"><span class="muted small">Live preview</span></div><div class="previewwrap" id="pw"><div class="scale" id="pscale"></div></div></div></div>`;

    const bind = () => {
      E.brand_id = $('#f-brand').value; E.issue_date = $('#f-date').value; E.due_date = $('#f-due').value || null;
      E.client_name = $('#f-client').value; E.client_address = $('#f-addr').value; E.client_gst = $('#f-gst').value;
      E.notes = $('#f-notes').value; E.signed_by = $('#f-signed').value; if ($('#f-project')) E.project_id = $('#f-project').value || null;
      if ($('#f-disc')) E.discount = Number($('#f-disc').value) || 0;
      if ($('#f-tax')) E.tax_rate = Number($('#f-tax').value) || 0;
      const t = totals(E); Object.assign(E, { subtotal: t.subtotal, tax: t.tax, total: t.total });
      $('#grand').textContent = fmt(t.total);
      $('#pscale').innerHTML = paperHTML(E);
      const w = $('#pw'); $('#pscale').style.zoom = Math.min(1, (w.clientWidth - 40) / 794);
    };
    const drawItems = () => {
      $('#items').innerHTML = `<table class="items-edit"><tr class="small muted"><td>Description</td><td style="width:84px">Unit ₹</td><td style="width:58px">Qty</td><td style="width:92px">Total ₹</td><td></td></tr>${E.items.map((it, n) => `
        <tr data-n="${n}"><td><textarea rows="1" data-k="desc" placeholder="Description">${esc(it.desc)}</textarea></td>
        <td><input data-k="unit" type="number" step="0.01" value="${it.unit ?? ''}"></td>
        <td><input data-k="qty" type="number" step="0.01" value="${it.qty ?? ''}"></td>
        <td><input data-k="total" type="number" step="0.01" value="${lineTotal(it) || ''}" title="Calculated; type here to override"></td>
        <td><button class="x" data-del="${n}" title="Remove">×</button></td></tr>`).join('')}</table>`;
    };
    drawItems(); bind();
    const form = $('.form');
    form.addEventListener('input', e => {
      const tr = e.target.closest('tr[data-n]');
      if (tr) { // line item edit
        const it = E.items[+tr.dataset.n], k = e.target.dataset.k;
        if (k === 'desc') it.desc = e.target.value;
        else if (k === 'total') it.total = e.target.value === '' ? undefined : Number(e.target.value);
        else { it[k] = e.target.value === '' ? '' : Number(e.target.value); delete it.total; $('[data-k=total]', tr).value = lineTotal(it) || ''; }
      }
      if (e.target.id === 'f-date' && !isReal) { $('#f-due').value = addDays($('#f-date').value, st.default_due_days); }
      if (e.target.id === 'f-client') {
        const c = S.clients.find(x => x.name.toLowerCase() === e.target.value.trim().toLowerCase());
        if (c) { E.client_id = c.id; $('#f-addr').value = c.address || ''; $('#f-gst').value = c.gst_no || ''; $('#f-email').value = c.email || ''; $('#f-phone').value = c.phone || ''; $('#client-hint').textContent = 'Existing client loaded.'; }
        else { E.client_id = null; $('#client-hint').textContent = e.target.value ? 'New client: it will be saved for next time.' : ''; }
      }
      bind();
    });
    form.addEventListener('click', e => {
      if (e.target.id === 'add-item') { E.items.push({ desc: '', qty: 1, unit: '' }); drawItems(); bind(); }
      const d = e.target.closest('[data-del]');
      if (d) { E.items.splice(+d.dataset.del, 1); if (!E.items.length) E.items.push({ desc: '', qty: 1, unit: '' }); drawItems(); bind(); }
    });
    $('#discard').onclick = () => (location.hash = isEdit ? '#history' : '#new/x');
    const commit = guard(async asDraft => {
      bind();
      if (!E.client_name.trim()) return toast('Enter the client name', true);
      if (!asDraft && !E.items.some(i => i.desc.trim())) return toast('Add at least one line item', true);
      if (!asDraft && !E.total && !confirm('Total is 0. Save anyway?')) return;
      $$('#save, #save-draft, #del-draft').forEach(b => (b.disabled = true));
      const reenable = () => $$('#save, #save-draft, #del-draft').forEach(b => (b.disabled = false));
      try {
        const known = S.clients.find(x => x.name.toLowerCase() === E.client_name.trim().toLowerCase());
        const c = asDraft ? { id: known ? known.id : null } : await DB.upsertClient({ name: E.client_name.trim(), address: E.client_address, gst_no: E.client_gst, email: $('#f-email').value, phone: $('#f-phone').value });
        const row = {
          brand_id: E.brand_id, client_id: c.id, client_name: E.client_name.trim(), client_address: E.client_address, client_gst: E.client_gst,
          issue_date: E.issue_date, due_date: E.due_date, items: E.items.filter(i => i.desc.trim() || lineTotal(i)), subtotal: E.subtotal, discount: E.discount || 0,
          tax_rate: E.tax_rate || 0, tax: E.tax || 0, total: E.total, notes: E.notes, signed_by: E.signed_by,
        };
        if (S.projects !== null) row.project_id = E.project_id || null; // only once the project tables exist
        let saved;
        if (asDraft) {
          saved = isDraft ? await DB.updateInvoice(E.id, { ...row, status: 'draft' }) : await DB.saveDraft({ ...row, status: 'draft', amount_paid: 0, created_by: S.user.name });
          await refresh(); toast('Draft saved'); location.hash = '#history'; return;
        }
        if (isDraft) saved = await DB.finalizeDraft(E.id, row);
        else if (isReal) { // keep status consistent if the total changed
          const paid = Number(E.amount_paid || 0);
          if (E.status !== 'cancelled' && paid > 0) row.status = paid >= row.total ? 'paid' : 'partial';
          saved = await DB.updateInvoice(E.id, row);
        } else saved = await DB.createInvoice({ ...row, status: 'pending', amount_paid: 0, created_by: S.user.name });
        await refresh(); toast(isReal ? 'Saved' : `Invoice ${saved.number} created`);
        location.hash = '#history'; setTimeout(() => viewInvoice(S.invoices.find(i => i.id === saved.id)), 50);
      } catch (e) { reenable(); throw e; }
    });
    $('#save').onclick = () => commit(false);
    if ($('#save-draft')) $('#save-draft').onclick = () => commit(true);
    if ($('#del-draft')) $('#del-draft').onclick = () => deleteDraft(src).then(() => { if (!S.invoices.some(i => i.id === src.id)) location.hash = '#history'; });
    window.onresize = () => $('#pw') && bind();
  }

  /* ---------- HISTORY ---------- */
  function viewHistory() {
    $('#view').innerHTML = `<div class="bar"><input id="q" class="grow" placeholder="Search by invoice number or client name…" autofocus>
      <select id="st"><option value="">All statuses</option><option value="pending">Pending</option><option value="partial">Part-paid</option><option value="paid">Paid</option><option value="cancelled">Cancelled</option><option value="overdue">Overdue</option><option value="draft">Drafts</option></select>
      <label style="margin:0">From</label><input id="d1" type="date"><label style="margin:0">To</label><input id="d2" type="date">
      <button class="btn" id="clr">Clear</button></div><div id="out"></div>`;
    if (viewHistory.preset) { $('#st').value = viewHistory.preset; viewHistory.preset = ''; }
    const draw = () => {
      const q = $('#q').value.trim().toLowerCase(), st = $('#st').value, d1 = $('#d1').value, d2 = $('#d2').value;
      const rows = S.invoices.slice().sort((a, b) => (b.status === 'draft') - (a.status === 'draft')).filter(i => (!q || (i.number || '').toLowerCase().includes(q) || i.client_name.toLowerCase().includes(q))
        && (!st || (st === 'overdue' ? isOverdue(i) : i.status === st)) && (!d1 || i.issue_date >= d1) && (!d2 || i.issue_date <= d2));
      $('#out').innerHTML = rows.length ? `<table class="list"><tr><th>Invoice</th><th>Date</th><th>Client</th><th class="r">Amount</th><th class="r">Balance</th><th>Status</th><th></th></tr>${rows.map(i => `
        <tr class="click" data-act="view" data-id="${i.id}"><td class="nowrap"><b>${esc(i.number || 'Draft')}</b></td><td class="nowrap">${dmy(i.issue_date)}</td><td>${esc(i.client_name)}</td>
        <td class="r nowrap">₹${fmt(i.total)}</td><td class="r nowrap">${['cancelled', 'draft'].includes(i.status) ? '—' : '₹' + fmt(balance(i))}</td><td class="nowrap">${chip(i)}</td>
        <td class="r nowrap">${actions(i, true)}</td></tr>`).join('')}</table><p class="muted small">${rows.length} invoice${rows.length === 1 ? '' : 's'}</p>` : '<div class="empty">No invoices match.</div>';
    };
    $('#view').oninput = draw; $('#view').onchange = draw;
    $('#clr').onclick = () => { $$('#view input, #view select').forEach(x => (x.value = '')); draw(); };
    wireActions($('#out')); draw();
  }

  /* ---------- PENDING ---------- */
  function viewPending() {
    const rows = S.invoices.filter(i => ['pending', 'partial'].includes(i.status))
      .sort((a, b) => (a.due_date || a.issue_date).localeCompare(b.due_date || b.issue_date));
    const out = rows.reduce((a, i) => a + balance(i), 0), over = rows.filter(isOverdue);
    const nd = S.invoices.filter(i => i.status === 'draft').length;
    $('#view').innerHTML = `${nd ? `<p class="muted">You have <a href="#history" id="to-drafts">${nd} draft${nd === 1 ? '' : 's'}</a> waiting to be finalised.</p>` : ''}<div class="stats"><div class="stat"><div class="n">₹${fmt(out)}</div><div class="l">Outstanding across ${rows.length} bill${rows.length === 1 ? '' : 's'}</div></div>
      <div class="stat"><div class="n" style="color:var(--bad)">₹${fmt(over.reduce((a, i) => a + balance(i), 0))}</div><div class="l">Overdue (${over.length} bill${over.length === 1 ? '' : 's'})</div></div></div>
      ${rows.length ? `<table class="list"><tr><th>Invoice</th><th>Date</th><th>Client</th><th>Due</th><th class="r">Amount</th><th class="r">Balance</th><th>Status</th><th></th></tr>${rows.map(i => {
        const late = isOverdue(i) ? Math.round((new Date(today()) - new Date(i.due_date)) / 864e5) : 0;
        return `<tr class="click" data-act="view" data-id="${i.id}"><td class="nowrap"><b>${esc(i.number)}</b></td><td class="nowrap">${dmy(i.issue_date)}</td><td>${esc(i.client_name)}</td>
        <td class="nowrap">${i.due_date ? dmy(i.due_date) + (late ? ` <span class="small" style="color:var(--bad)">(${late}d late)</span>` : '') : '<span class="muted">—</span>'}</td>
        <td class="r nowrap">₹${fmt(i.total)}</td><td class="r nowrap"><b>₹${fmt(balance(i))}</b></td><td class="nowrap">${chip(i)}</td><td class="r nowrap">${actions(i, true)}</td></tr>`;
      }).join('')}</table>` : '<div class="empty">Nothing pending. All bills are settled.</div>'}`;
    if ($('#to-drafts')) $('#to-drafts').onclick = () => { viewHistory.preset = 'draft'; };
    wireActions($('#view'));
  }

  /* ---------- DASHBOARD ---------- */
  function viewDashboard() {
    const fys = [...new Set(S.invoices.filter(i => i.prefix).map(i => i.prefix))].sort().reverse();
    const cur = viewDashboard.fy && fys.includes(viewDashboard.fy) ? viewDashboard.fy : fys[0];
    viewDashboard.fy = cur;
    const live = S.invoices.filter(i => i.prefix === cur && !['cancelled', 'draft'].includes(i.status));
    const billed = live.reduce((a, i) => a + Number(i.total), 0), got = live.reduce((a, i) => a + Number(i.amount_paid || 0), 0);
    const ym = today().slice(0, 7), month = live.filter(i => i.issue_date.startsWith(ym)).reduce((a, i) => a + Number(i.total), 0);
    const startYear = 2000 + Number((cur || '2726').slice(2));
    const months = Array.from({ length: 12 }, (_, k) => { const m = (3 + k) % 12, y = startYear + (m < 3 ? 1 : 0); return { key: `${y}-${String(m + 1).padStart(2, '0')}`, label: new Date(y, m).toLocaleString('en', { month: 'short' }) }; });
    const byM = months.map(m => live.filter(i => i.issue_date.startsWith(m.key)).reduce((a, i) => a + Number(i.total), 0)), mx = Math.max(...byM, 1);
    const cl = {}; live.forEach(i => (cl[i.client_name] = (cl[i.client_name] || 0) + Number(i.total)));
    const top = Object.entries(cl).sort((a, b) => b[1] - a[1]).slice(0, 6);
    $('#view').innerHTML = `<div class="bar"><label style="margin:0">Financial year</label><select id="fy">${fys.map(f => `<option value="${f}" ${f === cur ? 'selected' : ''}>FY 20${f.slice(2)}–${f.slice(0, 2)} (${f})</option>`).join('')}</select></div>
      <div class="stats"><div class="stat"><div class="n">₹${fmt(billed)}</div><div class="l">Billed (${live.length} invoices)</div></div>
      <div class="stat"><div class="n" style="color:var(--ok)">₹${fmt(got)}</div><div class="l">Received</div></div>
      <div class="stat"><div class="n" style="color:var(--warn)">₹${fmt(billed - got)}</div><div class="l">Pending</div></div>
      <div class="stat"><div class="n">₹${fmt(month)}</div><div class="l">Billed this month</div></div></div>
      <div class="card"><h3>Billed per month</h3><div class="bars">${byM.map((v, k) => `<div class="b" title="₹${fmt(v)}"><i style="height:${(v / mx) * 120}px"></i><span>${months[k].label}</span></div>`).join('')}</div></div>
      <div class="card"><h3>Top clients</h3>${top.length ? `<table class="list">${top.map(([n, v]) => `<tr><td>${esc(n)}</td><td class="r">₹${fmt(v)}</td></tr>`).join('')}</table>` : '<p class="muted">No data yet.</p>'}</div>`;
    $('#fy').onchange = e => { viewDashboard.fy = e.target.value; viewDashboard(); };
  }

  /* ---------- ADMIN ---------- */
  function viewAdmin() {
    if (!S.unlocked) {
      let pin = '';
      const dots = () => $('#dots').innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
      const press = k => { if (/^\d$/.test(k) && pin.length < 10) pin += k; else if (k === 'back') pin = pin.slice(0, -1); dots(); };
      const go = guard(async () => {
        if (!pin) return;
        if (await DB.verifyPin(pin)) { S.unlocked = true; document.removeEventListener('keydown', S.pinKey); viewAdmin(); }
        else { toast('Wrong PIN', true); pin = ''; dots(); }
      });
      $('#view').innerHTML = `<div class="card" style="max-width:320px;margin:50px auto;text-align:center"><h3>Admin panel</h3><p class="muted">Enter the admin PIN</p>
        <div id="dots" class="dots"></div>
        <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="btn" data-k="${n}">${n}</button>`).join('')}<button class="btn" data-k="back" aria-label="Delete">⌫</button><button class="btn" data-k="0">0</button><button class="btn primary" data-k="go">Unlock</button></div>
        <p class="muted small">You can also type the PIN on your keyboard.</p></div>`;
      dots();
      $('.pad').onclick = e => { const k = e.target.closest('[data-k]')?.dataset.k; if (!k) return; k === 'go' ? go() : press(k); };
      document.removeEventListener('keydown', S.pinKey);
      S.pinKey = e => { if (e.key === 'Enter') go(); else if (e.key === 'Backspace') press('back'); else if (/^\d$/.test(e.key) && !e.metaKey && !e.ctrlKey) press(e.key); };
      document.addEventListener('keydown', S.pinKey);
      return;
    }
    const st = S.settings;
    const ck = (id, v, label) => `<label class="check"><input type="checkbox" id="${id}" ${v ? 'checked' : ''}> ${label}</label>`;
    const fld = (id, label, v, type = 'text') => `<div><label>${label}</label><input id="${id}" type="${type}" value="${esc(v)}"></div>`;
    $('#view').innerHTML = `<div class="bar"><h2 class="grow" style="margin:0">Admin</h2><button class="btn" id="lock">Lock</button></div>
      <div class="card"><h3>Invoice numbering</h3>
        ${ck('s-auto', st.fy_auto, 'Switch financial year automatically on 1 April (FY 2027-28 becomes 2827, first bill 282701)')}
        <div class="row c3">${fld('s-prefix', 'FY prefix (used when auto is off)', st.fy_prefix)}${fld('s-digits', 'Running-number digits', st.seq_digits, 'number')}${fld('s-due', 'Default payment terms (days)', st.default_due_days, 'number')}</div>
        <p class="muted small">Next invoice number: <b id="next-no">…</b>. Changing the prefix starts a new sequence at 01. Numbers are never reused.</p></div>
      <div class="card"><h3>Bank details &amp; signature</h3><div class="row c3">${fld('s-bank', 'Bank', st.bank_name)}${fld('s-accname', 'Account name', st.account_name)}${fld('s-accno', 'Account no.', st.account_no)}${fld('s-ifsc', 'IFSC', st.ifsc)}${fld('s-gst', 'GST no. (printed under Pay to)', st.gst_no)}${fld('s-signco', 'Company line under signature', st.signer_company)}</div>
        <div class="row c2">${fld('s-signer', 'Default signed by', st.signer_name)}</div>
        ${ck('s-byuser', st.sign_by_login, 'Sign each invoice with the name of whoever is logged in (Abhijith / Meha) instead of the default')}</div>
      <div class="card"><h3>Optional invoice lines</h3>${ck('s-disc', st.discount_enabled, 'Enable discount line')}${ck('s-gston', st.gst_enabled, 'Enable GST line')}
        <div style="max-width:200px">${fld('s-gstrate', 'Default GST rate (%)', st.gst_rate, 'number')}</div>
        <p class="muted small">You are on the GST composition scheme, so leave both off. They only affect new or edited invoices.</p></div>
      <div class="bar"><button class="btn primary" id="save-set">Save settings</button></div>
      <div class="card"><h3>Brands</h3><div id="brands"></div><button class="btn sm" id="add-brand">+ Add brand</button></div>
      <div class="card"><h3>Download bills by date range</h3>
        <div class="bar"><label style="margin:0">From</label><input type="date" id="x1"><label style="margin:0">To</label><input type="date" id="x2">
        <label class="check" style="margin:0"><input type="checkbox" id="x-canc"> include cancelled</label></div>
        <div class="bar"><button class="btn primary" id="x-zip">Download all as PDFs (ZIP)</button><button class="btn" id="x-csv">Download register (CSV / Excel)</button></div>
        <p class="muted small" id="x-prog"></p></div>
      <div class="card"><h3>Change admin PIN</h3><div class="row c3">${fld('pin-old', 'Current PIN', '', 'text')}${fld('pin-new', 'New PIN (min 4 digits)', '', 'text')}<div><label>&nbsp;</label><button class="btn" id="pin-save">Change PIN</button></div></div></div>`;
    DB.peekNumber().then(n => ($('#next-no') && ($('#next-no').textContent = n)));
    $('#lock').onclick = () => { S.unlocked = false; viewAdmin(); };
    $('#save-set').onclick = guard(async () => {
      S.settings = await DB.saveSettings({
        fy_auto: $('#s-auto').checked, fy_prefix: $('#s-prefix').value.trim(), seq_digits: Number($('#s-digits').value) || 2, default_due_days: Number($('#s-due').value) || 0,
        bank_name: $('#s-bank').value, account_name: $('#s-accname').value, account_no: $('#s-accno').value, ifsc: $('#s-ifsc').value, gst_no: $('#s-gst').value,
        signer_name: $('#s-signer').value, signer_company: $('#s-signco').value, sign_by_login: $('#s-byuser').checked,
        discount_enabled: $('#s-disc').checked, gst_enabled: $('#s-gston').checked, gst_rate: Number($('#s-gstrate').value) || 0,
      });
      toast('Settings saved'); viewAdmin();
    });
    const drawBrands = () => {
      $('#brands').innerHTML = S.brands.map(b => `<div class="card" style="background:#fafafd" data-b="${b.id}"><div class="row c3">
        <div><label>Brand name</label><input data-k="name" value="${esc(b.name)}"></div><div><label>Title line under logo</label><input data-k="title_line" value="${esc(b.title_line)}"></div>
        <div><label>Logo ${logoOf(b) ? `<img src="${esc(logoOf(b))}" style="height:22px;vertical-align:middle">` : '(none)'}</label><input type="file" accept="image/*" data-logo></div>
        <div><label>Footer email</label><input data-k="email" value="${esc(b.email)}"></div><div><label>Footer phone</label><input data-k="phone" value="${esc(b.phone)}"></div>
        <div><label>Default brand</label><label class="check"><input type="checkbox" data-k="is_default" ${b.is_default ? 'checked' : ''}> use for new invoices</label></div></div>
        <label>Small print at the bottom</label><textarea data-k="footer_text">${esc(b.footer_text)}</textarea>
        <p style="margin:10px 0 0"><button class="btn sm primary" data-savebrand>Save brand</button></p></div>`).join('');
    };
    drawBrands();
    $('#brands').onclick = guard(async e => {
      if (!e.target.matches('[data-savebrand]')) return;
      const card = e.target.closest('[data-b]'), b = { ...S.brands.find(x => x.id === card.dataset.b) };
      $$('[data-k]', card).forEach(i => (b[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value));
      const f = $('[data-logo]', card).files[0]; if (f) b.logo_url = await DB.uploadLogo(f);
      await DB.saveBrand(b);
      if (b.is_default) for (const o of S.brands.filter(x => x.id !== b.id && x.is_default)) await DB.saveBrand({ ...o, is_default: false });
      S.brands = await DB.listBrands(); drawBrands(); toast('Brand saved');
    });
    $('#add-brand').onclick = guard(async () => { await DB.saveBrand({ name: 'New brand', title_line: S.settings.signer_company, email: '', phone: '', footer_text: '', is_default: false }); S.brands = await DB.listBrands(); drawBrands(); });
    const range = () => S.invoices.filter(i => (!$('#x1').value || i.issue_date >= $('#x1').value) && (!$('#x2').value || i.issue_date <= $('#x2').value) && i.status !== 'draft' && ($('#x-canc').checked || i.status !== 'cancelled'));
    $('#x-csv').onclick = () => {
      const rows = range().slice().sort((a, b) => a.issue_date.localeCompare(b.issue_date) || a.seq - b.seq); if (!rows.length) return toast('No invoices in that range', true);
      const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = ['Invoice no,Date,Client,Items,Subtotal,Discount,Tax,Total,Received,Balance,Status,Due date,Paid date,Created by']
        .concat(rows.map(i => [i.number, dmy(i.issue_date), i.client_name, i.items.map(x => x.desc.replace(/\n/g, ' ')).join('; '), i.subtotal, i.discount, i.tax, i.total, i.amount_paid, i.status === 'cancelled' ? 0 : balance(i), i.status, dmy(i.due_date), dmy(i.paid_date), i.created_by].map(q).join(','))).join('\n');
      saveBlob(new Blob(['﻿' + csv], { type: 'text/csv' }), `GFE_invoice_register_${$('#x1').value || 'start'}_to_${$('#x2').value || 'today'}.csv`);
    };
    $('#x-zip').onclick = guard(async () => {
      const rows = range(); if (!rows.length) return toast('No invoices in that range', true);
      const zip = new JSZip(); const p = $('#x-prog');
      for (let n = 0; n < rows.length; n++) { p.textContent = `Rendering ${n + 1} of ${rows.length}: ${rows[n].number}…`; zip.file(pdfName(rows[n]), await renderPDF(rows[n])); }
      p.textContent = 'Zipping…'; saveBlob(await zip.generateAsync({ type: 'blob' }), `GFE_invoices_${$('#x1').value || 'start'}_to_${$('#x2').value || 'today'}.zip`);
      p.textContent = `Done: ${rows.length} invoices.`;
    });
    $('#pin-save').onclick = guard(async () => {
      const n = $('#pin-new').value.trim(); if (n.length < 4) return toast('New PIN must be at least 4 digits', true);
      if (await DB.changePin($('#pin-old').value.trim(), n)) { toast('PIN changed'); $('#pin-old').value = $('#pin-new').value = ''; } else toast('Current PIN is wrong', true);
    });
  }

  /* ---------- router ---------- */
  function route() {
    const [tab, a, b] = location.hash.replace('#', '').split('/');
    const t = tab || 'new';
    closeModal(); document.removeEventListener('keydown', S.pinKey);
    $$('#nav a').forEach(x => x.classList.toggle('on', x.dataset.tab === t));
    if (t !== 'admin') S.unlocked = false;
    window.onresize = null; $('#view').oninput = $('#view').onchange = null;
    const run = { new: () => viewEditor(a === 'x' ? null : a, b), history: viewHistory, pending: viewPending, dashboard: viewDashboard, admin: viewAdmin }[t] || (() => (location.hash = '#new'));
    guard(run)();
  }

  /* ---------- boot ---------- */
  async function start() {
    $('#boot').hidden = true;
    $('#btn-logout').onclick = async () => { await DB.signOut(); location.reload(); };
    $('#btn-login').onclick = () => DB.signIn();
    let me;
    try { me = await DB.init(); } catch (e) { $('#login').hidden = false; $('#login-msg').textContent = e.message; return; }
    if (!me) { $('#login').hidden = false; return; }
    if (me.denied) { $('#login').hidden = false; $('#login-msg').textContent = `${me.denied} is not authorised for this tool.`; return; }
    S.user = me; $('#who').textContent = me.name;
    $('#demo-banner').hidden = !DB.demo; if (DB.demo) $('#proj-link').href = 'projects.html?demo=1';
    try { await refresh(); } catch (e) { $('#login').hidden = false; $('#login-msg').textContent = 'Could not load data: ' + e.message; return; }
    $('#app').hidden = false; window.addEventListener('hashchange', route); route();
  }
  start();
})();
