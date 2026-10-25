// Attendance store backed by Supabase — same interface as createLocalStore().
const MESSAGES = {
  'wrong pin': 'الكود غلط.',
  'PIN already used': 'الكود ده مستخدم لموظف تاني. اختار كود تاني.',
  'PIN must be 4-6 digits': 'الكود لازم يبقى من 4 لـ 6 أرقام.',
  'name required': 'اكتب اسم الموظف.',
  'not allowed': 'الحساب ده ملوش صلاحية للخطوة دي.',
  'invalid code': 'كود الدعوة غلط أو اتستخدم أو انتهى.',
  'not signed in': 'لازم تسجّل دخول الأول.',
};
export function arabicError(err) {
  const m = String(err?.message ?? err ?? '');
  for (const [k, v] of Object.entries(MESSAGES)) if (m.includes(k)) return new Error(v);
  if (/fetch|network/i.test(m)) return new Error('مفيش اتصال بالنت. جرّب تاني.');
  return new Error('حصلت مشكلة. جرّب تاني، ولو اتكررت قولّنا.');
}
const must = ({ data, error }) => { if (error) throw arabicError(error); return data; };

export function createSupabaseStore(client, pharmacyId) {
  const rec = (r) => ({ ...r, check_in: new Date(r.check_in), check_out: r.check_out ? new Date(r.check_out) : null });
  return {
    kind: 'supabase',
    async listEmployees() {
      return must(await client.from('employees')
        .select('id, name, shift_start, shift_end, work_days, grace_minutes, active, created_at')
        .eq('pharmacy_id', pharmacyId).order('created_at'))
        .map((e) => ({ ...e, shift_start: e.shift_start.slice(0, 5), shift_end: e.shift_end.slice(0, 5) }));
    },
    async addEmployee({ name, pin, shift_start = '09:00', shift_end = '17:00', work_days = [6, 0, 1, 2, 3, 4], grace_minutes = 15 }) {
      return must(await client.rpc('add_employee', {
        p_pharmacy: pharmacyId, p_name: name, p_pin: String(pin), p_shift_start: shift_start, p_shift_end: shift_end,
        p_work_days: work_days, p_grace: grace_minutes,
      }));
    },
    async updateEmployee(id, { pin, ...rest }) {
      if (pin !== undefined) must(await client.rpc('set_employee_pin', { p_employee: id, p_pin: String(pin) }));
      if (Object.keys(rest).length) must(await client.from('employees').update(rest).eq('id', id));
    },
    async clock(pin) {
      const [r] = must(await client.rpc('clock', { p_pharmacy: pharmacyId, p_pin: String(pin) }));
      return { name: r.employee_name, action: r.action, at: new Date(r.at) };
    },
    async records(from, to) {
      return must(await client.from('attendance').select('id, employee_id, check_in, check_out')
        .eq('pharmacy_id', pharmacyId).gte('check_in', from.toISOString()).lt('check_in', to.toISOString())
        .order('check_in')).map(rec);
    },
    async fixCheckout(recordId, date) {
      must(await client.from('attendance').update({ check_out: date.toISOString() }).eq('id', recordId));
    },
    async createInvite(role) { return must(await client.rpc('create_invite', { p_pharmacy: pharmacyId, p_role: role })); },
    async seedExample() { return false; },
  };
}
