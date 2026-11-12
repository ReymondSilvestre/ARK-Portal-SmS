/* Finance - Payroll: the automatic calculation. Pure functions (no screen, no server) so the same numbers are used everywhere.
   Every rate below is only a DEFAULT: the Payroll officer can change all of them under Settings (the government changes them from time to time). */
export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const DEFAULT_SETTINGS = {
  frequency: "semi",              // "semi" = twice a month (1-15 and 16-end), "monthly" = once a month
  workDays: 22,                   // working days in a month: daily rate = monthly pay / workDays
  hoursPerDay: 8,
  otRate: 1.25,                   // overtime = hourly rate x this
  contribTiming: "split",         // semi-monthly: take the contributions half in each pay ("split"), or all in the "first" / "second" pay
  sss: { on: true, rate: 5, min: 5000, max: 35000, step: 500, erRate: 10, ec: 30 },                       // employee 5%, employer 10% (+EC) of the Monthly Salary Credit
  phic: { on: true, rate: 5, employeeShare: 50, min: 10000, max: 100000 },                                // 5% premium shared equally, on the monthly basic pay
  hdmf: { on: true, rate: 2, erRate: 2, cap: 10000 },                                                      // Pag-IBIG: 2% of pay up to the Monthly Fund Salary cap
  tax: { on: true, brackets: [{ over: 0, rate: 0, base: 0 }, { over: 250000, rate: 15, base: 0 }, { over: 400000, rate: 20, base: 22500 }, { over: 800000, rate: 25, base: 102500 }, { over: 2000000, rate: 30, base: 402500 }, { over: 8000000, rate: 35, base: 2202500 }] },   // yearly taxable income
  dtr: { start: "08:00", end: "17:00", lunchMin: 60, graceMin: 10, otStartMin: 30, otBlockMin: 30, halfDayHrs: 4, workDays: [1, 2, 3, 4, 5], restDayAsOt: true, holidays: [], dateOrder: "MDY" },   // Daily Time Record from the biometric file
  unpaidLeave: true,              // approved "without pay" leave is deducted automatically
  preparedBy: "", checkedBy: "", approvedBy: "", approvedTitle: "School Head / Principal",
};

/** Settings saved by the officer, filled in with the defaults for anything missing. */
export function mergeSettings(saved) {
  const d = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), s = saved || {};
  for (const k of Object.keys(d)) {
    if (d[k] && typeof d[k] === "object" && !Array.isArray(d[k])) d[k] = { ...d[k], ...(s[k] || {}) };
    else if (s[k] !== undefined && s[k] !== null && s[k] !== "") d[k] = s[k];
  }
  if (s.tax && Array.isArray(s.tax.brackets) && s.tax.brackets.length) d.tax.brackets = s.tax.brackets;
  return d;
}

/** The pay period for a month and a half ("first" 1-15, "second" 16-end, "whole"). */
export function periodOf(month, half) {
  const [y, m] = month.split("-").map(Number), last = new Date(y, m, 0).getDate(), p = (n) => String(n).padStart(2, "0");
  const a = half === "second" ? 16 : 1, b = half === "first" ? 15 : last;
  const label = new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long" }) + " " + y + (half === "whole" ? "" : half === "first" ? " (1st - 15th)" : ` (16th - ${last}th)`);
  return { start: `${y}-${p(m)}-${p(a)}`, end: `${y}-${p(m)}-${p(b)}`, label, half };
}

/** Monday-Friday days of [a,b] that fall inside the period (both "YYYY-MM-DD"). Used for approved leave without pay. */
export function weekdaysIn(a, b, ps, pe) {
  const from = a > ps ? a : ps, to = b < pe ? b : pe; if (from > to) return 0;
  let n = 0; for (let d = new Date(from + "T00:00"); d <= new Date(to + "T00:00"); d.setDate(d.getDate() + 1)) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
/** Yearly withholding tax from the bracket table (over / rate % / base amount). */
export function yearlyTax(taxable, brackets) {
  let row = brackets[0]; for (const b of brackets) if (taxable > b.over) row = b;
  return taxable <= brackets[0].over ? 0 : r2((row.base || 0) + (taxable - row.over) * (row.rate / 100));
}

/** The monthly government contributions for a monthly basic pay (employee share and employer share). */
export function monthlyContrib(basicMonthly, info, S) {
  const out = { sssEe: 0, sssEr: 0, phicEe: 0, phicEr: 0, hdmfEe: 0, hdmfEr: 0 };
  if (info.sss !== false && S.sss.on) { const msc = clamp(Math.floor((basicMonthly + S.sss.step / 2) / S.sss.step) * S.sss.step, S.sss.min, S.sss.max); out.sssEe = r2(msc * S.sss.rate / 100); out.sssEr = r2(msc * S.sss.erRate / 100 + (S.sss.ec || 0)); }
  if (info.philhealth !== false && S.phic.on) { const base = clamp(basicMonthly, S.phic.min, S.phic.max), tot = base * S.phic.rate / 100; out.phicEe = r2(tot * S.phic.employeeShare / 100); out.phicEr = r2(tot - out.phicEe); }
  if (info.pagibig !== false && S.hdmf.on) { const base = Math.min(basicMonthly, S.hdmf.cap); out.hdmfEe = r2(base * S.hdmf.rate / 100); out.hdmfEr = r2(base * S.hdmf.erRate / 100); }
  return out;
}

/** One employee's pay for one period.
 *  info: the pay information; inp: { absentDays, lateMin, otHours, otherEarn, otherDed } typed for this run; leaveDays: unpaid leave days found automatically. */
export function computeSlip(info, inp, S, period) {
  const semi = S.frequency === "semi" && period.half !== "whole", div = semi ? 2 : 1, monthly = +info.basicMonthly || 0;
  const daily = monthly / S.workDays, hourly = daily / S.hoursPerDay, i = inp || {};
  const absentDays = (+i.absentDays || 0) + (+i.leaveDays || 0);
  const basic = r2(monthly / div);
  const allowList = (info.allowances || []).map((a) => ({ label: a.label, amount: r2((+a.amount || 0) / div) })), allow = r2(allowList.reduce((n, a) => n + a.amount, 0));
  const ot = r2((+i.otHours || 0) * hourly * S.otRate), otherEarn = r2(+i.otherEarn || 0);
  const absent = r2(absentDays * daily), late = r2(((+i.lateMin || 0) / 60) * hourly);
  const mc = monthlyContrib(monthly, info, S);
  const share = (v) => (!semi ? v : S.contribTiming === "split" ? r2(v / 2) : (S.contribTiming === "first") === (period.half === "first") ? v : 0);   // which pay takes the contribution
  const sssEe = share(mc.sssEe), phicEe = share(mc.phicEe), hdmfEe = share(mc.hdmfEe), sssEr = share(mc.sssEr), phicEr = share(mc.phicEr), hdmfEr = share(mc.hdmfEr);
  let tax = 0;
  if (info.tax !== false && S.tax.on) {
    const monthlyAllow = (info.allowances || []).reduce((n, a) => n + (a.taxable === false ? 0 : +a.amount || 0), 0);
    const taxableYear = Math.max(0, (monthly + monthlyAllow - mc.sssEe - mc.phicEe - mc.hdmfEe) * 12);
    tax = r2(yearlyTax(taxableYear, S.tax.brackets) / 12 / div);
  }
  const dedList = (info.deductions || []).map((d) => ({ label: d.label, amount: r2((+d.amount || 0) / div) })), loans = r2(dedList.reduce((n, d) => n + d.amount, 0)), otherDed = r2(+i.otherDed || 0), other = r2(loans + otherDed);
  const gross = r2(basic + allow + ot + otherEarn), totalDed = r2(absent + late + sssEe + phicEe + hdmfEe + tax + other), net = r2(gross - totalDed);
  return { basic, allow, allowList, ot, otherEarn, gross, absent, late, sssEe, phicEe, hdmfEe, sssEr, phicEr, hdmfEr, tax, other, dedList, otherDed, totalDed, net, absentDays, leaveDays: +i.leaveDays || 0 };
}
