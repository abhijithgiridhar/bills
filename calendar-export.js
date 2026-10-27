/* Calendar downloads: designed PDF pages, a picture (PNG), and an .ics file. Uses CalCore, html2canvas and jsPDF. */
window.CalExport = (() => {
  const C = CalCore;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], DOWN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const short = iso => { const d = C.parse(iso); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  const nice = iso => { const d = C.parse(iso); return `${DOWN[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const rangeText = (a, b) => (a === b ? short(a) : (a.slice(0, 7) === b.slice(0, 7) ? `${+a.slice(8)}–${short(b)}` : `${short(a)} – ${short(b)}`));
  const fmtTime = t => { if (!t) return ''; let [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${String(m).padStart(2, '0')} ${ap}`; };
  const ink = hex => { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255; return (0.299 * r + 0.587 * g + 0.114 * b) > 165 ? '#1c1c1c' : '#fff'; };
  const PW = 1123, PH = 794; // A4 landscape at 96 dpi

  const CSS = `*{box-sizing:border-box}html,body{margin:0;background:#fff;font-family:'Open Sans',Arial,sans-serif;color:#2b2b3a}
  .page{width:${PW}px;height:${PH}px;padding:26px 34px 22px;overflow:hidden;position:relative;background:#fff;page-break-after:always}
  .hd{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #55559a;padding-bottom:8px;margin-bottom:10px}
  .hd h1{margin:0;font-size:30px;letter-spacing:.02em;color:#55559a}.hd .sub{font-size:12.5px;color:#666;margin-top:2px}.hd .brand{font-size:11px;color:#888;text-align:right}
  .lg{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:10.5px;margin-top:8px}.lg span{display:inline-flex;align-items:center;gap:5px}.lg i{width:11px;height:11px;border-radius:2px;display:inline-block}
  table.g{width:100%;border-collapse:collapse;table-layout:fixed}table.g th{font-size:11px;background:#55559a;color:#fff;padding:5px;letter-spacing:.06em;text-transform:uppercase}
  table.g td{border:1px solid #d9d9e6;vertical-align:top;padding:2px 3px;overflow:hidden}.dn{font-size:11px;font-weight:700;color:#444}.oth{background:#f6f6fa}.oth .dn{color:#bbb}.cls{background:#eef3fc}
  .ch{display:block;font-size:9.5px;line-height:13.5px;height:13.5px;border-radius:3px;padding:0 4px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}.mo{font-size:9.5px;color:#55559a;font-weight:700;margin-top:2px}
  h2.sec{margin:0 0 6px;font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:#55559a}
  table.l{width:100%;border-collapse:collapse;font-size:11px}table.l th{text-align:left;background:#f0f0f8;padding:5px 7px;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em}
  table.l td{border-bottom:1px solid #e5e5ee;padding:0 7px;height:34px;vertical-align:middle;overflow:hidden}table.l td.dt{white-space:nowrap;font-weight:700;width:118px}table.l td.cl{width:96px}table.l td div{max-height:30px;overflow:hidden;line-height:15px}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}.mut{color:#777;font-size:10px}
  .wk{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;height:560px}.wc{border:1px solid #d9d9e6;border-radius:6px;padding:5px;overflow:hidden}.wc h4{margin:0 0 5px;font-size:11.5px;color:#55559a;border-bottom:1px solid #e5e5ee;padding-bottom:3px}.wc.cls{background:#eef3fc}
  .wcard{border-left:4px solid var(--c);background:#f7f7fb;border-radius:4px;padding:3px 5px;margin-bottom:4px;font-size:10px;line-height:12.5px}.wcard b{display:block;font-size:10.8px}
  .yg{display:grid;grid-template-columns:repeat(4,1fr);gap:9px}.mn{border:1px solid #d9d9e6;border-radius:6px;overflow:hidden}.mn h4{margin:0;padding:3px 8px;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;background:#55559a;color:#fff}
  .mn table{width:100%;border-collapse:collapse;table-layout:fixed}.mn th{font-size:8.5px;color:#999;padding:2px 0}.mn td{text-align:center;height:19px;font-size:9.5px;padding:0}.mn td span{display:inline-block;min-width:16px;border-radius:3px;padding:1px 0}.mn td.we{color:#999}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:24px}.dl{list-style:none;margin:0;padding:0;font-size:11.5px}.dl li{display:flex;gap:8px;padding:2.4px 0;border-bottom:1px dotted #e0e0ea}.dl .d{min-width:92px;font-weight:700;color:#555}.dl i{width:10px;height:10px;border-radius:50%;margin-top:4px;flex:none}
  .ft{position:absolute;left:34px;right:34px;bottom:10px;font-size:9.5px;color:#999;display:flex;justify-content:space-between}`;

  /* ---------- data for a sheet ---------- */
  function collect(o) {
    const catOf = id => o.categories.find(c => c.id === id) || { id, name: id, color: '#7a8aa0', closes: false }, calOf = id => o.calendars.find(c => c.id === id) || { name: '', color: '#999' };
    const colorOf = (cat, cal) => (o.colorBy === 'calendar' ? cal.color : cat.color);
    const its = C.expandAll(o.events, o.from, o.to).map(x => { const cat = catOf(x.ev.category), cal = calOf(x.ev.calendar_id); return { start: x.start, end: x.end, title: x.ev.title, cat, cal, color: colorOf(cat, cal), ev: x.ev, time: !x.ev.all_day && x.ev.start_time ? fmtTime(x.ev.start_time) + (x.ev.end_time ? '–' + fmtTime(x.ev.end_time) : '') : '' }; });
    o.auto.forEach(a => its.push({ ...a, ev: null, time: '' }));
    const rank = id => { const i = o.categories.findIndex(c => c.id === id); return i < 0 ? 999 : i; };
    its.sort((a, b) => a.start.localeCompare(b.start) || rank(a.cat.id || '') - rank(b.cat.id || '') || a.title.localeCompare(b.title));
    return { its, catOf, calOf, rank };
  }
  const legend = (its, o) => { const m = new Map(); its.forEach(i => { const k = o.colorBy === 'calendar' ? i.cal.name : i.cat.name; if (k && !m.has(k)) m.set(k, i.color); }); return `<div class="lg">${[...m].map(([n, c]) => `<span><i style="background:${c}"></i>${esc(n)}</span>`).join('')}</div>`; };
  const head = (o, h1, sub, its) => `<div class="hd"><div><h1>${esc(h1)}</h1><div class="sub">${esc(sub)}</div></div><div class="brand">Games for Ed<br>Prepared ${nice(C.iso(new Date()))}</div></div>${its ? legend(its, o) : ''}`;
  const foot = (o, n, t) => `<div class="ft"><span>${esc(o.calendars.map(c => c.name).join(' · ') || 'Calendar')}</span><span>Page ${n} of ${t}</span></div>`;
  const calNames = o => (o.calendars.length === 1 ? o.calendars[0].name : o.calendars.map(c => c.name).join(' + ')) || 'Calendar';

  /* ---------- list pages (detailed table) ---------- */
  function listRows(its) {
    const seen = new Set(), rows = []; its.forEach(i => { const k = (i.ev ? i.ev.id : i.title) + i.start; if (!seen.has(k)) { seen.add(k); rows.push(i); } }); return rows;
  }
  function listPages(o, its, heading, firstH) {
    const rows = listRows(its), per = 17, pages = [];
    for (let p = 0; p < Math.max(1, Math.ceil(rows.length / per)); p++) {
      const chunk = rows.slice(p * per, (p + 1) * per);
      pages.push(`${head(o, heading, p ? 'Detailed list (continued)' : firstH, null)}<table class="l"><tr><th>Date</th><th>Event</th><th>Category</th><th>Calendar</th><th>Details</th></tr>${chunk.map(i => {
        const e = i.ev || {}, at = e.for_school_id && (o.allCalendars || []).find(c => c.id === e.for_school_id), det = [i.time, at && 'At ' + at.name, e.location, e.owner && 'With ' + e.owner, e.contact && 'Contact: ' + e.contact, e.notes].filter(Boolean).join(' · ');
        return `<tr><td class="dt">${rangeText(i.start, i.end)}</td><td><div><b>${esc(i.title)}</b></div></td><td><div><span class="dot" style="background:${i.color}"></span>${esc(i.cat.name)}</div></td><td class="cl"><div class="mut">${esc(i.cal.name)}</div></td><td><div class="mut">${esc(det)}</div></td></tr>`;
      }).join('') || '<tr><td colspan="5" class="mut" style="padding:20px">Nothing in this period.</td></tr>'}</table>`);
    }
    return pages;
  }

  /* ---------- month / week / year sheets ---------- */
  function monthPage(o, d) {
    const m0 = o.from.slice(0, 7) + '-01', ws = day => C.addDays(day, -((C.dow(day) - o.weekStartsOn + 7) % 7)), gs = ws(m0), ge = C.addDays(ws(o.to), 6), weeks = (C.diff(ge, gs) + 1) / 7;
    const order = Array.from({ length: 7 }, (_, i) => (o.weekStartsOn + i) % 7), maxChips = weeks > 5 ? 5 : 6, rowH = Math.floor(545 / weeks);
    let g = `<table class="g"><tr>${order.map(x => `<th>${DOWN[x]}</th>`).join('')}</tr>`;
    for (let w = gs; w <= ge; w = C.addDays(w, 7)) {
      g += '<tr>';
      for (let c = 0; c < 7; c++) {
        const day = C.addDays(w, c), di = d.its.filter(i => i.start <= day && i.end >= day), closed = di.some(i => !i.ev ? false : i.cat.closes);
        const shown = di.slice(0, maxChips), more = di.length - shown.length;
        g += `<td class="${day.slice(0, 7) !== m0.slice(0, 7) ? 'oth' : ''} ${closed ? 'cls' : ''}" style="height:${rowH}px"><div class="dn">${+day.slice(8)}</div>${shown.map(i => `<span class="ch" style="background:${i.color};color:${ink(i.color)}">${i.start < day ? '↳ ' : ''}${i.time && i.start === day ? esc(i.time.split('–')[0].replace(' AM', 'a').replace(' PM', 'p')) + ' ' : ''}${esc(i.title)}</span>`).join('')}${more > 0 ? `<div class="mo">+${more} more</div>` : ''}</td>`;
      }
      g += '</tr>';
    }
    return `${head(o, o.label, calNames(o), d.its)}${g}</table>`;
  }
  function weekPage(o, d) {
    let cols = '';
    for (let i = 0; i < 7; i++) {
      const day = C.addDays(o.from, i), di = d.its.filter(x => x.start <= day && x.end >= day), shown = di.slice(0, 9);
      cols += `<div class="wc ${di.some(x => x.ev && x.cat.closes) ? 'cls' : ''}"><h4>${DOWN[C.dow(day)]} ${short(day)}</h4>${shown.map(x => `<div class="wcard" style="--c:${x.color}"><b>${esc(x.title)}</b>${esc([x.time, x.ev && x.ev.location, x.cal.name].filter(Boolean).join(' · '))}${x.ev && x.ev.owner ? '<br>With ' + esc(x.ev.owner) : ''}</div>`).join('') || '<span class="mut">Nothing</span>'}${di.length > shown.length ? `<div class="mo">+${di.length - shown.length} more (see list)</div>` : ''}</div>`;
    }
    return `${head(o, o.label, calNames(o), d.its)}<div class="wk">${cols}</div>`;
  }
  function yearPages(o, d) {
    const best = {}; d.its.filter(i => i.ev).forEach(it => { for (let x = it.start; x <= it.end; x = C.addDays(x, 1)) { if (x < o.from || x > o.to) continue; const r = d.rank(it.cat.id); if (!best[x] || r < best[x].r) best[x] = { r, color: it.color }; } });
    const order = Array.from({ length: 7 }, (_, i) => (o.weekStartsOn + i) % 7); let minis = '';
    for (let k = 0; k < 12; k++) {
      const m0 = C.addMonthsStart(o.from, k), yy = +m0.slice(0, 4), mm = +m0.slice(5, 7), first = (C.dow(m0) - o.weekStartsOn + 7) % 7, n = C.dim(yy, mm);
      minis += `<div class="mn"><h4>${C.MONTHS[mm - 1]} ${yy}</h4><table><tr>${order.map(x => `<th>${DOWN[x][0]}</th>`).join('')}</tr><tr>`;
      for (let i = 0; i < first; i++) minis += '<td></td>';
      for (let x = 1; x <= n; x++) { const iso = C.ymd(yy, mm, x), b = best[iso]; minis += `<td class="${[0, 6].includes(C.dow(iso)) ? 'we' : ''}"><span ${b ? `style="background:${b.color};color:${ink(b.color)};font-weight:700"` : ''}>${x}</span></td>`; if ((first + x - 1) % 7 === 6 && x < n) minis += '</tr><tr>'; }
      minis += '</tr></table></div>';
    }
    const first = `${head(o, o.label, calNames(o), d.its.filter(i => i.ev))}<div class="yg">${minis}</div>`;
    const rows = listRows(d.its), clos = rows.filter(i => i.ev && i.cat.closes), oth = rows.filter(i => !(i.ev && i.cat.closes));
    const li = i => `<li><span class="d">${rangeText(i.start, i.end)}</span><i style="background:${i.color}"></i><span>${esc(i.title)}</span></li>`, per = 24, pages = [first];
    for (let p = 0; p < Math.max(1, Math.ceil(Math.max(clos.length, oth.length) / per)); p++)
      pages.push(`${head(o, o.label + (p ? ' (continued)' : ''), 'Holidays & key dates', null)}<div class="two"><div><h2 class="sec">Holidays &amp; closures</h2><ul class="dl">${clos.slice(p * per, (p + 1) * per).map(li).join('') || '<li class="mut">None</li>'}</ul></div><div><h2 class="sec">Key dates</h2><ul class="dl">${oth.slice(p * per, (p + 1) * per).map(li).join('') || '<li class="mut">None</li>'}</ul></div></div>`);
    return pages.concat(listPages(o, d.its, o.label, 'Detailed list with places, people and notes'));
  }
  function buildPages(o) {
    const d = collect(o);
    let pages;
    if (o.period === 'month') pages = [monthPage(o, d), ...listPages(o, d.its, o.label, 'Detailed list')];
    else if (o.period === 'week') pages = [weekPage(o, d), ...listPages(o, d.its, o.label, 'Detailed list')];
    else if (o.period === 'year') pages = yearPages(o, d);
    else pages = listPages(o, d.its, o.label, 'Detailed list');
    return pages.map((inner, i) => `<div class="page">${inner}${foot(o, i + 1, pages.length)}</div>`);
  }

  /* ---------- rendering (isolated iframe, so page scroll and window size cannot affect the result) ---------- */
  async function renderPages(pages, scale) {
    const fr = document.createElement('iframe'); fr.setAttribute('aria-hidden', 'true');
    fr.style.cssText = `position:fixed;left:0;top:0;width:${PW + 40}px;height:${PH + 40}px;border:0;opacity:0;pointer-events:none;z-index:-1`; document.body.appendChild(fr);
    try {
      const doc = fr.contentDocument; doc.open();
      doc.write(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap"><style>${CSS}</style></head><body>${pages.join('')}</body></html>`); doc.close();
      const until = async (ok, ms = 8000) => { const t0 = Date.now(); while (!ok() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 50)); };
      await until(() => doc.readyState === 'complete'); await Promise.all(['400 12px "Open Sans"', '600 12px "Open Sans"', '700 12px "Open Sans"'].map(f => doc.fonts.load(f).catch(() => 0))); await doc.fonts.ready;
      const out = []; for (const el of [...doc.querySelectorAll('.page')]) out.push(await html2canvas(el, { scale, backgroundColor: '#fff', useCORS: true, scrollX: 0, scrollY: 0, windowWidth: PW + 40, windowHeight: PH + 40 }));
      return out;
    } finally { fr.remove(); }
  }
  function save(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
  const safe = s => s.replace(/[\\/:*?"<>|]+/g, '-');

  /* ---------- public ---------- */
  async function run(o) {
    const name = `GFE Calendar - ${safe(o.label)}`;
    if (o.format === 'ics') {
      const inRange = o.events.filter(e => C.occurrences(e, o.from, o.to).length);
      const autoEv = o.auto.map((a, i) => ({ id: 'auto' + i + a.start, uid: 'auto-' + a.kind + '-' + a.start + '-' + i, title: a.title, start_date: a.start, end_date: a.start, all_day: true, notes: a.meta || '', category: '', calendar_id: '' }));
      const ics = C.toICS([...inRange, ...autoEv], { name: `Games for Ed - ${o.label}`, categories: o.categories, calendars: o.calendars });
      if (!inRange.length && !autoEv.length) throw new Error('There are no events in that period.');
      return save(new Blob([ics], { type: 'text/calendar;charset=utf-8' }), name + '.ics');
    }
    const pages = buildPages(o);
    if (o.format === 'png') {
      const [cv] = await renderPages([pages[0]], 1.6);
      return new Promise((res, rej) => cv.toBlob(b => (b ? (save(b, name + '.png'), res()) : rej(new Error('Could not create the picture'))), 'image/png'));
    }
    const canvases = await renderPages(pages, 2), pdf = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    canvases.forEach((cv, i) => { if (i) pdf.addPage(); pdf.addImage(cv.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 297, 210); });
    save(pdf.output('blob'), name + '.pdf');
  }
  return { run, buildPages, collect };
})();
