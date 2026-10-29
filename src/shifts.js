// Cashier shifts: who is selling (a PIN per employee), and closing the shift with a count of the
// cash drawer. Pure functions, no DOM and no network.
import { daySummary, toPt, toEgp } from './pos.js';

// A PIN never leaves the device as text in a cache: what's kept is a hash tied to the pharmacy and
// the employee, so the cashier can still switch staff with no connection.
export async function pinVerifier(pharmacyId, employeeId, pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`saydaliti-pin:${pharmacyId}:${employeeId}:${pin}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Finds the employee a PIN belongs to among those cached on this device ([{ id, name, verifier }]).
export async function matchPin(pharmacyId, cached, pin) {
  for (const e of cached) if (e.verifier === await pinVerifier(pharmacyId, e.id, pin)) return e;
  return null;
}

// The shift's receipts, the money by payment method, and the cash that should be in the drawer:
// what was in it at the start, plus cash taken, minus cash given back on returns, minus money the
// owner (or a partner) took out of the drawer during the shift (shift.outs).
export function shiftSummary(shift, sales) {
  const mine = sales.filter((s) => s.shift_id === shift.id);
  const sum = daySummary(mine);
  const cash = sum.byPayment.cash || 0;
  const outs = toEgp((shift.outs || []).reduce((a, o) => a + toPt(+o.amount || 0), 0));
  const expected = toEgp(toPt(shift.opening_cash) + toPt(cash) - toPt(outs));
  return { ...sum, cash, outs, expected };
}

// What the count says: positive = more cash than expected, negative = missing.
export const cashDifference = (expected, counted) => toEgp(toPt(counted) - toPt(expected));
