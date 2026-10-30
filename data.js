// Supabase data layer. app.js only talks to window.DB, so the demo layer (data-demo.js) can stand in for it.
(function () {
  const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

  window.DB = {
    demo: false,
    sb, // shared with projects-data.js so both pages use one auth session

    async init() {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return null;
      const email = session.user.email;
      const users = must(await sb.from('allowed_users').select('*'));
      const me = users.find(u => u.email.toLowerCase() === email.toLowerCase());
      if (!me) { await sb.auth.signOut(); return { denied: email }; }
      return { email, name: me.display_name };
    },
    signIn: () => sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } }),
    signOut: () => sb.auth.signOut(),

    async getSettings() { return must(await sb.from('settings').select('*').eq('id', 1).single()); },
    async saveSettings(patch) { return must(await sb.from('settings').update(patch).eq('id', 1).select().single()); },

    async listBrands() { return must(await sb.from('brands').select('*').order('is_default', { ascending: false }).order('name')); },
    async saveBrand(b) {
      const row = { ...b }; if (!row.id) delete row.id;
      return must(await sb.from('brands').upsert(row).select().single());
    },
    async uploadLogo(file) {
      const path = `${Date.now()}-${file.name.replace(/[^\w.-]/g, '_')}`;
      must(await sb.storage.from('logos').upload(path, file, { upsert: true }));
      return sb.storage.from('logos').getPublicUrl(path).data.publicUrl;
    },

    async listClients() { return must(await sb.from('clients').select('*').order('name')); },
    async upsertClient(c) {
      const existing = must(await sb.from('clients').select('*').ilike('name', c.name.replace(/[%_]/g, '\\$&')).limit(1));
      if (existing.length) return must(await sb.from('clients').update(c).eq('id', existing[0].id).select().single());
      return must(await sb.from('clients').insert(c).select().single());
    },

    async listInvoices() { return must(await sb.from('invoices').select('*').order('prefix', { ascending: false }).order('seq', { ascending: false })); },
    async peekNumber() { return must(await sb.rpc('peek_next_number')); },
    async createInvoice(inv) {
      const [n] = must(await sb.rpc('next_invoice_number'));
      const row = { ...inv, number: n.number, prefix: n.prefix, seq: n.seq }; delete row.id;
      return must(await sb.from('invoices').insert(row).select().single());
    },
    // Drafts have no invoice number yet: number/prefix/seq stay empty until finalizeDraft().
    async saveDraft(inv) {
      const row = { ...inv, status: 'draft', number: null, prefix: null, seq: null }; delete row.id;
      const { data, error } = await sb.from('invoices').insert(row).select().single();
      if (error) throw new Error(/null value|violates check/i.test(error.message) ? 'Drafts are not enabled in the database yet. Run supabase/migration-drafts.sql once in the Supabase SQL Editor.' : error.message);
      return data;
    },
    async finalizeDraft(id, patch) {
      const [n] = must(await sb.rpc('next_invoice_number'));
      const row = { ...patch, number: n.number, prefix: n.prefix, seq: n.seq, status: 'pending', amount_paid: 0, updated_at: new Date().toISOString() }; delete row.id;
      const { data, error } = await sb.from('invoices').update(row).eq('id', id).eq('status', 'draft').select();
      if (error) throw new Error(error.message);
      if (!data.length) throw new Error('This draft was already finalised or deleted by someone else. Reload the page.');
      return data[0];
    },
    async deleteInvoice(id) { // the database only allows deleting drafts
      const { data, error } = await sb.from('invoices').delete().eq('id', id).eq('status', 'draft').select();
      if (error) throw new Error(error.message);
      if (!data.length) throw new Error('Only drafts can be deleted.');
    },
    async updateInvoice(id, patch) {
      const row = { ...patch, updated_at: new Date().toISOString() }; delete row.id;
      return must(await sb.from('invoices').update(row).eq('id', id).select().single());
    },

    // Used by the invoice editor's optional Project dropdown. Returns null if the project tables are not set up yet.
    async listProjectsLite() {
      const { data, error } = await sb.from('projects').select('id,name,status').order('name');
      return error ? null : data;
    },
    // Follow-ups. These return null if the follow-up tables are not set up yet (migration-followups.sql).
    async listTeam() { const { data } = await sb.from('allowed_users').select('display_name').order('display_name'); return (data || []).map(u => u.display_name); },
    async listInvoiceNotes() {
      const { data, error } = await sb.from('invoice_notes').select('*').order('noted_on', { ascending: false }).order('created_at', { ascending: false });
      return error ? null : data;
    },
    async addInvoiceNote(invoiceId, note, notedOn, author) { return must(await sb.from('invoice_notes').insert({ invoice_id: invoiceId, note, noted_on: notedOn, author }).select().single()); },
    async deleteInvoiceNote(id) { must(await sb.from('invoice_notes').delete().eq('id', id)); },
    // TDS on received payments. tdsReady() is false until migration-tds-vendor.sql has been run.
    async tdsReady() { const { error } = await sb.from('payments').select('tds_amount,tds_reviewed').limit(1); return !error; },
    async listAllPayments() { return must(await sb.from('payments').select('*').order('paid_on')); },
    async updatePayment(id, patch) { return must(await sb.from('payments').update(patch).eq('id', id).select().single()); },
    async deletePayment(id) { must(await sb.from('payments').delete().eq('id', id)); },
    async deletePaymentsFor(invoiceId) { must(await sb.from('payments').delete().eq('invoice_id', invoiceId)); },
    // A payment record only (does NOT change the invoice's amount_paid): used to add TDS details to money already counted as received.
    async addPaymentRecord(inv, p, by) {
      return must(await sb.from('payments').insert({ invoice_id: inv.id, amount: p.amount, paid_on: p.paid_on, mode: p.mode, note: p.note, recorded_by: by, tds_percent: p.tds_percent || 0, tds_amount: p.tds_amount || 0, tds_reviewed: true }).select().single());
    },
    async listPayments(invoiceId) { return must(await sb.from('payments').select('*').eq('invoice_id', invoiceId).order('paid_on')); },
    async recordPayment(inv, p, by) {
      must(await sb.from('payments').insert({ invoice_id: inv.id, amount: p.amount, paid_on: p.paid_on, mode: p.mode, note: p.note, recorded_by: by, ...(p.tds_amount !== undefined ? { tds_percent: p.tds_percent || 0, tds_amount: p.tds_amount || 0, tds_reviewed: true } : {}) }));
      const paid = Number(inv.amount_paid) + Number(p.amount);
      return this.updateInvoice(inv.id, {
        amount_paid: paid, status: paid >= Number(inv.total) ? 'paid' : 'partial',
        paid_date: paid >= Number(inv.total) ? p.paid_on : null,
      });
    },

    async verifyPin(pin) { return must(await sb.rpc('verify_admin_pin', { pin })); },
    async changePin(oldPin, newPin) { return must(await sb.rpc('change_admin_pin', { old_pin: oldPin, new_pin: newPin })); },
  };
})();
