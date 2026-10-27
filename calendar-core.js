/* Calendar core: dates, repeating events, clash checks, .ics export. Pure functions (no DOM), also usable from Node for tests. */
(function (root) {
  const DAY = 864e5, pad = n => String(n).padStart(2, '0');
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const iso = d => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  const addDays = (s, n) => iso(new Date(parse(s).getTime() + n * DAY));
  const diff = (a, b) => Math.round((parse(a) - parse(b)) / DAY);               // a - b in days
  const dow = s => parse(s).getUTCDay();                                         // 0 = Sunday
  const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();                // days in month (m = 1..12)
  const ymd = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);
  const addMonthsStart = (s, n) => { const d = parse(s); return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))); };
  const overlaps = (a1, a2, b1, b2) => a1 <= b2 && b1 <= a2;

  /* ---- repeating events: every occurrence that touches [from, to] ---- */
  function occurrences(ev, from, to) {
    const dur = diff(ev.end_date, ev.start_date), out = [], ex = new Set(ev.recur_exceptions || []);
    const push = s => { if (ex.has(s)) return; const e = addDays(s, dur); if (e >= from && s <= to) out.push({ ev, start: s, end: e, recurring: !!ev.recur }); };
    if (!ev.recur) { push(ev.start_date); return out; }
    const until = ev.recur_until && ev.recur_until < to ? ev.recur_until : to, step = Math.max(1, ev.recur_interval || 1), st = ev.start_date;
    let guard = 0;
    if (ev.recur === 'daily') {
      let s = st; const gap = diff(from, s) - dur;
      if (gap > step) s = addDays(s, Math.floor(gap / step) * step);
      for (; s <= until && guard++ < 6000; s = addDays(s, step)) if (s >= st) push(s);
    } else if (ev.recur === 'weekly') {
      const days = (ev.recur_days && ev.recur_days.length ? [...ev.recur_days] : [dow(st)]).sort((a, b) => a - b), w0 = addDays(st, -dow(st));
      let w = 0; const gapWeeks = Math.floor((diff(from, w0) - dur - 7) / (7 * step)); if (gapWeeks > 0) w = gapWeeks;
      for (; guard++ < 6000; w++) {
        const ws = addDays(w0, w * 7 * step); if (ws > until) break;
        days.forEach(d => { const s = addDays(ws, d); if (s >= st && s <= until) push(s); });
      }
    } else if (ev.recur === 'monthly') {
      const [y0, m0, d0] = st.split('-').map(Number);
      for (let k = 0; guard++ < 6000; k += step) {
        const mm = m0 - 1 + k, y = y0 + Math.floor(mm / 12), m = (mm % 12 + 12) % 12 + 1, s0 = ymd(y, m, 1); if (s0 > until) break;
        if (d0 <= dim(y, m)) push(ymd(y, m, d0));                                  // months without that day are skipped (same as the .ics rule)
      }
    } else if (ev.recur === 'yearly') {
      const [y0, m0, d0] = st.split('-').map(Number);
      for (let k = 0; guard++ < 400; k += step) { const y = y0 + k; if (ymd(y, m0, 1) > until) break; if (d0 <= dim(y, m0)) push(ymd(y, m0, d0)); }
    }
    return out;
  }
  const expandAll = (events, from, to) => events.flatMap(ev => occurrences(ev, from, to));

  /* ---- clash warnings ---- */
  const timeRange = ev => (ev.all_day || !ev.start_time ? null : [ev.start_time.slice(0, 5), (ev.end_time || ev.start_time).slice(0, 5)]);
  function clashes(draft, all, categories) {
    const closes = new Set(categories.filter(c => c.closes).map(c => c.id)), res = { closed: [], owner: [] };
    const win = draft.recur ? addDays(draft.start_date, 400) : draft.end_date, to = draft.recur_until && draft.recur_until < win ? draft.recur_until : win;
    const mine = occurrences({ ...draft, recur_exceptions: draft.recur_exceptions || [] }, draft.start_date, to).slice(0, 80);
    if (draft.for_school_id) {
      const closed = all.filter(e => e.calendar_id === draft.for_school_id && closes.has(e.category)), seen = new Set();
      mine.forEach(o => closed.forEach(c => occurrences(c, o.start, o.end).forEach(co => {
        for (let d = (co.start > o.start ? co.start : o.start); d <= (co.end < o.end ? co.end : o.end); d = addDays(d, 1)) { const k = d + co.ev.id; if (!seen.has(k)) { seen.add(k); res.closed.push({ date: d, title: co.ev.title }); } }
      })));
    }
    if (draft.owner) {
      const others = all.filter(e => e.owner === draft.owner && e.id !== draft.id), dt = timeRange(draft);
      mine.slice(0, 40).forEach(o => others.forEach(e => occurrences(e, o.start, o.end).forEach(eo => {
        const et = timeRange(e), clash = !dt && !et ? true : (dt && et && dt[0] < et[1] && et[0] < dt[1] && o.start === eo.start);
        if (clash) res.owner.push({ date: eo.start > o.start ? eo.start : o.start, title: e.title });
      })));
    }
    res.closed.sort((a, b) => a.date.localeCompare(b.date)); res.owner.sort((a, b) => a.date.localeCompare(b.date));
    return res;
  }

  /* ---- .ics export (opens in Google Calendar, Apple Calendar, Outlook) ---- */
  const esc = t => String(t ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const bytes = ch => (enc ? enc.encode(ch).length : Buffer.byteLength(ch));
  function fold(line) {
    const out = []; let cur = '', n = 0;
    for (const ch of line) { const b = bytes(ch); if (n + b > 73) { out.push(cur); cur = ' ' + ch; n = 1 + b; } else { cur += ch; n += b; } }
    out.push(cur); return out.join('\r\n');
  }
  const cd = s => s.replace(/-/g, ''), ct = t => t.slice(0, 5).replace(':', '') + '00';
  const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  function toICS(events, o = {}) {
    const cats = Object.fromEntries((o.categories || []).map(c => [c.id, c.name])), cals = Object.fromEntries((o.calendars || []).map(c => [c.id, c.name]));
    const stamp = (o.now || new Date().toISOString()).replace(/[-:]/g, '').replace(/\.\d+/, '');
    const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Games for Ed//Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + esc(o.name || 'Games for Ed calendar'), 'X-WR-TIMEZONE:Asia/Kolkata',
      'BEGIN:VTIMEZONE', 'TZID:Asia/Kolkata', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0530', 'TZOFFSETTO:+0530', 'TZNAME:IST', 'END:STANDARD', 'END:VTIMEZONE'];
    events.forEach(e => {
      const timed = !e.all_day && e.start_time, ex = e.recur_exceptions || [];
      L.push('BEGIN:VEVENT', 'UID:' + (e.uid || e.id) + '@gfe-calendar', 'DTSTAMP:' + stamp, 'SUMMARY:' + esc(e.title));
      if (timed) {
        const endDate = e.end_date || e.start_date, endT = e.end_time ? ct(e.end_time) : ct(addHour(e.start_time));
        L.push(`DTSTART;TZID=Asia/Kolkata:${cd(e.start_date)}T${ct(e.start_time)}`, `DTEND;TZID=Asia/Kolkata:${cd(endDate)}T${endT}`);
      } else L.push('DTSTART;VALUE=DATE:' + cd(e.start_date), 'DTEND;VALUE=DATE:' + cd(addDays(e.end_date || e.start_date, 1)));
      if (e.recur) {
        let r = 'FREQ=' + e.recur.toUpperCase() + ';INTERVAL=' + Math.max(1, e.recur_interval || 1);
        if (e.recur === 'weekly') r += ';BYDAY=' + (e.recur_days && e.recur_days.length ? e.recur_days : [dow(e.start_date)]).map(d => BYDAY[d]).join(',');
        if (e.recur === 'monthly') r += ';BYMONTHDAY=' + Number(e.start_date.slice(8));
        if (e.recur_until) r += ';UNTIL=' + (timed ? cd(e.recur_until) + 'T182959Z' : cd(e.recur_until));
        L.push('RRULE:' + r);
        if (ex.length) L.push(timed ? `EXDATE;TZID=Asia/Kolkata:${ex.map(d => cd(d) + 'T' + ct(e.start_time)).join(',')}` : `EXDATE;VALUE=DATE:${ex.map(cd).join(',')}`);
      }
      if (e.location) L.push('LOCATION:' + esc(e.location));
      const desc = [cats[e.category] ? 'Category: ' + cats[e.category] : '', cals[e.calendar_id] ? 'Calendar: ' + cals[e.calendar_id] : '', e.owner ? 'Owner: ' + e.owner : '', e.contact ? 'Contact: ' + e.contact : '', e.link ? 'Link: ' + e.link : '', e.notes || ''].filter(Boolean).join('\n');
      if (desc) L.push('DESCRIPTION:' + esc(desc));
      if (cats[e.category]) L.push('CATEGORIES:' + esc(cats[e.category]));
      L.push('TRANSP:TRANSPARENT', 'END:VEVENT');
    });
    L.push('END:VCALENDAR');
    return L.map(fold).join('\r\n') + '\r\n';
  }
  function addHour(t) { const h = Math.min(23, +t.slice(0, 2) + 1); return pad(h) + t.slice(2, 5); }

  /* ---- school years ---- */
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function schoolYearOf(dateIso, startMonth) { const y = +dateIso.slice(0, 4), m = +dateIso.slice(5, 7); const sy = m >= startMonth ? y : y - 1; return { startYear: sy, from: ymd(sy, startMonth, 1), to: addDays(ymd(sy + 1, startMonth, 1), -1) }; }
  const yearLabel = (sy, startMonth) => (startMonth === 1 ? String(sy) : `${sy}-${String(sy + 1).slice(2)}`);

  const api = { DAY, pad, parse, iso, addDays, diff, dow, dim, ymd, addMonthsStart, overlaps, occurrences, expandAll, clashes, toICS, fold, esc, schoolYearOf, yearLabel, MONTHS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CalCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
