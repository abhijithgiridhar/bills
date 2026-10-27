// Calendar data layer (Supabase). Extends the invoice DB (data.js): same login session, same database.
(function () {
  const sb = DB.sb;
  const MISSING = /does not exist|schema cache|Could not find|relation .* not found/i;
  const must = ({ data, error }) => {
    if (error) throw new Error(MISSING.test(error.message) ? 'The calendar tables are not set up yet. Run supabase/migration-calendar.sql once in the Supabase SQL Editor, then reload.' : error.message);
    return data;
  };
  const EV_COLS = ['calendar_id', 'for_school_id', 'title', 'category', 'start_date', 'end_date', 'all_day', 'start_time', 'end_time', 'location', 'notes', 'link', 'owner', 'contact', 'project_id', 'recur', 'recur_interval', 'recur_days', 'recur_until', 'recur_exceptions', 'created_by'];
  const evRow = e => { const r = {}; EV_COLS.forEach(k => { if (e[k] !== undefined) r[k] = e[k] === '' ? null : e[k]; }); r.updated_at = new Date().toISOString(); return r; };
  const CAL_COLS = ['name', 'kind', 'color', 'client_id', 'year_start_month', 'notes'];
  const calRow = c => { const r = {}; CAL_COLS.forEach(k => { if (c[k] !== undefined) r[k] = c[k] === '' ? null : c[k]; }); return r; };

  window.CDB = {
    demo: false,
    async load() {
      const [cals, events, settings, projects] = await Promise.all([
        sb.from('cal_calendars').select('*').order('created_at'),
        sb.from('cal_events').select('*').order('start_date'),
        sb.from('cal_settings').select('*').eq('id', 1).single(),
        sb.from('projects').select('id,name,status,start_date,end_date'),
      ]);
      return { calendars: must(cals), events: must(events), settings: must(settings), projects: projects.error ? [] : projects.data };
    },
    async saveCalendar(c) { const r = calRow(c); return must(await (c.id ? sb.from('cal_calendars').update(r).eq('id', c.id) : sb.from('cal_calendars').insert(r)).select().single()); },
    async deleteCalendar(id) { must(await sb.from('cal_calendars').delete().eq('id', id)); },
    async saveEvent(e) { const r = evRow(e); return must(await (e.id ? sb.from('cal_events').update(r).eq('id', e.id) : sb.from('cal_events').insert(r)).select().single()); },
    async deleteEvent(id) { must(await sb.from('cal_events').delete().eq('id', id)); },
    async saveSettings(patch) { return must(await sb.from('cal_settings').update(patch).eq('id', 1).select().single()); },
  };
})();
