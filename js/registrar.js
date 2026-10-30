import { requireRole, logout, db, esc, friendlyError, ageOf, applyBranding } from "./auth.js";
import { collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, deleteField, callFn }
  from "./db.js";
import { TERMS, termRank } from "./omr.js";

const $ = (id) => document.getElementById(id);
const { user, profile, school } = await requireRole(["registrar"]);
const SID = profile.schoolId;
$("who").textContent = profile.displayName + " (Registrar)"; $("out").onclick = logout;
applyBranding(school);

const flash = (t, ok) => { const m = $("msg"); m.textContent = t; m.className = "notice noprint " + (ok ? "ok" : "err"); m.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => (m.hidden = true), 9000); scrollTo({ top: 0, behavior: "smooth" }); };
const net = () => { $("sync").className = "sync" + (navigator.onLine ? "" : " off"); $("sync").lastElementChild.textContent = navigator.onLine ? "Online" : "Offline - changes will not save"; };
addEventListener("online", net); addEventListener("offline", net); net();
const run = async (fn) => { try { await fn(); } catch (e) { console.error(e); flash(friendlyError(e)); } };

/* ---------- constants and helpers ---------- */
const GRADES = ["Kindergarten", ...Array.from({ length: 12 }, (_, i) => "Grade " + (i + 1))];
const MODALITIES = ["Face to Face", "Blended", "Modular", "Internal Agreement"];
const REMARKS = ["Transferred Out", "Drop Out", "Cancelled Enrolled"];
const DEFAULT_VOUCHERS = ["PUB", "ALS", "ESC"];
const DEFAULT_STRANDS = ["STEM", "ABM", "HUMSS", "GAS", "TVL"];
/* School requirements: what a student hands in after registering (the list can be changed under Settings). The ids are shared with the Records sheet. */
const DEFAULT_REQS = [{ id: "form138", label: "Form 138 / Report Card" }, { id: "psa", label: "PSA Birth Certificate" }, { id: "goodmoral", label: "Good Moral Certificate" },
  { id: "form137", label: "Form 137 / SF10 (Permanent Record)" }, { id: "pictures", label: "2x2 ID Pictures" }, { id: "enrollform", label: "Signed Enrollment Form" }, { id: "transfer", label: "Certificate of Transfer (transferees only)" }];
const STATUSES = ["Pending", "Enrolled", "Not Enrolled", ...REMARKS];
const STATUS_CLASS = { Pending: "st-pending", Enrolled: "st-enrolled", "Not Enrolled": "st-not", "Transferred Out": "st-out", "Drop Out": "st-out", "Cancelled Enrolled": "st-out" };
const statusBadge = (s) => `<span class="badge ${STATUS_CLASS[s] || "st-not"}">${esc(s)}</span>`;
const schoolYearNow = () => { const d = new Date(), y = d.getFullYear(); return d.getMonth() >= 5 ? `${y}-${y + 1}` : `${y - 1}-${y}`; };
const rid = (no) => `${SID}_${String(no).trim()}`;
const nameOf = (p) => `${p.lastName}, ${p.firstName}${p.middleName ? " " + p.middleName : ""}${p.suffix ? " " + p.suffix : ""}`;
const bd = (b) => (b ? new Date(b + "T00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "-");
const options = (list, first) => (first !== undefined ? `<option value="">${esc(first)}</option>` : "") + list.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
const keep = (id, html) => { const el = $(id), v = el.value; el.innerHTML = html; if ([...el.options].some((o) => o.value === v)) el.value = v; };
const isLrn = (s) => /^\d{12}$/.test(s);
const isStuNo = (s) => /^[A-Za-z0-9._-]{1,30}$/.test(s);
const normGender = (g) => (/^\s*m/i.test(g) ? "Male" : /^\s*f/i.test(g) ? "Female" : "");
const tsec = (x) => x?.createdAt?.seconds || 0;
const statusOf = (r) => (r && r.enrollStatus) || "Pending";
const reqCount = (r) => S.reqs.filter((q) => (r.reqs || {})[q.id]).length;
const reqDone = (r) => S.reqs.length > 0 && reqCount(r) >= S.reqs.length;
const reqText = (r) => `${reqCount(r)} of ${S.reqs.length}`;

/* ---------- data ---------- */
const S = { registry: [], sections: [], teachers: [], enrollments: [], vouchers: [...DEFAULT_VOUCHERS], strands: [...DEFAULT_STRANDS], reqs: DEFAULT_REQS.map((x) => ({ ...x })), fields: { reg: [], enroll: [], master: [] } };
const bySchool = async (c, ...w) => (await getDocs(query(collection(db, c), where("schoolId", "==", SID), ...w))).docs.map((d) => ({ id: d.id, ...d.data() }));
async function refresh() {
  await run(async () => {
    const [reg, cls, ens, tch, set] = await Promise.all([
      bySchool("registry"), bySchool("classes"), bySchool("enrollmentRecords"),
      getDocs(query(collection(db, "users"), where("schoolId", "==", SID), where("role", "==", "teacher"))),
      getDoc(doc(db, "registrarSettings", SID)).catch(() => null),
    ]);
    S.registry = reg.sort((a, b) => a.name.localeCompare(b.name));
    S.sections = cls.filter((c) => c.gradeLevel).sort((a, b) => a.name.localeCompare(b.name));
    S.enrollments = ens;
    S.teachers = tch.docs.map((d) => ({ uid: d.id, ...d.data() })).filter((t) => t.status === "active").sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
    if (set && set.exists()) { S.vouchers = set.data().voucherTypes || S.vouchers; S.strands = set.data().strands || S.strands; if (Array.isArray(set.data().requirements) && set.data().requirements.length) S.reqs = set.data().requirements; const f = set.data().fields || {}; S.fields = { reg: f.reg || [], enroll: f.enroll || [], master: f.master || [] }; }
    await backfillStatus();
    render();
  });
}
/** Students registered before the "enrollment status" existed get one now (worked out once from their enrollment records). */
async function backfillStatus() {
  const todo = S.registry.filter((r) => !r.enrollStatus);
  if (!todo.length) return;
  const stOf = (r) => { const mine = S.enrollments.filter((e) => e.registryId === r.id); if (!mine.length) return "Not Enrolled"; if (mine.some((e) => !e.remark)) return "Enrolled"; return mine.find((e) => e.remark).remark; };
  try {
    for (let i = 0; i < todo.length; i += 200) {
      const b = writeBatch(db), part = todo.slice(i, i + 200);
      part.forEach((r) => b.update(doc(db, "registry", r.id), { enrollStatus: stOf(r) }));
      await b.commit(); part.forEach((r) => (r.enrollStatus = stOf(r)));
    }
  } catch (e) { console.warn("Could not set the enrollment status of older students", e); }
}
const saveSettings = () => setDoc(doc(db, "registrarSettings", SID), { schoolId: SID, voucherTypes: S.vouchers, strands: S.strands, requirements: S.reqs, fields: S.fields, updatedAt: serverTimestamp() }, { merge: true });

/* ---------- history log: who changed what ---------- */
const FLABEL = { schoolYear: "School year", gradeLevel: "Grade level", lrn: "LRN", voucherType: "Voucher type", lastName: "Last name", firstName: "First name", middleName: "Middle name", suffix: "Suffix", birthday: "Birthdate", gender: "Gender",
  contact: "Contact No.", address: "Address", father: "Father's name", mother: "Mother's name", guardianName: "Guardian's name", guardianContact: "Guardian contact No.", guardianAddress: "Guardian's address" };
const clip = (v, n = 160) => String(v ?? "").slice(0, n);
/** What changed between a saved student record and the new values (only the keys present in `patch`). */
function diffRec(oldR, patch) {
  const out = [], fields = [...S.fields.reg, ...S.fields.master, ...S.fields.enroll];
  for (const [k, lab] of Object.entries(FLABEL)) { if (!(k in patch)) continue; const a = String(oldR[k] ?? ""), b = String(patch[k] ?? ""); if (a !== b) out.push({ f: lab, from: a, to: b }); }
  for (const [id, val] of Object.entries(patch.extra || {})) { const a = String((oldR.extra || {})[id] ?? ""), b = String(val ?? ""); if (a !== b) out.push({ f: (fields.find((x) => x.id === id) || {}).label || id, from: a, to: b }); }
  return out;
}
/** Appends one entry to the registrar's history. A failure here never blocks the real action. */
async function logEvent(action, target, label, changes, note, items) {
  try {
    await setDoc(doc(collection(db, "registrarLog")), { schoolId: SID, at: serverTimestamp(), byUid: user.uid, byName: profile.displayName || "", byNo: profile.employeeId || "",
      action, target, label: clip(label, 200), note: clip(note, 400),
      changes: (changes || []).slice(0, 60).map((c) => ({ f: clip(c.f, 80), from: clip(c.from), to: clip(c.to) })), items: (items || []).slice(0, 300).map((x) => clip(x, 140)) });
    S.logLoaded = false;
  } catch (e) { console.warn("History entry could not be saved", e); }
}

/* ---------- navigation ---------- */
/** Every page with several parts has a button bar (.subnav); each button shows one panel and hides the others. */
const SUB = { enroll: "enForm", sections: "scListP", enrolled: "elList", settings: "stVoucher" };
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
document.addEventListener("click", (e) => {
  const nb = e.target.closest(".subnav button[data-p]"); if (nb) return showSub(nb.closest("[data-s]").dataset.s, nb.dataset.p);
  const g = e.target.closest("[data-goto]"); if (g) { const [pg, p] = g.dataset.goto.split(":"); show(pg, p); scrollTo({ top: 0, behavior: "smooth" }); }
});
show("dash");

/* ---------- rendering ---------- */
function render() {
  const noneV = "- none -", noneS = "- none / not applicable -";
  keep("rgGrade", options(GRADES)); keep("rgVoucher", options(S.vouchers, noneV));
  keep("enModality", options(MODALITIES)); keep("elModality", options(MODALITIES, "All learning modalities")); keep("elRemark", `<option value="">All students</option><option value="__none">No remark (active)</option>` + REMARKS.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join(""));
  keep("rmSel", `<option value="">- no remark (clear) -</option>` + REMARKS.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join(""));
  keep("mlYear", options(yearsList(), "All school years")); keep("mlTerm", options(TERMS, "All terms / quarters")); $("yrList").innerHTML = yearChoices().map((y) => `<option value="${esc(y)}">`).join("");
  keep("enGrade", options(GRADES)); keep("enTerm", options(TERMS)); keep("enStrand", options(S.strands, noneS));
  keep("scGrade", options(GRADES)); keep("scStrand", options(S.strands, noneS)); keep("scFilter", options(GRADES, "All grade levels"));
  keep("mlGrade", options(GRADES, "All grade levels")); keep("mlVoucher", options(S.vouchers, "All voucher types"));
  keep("dsYear", options(yearChoices())); keep("dsTermSel", options(TERMS, "All terms / quarters"));
  keep("rqYear", options(yearChoices(), "All school years")); keep("rqGrade", options(GRADES, "All grade levels")); keep("rqStatus", options(STATUSES, "All statuses")); keep("rqDStatus", options(STATUSES));
  keep("elYear", options(yearChoices(), "All school years")); keep("elTerm", options(TERMS, "All terms / quarters")); keep("elGrade", options(GRADES, "All grade levels")); keep("elStrand", options(S.strands, "All clusters / strands"));
  keep("elSection", `<option value="">All sections</option>` + [...S.sections].sort(byGradeName).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")); keep("elVoucher", options(S.vouchers, "All voucher types"));
  keep("msGrade", options(GRADES, "All grade levels")); keep("msYear", options(yearsList(), "All school years")); keep("msTerm", options(TERMS, "All terms"));
  keep("scAdv", S.teachers.map((t) => `<option value="${esc(t.uid)}">${esc(t.displayName)} (${esc(t.employeeId || "")})</option>`).join("") || `<option value="">No teacher accounts yet - ask the IT Admin</option>`);
  if (!$("enYear").value) $("enYear").value = schoolYearNow();
  if (!$("rgYear").value && !editing) $("rgYear").value = schoolYearNow();
  renderVoucherStrand(); renderReqSettings(); renderFieldSettings(); renderExtras(); renderReqs(); renderDash(); renderMaster(); renderEnList(); renderMasterSections(); renderEnrollPicker(); renderSections(); renderSectionView(); renderEnrolled();
}

/* ======================= ADDITIONAL INFORMATION (custom fields) ======================= */
const FTYPES = { text: "Text", number: "Number", date: "Date", select: "Dropdown list", yesno: "Yes / No" };
const GROUPS = { reg: "Student registration", enroll: "Enrollment", master: "Master list" };
const colFields = () => [...S.fields.reg, ...S.fields.master];
const fieldHtml = (f) => {
  const a = `data-x="${esc(f.id)}"`, L = esc(f.label);
  if (f.type === "select") return `<label>${L}<select ${a}><option value="">-</option>${(f.options || []).map((o) => `<option>${esc(o)}</option>`).join("")}</select></label>`;
  if (f.type === "yesno") return `<label>${L}<select ${a}><option value="">-</option><option>Yes</option><option>No</option></select></label>`;
  return `<label>${L}<input ${a} type="${f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}" autocomplete="off"></label>`;
};
const readExtras = (boxId) => Object.fromEntries([...$(boxId).querySelectorAll("[data-x]")].map((el) => [el.dataset.x, el.value.trim()]));
function drawExtra(boxId, fields, vals) {
  const box = $(boxId), cur = { ...readExtras(boxId), ...(vals || {}) };
  box.innerHTML = fields.map(fieldHtml).join("");
  box.querySelectorAll("[data-x]").forEach((el) => { if (cur[el.dataset.x] !== undefined) el.value = cur[el.dataset.x]; });
}
function renderExtras(vals) {
  drawExtra("rgExtra", S.fields.reg, vals); $("rgExtraBox").hidden = !S.fields.reg.length;
  drawExtra("rgMaster", S.fields.master, vals); $("rgMasterBox").hidden = !(S.fields.master.length && editing);
  drawExtra("enExtra", S.fields.enroll);
}
function renderFieldSettings() {
  if ($("fieldsBox").contains(document.activeElement) && document.activeElement.matches("input")) return; // do not disturb typing
  $("fieldsBox").innerHTML = Object.entries(GROUPS).map(([g, title]) => `<div class="fgroup" data-g="${g}"><h3>${title}</h3>
    <div class="chiplist">${S.fields[g].map((f) => `<span class="tag">${esc(f.label)} <small style="display:inline;margin:0">(${FTYPES[f.type]}${f.type === "select" ? ": " + esc((f.options || []).join(", ")) : ""})</small><button type="button" data-frm="${g}" data-id="${esc(f.id)}" aria-label="Remove ${esc(f.label)}">&times;</button></span>`).join("") || '<span class="muted">No additional fields yet.</span>'}</div>
    <div class="row"><label>Field title<input data-fl maxlength="40" placeholder="e.g. Religion" autocomplete="off"></label>
    <label>Type<select data-ft>${Object.entries(FTYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
    <label data-fo hidden>Choices <small>Separate with commas</small><input data-fopt maxlength="300" placeholder="Catholic, Muslim, Others" autocomplete="off"></label>
    <button class="btn primary" type="button" data-fadd="${g}">Add field</button></div></div>`).join("");
}
$("fieldsBox").onchange = (e) => { const t = e.target.closest("[data-ft]"); if (t) t.closest(".fgroup").querySelector("[data-fo]").hidden = t.value !== "select"; };
$("fieldsBox").onclick = (e) => run(async () => {
  const add = e.target.closest("[data-fadd]"), rm = e.target.closest("[data-frm]");
  if (add) {
    const box = add.closest(".fgroup"), g = add.dataset.fadd, label = box.querySelector("[data-fl]").value.trim(), type = box.querySelector("[data-ft]").value;
    const options = box.querySelector("[data-fopt]").value.split(",").map((x) => x.trim()).filter(Boolean);
    if (!label) return flash("Enter the field title.");
    if (type === "select" && options.length < 2) return flash("Enter at least two choices, separated by commas.");
    const all = [...S.fields.reg, ...S.fields.enroll, ...S.fields.master];
    if (all.some((f) => f.label.toLowerCase() === label.toLowerCase())) return flash("A field with that title already exists.");
    S.fields[g].push({ id: "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), label, type, ...(type === "select" ? { options } : {}) });
    await saveSettings(); await logEvent("Changed settings", "settings", "Additional information - " + GROUPS[g], [{ f: "Field", from: "", to: `${label} (${FTYPES[type]})` }], "Field added"); render(); return flash(`Added "${label}" to ${GROUPS[g]}.`, 1);
  }
  if (rm) {
    const f = S.fields[rm.dataset.frm].find((x) => x.id === rm.dataset.id); if (!f) return;
    if (!confirm(`Remove the field "${f.label}"? Values already saved stay in the records but are no longer shown.`)) return;
    S.fields[rm.dataset.frm] = S.fields[rm.dataset.frm].filter((x) => x.id !== f.id); await saveSettings(); await logEvent("Changed settings", "settings", "Additional information - " + GROUPS[rm.dataset.frm], [{ f: "Field", from: f.label, to: "" }], "Field removed"); render();
  }
});

/* ======================= STUDENT REGISTRATION ======================= */
const F = { no: "rgNo", lrn: "rgLrn", last: "rgLast", first: "rgFirst", middle: "rgMiddle", suffix: "rgSuffix", bday: "rgBday", contact: "rgContact", address: "rgAddress",
  father: "rgFather", mother: "rgMother", guardian: "rgGuardian", gcontact: "rgGContact", gaddress: "rgGAddress" };
let editing = null;
$("rgBday").oninput = () => ($("rgAge").value = ageOf($("rgBday").value));
function clearForm() {
  editing = null; Object.values(F).forEach((i) => ($(i).value = "")); $("rgAge").value = ""; $("rgGender").value = ""; $("rgVoucher").value = "";
  $("rgYear").value = schoolYearNow(); $("rgNo").readOnly = false; renderExtras({}); document.querySelectorAll("#rgExtra [data-x],#rgMaster [data-x]").forEach((el) => (el.value = "")); $("rgMasterBox").hidden = true; $("rgHead").textContent = "Student registration"; $("rgSave").textContent = "Save registration"; $("rgCancel").hidden = true;
}
$("rgCancel").onclick = clearForm;
function fillForm(r) {
  editing = r.id; $("rgYear").value = r.schoolYear || ""; $("rgGrade").value = r.gradeLevel || GRADES[0]; $("rgVoucher").value = r.voucherType || "";
  $(F.no).value = r.studentNo; $(F.lrn).value = r.lrn || ""; $(F.last).value = r.lastName; $(F.first).value = r.firstName; $(F.middle).value = r.middleName || ""; $(F.suffix).value = r.suffix || "";
  $(F.bday).value = r.birthday || ""; $("rgAge").value = ageOf(r.birthday); $("rgGender").value = r.gender || ""; $(F.contact).value = r.contact || ""; $(F.address).value = r.address || "";
  $(F.father).value = r.father || ""; $(F.mother).value = r.mother || ""; $(F.guardian).value = r.guardianName || ""; $(F.gcontact).value = r.guardianContact || ""; $(F.gaddress).value = r.guardianAddress || "";
  $("rgNo").readOnly = true; renderExtras(r.extra || {}); document.querySelectorAll("#rgExtra [data-x],#rgMaster [data-x]").forEach((el) => (el.value = (r.extra || {})[el.dataset.x] ?? "")); $("rgHead").textContent = `Edit registration - ${r.name}`; $("rgSave").textContent = "Save changes"; $("rgCancel").hidden = false;
  show("reg"); scrollTo({ top: 0 });
}
/** Keeps the teacher-visible student record (name, birthday, gender) in step with the master list. */
async function syncStudent(r) {
  if (!r.examNo) return;
  await updateDoc(doc(db, "students", r.examNo), { lastName: r.lastName, firstName: r.firstName, middleInitial: (r.middleName || "").slice(0, 1).toUpperCase(), name: r.name,
    birthday: r.birthday || "", gender: r.gender || "", lrn: r.lrn || "", studentNo: r.studentNo, updatedAt: serverTimestamp() }).catch(() => {});
}
$("rgSave").onclick = () => run(async () => {
  const v = (k) => $(F[k]).value.trim();
  const p = { schoolYear: $("rgYear").value.trim(), gradeLevel: $("rgGrade").value, studentNo: v("no"), lrn: v("lrn").replace(/\s+/g, ""), voucherType: $("rgVoucher").value,
    lastName: v("last"), firstName: v("first"), middleName: v("middle"), suffix: v("suffix"), birthday: $(F.bday).value, gender: $("rgGender").value,
    contact: v("contact"), address: v("address"), father: v("father"), mother: v("mother"), guardianName: v("guardian"), guardianContact: v("gcontact"), guardianAddress: v("gaddress"), extra: { ...readExtras("rgExtra"), ...readExtras("rgMaster") } };
  if (!/^\d{4}-\d{4}$/.test(p.schoolYear)) return flash("Enter the school year like 2026-2027.");
  if (!p.studentNo || !isStuNo(p.studentNo)) return flash("Enter the Student ID No. (letters, numbers, dot, dash or underscore only).");
  if (p.lrn && !isLrn(p.lrn)) return flash("The LRN must be exactly 12 digits. Leave it blank if the student has no LRN yet.");
  if (!p.lastName || !p.firstName) return flash("Enter the last name and first name.");
  if (!p.birthday) return flash("Enter the birthdate (it gives the age and is used for the student's first password).");
  if (!p.gender) return flash("Choose the gender.");
  if (!p.father && !p.mother && !p.guardianName) return flash("Enter the father's name, the mother's name, or the guardian's name if there is neither.");
  const id = rid(p.studentNo), old = S.registry.find((r) => r.id === id);
  if (!editing && old) return flash(`Student ID No. ${p.studentNo} is already registered (${old.name}).`);
  if (p.lrn && S.registry.some((r) => r.lrn === p.lrn && r.id !== id)) return flash("Another student already has that LRN.");
  p.name = nameOf(p);
  const rec = { ...p, ...(old ? {} : { schoolId: SID, createdBy: user.uid, createdAt: serverTimestamp(), enrollStatus: "Pending", reqs: {} }), updatedAt: serverTimestamp() };
  await setDoc(doc(db, "registry", id), rec, { merge: true });
  const who = `${p.name} (${p.studentNo})`, diff = old ? diffRec(old, p) : [];
  if (!old) await logEvent("Registered student", "student", who, [], `${p.schoolYear} - ${p.gradeLevel}${p.voucherType ? " - voucher " + p.voucherType : ""}`);
  else if (diff.length) await logEvent("Edited student", "student", who, diff);
  const merged = { ...(old || {}), ...p, extra: { ...(old?.extra || {}), ...p.extra }, id }; await syncStudent(merged);
  const was = editing; clearForm(); await refresh();
  flash(was ? `Saved changes for ${p.name}.` : `Registered ${p.name} (status: Pending). Next: tick the School requirements checklist as the documents are handed in, then enroll the student in a section.`, true);
  if (old?.examNo && p.lrn && old.examNo !== p.lrn) flash(`Saved. The Exam ID No. stays ${old.examNo} because the student is already enrolled; it is not changed afterwards.`, true);
});

/* ======================= MASTER LIST ======================= */
function latestEnrol(r) {
  return S.enrollments.filter((e) => e.registryId === r.id).sort((a, b) => (b.schoolYear || "").localeCompare(a.schoolYear || "") || termRank(b.term) - termRank(a.term) || tsec(b) - tsec(a))[0];
}
let mlLetter = "";
const lastInit = (r) => (String(r.lastName || r.name || "").trim()[0] || "#").toUpperCase();
/** Registered students after the search / grade / voucher / school year / term filters (the A-Z letter is applied afterwards). */
function mlBase() {
  const q = $("mlQ").value.trim().toLowerCase(), g = $("mlGrade").value, vt = $("mlVoucher").value, y = $("mlYear").value, t = $("mlTerm").value;
  return S.registry.filter((r) => {
    if ((g && r.gradeLevel !== g) || (vt && r.voucherType !== vt) || (q && ![r.studentNo, r.lrn, r.name].join(" ").toLowerCase().includes(q))) return false;
    const mine = S.enrollments.filter((e) => e.registryId === r.id);
    if (t) return mine.some((e) => e.term === t && (!y || e.schoolYear === y));          // enrolled in that quarter / term
    if (y) return r.schoolYear === y || mine.some((e) => e.schoolYear === y);            // registered or enrolled in that school year
    return true;
  });
}
const mlSorted = () => {
  const sort = $("mlSort").value, cmp = { az: (a, b) => a.name.localeCompare(b.name), za: (a, b) => b.name.localeCompare(a.name), no: (a, b) => String(a.studentNo).localeCompare(String(b.studentNo), undefined, { numeric: true }) }[sort];
  return mlBase().filter((r) => !mlLetter || lastInit(r) === mlLetter).sort(cmp);
};
function renderMaster() {
  const sort = $("mlSort").value, base = mlBase();
  const have = new Set(base.map(lastInit));
  $("mlLetters").innerHTML = `<button type="button" data-l="" class="${mlLetter ? "" : "on"}">All</button>` + "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c) => `<button type="button" data-l="${c}" class="${mlLetter === c ? "on" : ""}" ${have.has(c) ? "" : 'style="opacity:.35"'}>${c}</button>`).join("");
  const cmp = { az: (a, b) => a.name.localeCompare(b.name), za: (a, b) => b.name.localeCompare(a.name), no: (a, b) => String(a.studentNo).localeCompare(String(b.studentNo), undefined, { numeric: true }) }[sort];
  const rows = base.filter((r) => !mlLetter || lastInit(r) === mlLetter).sort(cmp), xf = colFields(), n = 14 + xf.length;
  $("mlCnt").textContent = `(${S.registry.length})`;
  $("mlCount").textContent = `${rows.length} of ${S.registry.length} registered students` + (rows.length > 12 ? " - scroll the list to see all" : "");
  $("mlTbl").innerHTML = "<tr><th>Student ID No.</th><th>LRN</th><th>Name</th><th>School year</th><th>Grade</th><th>Voucher</th><th>Birthdate</th><th>Age</th><th>Gender</th><th>Contact</th>" + xf.map((f) => `<th>${esc(f.label)}</th>`).join("") + "<th>Enrollment status</th><th>Requirements</th><th>Enrolled in</th><th></th></tr>" +
    (rows.slice(0, 3000).map((r) => { const e = latestEnrol(r);
      return `<tr><td>${esc(r.studentNo)}</td><td>${esc(r.lrn || "-")}</td><td>${esc(r.name)}</td><td>${esc(r.schoolYear || "-")}</td><td>${esc(r.gradeLevel || "")}</td><td>${esc(r.voucherType || "-")}</td><td>${esc(bd(r.birthday))}</td><td>${ageOf(r.birthday)}</td><td>${esc(r.gender || "")}</td><td>${esc(r.contact || "")}</td>
      ${xf.map((f) => `<td>${esc((r.extra || {})[f.id] ?? "")}</td>`).join("")}
      <td>${statusBadge(statusOf(r))}</td><td><span class="prog">${esc(reqText(r))}</span></td>
      <td>${e ? esc(e.sectionName) + `<small>${esc(e.term)} ${esc(e.schoolYear || "")}</small>` : '<span class="badge warn">Not enrolled</span>'}</td>
      <td class="actions"><button class="btn small" data-ed="${esc(r.id)}">Edit</button><button class="btn small" data-rq="${esc(r.id)}">Requirements</button><button class="btn small" data-en="${esc(r.id)}">Enroll</button><button class="btn small" data-hi="${esc(r.id)}">History</button><button class="btn small danger" data-rm="${esc(r.id)}">Delete</button></td></tr>`; }).join("") ||
      `<tr><td colspan="${n}">No students found.</td></tr>`);
}
$("mlLetters").onclick = (e) => { const b = e.target.closest("[data-l]"); if (b) { mlLetter = b.dataset.l; renderMaster(); } };
["mlQ", "mlGrade", "mlVoucher", "mlSort", "mlYear", "mlTerm"].forEach((i) => ($(i).oninput = renderMaster));
$("mlTbl").onclick = (e) => run(async () => {
  const b = e.target.closest("[data-ed],[data-en],[data-rm],[data-hi],[data-rq]"); if (!b) return;
  const r = S.registry.find((x) => x.id === (b.dataset.ed || b.dataset.en || b.dataset.rm || b.dataset.hi || b.dataset.rq)); if (!r) return;
  if (b.dataset.ed) return fillForm(r);
  if (b.dataset.rq) return openChecklist(r);
  if (b.dataset.hi) { show("history"); $("hiQ").value = `(${r.studentNo})`; renderHistory(); scrollTo({ top: 0 }); return; }
  if (b.dataset.en) { show("enroll", "enForm"); $("enQ").value = r.studentNo; renderEnrollPicker(r.id); return; }
  await deleteStudent(r);
});
/** Registrar deletes a student (registered or enrolled). A login account that was already created is deleted too. */
async function deleteStudent(r) {
  const acc = await hasAccount(r), gone = S.enrollments.filter((x) => x.registryId === r.id);
  if (!confirm(`Delete ${r.name} (${r.studentNo}) from the master list, with ${gone.length} enrollment record${gone.length === 1 ? "" : "s"}${acc ? " AND the student's login account" : ""}? This cannot be undone.`)) return;
  if (acc) await callFn("registrarDropStudentAccount", { registryId: r.id });
  for (const en of gone) await deleteDoc(doc(db, "enrollmentRecords", en.id));
  if (r.examNo) await deleteDoc(doc(db, "students", r.examNo)).catch(() => {});
  await deleteDoc(doc(db, "registry", r.id));
  await logEvent("Deleted student", "student", `${r.name} (${r.studentNo})`, [], `Also removed ${gone.length} enrollment record${gone.length === 1 ? "" : "s"}${acc ? " and the login account" : ""}`);
  await refresh(); flash(`${r.name} was deleted${acc ? ", including the login account" : ""}.`, true);
}
async function hasAccount(r) {
  if (!r.examNo) return false;
  try { const s = await getDoc(doc(db, "students", r.examNo)); return s.exists() && !!s.data().accountUid; } catch { return false; }
}
/* ---------- Excel export (whole master list, one section, or every section) ---------- */
const masterRow = (r) => ({ "Student ID No.": r.studentNo, LRN: r.lrn || "", "Voucher Type": r.voucherType || "", "Last Name": r.lastName, "First Name": r.firstName, "Middle Name": r.middleName || "", Suffix: r.suffix || "",
  Birthdate: r.birthday || "", Age: ageOf(r.birthday), Gender: r.gender || "", "Contact No.": r.contact || "", Address: r.address || "", "Father's Name": r.father || "", "Mother's Name": r.mother || "",
  "Guardian Name": r.guardianName || "", "Guardian Contact No.": r.guardianContact || "", "Guardian Address": r.guardianAddress || "", "Grade Level": r.gradeLevel || "", "Registered School Year": r.schoolYear || "", "Enrollment Status": statusOf(r), "School Requirements Submitted": reqText(r), ...Object.fromEntries(colFields().map((f) => [f.label, (r.extra || {})[f.id] ?? ""])) });
const slug = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
function saveXlsx(sheets, file) {
  if (!window.XLSX) return flash("The Excel writer did not load. Check your internet connection.");
  const wb = XLSX.utils.book_new(), used = new Set();
  sheets.forEach(({ name, rows, header }) => {
    const base = (String(name).replace(/[\[\]:*?\/\\]/g, "-").slice(0, 28).trim()) || "Sheet"; let n = base, k = 2;
    while (used.has(n.toLowerCase())) n = `${base} ${k++}`; used.add(n.toLowerCase());
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { header }), n);
  });
  XLSX.writeFile(wb, file);
}
$("mlXlsx").onclick = () => saveXlsx([{ name: "Master list", rows: S.registry.map(masterRow), header: Object.keys(masterRow({})) }], `master-list-${SID}.xlsx`);

/** One Excel file from a list of { r: student, e: enrollment or null }.
 *  mode "current": one sheet. "year": one sheet per school year. "term": one sheet per school year + quarter / term. */
const exportRow = (r, e, terms, years) => { e = e || {}; return { ...masterRow(r), "Learning Modality": e.modality || "", Section: e.sectionName || "", "Cluster / strand": e.strand || "", "Term / quarter": (terms || []).join(", "), "School year (enrolled)": (years || []).join(", "),
  Remark: e.remark || "", "Remark Date": e.remarkDate || "", "Remark Note": e.remarkNote || "", ...Object.fromEntries(S.fields.enroll.map((f) => [f.label, (e.extra || {})[f.id] ?? ""])) }; };
function exportPairs(pairs, mode, file, baseName) {
  const groups = new Map(), newer = (a, b) => !b || (a.schoolYear || "") > (b.schoolYear || "") || ((a.schoolYear || "") === (b.schoolYear || "") && termRank(a.term) > termRank(b.term));
  pairs.forEach(({ r, e }) => {
    const key = mode === "year" ? ((e ? e.schoolYear : r.schoolYear) || "No school year") : mode === "term" ? (e ? `${e.schoolYear || ""} ${e.term}`.trim() : "Not enrolled") : baseName;
    if (!groups.has(key)) groups.set(key, new Map());
    const g = groups.get(key), k = r.id + (mode === "term" && e ? "|" + e.id : ""), c = g.get(k);
    if (!c) g.set(k, { r, e, terms: new Set(e ? [e.term] : []), years: new Set(e && e.schoolYear ? [e.schoolYear] : []) });
    else if (e) { c.terms.add(e.term); if (e.schoolYear) c.years.add(e.schoolYear); if (newer(e, c.e)) c.e = e; }
  });
  const header = Object.keys(exportRow({}, null, [], []));
  const sheets = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((k) => ({ name: k, header,
    rows: [...groups.get(k).values()].sort((a, b) => String(a.r.name).localeCompare(b.r.name)).map((c) => exportRow(c.r, c.e, [...c.terms].sort((a, b) => termRank(a) - termRank(b)), [...c.years].sort())) }));
  if (!sheets.length || !sheets.some((s) => s.rows.length)) return flash("There are no students to download with these filters.");
  saveXlsx(sheets, file);
}
$("mlDl").onclick = () => {
  const y = $("mlYear").value, t = $("mlTerm").value, pairs = [];
  mlSorted().forEach((r) => { const ens = S.enrollments.filter((e) => e.registryId === r.id && (!y || e.schoolYear === y) && (!t || e.term === t)); if (ens.length) ens.forEach((e) => pairs.push({ r, e })); else pairs.push({ r, e: null }); });
  exportPairs(pairs, $("mlDlMode").value, `registration-masterlist-${y || "all-years"}-${SID}.xlsx`, "Registration masterlist");
};

/* ======================= MASTER LIST PER SECTION ======================= */
const NONE = "__none";
const yearsList = () => [...new Set([...S.enrollments.map((e) => e.schoolYear), ...S.registry.map((r) => r.schoolYear)].filter(Boolean))].sort().reverse();
const byGradeName = (a, b) => GRADES.indexOf(a.gradeLevel) - GRADES.indexOf(b.gradeLevel) || a.name.localeCompare(b.name);
let msSel = "", msInit = false;
const msF = () => ({ g: $("msGrade").value, y: $("msYear").value, t: $("msTerm").value });
/** The students of one section (or of nobody's section: NONE), after the grade / school year / term filters. */
function sectionRecords(id, f) {
  if (id === NONE) return S.registry.filter((r) => (!f.g || r.gradeLevel === f.g) && !S.enrollments.some((e) => e.registryId === r.id)).sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({ r }));
  return S.enrollments.filter((e) => e.sectionId === id && (!f.y || e.schoolYear === f.y) && (!f.t || e.term === f.t))
    .map((e) => ({ r: S.registry.find((x) => x.id === e.registryId), e })).filter((x) => x.r)
    .sort((a, b) => a.r.name.localeCompare(b.r.name) || (a.e.schoolYear || "").localeCompare(b.e.schoolYear || "") || termRank(a.e.term) - termRank(b.e.term));
}
const secLabel = (id) => (id === NONE ? "Not enrolled in any section" : (S.sections.find((s) => s.id === id) || {}).name || "Section");
const sectionRow = ({ r, e }, sec) => ({ ...masterRow(r), Section: sec ? sec.name : "", "Cluster / strand": sec ? sec.strand || "" : "", "Learning Modality": e ? e.modality || "" : "", Remark: e ? e.remark || "" : "", "Term / quarter": e ? e.term : "", "School year": e ? e.schoolYear || "" : "",
  ...Object.fromEntries(S.fields.enroll.map((f) => [f.label, e ? (e.extra || {})[f.id] ?? "" : ""])) });
const sectionSheet = (id) => { const sec = S.sections.find((s) => s.id === id); return { name: secLabel(id), rows: sectionRecords(id, msF()).map((x) => sectionRow(x, sec)), header: Object.keys(sectionRow({ r: {} }, sec)) }; };
function downloadSection(id) {
  const sh = sectionSheet(id); if (!sh.rows.length) return flash("There are no students to download for this section with the chosen filters.");
  saveXlsx([sh], `master-list-${slug(sh.name)}.xlsx`);
}
function downloadAllSections() {
  const f = msF(), ids = [...S.sections.filter((s) => !f.g || s.gradeLevel === f.g).sort(byGradeName).map((s) => s.id), NONE];
  const sheets = ids.map(sectionSheet).filter((s) => s.rows.length); if (!sheets.length) return flash("There are no enrolled students to download with the chosen filters.");
  saveXlsx(sheets, `master-list-per-section-${SID}.xlsx`);
}
function renderMasterSections() {
  if (!msInit) { msInit = true; const ys = yearsList(); $("msYear").value = ys.includes(schoolYearNow()) ? schoolYearNow() : ys[0] || ""; } // start on the current school year
  if (msSel && msSel !== NONE && !S.sections.some((s) => s.id === msSel)) msSel = "";
  $("msListBox").hidden = !!msSel; $("msDetail").hidden = !msSel;
  const f = msF();
  if (!msSel) {
    const list = S.sections.filter((s) => !f.g || s.gradeLevel === f.g).sort(byGradeName), none = sectionRecords(NONE, f).length;
    const row = (id, a, g, st, adv, n) => `<tr><td>${esc(a)}</td><td>${esc(g)}</td><td>${esc(st)}</td><td>${esc(adv)}</td><td>${n}</td><td class="actions"><button class="btn small" data-msv="${esc(id)}">View</button><button class="btn small primary" data-msd="${esc(id)}" ${n ? "" : "disabled"}>Download</button></td></tr>`;
    $("msTbl").innerHTML = "<tr><th>Section</th><th>Grade</th><th>Cluster / strand</th><th>Adviser</th><th>Students</th><th></th></tr>" +
      list.map((s) => row(s.id, s.sectionName || s.name, s.gradeLevel, s.strand || "-", s.adviserName || "-", sectionRecords(s.id, f).length)).join("") + row(NONE, "Not enrolled in any section", "-", "-", "-", none);
    return;
  }
  const sec = S.sections.find((s) => s.id === msSel), recs = sectionRecords(msSel, f), xf = colFields(), ef = S.fields.enroll;
  $("msHead").textContent = secLabel(msSel);
  $("msSub").textContent = `${recs.length} student${recs.length === 1 ? "" : "s"}` + (sec ? ` - adviser ${sec.adviserName || "-"}` : "") + (msSel === NONE ? "" : ` - ${f.y || "all school years"}, ${f.t || "all terms"}`);
  $("msDl").disabled = !recs.length;
  $("msView").innerHTML = "<tr><th>Student ID No.</th><th>LRN</th><th>Name</th><th>Grade</th><th>Voucher</th><th>Birthdate</th><th>Age</th><th>Gender</th><th>Contact</th>" + [...xf, ...ef].map((x) => `<th>${esc(x.label)}</th>`).join("") + "<th>Term / quarter</th><th>School year</th><th></th></tr>" +
    (recs.map(({ r, e }) => `<tr><td>${esc(r.studentNo)}</td><td>${esc(r.lrn || "-")}</td><td>${esc(r.name)}</td><td>${esc(r.gradeLevel || "")}</td><td>${esc(r.voucherType || "-")}</td><td>${esc(bd(r.birthday))}</td><td>${ageOf(r.birthday)}</td><td>${esc(r.gender || "")}</td><td>${esc(r.contact || "")}</td>` +
      xf.map((x) => `<td>${esc((r.extra || {})[x.id] ?? "")}</td>`).join("") + ef.map((x) => `<td>${esc(e ? (e.extra || {})[x.id] ?? "" : "")}</td>`).join("") + `<td>${esc(e ? e.term : "-")}</td><td>${esc(e ? e.schoolYear || "" : "-")}</td><td class="actions"><button class="btn small" data-ed="${esc(r.id)}">Edit</button></td></tr>`).join("") ||
      `<tr><td colspan="${12 + xf.length + ef.length}">No students found for this section with the chosen filters.</td></tr>`);
}
["msGrade", "msYear", "msTerm"].forEach((i) => ($(i).onchange = renderMasterSections));
$("msTbl").onclick = (e) => {
  const v = e.target.closest("[data-msv]"), d = e.target.closest("[data-msd]");
  if (v) { msSel = v.dataset.msv; renderMasterSections(); scrollTo({ top: 0, behavior: "smooth" }); } else if (d) downloadSection(d.dataset.msd);
};
$("msBack").onclick = () => { msSel = ""; renderMasterSections(); };
$("msDl").onclick = () => downloadSection(msSel);
$("msDlAll").onclick = downloadAllSections;
$("msView").onclick = (e) => { const b = e.target.closest("[data-ed]"); const r = b && S.registry.find((x) => x.id === b.dataset.ed); if (r) fillForm(r); };

/* ======================= DASHBOARD (based on the registration masterlist) ======================= */
const NOGRADE = "No grade level", NOSTRAND = "- none / not applicable -";
let dsInit = false, elInit = false;
const yearChoices = () => [...new Set([schoolYearNow(), ...yearsList()])].sort().reverse();
const pc = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + "%" : "-");
const bar = (a, b) => `<span class="bar"><i style="width:${b ? Math.min(100, Math.round((a / b) * 100)) : 0}%"></i></span>`;
const isM = (x) => x.r.gender === "Male", isF = (x) => x.r.gender === "Female";
const hdr = (cols) => "<tr>" + cols.map((c) => `<th>${c}</th>`).join("") + "</tr>";
const rowHtml = (cells, cls) => `<tr${cls ? ` class="${cls}"` : ""}>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
const emptyRow = (n, t) => `<tr><td colspan="${n}">${t}</td></tr>`;
/** Everyone on the registration masterlist, with the newest enrollment inside the chosen school year / term (if any). */
function dashScope() {
  const y = $("dsYear").value, t = $("dsTermSel").value, latest = new Map(), regMap = new Map(S.registry.map((r) => [r.id, r]));
  const ens = S.enrollments.filter((e) => !e.remark && (!y || e.schoolYear === y) && (!t || e.term === t) && regMap.has(e.registryId)); // Transferred Out / Drop Out / Cancelled Enrolled are not counted
  [...ens].sort((a, b) => termRank(b.term) - termRank(a.term) || tsec(b) - tsec(a)).forEach((e) => { if (!latest.has(e.registryId)) latest.set(e.registryId, e); });
  const rows = S.registry.map((r) => { const e = latest.get(r.id) || null; return { r, e, grade: (e && e.gradeLevel) || r.gradeLevel || NOGRADE }; });
  return { y, t, ens, regMap, rows, enrolled: rows.filter((x) => x.e) };
}
const gs0 = (list) => [...GRADES, NOGRADE].filter((g) => list.some((x) => x.grade === g));
function genderTable(list) {
  const gs = [...GRADES, NOGRADE].filter((g) => list.some((x) => x.grade === g));
  const line = (label, a, cls) => rowHtml([esc(label), a.filter(isM).length, a.filter(isF).length, a.length], cls);
  return hdr(["Grade level", "Male", "Female", "Total"]) + (gs.length ? gs.map((g) => line(g, list.filter((x) => x.grade === g))).join("") + line("All grade levels", list, "tot") : emptyRow(4, "No students."));
}
function renderDash() {
  if (!dsInit) { dsInit = true; $("dsYear").value = schoolYearNow(); }
  const { y, t, ens, regMap, rows, enrolled } = dashScope(), notEn = rows.length - enrolled.length;
  $("dsCtx").textContent = `Showing: school year ${y || "all"}, ${t || "all terms / quarters"}.`;
  $("dsCards").innerHTML = [["Registered students", rows.length], ["Requirements complete", rows.filter((x) => reqDone(x.r)).length, "good"], ["Requirements incomplete", rows.filter((x) => !reqDone(x.r)).length, "warn"], ["Total enrolled", enrolled.length], ["Total not enrolled", notEn, "warn"], ["Enrollment rate", pc(enrolled.length, rows.length)],
    ["Transferred out / dropped out / cancelled", new Set(S.enrollments.filter((e) => e.remark && (!y || e.schoolYear === y) && (!t || e.term === t) && regMap.has(e.registryId)).map((e) => e.registryId)).size, "warn"],
    ["Enrolled - male", enrolled.filter(isM).length], ["Enrolled - female", enrolled.filter(isF).length]].map(([l, v, c]) => `<div class="stat ${c || ""}"><b>${v}</b><span>${l}</span></div>`).join("");
  // per enrollment status (set by the registrar)
  const stc = new Map(STATUSES.map((k) => [k, 0])); rows.forEach((x) => stc.set(statusOf(x.r), (stc.get(statusOf(x.r)) || 0) + 1));
  $("dsStatus").innerHTML = hdr(["Enrollment status", "Students", "% of registered"]) + (rows.length ? [...stc.entries()].filter(([, n]) => n).map(([k, n]) => rowHtml([statusBadge(k), n, `${pc(n, rows.length)} ${bar(n, rows.length)}`])).join("") + rowHtml(["All students", rows.length, ""], "tot") : emptyRow(3, "No registered students yet."));
  // school requirements per grade level
  const rg = (g, a, cls) => { const c = a.filter((x) => reqDone(x.r)).length; return rowHtml([esc(g), a.length, c, a.length - c, `${pc(c, a.length)} ${bar(c, a.length)}`], cls); };
  $("dsReq").innerHTML = hdr(["Grade level", "Registered", "Complete", "Incomplete", "% complete"]) + (gs0(rows).length ? gs0(rows).map((g) => rg(g, rows.filter((x) => x.grade === g))).join("") + rg("All grade levels", rows, "tot") : emptyRow(5, "No registered students yet."));
  // per grade level
  const gs = [...GRADES, NOGRADE].filter((g) => rows.some((x) => x.grade === g));
  const gl = (g, a, cls) => { const n = a.filter((x) => x.e).length; return rowHtml([esc(g), a.length, n, a.length - n, `${pc(n, a.length)} ${bar(n, a.length)}`], cls); };
  $("dsGrade").innerHTML = hdr(["Grade level", "Registered", "Enrolled", "Not enrolled", "% enrolled"]) + (gs.length ? gs.map((g) => gl(g, rows.filter((x) => x.grade === g))).join("") + gl("All grade levels", rows, "tot") : emptyRow(5, "No registered students yet."));
  // enrolled per cluster / strand
  const sm = new Map(); enrolled.forEach((x) => { const k = x.e.strand || NOSTRAND; if (!sm.has(k)) sm.set(k, []); sm.get(k).push(x); });
  const order = [...S.strands, ...[...sm.keys()].filter((k) => !S.strands.includes(k) && k !== NOSTRAND), NOSTRAND].filter((k) => sm.has(k));
  const sl = (k, a, cls) => rowHtml([esc(k), a.length, a.filter(isM).length, a.filter(isF).length], cls);
  $("dsStrand").innerHTML = hdr(["Cluster / strand", "Enrolled", "Male", "Female"]) + (order.length ? order.map((k) => sl(k, sm.get(k))).join("") + sl("All clusters / strands", enrolled, "tot") : emptyRow(4, "Nobody is enrolled for this selection."));
  // per term / quarter (always for the chosen school year)
  $("dsTermTbl").innerHTML = hdr(["Term / quarter", "Enrolled", "Not enrolled", "% enrolled"]) + TERMS.map((tm) => {
    const n = new Set(S.enrollments.filter((e) => !e.remark && (!y || e.schoolYear === y) && e.term === tm && regMap.has(e.registryId)).map((e) => e.registryId)).size;
    return rowHtml([esc(tm), n, S.registry.length - n, `${pc(n, S.registry.length)} ${bar(n, S.registry.length)}`]);
  }).join("");
  // per learning modality
  const mm = new Map(); enrolled.forEach((x) => { const k = x.e.modality || "Not set"; if (!mm.has(k)) mm.set(k, []); mm.get(k).push(x); });
  const mOrder = [...MODALITIES, "Not set"].filter((k) => mm.has(k)), ml = (k, a, cls) => rowHtml([esc(k), a.length, a.filter(isM).length, a.filter(isF).length], cls);
  $("dsModality").innerHTML = hdr(["Learning modality", "Enrolled", "Male", "Female"]) + (mOrder.length ? mOrder.map((k) => ml(k, mm.get(k))).join("") + ml("All modalities", enrolled, "tot") : emptyRow(4, "Nobody is enrolled for this selection."));
  // male / female
  $("dsGenReg").innerHTML = genderTable(rows); $("dsGenEn").innerHTML = genderTable(enrolled);
  const secMap = new Map(); ens.forEach((e) => { if (!secMap.has(e.sectionId)) secMap.set(e.sectionId, new Map()); secMap.get(e.sectionId).set(e.registryId, { r: regMap.get(e.registryId) }); });
  const secs = S.sections.filter((s) => secMap.has(s.id)).sort(byGradeName);
  const all = secs.flatMap((s) => [...secMap.get(s.id).values()]);
  $("dsGenSec").innerHTML = hdr(["Section", "Grade", "Cluster / strand", "Adviser", "Male", "Female", "Total"]) + (secs.length ? secs.map((s) => { const a = [...secMap.get(s.id).values()];
    return rowHtml([esc(s.sectionName || s.name), esc(s.gradeLevel), esc(s.strand || "-"), esc(s.adviserName || "-"), a.filter(isM).length, a.filter(isF).length, a.length]); }).join("") +
    rowHtml(["All sections", "", "", "", all.filter(isM).length, all.filter(isF).length, all.length], "tot") : emptyRow(7, "No enrolled students in any section for this selection."));
}
["dsYear", "dsTermSel"].forEach((i) => ($(i).onchange = renderDash));

/* ======================= ENROLLED MASTERLIST (separate from the registration masterlist) ======================= */
/** Every enrollment record that passes the filters, joined to its student. */
function enrolledPairs() {
  const q = $("elQ").value.trim().toLowerCase(), y = $("elYear").value, t = $("elTerm").value, g = $("elGrade").value, st = $("elStrand").value, sc = $("elSection").value, v = $("elVoucher").value, md = $("elModality").value, rm = $("elRemark").value;
  const regMap = new Map(S.registry.map((r) => [r.id, r])), out = [];
  S.enrollments.forEach((e) => {
    if ((y && e.schoolYear !== y) || (t && e.term !== t) || (g && e.gradeLevel !== g) || (st && (e.strand || "") !== st) || (sc && e.sectionId !== sc) || (md && (e.modality || "") !== md)) return;
    if (rm === "__none" ? e.remark : rm && e.remark !== rm) return;
    const r = regMap.get(e.registryId); if (!r || (v && (r.voucherType || "") !== v) || (q && ![r.studentNo, r.lrn, r.name].join(" ").toLowerCase().includes(q))) return;
    out.push({ r, e });
  });
  return out;
}
function enrolledRecords() {
  const sort = $("elSort").value, by = new Map();
  enrolledPairs().forEach(({ r, e }) => {
    const cur = by.get(r.id);
    if (!cur) by.set(r.id, { r, e, terms: new Set([e.term]), years: new Set([e.schoolYear || ""]) });
    else { cur.terms.add(e.term); cur.years.add(e.schoolYear || "");
      if ((e.schoolYear || "") > (cur.e.schoolYear || "") || ((e.schoolYear || "") === (cur.e.schoolYear || "") && termRank(e.term) > termRank(cur.e.term))) cur.e = e; }
  });
  const cmp = { az: (a, b) => a.r.name.localeCompare(b.r.name), za: (a, b) => b.r.name.localeCompare(a.r.name), no: (a, b) => String(a.r.studentNo).localeCompare(String(b.r.studentNo), undefined, { numeric: true }) }[sort];
  return [...by.values()].map((x) => ({ ...x, terms: [...x.terms].sort((a, b) => termRank(a) - termRank(b)), years: [...x.years].filter(Boolean).sort() })).sort(cmp);
}
function renderEnList() {
  if (!elInit) { elInit = true; $("elYear").value = schoolYearNow(); }
  const rows = enrolledRecords(), xf = colFields(), ef = S.fields.enroll, n = 15 + xf.length + ef.length;
  $("elCnt").textContent = `(${new Set(S.enrollments.filter((e) => !e.remark).map((e) => e.registryId)).size})`;
  $("elCount").textContent = `${rows.length} enrolled student${rows.length === 1 ? "" : "s"} - ${rows.filter(isM).length} male, ${rows.filter(isF).length} female` + (rows.length > 12 ? " - scroll the list to see all" : "");
  $("elTbl").innerHTML = "<tr><th>Student ID No.</th><th>LRN</th><th>Name</th><th>Grade</th><th>Cluster / strand</th><th>Section</th><th>Learning modality</th><th>Term / quarter</th><th>School year</th><th>Voucher</th><th>Gender</th><th>Birthdate</th><th>Age</th><th>Enrollment status</th><th>Remark</th>" +
    [...xf, ...ef].map((f) => `<th>${esc(f.label)}</th>`).join("") + "<th></th></tr>" +
    (rows.slice(0, 3000).map(({ r, e, terms, years }) => `<tr><td>${esc(r.studentNo)}</td><td>${esc(r.lrn || "-")}</td><td>${esc(r.name)}</td><td>${esc(e.gradeLevel || r.gradeLevel || "")}</td><td>${esc(e.strand || "-")}</td><td>${esc(e.sectionName || "")}</td><td>${esc(e.modality || "-")}</td>` +
      `<td>${esc(terms.join(", "))}</td><td>${esc(years.join(", "))}</td><td>${esc(r.voucherType || "-")}</td><td>${esc(r.gender || "")}</td><td>${esc(bd(r.birthday))}</td><td>${ageOf(r.birthday)}</td><td>${statusBadge(statusOf(r))}</td>` +
      `<td>${e.remark ? `<span class="badge warn">${esc(e.remark)}</span>${e.remarkDate ? `<small>${esc(bd(e.remarkDate))}</small>` : ""}` : "-"}</td>` +
      xf.map((f) => `<td>${esc((r.extra || {})[f.id] ?? "")}</td>`).join("") + ef.map((f) => `<td>${esc((e.extra || {})[f.id] ?? "")}</td>`).join("") +
      `<td class="actions"><button class="btn small" data-ed="${esc(r.id)}">Edit</button><button class="btn small" data-rk="${esc(r.id)}">Remark</button><button class="btn small" data-hi="${esc(r.id)}">History</button><button class="btn small danger" data-rm="${esc(r.id)}">Delete</button></td></tr>`).join("") || emptyRow(n, "No enrolled students found."));
}
["elQ", "elYear", "elTerm", "elGrade", "elStrand", "elSection", "elVoucher", "elSort", "elModality", "elRemark"].forEach((i) => ($(i).oninput = renderEnList));
$("elTbl").onclick = (e) => run(async () => {
  const b = e.target.closest("[data-ed],[data-hi],[data-rk],[data-rm]"); if (!b) return;
  const r = S.registry.find((x) => x.id === (b.dataset.ed || b.dataset.hi || b.dataset.rk || b.dataset.rm)); if (!r) return;
  if (b.dataset.ed) return fillForm(r);
  if (b.dataset.rk) return openRemark(r);
  if (b.dataset.rm) return deleteStudent(r);
  show("history"); $("hiQ").value = `(${r.studentNo})`; renderHistory(); scrollTo({ top: 0 });
});
$("elXlsx").onclick = () => {
  const pairs = enrolledPairs(); if (!pairs.length) return flash("There are no enrolled students to download with these filters.");
  exportPairs(pairs, $("elDlMode").value, `enrolled-masterlist-${$("elYear").value || "all-years"}-${SID}.xlsx`, "Enrolled masterlist");
};

/* ---------- remark (Transferred Out / Drop Out / Cancelled Enrolled) ---------- */
let rmTarget = null;
async function openRemark(r) {
  const mine = S.enrollments.filter((e) => e.registryId === r.id); if (!mine.length) return flash("This student has no enrollment record to put a remark on.");
  const year = [...mine].sort((a, b) => (b.schoolYear || "").localeCompare(a.schoolYear || "") || termRank(b.term) - termRank(a.term))[0].schoolYear || "";
  const recs = mine.filter((e) => (e.schoolYear || "") === year), cur = recs.find((e) => e.remark) || {}, acc = await hasAccount(r);
  rmTarget = { r, year, recs, acc };
  $("rmInfo").innerHTML = [["Student", r.name], ["Student ID No.", r.studentNo], ["School year", year || "-"], ["Enrolled in", [...new Set(recs.map((e) => e.sectionName))].join(", ")], ["Current remark", cur.remark || "- none -"]].map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("");
  $("rmSel").value = cur.remark || REMARKS[0]; $("rmDate").value = cur.remarkDate || localDate(); $("rmNote").value = cur.remarkNote || "";
  $("rmDrop").checked = acc; $("rmDrop").disabled = !acc;
  $("rmAcc").textContent = acc ? "This student already has a login account." : "This student has no login account, so there is nothing to delete.";
  $("rmNone").hidden = true; $("rmBox").hidden = false; show("enrolled", "elRemark"); scrollTo({ top: 0, behavior: "smooth" });
}
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
$("rmCancel").onclick = () => { rmTarget = null; $("rmBox").hidden = true; $("rmNone").hidden = false; show("enrolled", "elList"); };
$("rmSave").onclick = () => run(async () => {
  const t = rmTarget; if (!t) return flash("Choose a student first (Remark button in the enrolled list).");
  const remark = $("rmSel").value, note = $("rmNote").value.trim(), date = $("rmDate").value || localDate(), dropAcc = remark && t.acc && $("rmDrop").checked;
  if (remark && !confirm(`Set "${remark}" for ${t.r.name} (${t.year})?${dropAcc ? "\n\nThe student's login account will be DELETED." : ""}`)) return;
  if (dropAcc) await callFn("registrarDropStudentAccount", { registryId: t.r.id });
  const patchRec = remark ? { remark, remarkDate: date, remarkNote: note, remarkBy: profile.displayName || "", updatedAt: serverTimestamp() } : { remark: deleteField(), remarkDate: deleteField(), remarkNote: deleteField(), remarkBy: deleteField(), updatedAt: serverTimestamp() };
  for (const e of t.recs) await updateDoc(doc(db, "enrollmentRecords", e.id), patchRec);
  await updateDoc(doc(db, "registry", t.r.id), { enrollStatus: remark || "Enrolled", enrollStatusDate: remark ? date : localDate(), enrollStatusNote: remark ? note : "", enrollStatusBy: profile.displayName || "", updatedAt: serverTimestamp() });
  await logEvent(remark ? "Set remark" : "Cleared remark", "enrollment", `${t.r.name} (${t.r.studentNo})`, [{ f: "Remark", from: (t.recs.find((e) => e.remark) || {}).remark || "", to: remark }], `${t.year}${note ? " - " + note : ""}${dropAcc ? " - login account deleted" : ""}`);
  rmTarget = null; $("rmBox").hidden = true; $("rmNone").hidden = false; await refresh(); show("enrolled", "elList");
  flash(remark ? `${t.r.name}: ${remark}.${dropAcc ? " The login account was deleted." : ""}` : `The remark of ${t.r.name} was cleared.`, true);
});

/* ======================= HISTORY LOG ======================= */
const ACTIONS = ["Registered student", "Edited student", "Deleted student", "Set remark", "Cleared remark", "Enrolled student", "Removed from section", "Added section", "Changed adviser", "Deleted section", "Imported list", "Updated requirements", "Changed enrollment status", "Changed settings"];
const atsec = (l) => l?.at?.seconds || 0;
const whenOf = (l) => (atsec(l) ? new Date(atsec(l) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "just now");
S.log = []; S.logLoaded = false;
async function loadHistory() {
  $("hiNote").hidden = true;
  try { S.log = (await bySchool("registrarLog")).sort((a, b) => atsec(b) - atsec(a)); S.logLoaded = true; }
  catch (e) { console.error(e); $("hiNote").textContent = "The history could not be loaded. Press Refresh. " + friendlyError(e); $("hiNote").hidden = false; }
  keep("hiAct", options(ACTIONS, "All actions")); keep("hiWho", options([...new Set(S.log.map((l) => l.byName).filter(Boolean))].sort(), "All people"));
  renderHistory();
}
function historyRows() {
  const q = $("hiQ").value.trim().toLowerCase(), a = $("hiAct").value, w = $("hiWho").value;
  const from = $("hiFrom").value ? new Date($("hiFrom").value + "T00:00").getTime() / 1000 : 0, to = $("hiTo").value ? new Date($("hiTo").value + "T23:59:59").getTime() / 1000 : Infinity;
  return S.log.filter((l) => (!a || l.action === a) && (!w || l.byName === w) && (!atsec(l) || (atsec(l) >= from && atsec(l) <= to)) &&
    (!q || [l.byName, l.byNo, l.action, l.label, l.note, ...(l.changes || []).map((c) => `${c.f} ${c.from} ${c.to}`), ...(l.items || [])].join(" ").toLowerCase().includes(q)));
}
function renderHistory() {
  const rows = historyRows(), shown = rows.slice(0, 300);
  $("hiCount").textContent = `${rows.length} of ${S.log.length} entr${S.log.length === 1 ? "y" : "ies"}` + (rows.length > shown.length ? ` - showing the latest ${shown.length}; narrow the filters or download the Excel file for all` : "");
  const detail = (l) => (l.changes || []).map((c) => `<div><b>${esc(c.f)}:</b> <span class="old">${esc(c.from || "(blank)")}</span> &rarr; <span class="new">${esc(c.to || "(blank)")}</span></div>`).join("") + (l.note ? `<div>${esc(l.note)}</div>` : "") +
    ((l.items || []).length ? `<details><summary>${l.items.length} record${l.items.length === 1 ? "" : "s"}</summary>${l.items.map((i) => `<div>${esc(i)}</div>`).join("")}</details>` : "");
  $("hiTbl").innerHTML = "<tr><th>When</th><th>Done by</th><th>Action</th><th>Record</th><th>What changed</th></tr>" +
    (shown.map((l) => `<tr><td>${esc(whenOf(l))}</td><td>${esc(l.byName || "-")}${l.byNo ? `<small>Employee No. ${esc(l.byNo)}</small>` : ""}</td><td><span class="badge act ${/Deleted|Removed/.test(l.action) ? "del" : ""}">${esc(l.action)}</span></td><td>${esc(l.label || "-")}</td><td class="wrapcell hist-detail">${detail(l) || "-"}</td></tr>`).join("") ||
      `<tr><td colspan="5">${S.log.length ? "No entries match the filters." : "Nothing recorded yet. New changes will appear here."}</td></tr>`);
}
["hiQ", "hiAct", "hiWho", "hiFrom", "hiTo"].forEach((i) => ($(i).oninput = renderHistory));
$("hiRefresh").onclick = () => run(loadHistory);
$("hiClear").onclick = () => { ["hiQ", "hiAct", "hiWho", "hiFrom", "hiTo"].forEach((i) => ($(i).value = "")); renderHistory(); };
$("hiXlsx").onclick = () => {
  const rows = historyRows().flatMap((l) => { const base = { When: whenOf(l), "Done by": l.byName || "", "Employee No.": l.byNo || "", Action: l.action, Record: l.label || "" };
    const ch = l.changes || []; if (!ch.length) return [{ ...base, Field: "", From: "", To: "", Note: [l.note, ...(l.items || [])].filter(Boolean).join("; ") }];
    return ch.map((c) => ({ ...base, Field: c.f, From: c.from, To: c.to, Note: l.note || "" })); });
  if (!rows.length) return flash("There are no history entries to download with these filters.");
  saveXlsx([{ name: "History", rows, header: ["When", "Done by", "Employee No.", "Action", "Record", "Field", "From", "To", "Note"] }], `history-${SID}.xlsx`);
};

/* ======================= SETTINGS ======================= */
function renderVoucherStrand() {
  const tag = (kind, v) => `<span class="tag">${esc(v)}<button type="button" data-kind="${kind}" data-v="${esc(v)}" aria-label="Remove ${esc(v)}">&times;</button></span>`;
  $("vtList").innerHTML = S.vouchers.map((v) => tag("v", v)).join("") || '<span class="muted">None yet.</span>';
  $("stList").innerHTML = S.strands.map((v) => tag("s", v)).join("") || '<span class="muted">None yet.</span>';
}
const addTo = (arr, val) => { val = val.trim(); if (!val) return false; if (arr.some((x) => x.toLowerCase() === val.toLowerCase())) return false; arr.push(val); return true; };
$("vtAdd").onclick = () => run(async () => { const v = $("vtNew").value.toUpperCase().trim(); if (!addTo(S.vouchers, v)) return flash("Enter a new voucher type."); $("vtNew").value = ""; await saveSettings(); await logEvent("Changed settings", "settings", "Voucher types", [{ f: "Voucher type", from: "", to: v }], "Added"); render(); flash("Voucher type added.", 1); });
$("stAdd").onclick = () => run(async () => { const v = $("stNew").value.trim(); if (!addTo(S.strands, v)) return flash("Enter a new cluster / strand."); $("stNew").value = ""; await saveSettings(); await logEvent("Changed settings", "settings", "Clusters / strands", [{ f: "Cluster / strand", from: "", to: v }], "Added"); render(); flash("Cluster / strand added.", 1); });
document.querySelector('[data-s="settings"]').onclick = (e) => run(async () => {
  const b = e.target.closest("button[data-kind]"); if (!b) return;
  const arr = b.dataset.kind === "v" ? S.vouchers : S.strands, i = arr.indexOf(b.dataset.v); if (i < 0) return;
  if (!confirm(`Remove "${b.dataset.v}" from the list? Students already saved with it keep it.`)) return;
  arr.splice(i, 1); await saveSettings(); await logEvent("Changed settings", "settings", b.dataset.kind === "v" ? "Voucher types" : "Clusters / strands", [{ f: b.dataset.kind === "v" ? "Voucher type" : "Cluster / strand", from: b.dataset.v, to: "" }], "Removed"); render();
});

/* ======================= SECTIONS & ADVISERS ======================= */
const teacherOf = (uid) => S.teachers.find((t) => t.uid === uid);
const secName = (g, st, n) => [g, st, n].filter(Boolean).join(" - ");
const studentsIn = (sec) => new Set(S.enrollments.filter((e) => e.sectionId === sec.id).map((e) => e.registryId)).size;
$("scAdd").onclick = () => run(async () => {
  const grade = $("scGrade").value, strand = $("scStrand").value, sn = $("scName").value.trim(), adv = teacherOf($("scAdv").value);
  if (!sn) return flash("Enter the section name."); if (!adv) return flash("Choose the adviser from the teacher accounts.");
  const name = secName(grade, strand, sn);
  if (S.sections.some((s) => s.name.toLowerCase() === name.toLowerCase())) return flash("That section already exists.");
  await setDoc(doc(collection(db, "classes")), { ownerUid: adv.uid, schoolId: SID, name, gradeLevel: grade, strand, sectionName: sn, adviserName: adv.displayName, code: "", createdBy: user.uid, createdAt: serverTimestamp() });
  await logEvent("Added section", "section", name, [], `Adviser: ${adv.displayName}`);
  $("scName").value = ""; await refresh(); flash(`Section added. Adviser: ${adv.displayName}.`, 1);
});
function renderSections() {
  const f = $("scFilter").value, list = S.sections.filter((s) => !f || s.gradeLevel === f);
  $("scCnt").textContent = `(${S.sections.length})`;
  $("scTbl").innerHTML = "<tr><th>Section</th><th>Grade</th><th>Cluster / strand</th><th>Adviser</th><th>Students</th><th></th></tr>" +
    (list.map((s) => `<tr><td>${esc(s.sectionName || s.name)}</td><td>${esc(s.gradeLevel)}</td><td>${esc(s.strand || "-")}</td>
      <td><select data-adv="${esc(s.id)}" aria-label="Adviser of ${esc(s.name)}">${S.teachers.some((t) => t.uid === s.ownerUid) ? "" : `<option value="${esc(s.ownerUid)}" selected>${esc(s.adviserName || "(unknown)")}</option>`}${S.teachers.map((t) => `<option value="${esc(t.uid)}" ${t.uid === s.ownerUid ? "selected" : ""}>${esc(t.displayName)}</option>`).join("")}</select></td>
      <td>${studentsIn(s)}</td><td class="actions"><button class="btn small" data-view="${esc(s.id)}">View students</button><button class="btn small" data-dl="${esc(s.id)}" ${studentsIn(s) ? "" : "disabled"}>Download</button><button class="btn small danger" data-del="${esc(s.id)}">Delete</button></td></tr>`).join("") || `<tr><td colspan="6">No sections yet.</td></tr>`);
}
$("scFilter").onchange = renderSections;
let viewSec = "";
function renderSectionView() {
  keep("scViewSel", `<option value="">Choose a section</option>` + [...S.sections].sort(byGradeName).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join(""));
  if (viewSec && !S.sections.some((x) => x.id === viewSec)) viewSec = "";
  $("scViewSel").value = viewSec;
  const s = S.sections.find((x) => x.id === viewSec);
  $("scViewHead").textContent = s ? `${s.name} - adviser ${s.adviserName || ""}` : "Section students";
  if (!s) { $("scView").innerHTML = "<tr><td>Choose a section to see its students.</td></tr>"; return; }
  const list = S.enrollments.filter((e) => e.sectionId === s.id).sort((a, b) => a.name.localeCompare(b.name));
  $("scView").innerHTML = "<tr><th>Student ID No.</th><th>LRN</th><th>Name</th><th>Term / quarter</th><th>School year</th><th></th></tr>" +
    (list.map((e) => `<tr><td>${esc(e.studentNo)}</td><td>${esc(e.lrn || "-")}</td><td>${esc(e.name)}</td><td>${esc(e.term)}</td><td>${esc(e.schoolYear || "")}</td><td class="actions"><button class="btn small danger" data-unen="${esc(e.id)}">Remove</button></td></tr>`).join("") || `<tr><td colspan="6">No students enrolled yet.</td></tr>`);
}
$("scViewSel").onchange = () => { viewSec = $("scViewSel").value; renderSectionView(); };
$("scTbl").onchange = (e) => run(async () => {
  const sel = e.target.closest("[data-adv]"); if (!sel) return;
  const s = S.sections.find((x) => x.id === sel.dataset.adv), t = teacherOf(sel.value); if (!s || !t || t.uid === s.ownerUid) return;
  if (!confirm(`Make ${t.displayName} the adviser of ${s.name}? The students of this section move to ${t.displayName}'s Teacher page, and the section's classroom code is cleared (the new adviser creates a new one).`)) { sel.value = s.ownerUid; return; }
  if (s.code) await deleteDoc(doc(db, "classCodes", s.code)).catch(() => {});
  const studs = (await getDocs(query(collection(db, "students"), where("schoolId", "==", SID), where("classId", "==", s.id)))).docs;
  const first = writeBatch(db); first.update(doc(db, "classes", s.id), { ownerUid: t.uid, adviserName: t.displayName, code: "", updatedAt: serverTimestamp() });
  await first.commit();
  for (let i = 0; i < studs.length; i += 400) { const b = writeBatch(db); studs.slice(i, i + 400).forEach((d) => b.update(d.ref, { ownerUid: t.uid, updatedAt: serverTimestamp() })); await b.commit(); }
  await logEvent("Changed adviser", "section", s.name, [{ f: "Adviser", from: s.adviserName || "", to: t.displayName }], `${studs.length} student${studs.length === 1 ? "" : "s"} moved`);
  await refresh(); flash(`${t.displayName} is now the adviser of ${s.name} (${studs.length} student${studs.length === 1 ? "" : "s"} moved).`, 1);
});
$("scTbl").onclick = (e) => run(async () => {
  const v = e.target.closest("[data-view]"); if (v) { viewSec = v.dataset.view; renderSectionView(); showSub("sections", "scViewBox"); scrollTo({ top: 0, behavior: "smooth" }); return; }
  const dl = e.target.closest("[data-dl]"); if (dl) { msSel = ""; const f = { g: "", y: "", t: "" }, sec = S.sections.find((x) => x.id === dl.dataset.dl); if (!sec) return;
    const sh = { name: sec.name, rows: sectionRecords(sec.id, f).map((x) => sectionRow(x, sec)), header: Object.keys(sectionRow({ r: {} }, sec)) }; return saveXlsx([sh], `master-list-${slug(sec.name)}.xlsx`); }
  const d = e.target.closest("[data-del]"); if (!d) return;
  const s = S.sections.find((x) => x.id === d.dataset.del); if (!s) return;
  if (studentsIn(s)) return flash("This section still has enrolled students. Remove or move them first.");
  if (!confirm(`Delete the section ${s.name}?`)) return;
  if (s.code) await deleteDoc(doc(db, "classCodes", s.code)).catch(() => {});
  await deleteDoc(doc(db, "classes", s.id)); await logEvent("Deleted section", "section", s.name, [], `Adviser: ${s.adviserName || "-"}`); if (viewSec === s.id) viewSec = ""; await refresh(); flash("Section deleted.", 1);
});
$("scView").onclick = (e) => run(async () => { const b = e.target.closest("[data-unen]"); if (b) await unenroll(b.dataset.unen); });

/* ======================= ENROLLMENT ======================= */
let picked = "";
function renderEnrollPicker(select) {
  const q = $("enQ").value.trim().toLowerCase();
  const rows = S.registry.filter((r) => !q || [r.studentNo, r.lrn, r.name].join(" ").toLowerCase().includes(q)).slice(0, 60);
  keep("enStu", rows.map((r) => `<option value="${esc(r.id)}">${esc(r.studentNo)} - ${esc(r.name)}${r.lrn ? " (LRN " + esc(r.lrn) + ")" : ""}</option>`).join("") || `<option value="">No registered student found</option>`);
  if (select && rows.some((r) => r.id === select)) $("enStu").value = select;
  const r = S.registry.find((x) => x.id === $("enStu").value);
  if (r && r.id !== picked) { picked = r.id; if (r.gradeLevel) $("enGrade").value = r.gradeLevel; if (r.schoolYear) $("enYear").value = r.schoolYear; }
  const examNo = r ? (r.examNo || r.lrn || r.studentNo) : "";
  $("enInfo").hidden = !r;
  if (r) $("enInfo").innerHTML = [["Name", r.name], ["Student ID No.", r.studentNo], ["School year", r.schoolYear || "-"], ["LRN", r.lrn || "- (none yet)"], ["Birthdate", bd(r.birthday)], ["Age", ageOf(r.birthday)], ["Gender", r.gender || "-"], ["Voucher", r.voucherType || "-"],
    ["Exam ID No. (login)", examNo + (r.lrn || r.examNo ? "" : " (Student ID, until an LRN is available)")]].map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("");
  const g = $("enGrade").value, st = $("enStrand").value, secs = S.sections.filter((s) => s.gradeLevel === g && (s.strand || "") === st);
  keep("enSection", secs.map((s) => `<option value="${esc(s.id)}">${esc(s.sectionName || s.name)} - ${esc(s.adviserName || "")}</option>`).join("") || `<option value="">No section for this grade / strand</option>`);
  $("enSecHint").textContent = secs.length ? "" : "Add the section first under Sections & advisers.";
  renderEnrolled();
}
$("enQ").oninput = () => renderEnrollPicker();
["enStu", "enGrade", "enStrand", "enTerm", "enYear", "enSection"].forEach((i) => ($(i).onchange = () => renderEnrollPicker()));
function ctx() {
  const section = S.sections.find((s) => s.id === $("enSection").value), year = $("enYear").value.trim();
  if (!section) throw new Error("Choose a section. If the list is empty, add the section first under Sections & advisers.");
  if (!/^\d{4}-\d{4}$/.test(year)) throw new Error("Enter the school year like 2026-2027.");
  if (!$("enModality").value) throw new Error("Choose the learning modality.");
  return { section, gradeLevel: $("enGrade").value, term: $("enTerm").value, schoolYear: year, strand: $("enStrand").value, modality: $("enModality").value, extra: readExtras("enExtra") };
}
/** One enrollment: the student's teacher-visible record (under the section's adviser), the enrollment record and the master list, in ONE all-or-nothing write.
 *  Exam ID No. = LRN, or the Student ID No. if there is no LRN yet; once set it never changes. */
async function enrollOne(r, c, rowExtra) {
  const examNo = r.examNo || r.lrn || r.studentNo, sec = c.section;
  if (S.registry.some((x) => x.id !== r.id && (x.examNo || x.lrn || x.studentNo) === examNo)) throw new Error(`${r.name}: the Exam ID No. ${examNo} belongs to another student.`);
  const b = writeBatch(db), eid = `${r.id}_${c.schoolYear}_${c.term}`.replace(/[\s/]+/g, "-");
  b.set(doc(db, "students", examNo), { ownerUid: sec.ownerUid, schoolId: SID, classId: sec.id, className: sec.name, number: examNo, lastName: r.lastName, firstName: r.firstName,
    middleInitial: (r.middleName || "").slice(0, 1).toUpperCase(), name: r.name, birthday: r.birthday || "", gender: r.gender || "", lrn: r.lrn || "", studentNo: r.studentNo, registryId: r.id,
    gradeLevel: c.gradeLevel, strand: c.strand || "", updatedAt: serverTimestamp(), ...(r.examNo ? {} : { createdAt: serverTimestamp() }) }, { merge: true });
  b.set(doc(db, "enrollmentRecords", eid), { schoolId: SID, registryId: r.id, studentNo: r.studentNo, lrn: r.lrn || "", examNo, name: r.name, birthday: r.birthday || "", gender: r.gender || "",
    gradeLevel: c.gradeLevel, term: c.term, schoolYear: c.schoolYear, strand: c.strand || "", modality: c.modality || "", sectionId: sec.id, sectionName: sec.name, adviserUid: sec.ownerUid, adviserName: sec.adviserName || "",
    extra: { ...(c.extra || {}), ...Object.fromEntries(Object.entries(rowExtra || {}).filter(([, v]) => v)) }, createdBy: user.uid, createdAt: serverTimestamp() }, { merge: true });
  b.update(doc(db, "registry", r.id), { examNo, gradeLevel: c.gradeLevel, enrollStatus: "Enrolled", enrollStatusDate: localDate(), updatedAt: serverTimestamp() });
  try { await b.commit(); }
  catch (e) { if (e.code === "permission-denied") throw new Error(`${r.name}: the Exam ID No. ${examNo} is already used by a student of another school, or you do not have permission.`); throw e; }
  r.examNo = examNo; r.gradeLevel = c.gradeLevel; r.enrollStatus = "Enrolled";
}
$("enSave").onclick = () => run(async () => {
  const r = S.registry.find((x) => x.id === $("enStu").value); if (!r) return flash("Find and choose a registered student first.");
  const c = ctx(); await enrollOne(r, c); await logEvent("Enrolled student", "enrollment", `${r.name} (${r.studentNo})`, [], `${c.section.name} - ${c.term} - ${c.schoolYear} - ${c.modality}`); await refresh();
  flash(`${r.name} is enrolled in ${c.section.name} (${c.term}, ${c.schoolYear}). Adviser ${c.section.adviserName || ""} can now activate the account. Exam ID No.: ${r.examNo}.`, 1);
});
function renderEnrolled() {
  const sec = $("enSection").value, term = $("enTerm").value, year = $("enYear").value.trim();
  const list = S.enrollments.filter((e) => e.sectionId === sec && e.term === term && e.schoolYear === year).sort((a, b) => a.name.localeCompare(b.name));
  const cs = S.sections.find((s) => s.id === sec), ctxText = cs ? `${cs.name} - ${term} - ${year}` : "no section chosen yet";
  document.querySelectorAll(".enCtx").forEach((el) => (el.textContent = ctxText)); $("enCnt").textContent = `(${list.length})`;
  $("enTbl").innerHTML = "<tr><th>Student ID No.</th><th>LRN</th><th>Name</th><th>Birthdate</th><th>Age</th><th>Gender</th><th>Learning modality</th><th>Remark</th>" + S.fields.enroll.map((f) => `<th>${esc(f.label)}</th>`).join("") + "</tr>" +
    (list.map((e) => `<tr><td>${esc(e.studentNo)}</td><td>${esc(e.lrn || "-")}</td><td>${esc(e.name)}</td><td>${esc(bd(e.birthday))}</td><td>${ageOf(e.birthday)}</td><td>${esc(e.gender || "")}</td><td>${esc(e.modality || "-")}</td><td>${esc(e.remark || "-")}</td>${S.fields.enroll.map((f) => `<td>${esc((e.extra || {})[f.id] ?? "")}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${8 + S.fields.enroll.length}">Nobody enrolled yet for the chosen section, term and school year.</td></tr>`);
}
async function unenroll(id) {
  const e = S.enrollments.find((x) => x.id === id); if (!e) return;
  if (!confirm(`Remove ${e.name} from ${e.sectionName} (${e.term}, ${e.schoolYear})?`)) return;
  await deleteDoc(doc(db, "enrollmentRecords", id));
  await logEvent("Removed from section", "enrollment", `${e.name} (${e.studentNo})`, [], `${e.sectionName} - ${e.term} - ${e.schoolYear}`);
  const rest = S.enrollments.filter((x) => x.registryId === e.registryId && x.id !== id).sort((a, b) => (b.schoolYear || "").localeCompare(a.schoolYear || "") || termRank(b.term) - termRank(a.term))[0];
  const ref = doc(db, "students", e.examNo);
  try {
    if (rest) { const s = S.sections.find((x) => x.id === rest.sectionId); if (s) await updateDoc(ref, { ownerUid: s.ownerUid, classId: s.id, className: s.name, updatedAt: serverTimestamp() }); }
    else { try { await deleteDoc(ref); } catch { await updateDoc(ref, { classId: "", className: "", updatedAt: serverTimestamp() }); } } // an activated account keeps its record, without a section
  } catch { /* record already gone */ }
  if (!rest) await updateDoc(doc(db, "registry", e.registryId), { enrollStatus: "Not Enrolled", enrollStatusDate: localDate(), updatedAt: serverTimestamp() }).catch(() => {});
  await refresh(); flash(`${e.name} was removed from ${e.sectionName}.`, 1);
}

/* ======================= SCHOOL REQUIREMENTS (checklist after registration) + EDITABLE ENROLLMENT STATUS ======================= */
let rqSel = "";
const rqRows = () => {
  const q = $("rqQ").value.trim().toLowerCase(), y = $("rqYear").value, g = $("rqGrade").value, st = $("rqStatus").value, ck = $("rqCheck").value;
  return S.registry.filter((r) => {
    if ((y && r.schoolYear !== y) || (g && r.gradeLevel !== g) || (st && statusOf(r) !== st) || (q && ![r.studentNo, r.lrn, r.name].join(" ").toLowerCase().includes(q))) return false;
    const n = reqCount(r);
    return !ck || (ck === "complete" ? reqDone(r) : ck === "incomplete" ? !reqDone(r) : n === 0);
  });
};
function renderReqs() {
  const rows = rqRows(), done = S.registry.filter(reqDone).length;
  $("rqCnt").textContent = `(${S.registry.length})`;
  $("rqCount").textContent = `${rows.length} of ${S.registry.length} registered students - ${done} with a complete checklist` + (rows.length > 12 ? " - scroll the list to see all" : "");
  $("rqTbl").innerHTML = "<tr><th>Student ID No.</th><th>Name</th><th>Grade</th><th>School year</th><th>Documents submitted</th><th>Enrollment status</th><th></th></tr>" +
    (rows.slice(0, 3000).map((r) => `<tr><td>${esc(r.studentNo)}</td><td>${esc(r.name)}</td><td>${esc(r.gradeLevel || "")}</td><td>${esc(r.schoolYear || "-")}</td>
      <td><span class="prog">${esc(reqText(r))}</span>${bar(reqCount(r), S.reqs.length)} ${reqDone(r) ? '<span class="badge st-enrolled">Complete</span>' : ""}</td><td>${statusBadge(statusOf(r))}</td>
      <td class="actions"><button class="btn small primary" data-rqo="${esc(r.id)}">Checklist / status</button><button class="btn small" data-en="${esc(r.id)}">Enroll</button></td></tr>`).join("") || emptyRow(7, "No students found."));
  if (rqSel && !S.registry.some((r) => r.id === rqSel)) rqSel = "";
  if (!rqSel) { $("rqDetail").hidden = true; $("rqListBox").hidden = false; }
}
["rqQ", "rqYear", "rqGrade", "rqStatus", "rqCheck"].forEach((i) => ($(i).oninput = renderReqs));
$("rqClear").onclick = () => { ["rqQ", "rqYear", "rqGrade", "rqStatus", "rqCheck"].forEach((i) => ($(i).value = "")); renderReqs(); };
$("rqTbl").onclick = (e) => {
  const o = e.target.closest("[data-rqo]"), en = e.target.closest("[data-en]");
  if (o) { const r = S.registry.find((x) => x.id === o.dataset.rqo); if (r) openChecklist(r); }
  else if (en) { const r = S.registry.find((x) => x.id === en.dataset.en); if (r) { show("enroll", "enForm"); $("enQ").value = r.studentNo; renderEnrollPicker(r.id); } }
};
function openChecklist(r) {
  rqSel = r.id; const cur = r.reqs || {};
  show("reqs");
  $("rqListBox").hidden = true; $("rqDetail").hidden = false;
  $("rqHead").textContent = `Checklist - ${r.name}`;
  $("rqInfo").innerHTML = [["Student ID No.", r.studentNo], ["LRN", r.lrn || "- (none yet)"], ["Grade level", r.gradeLevel || "-"], ["School year", r.schoolYear || "-"], ["Guardian", r.guardianName || r.mother || r.father || "-"], ["Guardian contact", r.guardianContact || r.contact || "-"], ["Documents", reqText(r)]]
    .map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("");
  const known = new Set(S.reqs.map((q) => q.id)), gone = Object.keys(cur).filter((k) => !known.has(k));   // submitted items whose requirement was later removed from the list
  $("rqItems").innerHTML = S.reqs.map((q) => itemHtml(q.id, q.label, cur[q.id])).join("") + gone.map((k) => itemHtml(k, (cur[k].label || "Other document") + " (no longer on the list)", cur[k])).join("");
  const stNow = statusOf(r), last = r.enrollStatusDate || "";
  $("rqDStatus").value = stNow; $("rqDDate").value = last || localDate(); $("rqDNote").value = r.enrollStatusNote || "";
  statusHint();
  scrollTo({ top: 0, behavior: "smooth" });
}
function itemHtml(id, label, v) {
  const on = !!v;
  return `<div class="reqitem ${on ? "done" : ""}" data-rq="${esc(id)}" data-label="${esc(label)}"><label class="chk"><input type="checkbox" data-rc ${on ? "checked" : ""}> ${esc(label)}</label>
    <input type="date" data-rd value="${esc((v && v.d) || "")}" aria-label="Date submitted: ${esc(label)}" class="${on ? "" : "off"}"><input type="text" data-rn maxlength="120" placeholder="Note (optional)" value="${esc((v && v.n) || "")}" aria-label="Note: ${esc(label)}" class="${on ? "" : "off"}"></div>`;
}
$("rqItems").onchange = (e) => {
  const c = e.target.closest("[data-rc]"); if (!c) return;
  const row = c.closest(".reqitem"), d = row.querySelector("[data-rd]"), n = row.querySelector("[data-rn]");
  row.classList.toggle("done", c.checked); d.classList.toggle("off", !c.checked); n.classList.toggle("off", !c.checked);
  if (c.checked && !d.value) d.value = localDate();
  if (!c.checked) { d.value = ""; n.value = ""; }
};
const setAll = (on) => document.querySelectorAll("#rqItems [data-rc]").forEach((c) => { c.checked = on; c.dispatchEvent(new Event("change", { bubbles: true })); });
$("rqAll").onclick = () => setAll(true); $("rqNone").onclick = () => setAll(false);
$("rqBack").onclick = () => { rqSel = ""; renderReqs(); };
$("rqEnroll").onclick = () => { const r = S.registry.find((x) => x.id === rqSel); if (!r) return; show("enroll", "enForm"); $("enQ").value = r.studentNo; renderEnrollPicker(r.id); };
function statusHint() {
  const r = S.registry.find((x) => x.id === rqSel); if (!r) return;
  const all = [...document.querySelectorAll("#rqItems [data-rc]")], done = all.filter((c) => c.checked).length, st = $("rqDStatus").value;
  $("rqStHint").textContent = (done === all.length && all.length ? "All documents are submitted. " : `${done} of ${all.length} documents submitted. `) +
    (st === "Enrolled" ? "To make a student Enrolled, enroll him or her in a section (Enrollment tab); the status then changes by itself." : REMARKS.includes(st) ? "This also puts the remark on the student's enrollment record for the latest school year (the student's login account is not deleted here; use Remark in the Enrolled masterlist for that)." : "");
}
$("rqDStatus").onchange = statusHint; $("rqItems").addEventListener("change", statusHint);

/** Changes the enrollment status. "Enrolled" comes from enrolling in a section; the three remarks are also written to the enrollment records, so the dashboard and lists agree. */
async function applyStatus(r, status, date, note) {
  const mine = S.enrollments.filter((e) => e.registryId === r.id), year = [...mine].sort((a, b) => (b.schoolYear || "").localeCompare(a.schoolYear || "") || termRank(b.term) - termRank(a.term))[0]?.schoolYear || "";
  const recs = mine.filter((e) => (e.schoolYear || "") === year);
  if (status === "Enrolled" && !mine.some((e) => !e.remark)) throw new Error("This student is not enrolled in a section yet. Use Go to enrollment: once enrolled, the status becomes Enrolled by itself.");
  if ((status === "Pending" || status === "Not Enrolled") && mine.some((e) => !e.remark)) throw new Error(`${r.name} is enrolled in a section, so the status cannot be ${status}. Remove the student from the section first (Sections & advisers), or choose Transferred Out / Drop Out / Cancelled Enrolled.`);
  const from = statusOf(r);
  if (REMARKS.includes(status)) { for (const e of recs) await updateDoc(doc(db, "enrollmentRecords", e.id), { remark: status, remarkDate: date, remarkNote: note, remarkBy: profile.displayName || "", updatedAt: serverTimestamp() }); }
  await updateDoc(doc(db, "registry", r.id), { enrollStatus: status, enrollStatusDate: date, enrollStatusNote: note, enrollStatusBy: profile.displayName || "", updatedAt: serverTimestamp() });
  await logEvent("Changed enrollment status", "student", `${r.name} (${r.studentNo})`, [{ f: "Enrollment status", from, to: status }], `${date}${note ? " - " + note : ""}${REMARKS.includes(status) && recs.length ? " - remark set on " + year : ""}`);
}
$("rqSave").onclick = () => run(async () => {
  const r = S.registry.find((x) => x.id === rqSel); if (!r) return flash("Choose a student first.");
  const old = r.reqs || {}, next = {};
  document.querySelectorAll("#rqItems .reqitem").forEach((row) => {
    if (!row.querySelector("[data-rc]").checked) return;
    const id = row.dataset.rq, v = { d: row.querySelector("[data-rd]").value || localDate() }, n = row.querySelector("[data-rn]").value.trim();
    if (n) v.n = n;
    if (!S.reqs.some((q) => q.id === id)) v.label = row.dataset.label.replace(/ \(no longer on the list\)$/, "");
    next[id] = v;
  });
  const changes = [], names = Object.fromEntries([...S.reqs.map((q) => [q.id, q.label]), ...Object.keys(old).map((k) => [k, old[k].label || k])]);
  new Set([...Object.keys(old), ...Object.keys(next)]).forEach((id) => {
    const a = old[id], b = next[id], lab = (S.reqs.find((q) => q.id === id) || {}).label || names[id] || id;
    if (!a && b) changes.push({ f: lab, from: "Not submitted", to: "Submitted " + b.d });
    else if (a && !b) changes.push({ f: lab, from: "Submitted " + a.d, to: "Not submitted" });
    else if (a && b && (a.d !== b.d || (a.n || "") !== (b.n || ""))) changes.push({ f: lab, from: `${a.d}${a.n ? " - " + a.n : ""}`, to: `${b.d}${b.n ? " - " + b.n : ""}` });
  });
  const status = $("rqDStatus").value, date = $("rqDDate").value || localDate(), note = $("rqDNote").value.trim();
  let said = "";
  if (changes.length) {
    await updateDoc(doc(db, "registry", r.id), { reqs: next, reqUpdatedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    await logEvent("Updated requirements", "student", `${r.name} (${r.studentNo})`, changes);
    r.reqs = next; said = "Checklist saved. ";
  }
  if (status !== statusOf(r) || (REMARKS.includes(status) && (note !== (r.enrollStatusNote || "") || date !== (r.enrollStatusDate || "")))) {
    try { await applyStatus(r, status, date, note); said += `Status: ${status}.`; }
    catch (err) { await refresh(); openChecklist(S.registry.find((x) => x.id === r.id) || r); return flash((said || "") + err.message); }
  }
  if (!said) return flash("Nothing was changed.");
  await refresh(); rqSel = ""; renderReqs();
  flash(`${r.name}: ${said.trim()}${reqDone(S.registry.find((x) => x.id === r.id) || r) && statusOf(S.registry.find((x) => x.id === r.id) || r) === "Pending" ? " The checklist is complete: the student can now be enrolled in a section." : ""}`, true);
});
$("rqXlsx").onclick = () => {
  const rows = rqRows(); if (!rows.length) return flash("There are no students to download with these filters.");
  const head = ["Student ID No.", "LRN", "Name", "Grade Level", "School Year", "Enrollment Status", "Documents Submitted", "Checklist", ...S.reqs.map((q) => q.label), "Notes"];
  const data = rows.map((r) => ({ "Student ID No.": r.studentNo, LRN: r.lrn || "", Name: r.name, "Grade Level": r.gradeLevel || "", "School Year": r.schoolYear || "", "Enrollment Status": statusOf(r), "Documents Submitted": reqText(r), Checklist: reqDone(r) ? "Complete" : "Incomplete",
    ...Object.fromEntries(S.reqs.map((q) => [q.label, (r.reqs || {})[q.id] ? "Submitted " + (r.reqs[q.id].d || "") : "Missing"])),
    Notes: S.reqs.filter((q) => (r.reqs || {})[q.id]?.n).map((q) => `${q.label}: ${r.reqs[q.id].n}`).join("; ") }));
  saveXlsx([{ name: "School requirements", rows: data, header: head }], `school-requirements-${$("rqYear").value || "all-years"}-${SID}.xlsx`);
};

/* settings: the list of required documents */
function renderReqSettings() {
  $("rqSetList").innerHTML = S.reqs.map((q) => `<span class="tag">${esc(q.label)}<button type="button" data-rqrm="${esc(q.id)}" aria-label="Remove ${esc(q.label)}">&times;</button></span>`).join("") || '<span class="muted">None yet.</span>';
}
$("rqAdd").onclick = () => run(async () => {
  const v = $("rqNew").value.trim(); if (!v) return flash("Type the name of the requirement.");
  if (S.reqs.some((q) => q.label.toLowerCase() === v.toLowerCase())) return flash("That requirement is already on the list.");
  S.reqs.push({ id: "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 4), label: v }); $("rqNew").value = "";
  await saveSettings(); await logEvent("Changed settings", "settings", "School requirements", [{ f: "Requirement", from: "", to: v }], "Added"); render(); flash("Requirement added.", 1);
});
$("rqSetList").onclick = (e) => run(async () => {
  const b = e.target.closest("[data-rqrm]"); if (!b) return;
  const q = S.reqs.find((x) => x.id === b.dataset.rqrm); if (!q) return;
  if (S.reqs.length <= 1) return flash("Keep at least one requirement on the list.");
  if (!confirm(`Remove "${q.label}" from the list of school requirements? Students who already submitted it keep that record.`)) return;
  S.reqs = S.reqs.filter((x) => x.id !== q.id); await saveSettings(); await logEvent("Changed settings", "settings", "School requirements", [{ f: "Requirement", from: q.label, to: "" }], "Removed"); render();
});

refresh();
