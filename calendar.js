/* GFE Calendar. Talks to window.DB (login, invoices, team), window.CDB (calendar data), CalCore (dates, repeats, clashes), CalExport (PDF / picture / .ics). */
(() => {
  const C = CalCore;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
  const dmy = iso => (iso ? iso.split('-').reverse().join('.') : '');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], DOWN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const nice = iso => { const d = C.parse(iso); return `${DOWN[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const short = iso => { const d = C.parse(iso); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  const rangeText = (a, b) => (a === b ? short(a) : (a.slice(0, 7) === b.slice(0, 7) ? `${+a.slice(8)}–${short(b)}` : `${short(a)} – ${short(b)}`));
  const fmtTime = t => { if (!t) return ''; let [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${String(m).padStart(2, '0')} ${ap}`; };
  const ink = hex => { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255; return (0.299 * r + 0.587 * g + 0.114 * b) > 165 ? '#1c1c1c' : '#fff'; };
  const sfx = () => (DB.demo ? '?demo=1' : '');

  /* ---------- state ---------- */
  const S = { user: null, team: [], calendars: [], events: [], settings: null, invoices: [], projects: [], cursor: today() };
  const KEY = 'gfe-cal-ui';
  const ui = { view: innerWidth < 700 ? 'agenda' : 'month', hidden: [], hiddenCats: [], owner: '', q: '', auto: { inv: true, fu: true, proj: true }, colorBy: 'category' };
  try { Object.assign(ui, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
  const saveUI = () => { try { localStorage.setItem(KEY, JSON.stringify(ui)); } catch {} };

  /* ---------- ui helpers ---------- */
  function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 6000 : 2200); }
  const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { console.error(e); toast(e.message || String(e), true); } };
  function modal(html, cls) { const r = $('#modal-root'); r.innerHTML = `<div class="modal-bg"><div class="modal ${cls || ''}">${html}</div></div>`; $('.modal-bg', r).addEventListener('mousedown', e => { if (e.target.classList.contains('modal-bg')) closeModal(); }); return $('.modal', r); }
  const closeModal = () => ($('#modal-root').innerHTML = '');

  /* ---------- lookups ---------- */
  const cats = () => S.settings.categories;
  const catOf = id => cats().find(c => c.id === id) || { id, name: id, color: '#7a8aa0', closes: false };
  const calOf = id => S.calendars.find(c => c.id === id) || { id, name: '?', color: '#999', kind: 'other' };
  const catRank = id => { const i = cats().findIndex(c => c.id === id); return i < 0 ? 999 : i; };
  const startMonthFor = () => {
    const vis = S.calendars.filter(c => c.kind === 'school' && !ui.hidden.includes(c.id));
    return vis.length === 1 && vis[0].year_start_month ? vis[0].year_start_month : S.settings.year_start_month;
  };
  const weekStart = d => C.addDays(d, -((C.dow(d) - S.settings.week_starts_on + 7) % 7));

  /* ---------- items: events (with repeats expanded) + auto items from invoices / follow-ups / projects ---------- */
  const matchQ = e => { const q = ui.q.trim().toLowerCase(); if (!q) return true; return [e.title, e.location, e.notes, e.contact, e.owner, catOf(e.category).name, calOf(e.calendar_id).name].join(' ').toLowerCase().includes(q); };
  const visibleEvents = () => S.events.filter(e => !ui.hidden.includes(e.calendar_id) && !ui.hiddenCats.includes(e.category) && (!ui.owner || e.owner === ui.owner) && matchQ(e));
  const itemColor = (cat, cal) => (ui.colorBy === 'calendar' ? cal.color : cat.color);
  function autoItems(from, to) {
    const gfe = S.calendars.filter(c => c.kind === 'gfe'); if (gfe.length && gfe.every(c => ui.hidden.includes(c.id))) return [];   // hiding Games for Ed hides its automatic items too
    const out = [], q = ui.q.trim().toLowerCase(), add = (kind, date, title, color, href, meta) => { if (date < from || date > to) return; if (q && !title.toLowerCase().includes(q)) return; out.push({ key: kind + date + title, start: date, end: date, title, color, auto: true, kind, href, meta, cat: { name: { inv: 'Invoice due', fu: 'Payment follow-up', proj: 'Project' }[kind] }, cal: { name: 'Games for Ed (auto)', color } }); };
    if (ui.auto.inv && !ui.owner) S.invoices.filter(i => ['pending', 'partial'].includes(i.status) && i.due_date).forEach(i => add('inv', i.due_date, `Due: ${i.number} · ${i.client_name}`, '#d9733f', 'index.html' + sfx() + '#pending', `₹${Number(i.total - (i.amount_paid || 0)).toLocaleString('en-IN')} outstanding`));
    if (ui.auto.fu) S.invoices.filter(i => ['pending', 'partial'].includes(i.status) && i.next_follow_up && (!ui.owner || i.follow_up_owner === ui.owner)).forEach(i => add('fu', i.next_follow_up, `Chase: ${i.number} · ${i.client_name}${i.follow_up_owner ? ' (' + i.follow_up_owner + ')' : ''}`, '#7c4dbd', 'index.html' + sfx() + '#pending', i.poc_name ? 'Contact: ' + i.poc_name : ''));
    if (ui.auto.proj && !ui.owner) S.projects.filter(p => p.status !== 'cancelled').forEach(p => { if (p.start_date) add('proj', p.start_date, `Project starts: ${p.name}`, '#0f9d8a', 'projects.html' + sfx() + '#project/' + p.id, ''); if (p.end_date) add('proj', p.end_date, `Project ends: ${p.name}`, '#0f9d8a', 'projects.html' + sfx() + '#project/' + p.id, ''); });
    return out;
  }
  let ITEMS = new Map();
  function items(from, to, withAuto = true) {
    const out = C.expandAll(visibleEvents(), from, to).map(o => {
      const cat = catOf(o.ev.category), cal = calOf(o.ev.calendar_id), timed = !o.ev.all_day && o.ev.start_time;
      return { key: o.ev.id + '@' + o.start, start: o.start, end: o.end, title: o.ev.title, color: itemColor(cat, cal), cat, cal, ev: o.ev, recurring: o.recurring, time: timed ? fmtTime(o.ev.start_time) + (o.ev.end_time ? ' – ' + fmtTime(o.ev.end_time) : '') : '' };
    });
    if (withAuto) out.push(...autoItems(from, to));
    out.sort((a, b) => a.start.localeCompare(b.start) || (C.diff(b.end, b.start) - C.diff(a.end, a.start)) || a.title.localeCompare(b.title));
    out.forEach(i => ITEMS.set(i.key, i));
    return out;
  }
  const isClosed = it => !it.auto && it.cat.closes;

  /* ---------- navigation ---------- */
  function yearInfo() { const sm = startMonthFor(); return { sm, ...C.schoolYearOf(S.cursor, sm) }; }
  function range() {
    if (ui.view === 'month') { const f = C.addMonthsStart(S.cursor, 0), l = C.addDays(C.addMonthsStart(S.cursor, 1), -1); return [weekStart(f), C.addDays(weekStart(l), 6)]; }
    if (ui.view === 'week') { const a = weekStart(S.cursor); return [a, C.addDays(a, 6)]; }
    if (ui.view === 'year') { const y = yearInfo(); return [y.from, y.to]; }
    return [S.cursor, C.addDays(S.cursor, 59)];
  }
  function title() {
    const d = C.parse(S.cursor);
    if (ui.view === 'month') return `${C.MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    if (ui.view === 'week') { const [a, b] = range(); return `${rangeText(a, b)} ${b.slice(0, 4)}`; }
    if (ui.view === 'year') { const y = yearInfo(); return `School year ${C.yearLabel(y.startYear, y.sm)}`; }
    const [a, b] = range(); return `${short(a)} – ${short(b)} ${b.slice(0, 4)}`;
  }
  function step(dir) {
    if (ui.view === 'month') S.cursor = C.addMonthsStart(S.cursor, dir);
    else if (ui.view === 'week') S.cursor = C.addDays(S.cursor, 7 * dir);
    else if (ui.view === 'year') S.cursor = C.addMonthsStart(S.cursor, 12 * dir);
    else S.cursor = C.addDays(S.cursor, 30 * dir);
    draw();
  }

  /* ---------- shell: toolbar, chips, filters ---------- */
  function shell() {
    const own = [...new Set([...S.team, ...S.events.map(e => e.owner).filter(Boolean)])];
    $('#view').className = 'cal';
    $('#view').innerHTML = `<div class="ctool">
        <button class="btn sm" id="c-prev" aria-label="Previous">◀</button><button class="btn sm" id="c-today">Today</button><button class="btn sm" id="c-next" aria-label="Next">▶</button>
        <h2 class="title" id="c-title"></h2><span class="grow"></span>
        <div class="seg" id="c-views">${['month', 'week', 'year', 'agenda'].map(v => `<button data-v="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
        <button class="btn primary" id="c-new">+ Event</button><button class="btn" id="c-dl">Download</button><button class="btn" id="c-set">Settings</button></div>
      <div class="chips" id="c-chips"></div>
      <details class="filt" ${ui.q || ui.owner || ui.hiddenCats.length ? 'open' : ''}><summary>Search &amp; filters</summary><div class="inner">
        <div class="frow"><b>Search</b><input id="f-q" placeholder="Title, place, notes, person…" value="${esc(ui.q)}" style="max-width:320px"></div>
        <div class="frow"><b>Who</b><select id="f-owner" style="width:auto"><option value="">Everyone</option>${own.map(o => `<option ${ui.owner === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>
          <b style="min-width:auto;margin-left:10px">Colour by</b><select id="f-color" style="width:auto"><option value="category" ${ui.colorBy === 'category' ? 'selected' : ''}>Category</option><option value="calendar" ${ui.colorBy === 'calendar' ? 'selected' : ''}>School / calendar</option></select></div>
        <div class="frow"><b>Categories</b><span class="chips" id="c-catchips" style="margin:0"></span></div>
        <div class="frow"><b>Also show</b>${[['inv', 'Invoice due dates'], ['fu', 'Payment follow-ups'], ['proj', 'Project start / end']].map(([k, l]) => `<label class="check" style="margin:0"><input type="checkbox" data-auto="${k}" ${ui.auto[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div>
      </div></details><div id="c-body"></div>`;
    $('#c-prev').onclick = () => step(-1); $('#c-next').onclick = () => step(1); $('#c-today').onclick = () => { S.cursor = today(); draw(); };
    $('#c-views').onclick = e => { const v = e.target.dataset.v; if (v) { ui.view = v; saveUI(); draw(); } };
    $('#c-new').onclick = () => eventModal(null, null, { date: S.cursor === today() || ui.view === 'agenda' ? today() : S.cursor });
    $('#c-dl').onclick = downloadModal; $('#c-set').onclick = settingsModal;
    $('#f-q').oninput = e => { ui.q = e.target.value; saveUI(); drawBody(); }; $('#f-owner').onchange = e => { ui.owner = e.target.value; saveUI(); drawBody(); };
    $('#f-color').onchange = e => { ui.colorBy = e.target.value; saveUI(); drawBody(); };
    $$('[data-auto]').forEach(c => (c.onchange = () => { ui.auto[c.dataset.auto] = c.checked; saveUI(); drawBody(); }));
    chips();
  }
  function chips() {
    $('#c-chips').innerHTML = S.calendars.map(c => `<button class="cchip ${ui.hidden.includes(c.id) ? 'off' : ''}" data-cal="${c.id}"><i style="background:${c.color}"></i>${esc(c.name)}</button>`).join('') || '<span class="muted small">No calendars yet. Open Settings to add one.</span>';
    $('#c-chips').onclick = e => { const id = e.target.closest('[data-cal]')?.dataset.cal; if (!id) return; ui.hidden = ui.hidden.includes(id) ? ui.hidden.filter(x => x !== id) : [...ui.hidden, id]; saveUI(); chips(); drawBody(); };
    $('#c-catchips').innerHTML = cats().map(c => `<button class="cchip ${ui.hiddenCats.includes(c.id) ? 'off' : ''}" data-cat="${c.id}"><i style="background:${c.color}"></i>${esc(c.name)}</button>`).join('');
    $('#c-catchips').onclick = e => { const id = e.target.closest('[data-cat]')?.dataset.cat; if (!id) return; ui.hiddenCats = ui.hiddenCats.includes(id) ? ui.hiddenCats.filter(x => x !== id) : [...ui.hiddenCats, id]; saveUI(); chips(); drawBody(); };
  }
  function draw() { $$('#c-views button').forEach(b => b.classList.toggle('on', b.dataset.v === ui.view)); drawBody(); }
  function drawBody() {
    ITEMS = new Map(); $('#c-title').textContent = title(); $$('#c-views button').forEach(b => b.classList.toggle('on', b.dataset.v === ui.view));
    ({ month: viewMonth, week: viewWeek, year: viewYear, agenda: viewAgenda }[ui.view])($('#c-body'));
    $('#c-body').onclick = e => {
      const k = e.target.closest('[data-k]')?.dataset.k; if (k) return openItem(ITEMS.get(k));
      const m = e.target.closest('[data-month]')?.dataset.month; if (m) { S.cursor = m; ui.view = 'month'; saveUI(); return draw(); }
      const d = e.target.closest('[data-date]')?.dataset.date; if (d) dayModal(d);
    };
  }

  /* ---------- MONTH ---------- */
  function layoutWeek(ws, its) {
    const we = C.addDays(ws, 6), bars = its.filter(i => i.start <= we && i.end >= ws).map(i => ({ it: i, col: Math.max(0, C.diff(i.start, ws)), end: Math.min(6, C.diff(i.end, ws)), cl: i.start < ws, cr: i.end > we }));
    bars.sort((a, b) => a.col - b.col || (b.end - b.col) - (a.end - a.col) || a.it.title.localeCompare(b.it.title));
    const lanes = []; bars.forEach(b => { let l = 0; while (lanes[l] !== undefined && lanes[l] >= b.col) l++; lanes[l] = b.end; b.lane = l; }); return bars;
  }
  function viewMonth(root) {
    const [from, to] = range(), its = items(from, to), cm = S.cursor.slice(0, 7), t = today(), MAXL = 4;
    const order = Array.from({ length: 7 }, (_, i) => (S.settings.week_starts_on + i) % 7);
    let html = `<div class="mgrid"><div class="mhead">${order.map(d => `<div>${DOWN[d]}</div>`).join('')}</div>`;
    for (let ws = from; ws <= to; ws = C.addDays(ws, 7)) {
      const bars = layoutWeek(ws, its), shown = bars.filter(b => b.lane < MAXL), lanes = Math.min(MAXL + 1, 1 + Math.max(-1, ...shown.map(b => b.lane))), hidden = {};
      bars.filter(b => b.lane >= MAXL).forEach(b => { for (let c = b.col; c <= b.end; c++) hidden[c] = (hidden[c] || 0) + 1; });
      html += `<div class="wk" style="--lanes:${Math.max(1, lanes + (Object.keys(hidden).length ? 1 : 0))}"><div class="days">`;
      for (let c = 0; c < 7; c++) {
        const d = C.addDays(ws, c), dayItems = its.filter(i => i.start <= d && i.end >= d), closed = dayItems.some(isClosed), wk = [0, 6].includes(C.dow(d));
        html += `<div class="day ${d.slice(0, 7) !== cm ? 'other' : ''} ${d === t ? 'today' : ''} ${closed ? 'closed' : ''} ${wk ? 'weekend' : ''}" data-date="${d}"><span class="num">${+d.slice(8)}</span><div class="dots">${dayItems.slice(0, 5).map(i => `<i style="background:${i.color}"></i>`).join('')}</div></div>`;
      }
      html += '</div><div class="bars">' + shown.map(b => `<div class="bar ${b.cl ? 'cl' : ''} ${b.cr ? 'cr' : ''} ${b.it.auto ? 'auto' : ''}" data-k="${esc(b.it.key)}" title="${esc(b.it.title)}${b.it.time ? ' · ' + b.it.time : ''}" style="left:calc(${b.col} / 7 * 100% + 2px);width:calc(${b.end - b.col + 1} / 7 * 100% - 4px);top:${b.lane * 22}px;background:${b.it.color};color:${ink(b.it.color)}">${b.it.time && !b.cl ? `<span class="t">${esc(b.it.time.split(' – ')[0])}</span> ` : ''}${esc(b.it.title)}</div>`).join('')
        + Object.entries(hidden).map(([c, n]) => `<div class="more" data-date="${C.addDays(ws, +c)}" style="left:calc(${c} / 7 * 100%);top:${MAXL * 22}px">+${n} more</div>`).join('') + '</div></div>';
    }
    root.innerHTML = html + '</div>';
    if (!its.length && !S.events.length) root.innerHTML += '<div class="empty-cal">Nothing here yet. Click <b>+ Event</b> to add your first event.</div>';
  }

  /* ---------- WEEK ---------- */
  function cardHTML(it, dayIso) {
    const n = C.diff(it.end, it.start) + 1, k = dayIso ? C.diff(dayIso, it.start) + 1 : 0, ev = it.ev || {};
    return `<div class="ecard ${it.auto ? 'auto' : ''}" style="--c:${it.color}" data-k="${esc(it.key)}"><b>${esc(it.title)}</b><div class="m">${[it.time, n > 1 ? `Day ${k} of ${n}` : '', ev.location].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="m">${esc(it.cal.name)} · ${esc(it.cat.name)}${ev.owner ? ' · ' + esc(ev.owner) : ''}${it.recurring ? ' · repeats' : ''}</div></div>`;
  }
  function viewWeek(root) {
    const [from, to] = range(), its = items(from, to), t = today();
    let html = '<div class="wgrid">';
    for (let i = 0; i < 7; i++) {
      const d = C.addDays(from, i), di = its.filter(x => x.start <= d && x.end >= d);
      html += `<div class="wcol ${d === t ? 'today' : ''} ${di.some(isClosed) ? 'closed' : ''}"><h4>${DOWN[C.dow(d)]} <small>${short(d)}</small> <button class="link small" data-date="${d}" style="float:right">+ add</button></h4>${di.map(x => cardHTML(x, d)).join('') || '<span class="muted small">Nothing</span>'}</div>`;
    }
    root.innerHTML = html + '</div>';
  }

  /* ---------- YEAR ---------- */
  function viewYear(root) {
    const y = yearInfo(), its = items(y.from, y.to, false), t = today(), best = {};
    its.forEach(it => { for (let d = it.start; d <= it.end; d = C.addDays(d, 1)) { if (d < y.from || d > y.to) continue; const r = catRank(it.cat.id); if (!best[d] || r < best[d].r) best[d] = { r, color: it.color }; } });
    const order = Array.from({ length: 7 }, (_, i) => (S.settings.week_starts_on + i) % 7);
    let html = '<div class="ygrid">';
    for (let k = 0; k < 12; k++) {
      const m0 = C.addMonthsStart(y.from, k), yy = +m0.slice(0, 4), mm = +m0.slice(5, 7), first = (C.dow(m0) - S.settings.week_starts_on + 7) % 7, n = C.dim(yy, mm);
      html += `<div class="mini"><h4 data-month="${m0}">${C.MONTHS[mm - 1]} ${yy}</h4><table><tr>${order.map(d => `<th>${DOWN[d][0]}</th>`).join('')}</tr><tr>`;
      for (let i = 0; i < first; i++) html += '<td></td>';
      for (let d = 1; d <= n; d++) {
        const iso = C.ymd(yy, mm, d), b = best[iso], col = (first + d - 1) % 7;
        html += `<td class="${[0, 6].includes(C.dow(iso)) ? 'we' : ''}"><span class="${b ? 'c' : ''} ${iso === t ? 't' : ''}" data-date="${iso}" ${b ? `style="background:${b.color};color:${ink(b.color)}"` : ''}>${d}</span></td>`;
        if (col === 6 && d < n) html += '</tr><tr>';
      }
      html += '</tr></table></div>';
    }
    const used = [...new Map(its.map(i => [i.cat.id, i.cat])).values()].sort((a, b) => catRank(a.id) - catRank(b.id));
    const seen = new Set(), uniq = its.filter(i => !seen.has(i.ev.id + i.start) && seen.add(i.ev.id + i.start)), li = it => `<li data-k="${esc(it.key)}"><span class="d">${rangeText(it.start, it.end)}</span><i style="background:${it.color}"></i><span>${esc(it.title)}</span></li>`;
    const closures = uniq.filter(isClosed), others = uniq.filter(i => !isClosed(i));
    root.innerHTML = html + `</div><div class="legend">${used.map(c => `<span><i style="background:${c.color}"></i>${esc(c.name)}</span>`).join('')}</div>
      <div class="lists"><div class="card"><h3>Holidays &amp; closures</h3><ul class="dl">${closures.map(li).join('') || '<li class="muted">None</li>'}</ul></div>
      <div class="card"><h3>Key dates</h3><ul class="dl">${others.map(li).join('') || '<li class="muted">None</li>'}</ul></div></div>`;
  }

  /* ---------- AGENDA ---------- */
  function viewAgenda(root) {
    const [from, to] = range(), its = items(from, to), byDay = new Map(), t = today();
    its.forEach(it => { const d = it.start < from ? from : it.start; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(it); });
    let html = '<div class="agenda">';
    [...byDay.keys()].sort().forEach(d => {
      html += `<div class="agd ${d === t ? 'today' : ''}"><h4>${nice(d)}${d === t ? ' · Today' : ''}</h4>${byDay.get(d).map(it => `<div class="arow" style="--c:${it.color}" data-k="${esc(it.key)}"><div class="tm">${esc(it.time || (C.diff(it.end, it.start) ? rangeText(it.start, it.end) : 'All day'))}</div><div><b>${esc(it.title)}</b><div class="m">${[it.cal.name, it.cat.name, it.ev && it.ev.location, it.ev && it.ev.owner, it.recurring ? 'repeats' : ''].filter(Boolean).map(esc).join(' · ')}</div></div></div>`).join('')}</div>`;
    });
    root.innerHTML = html + (byDay.size ? '' : '<div class="empty-cal">Nothing in this period.</div>') + '</div>';
  }

  /* ---------- opening things ---------- */
  function openItem(it) {
    if (!it) return;
    if (it.auto) {
      const m = modal(`<h3>${esc(it.title)}</h3><p class="muted">${nice(it.start)} · ${esc(it.cat.name)}</p>${it.meta ? `<p>${esc(it.meta)}</p>` : ''}<p class="muted small">This comes from your invoices or projects, so it can't be edited here.</p>
        <div class="foot"><button class="btn" id="m-x">Close</button><a class="btn primary" href="${esc(it.href)}">Open</a></div>`, 'cm');
      $('#m-x', m).onclick = closeModal; return;
    }
    eventModal(it.ev, it.start);
  }
  function dayModal(d) {
    const its = items(d, d), m = modal(`<h3>${nice(d)}</h3><div id="dm">${its.map(it => `<div class="arow" style="--c:${it.color}" data-k="${esc(it.key)}"><div class="tm">${esc(it.time || 'All day')}</div><div><b>${esc(it.title)}</b><div class="m">${[it.cal.name, it.cat.name, it.ev && it.ev.location].filter(Boolean).map(esc).join(' · ')}</div></div></div>`).join('') || '<p class="muted">Nothing on this day.</p>'}</div>
      <div class="foot"><button class="btn" id="m-x">Close</button><button class="btn primary" id="m-add">+ Add event</button></div>`, 'cm');
    $('#m-x', m).onclick = closeModal; $('#m-add', m).onclick = () => eventModal(null, null, { date: d });
    $('#dm', m).onclick = e => { const k = e.target.closest('[data-k]')?.dataset.k; if (k) openItem(ITEMS.get(k)); };
  }

  /* ---------- EVENT modal ---------- */
  const monthsOpts = sel => C.MONTHS.map((m, i) => `<option value="${i + 1}" ${+sel === i + 1 ? 'selected' : ''}>${m}</option>`).join('');
  function eventModal(ev, occStart, defaults = {}) {
    const isNew = !ev, rec = !!(ev && ev.recur), dur = ev ? C.diff(ev.end_date, ev.start_date) : 0, schools = S.calendars.filter(c => c.kind === 'school');
    const defCal = ev ? ev.calendar_id : (S.calendars.find(c => c.kind === 'gfe' && !ui.hidden.includes(c.id)) || S.calendars.find(c => !ui.hidden.includes(c.id)) || S.calendars[0] || {}).id;
    const d0 = defaults.date || today(), v = ev || { calendar_id: defCal, category: 'workshop', title: '', start_date: d0, end_date: d0, all_day: true, recur_interval: 1, recur_exceptions: [] };
    if (!S.calendars.length) return toast('Add a calendar first (Settings).', true);
    let scope = rec ? 'one' : 'all';
    const m = modal(`<h3>${isNew ? 'New event' : 'Edit event'}</h3>
      ${rec ? `<div class="scope">This event repeats. Apply changes to: <label><input type="radio" name="scope" value="one" checked> Only ${short(occStart)}</label><label><input type="radio" name="scope" value="all"> All dates</label></div>` : ''}
      <label>Title</label><input id="e-title" value="${esc(v.title)}" autofocus>
      <div class="pickrow"><div><label>Calendar</label><select id="e-cal">${S.calendars.map(c => `<option value="${c.id}" ${c.id === v.calendar_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div><label>Category</label><select id="e-cat">${cats().map(c => `<option value="${c.id}" ${c.id === v.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div></div>
      <div class="pickrow"><div><label>Starts</label><input id="e-sd" type="date" value="${rec ? occStart : v.start_date}"></div><div><label>Ends (same day if one day)</label><input id="e-ed" type="date" value="${rec ? C.addDays(occStart, dur) : v.end_date}"></div></div>
      <label class="check"><input type="checkbox" id="e-all" ${v.all_day !== false ? 'checked' : ''}> All day</label>
      <div class="pickrow" id="e-times" ${v.all_day !== false ? 'hidden' : ''}><div><label>From</label><input id="e-st" type="time" value="${(v.start_time || '').slice(0, 5)}"></div><div><label>To</label><input id="e-et" type="time" value="${(v.end_time || '').slice(0, 5)}"></div></div>
      <div class="pickrow"><div><label>Place</label><input id="e-loc" value="${esc(v.location || '')}"></div><div><label>Who is going</label><select id="e-own"><option value="">—</option>${[...new Set([...S.team, v.owner].filter(Boolean))].map(o => `<option ${o === v.owner ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div></div>
      <div class="pickrow"><div><label>Held at (school) — warns if it's closed that day</label><select id="e-for"><option value="">— none —</option>${schools.map(c => `<option value="${c.id}" ${c.id === v.for_school_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        ${S.projects.length ? `<div><label>Project (optional)</label><select id="e-proj"><option value="">— none —</option>${S.projects.map(p => `<option value="${p.id}" ${p.id === v.project_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>` : ''}</div>
      <div class="pickrow"><div><label>Contact person</label><input id="e-con" value="${esc(v.contact || '')}"></div><div><label>Link</label><input id="e-link" type="url" placeholder="https://" value="${esc(v.link || '')}"></div></div>
      <label>Notes</label><textarea id="e-notes" rows="2">${esc(v.notes || '')}</textarea>
      <div class="pickrow"><div><label>Repeat</label><select id="e-rec">${[['', 'Does not repeat'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']].map(([k, l]) => `<option value="${k}" ${(v.recur || '') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div id="e-rbox" ${v.recur ? '' : 'hidden'}><label>Every</label><input id="e-int" type="number" min="1" value="${v.recur_interval || 1}"></div><div id="e-ubox" ${v.recur ? '' : 'hidden'}><label>Until (optional)</label><input id="e-until" type="date" value="${v.recur_until || ''}"></div></div>
      <div id="e-wd" class="wdays" style="margin-top:8px" ${v.recur === 'weekly' ? '' : 'hidden'}>${DOWN.map((d, i) => `<label><input type="checkbox" value="${i}" ${(v.recur_days && v.recur_days.length ? v.recur_days : [C.dow(v.start_date)]).includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
      <div id="e-warn"></div>
      <div class="foot">${isNew ? '' : '<button class="btn danger" id="e-del" style="margin-right:auto">Delete</button><button class="btn" id="e-dup">Duplicate</button>'}<button class="btn" id="m-x">Cancel</button><button class="btn primary" id="m-ok">${isNew ? 'Add event' : 'Save'}</button></div>`, 'cm');
    const g = id => $('#' + id, m);
    g('e-all').onchange = () => (g('e-times').hidden = g('e-all').checked);
    g('e-rec').onchange = () => { const r = g('e-rec').value; g('e-rbox').hidden = g('e-ubox').hidden = !r; g('e-wd').hidden = r !== 'weekly'; };
    g('e-sd').onchange = () => { if (g('e-ed').value < g('e-sd').value) g('e-ed').value = g('e-sd').value; };
    $$('[name=scope]', m).forEach(r => (r.onchange = () => { scope = r.value; g('e-sd').value = scope === 'one' ? occStart : ev.start_date; g('e-ed').value = scope === 'one' ? C.addDays(occStart, dur) : ev.end_date; g('e-rec').disabled = scope === 'one'; if (scope === 'one') { g('e-rbox').hidden = g('e-ubox').hidden = g('e-wd').hidden = true; } else g('e-rec').onchange(); }));
    if (rec) { g('e-rec').disabled = true; g('e-rbox').hidden = g('e-ubox').hidden = g('e-wd').hidden = true; }
    const collect = () => {
      const r = g('e-rec').value, row = {
        calendar_id: g('e-cal').value, for_school_id: g('e-for').value || null, title: g('e-title').value.trim(), category: g('e-cat').value, start_date: g('e-sd').value, end_date: g('e-ed').value || g('e-sd').value,
        all_day: g('e-all').checked, start_time: g('e-all').checked ? null : g('e-st').value || null, end_time: g('e-all').checked ? null : g('e-et').value || null,
        location: g('e-loc').value, owner: g('e-own').value || null, contact: g('e-con').value, link: g('e-link').value, notes: g('e-notes').value, project_id: g('e-proj') ? g('e-proj').value || null : (v.project_id || null),
        recur: r || null, recur_interval: r ? Math.max(1, Number(g('e-int').value) || 1) : 1, recur_until: r ? g('e-until').value || null : null,
        recur_days: r === 'weekly' ? $$('#e-wd input:checked', m).map(i => +i.value) : null,
      };
      if (scope === 'one') Object.assign(row, { recur: null, recur_interval: 1, recur_until: null, recur_days: null, recur_exceptions: [] });
      else row.recur_exceptions = ev ? ev.recur_exceptions || [] : [];
      return row;
    };
    const persist = async row => {
      if (ev && rec && scope === 'one') { await CDB.saveEvent({ id: ev.id, recur_exceptions: [...(ev.recur_exceptions || []), occStart] }); await CDB.saveEvent({ ...row, created_by: S.user.name }); }
      else if (ev) await CDB.saveEvent({ ...row, id: ev.id });
      else await CDB.saveEvent({ ...row, created_by: S.user.name });
      await reload(); closeModal(); toast(isNew ? 'Event added' : 'Saved'); shell(); draw();
    };
    g('m-x').onclick = closeModal;
    g('m-ok').onclick = guard(async () => {
      const row = collect();
      if (!row.title) return toast('Give the event a title', true);
      if (!row.start_date) return toast('Pick a start date', true);
      if (row.end_date < row.start_date) return toast('The end date is before the start date', true);
      if (!row.all_day && !row.start_time) return toast('Pick a start time, or tick All day', true);
      const cl = C.clashes({ ...row, id: ev ? ev.id : undefined }, S.events, cats());
      if (cl.closed.length || cl.owner.length) {
        const sch = calOf(row.for_school_id).name;
        g('e-warn').innerHTML = `<div class="warn"><b>Heads up before you save</b>${cl.closed.length ? `<div>${esc(sch)} is closed on:</div><ul>${cl.closed.slice(0, 6).map(c => `<li>${nice(c.date)}: ${esc(c.title)}</li>`).join('')}${cl.closed.length > 6 ? `<li>…and ${cl.closed.length - 6} more</li>` : ''}</ul>` : ''}
          ${cl.owner.length ? `<div>${esc(row.owner)} already has something on:</div><ul>${cl.owner.slice(0, 6).map(c => `<li>${nice(c.date)}: ${esc(c.title)}</li>`).join('')}</ul>` : ''}
          <div class="foot" style="margin-top:10px"><button class="btn" id="w-back">Go back</button><button class="btn primary" id="w-go">Save anyway</button></div></div>`;
        g('w-back').onclick = () => (g('e-warn').innerHTML = ''); g('w-go').onclick = guard(() => persist(row)); g('e-warn').scrollIntoView({ block: 'nearest' }); return;
      }
      await persist(row);
    });
    if (!isNew) {
      g('e-dup').onclick = () => { closeModal(); eventModal(null, null, { date: ev.start_date }); setTimeout(() => { const m2 = $('#modal-root'); const set = (id, val) => { const e = $('#' + id, m2); if (e) e.value = val; }; set('e-title', ev.title + ' (copy)'); set('e-cal', ev.calendar_id); set('e-cat', ev.category); set('e-sd', ev.start_date); set('e-ed', ev.end_date); set('e-loc', ev.location || ''); set('e-notes', ev.notes || ''); set('e-con', ev.contact || ''); set('e-link', ev.link || ''); if (ev.owner) set('e-own', ev.owner); if (ev.for_school_id) set('e-for', ev.for_school_id); }, 0); };
      g('e-del').onclick = () => deleteModal(ev, occStart);
    }
  }
  function deleteModal(ev, occStart) {
    const rec = !!ev.recur, m = modal(`<h3>Delete “${esc(ev.title)}”?</h3>${rec ? `<p class="muted">This event repeats.</p>` : '<p class="muted">This cannot be undone.</p>'}
      <div class="foot"><button class="btn" id="m-x">Cancel</button>${rec ? `<button class="btn danger" id="d-one">Only ${short(occStart)}</button><button class="btn danger" id="d-all">All dates</button>` : '<button class="btn danger" id="d-all">Delete</button>'}</div>`, 'cm');
    $('#m-x', m).onclick = closeModal;
    const done = async () => { await reload(); closeModal(); toast('Deleted'); shell(); draw(); };
    if (rec) $('#d-one', m).onclick = guard(async () => { await CDB.saveEvent({ id: ev.id, recur_exceptions: [...(ev.recur_exceptions || []), occStart] }); await done(); });
    $('#d-all', m).onclick = guard(async () => { await CDB.deleteEvent(ev.id); await done(); });
  }

  /* ---------- DOWNLOAD modal ---------- */
  function downloadModal() {
    const [from] = range(), y = yearInfo(), sm = y.sm;
    const yrs = [y.startYear - 1, y.startYear, y.startYear + 1].map(s => `<option value="${s}" ${s === y.startYear ? 'selected' : ''}>${C.yearLabel(s, sm)} (${C.MONTHS[sm - 1].slice(0, 3)} ${s} – ${C.MONTHS[(sm + 10) % 12].slice(0, 3)} ${sm === 1 ? s : s + 1})</option>`).join('');
    const m = modal(`<h3>Download</h3>
      <label>What do you want?</label><div class="seg" id="d-fmt" style="width:100%"><button data-f="pdf" class="on">PDF (print)</button><button data-f="png">Picture (PNG)</button><button data-f="ics">Calendar file (.ics)</button></div>
      <p class="muted small" id="d-hint" style="margin:6px 0 0">A designed page you can print or send. Open the .ics file to add events to Google or Apple Calendar.</p>
      <label>Period</label><div class="seg" id="d-per" style="width:100%"><button data-p="week">A week</button><button data-p="month" class="on">A month</button><button data-p="year">School year</button><button data-p="custom">Custom</button></div>
      <div class="pickrow" id="d-opts" style="margin-top:8px"></div>
      <label>Include</label><div class="chips" id="d-cals">${S.calendars.map(c => `<label class="cchip" style="margin:0"><input type="checkbox" data-c="${c.id}" ${ui.hidden.includes(c.id) ? '' : 'checked'} style="width:auto"> <i style="background:${c.color}"></i>${esc(c.name)}</label>`).join('')}</div>
      <label class="check"><input type="checkbox" id="d-auto"> Also include invoice due dates, follow-ups and project dates <span class="muted small">(leave off when sharing with a school)</span></label>
      <div class="foot"><button class="btn" id="m-x">Cancel</button><button class="btn primary" id="m-ok">Download</button></div>`, 'cm');
    let fmt = 'pdf', per = 'month';
    const opts = () => {
      const o = $('#d-opts', m);
      if (per === 'week') o.innerHTML = `<div><label>Week containing</label><input type="date" id="d-d" value="${S.cursor}"></div>`;
      else if (per === 'month') o.innerHTML = `<div><label>Month</label><input type="month" id="d-mo" value="${S.cursor.slice(0, 7)}"></div>`;
      else if (per === 'year') o.innerHTML = `<div><label>School year (starts ${C.MONTHS[sm - 1]}; change in Settings)</label><select id="d-y">${yrs}</select></div>`;
      else o.innerHTML = `<div><label>From</label><input type="date" id="d-f" value="${from}"></div><div><label>To</label><input type="date" id="d-t" value="${C.addDays(from, 30)}"></div>`;
    };
    opts();
    $('#d-fmt', m).onclick = e => { const f = e.target.dataset.f; if (!f) return; fmt = f; $$('#d-fmt button', m).forEach(b => b.classList.toggle('on', b === e.target)); $('#d-hint', m).textContent = { pdf: 'A designed page you can print or send.', png: 'One picture of the period, easy to send on WhatsApp.', ics: 'Open the file to add these events to Google Calendar, Apple Calendar or Outlook. Repeats are kept.' }[f]; };
    $('#d-per', m).onclick = e => { const p = e.target.dataset.p; if (!p) return; per = p; $$('#d-per button', m).forEach(b => b.classList.toggle('on', b === e.target)); opts(); };
    $('#m-x', m).onclick = closeModal;
    $('#m-ok', m).onclick = guard(async () => {
      let a, b, label;
      if (per === 'week') { const d = $('#d-d', m).value || S.cursor; a = weekStart(d); b = C.addDays(a, 6); label = `Week of ${short(a)} ${a.slice(0, 4)}`; }
      else if (per === 'month') { const mo = $('#d-mo', m).value || S.cursor.slice(0, 7); a = mo + '-01'; b = C.addDays(C.addMonthsStart(a, 1), -1); label = `${C.MONTHS[+mo.slice(5) - 1]} ${mo.slice(0, 4)}`; }
      else if (per === 'year') { const sy = +$('#d-y', m).value; a = C.ymd(sy, sm, 1); b = C.addDays(C.ymd(sm === 1 ? sy + 1 : sy + 1, sm, 1), -1); if (sm === 1) b = C.ymd(sy, 12, 31); label = `School year ${C.yearLabel(sy, sm)}`; }
      else { a = $('#d-f', m).value; b = $('#d-t', m).value; if (!a || !b || b < a) return toast('Pick a valid date range', true); label = `${dmy(a)} to ${dmy(b)}`; }
      const sel = new Set($$('#d-cals input:checked', m).map(i => i.dataset.c)); if (!sel.size) return toast('Pick at least one calendar', true);
      const evs = S.events.filter(e => sel.has(e.calendar_id) && !ui.hiddenCats.includes(e.category) && (!ui.owner || e.owner === ui.owner));
      toast('Preparing…');
      await CalExport.run({ format: fmt, period: per, from: a, to: b, label, events: evs, calendars: S.calendars.filter(c => sel.has(c.id)), allCalendars: S.calendars, categories: cats(), auto: $('#d-auto', m).checked ? autoItems(a, b) : [], weekStartsOn: S.settings.week_starts_on, startMonth: sm, colorBy: ui.colorBy, user: S.user.name });
      closeModal(); toast('Downloaded');
    });
  }

  /* ---------- SETTINGS modal ---------- */
  function settingsModal() {
    const cal = S.calendars.map(c => ({ ...c })), ct = cats().map(c => ({ ...c })), gen = { year_start_month: S.settings.year_start_month, week_starts_on: S.settings.week_starts_on }, removed = [];
    const used = id => S.events.filter(e => e.category === id).length;
    const m = modal(`<h3>Calendar settings</h3><div class="seg" id="s-tabs" style="margin-bottom:12px"><button data-t="g" class="on">General</button><button data-t="c">Calendars</button><button data-t="k">Categories</button></div><div id="s-body"></div>
      <div class="foot"><button class="btn" id="m-x">Cancel</button><button class="btn primary" id="m-ok">Save settings</button></div>`, 'cm');
    let tab = 'g';
    const draw2 = () => {
      const b = $('#s-body', m);
      if (tab === 'g') b.innerHTML = `<label>School year starts in</label><select id="g-sm">${monthsOpts(gen.year_start_month)}</select><p class="muted small">Indian school years usually run May to April. The year view and downloads use this. A school can have its own start month under Calendars (for example Papagoya starts in June).</p>
        <label>Weeks start on</label><select id="g-ws"><option value="0" ${gen.week_starts_on === 0 ? 'selected' : ''}>Sunday</option><option value="1" ${gen.week_starts_on === 1 ? 'selected' : ''}>Monday</option></select>`;
      if (tab === 'c') b.innerHTML = `${cal.map((c, n) => `<div class="srow"><input type="color" class="swatch" data-cc="${n}" value="${c.color}"><input data-cn="${n}" value="${esc(c.name)}" placeholder="Name"><select data-ck="${n}" class="hide-m"><option value="school" ${c.kind === 'school' ? 'selected' : ''}>School</option><option value="gfe" ${c.kind === 'gfe' ? 'selected' : ''}>Games for Ed</option><option value="other" ${c.kind === 'other' ? 'selected' : ''}>Other</option></select><select data-cy="${n}" class="hide-m" title="School year starts"><option value="">Year: default</option>${monthsOpts(c.year_start_month)}</select><button class="btn sm danger" data-cd="${n}">×</button></div>`).join('')}<button class="btn sm" id="c-add">+ Add calendar</button>
        <p class="muted small">Add one calendar per school, plus one for Games for Ed's own events. Deleting a calendar deletes all of its events.</p>`;
      if (tab === 'k') b.innerHTML = `${ct.map((c, n) => `<div class="srow" style="grid-template-columns:34px 1fr 110px 70px 36px"><input type="color" class="swatch" data-kc="${n}" value="${c.color}"><input data-kn="${n}" value="${esc(c.name)}"><label class="check" style="margin:0" title="Counts as a day the school is closed (used for clash warnings)"><input type="checkbox" data-kx="${n}" ${c.closes ? 'checked' : ''}> Closes school</label><span><button class="btn sm" data-ku="${n}">↑</button><button class="btn sm" data-kdn="${n}">↓</button></span><button class="btn sm danger" data-kd="${n}" ${used(c.id) ? 'disabled title="In use by ' + used(c.id) + ' events"' : ''}>×</button></div>`).join('')}<button class="btn sm" id="k-add">+ Add category</button>
        <p class="muted small">The order matters in the year view: when two things fall on one day, the category higher in this list wins the colour.</p>`;
    };
    draw2();
    $('#s-tabs', m).onclick = e => { if (e.target.dataset.t) { tab = e.target.dataset.t; $$('#s-tabs button', m).forEach(x => x.classList.toggle('on', x === e.target)); draw2(); } };
    const b = $('#s-body', m);
    b.oninput = b.onchange = e => {
      const t = e.target, d = t.dataset;
      if (t.id === 'g-sm') gen.year_start_month = +t.value; if (t.id === 'g-ws') gen.week_starts_on = +t.value;
      if (d.cc !== undefined) cal[d.cc].color = t.value; if (d.cn !== undefined) cal[d.cn].name = t.value; if (d.ck !== undefined) cal[d.ck].kind = t.value; if (d.cy !== undefined) cal[d.cy].year_start_month = t.value ? +t.value : null;
      if (d.kc !== undefined) ct[d.kc].color = t.value; if (d.kn !== undefined) ct[d.kn].name = t.value; if (d.kx !== undefined) ct[d.kx].closes = t.checked;
    };
    b.onclick = e => {
      const t = e.target.closest('button'); if (!t) return; const d = t.dataset;
      if (d.cd !== undefined) { const c = cal[d.cd]; const n = S.events.filter(x => x.calendar_id === c.id).length; if (!confirm(`Delete “${c.name}”${n ? ' and its ' + n + ' events' : ''}? This cannot be undone.`)) return; if (c.id) removed.push(c.id); cal.splice(+d.cd, 1); draw2(); }
      else if (t.id === 'c-add') { cal.push({ name: 'New calendar', kind: 'school', color: '#2f6fc4', year_start_month: null }); draw2(); }
      else if (d.kd !== undefined) { ct.splice(+d.kd, 1); draw2(); }
      else if (t.id === 'k-add') { ct.push({ id: 'cat' + Math.random().toString(36).slice(2, 7), name: 'New category', color: '#7a8aa0', closes: false }); draw2(); }
      else if (d.ku !== undefined && +d.ku > 0) { [ct[d.ku - 1], ct[d.ku]] = [ct[d.ku], ct[d.ku - 1]]; draw2(); }
      else if (d.kdn !== undefined && +d.kdn < ct.length - 1) { [ct[+d.kdn + 1], ct[d.kdn]] = [ct[d.kdn], ct[+d.kdn + 1]]; draw2(); }
    };
    $('#m-x', m).onclick = closeModal;
    $('#m-ok', m).onclick = guard(async () => {
      if (cal.some(c => !c.name.trim())) return toast('Every calendar needs a name', true); if (ct.some(c => !c.name.trim())) return toast('Every category needs a name', true);
      for (const id of removed) await CDB.deleteCalendar(id);
      for (const c of cal) { const o = S.calendars.find(x => x.id === c.id); if (!o || JSON.stringify(o) !== JSON.stringify(c)) await CDB.saveCalendar({ ...c, name: c.name.trim() }); }
      await CDB.saveSettings({ ...gen, categories: ct.map(c => ({ ...c, name: c.name.trim() })) });
      await reload(); closeModal(); toast('Settings saved'); shell(); draw();
    });
  }

  /* ---------- load + boot ---------- */
  async function reload() {
    const d = await CDB.load(); Object.assign(S, { calendars: d.calendars, events: d.events, settings: d.settings, projects: d.projects });
    S.invoices = await DB.listInvoices(); try { S.team = await DB.listTeam(); } catch { S.team = []; }
  }
  async function start() {
    $('#boot').hidden = true;
    let me; try { me = await DB.init(); } catch (e) { $('#boot').hidden = false; $('#boot').textContent = e.message; return; }
    if (!me || me.denied) { location.href = (DB.demo ? 'index.html?demo=1' : 'index.html'); return; }
    S.user = me; $('#who').textContent = me.name; $('#demo-banner').hidden = !DB.demo; $('#app').hidden = false;
    try { await reload(); } catch (e) { $('#view').innerHTML = `<div class="card setup"><h3>One-time setup needed</h3><p>${esc(e.message)}</p><ol><li>Open Supabase → <b>SQL Editor</b> → <b>New query</b>.</li><li>Paste the contents of <code>supabase/migration-calendar.sql</code> and click <b>Run</b>.</li><li>Then run <code>supabase/seed-calendar-papagoya.sql</code> the same way (optional: loads the Papagoya dates).</li><li>Reload this page.</li></ol></div>`; return; }
    shell(); draw();
    window.addEventListener('resize', () => { if (innerWidth < 700 && ui.view === 'month' && !start.warned) { start.warned = true; } });
  }
  start();
})();
