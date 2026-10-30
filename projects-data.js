// Project tracker data layer (Supabase). Extends the invoice DB (data.js): same login session, same database.
(function () {
  const sb = DB.sb;
  const MISSING = /does not exist|schema cache|Could not find|relation .* not found/i;
  const must = ({ data, error }) => {
    if (error) throw new Error(MISSING.test(error.message) ? 'The project tables are not set up yet. Run supabase/migration-projects.sql once in the Supabase SQL Editor, then reload.' : error.message);
    return data;
  };
  const clean = r => { const o = { ...r }; if (!o.id) delete o.id; return o; };

  window.PDB = {
    demo: false,
    async load() {
      const [projects, expenses, income, settings, inst, pays] = await Promise.all([
        sb.from('projects').select('*').order('created_at', { ascending: false }),
        sb.from('project_expenses').select('*').order('spent_on', { ascending: false }).order('created_at', { ascending: false }),
        sb.from('project_income').select('*').order('received_on', { ascending: false }),
        sb.from('project_settings').select('*').eq('id', 1).single(),
        sb.from('project_expense_payments').select('*').order('paid_on'),     // vendor instalments (needs migration-tds-vendor.sql)
        sb.from('payments').select('*'),                                       // invoice payments, for the TDS shown on each project
      ]);
      return { projects: must(projects), expenses: must(expenses), income: must(income), settings: must(settings), instalments: inst.error ? [] : inst.data, instReady: !inst.error, payments: pays.error ? [] : pays.data };
    },
    async saveProject(p) { const r = clean({ ...p, updated_at: new Date().toISOString() }); return must(await (p.id ? sb.from('projects').update(r).eq('id', p.id) : sb.from('projects').insert(r)).select().single()); },
    async deleteProject(id) { must(await sb.from('projects').delete().eq('id', id)); },
    async saveExpense(e) { const r = clean({ ...e, updated_at: new Date().toISOString() }); return must(await (e.id ? sb.from('project_expenses').update(r).eq('id', e.id) : sb.from('project_expenses').insert(r)).select().single()); },
    async deleteExpense(id) { must(await sb.from('project_expenses').delete().eq('id', id)); },
    async markReimbursed(ids, date) { must(await sb.from('project_expenses').update({ reimbursed: true, reimbursed_on: date, updated_at: new Date().toISOString() }).in('id', ids)); },
    async saveIncome(i) { const r = clean(i); return must(await (i.id ? sb.from('project_income').update(r).eq('id', i.id) : sb.from('project_income').insert(r)).select().single()); },
    async deleteIncome(id) { must(await sb.from('project_income').delete().eq('id', id)); },
    async saveInstalment(i) { const r = clean(i); return must(await (i.id ? sb.from('project_expense_payments').update(r).eq('id', i.id) : sb.from('project_expense_payments').insert(r)).select().single()); },
    async deleteInstalment(id) { must(await sb.from('project_expense_payments').delete().eq('id', id)); },
    async markInstalmentsReimbursed(ids, date) { must(await sb.from('project_expense_payments').update({ reimbursed: true, reimbursed_on: date }).in('id', ids)); },
    async saveSettings(patch) { return must(await sb.from('project_settings').update(patch).eq('id', 1).select().single()); },
    async linkInvoice(invoiceId, projectId) { must(await sb.from('invoices').update({ project_id: projectId, updated_at: new Date().toISOString() }).eq('id', invoiceId)); },
    // receipts live in a private bucket; they are only opened through short-lived signed links
    async uploadReceipt(projectId, file) {
      if (file.size > 10 * 1024 * 1024) throw new Error('That file is over 10 MB. Please use a smaller photo or PDF.');
      const path = `${projectId}/${Date.now()}-${file.name.replace(/[^\w.-]/g, '_')}`;
      must(await sb.storage.from('receipts').upload(path, file, { upsert: false, contentType: file.type || undefined }));
      return path;
    },
    async receiptUrl(path) { const { data, error } = await sb.storage.from('receipts').createSignedUrl(path, 600); if (error) throw new Error(error.message); return data.signedUrl; },
    async removeReceipt(path) { await sb.storage.from('receipts').remove([path]); },
  };
})();
