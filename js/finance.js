import { requireRole, logout, db, esc, friendlyError, applyBranding } from "./auth.js";
import { collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, writeBatch, serverTimestamp }
  from "./db.js";
import { TERMS, termRank } from "./omr.js";

const $ = (id) => document.getElementById(id);
const { user, profile, school } = await requireRole(["finance"]);
const SID = profile.schoolId;
$("who").textContent = profile.displayName + " (Finance)"; $("out").onclick = logout;
applyBranding(school);

const flash = (t, ok) => { const m = $("msg"); m.textContent = t; m.className = "notice noprint " + (ok ? "ok" : "err"); m.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => (m.hidden = true), 9000); scrollTo({ top: 0, behavior: "smooth" }); };
const net = () => { $("sync").className = "sync" + (navigator.onLine ? "" : " off"); $("sync").lastElementChild.textContent = navigator.onLine ? "Online" : "Offline - changes will not save"; };
addEventListener("online", net); addEventListener("offline", net); net();
const run = async (fn) => { try { await fn(); } catch (e) { console.error(e); flash(friendlyError(e)); } };

/* ---------- constants and helpers ---------- */
const GRADES = ["Kindergarten", ...Array.from({ length: 12 }, (_, i) => "Grade " + (i + 1))];
const DEFAULT_VOUCHERS = ["PUB", "ALS", "ESC"];
const DEFAULT_TYPES = ["Miscellaneous", "Tuition", "Intramurals"];
const ALL = "_all", NOV = "_none"; // fee-schedule groups: default for everyone / students without a voucher
const schoolYearNow = () => { const d = new Date(), y = d.getFullYear(); return d.getMonth() >= 5 ? `${y}-${y + 1}` : `${y - 1}-${y}`; };
const money = (n) => "\u20b1" + (Number(n) || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sum = (a, f) => r2(a.reduce((n, x) => n + f(x), 0));
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dateText = (s) => (s ? new Date(s + "T00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "-");
const options = (list, first) => (first !== undefined ? `<option value="">${esc(first)}</option>` : "") + list.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
const keep = (id, html) => { const el = $(id), v = el.value; el.innerHTML = html; if ([...el.options].some((o) => o.value === v)) el.value = v; };
const hdr = (cols) => "<tr>" + cols.map((c) => (Array.isArray(c) ? `<th class="num">${c[0]}</th>` : `<th>${c}</th>`)).join("") + "</tr>";
const cell = (v, num) => `<td${num ? ' class="num"' : ""}>${v}</td>`;
const tsec = (x) => x?.createdAt?.seconds || 0;
const pcent = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + "%" : "-");
const bar = (a, b) => `<span class="bar"><i style="width:${b ? Math.min(100, Math.round((a / b) * 100)) : 0}%"></i></span>`;
const whenOf = (l) => (l?.at?.seconds ? new Date(l.at.seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "just now");

/* ---------- data ---------- */
const S = { registry: [], enrollments: [], payments: [], accounts: new Map(), types: [...DEFAULT_TYPES], vouchers: [...DEFAULT_VOUCHERS], fees: {}, bill: [], log: [], logLoaded: false };
const bySchool = async (c) => (await getDocs(query(collection(db, c), where("schoolId", "==", SID)))).docs.map((d) => ({ id: d.id, ...d.data() }));
async function refresh() {
  await run(async () => {
    const [reg, ens, pay, acc, rs, fs] = await Promise.all([bySchool("registry"), bySchool("enrollmentRecords"), bySchool("payments"), bySchool("studentAccounts").catch(() => []),
      getDoc(doc(db, "registrarSettings", SID)).catch(() => null), getDoc(doc(db, "financeSettings", SID)).catch(() => null)]);
    S.registry = reg; S.enrollments = ens; S.payments = pay; S.accounts = new Map(acc.map((a) => [a.id, a]));
    if (rs && rs.exists()) S.vouchers = rs.data().voucherTypes || S.vouchers;
    if (fs && fs.exists()) { S.types = fs.data().types?.length ? fs.data().types : S.types; S.fees = fs.data().fees || {}; }
    render(); await syncAccounts();
  });
}
const saveSettings = () => setDoc(doc(db, "financeSettings", SID), { schoolId: SID, types: S.types, fees: S.fees, updatedAt: serverTimestamp() });
async function logEvent(action, label, note) {
  try { await setDoc(doc(collection(db, "financeLog")), { schoolId: SID, at: serverTimestamp(), byUid: user.uid, byName: profile.displayName || "", byNo: profile.employeeId || "", action, label: String(label || "").slice(0, 200), note: String(note || "").slice(0, 400) }); S.logLoaded = false; }
  catch (e) { console.warn("History entry could not be saved", e); }
}

/* ---------- the payment computation ---------- */
/** What one student owes for a school year: one amount per payment transaction.
 *  The amount for the student's grade level under his or her voucher type is used; a blank cell falls back to the "default for all students" group. */
function dueOf(grade, voucher, y) {
  const f = S.fees[y] || {}, vk = voucher || NOV, at = (k, t) => ((f[k] || {})[grade] || {})[t];
  return S.types.map((t) => { let v = at(vk, t); if (v === undefined || v === null) v = at(ALL, t); return { type: t, amount: r2(v) }; }).filter((x) => x.amount > 0);
}
const allVouchers = () => [...new Set([...S.vouchers, ...S.registry.map((r) => r.voucherType).filter(Boolean)])];
const yearChoices = () => [...new Set([schoolYearNow(), ...S.enrollments.map((e) => e.schoolYear), ...S.payments.map((p) => p.schoolYear), ...Object.keys(S.fees)].filter(Boolean))].sort().reverse();
/** The students of the chosen school year (from the enrolled masterlist) with what they owe, paid and still owe. */
function build() {
  const y = $("fnYear").value, regMap = new Map(S.registry.map((r) => [r.id, r])), latest = new Map(), paid = new Map();
  S.enrollments.filter((e) => e.schoolYear === y && regMap.has(e.registryId)).sort((a, b) => termRank(b.term) - termRank(a.term) || tsec(b) - tsec(a)).forEach((e) => { if (!latest.has(e.registryId)) latest.set(e.registryId, e); });
  S.payments.filter((p) => p.schoolYear === y && p.status !== "void").forEach((p) => { const x = paid.get(p.registryId) || { total: 0, by: {} }; x.total += p.amount; x.by[p.type] = (x.by[p.type] || 0) + p.amount; paid.set(p.registryId, x); });
  S.bill = [...latest.values()].map((e) => {
    const r = regMap.get(e.registryId), grade = e.gradeLevel || r.gradeLevel || "", voucher = r.voucherType || "", due = dueOf(grade, voucher, y), p = paid.get(r.id) || { total: 0, by: {} }, total = sum(due, (x) => x.amount);
    const types = [...S.types.filter((t) => due.some((x) => x.type === t) || p.by[t]), ...Object.keys(p.by).filter((t) => !S.types.includes(t))];
    const lines = types.map((t) => ({ type: t, due: (due.find((x) => x.type === t) || {}).amount || 0, paid: r2(p.by[t] || 0) }));
    return { r, e, grade, voucher, examNo: e.examNo || r.examNo || "", section: e.sectionName || "", due: total, lines, paid: r2(p.total), balance: r2(total - p.total) };
  }).sort((a, b) => a.r.name.localeCompare(b.r.name));
}
/** Keeps each student's own balance record (read by the Student page) in step. Only records that changed are written. */
async function syncAccounts(only) {
  const y = $("fnYear").value, changed = [];
  for (const b of (only || S.bill).filter((x) => x.examNo)) {
    const id = `${b.r.id}_${y}`.replace(/[\s/]+/g, "-"), data = { schoolId: SID, schoolYear: y, registryId: b.r.id, studentId: b.examNo, studentNo: b.r.studentNo, name: b.r.name, gradeLevel: b.grade, voucherType: b.voucher, section: b.section, totalDue: b.due, totalPaid: b.paid, balance: b.balance, lines: b.lines };
    const sig = JSON.stringify(data); if (S.accounts.get(id)?.sig === sig) continue;
    changed.push({ id, data: { ...data, sig, updatedAt: serverTimestamp() } });
  }
  if (!changed.length) return;
  try {
    for (let i = 0; i < changed.length; i += 400) { const b = writeBatch(db); changed.slice(i, i + 400).forEach((c) => b.set(doc(db, "studentAccounts", c.id), c.data)); await b.commit(); }
    changed.forEach((c) => S.accounts.set(c.id, c.data));
  } catch (e) {
    console.warn("Balances could not be sent to the student accounts", e);
    if (!syncAccounts.warned) { syncAccounts.warned = true; flash("The balances could not be sent to the Student pages. Reload and try again. " + friendlyError(e)); }
  }
}

/* ---------- navigation ---------- */
const SUB = { settings: "stTypes" };
function showSub(pg, p) {
  const sec = document.querySelector(`[data-s="${pg}"]`), nav = sec && sec.querySelector(".subnav"); if (!nav) return;
  SUB[pg] = p;
  sec.querySelectorAll(":scope > .panel[data-p]").forEach((el) => (el.hidden = el.dataset.p !== p));
  nav.querySelectorAll("button[data-p]").forEach((b) => { const on = b.dataset.p === p; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
}
function show(t, p) {
  document.querySelectorAll("[data-s]").forEach((s) => (s.hidden = s.dataset.s !== t));
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
  showSub(t, p || SUB[t]);
  if (t === "history" && !S.logLoaded) run(loadHistory);
}
$("tabs").onclick = (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.t); };
document.addEventListener("click", (e) => { const nb = e.target.closest(".subnav button[data-p]"); if (nb) showSub(nb.closest("[data-s]").dataset.s, nb.dataset.p); });
show("dash");

function saveXlsx(sheets, file) {
  if (!window.XLSX) return flash("The Excel writer did not load. Check your internet connection.");
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ name, rows, header }) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { header }), String(name).slice(0, 28) || "Sheet"));
  XLSX.writeFile(wb, file);
}

/* ---------- rendering ---------- */
function render() {
  keep("fnYear", options(yearChoices()));
  if (!render.init) { render.init = true; $("fnYear").value = schoolYearNow(); }
  build();
  keep("fpType", options(S.types)); keep("txType", options(S.types, "All transactions")); keep("txGrade", options(GRADES, "All grade levels"));
  keep("sbGrade", options(GRADES, "All grade levels")); keep("sbVoucher", options([...allVouchers(), "No voucher"], "All voucher types"));
  const groups = [[ALL, "Default for all students"], ...allVouchers().map((v) => [v, v]), [NOV, "No voucher"]];
  keep("fsGroup", groups.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join(""));
  keep("fsCopy", options(Object.keys(S.fees).filter((y) => y !== $("fnYear").value).sort().reverse(), "- choose a school year -"));
  if (!$("fpDate").value) $("fpDate").value = localDate();
  renderTypes(); renderFees(); renderPicker(); renderDash(); renderTx(); renderBal(); renderCalc();
}
$("fnYear").onchange = () => run(async () => { render(); await syncAccounts(); });

/* ======================= DASHBOARD ======================= */
function renderDash() {
  const y = $("fnYear").value, today = localDate(), pays = S.payments.filter((p) => p.schoolYear === y && p.status !== "void"), tp = pays.filter((p) => p.date === today), B = S.bill;
  const due = sum(B, (b) => b.due), owed = sum(B, (b) => Math.max(0, b.balance));
  $("dCards").innerHTML = [["Total student collection", money(sum(pays, (p) => p.amount)), "good"], ["Total collection for today", money(sum(tp, (p) => p.amount)), "blue"], ["Total student balance", money(owed), "warn"],
    ["Total to collect (all students)", money(due), ""], ["Students billed", B.length, ""], ["Fully paid", B.filter((b) => b.due > 0 && b.balance <= 0).length, "good"], ["With a balance", B.filter((b) => b.balance > 0).length, "warn"]]
    .map(([l, v, c]) => `<div class="stat ${c}"><b class="sm">${v}</b><span>${l}</span></div>`).join("");
  $("dToday").innerHTML = hdr(["Receipt No.", "Student", "Transaction", ["Amount"]]) + (tp.length ? [...tp].sort((a, b) => tsec(b) - tsec(a)).map((p) => `<tr>${cell(esc(p.receiptNo || "-"))}${cell(esc(p.name))}${cell(esc(p.type))}${cell(money(p.amount), 1)}</tr>`).join("") +
    `<tr class="tot">${cell("Total")}${cell("")}${cell("")}${cell(money(sum(tp, (p) => p.amount)), 1)}</tr>` : `<tr><td colspan="4">No payments recorded today.</td></tr>`);
  const types = [...new Set([...S.types, ...pays.map((p) => p.type)])];
  $("dType").innerHTML = hdr(["Payment transaction", ["To collect"], ["Collected"], ["Balance"]]) + types.map((t) => {
    const toC = sum(B, (b) => (b.lines.find((l) => l.type === t) || {}).due || 0), col = sum(pays.filter((p) => p.type === t), (p) => p.amount), bal = sum(B, (b) => Math.max(0, ((b.lines.find((l) => l.type === t) || {}).due || 0) - ((b.lines.find((l) => l.type === t) || {}).paid || 0)));
    return `<tr>${cell(esc(t))}${cell(money(toC), 1)}${cell(money(col), 1)}${cell(money(bal), 1)}</tr>`; }).join("") +
    `<tr class="tot">${cell("All transactions")}${cell(money(due), 1)}${cell(money(sum(pays, (p) => p.amount)), 1)}${cell(money(owed), 1)}</tr>`;
  const vg = (list, label, cls) => `<tr${cls ? ` class="${cls}"` : ""}>${cell(esc(label))}${cell(list.length, 1)}${cell(money(sum(list, (b) => b.due)), 1)}${cell(money(sum(list, (b) => b.paid)), 1)}${cell(money(sum(list, (b) => Math.max(0, b.balance))), 1)}</tr>`;
  const vs = [...allVouchers().filter((v) => B.some((b) => b.voucher === v))];
  $("dVoucher").innerHTML = hdr(["Voucher type", ["Students"], ["To collect"], ["Collected"], ["Balance"]]) + (B.length ? vs.map((v) => vg(B.filter((b) => b.voucher === v), v)).join("") +
    (B.some((b) => !b.voucher) ? vg(B.filter((b) => !b.voucher), "No voucher") : "") + vg(B, "All students", "tot") : `<tr><td colspan="5">No enrolled students for this school year.</td></tr>`);
  const gs = GRADES.filter((g) => B.some((b) => b.grade === g)), gl = (g, list, cls) => { const d = sum(list, (b) => b.due), p = sum(list, (b) => b.paid);
    return `<tr${cls ? ` class="${cls}"` : ""}>${cell(esc(g))}${cell(list.length, 1)}${cell(money(d), 1)}${cell(money(p), 1)}${cell(money(sum(list, (b) => Math.max(0, b.balance))), 1)}${cell(pcent(Math.min(p, d), d) + " " + bar(Math.min(p, d), d))}</tr>`; };
  $("dGrade").innerHTML = hdr(["Grade level", ["Students"], ["To collect"], ["Collected"], ["Balance"], "% collected"]) + (gs.length ? gs.map((g) => gl(g, B.filter((b) => b.grade === g))).join("") + gl("All grade levels", B, "tot") : `<tr><td colspan="6">No enrolled students for this school year.</td></tr>`);
}

/* ======================= RECORD A PAYMENT ======================= */
let picked = "";
const chosen = () => S.bill.find((b) => b.r.id === $("fpStu").value);
function renderPicker(select) {
  const q = $("fpQ").value.trim().toLowerCase(), rows = S.bill.filter((b) => !q || [b.r.studentNo, b.r.lrn, b.r.name].join(" ").toLowerCase().includes(q)).slice(0, 60);
  keep("fpStu", rows.map((b) => `<option value="${esc(b.r.id)}">${esc(b.r.studentNo)} - ${esc(b.r.name)}</option>`).join("") || `<option value="">No enrolled student found for this school year</option>`);
  if (select && rows.some((b) => b.r.id === select)) $("fpStu").value = select;
  const b = chosen(); $("fpInfo").hidden = !b; $("fpLinesBox").hidden = !b;
  if (b && b.r.id !== picked) { picked = b.r.id; }
  if (!b) { $("fpHist").innerHTML = ""; return; }
  $("fpInfo").innerHTML = [["Name", b.r.name], ["Student ID No.", b.r.studentNo], ["LRN", b.r.lrn || "-"], ["Grade level", b.grade || "-"], ["Section", b.section || "-"], ["Voucher", b.voucher || "No voucher"],
    ["Total to pay", money(b.due)], ["Total paid", money(b.paid)], ["Balance", b.balance < 0 ? money(0) + " (overpaid " + money(-b.balance) + ")" : money(b.balance)]].map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("");
  $("fpLines").innerHTML = hdr(["Payment transaction", ["To pay"], ["Paid"], ["Balance"]]) + (b.lines.length ? b.lines.map((l) => `<tr>${cell(esc(l.type))}${cell(money(l.due), 1)}${cell(money(l.paid), 1)}${cell(money(l.due - l.paid), 1)}</tr>`).join("") +
    `<tr class="tot">${cell("Total")}${cell(money(b.due), 1)}${cell(money(b.paid), 1)}${cell(money(b.balance), 1)}</tr>` : `<tr><td colspan="4">No fees are set for ${esc(b.grade || "this grade level")} / ${esc(b.voucher || "no voucher")}. Set them under Settings &gt; Fee schedule.</td></tr>`);
  const mine = S.payments.filter((p) => p.registryId === b.r.id && p.schoolYear === $("fnYear").value).sort((a, c) => (c.date || "").localeCompare(a.date || "") || tsec(c) - tsec(a));
  $("fpHist").innerHTML = hdr(["Date", "Receipt No.", "Transaction", ["Amount"], "Status", ""]) + (mine.map((p) => payRow(p, true)).join("") || `<tr><td colspan="6">No payments yet.</td></tr>`);
  prefill();
}
/** The amount box starts with what is still owed for the chosen transaction. */
function prefill() {
  const b = chosen(), t = $("fpType").value, l = b && b.lines.find((x) => x.type === t), left = l ? r2(l.due - l.paid) : 0;
  $("fpAmt").value = left > 0 ? left : ""; $("fpAmt").placeholder = left > 0 ? "" : "0.00";
}
$("fpQ").oninput = () => renderPicker(); $("fpStu").onchange = () => renderPicker(); $("fpType").onchange = prefill;
const payRow = (p, short) => `<tr class="${p.status === "void" ? "voided" : ""}">${cell(esc(dateText(p.date)))}${short ? "" : cell(esc(p.studentNo)) + cell(esc(p.name)) + cell(esc(p.gradeLevel || "-"))}` +
  (short ? "" : "") + `${cell(esc(p.receiptNo || "-"))}${cell(esc(p.type))}${cell(money(p.amount), 1)}${short ? "" : cell(esc(p.createdByName || "-"))}${cell(p.status === "void" ? `<span class="badge void" title="${esc(p.voidReason || "")}">Voided</span>` : '<span class="badge paid">Paid</span>')}` +
  `<td class="actions">${p.status === "void" ? "" : `<button class="btn small danger" data-void="${esc(p.id)}">Void</button>`}</td></tr>`;
$("fpSave").onclick = () => run(async () => {
  const b = chosen(); if (!b) return flash("Find and choose an enrolled student first.");
  if (!b.examNo) return flash("This student has no Exam ID No. yet. Enroll the student in a section first.");
  const date = $("fpDate").value, type = $("fpType").value, amount = r2($("fpAmt").value), receiptNo = $("fpOr").value.trim(), remarks = $("fpNote").value.trim();
  if (!date) return flash("Enter the date of payment."); if (date > localDate()) return flash("The date of payment cannot be in the future.");
  if (!type) return flash("Choose the payment transaction."); if (!(amount > 0)) return flash("Enter the amount paid.");
  const l = b.lines.find((x) => x.type === type), left = l ? r2(l.due - l.paid) : 0;
  if (amount > left && !confirm(`${money(amount)} is more than the ${money(Math.max(0, left))} still owed for ${type}. Record it anyway?`)) return;
  const rec = { schoolId: SID, schoolYear: $("fnYear").value, registryId: b.r.id, studentId: b.examNo, studentNo: b.r.studentNo, name: b.r.name, gradeLevel: b.grade, voucherType: b.voucher,
    date, type, amount, receiptNo, remarks, status: "active", createdBy: user.uid, createdByName: profile.displayName || "", createdAt: serverTimestamp() };
  const ref = doc(collection(db, "payments")); await setDoc(ref, rec);
  S.payments.push({ id: ref.id, ...rec, createdAt: { seconds: Math.floor(Date.now() / 1000) } });
  $("fpOr").value = ""; $("fpNote").value = ""; render(); await syncAccounts([S.bill.find((x) => x.r.id === b.r.id)].filter(Boolean));
  await logEvent("Recorded payment", `${b.r.name} (${b.r.studentNo})`, `${type} ${money(amount)} on ${date}${receiptNo ? " - receipt " + receiptNo : ""} - ${rec.schoolYear}`);
  flash(`Saved ${money(amount)} (${type}) for ${b.r.name}. Balance now ${money(Math.max(0, S.bill.find((x) => x.r.id === b.r.id).balance))}.`, true);
});
async function voidPayment(id) {
  const p = S.payments.find((x) => x.id === id); if (!p || p.status === "void") return;
  const why = prompt(`Void this payment?\n${p.name} - ${p.type} - ${money(p.amount)} on ${dateText(p.date)}\n\nType the reason (required). The payment stays in the history but is no longer counted.`);
  if (why === null) return; if (!why.trim()) return flash("A reason is required to void a payment.");
  const patch = { status: "void", voidReason: why.trim().slice(0, 200), voidedAt: serverTimestamp(), voidedBy: user.uid, voidedByName: profile.displayName || "" };
  await updateDoc(doc(db, "payments", id), patch);
  Object.assign(p, patch, { voidedAt: { seconds: Math.floor(Date.now() / 1000) } });
  render(); await syncAccounts();
  await logEvent("Voided payment", `${p.name} (${p.studentNo})`, `${p.type} ${money(p.amount)} on ${p.date} - ${patch.voidReason}`);
  flash("Payment voided.", true);
}
$("fpHist").onclick = (e) => { const b = e.target.closest("[data-void]"); if (b) run(() => voidPayment(b.dataset.void)); };

/* ======================= PAYMENT TRANSACTIONS ======================= */
function txRows() {
  const q = $("txQ").value.trim().toLowerCase(), from = $("txFrom").value, to = $("txTo").value, t = $("txType").value, g = $("txGrade").value, st = $("txStatus").value;
  return S.payments.filter((p) => p.schoolYear === $("fnYear").value && (!st || (st === "void" ? p.status === "void" : p.status !== "void")) && (!t || p.type === t) && (!g || p.gradeLevel === g) && (!from || p.date >= from) && (!to || p.date <= to) &&
    (!q || [p.name, p.studentNo, p.receiptNo].join(" ").toLowerCase().includes(q))).sort((a, b) => (b.date || "").localeCompare(a.date || "") || tsec(b) - tsec(a));
}
function renderTx() {
  const rows = txRows(), valid = rows.filter((p) => p.status !== "void");
  $("txCount").textContent = `${rows.length} payment${rows.length === 1 ? "" : "s"} - total ${money(sum(valid, (p) => p.amount))}` + (rows.length > 12 ? " - scroll the list to see all" : "");
  $("txTbl").innerHTML = hdr(["Date", "Student ID No.", "Name", "Grade", "Receipt No.", "Transaction", ["Amount"], "Recorded by", "Status", ""]) + (rows.slice(0, 1500).map((p) => payRow(p, false)).join("") || `<tr><td colspan="10">No payments found.</td></tr>`);
}
["txQ", "txFrom", "txTo", "txType", "txGrade", "txStatus"].forEach((i) => ($(i).oninput = renderTx));
$("txToday").onclick = () => { $("txFrom").value = $("txTo").value = localDate(); renderTx(); };
$("txClear").onclick = () => { ["txQ", "txFrom", "txTo", "txType", "txGrade"].forEach((i) => ($(i).value = "")); $("txStatus").value = "active"; renderTx(); };
$("txTbl").onclick = (e) => { const b = e.target.closest("[data-void]"); if (b) run(() => voidPayment(b.dataset.void)); };
$("txXlsx").onclick = () => {
  const rows = txRows().map((p) => ({ Date: p.date, "Student ID No.": p.studentNo, Name: p.name, "Grade Level": p.gradeLevel || "", "Voucher Type": p.voucherType || "", "Receipt No.": p.receiptNo || "", Transaction: p.type, Amount: p.amount,
    "Recorded by": p.createdByName || "", Status: p.status === "void" ? "Voided" : "Paid", "Void reason": p.voidReason || "", Remarks: p.remarks || "" }));
  if (!rows.length) return flash("There are no payments to download with these filters.");
  saveXlsx([{ name: "Payments", rows, header: Object.keys(rows[0]) }], `payments-${$("fnYear").value}-${SID}.xlsx`);
};

/* ======================= STUDENT BALANCES ======================= */
const statusOf = (b) => (b.due <= 0 && b.paid <= 0 ? "none" : b.balance <= 0 ? "paid" : b.paid > 0 ? "part" : "unpaid");
function balRows() {
  const q = $("sbQ").value.trim().toLowerCase(), g = $("sbGrade").value, v = $("sbVoucher").value, st = $("sbStatus").value;
  return S.bill.filter((b) => (!g || b.grade === g) && (!v || (v === "No voucher" ? !b.voucher : b.voucher === v)) && (!q || [b.r.studentNo, b.r.lrn, b.r.name].join(" ").toLowerCase().includes(q)) &&
    (!st || (st === "bal" ? b.balance > 0 : st === "paid" ? b.due > 0 && b.balance <= 0 : b.paid <= 0)));
}
function renderBal() {
  const rows = balRows(), label = { paid: '<span class="badge paid">Paid</span>', part: '<span class="badge part">Partial</span>', unpaid: '<span class="badge unpaid">Unpaid</span>', none: '<span class="badge">No fees set</span>' };
  $("sbCount").textContent = `${rows.length} of ${S.bill.length} enrolled students - total to pay ${money(sum(rows, (b) => b.due))}, paid ${money(sum(rows, (b) => b.paid))}, balance ${money(sum(rows, (b) => Math.max(0, b.balance)))}` + (rows.length > 12 ? " - scroll the list to see all" : "");
  $("sbTbl").innerHTML = hdr(["Student ID No.", "LRN", "Name", "Grade", "Section", "Voucher", ["Total to pay"], ["Paid"], ["Balance"], "Status", ""]) +
    (rows.slice(0, 3000).map((b) => `<tr>${cell(esc(b.r.studentNo))}${cell(esc(b.r.lrn || "-"))}${cell(esc(b.r.name))}${cell(esc(b.grade))}${cell(esc(b.section || "-"))}${cell(esc(b.voucher || "-"))}${cell(money(b.due), 1)}${cell(money(b.paid), 1)}${cell(money(Math.max(0, b.balance)), 1)}${cell(label[statusOf(b)])}` +
      `<td class="actions"><button class="btn small primary" data-pay="${esc(b.r.id)}">Pay</button></td></tr>`).join("") || `<tr><td colspan="11">No students found.</td></tr>`);
}
["sbQ", "sbGrade", "sbVoucher", "sbStatus"].forEach((i) => ($(i).oninput = renderBal));
$("sbTbl").onclick = (e) => { const b = e.target.closest("[data-pay]"); if (!b) return; const s = S.bill.find((x) => x.r.id === b.dataset.pay); if (!s) return; show("pay"); $("fpQ").value = s.r.studentNo; renderPicker(s.r.id); scrollTo({ top: 0 }); };
$("sbXlsx").onclick = () => {
  const rows = balRows().map((b) => ({ "Student ID No.": b.r.studentNo, LRN: b.r.lrn || "", Name: b.r.name, "Grade Level": b.grade, Section: b.section, "Voucher Type": b.voucher || "", "Total to pay": b.due, Paid: b.paid, Balance: Math.max(0, b.balance),
    ...Object.fromEntries(S.types.map((t) => [t + " balance", r2(Math.max(0, ((b.lines.find((l) => l.type === t) || {}).due || 0) - ((b.lines.find((l) => l.type === t) || {}).paid || 0)))])) }));
  if (!rows.length) return flash("There are no students to download with these filters.");
  saveXlsx([{ name: "Student balances", rows, header: Object.keys(rows[0]) }], `student-balances-${$("fnYear").value}-${SID}.xlsx`);
};

/* ======================= PAYMENT COMPUTATION ======================= */
function renderCalc() {
  const y = $("fnYear").value, vs = [...allVouchers(), ""], vlabel = (v) => v || "No voucher";
  const grades = GRADES.filter((g) => S.bill.some((b) => b.grade === g) || Object.values(S.fees[y] || {}).some((grp) => grp[g]));
  $("cmTbl").innerHTML = hdr(["Grade level", ...vs.map((v) => [esc(vlabel(v))])]) + (grades.map((g) => `<tr>${cell(esc(g))}` + vs.map((v) => {
    const d = dueOf(g, v, y), n = S.bill.filter((b) => b.grade === g && b.voucher === v).length;
    return `<td class="num"><b>${d.length ? money(sum(d, (x) => x.amount)) : "-"}</b><small>${d.length ? d.map((x) => `${esc(x.type)} ${money(x.amount)}`).join(" + ") : "no fees set"}</small><small>${n} student${n === 1 ? "" : "s"}</small></td>`; }).join("") + "</tr>").join("") ||
    `<tr><td colspan="${vs.length + 1}">Nothing to show yet. Set the fees under Settings &gt; Fee schedule.</td></tr>`);
}

/* ======================= SETTINGS ======================= */
function renderTypes() {
  $("tyList").innerHTML = S.types.map((t) => `<span class="tag">${esc(t)}<button type="button" data-ty="${esc(t)}" aria-label="Remove ${esc(t)}">&times;</button></span>`).join("") || '<span class="muted">None yet.</span>';
}
$("tyAdd").onclick = () => run(async () => {
  const v = $("tyNew").value.trim();
  if (!v) return flash("Enter the name of the payment transaction.");
  if (/[./\[\]*~`]/.test(v) || v.startsWith("__")) return flash("Do not use . / [ ] * ~ in the name.");
  if (S.types.some((t) => t.toLowerCase() === v.toLowerCase())) return flash("That payment transaction already exists.");
  S.types.push(v); $("tyNew").value = ""; await saveSettings(); await logEvent("Changed settings", "Payment transactions", "Added " + v); render(); flash("Payment transaction added.", true);
});
$("tyList").onclick = (e) => run(async () => {
  const b = e.target.closest("[data-ty]"); if (!b) return; const t = b.dataset.ty;
  if (!confirm(`Remove "${t}"? Payments already recorded keep it, but its fee amounts are no longer counted in the total to pay.`)) return;
  S.types = S.types.filter((x) => x !== t); await saveSettings(); await logEvent("Changed settings", "Payment transactions", "Removed " + t); render(); await syncAccounts();
});
function renderFees() {
  if ($("fsTbl").contains(document.activeElement) && document.activeElement.matches("input")) return; // do not disturb typing
  const y = $("fnYear").value, cur = ((S.fees[y] || {})[$("fsGroup").value || ALL]) || {};
  $("fsYear").textContent = "school year " + y;
  $("fsTbl").innerHTML = hdr(["Grade level", ...S.types.map((t) => [esc(t)])]) + GRADES.map((g) => `<tr>${cell(esc(g))}` + S.types.map((t) => `<td class="num"><input type="number" min="0" step="0.01" inputmode="decimal" data-g="${esc(g)}" data-t="${esc(t)}" value="${cur[g] && cur[g][t] !== undefined ? cur[g][t] : ""}" aria-label="${esc(g)} ${esc(t)}"></td>`).join("") + "</tr>").join("");
}
$("fsGroup").onchange = () => renderFees();
const groupLabel = () => $("fsGroup").selectedOptions[0]?.textContent || "";
$("fsSave").onclick = () => run(async () => {
  const y = $("fnYear").value, gk = $("fsGroup").value || ALL, next = {};
  $("fsTbl").querySelectorAll("input").forEach((i) => { if (i.value.trim() === "") return; const n = r2(i.value); if (n < 0) return; (next[i.dataset.g] = next[i.dataset.g] || {})[i.dataset.t] = n; });
  S.fees[y] = { ...(S.fees[y] || {}), [gk]: next }; if (!Object.keys(next).length) delete S.fees[y][gk]; if (!Object.keys(S.fees[y]).length) delete S.fees[y];
  await saveSettings(); await logEvent("Changed settings", `Fee schedule ${y}`, `Saved ${groupLabel()}`); document.activeElement.blur(); render(); await syncAccounts();
  flash(`Fee schedule saved for ${groupLabel()} (${y}). Student balances were updated.`, true);
});
$("fsClear").onclick = () => run(async () => {
  const y = $("fnYear").value, gk = $("fsGroup").value || ALL; if (!(S.fees[y] || {})[gk]) return flash("Nothing to clear for this group.");
  if (!confirm(`Clear every amount of ${groupLabel()} for ${y}?`)) return;
  delete S.fees[y][gk]; if (!Object.keys(S.fees[y]).length) delete S.fees[y];
  await saveSettings(); await logEvent("Changed settings", `Fee schedule ${y}`, `Cleared ${groupLabel()}`); render(); await syncAccounts();
});
$("fsCopyGo").onclick = () => run(async () => {
  const src = $("fsCopy").value, y = $("fnYear").value; if (!src || !S.fees[src]) return flash("Choose the school year to copy from.");
  if (S.fees[y] && !confirm(`${y} already has a fee schedule. Replace it with the one of ${src}?`)) return;
  S.fees[y] = JSON.parse(JSON.stringify(S.fees[src])); await saveSettings(); await logEvent("Changed settings", `Fee schedule ${y}`, `Copied from ${src}`); render(); await syncAccounts(); flash(`Copied the fee schedule of ${src} to ${y}.`, true);
});

/* ======================= HISTORY ======================= */
async function loadHistory() {
  $("hiNote").hidden = true;
  try { S.log = (await bySchool("financeLog")).sort((a, b) => (b.at?.seconds || 0) - (a.at?.seconds || 0)); S.logLoaded = true; }
  catch (e) { console.error(e); $("hiNote").textContent = "The history could not be loaded. Press Refresh. " + friendlyError(e); $("hiNote").hidden = false; }
  renderHistory();
}
function renderHistory() {
  const q = $("hiQ").value.trim().toLowerCase(), rows = S.log.filter((l) => !q || [l.byName, l.byNo, l.action, l.label, l.note].join(" ").toLowerCase().includes(q)), shown = rows.slice(0, 300);
  $("hiCount").textContent = `${rows.length} of ${S.log.length} entr${S.log.length === 1 ? "y" : "ies"}` + (rows.length > shown.length ? ` - showing the latest ${shown.length}` : "");
  $("hiTbl").innerHTML = hdr(["When", "Done by", "Action", "Record", "Details"]) + (shown.map((l) => `<tr>${cell(esc(whenOf(l)))}${cell(esc(l.byName || "-") + (l.byNo ? `<small>Employee No. ${esc(l.byNo)}</small>` : ""))}${cell(`<span class="badge act ${/Voided/.test(l.action) ? "del" : ""}">${esc(l.action)}</span>`)}${cell(esc(l.label || "-"))}<td class="wrapcell">${esc(l.note || "-")}</td></tr>`).join("") ||
    `<tr><td colspan="5">${S.log.length ? "No entries match." : "Nothing recorded yet."}</td></tr>`);
}
$("hiQ").oninput = renderHistory; $("hiRefresh").onclick = () => run(loadHistory);

refresh();
