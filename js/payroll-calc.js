/* Finance - Payroll: the automatic calculation. Pure functions (no screen, no server) so the same numbers are used everywhere.
   Every rate below is only a DEFAULT: the Payroll officer can change all of them under Settings (the government changes them from time to time). */
export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const DEFAULT_SETTINGS = {
  frequency: "semi",              // "semi" = twice a month (1-15 and 16-end), "monthly" = once a month
  workDays: 22,                   // working days in a month: daily rate = monthly pay / workDays
  hoursPerDay: 8,
  otRate: 1.25,                   // overtime = hourly rate x this
  contribTiming: "split",         // older single setting, now only the fallback: each benefit (sss / phic / hdmf) has its own `when`: "split" = half in each cut-off, "first" / "second" = all in that cut-off
  minWage: { on: true, daily: 645 },   // minimum wage: the lowest DAILY rate paid to any employee (teachers: this / hours a day, per hour). Changeable under Settings > Minimum wage
  adminRange: { min: 0, max: 0 },   // salary range of the school admins (monthly); a pay outside it is flagged, 0 = no limit
  cutoffPair: "B",                // usual cut-off: "A" = 26th-10th and 11th-25th, "B" = 1st-15th and 16th-end (the cut-off can still be chosen for every payroll)
  // Government benefits: mode "fixed" = the same fixed amount a month (employee share / employer share) typed here or per employee under Add information;
  // mode "percent" = the rate below applied to the monthly pay.
  sss: { on: true, mode: "fixed", fixedEe: 0, fixedEr: 0, rate: 5, min: 5000, max: 35000, step: 500, erRate: 10, ec: 30 },                       // employee 5%, employer 10% (+EC) of the Monthly Salary Credit
  phic: { on: true, mode: "fixed", fixedEe: 0, fixedEr: 0, rate: 5, employeeShare: 50, min: 10000, max: 100000 },                                // 5% premium shared equally, on the monthly basic pay
  hdmf: { on: true, mode: "fixed", fixedEe: 0, fixedEr: 0, rate: 2, erRate: 2, cap: 10000 },                                                      // Pag-IBIG: 2% of pay up to the Monthly Fund Salary cap
  tax: { on: true, brackets: [{ over: 0, rate: 0, base: 0 }, { over: 250000, rate: 15, base: 0 }, { over: 400000, rate: 20, base: 22500 }, { over: 800000, rate: 25, base: 102500 }, { over: 2000000, rate: 30, base: 402500 }, { over: 8000000, rate: 35, base: 2202500 }] },   // yearly taxable income
  dtr: { start: "08:00", end: "17:00", lunchMin: 60, graceMin: 10, otStartMin: 30, otBlockMin: 30, halfDayHrs: 4, workDays: [1, 2, 3, 4, 5], restDayAsOt: true, holidays: [], dateOrder: "MDY" },   // Daily Time Record from the biometric file
  // Payment of holidays (holidays that fall on a working day). % of the DAILY rate: notWorked = paid although nobody worked, worked = paid for a day worked on that holiday.
  // Fixed-pay employees: the monthly pay (daily rate x working days) already covers the holiday, so 100 / 200 means nothing extra for a holiday not worked and one extra day for a holiday worked.
  holiday: { regular: { notWorked: 100, worked: 200 }, special: { notWorked: 100, worked: 130 }, teachersPaid: true },
  unpaidLeave: true,              // approved "without pay" leave is deducted automatically
  period: { firstFrom: 1, firstTo: 15, secondFrom: 16, payFirst: 15, paySecond: 0, payWhole: 0 },   // pay periods and the usual pay day (0 = last day of the month); both can still be changed for every payroll
  signatories: [{ label: "Prepared by", name: "", position: "Finance Officer" }, { label: "Approved by", name: "", position: "School Head / Principal" }],   // printed under every payslip (the employee's "Received by" is always first)
  preparedBy: "", checkedBy: "", approvedBy: "", approvedTitle: "School Head / Principal",   // older settings, kept only so saved settings still open
};

/** Settings saved by the officer, filled in with the defaults for anything missing. */
export function mergeSettings(saved) {
  const d = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), s = saved || {};
  for (const k of Object.keys(d)) {
    if (d[k] && typeof d[k] === "object" && !Array.isArray(d[k])) d[k] = { ...d[k], ...(s[k] || {}) };
    else if (s[k] !== undefined && s[k] !== null && s[k] !== "") d[k] = s[k];
  }
  if (s.tax && Array.isArray(s.tax.brackets) && s.tax.brackets.length) d.tax.brackets = s.tax.brackets;
  if (!Array.isArray(s.signatories) || !s.signatories.length) {          // settings saved before the signatory list existed
    d.signatories = [{ label: "Prepared by", name: s.preparedBy || "", position: "Finance Officer" }, { label: "Approved by", name: s.approvedBy || "", position: s.approvedTitle || "School Head / Principal" }];
  }
  return d;
}

/** The pay period for a month and a half ("first", "second", "whole"). P = the pay period rules from the Settings (first day / last day of each half). */
export function periodOf(month, half, P) {
  const R = { ...DEFAULT_SETTINGS.period, ...(P || {}) };
  const [y, m] = month.split("-").map(Number), last = new Date(y, m, 0).getDate(), p = (n) => String(n).padStart(2, "0"), cl = (n) => Math.min(last, Math.max(1, Math.round(+n) || 1));
  const a = half === "second" ? cl(R.secondFrom) : cl(R.firstFrom), b = half === "first" ? cl(R.firstTo) : last;
  const mon = new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long" });
  const label = half === "whole" ? mon + " " + y : `${mon} ${a} - ${b}, ${y}`;
  return { start: `${y}-${p(m)}-${p(a)}`, end: `${y}-${p(m)}-${p(b)}`, label, half };
}
/** A period typed by hand (start and end dates), for the half the contributions follow. */
export function customPeriod(start, end, half) {
  const f = (d) => new Date(d + "T00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return { start, end, label: `${f(start)} - ${f(end)}`, half };
}
/** The cut-off periods a payroll can follow. half = which pay of the month it is (for "contributions in the 1st / 2nd pay"). */
export const CUTOFFS = [
  { key: "c26_10", label: "26th - 10th", half: "first", pair: "A" },
  { key: "c11_25", label: "11th - 25th", half: "second", pair: "A" },
  { key: "c1_15", label: "1st - 15th", half: "first", pair: "B" },
  { key: "c16_end", label: "16th - 30th / 31st (end of month)", half: "second", pair: "B" },
];
/** The period of a cut-off for a month. For 26th - 10th the month is the one the period ENDS in (Nov 2026 = Oct 26 - Nov 10). */
export function cutoffPeriod(month, key) {
  const [y, m] = month.split("-").map(Number), p = (n) => String(n).padStart(2, "0"), mon = (yy, mm) => new Date(yy, mm - 1, 1).toLocaleString("en-US", { month: "short" }), last = (yy, mm) => new Date(yy, mm, 0).getDate();
  const c = CUTOFFS.find((x) => x.key === key) || CUTOFFS[2];
  let a, b, label;
  if (key === "c26_10") { const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1; a = `${py}-${p(pm)}-26`; b = `${y}-${p(m)}-10`; label = `${mon(py, pm)} 26 - ${mon(y, m)} 10, ${y}`; }
  else if (key === "c11_25") { a = `${y}-${p(m)}-11`; b = `${y}-${p(m)}-25`; label = `${mon(y, m)} 11 - 25, ${y}`; }
  else if (key === "c16_end") { const l = last(y, m); a = `${y}-${p(m)}-16`; b = `${y}-${p(m)}-${p(l)}`; label = `${mon(y, m)} 16 - ${l}, ${y}`; }
  else { a = `${y}-${p(m)}-01`; b = `${y}-${p(m)}-15`; label = `${mon(y, m)} 1 - 15, ${y}`; }
  return { start: a, end: b, label, half: c.half, cut: c.key };
}
/** Which cut-off a pair of dates is ("custom" when it is none of them, "whole" for a whole month). */
export function cutOfDates(start, end) {
  if (!start || !end) return "custom";
  const d = (x) => +x.slice(8, 10), [ey, em] = end.split("-").map(Number), l = new Date(ey, em, 0).getDate(), sm = start.slice(0, 7) === end.slice(0, 7);
  if (d(start) === 26 && d(end) === 10 && !sm) return "c26_10";
  if (d(start) === 11 && d(end) === 25 && sm) return "c11_25";
  if (d(start) === 1 && d(end) === 15 && sm) return "c1_15";
  if (d(start) === 16 && d(end) === l && sm) return "c16_end";
  if (d(start) === 1 && d(end) === l && sm) return "whole";
  return "custom";
}
/** Monthly pay of a fixed-pay employee: DAILY RATE x working days a month (Settings). Pay information saved before the daily rate existed keeps its monthly pay. */
export const minDaily = (S) => (S && S.minWage && S.minWage.on !== false && +S.minWage.daily > 0 ? +S.minWage.daily : 0);
/** Daily rate that is really paid: the saved daily rate (or the old monthly pay / working days), never below the minimum wage. */
export const dailyRateOf = (info, S) => { const w = +(S && S.workDays) || 22, d = info && +info.dailyRate > 0 ? +info.dailyRate : info && +info.basicMonthly > 0 ? r2(+info.basicMonthly / w) : 0; return Math.max(d, minDaily(S)); };
export const monthlyBasicOf = (info, S) => { const w = +(S && S.workDays) || 22, own = info && +info.dailyRate > 0 ? r2(+info.dailyRate * w) : +(info && info.basicMonthly) || 0; return isHourly(info) ? own : Math.max(own, r2(minDaily(S) * w)); };
/** Monthly amount of one allowance: a daily allowance (perDay) x working days a month; an older allowance is already a monthly amount. */
export const allowMonthly = (a, S) => (a && a.perDay ? r2((+a.amount || 0) * (+(S && S.workDays) || 22)) : +(a && a.amount) || 0);
/** A per-hour employee (teachers are paid for the hours they teach, not a fixed daily pay). Saved choice first; without one, a position with teacher / instructor / professor is per hour. */
export const CATEGORIES = [{ key: "staff", label: "Employee staff", short: "Staff" }, { key: "teacher", label: "Teachers (paid per hour)", short: "Teachers" }, { key: "admin", label: "School admins", short: "School admins" }];
const TEACHER_RX = /teacher|instructor|professor|faculty/i, ADMIN_RX = /principal|school head|head of school|school admin|director|administrator|president|dean|superintendent|supervisor|coordinator/i;
/** The payroll group of an employee: staff, teacher (paid per hour) or admin (school admins). The saved choice first; without one it follows the position. */
export function categoryOf(info) {
  if (!info) return "staff";
  if (info.category === "staff" || info.category === "teacher" || info.category === "admin") return info.category;
  const pos = info.position || "";
  if (info.payType === "hourly") return "teacher";
  if (info.payType === "monthly") return ADMIN_RX.test(pos) ? "admin" : "staff";
  return TEACHER_RX.test(pos) ? "teacher" : ADMIN_RX.test(pos) ? "admin" : "staff";
}
/** A per-hour employee: teachers are paid for the hours they teach, not a fixed daily pay. */
export const isHourly = (info) => categoryOf(info) === "teacher";

/** The usual pay day of a period (rule from the Settings; 0 = last day of the month). */
export function payDateOf(month, half, P) {
  const R = { ...DEFAULT_SETTINGS.period, ...(P || {}) }, [y, m] = month.split("-").map(Number), last = new Date(y, m, 0).getDate(), p = (n) => String(n).padStart(2, "0");
  const d = half === "first" ? R.payFirst : half === "second" ? R.paySecond : R.payWhole;
  return `${y}-${p(m)}-${p(+d > 0 ? Math.min(last, +d) : last)}`;
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
  const out = { sssEe: 0, sssEr: 0, phicEe: 0, phicEr: 0, hdmfEe: 0, hdmfEr: 0 }, fixedOf = (g) => g.mode !== "percent";      // mode "fixed" is the default
  if (info.sss !== false && S.sss.on) { if (fixedOf(S.sss)) { out.sssEe = r2(S.sss.fixedEe); out.sssEr = r2(S.sss.fixedEr); } else { const msc = clamp(Math.floor((basicMonthly + S.sss.step / 2) / S.sss.step) * S.sss.step, S.sss.min, S.sss.max); out.sssEe = r2(msc * S.sss.rate / 100); out.sssEr = r2(msc * S.sss.erRate / 100 + (S.sss.ec || 0)); } }
  if (info.philhealth !== false && S.phic.on) { if (fixedOf(S.phic)) { out.phicEe = r2(S.phic.fixedEe); out.phicEr = r2(S.phic.fixedEr); } else { const base = clamp(basicMonthly, S.phic.min, S.phic.max), tot = base * S.phic.rate / 100; out.phicEe = r2(tot * S.phic.employeeShare / 100); out.phicEr = r2(tot - out.phicEe); } }
  if (info.pagibig !== false && S.hdmf.on) { if (fixedOf(S.hdmf)) { out.hdmfEe = r2(S.hdmf.fixedEe); out.hdmfEr = r2(S.hdmf.fixedEr); } else { const base = Math.min(basicMonthly, S.hdmf.cap); out.hdmfEe = r2(base * S.hdmf.rate / 100); out.hdmfEr = r2(base * S.hdmf.erRate / 100); } }
  // a fixed amount typed under Add information (per month) replaces the amount from the Settings for that employee
  const fx = info.fixed || {}, has = (v) => v !== undefined && v !== null && v !== "" && +v >= 0;
  if (has(fx.sss)) out.sssEe = r2(+fx.sss); if (has(fx.phic)) out.phicEe = r2(+fx.phic); if (has(fx.hdmf)) out.hdmfEe = r2(+fx.hdmf);
  return out;
}

/** One employee's pay for one period.
 *  info: the pay information; inp: { absentDays, lateMin, otHours, otherEarn, otherDed } typed for this run; leaveDays: unpaid leave days found automatically. */
export function computeSlip(info, inp, S, period) {
  const semi = S.frequency === "semi" && period.half !== "whole", div = semi ? 2 : 1, i = inp || {};
  const perHour = !!isHourly(info), rate = perHour ? Math.max(+info.hourlyRate || 0, minDaily(S) / (+S.hoursPerDay || 8)) : 0, hours = perHour ? r2(+i.hoursWorked || 0) : 0;
  // per-hour employee (teacher): pay = hours worked x rate for THIS period; no absence / late deduction (only the hours worked are paid).
  // fixed-pay employee: monthly pay (half of it in a twice-a-month payroll) less absences and late.
  const mB = !perHour && i.mBasic !== undefined && i.mBasic !== null && i.mBasic !== "" && !isNaN(+i.mBasic);      // pay of this period typed by hand (administrators)
  const baseMonthly = monthlyBasicOf(info, S);
  const basic = perHour ? r2(hours * rate) : mB ? r2(+i.mBasic) : r2(baseMonthly / div);
  const monthly = perHour || mB ? r2(basic * div) : baseMonthly;      // the monthly equivalent (used by the percent rates and the tax estimate)
  const daily = !perHour && !mB ? dailyRateOf(info, S) : monthly / S.workDays, hourly = perHour ? rate : daily / S.hoursPerDay;
  const absentDays = perHour ? 0 : (+i.absentDays || 0) + (+i.leaveDays || 0);
  const allowList = (info.allowances || []).map((a) => ({ label: a.label, amount: r2(allowMonthly(a, S) / div), perDay: !!a.perDay, daily: a.perDay ? r2(+a.amount || 0) : null })), allow = r2(allowList.reduce((n, a) => n + a.amount, 0));
  const ot = r2((+i.otHours || 0) * hourly * S.otRate), otherEarn = r2(+i.otherEarn || 0);
  const absent = perHour ? 0 : r2(absentDays * daily), late = perHour ? 0 : r2(((+i.lateMin || 0) / 60) * hourly);
  const mc = monthlyContrib(monthly, info, S);
  const share = (v, when) => { const t = when || S.contribTiming; return !semi ? v : t === "split" ? r2(v / 2) : (t === "first") === (period.half === "first") ? v : 0; };   // which cut-off takes the contribution (chosen per benefit under Settings)
  const sssEe = share(mc.sssEe, S.sss.when), phicEe = share(mc.phicEe, S.phic.when), hdmfEe = share(mc.hdmfEe, S.hdmf.when), sssEr = share(mc.sssEr, S.sss.when), phicEr = share(mc.phicEr, S.phic.when), hdmfEr = share(mc.hdmfEr, S.hdmf.when);
  let tax = 0;
  const fx = info.fixed || {}, has = (v) => v !== undefined && v !== null && v !== "" && !isNaN(+v) && +v >= 0;
  if (has(fx.tax)) tax = r2(+fx.tax / div);
  else if (info.tax !== false && S.tax.on) {
    const monthlyAllow = (info.allowances || []).reduce((n, a) => n + (a.taxable === false ? 0 : allowMonthly(a, S)), 0);
    const taxableYear = Math.max(0, (monthly + monthlyAllow - mc.sssEe - mc.phicEe - mc.hdmfEe) * 12);
    tax = r2(yearlyTax(taxableYear, S.tax.brackets) / 12 / div);
  }
  // amounts typed by hand for THIS payroll replace the automatic ones (government benefits and tax)
  const manual = { basic: mB, sss: has(i.mSss), phic: has(i.mPhic), hdmf: has(i.mHdmf), tax: has(i.mTax) };
  const sssF = manual.sss ? r2(+i.mSss) : sssEe, phicF = manual.phic ? r2(+i.mPhic) : phicEe, hdmfF = manual.hdmf ? r2(+i.mHdmf) : hdmfEe, taxF = manual.tax ? r2(+i.mTax) : tax;
  // recurring loans / other deductions (per month, shared by the pay periods); a loan with a balance stops when the balance is paid
  const dedList = (info.deductions || []).map((d) => {
    let amount = r2((+d.amount || 0) / div); const tracked = d.balance !== undefined && d.balance !== null && d.balance !== "" && !isNaN(+d.balance), bal = tracked ? r2(+d.balance) : null;
    if (tracked) amount = Math.min(amount, Math.max(0, bal));
    return { id: d.id || "", type: d.type || "", label: d.label, amount, balanceBefore: bal, balanceAfter: tracked ? r2(Math.max(0, bal - amount)) : null };
  });
  const loans = r2(dedList.reduce((n, d) => n + d.amount, 0)), otherDed = r2(+i.otherDed || 0), other = r2(loans + otherDed);
  // cash advance: the amount taken this pay (never more than the balance) and what is left
  const caBal = r2(Math.max(0, +(info.ca && info.ca.balance) || 0)), caWant = i.caDed !== undefined && i.caDed !== "" ? +i.caDed || 0 : Math.min(+(info.ca && info.ca.perPay) || 0, caBal), caDed = r2(Math.min(Math.max(0, caWant), caBal)), caAfter = r2(caBal - caDed);
  // holidays of the period (inp.hol: [{ date, label, type: "regular" | "special", worked, hours }]) paid by the rules under Settings > Payment of holidays
  const HS = S.holiday || DEFAULT_SETTINGS.holiday, hl = Array.isArray(i.hol) ? i.hol : [], pct = (t, k, def) => (t && t[k] !== undefined && t[k] !== "" && !isNaN(+t[k]) ? +t[k] : def);
  let holPay = 0, holDed = 0;
  for (const h of hl) {
    const sp = h.type === "special", T = sp ? HS.special : HS.regular, nw = pct(T, "notWorked", 100), wk = pct(T, "worked", sp ? 130 : 200);
    if (h.worked) holPay += perHour ? (+h.hours || 0) * rate * (wk - 100) / 100 : daily * (wk - 100) / 100;            // extra for working on the holiday
    else if (perHour) { if (HS.teachersPaid !== false) holPay += S.hoursPerDay * rate * nw / 100; }                    // teachers: a holiday not worked is paid at this % of a day
    else { const x = daily * (nw - 100) / 100; if (x < 0) holDed -= x; else holPay += x; }                           // fixed pay: already in the monthly pay; below 100% = deducted
  }
  holPay = r2(holPay); holDed = r2(holDed);
  const gross = r2(basic + allow + ot + otherEarn + holPay), totalDed = r2(absent + late + holDed + sssF + phicF + hdmfF + taxF + other + caDed), net = r2(gross - totalDed);
  return { cat: categoryOf(info), perHour, rate, hours, basic, allow, allowList, ot, otherEarn, gross, absent, late, sssEe: sssF, phicEe: phicF, hdmfEe: hdmfF, sssEr, phicEr, hdmfEr, tax: taxF, other, dedList, otherDed, caDed, caBal, caAfter, manual, auto: { sssEe, phicEe, hdmfEe, tax }, totalDed, net, absentDays, leaveDays: +i.leaveDays || 0,
    holidays: hl.length, holWorked: hl.filter((h) => h.worked).length, holPay, holDed, holList: hl.map((h) => ({ date: h.date, label: h.label || "", type: h.type || "regular", worked: !!h.worked })),
    dailyRate: perHour ? 0 : r2(daily), paidDays: r2((+S.workDays || 0) / div), otHours: r2(+i.otHours || 0), presentDays: i.dtr && i.dtr.present !== undefined && i.dtr.present !== null ? +i.dtr.present : null };
}
