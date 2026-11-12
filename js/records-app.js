/* Shared page engine for the Custodian and Guidance accounts.
   A page (custodian.js / guidance.js) only describes WHAT it records (kinds of record, their fields, the lists the user can edit, the dashboard);
   this file draws everything: dashboard, add / edit form, records list with filters, student file, history log, settings, Excel downloads.
   Records are stored per school in the collections named in the config and are copied (as plain words) into the readable Records sheet by the server. */
import { liveRefresh } from "./db.js";   // live updates: other users' saves appear here by themselves
import { requireRole, logout, db, esc, friendlyError, ageOf, applyBranding } from "./auth.js";
import { collection, query, where, getDocs, getDoc, doc, setDoc, deleteDoc, serverTimestamp } from "./db.js";
import { termRank } from "./omr.js";

const $ = (id) => document.getElementById(id);
const GRADES = ["Kindergarten", ...Array.from({ length: 12 }, (_, i) => "Grade " + (i + 1))];
const FTYPES = { text: "Text", number: "Number", date: "Date", select: "Dropdown list", yesno: "Yes / No" };
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dateText = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || "") ? new Date(s + "T00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : s || "-");
const schoolYearNow = () => { const d = new Date(), y = d.getFullYear(); return d.getMonth() >= 5 ? `${y}-${y + 1}` : `${y - 1}-${y}`; };
const options = (list, first) => (first !== undefined ? `<option value="">${esc(first)}</option>` : "") + list.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
const keep = (id, html) => { const el = $(id); if (!el) return; const v = el.value; el.innerHTML = html; if ([...el.options].some((o) => o.value === v)) el.value = v; };
const clip = (v, n = 160) => String(v ?? "").slice(0, n);
const pc = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + "%" : "-");
const bar = (a, b) => `<span class="bar"><i style="width:${b ? Math.min(100, Math.round((a / b) * 100)) : 0}%"></i></span>`;
const hdr = (cols) => "<tr>" + cols.map((c) => `<th>${c}</th>`).join("") + "</tr>";
const rowHtml = (cells, cls) => `<tr${cls ? ` class="${cls}"` : ""}>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
const emptyRow = (n, t) => `<tr><td colspan="${n}">${t}</td></tr>`;
const slugName = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "records";

export async function startRecordsApp(cfg) {
  const { user, profile, school } = await requireRole([cfg.role, "schooladmin"]);   // the School Admin opens this page view-only (js/viewonly.js)
  const SID = profile.schoolId;
  $("who").textContent = `${profile.displayName} (${cfg.title})`; $("out").onclick = logout;
  applyBranding(school);

  const flash = (t, ok) => { const m = $("msg"); m.textContent = t; m.className = "notice noprint " + (ok ? "ok" : "err"); m.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => (m.hidden = true), 9000); scrollTo({ top: 0, behavior: "smooth" }); };
  const net = () => { $("sync").className = "sync" + (navigator.onLine ? "" : " off"); $("sync").lastElementChild.textContent = navigator.onLine ? "Online" : "Offline - changes will not save"; };
  addEventListener("online", net); addEventListener("offline", net); net();
  const run = async (fn) => { try { await fn(); } catch (e) { console.error(e); flash(friendlyError(e)); } };

  /* ---------- state ---------- */
  const KINDS = cfg.kinds, KMAP = Object.fromEntries(KINDS.map((k) => [k.key, k]));
  const S = { registry: [], enrollments: [], recs: {}, lists: {}, fields: {}, log: [], logLoaded: false, latest: new Map() };
  KINDS.forEach((k) => { S.recs[k.key] = []; S.fields[k.key] = []; });
  (cfg.lists || []).forEach((l) => (S.lists[l.key] = [...l.defaults]));
  const edit = {};                        // kind -> id of the record being edited
  const editRec = {};                     // kind -> the record itself
  const bySchool = async (c) => (await getDocs(query(collection(db, c), where("schoolId", "==", SID)))).docs.map((d) => ({ id: d.id, ...d.data() }));
  const tsec = (x) => x?.createdAt?.seconds || 0;
  const byNewest = (a, b) => String(b.date || "").localeCompare(String(a.date || "")) || tsec(b) - tsec(a);

  async function refresh() {
    await run(async () => {
      const [reg, ens, set, ...rc] = await Promise.all([bySchool("registry"), bySchool("enrollmentRecords"), getDoc(doc(db, cfg.settingsColl, SID)).catch(() => null), ...KINDS.map((k) => bySchool(k.coll))]);
      S.registry = reg.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      S.enrollments = ens; S.latest = new Map();
      [...ens].sort((a, b) => (a.remark ? 1 : 0) - (b.remark ? 1 : 0) || (b.schoolYear || "").localeCompare(a.schoolYear || "") || termRank(b.term) - termRank(a.term) || tsec(b) - tsec(a)).forEach((e) => { if (!S.latest.has(e.registryId)) S.latest.set(e.registryId, e); });
      KINDS.forEach((k, i) => (S.recs[k.key] = rc[i].sort(byNewest)));
      if (set && set.exists()) {
        const d = set.data();
        (cfg.lists || []).forEach((l) => { const v = d.lists && d.lists[l.key]; if (Array.isArray(v) && v.length) S.lists[l.key] = v; });
        KINDS.forEach((k) => { const v = d.fields && d.fields[k.key]; if (Array.isArray(v)) S.fields[k.key] = v; });
      }
      renderAll();
    });
  }
  const saveSettings = () => setDoc(doc(db, cfg.settingsColl, SID), { schoolId: SID, lists: S.lists, fields: S.fields, updatedAt: serverTimestamp() }, { merge: true });

  /* ---------- student helpers ---------- */
  const enrolOf = (r) => S.latest.get(r.id) || null;
  const gradeOf = (r) => (enrolOf(r) && enrolOf(r).gradeLevel) || r.gradeLevel || "";
  const sectionOf = (r) => (enrolOf(r) && enrolOf(r).sectionName) || "";
  const yearOf = (r) => (enrolOf(r) && enrolOf(r).schoolYear) || r.schoolYear || "";
  const regOf = (id) => S.registry.find((x) => x.id === id);
  const yearsList = () => [...new Set([schoolYearNow(), ...S.registry.map((r) => r.schoolYear), ...KINDS.flatMap((k) => S.recs[k.key].map((x) => x.schoolYear))].filter(Boolean))].sort().reverse();
  const infoGrid = (r) => [["Name", r.name], ["Student ID No.", r.studentNo], ["Grade level", gradeOf(r) || "-"], ["Section", sectionOf(r) || "-"], ["School year", yearOf(r) || "-"], ["Gender", r.gender || "-"], ["Age", ageOf(r.birthday) || "-"],
    ["Guardian", r.guardianName || r.mother || r.father || "-"], ["Guardian contact", r.guardianContact || r.contact || "-"]].map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("");
  const pickerHtml = (p) => `<div class="row"><label>Find a student<input id="${p}q" placeholder="Student ID No., LRN or name" autocomplete="off"></label><label>Student<select id="${p}stu"></select></label></div><div class="infogrid" id="${p}info" hidden></div>`;
  function fillPicker(p, select) {
    const q = $(p + "q").value.trim().toLowerCase();
    const rows = S.registry.filter((r) => !q || [r.studentNo, r.lrn, r.name].join(" ").toLowerCase().includes(q)).slice(0, 60);
    keep(p + "stu", rows.map((r) => `<option value="${esc(r.id)}">${esc(r.studentNo)} - ${esc(r.name)}${r.lrn ? " (LRN " + esc(r.lrn) + ")" : ""}</option>`).join("") || `<option value="">No registered student found</option>`);
    if (select && rows.some((r) => r.id === select)) $(p + "stu").value = select;
    const r = regOf($(p + "stu").value);
    $(p + "info").hidden = !r; if (r) $(p + "info").innerHTML = infoGrid(r);
    return r || null;
  }

  /* ---------- fields ---------- */
  const optsOf = (f) => (f.type === "list" ? S.lists[f.list] || [] : f.options || []);
  function control(id, f) {
    const a = `id="${id}" data-f="${esc(f.id)}"`;
    if (f.type === "textarea") return `<textarea ${a} class="tall" maxlength="1000"></textarea>`;
    if (f.type === "select" || f.type === "list") return `<select ${a}>${f.req && f.def ? "" : '<option value="">-</option>'}${optsOf(f).map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
    if (f.type === "yesno") return `<select ${a}><option value="">-</option><option>Yes</option><option>No</option></select>`;
    return `<input ${a} type="${f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}" ${f.type === "number" ? 'step="any" min="0" inputmode="decimal"' : ""} autocomplete="off" maxlength="200">`;
  }
  const fieldBox = (id, f) => `<label class="${f.type === "textarea" ? "full" : f.wide ? "wide2" : ""}">${esc(f.label)}${f.req ? ' <span class="req">*</span>' : ""}${f.hint ? `<small>${esc(f.hint)}</small>` : ""}${control(id, f)}</label>`;
  const customHtml = (k, i) => `<label data-xwrap>${esc(i.label)}${i.type === "select" ? control(`${k.key}_x_${i.id}`, { id: i.id, type: "select", options: i.options }) : i.type === "yesno" ? control(`${k.key}_x_${i.id}`, { id: i.id, type: "yesno" }) : control(`${k.key}_x_${i.id}`, { id: i.id, type: i.type })}</label>`.replace("data-f=", "data-x=");
  const readForm = (k) => {
    const v = {}, x = {};
    k.fields.forEach((f) => { const el = $(`${k.key}_f_${f.id}`); v[f.id] = el ? el.value.trim() : ""; });
    S.fields[k.key].forEach((i) => { const el = $(`${k.key}_x_${i.id}`); x[i.id] = el ? el.value.trim() : ""; });
    return { v, x };
  };
  function writeForm(k, rec) {
    k.fields.forEach((f) => { const el = $(`${k.key}_f_${f.id}`); if (el) el.value = rec ? rec[f.id] ?? "" : f.type === "date" && f.today ? localDate() : f.def ?? ""; });
    S.fields[k.key].forEach((i) => { const el = $(`${k.key}_x_${i.id}`); if (el) el.value = rec ? (rec.extra || {})[i.id] ?? "" : ""; });
  }
  function drawForm(k) {            // rebuilt whenever a list or an additional field changes; typed values are kept
    const fresh = !$(`${k.key}_fields`).children.length, cur = fresh ? null : readForm(k);
    $(`${k.key}_fields`).innerHTML = k.fields.map((f) => fieldBox(`${k.key}_f_${f.id}`, f)).join("");
    $(`${k.key}_extra`).innerHTML = S.fields[k.key].map((i) => customHtml(k, i)).join(""); $(`${k.key}_extraBox`).hidden = !S.fields[k.key].length;
    if (fresh) { writeForm(k, editRec[k.key] || null); return; }
    k.fields.forEach((f) => { const el = $(`${k.key}_f_${f.id}`); if (el) el.value = cur.v[f.id]; });
    S.fields[k.key].forEach((i) => { const el = $(`${k.key}_x_${i.id}`); if (el && cur.x[i.id] !== undefined) el.value = cur.x[i.id]; });
  }

  /* ---------- history log ---------- */
  async function logEvent(action, label, changes, note) {
    try {
      await setDoc(doc(collection(db, cfg.logColl)), { schoolId: SID, at: serverTimestamp(), byUid: user.uid, byName: profile.displayName || "", byNo: profile.employeeId || "", action, label: clip(label, 200), note: clip(note, 400),
        changes: (changes || []).slice(0, 40).map((c) => ({ f: clip(c.f, 80), from: clip(c.from), to: clip(c.to) })) });
      S.logLoaded = false;
    } catch (e) { console.warn("History entry could not be saved", e); }
  }

  /* ---------- skeleton of every tab ---------- */
  const secs = (n) => document.querySelector(`[data-s="${n}"]`);
  const multi = KINDS.length > 1;
  const subnav = (id, items) => `<div class="subnav noprint" data-sub="${id}">${items.map(([p, t]) => `<button class="btn" type="button" data-p="${p}">${t}</button>`).join("")}</div>`;

  secs("dash").innerHTML = `<div class="panel"><h2>${esc(cfg.title)} dashboard</h2><p class="muted fine">${esc(cfg.dashNote || "")}</p><div class="row"><label>School year<select id="dsYear"></select></label></div></div><div class="cards" id="dsCards"></div><div class="dgrid" id="dsPanels"></div>`;

  secs("add").innerHTML = (multi ? subnav("add", KINDS.map((k) => ["add_" + k.key, esc(k.addTab || k.label)])) : "") +
    KINDS.map((k) => `<div class="panel" data-p="add_${k.key}" ${multi && k !== KINDS[0] ? "hidden" : ""}><h2 id="${k.key}_head">${esc(k.addTitle)}</h2>
      <p class="muted fine">${esc(k.addNote || "")}</p>
      ${pickerHtml(k.key + "_")}
      <div class="formgrp"><h3>${esc(k.label)} details</h3><div class="row" id="${k.key}_fields" style="align-items:end"></div></div>
      <div class="formgrp" id="${k.key}_extraBox" hidden><h3>Additional information</h3><div class="row" id="${k.key}_extra"></div></div>
      <div class="btnbar"><button class="btn primary" id="${k.key}_save" type="button">Save record</button><button class="btn" id="${k.key}_cancel" type="button" hidden>Cancel editing</button></div></div>`).join("");

  secs("list").innerHTML = (multi ? subnav("list", KINDS.map((k) => ["list_" + k.key, `${esc(k.plural)} <span class="cnt" id="${k.key}_cnt"></span>`])) : "") +
    KINDS.map((k) => `<div class="panel" data-p="list_${k.key}" ${multi && k !== KINDS[0] ? "hidden" : ""}><h2>${esc(k.plural)} ${multi ? "" : `<span class="cnt" id="${k.key}_cnt"></span>`}</h2>
      <div class="row"><label>Search<input id="${k.key}_lq" placeholder="Student ID No., name or any word in the record" autocomplete="off"></label>
      <label>From<input type="date" id="${k.key}_from"></label><label>To<input type="date" id="${k.key}_to"></label>
      <label>Grade level<select id="${k.key}_grade"></select></label><label>School year<select id="${k.key}_year"></select></label>
      ${(k.filters || []).map((f) => `<label>${esc(f.label)}<select id="${k.key}_fl_${f.field}"></select></label>`).join("")}</div>
      <div class="btnbar"><button class="btn primary" id="${k.key}_xlsx" type="button">Download this list (Excel)</button><button class="btn" id="${k.key}_xall" type="button">Download all ${esc(k.plural.toLowerCase())} (Excel)</button><button class="btn" id="${k.key}_clear" type="button">Clear filters</button></div>
      <p class="muted fine" id="${k.key}_count"></p><div class="scrollbox"><table id="${k.key}_tbl"></table></div></div>`).join("");

  secs("file").innerHTML = `<div class="panel"><h2>Student file</h2><p class="muted fine">Everything recorded for one student, in one place.</p>${pickerHtml("sf_")}
    <div class="btnbar" id="sfBtns"></div><div class="scrollbox"><table id="sfTbl"></table></div></div>`;

  if (cfg.matrix && secs("matrix")) secs("matrix").innerHTML = `<div class="panel"><h2>${esc(cfg.matrix.title)}</h2><p class="muted fine">${esc(cfg.matrix.note || "")}</p>
    <div class="row"><label>Search<input id="mxQ" placeholder="Student ID No., LRN or name" autocomplete="off"></label><label>Grade level<select id="mxGrade"></select></label><label>School year registered<select id="mxYear"></select></label>
    <label>Show students who have NOT received<select id="mxMiss"></select></label></div>
    <div class="btnbar"><button class="btn primary" id="mxXlsx" type="button">Download (Excel)</button><button class="btn" id="mxClear" type="button">Clear filters</button></div>
    <p class="muted fine" id="mxCount"></p><div class="scrollbox"><table id="mxTbl" class="matrix"></table></div></div>`;

  secs("history").innerHTML = `<div class="panel"><h2>History log</h2><p class="muted fine">Every record added, edited or deleted, and every change to the settings, with who did it and when. Entries cannot be edited or deleted.</p>
    <div id="hiNote" class="notice err" hidden></div><div class="row"><label>Search<input id="hiQ" placeholder="Student, person or detail" autocomplete="off"></label><label>Action<select id="hiAct"></select></label></div>
    <div class="btnbar"><button class="btn" id="hiRefresh" type="button">Refresh</button><button class="btn primary" id="hiXlsx" type="button">Download history (Excel)</button></div>
    <p class="muted fine" id="hiCount"></p><div class="scrollbox"><table id="hiTbl"></table></div></div>`;

  const hasLists = (cfg.lists || []).length > 0;
  secs("settings").innerHTML = subnav("settings", [...(hasLists ? [["stLists", "Lists"]] : []), ["stFields", "Additional information"]]) +
    (hasLists ? `<div class="panel" data-p="stLists"><h2>Lists</h2><p class="muted fine">The choices shown in the drop-down lists of the forms.</p>${cfg.lists.map((l) => `<div class="fgroup"><h3>${esc(l.title)}</h3>${l.help ? `<p class="muted fine">${esc(l.help)}</p>` : ""}<div class="chiplist" id="ls_${l.key}"></div>
      <div class="row"><label>Add ${esc(l.one)}<input id="lsn_${l.key}" maxlength="40" autocomplete="off"></label><button class="btn primary" type="button" data-ladd="${l.key}">Add</button></div></div>`).join("")}</div>` : "") +
    `<div class="panel" data-p="stFields" ${hasLists ? "hidden" : ""}><h2>Additional information</h2><p class="muted fine">Add your own fields. They appear on the form, in the list, in the Excel download and in the readable Records sheet.</p><div id="fieldsBox"></div></div>`;

  /* ---------- navigation ---------- */
  const SUB = {};
  function showSub(pg, p) {
    const sec = secs(pg), nav = sec && sec.querySelector(".subnav"); if (!nav) return;
    p = p || SUB[pg] || nav.querySelector("button[data-p]").dataset.p; SUB[pg] = p;
    sec.querySelectorAll(":scope > .panel[data-p]").forEach((el) => (el.hidden = el.dataset.p !== p));
    nav.querySelectorAll("button[data-p]").forEach((b) => { const on = b.dataset.p === p; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
  }
  function show(t, p) {
    document.querySelectorAll("[data-s]").forEach((s) => (s.hidden = s.dataset.s !== t));
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
    showSub(t, p);
    if (t === "history" && !S.logLoaded) run(loadHistory);
  }
  $("tabs").onclick = (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.t); };
  document.addEventListener("click", (e) => { const nb = e.target.closest(".subnav button[data-p]"); if (nb) showSub(nb.closest("[data-s]").dataset.s, nb.dataset.p); });

  /* ---------- add / edit a record ---------- */
  function resetForm(k) {
    edit[k.key] = null; editRec[k.key] = null; writeForm(k, null);
    $(`${k.key}_q`).disabled = $(`${k.key}_stu`).disabled = false; $(`${k.key}_head`).textContent = k.addTitle; $(`${k.key}_save`).textContent = "Save record"; $(`${k.key}_cancel`).hidden = true;
  }
  function startEdit(k, rec) {
    edit[k.key] = rec.id; editRec[k.key] = rec; writeForm(k, rec);
    const r = regOf(rec.registryId);
    $(`${k.key}_q`).value = rec.studentNo || ""; fillPicker(k.key + "_", rec.registryId); $(`${k.key}_q`).disabled = $(`${k.key}_stu`).disabled = true;
    if (!r) { $(`${k.key}_info`).hidden = false; $(`${k.key}_info`).innerHTML = `<div><span>Name</span><b>${esc(rec.name)}</b></div><div><span>Student ID No.</span><b>${esc(rec.studentNo)}</b></div>`; }
    $(`${k.key}_head`).textContent = `Edit record - ${rec.name}`; $(`${k.key}_save`).textContent = "Save changes"; $(`${k.key}_cancel`).hidden = false;
    show("add", "add_" + k.key); scrollTo({ top: 0 });
  }
  const labelOf = (k, id) => (k.fields.find((f) => f.id === id) || S.fields[k.key].find((f) => f.id === id) || {}).label || id;
  KINDS.forEach((k) => {
    $(`${k.key}_q`).oninput = () => fillPicker(k.key + "_"); $(`${k.key}_stu`).onchange = () => fillPicker(k.key + "_");
    $(`${k.key}_cancel`).onclick = () => resetForm(k);
    if (k.onForm) $(`${k.key}_fields`).addEventListener("input", () => k.onForm(k, (id) => $(`${k.key}_f_${id}`)));
    $(`${k.key}_save`).onclick = () => run(async () => {
      const { v, x } = readForm(k), old = editRec[k.key];
      const r = old ? regOf(old.registryId) || { id: old.registryId, studentNo: old.studentNo, name: old.name, gradeLevel: old.gradeLevel, schoolYear: old.schoolYear } : fillPicker(k.key + "_");
      if (!r) return flash("Find and choose a student first.");
      for (const f of k.fields) {
        if (f.req && !v[f.id]) return flash(`Enter: ${f.label}.`);
        if (f.type === "number" && v[f.id] !== "" && !(Number(v[f.id]) >= 0)) return flash(`${f.label} must be a number.`);
      }
      const fixed = Object.fromEntries(k.fields.map((f) => [f.id, f.type === "number" && v[f.id] !== "" ? Number(v[f.id]) : v[f.id]]));
      const base = old ? {} : { schoolId: SID, registryId: r.id, studentNo: r.studentNo, name: r.name, gradeLevel: gradeOf(r), sectionName: sectionOf(r), schoolYear: yearOf(r), examNo: r.examNo || "", createdBy: user.uid, createdByName: profile.displayName || "", createdAt: serverTimestamp() };
      const rec = { ...base, ...fixed, extra: x, updatedByName: profile.displayName || "", updatedAt: serverTimestamp() };
      const ref = old ? doc(db, k.coll, old.id) : doc(collection(db, k.coll));
      await setDoc(ref, rec, { merge: true });
      const who = `${r.name} (${r.studentNo})`;
      if (!old) await logEvent("Added record", who, [], `${k.label}: ${k.summary({ ...fixed, extra: x })}`);
      else {
        const ch = [...k.fields.map((f) => ({ f: f.label, from: String(old[f.id] ?? ""), to: String(fixed[f.id] ?? "") })), ...S.fields[k.key].map((i) => ({ f: i.label, from: String((old.extra || {})[i.id] ?? ""), to: String(x[i.id] ?? "") }))].filter((c) => c.from !== c.to);
        if (ch.length) await logEvent("Edited record", who, ch, k.label);
      }
      const was = !!old; resetForm(k); $(`${k.key}_q`).value = ""; fillPicker(k.key + "_");
      await refresh(); flash(was ? `Saved changes for ${r.name}.` : `Saved the ${k.label.toLowerCase()} of ${r.name}.`, true);
    });
  });

  /* ---------- records list ---------- */
  const cellFor = (f, rec) => {
    const v = rec[f.id]; if (v === undefined || v === null || v === "") return "-";
    if (f.badges && f.badges[v]) return `<span class="badge ${f.badges[v]}">${esc(v)}</span>`;
    if (f.type === "date") return esc(dateText(v));
    return esc(clip(v, 140));
  };
  const listF = (k) => ({ q: $(`${k.key}_lq`).value.trim().toLowerCase(), from: $(`${k.key}_from`).value, to: $(`${k.key}_to`).value, g: $(`${k.key}_grade`).value, y: $(`${k.key}_year`).value });
  function listRows(k) {
    const f = listF(k);
    return S.recs[k.key].filter((r) => {
      if ((f.from && (r.date || "") < f.from) || (f.to && (r.date || "") > f.to) || (f.g && r.gradeLevel !== f.g) || (f.y && r.schoolYear !== f.y)) return false;
      for (const fl of k.filters || []) { const val = $(`${k.key}_fl_${fl.field}`).value; if (val && String(r[fl.field] ?? "") !== val) return false; }
      return !f.q || [r.studentNo, r.name, r.createdByName, ...k.fields.map((x) => r[x.id]), ...Object.values(r.extra || {})].join(" ").toLowerCase().includes(f.q);
    });
  }
  const shownFields = (k) => k.fields.filter((f) => (k.listCols || []).includes(f.id));
  function renderList(k) {
    const rows = listRows(k), cols = shownFields(k), dv = k.derived || [], xf = S.fields[k.key];
    $(`${k.key}_cnt`).textContent = `(${S.recs[k.key].length})`;
    $(`${k.key}_count`).textContent = `${rows.length} of ${S.recs[k.key].length} record${S.recs[k.key].length === 1 ? "" : "s"}` + (rows.length > 12 ? " - scroll the list to see all" : "");
    $(`${k.key}_tbl`).innerHTML = hdr(["Date", "Student ID No.", "Name", "Grade", ...cols.map((f) => esc(f.label)), ...dv.map((d) => esc(d.label)), ...(xf.length ? ["Additional information"] : []), "Recorded by", ""]) +
      (rows.slice(0, 3000).map((r) => `<tr><td>${esc(dateText(r.date))}</td><td>${esc(r.studentNo)}</td><td>${esc(r.name)}</td><td>${esc(r.gradeLevel || "")}</td>${cols.map((f) => `<td${f.type === "textarea" ? ' class="wrapcell"' : ""}>${cellFor(f, r)}</td>`).join("")}${dv.map((d) => `<td>${esc(d.fn(r) || "-")}</td>`).join("")}${xf.length ? `<td class="wrapcell">${esc(xf.map((i) => ((r.extra || {})[i.id] ? `${i.label}: ${r.extra[i.id]}` : "")).filter(Boolean).join("; ") || "-")}</td>` : ""}<td>${esc(r.createdByName || "-")}</td>
        <td class="actions"><button class="btn small" data-ed="${esc(r.id)}">Edit</button><button class="btn small danger" data-dl="${esc(r.id)}">Delete</button></td></tr>`).join("") || emptyRow(8 + cols.length + dv.length, "No records found."));
  }
  const exportRow = (k, r) => ({ Date: r.date || "", "Student ID No.": r.studentNo || "", Name: r.name || "", "Grade Level": r.gradeLevel || "", Section: r.sectionName || "", "School Year": r.schoolYear || "",
    ...Object.fromEntries(k.fields.map((f) => [f.label, r[f.id] ?? ""])), ...Object.fromEntries((k.derived || []).map((d) => [d.label, d.fn(r) || ""])), ...Object.fromEntries(S.fields[k.key].map((i) => [i.label, (r.extra || {})[i.id] ?? ""])),
    "Recorded by": r.createdByName || "", "Recorded on": r.createdAt?.toDate ? r.createdAt.toDate().toLocaleString() : "" });
  function saveXlsx(sheets, file) {
    if (!window.XLSX) return flash("The Excel writer did not load. Check your internet connection.");
    const wb = XLSX.utils.book_new(), used = new Set();
    sheets.forEach(({ name, rows, header }) => {
      const base = (String(name).replace(/[\[\]:*?\/\\]/g, "-").slice(0, 28).trim()) || "Sheet"; let n = base, i = 2;
      while (used.has(n.toLowerCase())) n = `${base} ${i++}`; used.add(n.toLowerCase());
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { header }), n);
    });
    XLSX.writeFile(wb, file);
  }
  const sheetOf = (k, recs) => ({ name: k.plural, rows: recs.map((r) => exportRow(k, r)), header: Object.keys(exportRow(k, {})) });
  KINDS.forEach((k) => {
    $(`${k.key}_tbl`).onclick = (e) => run(async () => {
      const b = e.target.closest("[data-ed],[data-dl]"); if (!b) return;
      const r = S.recs[k.key].find((x) => x.id === (b.dataset.ed || b.dataset.dl)); if (!r) return;
      if (b.dataset.ed) return startEdit(k, r);
      if (!confirm(`Delete this ${k.label.toLowerCase()} of ${r.name} (${k.summary(r)})? This cannot be undone.`)) return;
      await deleteDoc(doc(db, k.coll, r.id)); await logEvent("Deleted record", `${r.name} (${r.studentNo})`, [], `${k.label}: ${k.summary(r)}`);
      if (edit[k.key] === r.id) resetForm(k);
      await refresh(); flash("Record deleted.", true);
    });
    $(`${k.key}_xlsx`).onclick = () => { const rows = listRows(k); if (!rows.length) return flash("There are no records to download with these filters."); saveXlsx([sheetOf(k, rows)], `${slugName(k.plural)}-${SID}.xlsx`); };
    $(`${k.key}_xall`).onclick = () => { if (!S.recs[k.key].length) return flash("There are no records to download yet."); saveXlsx([sheetOf(k, S.recs[k.key])], `${slugName(k.plural)}-all-${SID}.xlsx`); };
    $(`${k.key}_clear`).onclick = () => { [`${k.key}_lq`, `${k.key}_from`, `${k.key}_to`, `${k.key}_grade`, `${k.key}_year`, ...(k.filters || []).map((f) => `${k.key}_fl_${f.field}`)].forEach((id) => ($(id).value = "")); renderList(k); };
  });

  /* ---------- student file ---------- */
  let sfRec = null;
  function renderFile() {
    const r = fillPicker("sf_"); sfRec = r;
    $("sfBtns").innerHTML = r ? KINDS.map((k) => `<button class="btn" type="button" data-add="${k.key}">Add ${esc(k.label.toLowerCase())}</button>`).join("") + `<button class="btn primary" type="button" data-xl="1">Download this student's file (Excel)</button>` : "";
    const rows = r ? KINDS.flatMap((k) => S.recs[k.key].filter((x) => x.registryId === r.id).map((x) => ({ k, x }))).sort((a, b) => byNewest(a.x, b.x)) : [];
    $("sfTbl").innerHTML = hdr(["Date", "Kind", "Record", "Recorded by", ""]) + (rows.map(({ k, x }) => `<tr><td>${esc(dateText(x.date))}</td><td>${esc(k.label)}</td><td class="wrapcell">${esc(k.summary(x))}</td><td>${esc(x.createdByName || "-")}</td><td class="actions"><button class="btn small" data-fed="${esc(k.key)}|${esc(x.id)}">Edit</button></td></tr>`).join("") ||
      emptyRow(5, r ? "Nothing has been recorded for this student yet." : "Find and choose a student."));
  }
  $("sf_q").oninput = renderFile; $("sf_stu").onchange = renderFile;
  $("sfBtns").onclick = (e) => {
    const a = e.target.closest("[data-add]"), x = e.target.closest("[data-xl]"); if (!sfRec) return;
    if (a) { const k = KMAP[a.dataset.add]; resetForm(k); $(`${k.key}_q`).value = sfRec.studentNo; fillPicker(k.key + "_", sfRec.id); show("add", "add_" + k.key); scrollTo({ top: 0 }); }
    else if (x) { const sheets = KINDS.map((k) => sheetOf(k, S.recs[k.key].filter((r) => r.registryId === sfRec.id))).filter((s) => s.rows.length); if (!sheets.length) return flash("Nothing has been recorded for this student yet."); saveXlsx(sheets, `student-file-${slugName(sfRec.studentNo)}.xlsx`); }
  };
  $("sfTbl").onclick = (e) => { const b = e.target.closest("[data-fed]"); if (!b) return; const [kk, id] = b.dataset.fed.split("|"), k = KMAP[kk], r = S.recs[kk].find((x) => x.id === id); if (k && r) startEdit(k, r); };

  /* ---------- monitoring matrix (who has received which item) ---------- */
  function mxBase() {
    const m = cfg.matrix, q = $("mxQ").value.trim().toLowerCase(), g = $("mxGrade").value, y = $("mxYear").value, miss = $("mxMiss").value, k = KMAP[m.kind];
    const latest = new Map();           // registry id | item -> newest record
    S.recs[m.kind].forEach((r) => { const key = r.registryId + "|" + r[m.field]; const cur = latest.get(key); if (!cur || byNewest(r, cur) < 0) latest.set(key, r); });
    const items = S.lists[m.list];
    const rows = S.registry.filter((r) => (!g || gradeOf(r) !== "" && gradeOf(r) === g) && (!y || r.schoolYear === y) && (!q || [r.studentNo, r.lrn, r.name].join(" ").toLowerCase().includes(q))).map((r) => ({ r, cells: items.map((it) => latest.get(r.id + "|" + it) || null) }));
    return { m, k, items, rows: rows.filter((x) => !miss || !(x.cells[items.indexOf(miss)] && m.ok.includes(x.cells[items.indexOf(miss)][m.statusField]))) };
  }
  function mxCell(m, rec) {
    if (!rec) return '<td class="no">-</td>';
    const st = rec[m.statusField], cls = m.ok.includes(st) ? "ok" : (m.bad || []).includes(st) ? "bad" : "";
    return `<td class="${cls}" title="${esc(dateText(rec.date))}">${esc(st)}${rec.size ? `<small>${esc(rec.size)}</small>` : ""}</td>`;
  }
  function renderMatrix() {
    if (!cfg.matrix || !secs("matrix")) return;
    keep("mxGrade", options(GRADES, "All grade levels")); keep("mxYear", options(yearsList(), "All school years")); keep("mxMiss", options(S.lists[cfg.matrix.list], "(no filter)"));
    const { m, items, rows } = mxBase();
    $("mxCount").textContent = `${rows.length} of ${S.registry.length} registered students`;
    $("mxTbl").innerHTML = hdr(["Student ID No.", "Name", "Grade", ...items.map(esc), "Items received"]) + (rows.slice(0, 3000).map(({ r, cells }) => `<tr><td>${esc(r.studentNo)}</td><td>${esc(r.name)}</td><td>${esc(gradeOf(r))}</td>${cells.map((c) => mxCell(m, c)).join("")}<td><b>${cells.filter((c) => c && m.ok.includes(c[m.statusField])).length}</b> of ${items.length}</td></tr>`).join("") || emptyRow(4 + items.length, "No students found."));
  }
  if (cfg.matrix && secs("matrix")) {
    ["mxQ", "mxGrade", "mxYear", "mxMiss"].forEach((i) => ($(i).oninput = renderMatrix));
    $("mxClear").onclick = () => { ["mxQ", "mxGrade", "mxYear", "mxMiss"].forEach((i) => ($(i).value = "")); renderMatrix(); };
    $("mxXlsx").onclick = () => {
      const { m, items, rows } = mxBase(); if (!rows.length) return flash("There are no students to download with these filters.");
      const data = rows.map(({ r, cells }) => ({ "Student ID No.": r.studentNo, Name: r.name, "Grade Level": gradeOf(r), ...Object.fromEntries(items.map((it, i) => [it, cells[i] ? `${cells[i][m.statusField]}${cells[i].date ? " (" + cells[i].date + ")" : ""}` : "Not yet"])), "Items Received": `${cells.filter((c) => c && m.ok.includes(c[m.statusField])).length} of ${items.length}` }));
      saveXlsx([{ name: "Monitoring", rows: data, header: ["Student ID No.", "Name", "Grade Level", ...items, "Items Received"] }], `${slugName(m.title)}-${SID}.xlsx`);
    };
  }

  /* ---------- dashboard ---------- */
  const helpers = { esc, pc, bar, hdr, rowHtml, emptyRow, dateText, localDate, gradeOf, sectionOf, GRADES, badge: (cls, t) => `<span class="badge ${cls}">${esc(t)}</span>` };
  function renderDash() {
    keep("dsYear", options(yearsList(), "All school years"));
    const y = $("dsYear").value, recs = {}; KINDS.forEach((k) => (recs[k.key] = S.recs[k.key].filter((r) => !y || r.schoolYear === y)));
    const d = cfg.dashboard({ S, y, recs, students: S.registry, today: localDate(), h: helpers, kinds: KMAP });
    $("dsCards").innerHTML = d.cards.map(([l, v, c]) => `<div class="stat ${c || ""}"><b>${v}</b><span>${esc(l)}</span></div>`).join("");
    $("dsPanels").innerHTML = d.panels.map((p) => `<div class="panel"><h2>${esc(p.title)}</h2>${p.note ? `<p class="muted fine">${esc(p.note)}</p>` : ""}<div class="tablewrap"><table>${p.html}</table></div></div>`).join("");
  }
  $("dsYear").onchange = renderDash;

  /* ---------- history ---------- */
  const atsec = (l) => l?.at?.seconds || 0;
  const whenOf = (l) => (atsec(l) ? new Date(atsec(l) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "just now");
  async function loadHistory() {
    $("hiNote").hidden = true;
    try { S.log = (await bySchool(cfg.logColl)).sort((a, b) => atsec(b) - atsec(a)); S.logLoaded = true; }
    catch (e) { console.error(e); $("hiNote").textContent = "The history could not be loaded. Press Refresh. " + friendlyError(e); $("hiNote").hidden = false; }
    keep("hiAct", options(["Added record", "Edited record", "Deleted record", "Changed settings"], "All actions")); renderHistory();
  }
  const historyRows = () => { const q = $("hiQ").value.trim().toLowerCase(), a = $("hiAct").value; return S.log.filter((l) => (!a || l.action === a) && (!q || [l.byName, l.action, l.label, l.note, ...(l.changes || []).map((c) => `${c.f} ${c.from} ${c.to}`)].join(" ").toLowerCase().includes(q))); };
  function renderHistory() {
    const rows = historyRows(), shown = rows.slice(0, 300);
    $("hiCount").textContent = `${rows.length} of ${S.log.length} entr${S.log.length === 1 ? "y" : "ies"}` + (rows.length > shown.length ? " - showing the latest 300; download the Excel file for all" : "");
    const detail = (l) => (l.changes || []).map((c) => `<div><b>${esc(c.f)}:</b> <span class="old">${esc(c.from || "(blank)")}</span> &rarr; <span class="new">${esc(c.to || "(blank)")}</span></div>`).join("") + (l.note ? `<div>${esc(l.note)}</div>` : "");
    $("hiTbl").innerHTML = hdr(["When", "Done by", "Action", "Record", "What changed"]) + (shown.map((l) => `<tr><td>${esc(whenOf(l))}</td><td>${esc(l.byName || "-")}</td><td><span class="badge act ${/Deleted/.test(l.action) ? "del" : ""}">${esc(l.action)}</span></td><td>${esc(l.label || "-")}</td><td class="wrapcell hist-detail">${detail(l) || "-"}</td></tr>`).join("") || emptyRow(5, S.log.length ? "No entries match the filters." : "Nothing recorded yet."));
  }
  ["hiQ", "hiAct"].forEach((i) => ($(i).oninput = renderHistory));
  $("hiRefresh").onclick = () => run(loadHistory);
  $("hiXlsx").onclick = () => {
    const rows = historyRows().flatMap((l) => { const base = { When: whenOf(l), "Done by": l.byName || "", Action: l.action, Record: l.label || "" }; const ch = l.changes || []; return ch.length ? ch.map((c) => ({ ...base, Field: c.f, From: c.from, To: c.to, Note: l.note || "" })) : [{ ...base, Field: "", From: "", To: "", Note: l.note || "" }]; });
    if (!rows.length) return flash("There are no history entries to download."); saveXlsx([{ name: "History", rows, header: ["When", "Done by", "Action", "Record", "Field", "From", "To", "Note"] }], `history-${cfg.role}-${SID}.xlsx`);
  };

  /* ---------- settings: lists + additional information ---------- */
  function renderLists() {
    (cfg.lists || []).forEach((l) => { $("ls_" + l.key).innerHTML = S.lists[l.key].map((v) => `<span class="tag">${esc(v)}<button type="button" data-lrm="${esc(l.key)}|${esc(v)}" aria-label="Remove ${esc(v)}">&times;</button></span>`).join("") || '<span class="muted">None yet.</span>'; });
  }
  secs("settings").addEventListener("click", (e) => run(async () => {
    const add = e.target.closest("[data-ladd]"), rm = e.target.closest("[data-lrm]");
    if (add) {
      const l = cfg.lists.find((x) => x.key === add.dataset.ladd), inp = $("lsn_" + l.key), v = inp.value.trim();
      if (!v) return flash(`Type the ${l.one}.`); if (S.lists[l.key].some((x) => x.toLowerCase() === v.toLowerCase())) return flash("That is already on the list.");
      S.lists[l.key].push(v); inp.value = ""; await saveSettings(); await logEvent("Changed settings", l.title, [{ f: l.one, from: "", to: v }], "Added"); renderAll(); return flash("Added.", true);
    }
    if (rm) {
      const [key, v] = rm.dataset.lrm.split("|"), l = cfg.lists.find((x) => x.key === key);
      if (S.lists[key].length <= 1) return flash("Keep at least one choice on the list.");
      if (!confirm(`Remove "${v}" from the list? Records already saved with it keep it.`)) return;
      S.lists[key] = S.lists[key].filter((x) => x !== v); await saveSettings(); await logEvent("Changed settings", l.title, [{ f: l.one, from: v, to: "" }], "Removed"); renderAll();
    }
  }));
  function renderFieldSettings() {
    if ($("fieldsBox").contains(document.activeElement) && document.activeElement.matches("input")) return;   // do not disturb typing
    $("fieldsBox").innerHTML = KINDS.map((k) => `<div class="fgroup" data-g="${k.key}"><h3>${esc(k.label)}</h3>
      <div class="chiplist">${S.fields[k.key].map((f) => `<span class="tag">${esc(f.label)} <small style="display:inline;margin:0">(${FTYPES[f.type]}${f.type === "select" ? ": " + esc((f.options || []).join(", ")) : ""})</small><button type="button" data-frm="${k.key}|${esc(f.id)}" aria-label="Remove ${esc(f.label)}">&times;</button></span>`).join("") || '<span class="muted">No additional fields yet.</span>'}</div>
      <div class="row"><label>Field title<input data-fl maxlength="40" placeholder="e.g. Locker No." autocomplete="off"></label><label>Type<select data-ft>${Object.entries(FTYPES).map(([a, b]) => `<option value="${a}">${b}</option>`).join("")}</select></label>
      <label data-fo hidden>Choices <small>Separate with commas</small><input data-fopt maxlength="300" autocomplete="off"></label><button class="btn primary" type="button" data-fadd="${k.key}">Add field</button></div></div>`).join("");
  }
  $("fieldsBox").onchange = (e) => { const t = e.target.closest("[data-ft]"); if (t) t.closest(".fgroup").querySelector("[data-fo]").hidden = t.value !== "select"; };
  $("fieldsBox").onclick = (e) => run(async () => {
    const add = e.target.closest("[data-fadd]"), rm = e.target.closest("[data-frm]");
    if (add) {
      const box = add.closest(".fgroup"), kk = add.dataset.fadd, label = box.querySelector("[data-fl]").value.trim(), type = box.querySelector("[data-ft]").value;
      const opts = box.querySelector("[data-fopt]").value.split(",").map((x) => x.trim()).filter(Boolean);
      if (!label) return flash("Enter the field title."); if (type === "select" && opts.length < 2) return flash("Enter at least two choices, separated by commas.");
      const taken = [...KMAP[kk].fields, ...S.fields[kk]].some((f) => f.label.toLowerCase() === label.toLowerCase()); if (taken) return flash("A field with that title already exists.");
      S.fields[kk].push({ id: "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), label, type, ...(type === "select" ? { options: opts } : {}) });
      await saveSettings(); await logEvent("Changed settings", "Additional information - " + KMAP[kk].label, [{ f: "Field", from: "", to: `${label} (${FTYPES[type]})` }], "Field added"); renderAll(); return flash(`Added "${label}".`, true);
    }
    if (rm) {
      const [kk, id] = rm.dataset.frm.split("|"), f = S.fields[kk].find((x) => x.id === id); if (!f) return;
      if (!confirm(`Remove the field "${f.label}"? Values already saved stay in the records but are no longer shown.`)) return;
      S.fields[kk] = S.fields[kk].filter((x) => x.id !== id); await saveSettings(); await logEvent("Changed settings", "Additional information - " + KMAP[kk].label, [{ f: "Field", from: f.label, to: "" }], "Field removed"); renderAll();
    }
  });

  /* ---------- draw everything ---------- */
  function renderAll() {
    renderLists();
    KINDS.forEach((k) => {
      drawForm(k); fillPicker(k.key + "_");
      keep(`${k.key}_grade`, options(GRADES, "All grade levels")); keep(`${k.key}_year`, options(yearsList(), "All school years"));
      (k.filters || []).forEach((f) => keep(`${k.key}_fl_${f.field}`, options(f.list ? S.lists[f.list] || [] : (k.fields.find((x) => x.id === f.field) || {}).options || [], "All")));
      renderList(k);
    });
    renderFile(); renderMatrix(); renderDash(); renderFieldSettings();
    if (S.logLoaded) renderHistory();
  }
  KINDS.forEach((k) => {
    [`${k.key}_lq`, `${k.key}_from`, `${k.key}_to`, `${k.key}_grade`, `${k.key}_year`, ...(k.filters || []).map((f) => `${k.key}_fl_${f.field}`)].forEach((id) => ($(id).oninput = () => renderList(k)));
  });

  KINDS.forEach((k) => resetForm(k));
  show("dash");
  await refresh();
  liveRefresh(["registry", "enrollmentRecords", cfg.settingsColl, ...(cfg.kinds || []).map((k) => k.coll).filter(Boolean)], refresh);
}
