/* Shared by the Registrar (schedule maker), the Teacher page and the Student page.
   Pure helpers: time maths, the weekly grid, a print window and an Excel export. Nothing here talks to the server. */
import { esc } from "./auth.js";

export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const SHORT = { Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu", Friday: "Fri", Saturday: "Sat", Sunday: "Sun" };
const PPM = 0.8;                                  // pixels per minute in the weekly grid (1 hour = 48 px)

export const toMin = (t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
export const toHm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const ampm = (t) => { const m = toMin(t), h = Math.floor(m / 60), mm = m % 60; return `${h % 12 || 12}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
export const hours = (a, b) => Math.max(0, (toMin(b) - toMin(a)) / 60);
const hue = (s) => { let h = 7; for (const c of String(s || "")) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
export const teacherKey = (e) => (e.teacherUid ? "u:" + e.teacherUid : e.teacherName ? "n:" + String(e.teacherName).trim().toUpperCase() : "");
export const up = (s) => String(s || "").trim().toUpperCase();
export const byTime = (a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || toMin(a.start) - toMin(b.start);

/** Breaks that apply to what is on screen: all-school breaks, plus those scoped to the section / teacher / room being shown. */
export function breaksFor(breaks, mode, value) {
  return (breaks || []).filter((b) => b.scope === "all" || !b.scope || (b.scope === mode && up(b.scopeValue) === up(value)));
}

/** Places overlapping blocks of one day side by side. */
function lanes(list) {
  const out = [], sorted = [...list].sort((a, b) => toMin(a.start) - toMin(b.start) || toMin(b.end) - toMin(a.end));
  let group = [], groupEnd = -1;
  const flush = () => { const n = Math.max(1, ...group.map((g) => g.lane + 1)); group.forEach((g) => (g.lanes = n)); out.push(...group); group = []; groupEnd = -1; };
  for (const e of sorted) {
    if (group.length && toMin(e.start) >= groupEnd) flush();
    const used = new Set(group.filter((g) => toMin(g.e.end) > toMin(e.start)).map((g) => g.lane));
    let lane = 0; while (used.has(lane)) lane++;
    group.push({ e, lane, lanes: 1 }); groupEnd = Math.max(groupEnd, toMin(e.end));
  }
  flush(); return out;
}

/** What is written inside a block, by what the grid is about (the thing that is already obvious from the title is left out). */
function lines(e, mode) {
  const sec = e.sectionName || "", t = e.teacherName || "", r = e.room || "";
  if (mode === "teacher") return [sec, r];
  if (mode === "room") return [sec, t];
  if (mode === "student") return [t, r];
  return [t, r];                                   // section
}

/** The weekly grid as HTML. entries: schedule entries; breaks: already filtered; opts.drag adds drag handles and edit buttons for the Registrar. */
export function gridHtml(entries, breaks = [], { mode = "section", drag = false, days = DAYS } = {}) {
  const starts = [...entries, ...breaks].map((x) => toMin(x.start)), ends = [...entries, ...breaks].map((x) => toMin(x.end));
  const min = Math.floor(Math.min(7 * 60, ...starts) / 60) * 60, max = Math.ceil(Math.max(17 * 60, ...ends) / 60) * 60, H = (max - min) * PPM;
  const hrs = []; for (let m = min; m < max; m += 60) hrs.push(m);
  const col = (d) => {
    const es = entries.filter((e) => e.day === d), bs = breaks.filter((b) => !b.days || b.days === "all" || b.days === d);
    const brk = bs.map((b) => `<div class="sc-brk" style="top:${(toMin(b.start) - min) * PPM}px;height:${Math.max(14, (toMin(b.end) - toMin(b.start)) * PPM)}px" title="${esc(b.label)} ${ampm(b.start)} - ${ampm(b.end)}"><b>${esc(b.label)}</b></div>`).join("");
    const blk = lanes(es).map(({ e, lane, lanes: n }) => {
      const [l1, l2] = lines(e, mode), top = (toMin(e.start) - min) * PPM, h = Math.max(20, (toMin(e.end) - toMin(e.start)) * PPM - 1);
      return `<div class="sc-blk${drag ? " mv" : ""}" ${drag ? `draggable="true" data-id="${esc(e.id)}"` : ""} style="top:${top}px;height:${h}px;left:calc(${(lane / n) * 100}% + 1px);width:calc(${100 / n}% - 2px);--hue:${hue(e.subject)}"
        title="${esc(e.subject)} | ${ampm(e.start)} - ${ampm(e.end)}${e.sectionName ? " | " + esc(e.sectionName) : ""}${e.teacherName ? " | " + esc(e.teacherName) : ""}${e.room ? " | " + esc(e.room) : ""}">
        <b>${esc(e.subject)}</b><span>${ampm(e.start)} - ${ampm(e.end)}</span>${l1 ? `<span>${esc(l1)}</span>` : ""}${l2 ? `<span>${esc(l2)}</span>` : ""}</div>`;
    }).join("");
    return `<div class="sc-col" data-day="${d}" data-min="${min}" style="height:${H}px">${brk}${blk}</div>`;
  };
  return `<div class="sc-grid" style="--cols:${days.length};--hgt:${H}px">
    <div class="sc-corner"></div>${days.map((d) => `<div class="sc-dh">${SHORT[d] || d}</div>`).join("")}
    <div class="sc-times" style="height:${H}px">${hrs.map((m) => `<i style="top:${(m - min) * PPM}px">${ampm(toHm(m))}</i>`).join("")}</div>${days.map(col).join("")}</div>`;
}

/** A plain list (also good on a phone): one row per class, in day and time order. */
export function listHtml(entries, mode = "section") {
  const rows = [...entries].sort(byTime).map((e) => `<tr><td>${esc(e.day)}</td><td>${ampm(e.start)} - ${ampm(e.end)}</td><td><b>${esc(e.subject)}</b></td>
    <td>${esc(mode === "teacher" ? e.sectionName : e.teacherName || "-")}</td><td>${esc(e.room || "-")}</td></tr>`).join("");
  return `<div class="tablewrap"><table><tr><th>Day</th><th>Time</th><th>Subject</th><th>${mode === "teacher" ? "Section" : "Teacher"}</th><th>Room</th></tr>${rows || `<tr><td colspan="5">No classes.</td></tr>`}</table></div>`;
}

/** Opens a clean page with the school name, logo and one or more schedules, and prints it. pages: [{ title, sub, html }] */
export function printPages(school, pages, docTitle = "Class schedule") {
  const w = window.open("", "_blank");
  if (!w) { alert("Your browser blocked the print window. Allow pop-ups for this site and try again."); return; }
  const css = new URL("css/schedule.css", location.href).href, base = new URL("css/style.css", location.href).href;
  const name = (school && (school.displayName || school.name)) || "", logo = school && school.logo ? `<img src="${esc(school.logo)}" alt="">` : "";
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(docTitle)}</title><link rel="stylesheet" href="${base}"><link rel="stylesheet" href="${css}">
    <style>@page{size:landscape;margin:8mm}body{background:#fff}.pp{page-break-after:always;padding:0}.pp:last-child{page-break-after:auto}.sc-print-head{display:flex;align-items:center;gap:.8rem;border-bottom:2px solid #b3121f;padding-bottom:.4rem;margin-bottom:.5rem}
    .sc-print-head img{height:56px;width:56px;object-fit:contain}.sc-print-head h1{margin:0;font-size:1.25rem}.sc-print-head p{margin:0;color:#444}.sc-sign{display:flex;justify-content:space-around;margin-top:1.6rem;font-size:.85rem}.sc-sign div{border-top:1px solid #000;padding-top:.2rem;min-width:200px;text-align:center}</style></head><body>
    ${pages.map((p) => `<section class="pp"><div class="sc-print-head">${logo}<div><h1>${esc(name)}</h1><p><b>${esc(p.title)}</b>${p.sub ? " &middot; " + esc(p.sub) : ""}</p></div></div>${p.html}
      <div class="sc-sign"><div>Prepared by (Registrar)</div><div>Noted by (Principal)</div></div></section>`).join("")}
    <script>addEventListener("load",function(){setTimeout(function(){focus();print()},300)})<\/script></body></html>`);
  w.document.close();
}

export function exportXlsx(entries, file, sheet = "Schedule") {
  if (!window.XLSX) return alert("The Excel writer did not load. Check your internet connection.");
  const rows = [...entries].sort(byTime).map((e) => ({ Semester: e.semesterName || "", "Grade level": e.gradeLevel || "", Section: e.sectionName || "", Day: e.day, Start: ampm(e.start), End: ampm(e.end), Subject: e.subject, Teacher: e.teacherName || "", Room: e.room || "", "Cluster / strand": e.cluster || "" }));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheet.slice(0, 31)); XLSX.writeFile(wb, file);
}
