import { requireRole, logout, db, esc, friendlyError, ageOf, applyBranding } from "./auth.js";
import { collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp }
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
const DEFAULT_VOUCHERS = ["PUB", "ALS", "ESC"];
const DEFAULT_STRANDS = ["STEM", "ABM", "HUMSS", "GAS", "TVL"];
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

/* ---------- data ---------- */
const S = { registry: [], sections: [], teachers: [], enrollments: [], vouchers: [...DEFAULT_VOUCHERS], strands: [...DEFAULT_STRANDS], fields: { reg: [], enroll: [], master: [] } };
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
    if (set && set.exists()) { S.vouchers = set.data().voucherTypes || S.vouchers; S.strands = set.data().strands || S.strands; const f = set.data().fields || {}; S.fields = { reg: f.reg || [], enroll: f.enroll || [], master: f.master || [] }; }
    render();
  });
}
const saveSettings = () => setDoc(doc(db, "registrarSettings", SID), { schoolId: SID, voucherTypes: S.vouchers, strands: S.strands, fields: S.fields, updatedAt: serverTimestamp() }, { merge: true });

/* ---------- history log: who changed what ---------- */
const FLABEL = { gradeLevel: "Grade level", lrn: "LRN", voucherType: "Voucher type", lastName: "Last name", firstName: "First name", middleName: "Middle name", suffix: "Suffix", birthday: "Birthdate", gender: "Gender",
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
  keep("enGrade", options(GRADES)); keep("enTerm", options(TERMS)); keep("enStrand", options(S.strands, noneS));
  keep("scGrade", options(GRADES)); keep("scStrand", options(S.strands, noneS)); keep("scFilter", options(GRADES, "All grade levels"));
  keep("mlGrade", options(GRADES, "All grade levels")); keep("mlVoucher", options(S.vouchers, "All voucher types"));
  keep("dsYear", options(yearChoices())); keep("dsTermSel", options(TERMS, "All terms / quarters"));
  keep("elYear", options(yearChoices(), "All school years")); keep("elTerm", options(TERMS, "All terms / quarters")); keep("elGrade", options(GRADES, "All grade levels")); keep("elStrand", options(S.strands, "All clusters / strands"));
  keep("elSection", `<option value="">All sections</option>` + [...S.sections].sort(byGradeName).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")); keep("elVoucher", options(S.vouchers, "All voucher types"));
  keep("msGrade", options(GRADES, "All grade levels")); keep("msYear", options(yearsList(), "All school years")); keep("msTerm", options(TERMS, "All terms"));
  keep("scAdv", S.teachers.map((t) => `<option value="${esc(t.uid)}">${esc(t.displayName)} (${esc(t.employeeId || "")})</option>`).join("") || `<option value="">No teacher accounts yet - ask the IT Admin</option>`);
  if (!$("enYear").value) $("enYear").value = schoolYearNow();
  renderVoucherStrand(); renderFieldSettings(); renderExtras(); renderDash(); renderMaster(); renderEnList(); renderMasterSections(); renderEnrollPicker(); renderSections(); renderSectionView(); renderEnrolled();
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
  $("rgNo").readOnly = false; renderExtras({}); document.querySelectorAll("#rgExtra [data-x],#rgMaster [data-x]").forEach((el) => (el.value = "")); $("rgMasterBox").hidden = true; $("rgHead").textContent = "Student registration"; $("rgSave").textContent = "Save registration"; $("rgCancel").hidden = true;
}
$("rgCancel").onclick = clearForm;
function fillForm(r) {
  editing = r.id; $("rgGrade").value = r.gradeLevel || GRADES[0]; $("rgVoucher").value = r.voucherType || "";
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
  const p = { gradeLevel: $("rgGrade").value, studentNo: v("no"), lrn: v("lrn").replace(/\s+/g, ""), voucherType: $("rgVoucher").value,
    lastName: v("last"), firstName: v("first"), middleName: v("middle"), suffix: v("suffix"), birthday: $(F.bday).value, gender: $("rgGender").value,
    contact: v("contact"), address: v("address"), father: v("father"), mother: v("mother"), guardianName: v("guardian"), guardianContact: v("gcontact"), guardianAddress: v("gaddress"), extra: { ...readExtras("rgExtra"), ...readExtras("rgMaster") } };
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
  const rec = { ...p, ...(old ? {} : { schoolId: SID, createdBy: user.uid, createdAt: serverTimestamp() }), updatedAt: serverTimestamp() };
  await setDoc(doc(db, "registry", id), rec, { merge: true });
  const who = `${p.name} (${p.studentNo})`, diff = old ? diffRec(old, p) : [];
  if (!old) await logEvent("Registered student", "student", who, [], `${p.gradeLevel}${p.voucherType ? " - voucher " + p.voucherType : ""}`);
  else if (diff.length) await logEvent("Edited student", "student", who, diff);
  const merged = { ...(old || {}), ...p, extra: { ...(old?.extra || {}), ...p.extra }, id }; await syncStudent(merged);
  const was = editing; clearForm(); await refresh();
  flash(was ? `Saved changes for ${p.name}.` : `Registered ${p.name}. Next: enroll the student in a section.` , true);
  if (old?.examNo && p.lrn && old.examNo !== p.lrn) flash(`Saved. The Exam ID No. stays ${old.examNo} because the student is already enrolled; it is not changed afterwards.`, true);
});

/* ======================= MASTER LIST ======================= */
function latestEnrol(r) {
  return S.enrollments.filter((e) => e.registryId === r.id).sort((a, b) => (b.schoolYear || "").localeCompare(a.schoolYear || "") || termRank(b.term) - termRank(a.term) || tsec(b) - tsec(a))[0];
}
let mlLetter = "";
const lastInit = (r) => (String(r.lastName || r.name || "").trim()[0] || "#").toUpperCase();
function renderMaster() {
  const q = $("mlQ").value.trim().toLowerCase(), g = $("mlGrade").value, vt = $("mlVoucher").value, sort = $("mlSort").value;
  const base = S.registry.filter((r) => (!g || r.gradeLevel === g) && (!vt || r.voucherType === vt) && (!q || [r.studentNo, r.lrn, r.name].join(" ").toLowerCase().includes(q)));
  const have = new Set(base.map(lastInit));
  $("mlLetters").innerHTML = `<button type="button" data-l="" class="${mlLetter ? "" : "on"}">All</button>` + "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c) => `<button type="button" data-l="${c}" class="${mlLetter === c ? "on" : ""}" ${have.has(c) ? "" : 'style="opacity:.35"'}>${c}</button>`).join("");
  const cmp = { az: (a, b) => a.name.localeCompare(b.name), za: (a, b) => b.name.localeCompare(a.name), no: (a, b) => String(a.studentNo).localeCompare(String(b.studentNo), undefined, { numeric: true }) }[sort];
  const rows = base.filter((r) => !mlLetter || lastInit(r) === mlLetter).sort(cmp), xf = colFields(), n = 11 + xf.length;
  $("mlCnt").textContent = `(${S.registry.length})`;
  $("mlCount").textContent = `${rows.length} of ${S.registry.length} registered students` + (rows.length > 12 ? " - scroll the list to see all" : "");
  $("mlTbl").innerHTML = "<tr><th>Student ID No.</th><th>LRN</th><th>Name</th><th>Grade</th><th>Voucher</th><th>Birthdate</th><th>Age</th><th>Gender</th><th>Contact</th>" + xf.map((f) => `<th>${esc(f.label)}</th>`).join("") + "<th>Enrolled in</th><th></th></tr>" +
    (rows.slice(0, 3000).map((r) => { const e = latestEnrol(r);
      return `<tr><td>${esc(r.studentNo)}</td><td>${esc(r.lrn || "-")}</td><td>${esc(r.name)}</td><td>${esc(r.gradeLevel || "")}</td><td>${esc(r.voucherType || "-")}</td><td>${esc(bd(r.birthday))}</td><td>${ageOf(r.birthday)}</td><td>${esc(r.gender || "")}</td><td>${esc(r.contact || "")}</td>
      ${xf.map((f) => `<td>${esc((r.extra || {})[f.id] ?? "")}</td>`).join("")}
      <td>${e ? esc(e.sectionName) + `<small>${esc(e.term)} ${esc(e.schoolYear || "")}</small>` : '<span class="badge warn">Not enrolled</span>'}</td>
      <td class="actions"><button class="btn small" data-ed="${esc(r.id)}">Edit</button><button class="btn small" data-en="${esc(r.id)}">Enroll</button><button class="btn small" data-hi="${esc(r.id)}">History</button><button class="btn small danger" data-rm="${esc(r.id)}">Delete</button></td></tr>`; }).join("") ||
      `<tr><td colspan="${n}">No students found.</td></tr>`);
}
$("mlLetters").onclick = (e) => { const b = e.target.closest("[data-l]"); if (b) { mlLetter = b.dataset.l; renderMaster(); } };
["mlQ", "mlGrade", "mlVoucher", "mlSort"].forEach((i) => ($(i).oninput = renderMaster));
$("mlTbl").onclick = (e) => run(async () => {
  const b = e.target.closest("[data-ed],[data-en],[data-rm],[data-hi]"); if (!b) return;
  const r = S.registry.find((x) => x.id === (b.dataset.ed || b.dataset.en || b.dataset.rm || b.dataset.hi)); if (!r) return;
  if (b.dataset.ed) return fillForm(r);
  if (b.dataset.hi) { show("history"); $("hiQ").value = `(${r.studentNo})`; renderHistory(); scrollTo({ top: 0 }); return; }
  if (b.dataset.en) { show("enroll", "enForm"); $("enQ").value = r.studentNo; renderEnrollPicker(r.id); return; }
  if (r.examNo) { // an activated student account must be removed by the IT Admin
    let acc = false; try { const s = await getDoc(doc(db, "students", r.examNo)); acc = s.exists() && !!s.data().accountUid; } catch { /* no record */ }
    if (acc) return flash(`${r.name} already has an active account. Ask the IT Admin to remove the account first, then delete the registration.`);
  }
  if (!confirm(`Delete ${r.name} (${r.studentNo}) from the master list, with all of their enrollment records?`)) return;
  const gone = S.enrollments.filter((x) => x.registryId === r.id);
  for (const en of gone) await deleteDoc(doc(db, "enrollmentRecords", en.id));
  if (r.examNo) await deleteDoc(doc(db, "students", r.examNo)).catch(() => {});
  await deleteDoc(doc(db, "registry", r.id)); await logEvent("Deleted student", "student", `${r.name} (${r.studentNo})`, [], `Also removed ${gone.length} enrollment record${gone.length === 1 ? "" : "s"}`); await refresh(); flash(`${r.name} was deleted.`, true);
});
/* ---------- Excel export (whole master list, one section, or every section) ---------- */
const masterRow = (r) => ({ "Student ID No.": r.studentNo, LRN: r.lrn || "", "Voucher Type": r.voucherType || "", "Last Name": r.lastName, "First Name": r.firstName, "Middle Name": r.middleName || "", Suffix: r.suffix || "",
  Birthdate: r.birthday || "", Age: ageOf(r.birthday), Gender: r.gender || "", "Contact No.": r.contact || "", Address: r.address || "", "Father's Name": r.father || "", "Mother's Name": r.mother || "",
  "Guardian Name": r.guardianName || "", "Guardian Contact No.": r.guardianContact || "", "Guardian Address": r.guardianAddress || "", "Grade Level": r.gradeLevel || "", ...Object.fromEntries(colFields().map((f) => [f.label, (r.extra || {})[f.id] ?? ""])) });
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

/* ======================= MASTER LIST PER SECTION ======================= */
const NONE = "__none";
const yearsList = () => [...new Set(S.enrollments.map((e) => e.schoolYear).filter(Boolean))].sort().reverse();
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
const sectionRow = ({ r, e }, sec) => ({ ...masterRow(r), Section: sec ? sec.name : "", "Cluster / strand": sec ? sec.strand || "" : "", "Term / quarter": e ? e.term : "", "School year": e ? e.schoolYear || "" : "",
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
  const ens = S.enrollments.filter((e) => (!y || e.schoolYear === y) && (!t || e.term === t) && regMap.has(e.registryId));
  [...ens].sort((a, b) => termRank(b.term) - termRank(a.term) || tsec(b) - tsec(a)).forEach((e) => { if (!latest.has(e.registryId)) latest.set(e.registryId, e); });
  const rows = S.registry.map((r) => { const e = latest.get(r.id) || null; return { r, e, grade: (e && e.gradeLevel) || r.gradeLevel || NOGRADE }; });
  return { y, t, ens, regMap, rows, enrolled: rows.filter((x) => x.e) };
}
function genderTable(list) {
  const gs = [...GRADES, NOGRADE].filter((g) => list.some((x) => x.grade === g));
  const line = (label, a, cls) => rowHtml([esc(label), a.filter(isM).length, a.filter(isF).length, a.length], cls);
  return hdr(["Grade level", "Male", "Female", "Total"]) + (gs.length ? gs.map((g) => line(g, list.filter((x) => x.grade === g))).join("") + line("All grade levels", list, "tot") : emptyRow(4, "No students."));
}
function renderDash() {
  if (!dsInit) { dsInit = true; $("dsYear").value = schoolYearNow(); }
  const { y, t, ens, regMap, rows, enrolled } = dashScope(), notEn = rows.length - enrolled.length;
  $("dsCtx").textContent = `Showing: school year ${y || "all"}, ${t || "all terms / quarters"}.`;
  $("dsCards").innerHTML = [["Registered students", rows.length], ["Total enrolled", enrolled.length], ["Total not enrolled", notEn, "warn"], ["Enrollment rate", pc(enrolled.length, rows.length)],
    ["Enrolled - male", enrolled.filter(isM).length], ["Enrolled - female", enrolled.filter(isF).length]].map(([l, v, c]) => `<div class="stat ${c || ""}"><b>${v}</b><span>${l}</span></div>`).join("");
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
    const n = new Set(S.enrollments.filter((e) => (!y || e.schoolYear === y) && e.term === tm && regMap.has(e.registryId)).map((e) => e.registryId)).size;
    return rowHtml([esc(tm), n, S.registry.length - n, `${pc(n, S.registry.length)} ${bar(n, S.registry.length)}`]);
  }).join("");
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
function enrolledRecords() {
  const q = $("elQ").value.trim().toLowerCase(), y = $("elYear").value, t = $("elTerm").value, g = $("elGrade").value, st = $("elStrand").value, sc = $("elSection").value, v = $("elVoucher").value, sort = $("elSort").value;
  const regMap = new Map(S.registry.map((r) => [r.id, r])), by = new Map();
  S.enrollments.forEach((e) => {
    if ((y && e.schoolYear !== y) || (t && e.term !== t) || (g && e.gradeLevel !== g) || (st && (e.strand || "") !== st) || (sc && e.sectionId !== sc)) return;
    const r = regMap.get(e.registryId); if (!r || (v && (r.voucherType || "") !== v) || (q && ![r.studentNo, r.lrn, r.name].join(" ").toLowerCase().includes(q))) return;
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
  const rows = enrolledRecords(), xf = colFields(), ef = S.fields.enroll, n = 12 + xf.length + ef.length;
  $("elCnt").textContent = `(${new Set(S.enrollments.map((e) => e.registryId)).size})`;
  $("elCount").textContent = `${rows.length} enrolled student${rows.length === 1 ? "" : "s"} - ${rows.filter(isM).length} male, ${rows.filter(isF).length} female` + (rows.length > 12 ? " - scroll the list to see all" : "");
  $("elTbl").innerHTML = "<tr><th>Student ID No.</th><th>LRN</th><th>Name</th><th>Grade</th><th>Cluster / strand</th><th>Section</th><th>Term / quarter</th><th>School year</th><th>Voucher</th><th>Gender</th><th>Birthdate</th><th>Age</th>" +
    [...xf, ...ef].map((f) => `<th>${esc(f.label)}</th>`).join("") + "<th></th></tr>" +
    (rows.slice(0, 3000).map(({ r, e, terms, years }) => `<tr><td>${esc(r.studentNo)}</td><td>${esc(r.lrn || "-")}</td><td>${esc(r.name)}</td><td>${esc(e.gradeLevel || r.gradeLevel || "")}</td><td>${esc(e.strand || "-")}</td><td>${esc(e.sectionName || "")}</td>` +
      `<td>${esc(terms.join(", "))}</td><td>${esc(years.join(", "))}</td><td>${esc(r.voucherType || "-")}</td><td>${esc(r.gender || "")}</td><td>${esc(bd(r.birthday))}</td><td>${ageOf(r.birthday)}</td>` +
      xf.map((f) => `<td>${esc((r.extra || {})[f.id] ?? "")}</td>`).join("") + ef.map((f) => `<td>${esc((e.extra || {})[f.id] ?? "")}</td>`).join("") +
      `<td class="actions"><button class="btn small" data-ed="${esc(r.id)}">Edit</button><button class="btn small" data-hi="${esc(r.id)}">History</button></td></tr>`).join("") || emptyRow(n, "No enrolled students found."));
}
["elQ", "elYear", "elTerm", "elGrade", "elStrand", "elSection", "elVoucher", "elSort"].forEach((i) => ($(i).oninput = renderEnList));
$("elTbl").onclick = (e) => {
  const b = e.target.closest("[data-ed],[data-hi]"); if (!b) return;
  const r = S.registry.find((x) => x.id === (b.dataset.ed || b.dataset.hi)); if (!r) return;
  if (b.dataset.ed) return fillForm(r);
  show("history"); $("hiQ").value = `(${r.studentNo})`; renderHistory(); scrollTo({ top: 0 });
};
$("elXlsx").onclick = () => {
  const ef = S.fields.enroll, list = enrolledRecords();
  if (!list.length) return flash("There are no enrolled students to download with these filters.");
  const rowOf = ({ r, e, terms, years }) => ({ ...masterRow(r), "Grade Level": e.gradeLevel || r.gradeLevel || "", "Cluster / strand": e.strand || "", Section: e.sectionName || "", "Term / quarter": terms.join(", "), "School year": years.join(", "),
    ...Object.fromEntries(ef.map((f) => [f.label, (e.extra || {})[f.id] ?? ""])) });
  saveXlsx([{ name: "Enrolled masterlist", rows: list.map(rowOf), header: Object.keys(rowOf({ r: {}, e: {}, terms: [], years: [] })) }], `enrolled-masterlist-${$("elYear").value || "all"}-${SID}.xlsx`);
};

/* ======================= HISTORY LOG ======================= */
const ACTIONS = ["Registered student", "Edited student", "Deleted student", "Enrolled student", "Removed from section", "Added section", "Changed adviser", "Deleted section", "Imported list", "Changed settings"];
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
  if (r && r.id !== picked) { picked = r.id; if (r.gradeLevel) $("enGrade").value = r.gradeLevel; }
  const examNo = r ? (r.examNo || r.lrn || r.studentNo) : "";
  $("enInfo").hidden = !r;
  if (r) $("enInfo").innerHTML = [["Name", r.name], ["Student ID No.", r.studentNo], ["LRN", r.lrn || "- (none yet)"], ["Birthdate", bd(r.birthday)], ["Age", ageOf(r.birthday)], ["Gender", r.gender || "-"], ["Voucher", r.voucherType || "-"],
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
  return { section, gradeLevel: $("enGrade").value, term: $("enTerm").value, schoolYear: year, strand: $("enStrand").value, extra: readExtras("enExtra") };
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
    gradeLevel: c.gradeLevel, term: c.term, schoolYear: c.schoolYear, strand: c.strand || "", sectionId: sec.id, sectionName: sec.name, adviserUid: sec.ownerUid, adviserName: sec.adviserName || "",
    extra: { ...(c.extra || {}), ...Object.fromEntries(Object.entries(rowExtra || {}).filter(([, v]) => v)) }, createdBy: user.uid, createdAt: serverTimestamp() }, { merge: true });
  b.update(doc(db, "registry", r.id), { examNo, gradeLevel: c.gradeLevel, updatedAt: serverTimestamp() });
  try { await b.commit(); }
  catch (e) { if (e.code === "permission-denied") throw new Error(`${r.name}: the Exam ID No. ${examNo} is already used by a student of another school, or you do not have permission.`); throw e; }
  r.examNo = examNo; r.gradeLevel = c.gradeLevel;
}
$("enSave").onclick = () => run(async () => {
  const r = S.registry.find((x) => x.id === $("enStu").value); if (!r) return flash("Find and choose a registered student first.");
  const c = ctx(); await enrollOne(r, c); await logEvent("Enrolled student", "enrollment", `${r.name} (${r.studentNo})`, [], `${c.section.name} - ${c.term} - ${c.schoolYear}`); await refresh();
  flash(`${r.name} is enrolled in ${c.section.name} (${c.term}, ${c.schoolYear}). Adviser ${c.section.adviserName || ""} can now activate the account. Exam ID No.: ${r.examNo}.`, 1);
});
function renderEnrolled() {
  const sec = $("enSection").value, term = $("enTerm").value, year = $("enYear").value.trim();
  const list = S.enrollments.filter((e) => e.sectionId === sec && e.term === term && e.schoolYear === year).sort((a, b) => a.name.localeCompare(b.name));
  const cs = S.sections.find((s) => s.id === sec), ctxText = cs ? `${cs.name} - ${term} - ${year}` : "no section chosen yet";
  document.querySelectorAll(".enCtx").forEach((el) => (el.textContent = ctxText)); $("enCnt").textContent = `(${list.length})`;
  $("enTbl").innerHTML = "<tr><th>Student ID No.</th><th>LRN</th><th>Name</th><th>Birthdate</th><th>Age</th><th>Gender</th>" + S.fields.enroll.map((f) => `<th>${esc(f.label)}</th>`).join("") + "</tr>" +
    (list.map((e) => `<tr><td>${esc(e.studentNo)}</td><td>${esc(e.lrn || "-")}</td><td>${esc(e.name)}</td><td>${esc(bd(e.birthday))}</td><td>${ageOf(e.birthday)}</td><td>${esc(e.gender || "")}</td>${S.fields.enroll.map((f) => `<td>${esc((e.extra || {})[f.id] ?? "")}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${6 + S.fields.enroll.length}">Nobody enrolled yet for the chosen section, term and school year.</td></tr>`);
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
  await refresh(); flash(`${e.name} was removed from ${e.sectionName}.`, 1);
}

refresh();
