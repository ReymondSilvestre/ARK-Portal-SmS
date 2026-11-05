/* Leave requests for EVERY employee account (teacher, registrar, finance, custodian, guidance, HR and the IT Admin).
   Adds a "Leave request" button to the page's top bar. It opens a small window with the leave form and the person's own requests.
   Requests go to the HR account of the school, which approves or rejects them (HR page > Leave). Nothing else on the page is touched. */
import { requireRole, db, esc, friendlyError } from "./auth.js";
import { collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp } from "./db.js";

export const DEFAULT_LEAVE_TYPES = [
  { name: "Vacation leave", days: 15 }, { name: "Sick leave", days: 15 }, { name: "Emergency leave", days: 3 },
  { name: "Maternity / Paternity leave", days: 0 }, { name: "Leave without pay", days: 0 }, { name: "Other", days: 0 },
];
export const STATUS_CLASS = { Pending: "st-pending", Approved: "st-enrolled", Rejected: "st-out", Cancelled: "st-not" };
export const dateText = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || "") ? new Date(s + "T00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : s || "-");
export const rangeText = (r) => (r.startDate === r.endDate ? dateText(r.startDate) : `${dateText(r.startDate)} - ${dateText(r.endDate)}`);
/** Monday to Friday between two YYYY-MM-DD dates (inclusive). The person can still change the number (half days, Saturday classes ...). */
export function workingDays(a, b) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a || "") || !/^\d{4}-\d{2}-\d{2}$/.test(b || "") || b < a) return 0;
  let n = 0; const d = new Date(a + "T00:00"), e = new Date(b + "T00:00");
  for (; d <= e; d.setDate(d.getDate() + 1)) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}
export const roleName = (r) => ({ admin: "IT Admin", staff: "Staff", teacher: "Teacher", registrar: "Registrar", finance: "Finance", custodian: "Custodian", guidance: "Guidance", hr: "HR" }[r] || r || "");
export async function loadLeaveTypes(sid) {
  try { const s = await getDoc(doc(db, "hrSettings", sid)); const t = s.exists() && s.data().leaveTypes; if (Array.isArray(t) && t.length) return t; } catch { }
  return DEFAULT_LEAVE_TYPES;
}

/** A message that pops up in the CENTER of the screen (instead of a banner at the top or bottom of the page).
 *  buttons: [{ label, value, primary }]; input: { label, required } adds a text box. Resolves { value, text } (value null when closed with Esc / outside). */
export function showPopup({ title = "", html = "", ok, buttons, input, validate, onOpen } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement("div"); el.className = "lv-pop"; el.setAttribute("role", "alertdialog"); el.setAttribute("aria-modal", "true");
    const bs = buttons && buttons.length ? buttons : [{ label: "OK", value: "ok", primary: true }];
    el.innerHTML = `<div class="lv-pop-box${ok === true ? " ok" : ok === false ? " err" : ""}"><h3>${esc(title)}</h3><div class="lv-pop-body">${html}</div>
      <p class="lv-pop-err" id="lvPopErr2" hidden></p>${input ? `<label>${esc(input.label || "")}<textarea class="tall" maxlength="500" id="lvPopText" placeholder="${esc(input.placeholder || "")}"></textarea></label><p class="lv-pop-err" id="lvPopErr" hidden></p>` : ""}
      <div class="lv-pop-btns">${bs.map((b, i) => `<button type="button" class="btn${b.primary ? " primary" : ""}${b.danger ? " danger" : ""}" data-i="${i}">${esc(b.label)}</button>`).join("")}</div></div>`;
    document.body.append(el);
    const fieldsOf = () => Object.fromEntries([...el.querySelectorAll("[data-pf]")].map((f) => [f.dataset.pf, f.value]));
    const done = (value) => { const fields = fieldsOf(), text = (el.querySelector("#lvPopText") || {}).value || ""; el.remove(); removeEventListener("keydown", key); resolve({ value, text, fields }); };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(null); } };
    addEventListener("keydown", key);
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-i]"); if (!b) return;
      const def = bs[+b.dataset.i], t = el.querySelector("#lvPopText");
      if (input && input.required && def.primary && !t.value.trim()) { const er = el.querySelector("#lvPopErr"); er.textContent = input.required === true ? "Please write something first." : input.required; er.hidden = false; t.focus(); return; }
      if (validate && def.primary) { const msg = validate(fieldsOf()), er2 = el.querySelector("#lvPopErr2"); if (msg) { er2.textContent = msg; er2.hidden = false; return; } }
      done(def.value);
    });
    if (onOpen) onOpen(el);
    (el.querySelector("#lvPopText") || el.querySelector("[data-pf]") || el.querySelector(".btn.primary") || el.querySelector(".btn")).focus();
  });
}
export const errText = (e) => friendlyError(e) + (e && e.code === "permission-denied" ? " If this keeps happening, make sure the newest Code.gs is deployed in Apps Script (Deploy > Manage deployments > pencil > New version > Deploy)." : "");

const ROLES = ["teacher", "registrar", "finance", "custodian", "guidance", "hr", "staff", "admin"];
const m = await requireRole(ROLES).catch(() => null);
if (m) start(m);

function start({ user, profile }) {
  const SID = profile.schoolId, UID = user.uid, YEAR = new Date().getFullYear();
  const SEEN = "ark.leaveSeen." + UID;
  let mine = [], types = DEFAULT_LEAVE_TYPES, open = false;

  /* ---- the 2x2 photo (kept by HR) and the position, beside the person's name ---- */
  const who = document.getElementById("who");
  if (who && who.parentNode && !document.getElementById("whoPhoto") && !document.getElementById("sidePhoto")) {   // pages with the side panel show the photo, position and department there (js/sidepanel.js)
    if (profile.photo) { const im = Object.assign(document.createElement("img"), { src: profile.photo, alt: "", id: "whoPhoto", className: "who-photo" }); who.parentNode.insertBefore(im, who); }
    const pos = [profile.position, profile.department].filter(Boolean).join(", ") || (profile.role === "admin" ? "IT Admin" : "");
    if (pos) { const sm = Object.assign(document.createElement("small"), { className: "who-pos", id: "whoPos", textContent: pos }); who.after(sm); }
  }
  /* ---- the button in the top bar ---- */
  const out = document.getElementById("out"); if (!out) return;
  const btn = document.createElement("button"); btn.className = out.className.replace("danger", "").trim() || "btn small"; btn.type = "button"; btn.id = "leaveBtn"; btn.textContent = "Leave request";
  out.parentNode.insertBefore(btn, out); out.parentNode.insertBefore(document.createTextNode(" "), out);
  const setBadge = () => {
    const seen = +(localStorage.getItem(SEEN) || 0), news = mine.filter((r) => r.status !== "Pending" && (r.decidedAt?.toMillis?.() || 0) > seen).length;
    btn.textContent = news ? `Leave request (${news} new)` : "Leave request";
  };

  /* ---- the window ---- */
  const back = document.createElement("div"); back.className = "lv-back"; back.hidden = true;
  back.innerHTML = `<div class="lv-box" role="dialog" aria-modal="true" aria-label="Leave request"><div class="lv-head"><h2>Leave request</h2><button class="btn small" type="button" id="lvClose">Close</button></div>
        <form id="lvForm" novalidate><div class="row">
      <label>Leave type<select id="lvType"></select></label>
      <label>From<input type="date" id="lvFrom"></label><label>To<input type="date" id="lvTo"></label>
      <label class="narrow">Working days<input type="number" id="lvDays" min="0.5" max="366" step="0.5"></label></div>
      <label>Reason<textarea id="lvReason" class="tall" maxlength="1000" placeholder="Why are you filing this leave? (optional for some leave types)"></textarea></label>
      <p class="muted" id="lvBal"></p>
      <div class="savebar"><button class="btn primary" id="lvSend">Send to HR</button></div></form>
    <h3>My requests</h3><div class="tablewrap"><table id="lvList"></table></div></div>`;
  document.body.append(back);
  const $ = (id) => back.querySelector("#" + id);
  const flash = (t, ok) => { showPopup({ title: ok ? "Done" : "Could not send", html: `<p>${esc(t)}</p>`, ok: !!ok }); };
  const close = () => { back.hidden = true; open = false; document.body.classList.remove("lv-open"); };
  const usedBy = (type) => mine.filter((r) => r.status === "Approved" && r.leaveType === type && (r.startDate || "").startsWith(String(YEAR))).reduce((a, r) => a + (+r.days || 0), 0);

  function renderBalance() {
    const t = types.find((x) => x.name === $("lvType").value);
    $("lvBal").textContent = t && +t.days > 0 ? `${t.name}: ${t.days} days a year, ${Math.round(usedBy(t.name) * 10) / 10} used in ${YEAR}, ${Math.round((t.days - usedBy(t.name)) * 10) / 10} left.` : "";
  }
  function renderList() {
    const rows = [...mine].sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    $("lvList").innerHTML = "<tr><th>Leave</th><th>Dates</th><th>Days</th><th>Status</th><th>HR remarks</th><th></th></tr>" +
      (rows.map((r) => `<tr><td>${esc(r.leaveType)}${r.reason ? `<br><small>${esc(r.reason)}</small>` : ""}</td><td>${esc(rangeText(r))}</td><td>${esc(r.days)}</td>
        <td><span class="badge ${STATUS_CLASS[r.status] || ""}">${esc(r.status)}</span>${r.decidedAt?.toDate ? `<br><small>${esc(r.decidedAt.toDate().toLocaleDateString())}</small>` : ""}</td><td>${esc(r.hrRemarks || "")}</td>
        <td class="actions">${r.status === "Pending" ? `<button class="btn small" data-c="${esc(r.id)}" type="button">Cancel request</button>` : r.status !== "Approved" ? `<button class="btn small danger" data-d="${esc(r.id)}" type="button">Remove</button>` : ""}</td></tr>`).join("") ||
        `<tr><td colspan="6">You have not sent a leave request yet.</td></tr>`);
  }
  async function load() {
    const [snap, lt] = await Promise.all([getDocs(query(collection(db, "leaveRequests"), where("schoolId", "==", SID), where("requesterUid", "==", UID))), loadLeaveTypes(SID)]);
    mine = snap.docs.map((d) => ({ id: d.id, ...d.data() })); types = lt;
    const v = $("lvType").value; $("lvType").innerHTML = types.map((t) => `<option>${esc(t.name)}</option>`).join(""); if (types.some((t) => t.name === v)) $("lvType").value = v;
    renderBalance(); renderList(); setBadge();
  }
  const calc = () => { const n = workingDays($("lvFrom").value, $("lvTo").value); if (n) $("lvDays").value = n; };
  $("lvFrom").onchange = () => { if (!$("lvTo").value || $("lvTo").value < $("lvFrom").value) $("lvTo").value = $("lvFrom").value; calc(); };
  $("lvTo").onchange = calc; $("lvType").onchange = renderBalance;
  $("lvClose").onclick = close; back.addEventListener("click", (e) => { if (e.target === back) close(); }); addEventListener("keydown", (e) => { if (e.key === "Escape" && open) close(); });

  $("lvForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const type = $("lvType").value, a = $("lvFrom").value, b = $("lvTo").value, days = +$("lvDays").value, reason = $("lvReason").value.trim();
    if (!type) return flash("Choose the kind of leave.");
    if (!a || !b) return flash("Enter the first and the last day of the leave.");
    if (b < a) return flash("The last day cannot be before the first day.");
    if (!(days > 0)) return flash("Enter the number of working days (for example 1, or 0.5 for a half day).");
    if (type === "Other" && !reason) return flash("Please explain the reason for this leave.");
    $("lvSend").disabled = true;
    try {
      const ref = doc(collection(db, "leaveRequests"));
      await setDoc(ref, { schoolId: SID, requesterUid: UID, requesterName: profile.displayName || "", requesterRole: profile.role, employeeId: profile.employeeId || "", leaveType: type, startDate: a, endDate: b, days, reason, status: "Pending", createdAt: serverTimestamp() });
      mine.push({ id: ref.id, schoolId: SID, requesterUid: UID, leaveType: type, startDate: a, endDate: b, days, reason, status: "Pending", createdAt: Timestamp.now() });
      $("lvReason").value = ""; $("lvFrom").value = ""; $("lvTo").value = ""; $("lvDays").value = "";
      renderList(); renderBalance(); flash(`Your ${type.toLowerCase()} request (${rangeText({ startDate: a, endDate: b })}, ${days} day${days === 1 ? "" : "s"}) was sent to HR. You will see the answer here.`, true);
    } catch (err) { console.error(err); flash(errText(err)); } finally { $("lvSend").disabled = false; }
  });
  $("lvList").addEventListener("click", async (e) => {
    const c = e.target.closest("[data-c]"), d = e.target.closest("[data-d]"); if (!c && !d) return;
    const r = mine.find((x) => x.id === (c || d).dataset[c ? "c" : "d"]); if (!r) return;
    if ((await showPopup({ title: c ? "Cancel this leave request?" : "Remove this request?", html: `<p>${esc(r.leaveType)}, ${esc(rangeText(r))}</p>`, buttons: [{ label: "Keep it", value: "no" }, { label: c ? "Cancel request" : "Remove", value: "yes", primary: true }] })).value !== "yes") return;
    try {
      if (c) { await updateDoc(doc(db, "leaveRequests", r.id), { status: "Cancelled", updatedAt: serverTimestamp() }); r.status = "Cancelled"; }
      else { await deleteDoc(doc(db, "leaveRequests", r.id)); mine = mine.filter((x) => x.id !== r.id); }
      renderList(); renderBalance(); setBadge();
    } catch (err) { console.error(err); flash(errText(err)); }
  });

  btn.onclick = () => {
    back.hidden = false; open = true; document.body.classList.add("lv-open");
    load().then(() => { localStorage.setItem(SEEN, String(Date.now())); setBadge(); }).catch((err) => flash(errText(err)));
  };
  load().then(() => {   // HR answered while the person was away: tell them in the middle of the screen
    const seen = +(localStorage.getItem(SEEN) || 0), fresh = mine.filter((r) => r.status !== "Pending" && r.status !== "Cancelled" && (r.decidedAt?.toMillis?.() || 0) > seen);
    if (!fresh.length) return;
    showPopup({ title: fresh.length === 1 ? "HR answered your leave request" : `HR answered ${fresh.length} leave requests`, ok: fresh.every((r) => r.status === "Approved"),
      html: fresh.map((r) => `<p><b>${esc(r.leaveType)}</b> (${esc(rangeText(r))}): <span class="badge ${STATUS_CLASS[r.status] || ""}">${esc(r.status)}</span>${r.hrRemarks ? `<br><small>${esc(r.hrRemarks)}</small>` : ""}</p>`).join(""),
      buttons: [{ label: "Close", value: "close" }, { label: "View my requests", value: "view", primary: true }] }).then((a) => { localStorage.setItem(SEEN, String(Date.now())); setBadge(); if (a.value === "view") btn.click(); });
  }).catch(() => { });
}
