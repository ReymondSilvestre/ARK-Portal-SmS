import { requireRole, logout, db, esc, friendlyError, ageOf, applyBranding } from "./auth.js";
import { collection, query, where, getDocs, getDoc, doc, setDoc, writeBatch, deleteDoc, serverTimestamp } from "./db.js";
import { TERMS, termRank, score, missedText } from "./omr.js";
import { sizeText, openModule, safeUrl } from "./files.js";

const $ = (id) => document.getElementById(id);
const { user, profile, school } = await requireRole(["student"]);
$("out").onclick = logout;
applyBranding(school);
const flash = (t, ok) => { const m = $("msg"); m.textContent = t; m.className = "notice " + (ok ? "ok" : "err"); m.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => (m.hidden = true), 8000); };
const net = () => { $("sync").className = "sync" + (navigator.onLine ? "" : " off"); $("sync").lastElementChild.textContent = navigator.onLine ? "Online" : "Offline"; };
addEventListener("online", net); addEventListener("offline", net); net();

const termHtml = `<option value="">All terms / quarters</option>` + TERMS.map((t) => `<option>${t}</option>`).join("");
$("rTerm").innerHTML = $("mTerm").innerHTML = termHtml;
const grouped = (list, cols, row) => { let last, out = ""; for (const x of list) { const t = x.term || "No term"; if (t !== last) { last = t; out += `<tr class="grp"><td colspan="${cols}">${esc(t)}</td></tr>`; } out += row(x); } return out; };
const byTerm = (a, b) => termRank(a.term) - termRank(b.term);
const mine = (c) => getDocs(query(collection(db, c), where("studentId", "==", profile.studentId)));

let fees = { accounts: [], pays: [], err: null };
let S = null, results = [], modules = [], rooms = [], links = [], papers = [], attempts = new Map(), subs = new Map();
async function loadAll() {
  const me = await getDoc(doc(db, "students", profile.studentId));
  if (!me.exists()) throw new Error("Your student record was not found. Ask your teacher.");
  S = me.data();
  $("who").textContent = S.name; $("name").textContent = S.name;
  $("info").textContent = `Exam ID No. ${S.number} | Section ${S.className}` + (S.birthday ? ` | Age ${ageOf(S.birthday)}` : "");
  [rooms, links] = (await Promise.all([mine("enrollments"), mine("teacherLinks")])).map((s) => s.docs.map((d) => ({ id: d.id, ...d.data() })));
  // exam results from ALL teachers (own adviser and any classroom joined by code)
  results = (await mine("scanResults")).docs.map((d) => d.data())
    .sort((a, b) => byTerm(a, b) || (b.scannedAt?.seconds || 0) - (a.scannedAt?.seconds || 0));
  // modules: my section + "all sections" of my adviser, and the same for every classroom I joined
  const pairs = new Map([[`${S.ownerUid}|${S.classId}`, [S.ownerUid, S.classId]], [`${S.ownerUid}|`, [S.ownerUid, ""]]]);
  rooms.forEach((r) => { pairs.set(`${r.ownerUid}|${r.classId}`, [r.ownerUid, r.classId]); pairs.set(`${r.ownerUid}|`, [r.ownerUid, ""]); });
  const got = await Promise.allSettled([...pairs.values()].map(([o, c]) => getDocs(query(collection(db, "modules"), where("ownerUid", "==", o), where("classId", "==", c)))));
  got.push(...await Promise.allSettled([getDocs(query(collection(db, "modules"), where("studentId", "==", profile.studentId)))])); // modules sent to me alone
  const seen = new Set(); modules = [];
  got.forEach((g) => g.status === "fulfilled" && g.value.docs.forEach((d) => { if (!seen.has(d.id)) { seen.add(d.id); modules.push({ id: d.id, ...d.data() }); } }));
  modules.sort((a, b) => byTerm(a, b) || (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  // online exams that are open for me (same sections as the modules above); the answer key is never in these documents
  const gp = await Promise.allSettled([...pairs.values()].map(([o, c]) => getDocs(query(collection(db, "examPapers"), where("ownerUid", "==", o), where("classId", "==", c), where("open", "==", true)))));
  const seenP = new Set(); papers = [];
  gp.forEach((g) => g.status === "fulfilled" && g.value.docs.forEach((d) => { if (!seenP.has(d.id)) { seenP.add(d.id); papers.push({ id: d.id, ...d.data() }); } }));
  papers.sort((a, b) => byTerm(a, b) || String(a.title).localeCompare(String(b.title)));
  attempts = new Map((await mine("examAttempts")).docs.map((d) => [d.data().examId, d.data()]));
  subs = new Map((await mine("examSubmissions")).docs.map((d) => [d.data().examId, d.data()]));
  // balance and payments posted by the Finance office (a failure here must not break the rest of the page)
  try {
    fees = { err: null,
      accounts: (await mine("studentAccounts")).docs.map((d) => d.data()).sort((a, b) => String(b.schoolYear).localeCompare(String(a.schoolYear))),
      pays: (await mine("payments")).docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)) };
  } catch (e) { console.warn(e); fees = { accounts: [], pays: [], err: e }; }
}
const peso = (n) => "\u20b1" + (Number(n) || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function renderFees() {
  const owed = fees.accounts.reduce((n, a) => n + Math.max(0, a.balance || 0), 0);
  $("feTab").textContent = "Balance & payments" + (owed > 0 ? ` (${peso(owed)} due)` : "");
  if (fees.err) { $("feBox").innerHTML = '<p class="muted">Your balance is not available yet. Please try again later or ask the Finance office.</p>'; return; }
  if (!fees.accounts.length) { $("feBox").innerHTML = '<p class="muted">No balance has been posted for you yet.</p>'; return; }
  $("feBox").innerHTML = fees.accounts.map((a) => {
    const ps = fees.pays.filter((p) => p.schoolYear === a.schoolYear), paidOff = a.totalDue > 0 && a.balance <= 0;
    return `<div class="formgrp"><h3>School year ${esc(a.schoolYear)} - ${esc(a.gradeLevel || "")}${a.voucherType ? " (" + esc(a.voucherType) + ")" : ""}</h3>
      <div class="cards"><div class="stat"><b>${peso(a.totalDue)}</b><span>Total to pay</span></div><div class="stat good"><b>${peso(a.totalPaid)}</b><span>Total paid</span></div>
      <div class="stat ${paidOff ? "good" : "warn"}"><b>${peso(Math.max(0, a.balance))}</b><span>${paidOff ? "Balance - fully paid" : "Balance"}</span></div></div>
      <div class="tablewrap"><table><tr><th>Payment transaction</th><th>To pay</th><th>Paid</th><th>Balance</th></tr>${(a.lines || []).map((l) => `<tr><td>${esc(l.type)}</td><td>${peso(l.due)}</td><td>${peso(l.paid)}</td><td>${peso(Math.max(0, l.due - l.paid))}</td></tr>`).join("") || "<tr><td colspan=4>No fees set yet.</td></tr>"}</table></div>
      <h3 style="margin-top:1rem">Payment transactions</h3>
      <div class="tablewrap"><table><tr><th>Date</th><th>Receipt No.</th><th>Transaction</th><th>Amount</th><th>Status</th></tr>${ps.map((p) => `<tr class="${p.status === "void" ? "voided" : ""}"><td>${esc(p.date || "-")}</td><td>${esc(p.receiptNo || "-")}</td><td>${esc(p.type)}</td><td>${peso(p.amount)}</td><td>${p.status === "void" ? '<span class="badge void">Voided</span>' : '<span class="badge active">Paid</span>'}</td></tr>`).join("") || "<tr><td colspan=5>No payments yet.</td></tr>"}</table></div></div>`;
  }).join("");
}

function renderExams() {
  const todo = papers.filter((p) => !results.some((r) => r.examId === p.id)).length;
  document.querySelector('#tabs [data-t="exams"]').textContent = "Online exams" + (todo ? ` (${todo})` : "");
  $("eTbl").innerHTML = "<tr><th>Exam</th><th>Teacher</th><th>Subject</th><th>Items</th><th>Time</th><th>Status</th><th></th></tr>" +
    (grouped(papers, 7, (p) => {
      const r = results.find((x) => x.examId === p.id), a = attempts.get(p.id);
      const st = r ? (r.final ? `<span class="badge ${r.pass ? "active" : "suspended"}">${r.points}/${r.maxPoints} - ${r.pass ? "Passed" : "Failed"}</span>` : '<span class="badge warn">Submitted, being checked</span>')
        : subs.has(p.id) ? '<span class="badge warn">Submitted, score not saved yet</span>' : a ? '<span class="badge warn">In progress</span>' : '<span class="badge">Not taken</span>';
      return `<tr><td class="wrapcell"><b>${esc(p.title)}</b></td><td>${esc(p.teacherName || "-")}</td><td>${esc(p.subject || "-")}</td><td>${p.n}</td><td>${p.timeLimit ? p.timeLimit + " min" : "No limit"}</td><td>${st}</td>
        <td class="actions">${r ? "" : `<button class="btn small primary" data-take="${esc(p.id)}">${subs.has(p.id) ? "Get my score" : a ? "Continue" : "Start"}</button>`}</td></tr>`;
    }) || "<tr><td colspan=7>No exams are open for you right now.</td></tr>");
}
function render() {
  renderExams(); renderFees();
  const rt = $("rTerm").value, rs = results.filter((r) => !rt || (r.term || "") === rt);
  $("rTbl").innerHTML = "<tr><th>Exam</th><th>Teacher</th><th>Subject</th><th>Score</th><th>%</th><th>Result</th><th>Items to review</th></tr>" +
    (grouped(rs, 7, (r) => `<tr><td>${esc(r.examTitle || "Examination")}</td><td>${esc(r.teacherName || "-")}</td><td>${esc(r.subject || "-")}</td><td>${r.points}/${r.maxPoints}</td><td>${r.pct}</td>
      <td>${r.final ? `<span class="badge ${r.pass ? "active" : "suspended"}">${r.pass ? "Passed" : "Failed"}</span>` : '<span class="badge warn">Being checked</span>'}</td>
      <td class="wrapcell">${(r.missedList || []).length ? r.missedList.map((m) => `<span class="wr">${esc(m)}</span>`).join("") : "None"}</td></tr>`) || "<tr><td colspan=7>No exam results yet.</td></tr>");
  const mt = $("mTerm").value, ms = modules.filter((m) => !mt || (m.term || "") === mt);
  $("mTbl").innerHTML = "<tr><th>Module</th><th>Teacher</th><th>File</th><th>Uploaded</th><th></th></tr>" +
    (grouped(ms, 5, (m) => `<tr><td class="wrapcell"><b>${esc(m.title)}</b>${m.studentId ? ' <span class="badge one">For you only</span>' : ""}${m.description ? `<br><span class="muted fine">${esc(m.description)}</span>` : ""}</td><td>${esc(m.teacherName || "-")}</td>
      <td>${m.kind === "link" ? "Link" : esc(m.fileName) + " (" + sizeText(m.size) + ")"}</td><td>${m.createdAt?.toDate ? m.createdAt.toDate().toLocaleDateString() : "-"}</td>
      <td class="actions"><button class="btn small primary" data-open="${esc(m.id)}">${m.kind === "link" ? "Open" : "Download"}</button></td></tr>`) || "<tr><td colspan=5>No modules yet.</td></tr>");
  $("cTbl").innerHTML = "<tr><th>Section</th><th>Teacher</th><th>Joined</th><th></th></tr>" +
    `<tr><td>${esc(S.className)}</td><td>My own section (adviser)</td><td>-</td><td></td></tr>` +
    rooms.map((r) => `<tr><td>${esc(r.className)}</td><td>${esc(r.teacherName)}</td><td>${r.joinedAt?.toDate ? r.joinedAt.toDate().toLocaleDateString() : "-"}</td>
      <td class="actions"><button class="btn small danger" data-leave="${esc(r.id)}">Leave</button></td></tr>`).join("");
}
$("rTerm").onchange = $("mTerm").onchange = render;
const showTab = (t) => {
  $("room").hidden = true; $("done").hidden = true; $("tabs").hidden = false; wide(false);
  document.querySelectorAll("[data-s]").forEach((s) => (s.hidden = s.dataset.s !== t));
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x.dataset.t === t));
};
$("tabs").onclick = (e) => { const b = e.target.closest("button"); if (b) showTab(b.dataset.t); };
$("mTbl").onclick = async (e) => { const b = e.target.closest("[data-open]"); if (!b) return;
  try { b.disabled = true; await openModule(db, modules.find((m) => m.id === b.dataset.open)); } catch (err) { flash(friendlyError(err)); } finally { b.disabled = false; } };

/* ---------- join / leave a classroom with the teacher's code ---------- */
$("jGo").onclick = async () => {
  const code = $("jCode").value.trim().toUpperCase().replace(/\s+/g, ""); if (!code) return flash("Type the classroom code from your teacher.");
  $("jGo").disabled = true;
  try {
    const snap = await getDoc(doc(db, "classCodes", code));
    if (!snap.exists()) return flash("No classroom has that code. Check it with your teacher.");
    const c = snap.data();
    if (c.schoolId !== profile.schoolId) return flash("That classroom belongs to another school.");
    if (c.classId === S.classId || rooms.some((r) => r.classId === c.classId)) return flash("You are already in that classroom.", true);
    if (!confirm(`Join ${c.className} of ${c.teacherName}?`)) return;
    const b = writeBatch(db);
    b.set(doc(db, "enrollments", `${S.number}_${c.classId}`), { studentId: S.number, studentUid: user.uid, studentName: S.name, studentNumber: S.number, classId: c.classId, className: c.className, code,
      ownerUid: c.ownerUid, teacherName: c.teacherName, schoolId: profile.schoolId, joinedAt: serverTimestamp() });
    if (!links.some((l) => l.ownerUid === c.ownerUid))
      b.set(doc(db, "teacherLinks", `${S.number}_${c.ownerUid}`), { studentId: S.number, ownerUid: c.ownerUid, classId: c.classId, schoolId: profile.schoolId, createdAt: serverTimestamp() });
    await b.commit(); $("jCode").value = "";
    await loadAll(); render(); flash(`You joined ${c.className} (${c.teacherName}).`, true);
  } catch (err) { console.error(err); flash(friendlyError(err)); } finally { $("jGo").disabled = false; }
};
$("cTbl").onclick = async (e) => { const b = e.target.closest("[data-leave]"); if (!b) return;
  const r = rooms.find((x) => x.id === b.dataset.leave); if (!r || !confirm(`Leave ${r.className} (${r.teacherName})? You will no longer see that teacher's modules. Past exam results stay in your list.`)) return;
  try {
    await deleteDoc(doc(db, "enrollments", r.id));
    if (!rooms.some((x) => x.id !== r.id && x.ownerUid === r.ownerUid)) await deleteDoc(doc(db, "teacherLinks", `${S.number}_${r.ownerUid}`)).catch(() => {});
    await loadAll(); render(); flash("You left the classroom.", true);
  } catch (err) { flash(friendlyError(err)); } };

/* ---------- online exams: answer on screen, the server scores it with the answer key ---------- */
let P = null, A = [], timer = null, busy = false, endAt = 0;
const draftKey = () => `ark.draft.${user.uid}.${P.id}`, startKey = (id) => `ark.start.${user.uid}.${id}`;
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* private mode */ } };

/** Google Drive / Docs / YouTube links are turned into their embeddable "preview" form so the paper can sit beside the answer sheet. */
function embedUrl(u) {
  u = safeUrl(u); if (!u) return "";
  let m = /drive\.google\.com\/file\/d\/([\w-]+)/.exec(u) || /drive\.google\.com\/open\?id=([\w-]+)/.exec(u);
  if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;
  m = /docs\.google\.com\/(document|presentation|spreadsheets)\/d\/([\w-]+)/.exec(u);
  if (m) return `https://docs.google.com/${m[1]}/d/${m[2]}/preview`;
  m = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/.exec(u);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  return u;
}
const pts = (n) => `${n} pt${n === 1 ? "" : "s"}`;
/** Left side: the exam paper (the teacher's link, or the typed questions with their choices). */
function paperHTML(p) {
  const link = safeUrl(p.link);
  if (link) return `<iframe class="paperframe" src="${esc(embedUrl(link))}" title="Exam paper" referrerpolicy="no-referrer" allow="fullscreen"></iframe>
    <p class="fine muted">Paper not showing? <a href="${esc(link)}" target="_blank" rel="noopener">Open it in a new tab</a>, then come back and choose your answers on the answer sheet.</p>`;
  return p.items.map((it, i) => {
    const L = "ABCDE".slice(0, +p.choices || 5).split("");
    const opts = it.type === "mc" ? L.map((c, j) => `<div class="po" data-pick="${i}:${c}"><b>${c}.</b> <span>${esc((it.opts || [])[j] || "")}</span></div>`).join("")
      : it.type === "tf" ? `<div class="po" data-pick="${i}:T"><b>True</b></div><div class="po" data-pick="${i}:F"><b>False</b></div>` : "";
    return `<div class="pq"><div class="qh"><b>${i + 1}.</b><span class="qt">${esc(it.q)}</span><span class="pt">${pts(it.pts)}</span></div>${opts}</div>`;
  }).join("");
}
/** Right side: the answer sheet. Bubbles for multiple choice and true/false, a box for identification and essay. */
function sheetHTML(p) {
  const L = "ABCDE".slice(0, +p.choices || 5).split("");
  return p.items.map((it, i) => {
    const bub = (v, t) => `<label class="bub"><input type="radio" name="q${i}" value="${v}" aria-label="Number ${i + 1}, ${t}"><span>${t}</span></label>`;
    const ctl = it.type === "mc" ? `<div class="bubbles">${L.map((c) => bub(c, c)).join("")}</div>`
      : it.type === "tf" ? `<div class="bubbles">${bub("T", "True")}${bub("F", "False")}</div>`
      : it.type === "ident" ? `<input type="text" data-i="${i}" maxlength="300" autocomplete="off" placeholder="Type your answer" aria-label="Answer ${i + 1}">`
      : `<textarea data-i="${i}" rows="4" maxlength="4000" placeholder="Write your answer" aria-label="Answer ${i + 1}"></textarea>`;
    return `<div class="arow ${it.type === "essay" ? "tall" : ""}" data-q="${i}"><b class="an">${i + 1}</b>${ctl}</div>`;
  }).join("");
}
function count() {
  const n = A.filter((a) => String(a).trim()).length;
  $("rmCount").textContent = `${n} of ${A.length} answered`;
  document.querySelectorAll("#rmQs .arow").forEach((d) => d.classList.toggle("answered", !!String(A[+d.dataset.q]).trim()));
  document.querySelectorAll("#rmPaper .po").forEach((o) => { const [i, c] = o.dataset.pick.split(":"); o.classList.toggle("sel", A[+i] === c); });
}
function tick() {
  const left = Math.max(0, Math.round((endAt - Date.now()) / 1000)), m = Math.floor(left / 60), s = left % 60;
  $("rmTimer").textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`; $("rmTimer").classList.toggle("low", left <= 60);
  if (left === 0) { clearInterval(timer); flash("Time is up. Submitting your answers...", true); submitRoom(true); }
}
const setView = (v) => { $("rmSplit").dataset.view = v; $("rmSplit").querySelectorAll(".mobtabs .btn").forEach((b) => b.classList.toggle("on", b.dataset.v === v)); };
$("rmSplit").querySelector(".mobtabs").onclick = (e) => { const b = e.target.closest("button"); if (b) setView(b.dataset.v); };
const wide = (on) => { document.querySelector(".wrap").classList.toggle("wide", on); $("name").closest(".panel").hidden = on; }; // more room for the paper while answering
function openRoom(p, startedMs) {
  P = p; busy = false; A = p.items.map(() => "");
  try { const d = JSON.parse(lsGet(draftKey()) || "[]"); if (Array.isArray(d)) d.forEach((v, i) => { if (i < A.length && typeof v === "string") A[i] = v; }); } catch { /* ignore a damaged draft */ }
  $("rmTitle").textContent = p.title;
  $("rmMeta").textContent = [p.subject, p.teacherName, `${p.n} items`, `${p.totalPts} points`].filter(Boolean).join(" | ");
  $("rmInst").hidden = !p.instructions; $("rmInst").textContent = p.instructions || "";
  $("rmPaper").innerHTML = paperHTML(p); $("rmQs").innerHTML = sheetHTML(p); setView("paper");
  p.items.forEach((it, i) => { // put saved answers back
    const v = A[i]; if (!v) return;
    if (it.type === "mc" || it.type === "tf") { const r = $("rmQs").querySelector(`input[name="q${i}"][value="${v}"]`); if (r) r.checked = true; }
    else { const f = $("rmQs").querySelector(`[data-i="${i}"]`); if (f) f.value = v; }
  });
  document.querySelectorAll("[data-s]").forEach((s) => (s.hidden = true)); $("tabs").hidden = true; $("done").hidden = true; $("room").hidden = false; wide(true);
  $("rmSubmit").disabled = false; count(); scrollTo({ top: 0 });
  clearInterval(timer);
  if (p.timeLimit > 0) { endAt = startedMs + p.timeLimit * 60000; $("rmTimer").hidden = false; tick(); timer = setInterval(tick, 1000); } else $("rmTimer").hidden = true;
}
$("rmQs").addEventListener("input", (e) => {
  const t = e.target, q = t.closest(".arow"); if (!q || !P) return; const i = +q.dataset.q;
  A[i] = t.type === "radio" ? (t.checked ? t.value : A[i]) : t.value; lsSet(draftKey(), JSON.stringify(A)); count();
});
// clicking a choice on the paper selects it on the answer sheet
$("rmPaper").addEventListener("click", (e) => {
  const o = e.target.closest("[data-pick]"); if (!o) return; const [i, c] = o.dataset.pick.split(":");
  const r = $("rmQs").querySelector(`input[name="q${i}"][value="${c}"]`); if (r) { r.checked = true; r.dispatchEvent(new Event("input", { bubbles: true })); }
});
async function begin(p) {
  if (subs.has(p.id)) { P = p; return finish(p, subs.get(p.id)); } // answers already locked: only the score is missing
  const ref = doc(db, "examAttempts", `${p.id}_${profile.studentId}`);
  let a = attempts.get(p.id), startedMs;
  if (!a) {
    const old = await getDoc(ref);
    if (!old.exists()) await setDoc(ref, { examId: p.id, studentId: profile.studentId, studentUid: user.uid, ownerUid: p.ownerUid, schoolId: profile.schoolId, startedAt: serverTimestamp() });
    a = (await getDoc(ref)).data(); attempts.set(p.id, a); lsSet(startKey(p.id), String(Date.now()));
  }
  // The timer shown here counts from when THIS device opened the exam (so a wrong device clock cannot cut it short);
  // the server keeps its own record and marks work "Late" if it arrives after the limit.
  startedMs = +lsGet(startKey(p.id)) || a.startedAt?.toMillis?.() || Date.now();
  openRoom(p, startedMs);
}
$("eTbl").onclick = async (e) => {
  const b = e.target.closest("[data-take]"); if (!b) return; const p = papers.find((x) => x.id === b.dataset.take); if (!p) return;
  if (!attempts.has(p.id) && !confirm(`Start "${p.title}"?` + (p.timeLimit ? `\nYou have ${p.timeLimit} minutes. The timer starts now and cannot be paused.` : "") + "\nYou can submit this exam only once.")) return;
  b.disabled = true;
  try { await begin(p); } catch (err) { console.error(err); flash(friendlyError(err)); } finally { b.disabled = false; }
};
$("rmLeave").onclick = () => { clearInterval(timer); lsSet(draftKey(), JSON.stringify(A)); showTab("exams"); render(); flash(P.timeLimit ? "Your answers are saved on this device, but the timer keeps running." : "Your answers are saved on this device. Press Continue to finish.", true); };
$("doneBack").onclick = () => { showTab("exams"); render(); };
addEventListener("beforeunload", (e) => { if (!$("room").hidden) { e.preventDefault(); e.returnValue = ""; } });

/** Section to record: the student's own section, or the classroom joined with that teacher's code. */
function sectionFor(p) {
  if (p.ownerUid === S.ownerUid) return { classId: S.classId, className: S.className };
  const r = rooms.find((x) => x.ownerUid === p.ownerUid && (!p.classId || x.classId === p.classId));
  return r ? { classId: r.classId, className: r.className } : { classId: S.classId, className: S.className };
}
/** Step 2: the answers are locked, so the rules now let this student read the key. Score them and save the result. */
async function finish(p, sub) {
  const id = `${p.id}_${profile.studentId}`, k = await getDoc(doc(db, "examKeys", p.id));
  if (!k.exists()) throw new Error("The answer key was not found. Ask your teacher.");
  const key = k.data(), { missed, ...sc } = score({ items: key.items, choices: key.choices, passing: key.passing }, sub.answers, []); // identification / essay stay "to check"
  const att = attempts.get(p.id) || (await getDoc(doc(db, "examAttempts", id))).data(), sec = sectionFor(p);
  const late = p.timeLimit > 0 && sub.submittedAt?.toMillis && att?.startedAt?.toMillis && sub.submittedAt.toMillis() - att.startedAt.toMillis() > (p.timeLimit * 60 + 120) * 1000;
  const missedList = missed.map((m) => missedText(m, key.showAnswers === false));
  if (!results.some((r) => r.examId === p.id))
    await setDoc(doc(db, "scanResults", id), { ownerUid: p.ownerUid, schoolId: profile.schoolId, examId: p.id, studentId: profile.studentId, studentName: S.name, studentNumber: S.number, ...sec,
      answers: sub.answers, ...sc, teacherName: p.teacherName || "", examTitle: p.title, subject: p.subject || "", term: p.term || "", passingPct: key.passing || 75, missedList,
      via: "online", startedAt: att.startedAt, submittedAt: sub.submittedAt, scannedAt: serverTimestamp(), reviewedFlags: 0 });
  clearInterval(timer); lsDel(`ark.draft.${user.uid}.${p.id}`); lsDel(startKey(p.id));
  await loadAll(); showDone({ ...sc, late, missedList }); render();
}
async function submitRoom(auto) {
  if (busy || !P) return;
  const blank = A.filter((a) => !String(a).trim()).length;
  if (!auto && !confirm(blank ? `${blank} item${blank === 1 ? " is" : "s are"} still blank. Submit anyway? You cannot change your answers afterwards.` : "Submit your answers? You cannot change them afterwards.")) return;
  busy = true; $("rmSubmit").disabled = true;
  try {
    // Step 1: lock the answers (written once, cannot be changed afterwards)
    const sref = doc(db, "examSubmissions", `${P.id}_${profile.studentId}`);
    let sub = await getDoc(sref);
    if (!sub.exists()) { await setDoc(sref, { examId: P.id, studentId: profile.studentId, studentUid: user.uid, ownerUid: P.ownerUid, schoolId: profile.schoolId, answers: A.map(String), submittedAt: serverTimestamp() }); sub = await getDoc(sref); }
    subs.set(P.id, sub.data());
    await finish(P, sub.data());
  } catch (err) {
    console.error(err); busy = false; $("rmSubmit").disabled = false;
    flash(err?.code === "permission-denied" ? "The exam could not be submitted. It may have been closed by your teacher, or you already submitted it." : friendlyError(err));
  }
}
$("rmSubmit").onclick = () => submitRoom(false);

function showDone(r) {
  $("room").hidden = true; wide(false); $("tabs").hidden = true; document.querySelectorAll("[data-s]").forEach((s) => (s.hidden = true)); $("done").hidden = false;
  const score = `<p style="font-size:1.5rem;margin:.2rem 0"><b>${r.points} / ${r.maxPoints}</b> (${r.pct}%)`;
  $("doneBody").innerHTML = (r.final ? `${score} <span class="badge ${r.pass ? "active" : "suspended"}">${r.pass ? "Passed" : "Failed"}</span></p>`
    : `${score} so far</p><p class="muted">${r.pending} item${r.pending === 1 ? "" : "s"} still to be checked by your teacher. Your final score will appear under <b>My exam results</b>.</p>`)
    + (r.late ? '<p class="notice err">You submitted after the time limit. Your teacher can see this.</p>' : "")
    + (r.missedList?.length ? `<h3>Items to review</h3><div>${r.missedList.map((m) => `<span class="wr">${esc(m)}</span>`).join("")}</div>` : '<p class="muted">No wrong items.</p>');
  scrollTo({ top: 0 });
}

try { await loadAll(); } catch (e) { console.error(e); flash(friendlyError(e)); }
if (S) render();
