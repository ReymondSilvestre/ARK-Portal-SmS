/* Registrar > Sections & advisers > Make schedule.
   A class schedule maker (semesters, weekly grid, drag and drop, conflict checks, break times, daily hour limit, print / Excel),
   modelled on the ARK Class Schedule app but stored in THIS portal's Google Sheet (tabs: scheduleSemesters, classSchedules, scheduleSettings)
   - no Firebase. "Send" makes the schedule visible to the teachers (their own classes) and to the students (their own section). */
import { requireRole, db, esc } from "./auth.js";
import { collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, writeBatch, serverTimestamp } from "./db.js";
import { showPopup, errText } from "./leave.js";
import { DAYS, SHORT, toMin, toHm, ampm, hours, teacherKey, up, byTime, breaksFor, gridHtml, printPages, exportXlsx } from "./schedule-view.js";

const root = document.getElementById("schedRoot");
if (root) boot();

async function boot() {
  const { user, profile, school } = await requireRole(["registrar"]);
  const SID = profile.schoolId;
  const $ = (id) => document.getElementById(id);
  const S = { sems: [], semId: "", entries: [], sections: [], teachers: [], lists: { subjects: [], rooms: [] }, loaded: false, loading: false, tab: "encode", editId: "", mode: "section", pick: "", q: "", dragOff: 0,
    form: { section: "", subject: "", teacher: "", other: "", room: "", days: [], start: "07:00", end: "08:00" } };
  const sem = () => S.sems.find((x) => x.id === S.semId) || null;
  const flash = (t, ok) => { const m = $("msg"); if (!m) return alert(t); m.textContent = t; m.className = "notice noprint " + (ok ? "ok" : "err"); m.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => (m.hidden = true), 9000); scrollTo({ top: 0, behavior: "smooth" }); };
  const run = async (fn) => { try { await fn(); } catch (e) { console.error(e); flash(errText(e)); } };
  const schoolYearNow = () => { const d = new Date(), y = d.getFullYear(); return d.getMonth() >= 5 ? `${y}-${y + 1}` : `${y - 1}-${y}`; };
  const rid = () => Math.random().toString(36).slice(2, 9);
  const tsMs = (x) => (x && x.toMillis ? x.toMillis() : 0);

  /* ---------- data ---------- */
  async function loadBase() {
    const [cls, tch, sems, set] = await Promise.all([
      getDocs(query(collection(db, "classes"), where("schoolId", "==", SID))),
      getDocs(query(collection(db, "users"), where("schoolId", "==", SID), where("role", "==", "teacher"))),
      getDocs(query(collection(db, "scheduleSemesters"), where("schoolId", "==", SID))),
      getDoc(doc(db, "scheduleSettings", SID)).catch(() => null),
    ]);
    S.sections = cls.docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => c.gradeLevel).sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
    S.teachers = tch.docs.map((d) => ({ uid: d.id, ...d.data() })).filter((t) => t.status === "active").sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
    S.sems = sems.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt));
    if (set && set.exists()) { const d = set.data(); S.lists.subjects = d.subjects || []; S.lists.rooms = d.rooms || []; }
    if (!S.sems.some((x) => x.id === S.semId)) S.semId = (S.sems.find((x) => x.published) || S.sems[0] || {}).id || "";
    await loadEntries();
  }
  async function loadEntries() {
    S.entries = S.semId ? (await getDocs(query(collection(db, "classSchedules"), where("schoolId", "==", SID), where("semesterId", "==", S.semId)))).docs.map((d) => ({ id: d.id, ...d.data() })) : [];
  }
  async function reload() { await loadBase(); render(); }
  async function logEvent(action, label, note) {
    try { await setDoc(doc(collection(db, "registrarLog")), { schoolId: SID, at: serverTimestamp(), byUid: user.uid, byName: profile.displayName || "", byNo: profile.employeeId || "", action, target: "schedule", label: String(label).slice(0, 200), note: String(note || "").slice(0, 400), changes: [], items: [] }); } catch (e) { console.warn("History entry not saved", e); }
  }
  async function chunked(ops) {          // the server accepts up to 500 changes per request
    for (let i = 0; i < ops.length; i += 400) { const b = writeBatch(); ops.slice(i, i + 400).forEach((f) => f(b)); await b.commit(); }
  }

  /* ---------- rules the schedule must obey ---------- */
  const limit = () => +(sem() || {}).dailyHourLimit || 8;
  const enforce = () => !sem() || sem().enforceLimit !== false;
  function conflicts(n, ignore) {
    const a = toMin(n.start), b = toMin(n.end), out = [];
    if (b <= a) return ["The end time must be after the start time."];
    S.entries.forEach((x) => {
      if (x.id === ignore || x.day !== n.day || !(a < toMin(x.end) && b > toMin(x.start))) return;
      const when = `${x.day} ${ampm(x.start)} - ${ampm(x.end)}`;
      if (teacherKey(n) && teacherKey(n) === teacherKey(x)) out.push(`Teacher conflict: ${x.teacherName} already teaches ${x.subject} to ${x.sectionName} (${when}).`);
      if (n.room && x.room && up(n.room) === up(x.room)) out.push(`Room conflict: ${x.room} is used by ${x.sectionName} for ${x.subject} (${when}).`);
      if (n.sectionId === x.sectionId) out.push(`Section conflict: ${x.sectionName} already has ${x.subject} (${when}).`);
    });
    return out;
  }
  function dayHours(n, ignore, extra = 0) {
    if (!teacherKey(n)) return 0;
    return S.entries.filter((x) => x.id !== ignore && x.day === n.day && teacherKey(x) === teacherKey(n)).reduce((s, x) => s + hours(x.start, x.end), 0) + hours(n.start, n.end) + extra;
  }
  function breakHit(n) {
    const s = sem(); if (!s) return null; const a = toMin(n.start), b = toMin(n.end);
    return (s.breaks || []).find((k) => (k.days === "all" || !k.days || k.days === n.day) && (k.scope === "all" || !k.scope || (k.scope === "section" && up(k.scopeValue) === up(n.sectionName)) ||
      (k.scope === "teacher" && up(k.scopeValue) === up(n.teacherName)) || (k.scope === "room" && up(k.scopeValue) === up(n.room))) && a < toMin(k.end) && b > toMin(k.start)) || null;
  }
  const subjectsAll = () => [...new Set([...S.lists.subjects, ...S.entries.map((e) => e.subject)].filter(Boolean))].sort();
  const roomsAll = () => [...new Set([...S.lists.rooms, ...S.entries.map((e) => e.room)].filter(Boolean))].sort();

  /* ---------- page ---------- */
  function render() {
    const s = sem();
    if (!S.sems.length) {
      root.innerHTML = `<h2>Make schedule</h2><p class="muted">No semester yet. A semester holds one complete class schedule (for example <b>1st Semester ${schoolYearNow()}</b>).</p><button class="btn primary" data-act="newSem">Create the first semester</button>`;
      return;
    }
    const sent = s && s.published;
    root.innerHTML = `<h2>Make schedule</h2>
    <p class="muted fine">Build the weekly class schedule of every section. When it is ready, press <b>Send</b>: each <b>teacher</b> sees his or her own classes on the Teacher page, and each <b>student</b> sees the schedule of the section they are in.</p>
    <div class="sc-bar noprint"><label>Semester<select id="scSem">${S.sems.map((x) => `<option value="${esc(x.id)}"${x.id === S.semId ? " selected" : ""}>${esc(x.name)}${x.published ? " (sent)" : ""}</option>`).join("")}</select></label>
      <button class="btn small" data-act="newSem">New</button><button class="btn small" data-act="copySem">Copy</button><button class="btn small danger" data-act="delSem">Delete</button>
      <span class="badge ${sent ? "active" : "warn"}">${sent ? "Sent to teachers and students" : "Not sent yet"}</span>
      ${sent ? `<button class="btn small" data-act="unsend">Withdraw</button><button class="btn small primary" data-act="send">Send again</button>` : `<button class="btn primary" data-act="send">Send to teachers and students</button>`}</div>
    ${sent ? `<p class="muted fine noprint">This schedule is live: changes you save now show to teachers and students right away.</p>` : ""}
    <div class="sc-tabs noprint">${[["encode", "Add a class"], ["view", "Weekly schedule"], ["list", "All classes (" + S.entries.length + ")"], ["breaks", "Break times and limits"], ["lists", "Subjects and rooms"]].map(([k, l]) => `<button class="btn${S.tab === k ? " on" : ""}" data-tab="${k}">${l}</button>`).join("")}</div>
    <div id="scBody"></div>`;
    body();
  }
  function body() { const el = $("scBody"); if (!el) return; el.innerHTML = { encode: encodeHtml, view: viewHtml, list: listHtml2, breaks: breaksHtml, lists: listsHtml }[S.tab](); }

  /* --- add / edit a class --- */
  function encodeHtml() {
    const f = S.form, ed = S.editId ? S.entries.find((x) => x.id === S.editId) : null;
    const ready = S.sections.length > 0;
    return `<div class="sc-card"><h3>${ed ? "Edit this class" : "Add a class"}</h3>
    ${S.sections.length ? "" : `<p class="notice err">There is no section yet. Add the sections first (<b>Add a section</b>), then come back here.</p>`}
    <div class="row"><label>Section<select id="fSection"><option value="">- choose -</option>${S.sections.map((x) => `<option value="${esc(x.id)}"${f.section === x.id ? " selected" : ""}>${esc(x.name)}${x.adviserName ? " (adviser: " + esc(x.adviserName) + ")" : ""}</option>`).join("")}</select></label>
      <label>Subject<input id="fSubject" list="dlSubj" value="${esc(f.subject)}" maxlength="80" autocomplete="off" placeholder="e.g. Mathematics 7"><datalist id="dlSubj">${subjectsAll().map((x) => `<option value="${esc(x)}">`).join("")}</datalist></label></div>
    <div class="row"><label>Teacher<select id="fTeacher"><option value="">- no teacher yet -</option>${S.teachers.map((t) => `<option value="${esc(t.uid)}"${f.teacher === t.uid ? " selected" : ""}>${esc(t.displayName)}</option>`).join("")}<option value="__other"${f.teacher === "__other" ? " selected" : ""}>Other (no portal account) - type the name</option></select></label>
      <label id="fOtherWrap"${f.teacher === "__other" ? "" : " hidden"}>Teacher name<input id="fOther" value="${esc(f.other)}" maxlength="120" autocomplete="off"><small>This teacher will not see the schedule in the portal.</small></label>
      <label>Room<input id="fRoom" list="dlRoom" value="${esc(f.room)}" maxlength="60" autocomplete="off" placeholder="e.g. Room 101"><datalist id="dlRoom">${roomsAll().map((x) => `<option value="${esc(x)}">`).join("")}</datalist></label></div>
    <div class="row"><fieldset class="sc-days"><legend>${ed ? "Day" : "Days (tick every day of the class)"}</legend>${DAYS.map((d) => `<label class="sc-chk"><input type="checkbox" data-day="${d}"${f.days.includes(d) ? " checked" : ""}${ed ? " disabled" : ""}> ${SHORT[d]}</label>`).join("")}</fieldset>
      <label>Start<input type="time" id="fStart" value="${esc(f.start)}"></label><label>End<input type="time" id="fEnd" value="${esc(f.end)}"></label></div>
    <div class="btnbar"><button class="btn primary" data-act="saveEntry"${ready ? "" : " disabled"}>${ed ? "Update class" : "Save class"}</button>${ed ? `<button class="btn" data-act="cancelEdit">Cancel</button>` : ""}</div>
    <p class="muted fine">The system checks the teacher, the room and the section for overlaps, and the teacher's daily hour limit (${limit()} hours${enforce() ? ", strict" : ", warning only"}). After saving, the next class starts where this one ended.</p></div>
    ${recent()}`;
  }
  const recent = () => { const l = [...S.entries].sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt)).slice(0, 8); return l.length ? `<div class="sc-card"><h3>Latest classes added</h3>${rowsTable(l)}</div>` : ""; };
  function rowsTable(list, acts = true) {
    return `<div class="tablewrap"><table><tr><th>Section</th><th>Day</th><th>Time</th><th>Subject</th><th>Teacher</th><th>Room</th>${acts ? "<th></th>" : ""}</tr>${list.map((e) => `<tr><td>${esc(e.sectionName)}</td><td>${esc(e.day)}</td><td>${ampm(e.start)} - ${ampm(e.end)}</td><td><b>${esc(e.subject)}</b></td><td>${esc(e.teacherName || "-")}${e.teacherName && !e.teacherUid ? ' <small>(no account)</small>' : ""}</td><td>${esc(e.room || "-")}</td>
      ${acts ? `<td class="actions"><button class="btn small" data-act="edit" data-id="${esc(e.id)}">Edit</button><button class="btn small danger" data-act="del" data-id="${esc(e.id)}">Delete</button></td>` : ""}</tr>`).join("") || `<tr><td colspan="7">No classes yet.</td></tr>`}</table></div>`;
  }
  function readForm() {
    const f = S.form; f.section = $("fSection").value; f.subject = $("fSubject").value; f.teacher = $("fTeacher").value; f.other = ($("fOther") || {}).value || ""; f.room = $("fRoom").value;
    f.days = [...root.querySelectorAll("[data-day]:checked")].map((x) => x.dataset.day); f.start = $("fStart").value; f.end = $("fEnd").value; return f;
  }
  async function saveEntry() {
    const f = readForm(), ed = S.editId ? S.entries.find((x) => x.id === S.editId) : null, sec = S.sections.find((x) => x.id === f.section);
    if (!sem()) return flash("Create or choose a semester first.");
    if (!sec) return flash("Choose the section."); if (!up(f.subject)) return flash("Enter the subject.");
    if (!f.start || !f.end) return flash("Enter the start and end time."); if (toMin(f.end) <= toMin(f.start)) return flash("The end time must be after the start time.");
    const days = ed ? [ed.day] : f.days; if (!days.length) return flash("Tick at least one day.");
    const t = S.teachers.find((x) => x.uid === f.teacher), teacherName = f.teacher === "__other" ? f.other.trim() : t ? t.displayName : "";
    if (f.teacher === "__other" && !teacherName) return flash("Type the teacher's name.");
    const base = { schoolId: SID, semesterId: S.semId, semesterName: sem().name, sectionId: sec.id, sectionName: sec.name, gradeLevel: sec.gradeLevel, cluster: sec.strand || "", subject: up(f.subject),
      teacherUid: t ? t.uid : "", teacherName, ownerUid: t ? t.uid : "", room: up(f.room), start: f.start, end: f.end };
    const problems = [], warns = [];
    days.forEach((d) => {
      const n = { ...base, day: d }, c = conflicts(n, S.editId); c.forEach((x) => problems.push(x));
      const h = dayHours(n, S.editId); if (teacherKey(n) && h > limit()) (enforce() ? problems : warns).push(`${n.teacherName} would teach ${h.toFixed(1)} hours on ${d} (limit ${limit()}).`);
      const k = breakHit(n); if (k) warns.push(`${d}: this class overlaps the break "${k.label}" (${ampm(k.start)} - ${ampm(k.end)}).`);
    });
    if (problems.length) return showPopup({ title: "This class cannot be saved", ok: false, html: `<p>${[...new Set(problems)].map(esc).join("</p><p>")}</p>` });
    if (warns.length) { const a = await showPopup({ title: "Save anyway?", ok: false, html: `<p>${[...new Set(warns)].map(esc).join("</p><p>")}</p>`, buttons: [{ label: "Go back", value: "no" }, { label: "Save anyway", value: "yes", primary: true }] }); if (a.value !== "yes") return; }
    const b = writeBatch();
    if (ed) b.update(doc(db, "classSchedules", ed.id), { ...base, day: ed.day, updatedAt: serverTimestamp() });
    else days.forEach((d) => b.set(doc(collection(db, "classSchedules")), { ...base, day: d, createdBy: user.uid, createdAt: serverTimestamp() }));
    await b.commit();
    const dur = toMin(f.end) - toMin(f.start);
    S.editId = ""; Object.assign(S.form, { subject: "", start: f.end, end: toMin(f.end) + dur <= 1439 ? toHm(toMin(f.end) + dur) : f.end });
    if (!ed) S.form.days = f.days;
    await loadEntries(); render();
    flash(ed ? "Class updated." : `Class saved (${days.length} day${days.length === 1 ? "" : "s"}).`, true);
  }

  /* --- weekly schedule (by section, teacher or room) --- */
  function options() {
    if (S.mode === "section") return S.sections.map((x) => [x.id, x.name]);
    if (S.mode === "teacher") { const m = new Map(); S.teachers.forEach((t) => m.set("u:" + t.uid, t.displayName)); S.entries.forEach((e) => { const k = teacherKey(e); if (k && !m.has(k)) m.set(k, e.teacherName); }); return [...m].sort((a, b) => String(a[1]).localeCompare(String(b[1]))); }
    return roomsAll().map((r) => [up(r), r]);
  }
  const pickOf = (e) => (S.mode === "section" ? e.sectionId : S.mode === "teacher" ? teacherKey(e) : up(e.room));
  function viewEntries(pick) { return S.entries.filter((e) => pickOf(e) === pick); }
  function viewHtml() {
    const opts = options(); if (!opts.some(([k]) => k === S.pick)) S.pick = (opts[0] || [""])[0];
    const list = viewEntries(S.pick), label = (opts.find(([k]) => k === S.pick) || [, ""])[1];
    return `<div class="sc-card"><div class="row noprint"><label>Show the schedule of<select id="vMode">${[["section", "a section"], ["teacher", "a teacher"], ["room", "a room"]].map(([k, l]) => `<option value="${k}"${S.mode === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>${S.mode === "section" ? "Section" : S.mode === "teacher" ? "Teacher" : "Room"}<select id="vPick">${opts.map(([k, l]) => `<option value="${esc(k)}"${k === S.pick ? " selected" : ""}>${esc(l)}</option>`).join("") || "<option value=''>- none -</option>"}</select></label></div>
      <div class="btnbar noprint"><button class="btn primary" data-act="print">Print this schedule</button><button class="btn" data-act="printAll">Print all (${S.mode}s)</button><button class="btn" data-act="xlsxOne">Excel (this one)</button><button class="btn" data-act="xlsxAll">Excel (everything)</button></div>
      <h3>${esc(label)} <small style="display:inline">${esc((sem() || {}).name || "")}</small></h3>${S.mode === "teacher" ? teacherHours(list) : ""}
      <p class="muted fine noprint">Drag a class to another day or time to move it (the same checks apply).</p>
      <div class="sc-scroll" id="scGridWrap">${gridHtml(list, breaksFor((sem() || {}).breaks, S.mode, label), { mode: S.mode, drag: true })}</div></div>`;
  }
  function teacherHours(list) {
    const per = DAYS.map((d) => list.filter((e) => e.day === d).reduce((s, e) => s + hours(e.start, e.end), 0));
    return `<div class="sc-hrs">${DAYS.map((d, i) => `<span class="${per[i] > limit() ? "over" : ""}"><b>${SHORT[d]}</b> ${per[i].toFixed(1)} h${per[i] > limit() ? " (over)" : ""}</span>`).join("")}<span><b>Week</b> ${per.reduce((a, b) => a + b, 0).toFixed(1)} h</span></div>`;
  }
  function pagesFor(mode) {
    const old = S.mode; S.mode = mode; const pages = options().map(([k, l]) => ({ k, l, list: viewEntries(k) })).filter((p) => p.list.length)
      .map((p) => ({ title: p.l, sub: (sem() || {}).name || "", html: gridHtml(p.list, breaksFor((sem() || {}).breaks, mode, p.l), { mode }) })); S.mode = old; return pages;
  }

  /* --- all classes --- */
  function listHtml2() {
    const q = S.q.toLowerCase(), l = S.entries.filter((e) => !q || [e.subject, e.sectionName, e.teacherName, e.room, e.day].join(" ").toLowerCase().includes(q)).sort((a, b) => String(a.sectionName).localeCompare(String(b.sectionName), undefined, { numeric: true }) || byTime(a, b));
    return `<div class="sc-card"><div class="row"><label>Search<input id="lQ" value="${esc(S.q)}" placeholder="Subject, section, teacher, room or day" autocomplete="off"></label></div>
      <div class="btnbar noprint"><button class="btn primary" data-act="xlsxAll">Download Excel</button></div><p class="muted fine">${l.length} of ${S.entries.length} classes</p>${rowsTable(l)}</div>`;
  }

  /* --- break times and limits --- */
  function breaksHtml() {
    const s = sem() || {}, br = s.breaks || [];
    return `<div class="sc-card"><h3>Teacher daily hour limit</h3><div class="row"><label>Hours a day<input type="number" id="bLimit" min="1" max="16" step="0.5" value="${limit()}"></label>
      <label class="sc-chk" style="margin-top:1.6rem"><input type="checkbox" id="bEnf"${enforce() ? " checked" : ""}> Strict: do not allow more than the limit</label><button class="btn primary" data-act="saveLimit">Save limit</button></div></div>
    <div class="sc-card"><h3>Break times</h3><p class="muted fine">Shown as shaded bands in the weekly schedule. Saving a class that overlaps a break asks for confirmation.</p>
      <div class="tablewrap"><table><tr><th>Break</th><th>Time</th><th>Days</th><th>Applies to</th><th></th></tr>${br.map((k) => `<tr><td>${esc(k.label)}</td><td>${ampm(k.start)} - ${ampm(k.end)}</td><td>${k.days === "all" || !k.days ? "Every day" : esc(k.days)}</td><td>${k.scope === "all" || !k.scope ? "Everyone" : esc(k.scope) + ": " + esc(k.scopeValue)}</td><td class="actions"><button class="btn small danger" data-act="delBreak" data-id="${esc(k.id)}">Delete</button></td></tr>`).join("") || `<tr><td colspan="5">No break times yet.</td></tr>`}</table></div>
      <h3 style="margin-top:1rem">Add a break</h3><div class="row"><label>Name<input id="kLabel" maxlength="40" placeholder="Lunch break"></label><label>From<input type="time" id="kStart" value="12:00"></label><label>To<input type="time" id="kEnd" value="13:00"></label>
        <label>Days<select id="kDays"><option value="all">Every day</option>${DAYS.map((d) => `<option>${d}</option>`).join("")}</select></label>
        <label>Applies to<select id="kScope"><option value="all">Everyone</option><option value="section">One section</option><option value="teacher">One teacher</option><option value="room">One room</option></select></label>
        <label id="kValWrap" hidden>Which one<input id="kVal" maxlength="120" placeholder="Exactly as written in the schedule (e.g. the section name)"></label></div>
      <button class="btn primary" data-act="addBreak">Add break</button></div>`;
  }

  /* --- subjects and rooms --- */
  function listsHtml() {
    const chips = (k) => S.lists[k].map((x) => `<span class="sc-chip">${esc(x)}<button data-act="rmList" data-k="${k}" data-v="${esc(x)}" aria-label="Remove ${esc(x)}">&times;</button></span>`).join("") || `<span class="muted">None yet.</span>`;
    return `<div class="sc-card"><h3>Subjects</h3><p class="muted fine">Optional. Subjects you already used are suggested automatically; add the others here so they appear in the drop-down.</p><div class="sc-chips">${chips("subjects")}</div>
      <div class="row"><label>Add a subject<input id="aSubj" maxlength="80" autocomplete="off"></label><button class="btn primary" data-act="addList" data-k="subjects" data-in="aSubj">Add</button></div></div>
    <div class="sc-card"><h3>Rooms</h3><div class="sc-chips">${chips("rooms")}</div><div class="row"><label>Add a room<input id="aRoom" maxlength="60" autocomplete="off"></label><button class="btn primary" data-act="addList" data-k="rooms" data-in="aRoom">Add</button></div></div>`;
  }
  async function saveLists() { await setDoc(doc(db, "scheduleSettings", SID), { schoolId: SID, subjects: S.lists.subjects, rooms: S.lists.rooms, updatedAt: serverTimestamp() }, { merge: true }); }

  /* ---------- semester actions ---------- */
  async function askName(title, def) {
    const a = await showPopup({ title, html: `<label>Name of the semester<input data-pf="name" maxlength="80" value="${esc(def)}"></label>`, validate: (f) => (!String(f.name || "").trim() ? "Enter a name." : ""), buttons: [{ label: "Cancel", value: "no" }, { label: "Create", value: "yes", primary: true }] });
    return a.value === "yes" ? a.fields.name.trim() : "";
  }
  const newSemDoc = (name) => ({ schoolId: SID, name, published: false, breaks: [], dailyHourLimit: 8, enforceLimit: true, createdBy: user.uid, createdByName: profile.displayName || "", createdAt: serverTimestamp() });
  async function newSem() {
    const name = await askName("New semester", `1st Semester ${schoolYearNow()}`); if (!name) return;
    if (S.sems.some((x) => x.name.toLowerCase() === name.toLowerCase())) return flash(`The semester "${name}" already exists.`);
    const ref = doc(collection(db, "scheduleSemesters")); await setDoc(ref, newSemDoc(name)); S.semId = ref.id; await logEvent("Created schedule semester", name, ""); await reload(); flash(`Semester "${name}" created.`, true);
  }
  async function copySem() {
    const s = sem(); if (!s) return;
    const name = await askName(`Copy "${s.name}" to a new semester`, `2nd Semester ${schoolYearNow()}`); if (!name) return;
    if (S.sems.some((x) => x.name.toLowerCase() === name.toLowerCase())) return flash(`The semester "${name}" already exists.`);
    const ref = doc(collection(db, "scheduleSemesters")); await setDoc(ref, { ...newSemDoc(name), breaks: s.breaks || [], dailyHourLimit: s.dailyHourLimit || 8, enforceLimit: s.enforceLimit !== false });
    await chunked(S.entries.map((e) => (b) => { const { id, createdAt, updatedAt, ...rest } = e; b.set(doc(collection(db, "classSchedules")), { ...rest, semesterId: ref.id, semesterName: name, createdBy: user.uid, createdAt: serverTimestamp() }); }));
    S.semId = ref.id; await logEvent("Copied schedule semester", name, `From ${s.name}: ${S.entries.length} classes`); await reload(); flash(`Copied ${S.entries.length} classes to "${name}".`, true);
  }
  async function delSem() {
    const s = sem(); if (!s) return;
    const a = await showPopup({ title: `Delete "${s.name}"?`, ok: false, html: `<p>All ${S.entries.length} classes of this semester are deleted${s.published ? ", and teachers and students will no longer see it" : ""}. This cannot be undone.</p>`, buttons: [{ label: "Keep it", value: "no" }, { label: "Delete the semester", value: "yes", primary: true, danger: true }] });
    if (a.value !== "yes") return;
    await chunked(S.entries.map((e) => (b) => b.delete(doc(db, "classSchedules", e.id)))); await chunked([(b) => b.delete(doc(db, "scheduleSemesters", s.id))]);
    S.semId = ""; await logEvent("Deleted schedule semester", s.name, ""); await reload(); flash("Semester deleted.", true);
  }
  async function send() {
    const s = sem(); if (!s) return;
    if (!S.entries.length) return flash("There are no classes to send yet.");
    const teachers = new Set(S.entries.map((e) => e.teacherUid).filter(Boolean)), secs = new Set(S.entries.map((e) => e.sectionId)), noAcct = new Set(S.entries.filter((e) => e.teacherName && !e.teacherUid).map((e) => e.teacherName));
    const other = S.sems.filter((x) => x.published && x.id !== s.id);
    const a = await showPopup({ title: `Send "${s.name}"?`, html: `<p><b>${teachers.size}</b> teacher${teachers.size === 1 ? "" : "s"} will see their own classes, and the students of <b>${secs.size}</b> section${secs.size === 1 ? "" : "s"} will see their section's schedule.</p>
      ${S.entries.some((e) => !e.teacherName) ? `<p class="lv-pop-err">Some classes have no teacher yet.</p>` : ""}${noAcct.size ? `<p class="lv-pop-err">No portal account, so they will not see it: ${[...noAcct].map(esc).join(", ")}.</p>` : ""}${other.length ? `<p class="muted">The semester "${esc(other.map((x) => x.name).join(", "))}" is withdrawn, so people see only one schedule.</p>` : ""}`,
      buttons: [{ label: "Cancel", value: "no" }, { label: "Send now", value: "yes", primary: true }] });
    if (a.value !== "yes") return;
    const b = writeBatch(); b.update(doc(db, "scheduleSemesters", s.id), { published: true, publishedAt: serverTimestamp(), publishedBy: user.uid, publishedByName: profile.displayName || "", updatedAt: serverTimestamp() });
    other.forEach((x) => b.update(doc(db, "scheduleSemesters", x.id), { published: false, updatedAt: serverTimestamp() })); await b.commit();
    await logEvent("Sent class schedule", s.name, `${teachers.size} teachers, ${secs.size} sections, ${S.entries.length} classes`); await reload(); flash(`"${s.name}" was sent to the teachers and students.`, true);
  }
  async function unsend() {
    const s = sem(); if (!s) return;
    const a = await showPopup({ title: "Withdraw the schedule?", html: `<p>Teachers and students will no longer see "${esc(s.name)}" until you send it again.</p>`, buttons: [{ label: "Keep it sent", value: "no" }, { label: "Withdraw", value: "yes", primary: true }] });
    if (a.value !== "yes") return; await updateDoc(doc(db, "scheduleSemesters", s.id), { published: false, updatedAt: serverTimestamp() }); await logEvent("Withdrew class schedule", s.name, ""); await reload(); flash("The schedule was withdrawn.", true);
  }

  /* ---------- events ---------- */
  root.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab],[data-act]"); if (!t) return;
    if (t.dataset.tab) { if (S.tab === "encode" && $("fSection")) readForm(); S.tab = t.dataset.tab; render(); return; }
    const id = t.dataset.id, act = t.dataset.act;
    run(async () => {
      if (act === "newSem") return newSem(); if (act === "copySem") return copySem(); if (act === "delSem") return delSem(); if (act === "send") return send(); if (act === "unsend") return unsend();
      if (act === "saveEntry") return saveEntry();
      if (act === "cancelEdit") { S.editId = ""; return body(); }
      if (act === "edit") { const x = S.entries.find((q) => q.id === id); if (!x) return; S.editId = id; Object.assign(S.form, { section: x.sectionId, subject: x.subject, teacher: x.teacherUid || (x.teacherName ? "__other" : ""), other: x.teacherUid ? "" : x.teacherName || "", room: x.room || "", days: [x.day], start: x.start, end: x.end }); S.tab = "encode"; render(); return scrollTo({ top: root.offsetTop, behavior: "smooth" }); }
      if (act === "del") {
        const x = S.entries.find((q) => q.id === id); if (!x) return;
        const a = await showPopup({ title: "Delete this class?", ok: false, html: `<p><b>${esc(x.subject)}</b><br>${esc(x.sectionName)}, ${esc(x.day)} ${ampm(x.start)} - ${ampm(x.end)}</p>`, buttons: [{ label: "Keep", value: "no" }, { label: "Delete", value: "yes", primary: true, danger: true }] });
        if (a.value !== "yes") return; await writeBatch().delete(doc(db, "classSchedules", id)).commit(); await loadEntries(); return render();
      }
      if (act === "print") { const l = viewEntries(S.pick), lab = (options().find(([k]) => k === S.pick) || [, ""])[1]; return printPages(school, [{ title: lab, sub: (sem() || {}).name, html: gridHtml(l, breaksFor((sem() || {}).breaks, S.mode, lab), { mode: S.mode }) }]); }
      if (act === "printAll") { const p = pagesFor(S.mode); return p.length ? printPages(school, p) : flash("There is nothing to print yet."); }
      if (act === "xlsxOne") return exportXlsx(viewEntries(S.pick), `schedule-${S.mode}.xlsx`);
      if (act === "xlsxAll") return exportXlsx(S.entries, `class-schedule-${(sem() || {}).name || "semester"}.xlsx`.replace(/\s+/g, "-"));
      if (act === "saveLimit") { const v = +$("bLimit").value; if (!(v >= 1 && v <= 16)) return flash("Enter the hours a day (1 to 16)."); await updateDoc(doc(db, "scheduleSemesters", S.semId), { dailyHourLimit: v, enforceLimit: $("bEnf").checked, updatedAt: serverTimestamp() }); await reload(); return flash("Limit saved.", true); }
      if (act === "addBreak") {
        const k = { id: rid(), label: $("kLabel").value.trim(), start: $("kStart").value, end: $("kEnd").value, days: $("kDays").value, scope: $("kScope").value, scopeValue: $("kVal").value.trim() };
        if (!k.label) return flash("Enter the name of the break."); if (!k.start || !k.end || toMin(k.end) <= toMin(k.start)) return flash("The break must end after it starts."); if (k.scope !== "all" && !k.scopeValue) return flash("Say which " + k.scope + " the break is for.");
        await updateDoc(doc(db, "scheduleSemesters", S.semId), { breaks: [...(sem().breaks || []), k], updatedAt: serverTimestamp() }); await reload(); return flash("Break added.", true);
      }
      if (act === "delBreak") { await updateDoc(doc(db, "scheduleSemesters", S.semId), { breaks: (sem().breaks || []).filter((k) => k.id !== id), updatedAt: serverTimestamp() }); await reload(); return; }
      if (act === "addList") { const v = $(t.dataset.in).value.trim(); if (!v) return; const k = t.dataset.k; if (S.lists[k].some((x) => x.toLowerCase() === v.toLowerCase())) return flash("It is already in the list."); S.lists[k] = [...S.lists[k], v.toUpperCase()].sort(); await saveLists(); return body(); }
      if (act === "rmList") { const k = t.dataset.k; S.lists[k] = S.lists[k].filter((x) => x !== t.dataset.v); await saveLists(); return body(); }
    });
  });
  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "scSem") { S.semId = t.value; run(async () => { await loadEntries(); render(); }); return; }
    if (t.id === "vMode") { S.mode = t.value; S.pick = ""; return body(); }
    if (t.id === "vPick") { S.pick = t.value; return body(); }
    if (t.id === "kScope") { $("kValWrap").hidden = t.value === "all"; return; }
    if (t.id === "fTeacher") { $("fOtherWrap").hidden = t.value !== "__other"; }
    if (S.tab === "encode" && $("fSection")) readForm();
  });
  root.addEventListener("input", (e) => { if (e.target.id === "lQ") { S.q = e.target.value; const p = e.target.selectionStart; body(); const n = $("lQ"); n.focus(); n.setSelectionRange(p, p); } else if (S.tab === "encode" && $("fSection")) readForm(); });

  /* drag a class to another day / time */
  root.addEventListener("dragstart", (e) => { const b = e.target.closest(".sc-blk[data-id]"); if (!b) return; e.dataTransfer.setData("text/plain", b.dataset.id); e.dataTransfer.effectAllowed = "move"; S.dragOff = e.clientY - b.getBoundingClientRect().top; });
  root.addEventListener("dragover", (e) => { if (e.target.closest(".sc-col")) e.preventDefault(); });
  root.addEventListener("drop", (e) => {
    const col = e.target.closest(".sc-col"); if (!col) return; e.preventDefault();
    run(async () => {
      const x = S.entries.find((q) => q.id === e.dataTransfer.getData("text/plain")); if (!x) return;
      const dur = toMin(x.end) - toMin(x.start), y = e.clientY - col.getBoundingClientRect().top - S.dragOff;
      let m = Math.round((+col.dataset.min + y / 0.8) / 15) * 15; m = Math.max(0, Math.min(m, 24 * 60 - dur));
      const n = { ...x, day: col.dataset.day, start: toHm(m), end: toHm(m + dur) };
      if (n.day === x.day && n.start === x.start) return;
      const c = conflicts(n, x.id); if (teacherKey(n) && dayHours(n, x.id) > limit() && enforce()) c.push(`${n.teacherName} would go over the daily limit of ${limit()} hours.`);
      if (c.length) return showPopup({ title: "Cannot move the class", ok: false, html: `<p>${c.map(esc).join("</p><p>")}</p>` });
      await updateDoc(doc(db, "classSchedules", x.id), { day: n.day, start: n.start, end: n.end, updatedAt: serverTimestamp() }); await loadEntries(); body();
    });
  });

  /* load when the "Make schedule" button is first opened */
  const open = () => { if (S.loaded || S.loading) return; S.loading = true; root.innerHTML = `<p class="muted">Loading the schedule...</p>`; run(async () => { await loadBase(); S.loaded = true; render(); }).finally(() => (S.loading = false)); };
  document.addEventListener("click", (e) => { if (e.target.closest('[data-p="scSchedP"]')) open(); });
  if (!root.hidden) open();
}
