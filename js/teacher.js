import { requireRole, logout, db, esc, friendlyError, studentEmail, sharedEmail, defaultStudentPassword, ageOf, fullName, applyBranding, cleanEmail, studentKey } from "./auth.js";
import { collection, query, where, getDocs, getDoc, doc, setDoc, addDoc, updateDoc, deleteDoc, deleteField, writeBatch, serverTimestamp, callFn }
  from "./db.js";
import { TYPES, TYPE_SHORT, TERMS, termRank, isAuto, itemsOf, lettersOf, MAX_ITEMS, sheetSVG, scanSheet, score, missedText, identMatches, findCorners, SheetTracker } from "./omr.js";
import { CHUNK, MAX_BYTES, sizeText, b64, safeUrl, openModule } from "./files.js";

const $ = (id) => document.getElementById(id);
const { user, profile, school } = await requireRole(["teacher", "admin"]); // the IT admin has every teacher feature
$("who").textContent = profile.displayName; $("out").onclick = logout;
applyBranding(school);
if (profile.role === "admin") $("adminLink").hidden = false;
const SID = profile.schoolId; // every record this teacher creates is stamped with the school

const flash = (t, ok) => { const m = $("msg"); m.textContent = t; m.className = "notice noprint " + (ok ? "ok" : "err"); m.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => (m.hidden = true), 8000); };
const net = () => { $("sync").className = "sync" + (navigator.onLine ? "" : " off"); $("sync").lastElementChild.textContent = navigator.onLine ? "Online" : "Offline - changes will not save"; };
addEventListener("online", net); addEventListener("offline", net); net();
const run = async (fn) => { try { await fn(); } catch (e) { console.error(e); flash(friendlyError(e)); } };
const store = { get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

/* ---------- data ---------- */
const S = { classes: [], students: [], home: [], joins: [], exams: [], modules: [], results: [] };
const load = async (c, ...w) => (await getDocs(query(collection(db, c), where("ownerUid", "==", user.uid), ...w))).docs.map((d) => ({ id: d.id, ...d.data() }));
const keep = (id, html) => { const el = $(id), v = el.value; el.innerHTML = html; if ([...el.options].some((o) => o.value === v)) el.value = v; };
const opts = (a, f, empty) => a.map((x) => `<option value="${esc(x.id)}">${esc(f(x))}</option>`).join("") || `<option value="">${empty}</option>`;
const byName = (a, b) => String(a.name).localeCompare(String(b.name));
const clsOf = (id) => S.classes.find((c) => c.id === id);
const examOf = (id) => S.exams.find((x) => x.id === id);
const countIn = (c) => S.students.filter((s) => s.classId === c.id).length;
const bd = (b) => (b ? new Date(b + "T00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "-");
const byTerm = (a, b) => termRank(a.term) - termRank(b.term) || (b.createdAt?.seconds || 9e9) - (a.createdAt?.seconds || 9e9);
const termHtml = (all) => (all ? `<option value="">All terms / quarters</option>` : "") + TERMS.map((t) => `<option>${t}</option>`).join("");
const groupRows = (list, cols, row) => { let last, out = ""; for (const x of list) { const t = x.term || "No term"; if (t !== last) { last = t; out += `<tr class="grp"><td colspan="${cols}">${esc(t)} - ${list.filter((y) => (y.term || "No term") === t).length}</td></tr>`; } out += row(x); } return out; };
["exTerm", "mdTerm"].forEach((i) => ($(i).innerHTML = termHtml(false))); ["exFilter", "mdFilter"].forEach((i) => ($(i).innerHTML = termHtml(true)));
$("exTerm").value = $("mdTerm").value = store.get("ark.term") || TERMS[0];
["exFilter", "mdFilter"].forEach((i) => ($(i).onchange = render));

async function refresh() {
  await run(async () => {
    [S.classes, S.home, S.exams, S.modules, S.joins] = await Promise.all([load("classes"), load("students"), load("examinations"), load("modules"), load("enrollments")]);
    // roster = my advisory students + students from other teachers who joined my classrooms with its code
    S.students = [...S.home, ...S.joins.map((j) => ({ id: j.studentId, number: j.studentNumber, name: j.studentName, classId: j.classId, className: j.className, accountUid: j.studentUid, joined: true, enrollId: j.id }))];
    S.classes.sort((a, b) => a.name.localeCompare(b.name));
    S.exams.sort(byTerm); S.modules.sort(byTerm);
    render();
  });
}
function render() {
  const sec = S.classes.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  keep("stClass", opts(S.classes, (c) => c.name, "Add a section first"));
  keep("exClass", `<option value="">All sections</option>` + sec); keep("mdClass", `<option value="">All my sections</option>` + sec);
  keep("mdStuSec", opts(S.classes, (c) => c.name, "Add a section first")); fillMdStudents();
  const eo = opts(S.exams, (e) => `${e.term ? "[" + e.term + "] " : ""}${e.title} (${e.className})`, "Create an exam first");
  ["shExam", "scExam", "reExam", "kvExam"].forEach((i) => keep(i, eo));
  keep("scSec", `<option value="">All sections</option>` + sec); keep("reSec", `<option value="">All sections</option>` + sec);
  keep("shFor", `<option value="blank">Blank sheets (write name by hand)</option>` + S.classes.map((c) => `<option value="${esc(c.id)}">Named sheets: ${esc(c.name)} (${countIn(c)} students)</option>`).join(""));

  $("clTbl").innerHTML = "<tr><th>Section</th><th>Classroom code</th><th>Advisory students</th><th>Joined by code</th><th></th></tr>" +
    (S.classes.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.code ? `<code class="cc">${esc(c.code)}</code>` : "-"}</td><td>${S.home.filter((s) => s.classId === c.id).length}</td><td>${S.joins.filter((j) => j.classId === c.id).length}</td>
      <td class="actions"><button class="btn small" data-code="${esc(c.id)}">${c.code ? "New code" : "Create code"}</button></td></tr>`).join("") || "<tr><td colspan=5>No sections yet.</td></tr>");

  keep("stFSec", `<option value="">All sections</option>` + sec);
  const fsec = stF.sec === undefined ? $("stClass").value : stF.sec; $("stFSec").value = fsec;
  const stCmp = { az: byName, za: (x, y) => byName(y, x), id: (x, y) => String(x.number).localeCompare(String(y.number), undefined, { numeric: true }) }[$("stFSort").value] || byName;
  const stRow = (s) => s.joined ? `<tr><td>${esc(s.number)}</td><td>${esc(s.name)}</td><td>-</td><td></td><td><span class="badge active">Joined by code</span></td>
      <td class="actions"><button class="btn small danger" data-unjoin="${esc(s.enrollId)}">Remove from classroom</button></td></tr>`
      : `<tr><td>${esc(s.number)}</td><td>${esc(s.name)}${s.email ? `<small>${esc(s.email)}</small>` : ""}</td><td>${esc(bd(s.birthday))}</td><td>${ageOf(s.birthday)}</td>
      <td>${s.accountUid ? '<span class="badge active">Active</span>' : '<span class="badge warn">Not activated</span>'}</td>
      <td class="actions">${s.accountUid ? "" : `<button class="btn small" data-mk="${esc(s.id)}">Activate account</button>`}
      <button class="btn small danger" data-rm="${esc(s.id)}">Remove</button></td></tr>`;
  let stBody = "";
  for (const c of fsec ? S.classes.filter((x) => x.id === fsec) : S.classes) { // "All sections": one group per section, names sorted inside each
    const list = S.students.filter((s) => s.classId === c.id).sort(stCmp);
    if (!fsec && list.length) stBody += `<tr class="grp"><td colspan="6">${esc(c.name)} - ${list.length} student${list.length === 1 ? "" : "s"}</td></tr>`;
    stBody += list.map(stRow).join("");
  }
  $("stTbl").innerHTML = "<tr><th>Exam ID No.</th><th>Name (Last, First M.I.)</th><th>Birthday</th><th>Age</th><th>Account</th><th></th></tr>" +
    (stBody || `<tr><td colspan="6">No students ${fsec ? "in this section" : "yet"}.</td></tr>`);

  const mix = (e) => { const c = {}; itemsOf(e).forEach((i) => (c[i.type] = (c[i.type] || 0) + 1)); return Object.entries(c).map(([t, n]) => `${TYPE_SHORT[t]} ${n}`).join(", "); };
  const exs = S.exams.filter((e) => !$("exFilter").value || (e.term || "") === $("exFilter").value);
  const card = (e) => { const its = itemsOf(e), pts = its.reduce((x, y) => x + y.pts, 0);
    return `<div class="excard"><div class="top2"><h4>${esc(e.title)}</h4><span class="badge ${e.online ? "active" : ""}">${e.online ? (e.link ? "Online - paper link" : "Online") : "Printed"}</span></div>
      <div class="meta"><span class="cm">${esc(e.className)}</span>${e.subject ? `<span class="cm">${esc(e.subject)}</span>` : ""}${e.date ? `<span class="cm">${esc(e.date)}</span>` : ""}
      <span class="cm" title="${esc(mix(e))}">${its.length} items</span><span class="cm">${pts} pts</span><span class="cm">Pass ${esc(e.passing)}%</span>${e.timeLimit ? `<span class="cm">${e.timeLimit} min</span>` : ""}</div>
      ${e.online ? `<button type="button" class="switch" role="switch" aria-checked="${!!e.open}" data-pub="${esc(e.id)}" title="Click to ${e.open ? "close" : "open"} this exam"><span class="trk"></span><span>${e.open ? "Open for students" : "Closed - students cannot see it"}</span></button>` : `<span class="muted fine">Printed exam: print the answer sheets, then scan them.</span>`}
      <div class="acts"><button class="btn small" data-edit="${esc(e.id)}">Edit</button><button class="btn small" data-key="${esc(e.id)}">Answer key</button><button class="btn small" data-sheet="${esc(e.id)}">Answer sheet</button><button class="btn small danger" data-del="${esc(e.id)}">Delete</button></div></div>`; };
  let lastT, exHtml = "";
  for (const e of exs) { const t = e.term || "No term"; if (t !== lastT) { lastT = t; exHtml += `<div class="termhead">${esc(t)} - ${exs.filter((y) => (y.term || "No term") === t).length}</div>`; } exHtml += card(e); }
  $("exList").innerHTML = exHtml || `<p class="muted">No examinations yet. Press <b>+ Create exam</b> to make one.</p>`;

  const mds = S.modules.filter((m) => !$("mdFilter").value || (m.term || "") === $("mdFilter").value);
  $("mdTbl").innerHTML = "<tr><th>Title</th><th>Sent to</th><th>File</th><th>Uploaded</th><th></th></tr>" +
    (groupRows(mds, 5, (m) => `<tr><td class="wrapcell"><b>${esc(m.title)}</b>${m.description ? `<br><span class="muted fine">${esc(m.description)}</span>` : ""}</td><td>${m.studentId ? `<span class="badge one">One student</span> ${esc(m.studentName || m.studentId)}` : esc(m.className)}</td>
      <td>${m.kind === "link" ? "Link" : esc(m.fileName) + " (" + sizeText(m.size) + ")"}</td><td>${m.createdAt?.toDate ? m.createdAt.toDate().toLocaleDateString() : "-"}</td>
      <td class="actions"><button class="btn small" data-open="${esc(m.id)}">${m.kind === "link" ? "Open" : "Download"}</button><button class="btn small danger" data-delmd="${esc(m.id)}">Remove</button></td></tr>`) || "<tr><td colspan=5>No modules yet.</td></tr>");
  drawSheet(); if (!$("kvBody").closest("[data-ev]").hidden) renderKey();
}
function show(t) {
  document.querySelectorAll("[data-s]").forEach((s) => (s.hidden = s.dataset.s !== t));
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
  if (t === "results") loadResults(); if (t === "sheet") drawSheet(); if (t === "scan") fillStudents();
}
$("tabs").onclick = (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.t); };
const stF = { sec: undefined }; // undefined = follow the Section box above the form
$("stClass").onchange = () => { stF.sec = $("stClass").value; render(); };
$("stFSec").onchange = () => { stF.sec = $("stFSec").value; if (stF.sec) $("stClass").value = stF.sec; render(); };
$("stFSort").onchange = render;
$("stFilter").querySelector("[data-reset]").onclick = () => { stF.sec = ""; $("stFSort").value = "az"; render(); };
$("reFilter").querySelector("[data-reset]").onclick = () => { $("reSec").value = ""; $("reSort").value = "sec_name"; renderResults(); };
/** Filter icon: opens a small panel under the button; closes on outside click or Escape. */
function popover(root) {
  const btn = root.querySelector("button"), panel = root.querySelector(".fpanel");
  const set = (open) => { panel.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };
  btn.onclick = (e) => { e.stopPropagation(); set(panel.hidden); };
  document.addEventListener("click", (e) => { if (!root.contains(e.target)) set(false); });
  root.addEventListener("keydown", (e) => { if (e.key === "Escape") { set(false); btn.focus(); } });
}
document.querySelectorAll(".fpop").forEach(popover);

/* ---------- sections and students ---------- */
const CODE_CH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I so codes are easy to read aloud
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (n) => CODE_CH[n % CODE_CH.length]).join("");
/** Each section gets a unique classroom code. A student of any teacher in this school can join with it. */
async function issueCode(c) {
  for (let k = 0; k < 8; k++) {
    const code = newCode();
    try { await setDoc(doc(db, "classCodes", code), { code, classId: c.id, className: c.name, ownerUid: user.uid, teacherName: profile.displayName, schoolId: SID, createdAt: serverTimestamp() }); return code; }
    catch (e) { if (e.code !== "permission-denied") throw e; } // code already used by another teacher: try another
  }
  throw new Error("Could not make a unique code. Try again.");
}
$("clAdd").onclick = () => run(async () => {
  const name = $("clName").value.trim(); if (!name) return flash("Enter a section name.");
  const ref = doc(collection(db, "classes"));
  await setDoc(ref, { ownerUid: user.uid, schoolId: SID, name, code: "", createdAt: serverTimestamp() });
  const code = await issueCode({ id: ref.id, name }); await updateDoc(ref, { code });
  $("clName").value = ""; await refresh(); flash(`Section added. Classroom code: ${code}`, 1);
});
$("clTbl").onclick = (e) => run(async () => {
  const b = e.target.closest("[data-code]"); if (!b) return; const c = clsOf(b.dataset.code); if (!c) return;
  if (c.code && !confirm(`Make a new code for ${c.name}? The old code stops working for new students. Students who already joined stay in the classroom.`)) return;
  if (c.code) await deleteDoc(doc(db, "classCodes", c.code)).catch(() => {});
  const code = await issueCode(c); await updateDoc(doc(db, "classes", c.id), { code, updatedAt: serverTimestamp() });
  await refresh(); flash(`Classroom code for ${c.name}: ${code}`, 1);
});

/** Exam ID No. are unique across ALL teachers (YEAR-0001, YEAR-0002 ...), handed out by a counter so two teachers never get the same one. */
async function allocIds(n) {
  const year = new Date().getFullYear();
  const { start } = await callFn("allocIds", { year, n });
  return Array.from({ length: n }, (_, i) => `${year}-${String(start + i + 1).padStart(4, "0")}`);
}
const studentData = (p, c, id) => ({ ownerUid: user.uid, schoolId: SID, classId: c.id, className: c.name, number: id, lastName: p.last, firstName: p.first, middleInitial: p.mi || "",
  name: fullName(p.last, p.first, p.mi), birthday: p.birthday || "", email: cleanEmail(p.email), createdAt: serverTimestamp() });
/** The student's document id IS the Exam ID No. If another teacher already has that id, Firestore refuses (permission-denied) and we try the next number. */
async function createStudent(p, c) {
  let last;
  for (let k = 0; k < 5; k++) {
    const [id] = await allocIds(1);
    try { await setDoc(doc(db, "students", id), studentData(p, c, id)); return id; } catch (e) { last = e; if (e.code !== "permission-denied") throw e; }
  }
  throw last;
}
$("stBday").oninput = () => ($("stAge").value = ageOf($("stBday").value));
$("stAdd").onclick = () => run(async () => {
  const c = clsOf($("stClass").value), p = { last: $("stLast").value.trim(), first: $("stFirst").value.trim(), mi: $("stMi").value.trim().slice(0, 1).toUpperCase(), birthday: $("stBday").value, email: $("stEmail").value.trim() };
  if (!c || !p.last || !p.first) return flash("Choose a section and enter the student's last name and first name.");
  if (p.email && !cleanEmail(p.email)) return flash("That email address is not valid. Fix it or leave it blank.");
  if (!p.birthday) return flash("Enter the birthday. It is used for the age and for the student's login password.");
  const id = await createStudent(p, c);
  ["stLast", "stFirst", "stMi", "stBday", "stAge", "stEmail"].forEach((i) => ($(i).value = "")); await refresh(); $("stLast").focus();
  flash(`Added ${fullName(p.last, p.first, p.mi)} with Exam ID No. ${id}.`, 1);
});

/* ---------- student logins (Exam ID No. + birth year & first letter of last name) ---------- */
async function makeLogin(s) {
  if (!defaultStudentPassword(s)) throw new Error("Add the birthday and last name first.");
  // A real email (typed when the student was added) becomes a second way to sign in and receives reset links;
  // otherwise ONE shared inbox: IT Admin email + Exam ID No. (adminemail+2026-0001@gmail.com)
  const base = (school && school.adminEmail) || (profile.role === "admin" ? profile.email : "");
  const real = cleanEmail(s.email) || sharedEmail(base, s.number);
  if (real && studentKey(s.number) !== String(s.number).toLowerCase()) throw new Error("This Exam ID No. has unusual characters, so a real email cannot be used with it.");
  // The server checks the rules, makes the login and links it to the student.
  await callFn("createAccount", { role: "student", studentId: s.id, realEmail: real, email: real || studentEmail(s.number) });
}
$("stLogins").onclick = () => run(async () => {
  const c = clsOf($("stClass").value); if (!c) return flash("Choose a section first.");
  const todo = S.students.filter((s) => s.classId === c.id && !s.accountUid);
  if (!todo.length) return flash("Everyone in this section is already activated.", 1);
  if (!confirm(`Activate ${todo.length} student account${todo.length === 1 ? "" : "s"} in ${c.name}?\nUsername: Exam ID No. (LRN, or Student ID No.)  Password: birth year + first letter of last name.`)) return;
  $("stLogins").disabled = true; let ok = 0; const fail = [];
  try { for (const s of todo) { try { await makeLogin(s); ok++; } catch (e) { fail.push(`${s.name}: ${friendlyError(e)}`); } } }
  finally { $("stLogins").disabled = false; }
  await refresh(); flash(`Activated ${ok} account${ok === 1 ? "" : "s"}.` + (fail.length ? ` Not created: ${fail.slice(0, 3).join("; ")}${fail.length > 3 ? "..." : ""}` : ""), !fail.length);
});
$("stTbl").onclick = (e) => run(async () => {
  const u = e.target.closest("[data-unjoin]");
  if (u) {
    const j = S.joins.find((x) => x.id === u.dataset.unjoin); if (!j) return;
    if (!confirm(`Remove ${j.studentName} from ${j.className}? They will no longer see your modules. Their saved results stay in the results list.`)) return;
    await deleteDoc(doc(db, "enrollments", j.id));
    if (!S.joins.some((x) => x.id !== j.id && x.studentId === j.studentId)) await deleteDoc(doc(db, "teacherLinks", `${j.studentId}_${user.uid}`)).catch(() => {});
    await refresh(); return flash(`${j.studentName} was removed from ${j.className}.`, 1);
  }
  const b = e.target.closest("[data-rm],[data-mk]"); if (!b) return;
  const s = S.students.find((x) => x.id === (b.dataset.rm || b.dataset.mk)); if (!s) return;
  if (b.dataset.mk !== undefined) {
    await makeLogin(s);
    await refresh(); return flash(`Account activated for ${s.name}. Username ${s.number}, password ${defaultStudentPassword(s)}.`, 1);
  }
  if (!confirm(`Remove ${s.name} (${s.number}) and their login? Saved results for this student stay in the results list.`)) return;
  if (s.accountUid) await callFn("adminDeleteUser", { uid: s.accountUid }).catch(() => deleteDoc(doc(db, "users", s.accountUid)).catch(() => {}));
  await deleteDoc(doc(db, "students", s.id)); await refresh();
});

/* ---------- class-list import ---------- */
async function readTable(f) {
  if (/\.xlsx?$/i.test(f.name)) {
    if (!window.XLSX) throw new Error("The Excel reader did not load. Check your internet connection, or save the list as CSV.");
    const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: "" }).map((r) => r.map((x) => String(x).trim()));
  }
  return (await f.text()).replace(/^\ufeff/, "").split(/\r?\n/).map((l) => l.split(/[,;\t]/).map((x) => x.replace(/^"|"$/g, "").trim()));
}
function parseName(s) {
  s = s.trim(); let last, rest;
  if (s.includes(",")) { last = s.split(",")[0].trim(); rest = s.split(",").slice(1).join(" ").trim(); }
  else { const t = s.split(/\s+/); last = t.pop(); rest = t.join(" "); }
  let mi = ""; const m = /^(.*?)\s+([A-Za-z])\.?$/.exec(rest); if (m) { rest = m[1]; mi = m[2].toUpperCase(); }
  return { last, first: rest, mi };
}
function parseDate(s) {
  s = String(s || "").trim(); if (!s) return "";
  const pad = (n) => String(n).padStart(2, "0"); let m;
  if ((m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(s))) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  if ((m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/.exec(s))) {
    let [, a, b, y] = m; a = +a; b = +b; if (y.length === 2) y = (+y <= new Date().getFullYear() % 100 ? "20" : "19") + y;
    const [mo, d] = a > 12 ? [b, a] : [a, b]; return `${y}-${pad(mo)}-${pad(d)}`;
  }
  const t = new Date(s + " 12:00"); return Number.isNaN(+t) ? "" : `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}
$("stCsv").onchange = (e) => run(async () => {
  const c = clsOf($("stClass").value), f = e.target.files[0]; e.target.value = "";
  if (!c || !f) return flash("Choose a section first.");
  let rows = (await readTable(f)).filter((r) => r.some(Boolean)), col = null;
  if (rows.length && rows[0].some((x) => /name|birth|exam|\bid\b/i.test(x))) {
    col = {}; rows[0].forEach((h, i) => { const t = h.toLowerCase(); const k = /e-?mail/.test(t) ? "email" : /birth|bday|dob/.test(t) ? "bday" : /last|surname|family/.test(t) ? "last" : /first|given/.test(t) ? "first"
      : /^m\.?\s?i\.?$|middle/.test(t) ? "mi" : /exam|student|\bid\b|\bno\b/.test(t) ? "id" : /name/.test(t) ? "name" : null; if (k && !(k in col)) col[k] = i; });
    rows = rows.slice(1);
  }
  const people = rows.map((r) => {
    const g = (k) => (col ? (k in col ? r[col[k]] || "" : "") : ""); let p;
    if (col) p = ("last" in col || "first" in col) ? { id: g("id"), last: g("last"), first: g("first"), mi: g("mi"), bday: g("bday"), email: g("email") } : { id: g("id"), ...parseName(g("name")), bday: g("bday"), email: g("email") };
    else if (r.length === 1) p = { id: "", ...parseName(r[0]), bday: "" };
    else if (r.length === 2) p = { id: r[0], ...parseName(r[1]), bday: "" };
    else p = { id: r[0], last: r[1], first: r[2], mi: r[3] || "", bday: r[4] || "" };
    return { id: p.id.trim(), last: p.last.trim(), first: p.first.trim(), mi: (p.mi || "").trim().slice(0, 1).toUpperCase(), birthday: parseDate(p.bday), email: cleanEmail(p.email) };
  }).filter((p) => p.last && p.first);
  const have = new Set(S.home.map((s) => s.id)); let skipped = 0, auto = 0, nodate = 0;
  const explicit = people.filter((p) => p.id && !have.has(p.id) && have.add(p.id)), dupes = people.filter((p) => p.id).length - explicit.length;
  const blanks = people.filter((p) => !p.id), ids = blanks.length ? await allocIds(blanks.length) : [];
  blanks.forEach((p, i) => { p.id = ids[i]; auto++; });
  const ready = [...explicit, ...blanks]; let done = 0;
  for (let i = 0; i < ready.length; i += 20) {
    const res = await Promise.allSettled(ready.slice(i, i + 20).map((p) => setDoc(doc(db, "students", p.id), studentData(p, c, p.id))));
    res.forEach((r, k) => { if (r.status === "fulfilled") { done++; if (!ready[i + k].birthday) nodate++; } else skipped++; });
  }
  await refresh();
  flash(`Imported ${done} students into ${c.name} (${auto} got an automatic Exam ID No.).` + (dupes + skipped ? ` Skipped ${dupes + skipped} whose Exam ID No. already exists.` : "") + (nodate ? ` ${nodate} have no birthday yet (needed for login).` : ""), 1);
});

/* ---------- examinations: collapsible key per number ---------- */
const D = { items: [], editId: null, mode: "manual" }; // mode: manual = typed questions, link = exam paper link, paper = printed only
const mkItem = () => ({ type: "mc", key: "", pts: 1, q: "", opts: [] });
const box = $("exItems");
$("exBulkType").innerHTML = Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
const keyName = (k) => (k === "T" ? "True" : k === "F" ? "False" : k);

function rowHTML(i, open) {
  const it = D.items[i], auto = isAuto(it.type), manual = D.mode === "manual", online = D.mode !== "paper", nCh = +$("exCh").value;
  const L = "ABCDE".slice(0, nCh).split(""), chips = it.type === "tf" ? ["T", "F"] : it.type === "mc" ? L : [];
  const label = auto ? (it.key ? "Key: " + keyName(it.key) : "No key yet") : "Teacher checks";
  const refLbl = it.type === "ident" ? (online ? "Accepted answer(s): separate with | . A student answer that matches is marked correct automatically; any other waits for your check" : "Reference answer (optional, for your own checking)") : "Rubric or notes (optional)";
  const inlineKey = manual && it.type === "mc"; // typed multiple choice: the letter beside each choice marks the correct one
  const body = inlineKey ? "" : auto
    ? `<div><span class="lbl">Correct answer</span><div class="chips" role="group" aria-label="Correct answer for number ${i + 1}">${chips.map((c) => `<button type="button" class="chip ${it.key === c ? "on" : ""}" data-k="${c}" aria-pressed="${it.key === c}">${keyName(c)}</button>`).join("")}</div></div>`
    : `<label>${refLbl}<input data-f="key" value="${esc(it.key)}" maxlength="200"></label>`;
  const qBox = manual ? `<label class="wide">${it.type === "tf" ? "Statement (the student answers True or False)" : it.type === "essay" ? "Essay prompt" : "Question"}<textarea data-f="q" rows="2" maxlength="1000" placeholder="Type the ${it.type === "tf" ? "statement" : "question"} here">${esc(it.q || "")}</textarea></label>` : "";
  const oBox = inlineKey ? `<div class="wide"><span class="lbl">Choices <span class="muted fine">(click a letter to mark the correct answer)</span></span>${L.map((c, j) => `<div class="optin"><button type="button" class="chip ${it.key === c ? "on" : ""}" data-k="${c}" aria-pressed="${it.key === c}" aria-label="Mark ${c} as the correct answer">${c}</button><input data-f="opt" data-j="${j}" maxlength="300" placeholder="Choice ${c}" value="${esc((it.opts || [])[j] || "")}"></div>`).join("")}</div>` : "";
  const snip = manual && it.q ? " - " + esc(it.q.slice(0, 45)) : "";
  const rm = D.items.length > 1 ? `<div class="wide"><button type="button" class="btn small danger" data-del-q>Remove this question</button></div>` : "";
  return `<details class="it" data-i="${i}" ${open ? "open" : ""}><summary class="${auto && !it.key ? "miss" : ""}"><b>${i + 1}</b><span class="tp">${TYPE_SHORT[it.type]}<span class="qs">${snip}</span></span><span class="ky">${esc(label)}</span><span class="pt">${it.pts} pt${it.pts === 1 ? "" : "s"}</span></summary>
  <div class="ibody">${qBox}${oBox}<label>Type<select data-f="type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${k === it.type ? "selected" : ""}>${v}</option>`).join("")}</select></label>${body}
  <label>Points<input data-f="pts" type="number" min="0.5" max="100" step="0.5" value="${it.pts}"></label>${rm}</div></details>`;
}
function drawItems() {
  const open = new Set([...box.querySelectorAll("details[open]")].map((d) => +d.dataset.i));
  box.innerHTML = D.items.map((_, i) => rowHTML(i, open.has(i))).join("");
}
function redraw(i) { const d = box.children[i]; d.outerHTML = rowHTML(i, d.open); }
function setType(i, t) { const it = D.items[i]; if (it.type !== t && (isAuto(it.type) || isAuto(t))) it.key = ""; it.type = t; }
function resize(n) {
  n = Math.max(1, Math.min(MAX_ITEMS, Math.floor(+n) || 1)); $("exN").value = n;
  while (D.items.length < n) D.items.push(mkItem()); D.items.length = n; drawItems();
}
$("exN").onchange = () => resize($("exN").value);
$("exCh").onchange = () => { D.items.forEach((it) => { if (it.type === "mc" && it.key && !"ABCDE".slice(0, +$("exCh").value).includes(it.key)) it.key = ""; }); drawItems(); };
$("exOpenAll").onclick = () => box.querySelectorAll("details").forEach((d) => (d.open = true));
$("exCloseAll").onclick = () => box.querySelectorAll("details").forEach((d) => (d.open = false));
$("exBulk").onclick = () => {
  const a = +$("exFrom").value, b = +$("exTo").value, t = $("exBulkType").value;
  if (!(a >= 1 && b >= a && b <= D.items.length)) return flash(`Enter a range between 1 and ${D.items.length}.`);
  for (let i = a - 1; i < b; i++) setType(i, t);
  drawItems(); flash(`Items ${a} to ${b} are now ${TYPE_SHORT[t]}.`, 1);
};
box.addEventListener("click", (e) => {
  const rm = e.target.closest("[data-del-q]");
  if (rm) { if (D.items.length <= 1) return; D.items.splice(+rm.closest("details").dataset.i, 1); $("exN").value = D.items.length; drawItems(); return; }
  const c = e.target.closest(".chip"); if (!c) return;
  const i = +c.closest("details").dataset.i, it = D.items[i];
  it.key = it.key === c.dataset.k ? "" : c.dataset.k; redraw(i);
  if (it.key && $("exAuto").checked) {
    box.children[i].open = false; const nx = box.children[i + 1];
    if (nx) { nx.open = true; nx.scrollIntoView({ block: "nearest", behavior: "smooth" }); nx.querySelector(".chip")?.focus(); }
  } else box.children[i].querySelector(".chip.on, .chip")?.focus();
});
box.addEventListener("change", (e) => {
  const f = e.target.dataset.f, d = e.target.closest("details"); if (!f || !d) return; const i = +d.dataset.i;
  if (f === "type") { setType(i, e.target.value); redraw(i); box.children[i].querySelector("select")?.focus(); }
});
box.addEventListener("input", (e) => {
  const f = e.target.dataset.f, d = e.target.closest("details"); if (!f || !d) return; const i = +d.dataset.i, it = D.items[i];
  if (f === "pts") { it.pts = Math.max(0.5, Math.min(100, +e.target.value || 1)); d.querySelector(".pt").textContent = `${it.pts} pt${it.pts === 1 ? "" : "s"}`; }
  if (f === "key") it.key = e.target.value;
  if (f === "q") it.q = e.target.value;
  if (f === "opt") { it.opts = it.opts || []; it.opts[+e.target.dataset.j] = e.target.value; }
});
const MODE_HINT = { manual: "Write each question. Click a choice letter to mark the correct answer. Identification: type the accepted answers, separated with | .",
  link: "Students read your exam paper link beside their answer sheet. Here you only choose the correct answer for each number.",
  paper: "Choose the correct answer for each number. Print the answer sheets with the Answer sheets button, then scan them." };
function setMode(m) {
  D.mode = m; $("exOnline").checked = m !== "paper"; $("exOnlineBox").hidden = m === "paper"; $("exLinkRow").hidden = m !== "link"; $("exStepHint").textContent = MODE_HINT[m];
  document.querySelectorAll("#exMode .mode").forEach((b) => b.classList.toggle("on", b.dataset.mode === m)); drawItems();
}
$("exMode").onclick = (e) => { const b = e.target.closest(".mode"); if (b) setMode(b.dataset.mode); };
$("exAddQ").onclick = () => {
  if (D.items.length >= MAX_ITEMS) return flash(`An exam can have up to ${MAX_ITEMS} items.`);
  D.items.push(mkItem()); $("exN").value = D.items.length; drawItems();
  const d = box.lastElementChild; d.open = true; d.scrollIntoView({ block: "center", behavior: "smooth" }); d.querySelector("textarea,select")?.focus();
};
/** Examination page views: My exams / Create exam / Answer key */
function exView(v) {
  document.querySelectorAll("[data-ev]").forEach((p) => (p.hidden = p.dataset.ev !== v));
  document.querySelectorAll("#exNav [data-exv]").forEach((b) => b.classList.toggle("on", b.dataset.exv === v));
  if (v === "key") renderKey();
}
$("exNav").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.id === "exGoSheet") return show("sheet");
  if (b.dataset.exv === "create" && D.editId) resetBuilder();
  exView(b.dataset.exv);
};
function renderKey() {
  const ex = examOf($("kvExam").value), out = $("kvBody");
  if (!ex) { out.innerHTML = "<p class='muted'>Create an exam first.</p>"; return; }
  const its = itemsOf(ex), tot = its.reduce((a, b) => a + b.pts, 0);
  const keyText = (it) => it.type === "mc" ? (it.key ? it.key + (it.opts?.["ABCDE".indexOf(it.key)] ? " - " + it.opts["ABCDE".indexOf(it.key)] : "") : "-")
    : it.type === "tf" ? keyName(it.key) || "-" : it.type === "ident" ? (it.key ? it.key.split("|").map((x) => x.trim()).join("  /  ") : "Teacher checks") : (it.key ? "Teacher checks: " + it.key : "Teacher checks");
  out.innerHTML = `<h2 style="margin:0">${esc(ex.title)} - Answer key</h2><p class="muted">${[ex.subject, ex.className, ex.term, ex.date].filter(Boolean).map(esc).join(" | ")} | ${its.length} items | ${tot} points | Passing ${esc(ex.passing)}%</p>
    <div class="tablewrap"><table class="kvt"><tr><th>#</th><th>Type</th><th>Question</th><th>Correct answer</th><th>Points</th></tr>${its.map((it, i) => `<tr><td>${i + 1}</td><td>${TYPE_SHORT[it.type]}</td><td class="wrapcell">${esc(it.q || "")}</td><td class="k">${esc(keyText(it))}</td><td>${it.pts}</td></tr>`).join("")}</table></div>`;
}
$("kvExam").onchange = renderKey; $("kvPrint").onclick = () => print(); $("kvEdit").onclick = () => editExam(examOf($("kvExam").value));


/** What the student page needs, saved on each result so students never need to read the exam (and its answer key). */
const extras = (ex, missed) => ({ teacherName: profile.displayName, examTitle: ex.title, subject: ex.subject || "", term: ex.term || "", passingPct: ex.passing || 75, missedList: missed.map((m) => missedText(m, ex.online && ex.showAnswers === false)) });
async function rescore(exId, data) {
  const ex = { id: exId, ...data }, rs = await load("scanResults", where("examId", "==", exId));
  for (let i = 0; i < rs.length; i += 400) {
    const b = writeBatch(db);
    rs.slice(i, i + 400).forEach((r) => { const { missed, ...sc } = score(ex, r.answers || [], r.manual || []); b.update(doc(db, "scanResults", r.id), { ...sc, ...extras(ex, missed) }); });
    await b.commit();
  }
}
/** The student-readable copy of an online exam: questions and choices only. The answer key stays in `examinations`, which students cannot read. */
const paperOf = (data) => ({ ownerUid: user.uid, schoolId: SID, classId: data.classId, className: data.className, title: data.title, subject: data.subject || "", term: data.term || "",
  teacherName: profile.displayName, instructions: data.instructions || "", link: data.link || "", timeLimit: data.timeLimit || 0, choices: data.choices, n: data.n, totalPts: data.totalPts,
  showAnswers: data.showAnswers !== false, open: !!data.open, items: data.items.map(({ type, pts, q, opts }) => ({ type, pts, q: q || "", opts: opts || [] })), updatedAt: serverTimestamp() });
async function syncPaper(id, data) {
  if (data.online) {
    await setDoc(doc(db, "examPapers", id), paperOf(data));
    // The key copy: the server lets a student read it only AFTER their answers are submitted and locked.
    await setDoc(doc(db, "examKeys", id), { ownerUid: user.uid, schoolId: SID, choices: data.choices, passing: data.passing, showAnswers: data.showAnswers !== false,
      items: data.items.map(({ type, key, pts }) => ({ type, key, pts })), updatedAt: serverTimestamp() });
  } else { // not an online exam (or never was): nothing to remove
    await deleteDoc(doc(db, "examPapers", id)).catch(() => {}); await deleteDoc(doc(db, "examKeys", id)).catch(() => {});
  }
}
const togglePub = (id) => run(async () => {
  const ex = examOf(id); if (!ex || !ex.online) return; const open = !ex.open, b = writeBatch(db);
  b.update(doc(db, "examinations", id), { open, updatedAt: serverTimestamp() });
  b.set(doc(db, "examPapers", id), paperOf({ ...ex, open }));
  await b.commit(); await refresh();
  flash(open ? `"${ex.title}" is open. Students can see it and answer now.` : `"${ex.title}" is closed. Students can no longer submit.`, 1);
});
const deleteExam = (id) => run(async () => {
  const ex = examOf(id); if (!ex) return;
  const rs = await load("scanResults", where("examId", "==", id));
  if (!confirm(`Delete the examination "${ex.title}"${rs.length ? ` AND its ${rs.length} scanned result${rs.length === 1 ? "" : "s"}` : ""}? This cannot be undone.`)) return;
  for (let i = 0; i < rs.length; i += 400) { const b = writeBatch(db); rs.slice(i, i + 400).forEach((r) => b.delete(doc(db, "scanResults", r.id))); await b.commit(); }
  const at = await load("examAttempts", where("examId", "==", id));
  for (let i = 0; i < at.length; i += 400) { const b = writeBatch(db); at.slice(i, i + 400).forEach((r) => b.delete(doc(db, "examAttempts", r.id))); await b.commit(); }
  const sb = await load("examSubmissions", where("examId", "==", id));
  for (let i = 0; i < sb.length; i += 400) { const b = writeBatch(db); sb.slice(i, i + 400).forEach((r) => b.delete(doc(db, "examSubmissions", r.id))); await b.commit(); }
  await deleteDoc(doc(db, "examPapers", id)).catch(() => {}); await deleteDoc(doc(db, "examKeys", id)).catch(() => {});
  await deleteDoc(doc(db, "examinations", id));
  if (D.editId === id) resetBuilder();
  await refresh(); flash(`"${ex.title}" was deleted.`, 1);
});

function resetBuilder() {
  D.editId = null; D.items = []; ["exTitle", "exSub", "exDate"].forEach((i) => ($(i).value = "")); $("exPass").value = 75; $("exCh").value = 5; $("exTerm").value = store.get("ark.term") || TERMS[0];
  $("exTime").value = 0; $("exInst").value = ""; $("exLink").value = ""; $("exShow").checked = true; $("exOpen").checked = false;
  $("exHead").textContent = "New examination"; $("exAdd").textContent = "Save exam"; $("exCancel").hidden = true; setMode("manual"); resize(20); box.children[0]?.setAttribute("open", "");
}
$("exCancel").onclick = () => { resetBuilder(); exView("list"); };
$("exList").onclick = (e) => {
  const d = e.target.closest("[data-del]"); if (d) return deleteExam(d.dataset.del);
  const pb = e.target.closest("[data-pub]"); if (pb) return togglePub(pb.dataset.pub);
  const kb = e.target.closest("[data-key]"); if (kb) { exView("key"); $("kvExam").value = kb.dataset.key; return renderKey(); }
  const sb = e.target.closest("[data-sheet]"); if (sb) { show("sheet"); $("shExam").value = sb.dataset.sheet; return drawSheet(); }
  const b = e.target.closest("[data-edit]"); if (!b) return; editExam(examOf(b.dataset.edit));
};
function editExam(ex) {
  if (!ex) return;
  D.editId = ex.id; D.items = itemsOf(ex).map((x) => ({ ...x }));
  $("exTitle").value = ex.title; $("exTerm").value = ex.term || TERMS[0]; $("exSub").value = ex.subject || ""; $("exClass").value = ex.classId || ""; $("exDate").value = ex.date || "";
  $("exCh").value = ex.choices || 5; $("exPass").value = ex.passing || 75; $("exN").value = D.items.length;
  setMode(ex.online ? (ex.link ? "link" : "manual") : "paper"); $("exTime").value = ex.timeLimit || 0; $("exInst").value = ex.instructions || ""; $("exLink").value = ex.link || ""; $("exShow").checked = ex.showAnswers !== false; $("exOpen").checked = !!ex.open;
  drawItems();
  $("exHead").textContent = "Edit examination"; $("exAdd").textContent = "Update exam"; $("exCancel").hidden = false; exView("create"); scrollTo({ top: 0, behavior: "smooth" });
  flash("Editing. Saved results are re-scored automatically with the new key.", 1);
}
$("exAdd").onclick = () => run(async () => {
  const c = clsOf($("exClass").value), title = $("exTitle").value.trim(), online = D.mode !== "paper", link = D.mode === "link" ? $("exLink").value.trim() : "", nCh = +$("exCh").value;
  if (!title) return flash("Enter a title for the examination.");
  const missing = D.items.map((it, i) => (isAuto(it.type) && !it.key ? i : -1)).filter((i) => i >= 0);
  if (missing.length) {
    missing.forEach((i) => (box.children[i].open = true)); box.children[missing[0]].scrollIntoView({ block: "center", behavior: "smooth" });
    return flash(`Choose the correct answer for number ${missing.length > 8 ? missing.slice(0, 8).map((i) => i + 1).join(", ") + "..." : missing.map((i) => i + 1).join(", ")}.`);
  }
  if (D.mode === "link" && !link) return flash("Paste the link to your exam paper, or choose another way to take the exam.");
  if (link && !safeUrl(link)) return flash("The exam paper link must start with http:// or https://");
  if (D.mode === "manual") { // typed exam: students can only see what is typed here
    const bad = D.items.findIndex((it) => !String(it.q || "").trim() || (it.type === "mc" && Array.from({ length: nCh }, (_, j) => String((it.opts || [])[j] || "").trim()).some((x) => !x)));
    if (bad >= 0) {
      box.children[bad].open = true; box.children[bad].scrollIntoView({ block: "center", behavior: "smooth" });
      return flash(`Number ${bad + 1} needs its ${D.items[bad].type === "mc" ? "question and all its choices" : "question"}.`);
    }
  }
  const items = D.items.map((x) => ({ type: x.type, key: isAuto(x.type) ? x.key : String(x.key || "").trim(), pts: +x.pts > 0 ? +x.pts : 1,
    q: String(x.q || "").trim().slice(0, 1000), opts: x.type === "mc" ? Array.from({ length: nCh }, (_, j) => String((x.opts || [])[j] || "").trim().slice(0, 300)) : [] }));
  const data = { schoolId: SID, title, term: $("exTerm").value, subject: $("exSub").value.trim(), classId: c ? c.id : "", className: c ? c.name : "All sections", date: $("exDate").value,
    n: items.length, choices: nCh, passing: +$("exPass").value || 75, items, totalPts: items.reduce((a, b) => a + b.pts, 0),
    online, open: online && $("exOpen").checked, timeLimit: online ? Math.max(0, Math.min(600, Math.floor(+$("exTime").value) || 0)) : 0,
    instructions: $("exInst").value.trim().slice(0, 1000), link, showAnswers: $("exShow").checked };
  let id = D.editId;
  if (id) await updateDoc(doc(db, "examinations", id), { ...data, key: deleteField(), updatedAt: serverTimestamp() });
  else id = (await addDoc(collection(db, "examinations"), { ownerUid: user.uid, ...data, createdAt: serverTimestamp() })).id;
  await syncPaper(id, data);
  store.set("ark.term", data.term);
  if (D.editId) await rescore(D.editId, data);
  const was = D.editId; resetBuilder(); exView("list"); await refresh();
  flash(was ? "Examination updated." : online ? (data.open ? "Examination saved and open for students." : "Examination saved. Press Open in the list when you want students to see it.") : "Examination saved.", 1);
});
resetBuilder();


/* ---------- modules: files for students, organised by term / quarter ---------- */
let mdMode = "class"; // "class" = a whole section / all sections, "one" = a single student
function fillMdStudents() {
  const sec = $("mdStuSec").value, list = S.students.filter((s) => s.classId === sec).sort(byName);
  keep("mdStu", list.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.number)})</option>`).join("") || `<option value="">No students in this section</option>`);
}
function setMdMode(m) {
  mdMode = m;
  document.querySelectorAll("#mdMode [data-mdmode]").forEach((b) => b.classList.toggle("on", b.dataset.mdmode === m));
  $("mdClassL").hidden = m === "one"; $("mdStuSecL").hidden = $("mdStuL").hidden = m !== "one";
}
$("mdMode").onclick = (e) => { const b = e.target.closest("[data-mdmode]"); if (b) setMdMode(b.dataset.mdmode); };
$("mdStuSec").onchange = fillMdStudents;
$("mdAdd").onclick = () => run(async () => {
  const title = $("mdTitle").value.trim(), file = $("mdFile").files[0], url = $("mdUrl").value.trim();
  const one = mdMode === "one", stu = one ? S.students.find((s) => s.id === $("mdStu").value) : null;
  if (!title) return flash("Enter a title for the module.");
  if (one && !stu) return flash("Choose the student who should receive this module.");
  if (!file && !url) return flash("Choose a file or paste a link.");
  if (file && file.size > MAX_BYTES) return flash(`That file is ${sizeText(file.size)}. The limit is 8 MB: upload a smaller file or paste a link instead.`);
  if (!file && !safeUrl(url)) return flash("The link must start with http:// or https://");
  const c = clsOf($("mdClass").value), ref = doc(collection(db, "modules")), term = $("mdTerm").value;
  const target = one ? { classId: "__student", className: "Only: " + stu.name, studentId: stu.id, studentName: stu.name } // "__student" matches no section, so only this student can read it
    : { classId: c ? c.id : "", className: c ? c.name : "All my sections" };
  const base = { ownerUid: user.uid, schoolId: SID, teacherName: profile.displayName, title, term, ...target, description: $("mdDesc").value.trim() };
  const prog = $("mdProg"); $("mdAdd").disabled = true; prog.hidden = !file; prog.value = 0;
  let tried = 0, n = 0;
  try {
    if (file) {
      n = Math.max(1, Math.ceil(file.size / CHUNK));
      try {
        for (let i = 0; i < n; i++) { tried = i + 1; await setDoc(doc(db, "moduleChunks", `${ref.id}_${i}`), { ownerUid: user.uid, moduleId: ref.id, i, data: await b64(file.slice(i * CHUNK, (i + 1) * CHUNK)) }); prog.value = (i + 1) / n; }
      } catch (err) { await Promise.all(Array.from({ length: tried }, (_, i) => deleteDoc(doc(db, "moduleChunks", `${ref.id}_${i}`)).catch(() => {}))); throw err; }
      await setDoc(ref, { ...base, kind: "file", fileName: file.name, mime: file.type, size: file.size, chunks: n, createdAt: serverTimestamp() });
    } else await setDoc(ref, { ...base, kind: "link", url, createdAt: serverTimestamp() });
  } finally { $("mdAdd").disabled = false; prog.hidden = true; }
  store.set("ark.term", term); ["mdTitle", "mdDesc", "mdUrl", "mdFile"].forEach((i) => ($(i).value = ""));
  await refresh(); flash(one ? `Module sent to ${stu.name} only.` : "Module uploaded. Students in that section can now see it.", 1);
});
$("mdTbl").onclick = (e) => run(async () => {
  const o = e.target.closest("[data-open]"), d = e.target.closest("[data-delmd]");
  if (o) { const m = S.modules.find((x) => x.id === o.dataset.open); if (m) await openModule(db, m); return; }
  if (!d) return; const m = S.modules.find((x) => x.id === d.dataset.delmd); if (!m || !confirm(`Remove the module "${m.title}"? Students will no longer see it.`)) return;
  if (m.kind === "file") await Promise.all(Array.from({ length: m.chunks }, (_, i) => deleteDoc(doc(db, "moduleChunks", `${m.id}_${i}`)).catch(() => {})));
  await deleteDoc(doc(db, "modules", m.id)); await refresh(); flash("Module removed.", 1);
});

/* ---------- answer sheets: 8.5 x 13 in landscape, two per page ---------- */
$("school").value = store.get("ark.school") || school?.displayName || profile.schoolName || ""; $("teacher").value = store.get("ark.teacher") || profile.displayName;
function drawSheet() {
  const ex = examOf($("shExam").value), f = $("shFor").value; $("shCopiesL").hidden = f !== "blank";
  if (!ex) { $("sheetWrap").innerHTML = "<p class='muted'>Create an examination first.</p>"; $("shInfo").textContent = ""; return; }
  if (itemsOf(ex).length > MAX_ITEMS) { $("sheetWrap").innerHTML = `<p class='muted'>This sheet holds up to ${MAX_ITEMS} items.</p>`; return; }
  const list = f === "blank" ? Array.from({ length: Math.max(1, Math.min(500, +$("shCopies").value || 2)) }, () => null) : S.students.filter((s) => s.classId === f).sort(byName);
  const o = { school: $("school").value.trim(), teacher: $("teacher").value.trim() };
  let html = "";
  for (let i = 0; i < list.length; i += 2)
    html += `<div class="page"><div class="half">${sheetSVG(ex, { ...o, student: list[i] })}</div><div class="half">${i + 1 < list.length ? sheetSVG(ex, { ...o, student: list[i + 1] }) : ""}</div></div>`;
  $("sheetWrap").innerHTML = html || "<p class='muted'>This section has no students yet. Add students first.</p>";
  $("shInfo").textContent = list.length ? `${list.length} answer sheet${list.length === 1 ? "" : "s"} on ${Math.ceil(list.length / 2)} page${list.length > 2 ? "s" : ""}.` : "";
}
["shExam", "shFor", "shCopies", "school", "teacher"].forEach((i) => $(i).addEventListener("input", () => { if (i === "school") store.set("ark.school", $(i).value); if (i === "teacher") store.set("ark.teacher", $(i).value); drawSheet(); }));
const setPage = (css) => ($("pg").textContent = css);
$("shPrint").onclick = () => { drawSheet(); if (!$("sheetWrap").querySelector(".page")) return flash("Nothing to print yet."); setPage("@page{size:13in 8.5in;margin:0}"); print(); };
addEventListener("afterprint", () => setPage("@page{margin:10mm}"));

/* ---------- scanner ---------- */
let stream, R = null; // R = the sheet being reviewed {ex, items, answers, manual, flags}
/* Auto-detect + auto-capture: while the camera runs, every ~130 ms a small copy of the frame is searched for the 4 black
   corner squares. When the whole sheet is in view, big enough and holding still, the picture is taken and read by itself.
   After that the loop pauses (so a sheet being reviewed is never replaced) until the result is saved or "Rescan" is pressed. */
const AUTO = { tracker: new SheetTracker(), timer: 0, paused: false, busy: false, cool: 0, work: document.createElement("canvas"), ac: null };
const scanOpen = () => !document.querySelector('[data-s="scan"]').hidden;
const scStat = (t, cls = "") => { const el = $("scStatus"); el.textContent = t; el.className = "scstat " + cls; };
function beep() {
  try { AUTO.ac = AUTO.ac || new (window.AudioContext || window.webkitAudioContext)(); const o = AUTO.ac.createOscillator(), g = AUTO.ac.createGain();
    o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(AUTO.ac.destination); o.start(); o.stop(AUTO.ac.currentTime + 0.12); } catch {}
  try { navigator.vibrate?.(60); } catch {}
}
function drawOverlay(st, w, h) {
  const v = $("vid"), cv = $("ovl"), ew = v.clientWidth, eh = v.clientHeight; if (!ew) return;
  if (cv.width !== ew || cv.height !== eh) { cv.width = ew; cv.height = eh; }
  const x = cv.getContext("2d"); x.clearRect(0, 0, ew, eh);
  const k = Math.min(ew / v.videoWidth, eh / v.videoHeight), ox = (ew - v.videoWidth * k) / 2, oy = (eh - v.videoHeight * k) / 2, f = (v.videoWidth / w) * k;
  const P = (p) => [ox + p[0] * f, oy + p[1] * f];
  if (!st.pts) { // no sheet yet: show a guide frame the shape of the sheet
    const gh = Math.min(eh * 0.86, ew * 0.9 * 1.31), gw = gh / 1.31; x.setLineDash([10, 8]); x.lineWidth = 3; x.strokeStyle = "rgba(255,255,255,.6)";
    x.strokeRect((ew - gw) / 2, (eh - gh) / 2, gw, gh); return;
  }
  const [a, b, c, d] = st.pts.map(P), col = st.state === "ready" || st.state === "steady" ? "#22c55e" : st.state === "far" ? "#f59e0b" : "#38bdf8";
  x.setLineDash([]); x.lineWidth = 4; x.strokeStyle = col; x.fillStyle = col + "33";
  x.beginPath(); x.moveTo(...a); x.lineTo(...b); x.lineTo(...d); x.lineTo(...c); x.closePath(); x.fill(); x.stroke();
  x.fillStyle = col; [a, b, c, d].forEach(([px, py]) => { x.beginPath(); x.arc(px, py, 7, 0, 7); x.fill(); });
  if (st.progress > 0) { // progress bar along the bottom edge of the sheet
    x.lineWidth = 7; x.strokeStyle = "#fff"; x.beginPath(); x.moveTo(c[0], c[1]); x.lineTo(c[0] + (d[0] - c[0]) * st.progress, c[1] + (d[1] - c[1]) * st.progress); x.stroke();
  }
}
function liveStep() {
  const v = $("vid");
  if (!stream || AUTO.paused || AUTO.busy || !$("autoCap").checked || !v.videoWidth || !scanOpen() || document.hidden) return;
  if (performance.now() < AUTO.cool) return;
  if (!$("scExam").value) { scStat("Choose the examination first."); $("ovl").getContext("2d").clearRect(0, 0, 9999, 9999); return; }
  const k = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight)), w = Math.round(v.videoWidth * k), h = Math.round(v.videoHeight * k), cv = AUTO.work;
  cv.width = w; cv.height = h; const ctx = cv.getContext("2d", { willReadFrequently: true }); ctx.drawImage(v, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data, g = new Uint8ClampedArray(w * h);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
  const det = findCorners(g, w, h), st = AUTO.tracker.update(det, w, h, performance.now());
  drawOverlay(st, w, h);
  if (st.state === "none") scStat(st.seen >= 2 ? "Show all 4 black corner squares of the sheet." : "Looking for the answer sheet...");
  else if (st.state === "far") scStat("Sheet found. Move closer so it fills more of the screen.", "warn");
  else if (st.state === "moving") scStat("Sheet found. Hold it steady...", "go");
  else if (st.state === "steady") scStat("Hold steady...", "go");
  else { AUTO.busy = true; scStat("Captured. Reading the sheet...", "go"); autoCapture(); }
}
async function autoCapture() {
  try {
    beep(); $("vidwrap").classList.remove("flash"); void $("vidwrap").offsetWidth; $("vidwrap").classList.add("flash");
    const ok = grab($("vid"), $("vid").videoWidth, $("vid").videoHeight, true);
    if (ok) { AUTO.paused = true; scStat("Sheet read. Check the answers below, then save.", "go"); }
    else { AUTO.cool = performance.now() + 2500; AUTO.tracker.reset(); }  // could not read it: try again from a fresh look after a short pause
  } finally { AUTO.busy = false; }
}
function resumeAuto(msg) { AUTO.paused = false; AUTO.cool = performance.now() + 600; AUTO.tracker.reset(); if (stream) scStat(msg || "Place the next answer sheet in view."); }
function stopCamera() {
  clearInterval(AUTO.timer); stream?.getTracks().forEach((t) => t.stop()); stream = null; $("vid").srcObject = null;
  $("vidwrap").hidden = true; $("capBtn").disabled = true; $("camBtn").textContent = "Start camera";
}
$("camBtn").onclick = async () => {
  if (stream) return stopCamera();
  try {
    try { AUTO.ac = AUTO.ac || new (window.AudioContext || window.webkitAudioContext)(); AUTO.ac.resume?.(); } catch {}   // created on the click so the capture beep is allowed later
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    $("vid").srcObject = stream; $("vidwrap").hidden = false; $("capBtn").disabled = false; $("camBtn").textContent = "Stop camera";
    try { await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch {}   // keep the sheet sharp where the phone allows it
    AUTO.paused = !!(R && !$("review").hidden); AUTO.tracker.reset();
    scStat(AUTO.paused ? "Finish the sheet below, or press Rescan." : "Looking for the answer sheet...");
    clearInterval(AUTO.timer); AUTO.timer = setInterval(liveStep, 130);
  } catch { flash("Camera unavailable. Allow camera access (HTTPS is required) or upload a photo."); }
};
$("autoCap").onchange = () => { AUTO.tracker.reset(); if ($("autoCap").checked) { resumeAuto(); } else { $("ovl").getContext("2d").clearRect(0, 0, 9999, 9999); scStat("Auto-capture is off. Press Capture now."); } };
$("capBtn").onclick = () => { AUTO.paused = true; if (!grab($("vid"), $("vid").videoWidth, $("vid").videoHeight)) resumeAuto("Could not read the sheet. Adjust and try again."); else scStat("Sheet read. Check the answers below, then save.", "go"); };
$("scAgain").onclick = () => { $("review").hidden = true; $("cv").hidden = true; R = null; resumeAuto(); };
$("file").onchange = (e) => { const f = e.target.files[0]; if (!f) return; const im = new Image(); im.onload = () => grab(im, im.naturalWidth, im.naturalHeight); im.src = URL.createObjectURL(f); e.target.value = ""; };
$("scExam").onchange = () => { const ex = examOf($("scExam").value); if (ex?.classId) $("scSec").value = ex.classId; fillStudents(); };
$("scSec").onchange = () => fillStudents($("scStu").value);

function grab(src, w0, h0, auto) {
  const ex = examOf($("scExam").value); if (!ex) return void flash("Choose an examination first.");
  if (!w0) return void flash("The camera is not ready yet.");
  const k = Math.min(1, (auto ? 1800 : 1400) / Math.max(w0, h0)), w = Math.round(w0 * k), h = Math.round(h0 * k), cv = $("cv");
  cv.width = w; cv.height = h; const ctx = cv.getContext("2d", { willReadFrequently: true }); ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data, g = new Uint8ClampedArray(w * h);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
  cv.hidden = false; const r = scanSheet(g, w, h, ex, ctx);
  if (r.err) { $("review").hidden = true; if (auto) scStat(r.err, "warn"); flash(r.err); return false; }
  const items = itemsOf(ex);
  R = { ex, items, answers: r.answers, manual: items.map(() => null), flags: r.flags };
  $("reviewNote").hidden = true; $("review").hidden = false; $("scId").value = ""; $("scHint").textContent = ""; fillStudents(); drawReview();
  if (r.flags.some(Boolean)) flash("Some answers are uncertain (highlighted). Check them against the paper before saving.");
  else if (items.some((i) => !isAuto(i.type))) flash("Scanned. Now mark the identification and essay items below.", 1);
  if (stream) AUTO.paused = true;   // a sheet is on screen for review: do not replace it until it is saved or "Rescan" is pressed
  return true;
}
function fillStudents(keepId) {
  const sec = $("scSec").value, list = S.students.filter((s) => !sec || s.classId === sec).sort(byName);
  $("scStu").innerHTML = '<option value="">Choose student</option>' + list.map((s) => `<option value="${esc(s.id)}">${esc(s.number)} - ${esc(s.name)}${sec ? "" : " (" + esc(s.className) + ")"}</option>`).join("");
  if (keepId) $("scStu").value = keepId;
}
$("scId").addEventListener("input", () => {
  const v = $("scId").value.trim().toLowerCase(), s = v && S.students.find((x) => String(x.number).toLowerCase() === v);
  if (s) { if ($("scSec").value && $("scSec").value !== s.classId) $("scSec").value = s.classId; fillStudents(s.id); $("scHint").textContent = `${s.name}, ${s.className}`; }
  else $("scHint").textContent = v ? "No student has this Exam ID No." : "";
});

function drawReview() {
  const { ex, items, answers, manual, flags } = R;
  $("grid").innerHTML = items.map((it, i) => {
    const n = `<span class="qn">${i + 1}.</span>`, m = manual[i];
    if (isAuto(it.type)) return `<div class="${flags[i] ? "bad" : ""}">${n}<select data-i="${i}" data-k="a" aria-label="Answer ${i + 1}"><option value="">blank</option>${lettersOf(it, ex).map((c) => `<option ${answers[i] === c ? "selected" : ""}>${c}</option>`).join("")}<option value="*" ${answers[i] === "*" ? "selected" : ""}>multiple</option></select></div>`;
    if (it.type === "ident") return `<div class="man ${m == null ? "pend" : ""}">${n}<select data-i="${i}" data-k="m" aria-label="Identification ${i + 1}"><option value="">Ident: check</option><option value="1" ${m != null && m >= it.pts ? "selected" : ""}>Correct</option><option value="0" ${m === 0 ? "selected" : ""}>Wrong</option></select></div>`;
    return `<div class="man ${m == null ? "pend" : ""}">${n}<input type="number" data-i="${i}" data-k="m" min="0" max="${it.pts}" step="0.5" value="${m ?? ""}" placeholder="Essay /${it.pts}" aria-label="Essay ${i + 1} points"></div>`;
  }).join("");
  drawTyped(); sumUp();
}
function drawTyped() {
  const items = R.items, html = (R.typed || []).map((t, i) => (t && items[i] && !isAuto(items[i].type)
    ? `<div class="typed"><b>#${i + 1}</b> <span class="muted">${esc(items[i].q || TYPE_SHORT[items[i].type])}</span><p>${esc(t)}</p>${items[i].key ? `<small>${items[i].type === "ident" ? "Accepted" : "Notes"}: ${esc(items[i].key)}</small>` : ""}</div>` : "")).join("");
  $("typedBox").hidden = !html; $("typedList").innerHTML = html;
}
function sumUp() {
  const s = score(R.ex, R.answers, R.manual);
  $("sum").innerHTML = `<b>Score ${s.points}/${s.maxPoints} (${s.pct}%) - ${s.final ? (s.pass ? "Passed" : "Failed") : "Not final yet"}</b> &nbsp; Wrong ${s.wrong + s.multi}, blank ${s.blank}` + (s.pending ? `, <b>${s.pending} item${s.pending === 1 ? "" : "s"} still to check by you</b>` : "");
}
$("grid").addEventListener("change", (e) => {
  const t = e.target, i = +t.dataset.i; if (!t.dataset.k || Number.isNaN(i)) return;
  if (t.dataset.k === "a") { R.answers[i] = t.value; R.flags[i] = false; t.parentElement.classList.remove("bad"); }
  else { const it = R.items[i]; const v = t.value === "" ? null : t.tagName === "SELECT" ? (t.value === "1" ? it.pts : 0) : Math.min(it.pts, Math.max(0, +t.value)); R.manual[i] = v; t.parentElement.classList.toggle("pend", v === null); }
  sumUp();
});
$("scSave").onclick = () => run(async () => {
  const stu = S.students.find((s) => s.id === $("scStu").value); if (!stu) return flash("Choose the student this sheet belongs to (or type the Exam ID No.).");
  const id = `${R.ex.id}_${stu.id}`, ref = doc(db, "scanResults", id), old = await getDoc(ref);
  if (old.exists() && !confirm(`${stu.name} already has a result for this exam. Replace it?`)) return;
  const { missed, ...sc } = score(R.ex, R.answers, R.manual);
  $("scSave").disabled = true;
  try {
    const payload = { ownerUid: user.uid, schoolId: SID, examId: R.ex.id, studentId: stu.id, studentName: stu.name, studentNumber: stu.number, classId: stu.classId, className: stu.className,
      answers: R.answers, manual: R.manual, ...sc, ...extras(R.ex, missed), reviewedFlags: R.flags.filter(Boolean).length, scannedAt: serverTimestamp() };
    if (R.editing) await setDoc(ref, payload, { merge: true }); // keeps the online fields (typed answers, time, "online" mark)
    else await setDoc(ref, payload);
    flash(`Saved result for ${stu.name}.`, 1); $("review").hidden = true; $("cv").hidden = true; R = null; resumeAuto("Saved. Place the next answer sheet in view.");
  } finally { $("scSave").disabled = false; }
});

/* ---------- results ---------- */
const secName = (r) => r.className || "-";
const CMP = {
  sec_name: (a, b) => secName(a).localeCompare(secName(b)) || a.studentName.localeCompare(b.studentName),
  sec_score: (a, b) => secName(a).localeCompare(secName(b)) || b.sc.pct - a.sc.pct || a.studentName.localeCompare(b.studentName),
  score: (a, b) => b.sc.pct - a.sc.pct || a.studentName.localeCompare(b.studentName),
  wrong: (a, b) => b.sc.missed.length - a.sc.missed.length || a.studentName.localeCompare(b.studentName),
  name: (a, b) => a.studentName.localeCompare(b.studentName),
  name_desc: (a, b) => b.studentName.localeCompare(a.studentName),
  sec_name_desc: (a, b) => secName(a).localeCompare(secName(b)) || b.studentName.localeCompare(a.studentName),
  id: (a, b) => String(a.studentNumber).localeCompare(String(b.studentNumber), undefined, { numeric: true }),
};
const status = (s) => (s.final ? (s.pass ? "Pass" : "Fail") : "To check");
let VIEW = { ex: null, list: [] };

async function loadResults() {
  await run(async () => {
    const ex = examOf($("reExam").value); if (!ex) { S.results = []; return renderResults(); }
    const items = itemsOf(ex);
    S.results = await Promise.all((await load("scanResults", where("examId", "==", ex.id))).map(async (r) => {
      const stu = S.students.find((s) => s.id === r.studentId); // older results have no section saved
      let manual = r.manual || [], late = false;
      if (r.via === "online") {
        manual = items.map((_, i) => manual[i] ?? null); let changed = false;
        items.forEach((it, i) => { if (it.type === "ident" && manual[i] == null && identMatches(it, (r.answers || [])[i])) { manual[i] = it.pts; changed = true; } });
        const { missed, ...fresh } = score(ex, r.answers || [], manual);
        if (changed || fresh.points !== r.points || fresh.pct !== r.pct || fresh.final !== r.final) // save the corrected score so the student sees it too
          await updateDoc(doc(db, "scanResults", r.id), { manual, ...fresh, ...extras(ex, missed) }).catch(() => {});
        late = +ex.timeLimit > 0 && !!r.startedAt?.toMillis && !!r.submittedAt?.toMillis && r.submittedAt.toMillis() - r.startedAt.toMillis() > (ex.timeLimit * 60 + 120) * 1000;
      }
      return { ...r, manual, late, classId: r.classId ?? stu?.classId ?? "", className: r.className ?? stu?.className ?? "-", sc: score(ex, r.answers || [], manual) };
    }));
    renderResults();
  });
}
function renderResults() {
  const ex = examOf($("reExam").value), items = ex ? itemsOf(ex) : [];
  if (!ex) { $("reTbl").innerHTML = ""; $("stats").textContent = "Create an examination first."; $("items").innerHTML = ""; VIEW = { ex: null, list: [] }; return; }
  const ranked = [...S.results].sort((a, b) => b.sc.pct - a.sc.pct); ranked.forEach((r, i) => (r.rank = i && ranked[i - 1].sc.pct === r.sc.pct ? ranked[i - 1].rank : i + 1));
  const sec = $("reSec").value, sort = $("reSort").value;
  const list = S.results.filter((r) => !sec || r.classId === sec).sort(CMP[sort]); VIEW = { ex, list };
  const pcts = list.map((r) => r.sc.pct), avg = pcts.length ? (pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(1) : "-";
  $("stats").textContent = list.length ? `Scanned ${list.length} | Average ${avg}% | Highest ${Math.max(...pcts)}% | Lowest ${Math.min(...pcts)}% | Passed ${list.filter((r) => r.sc.pass).length}` : "No results yet for this selection.";
  const wt = $("waiting");
  if (ex.online) { // who has not submitted yet
    const done = new Set(S.results.map((r) => r.studentId)), late = S.students.filter((s) => (!ex.classId || s.classId === ex.classId) && !done.has(s.id)).sort(byName);
    wt.hidden = false; wt.innerHTML = `<p class="muted fine">Online exam: ${ex.open ? "open" : "closed"}. ${S.results.length} submitted${late.length ? `, ${late.length} not yet.` : ", everyone has submitted."}</p>` +
      (late.length ? `<details><summary>Not yet submitted (${late.length})</summary><p class="fine">${late.map((s) => esc(s.name) + (ex.classId ? "" : ` <span class="muted">(${esc(s.className)})</span>`)).join("; ")}</p></details>` : "");
  } else { wt.hidden = true; wt.innerHTML = ""; }
  const grouped = sort.startsWith("sec_"); let last = null, rows = "";
  for (const r of list) {
    if (grouped && secName(r) !== last) { last = secName(r); const g = list.filter((x) => secName(x) === last); rows += `<tr class="grp"><td colspan="9">${esc(last)} - ${g.length} student${g.length === 1 ? "" : "s"}, average ${(g.reduce((a, b) => a + b.sc.pct, 0) / g.length).toFixed(1)}%</td></tr>`; }
    const s = r.sc;
    rows += `<tr class="${s.final ? "" : "pend"}"><td>${r.rank}</td><td>${esc(r.studentNumber)}</td><td>${esc(r.studentName)}</td><td>${esc(secName(r))}</td><td>${s.points}/${s.maxPoints}</td><td>${s.pct}</td><td>${status(s)}${r.via === "online" ? ' <span class="badge">Online</span>' : ""}${r.late ? ' <span class="badge warn">Late</span>' : ""}</td>
      <td class="wrapcell">${s.missed.length ? `<b>${s.missed.length}</b> ` + s.missed.map((m) => `<span class="wr">${esc(missedText(m))}</span>`).join("") : "None"}${s.pending ? ` <span class="badge warn">${s.pending} to check</span>` : ""}</td>
      <td class="actions"><button class="btn small" data-edit="${esc(r.id)}">${s.pending ? "Check" : "Edit"}</button>${r.via === "online" ? `<button class="btn small danger" data-retake="${esc(r.id)}">Retake</button>` : ""}</td></tr>`;
  }
  $("reTbl").innerHTML = "<tr><th>Rank</th><th>Exam ID No.</th><th>Name</th><th>Section</th><th>Score</th><th>%</th><th>Status</th><th>Wrong answers (student answer → correct)</th><th></th></tr>" + (rows || "<tr><td colspan=9>No results yet.</td></tr>");
  $("items").innerHTML = items.map((it, i) => {
    const done = list.filter((r) => isAuto(it.type) || (r.manual || [])[i] != null);
    const ok = done.filter((r) => !r.sc.missed.some((m) => m.i === i)).length;
    return `<div>Q${i + 1} (${isAuto(it.type) ? esc(keyName(it.key)) : TYPE_SHORT[it.type]}): ${done.length ? Math.round((ok / done.length) * 100) + "%" : "-"}</div>`;
  }).join("");
}
["reExam"].forEach((i) => ($(i).onchange = loadResults)); ["reSec", "reSort"].forEach((i) => ($(i).onchange = renderResults));
$("reTbl").onclick = (e) => {
  const rt = e.target.closest("[data-retake]");
  if (rt) return run(async () => {
    const r = S.results.find((x) => x.id === rt.dataset.retake); if (!r) return;
    if (!confirm(`Let ${r.studentName} take this exam again? Their submitted answers and score are deleted and they can start over.`)) return;
    await deleteDoc(doc(db, "scanResults", r.id)); await deleteDoc(doc(db, "examAttempts", r.id)).catch(() => {}); await deleteDoc(doc(db, "examSubmissions", r.id)).catch(() => {});
    await loadResults(); flash(`${r.studentName} can take the exam again.`, 1);
  });
  const b = e.target.closest("[data-edit]"); if (!b) return; const r = S.results.find((x) => x.id === b.dataset.edit); if (!r) return;
  const ex = examOf(r.examId), items = itemsOf(ex);
  R = { ex, items, answers: items.map((_, i) => (r.answers || [])[i] ?? ""), manual: items.map((_, i) => (r.manual || [])[i] ?? null), flags: items.map(() => false), typed: items.map((it, i) => (r.via === "online" && !isAuto(it.type) ? String((r.answers || [])[i] || "") : "")), editing: true };
  show("scan"); $("scExam").value = ex.id; $("scSec").value = ""; fillStudents(r.studentId); $("scId").value = r.studentNumber; $("scHint").textContent = "";
  $("cv").hidden = true; $("review").hidden = false; $("reviewNote").hidden = false;
  $("reviewNote").textContent = `Editing the saved result of ${r.studentName}. Mark the items you check by hand, then press Save result.`; drawReview(); scrollTo({ top: 0 });
};

/* ---------- Excel download ---------- */
const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, "-").trim() || "exam";
function sheetOf(rows, widths) { const ws = XLSX.utils.aoa_to_sheet(rows); ws["!cols"] = widths.map((w) => ({ wch: w })); return ws; }
$("xlsx").onclick = () => run(async () => {
  const { ex, list } = VIEW; if (!ex || !list.length) return flash("No results to export.");
  if (!window.XLSX) return flash("The Excel library did not load. Check your internet connection and reload the page.");
  const items = itemsOf(ex), kind = (it) => TYPE_SHORT[it.type], ans = (m) => (isAuto(m.type) ? (m.given === "" ? "(blank)" : m.given === "*" ? "(multiple)" : m.given) : m.awarded);
  const wb = XLSX.utils.book_new(), head = ["Rank", "Exam ID No.", "Name", "Section", "Points", "Max points", "Percent", "Status", "Number wrong", "Blank", "Multiple answers", "To check by teacher", "Wrong items (student answer → correct)"];
  const line = (r, rank) => [rank, r.studentNumber, r.studentName, secName(r), r.sc.points, r.sc.maxPoints, r.sc.pct, status(r.sc), r.sc.missed.length, r.sc.blank, r.sc.multi, r.sc.pending, r.sc.missed.map(missedText).join(", ")];
  const meta = [[ex.title], [`Subject: ${ex.subject || "-"}`, `Date: ${ex.date || "-"}`, `Teacher: ${profile.displayName}`, `Passing: ${ex.passing}%`], []];
  const w = [6, 14, 28, 20, 8, 10, 9, 9, 12, 7, 10, 12, 70];
  XLSX.utils.book_append_sheet(wb, sheetOf([...meta, head, ...list.map((r) => line(r, r.rank))], w), "All results");
  // Wrong answers: one row per missed item (this is the specification of where each student went wrong)
  const wrong = [["Section", "Exam ID No.", "Name", "Item no.", "Type", "Student answer", "Correct answer", "Points earned", "Points possible"]];
  list.forEach((r) => r.sc.missed.forEach((m) => wrong.push([secName(r), r.studentNumber, r.studentName, m.i + 1, kind(items[m.i]), ans(m), isAuto(m.type) ? m.key : "(teacher checked)", m.awarded, m.pts])));
  XLSX.utils.book_append_sheet(wb, sheetOf(wrong, [20, 14, 28, 9, 15, 15, 15, 12, 14]), "Wrong answers");
  // Item analysis
  const ia = [["Item no.", "Type", "Correct answer", "Points", "Students counted", "Got it right", "% correct"]];
  items.forEach((it, i) => { const done = list.filter((r) => isAuto(it.type) || (r.manual || [])[i] != null), ok = done.filter((r) => !r.sc.missed.some((m) => m.i === i)).length;
    ia.push([i + 1, kind(it), isAuto(it.type) ? it.key : "(teacher checked)", it.pts, done.length, ok, done.length ? Math.round((ok / done.length) * 1000) / 10 : ""]); });
  XLSX.utils.book_append_sheet(wb, sheetOf(ia, [9, 15, 16, 8, 16, 13, 10]), "Item analysis");
  // One sheet per section, ranked inside the section
  const used = new Set(["All results", "Wrong answers", "Item analysis"]);
  [...new Set(list.map(secName))].sort().forEach((sn) => {
    const g = list.filter((r) => secName(r) === sn).sort(CMP.score), rk = []; g.forEach((r, i) => rk.push(i && g[i - 1].sc.pct === r.sc.pct ? rk[i - 1] : i + 1)); let name = safe(sn).slice(0, 28), n = 2; while (used.has(name)) name = safe(sn).slice(0, 26) + " " + n++; used.add(name);
    XLSX.utils.book_append_sheet(wb, sheetOf([[ex.title + " - " + sn], [], head, ...g.map((r, i) => line(r, rk[i]))], w), name);
  });
  XLSX.writeFile(wb, `${safe(ex.title)}-results.xlsx`);
});

show("classes");
refresh();
