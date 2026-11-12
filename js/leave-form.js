/* HR: the printable "Application for Leave" form, filled in automatically from the leave request, the employee's HR record
   and the leave balance of the year. Opens in a clean window and starts the print dialog (Save as PDF works too).
   One request = one page; several requests = one page each. */
import { esc } from "./auth.js";

const dt = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || "") ? new Date(s + "T00:00").toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" }) : s || "");
const r1 = (n) => Math.round(n * 10) / 10;
const box = (on) => `<span class="box">${on ? "&#10003;" : ""}</span>`;
const fileDate = (r) => (r.createdAt && r.createdAt.toDate ? r.createdAt.toDate().toISOString().slice(0, 10) : r.filedOn || "");

/** One form as HTML.
 *  ctx: { req, emp (HR record or null), school, types: [{name, days}], used(type, year, exceptId) -> days already approved, hrName, roleName } */
export function leaveFormHtml(ctx) {
  const { req: r, emp, school, types, used, hrName } = ctx, year = String(r.startDate || "").slice(0, 4);
  const name = emp ? `${emp.lastName || ""}, ${emp.firstName || ""}${emp.middleInitial ? " " + emp.middleInitial + "." : ""}` : r.requesterName || "";
  const parts = emp ? [emp.lastName, emp.firstName, emp.middleInitial] : String(r.requesterName || "").split(",").map((x) => x.trim());
  const position = (emp && emp.position) || (ctx.roleName ? ctx.roleName(r.requesterRole) : "") || "";
  const dept = (emp && emp.department) || "";
  const no = r.employeeId || (emp && emp.employeeId) || "";
  const listed = types.map((t) => t.name), inList = listed.includes(r.leaveType), noPay = /without pay|no pay/i.test(r.leaveType || "");
  const status = r.status || "Pending", approved = status === "Approved", rejected = status === "Rejected";
  const logo = school && school.logo ? `<img src="${esc(school.logo)}" alt="">` : "";
  const schoolName = (school && (school.displayName || school.name)) || "";
  const limited = types.filter((t) => +t.days > 0);
  const bal = limited.map((t) => {
    const u = used(t.name, year, r.id), thisApp = t.name === r.leaveType ? +r.days || 0 : 0, left = +t.days - u - thisApp, hit = t.name === r.leaveType;
    return `<tr${hit ? ' style="background:#f3f3f3;font-weight:700"' : ""}><td>${esc(t.name)}</td><td style="text-align:center">${t.days}</td><td style="text-align:center">${r1(u)}</td><td style="text-align:center">${thisApp ? r1(thisApp) : "-"}</td><td style="text-align:center">${r1(left)}</td></tr>`;
  }).join("");
  const stamp = approved ? `<span class="stamp">APPROVED</span>` : rejected ? `<span class="stamp rej">DISAPPROVED</span>` : status === "Cancelled" ? `<span class="stamp rej">CANCELLED</span>` : `<span class="stamp pen">FOR HR ACTION</span>`;
  const days = +r.days || 0;
  return `<div class="lf">
  <div class="head">${logo}<div><p><b style="font-size:14px">${esc(schoolName)}</b></p><p>Human Resource Office</p></div><div style="margin-left:auto">${stamp}</div></div>
  <h1>APPLICATION FOR LEAVE</h1><h2>Form no. ${esc(String(r.id || "").slice(0, 8).toUpperCase() || "-")}</h2>
  <table>
    <tr><td style="width:34%"><small>1. OFFICE / DEPARTMENT</small>${esc(dept) || "&nbsp;"}</td><td colspan="2"><small>2. NAME &nbsp; (Last) &nbsp;&nbsp; (First) &nbsp;&nbsp; (Middle)</small><b>${esc(parts[0] || "")}</b> &nbsp; <b>${esc(parts[1] || "")}</b> &nbsp; <b>${esc(parts[2] ? parts[2] : "")}</b></td></tr>
    <tr><td><small>3. DATE OF FILING</small>${esc(dt(fileDate(r))) || "&nbsp;"}</td><td style="width:33%"><small>4. POSITION</small>${esc(position) || "&nbsp;"}</td><td><small>5. EMPLOYEE NO.</small>${esc(no) || "&nbsp;"}</td></tr>
    <tr><td colspan="3" class="sec">6. DETAILS OF APPLICATION</td></tr>
    <tr><td colspan="2" style="width:50%"><small>6.A TYPE OF LEAVE TO BE AVAILED OF</small><div class="types">${listed.map((t) => `<div>${box(t === r.leaveType)}${esc(t)}</div>`).join("")}<div>${box(!inList)}Others: ${inList ? "______________" : esc(r.leaveType)}</div></div></td>
      <td><small>6.B DETAILS OF LEAVE</small><div>Reason: <b>${esc(r.reason || "")}</b>${r.reason ? "" : "________________________"}</div></td></tr>
    <tr><td colspan="2"><small>6.C NUMBER OF WORKING DAYS APPLIED FOR</small><b style="font-size:13px">${days} day${days === 1 ? "" : "s"}</b></td><td><small>INCLUSIVE DATES</small><b>${esc(r.startDate === r.endDate ? dt(r.startDate) : dt(r.startDate) + " to " + dt(r.endDate))}</b></td></tr>
    <tr><td colspan="3"><small>6.D EMPLOYEE'S SIGNATURE</small><div class="sig"></div><div class="line">${esc(name)}</div></td></tr>
    <tr><td colspan="3" class="sec">7. DETAILS OF ACTION ON APPLICATION</td></tr>
    <tr><td colspan="2"><small>7.A CERTIFICATION OF LEAVE CREDITS (as of ${esc(dt(new Date().toISOString().slice(0, 10)))}, year ${esc(year)})</small>
      ${bal ? `<table style="margin-top:3px"><tr><th>Leave type</th><th>Credits (days a year)</th><th>Used (approved)</th><th>This application</th><th>Balance</th></tr>${bal}</table>` : "<i>No yearly credits are set for the leave types.</i>"}
      <div class="sig"></div><div class="line">${esc(hrName || "HR Officer")}<br><small style="font-weight:400">HR Officer</small></div></td>
      <td><small>7.B RECOMMENDATION</small><div>${box(false)}For approval</div><div>${box(false)}For disapproval due to _________________</div><div class="sig"></div><div class="line">Immediate Supervisor</div></td></tr>
    <tr><td colspan="2"><small>7.C APPROVED FOR</small><div>${box(approved && !noPay)}<b>${approved && !noPay ? days : "____"}</b> days with pay</div><div>${box(approved && noPay)}<b>${approved && noPay ? days : "____"}</b> days without pay</div><div>${box(false)}others (specify) __________</div></td>
      <td><small>7.D DISAPPROVED DUE TO</small><div>${rejected ? "<b>" + esc(r.hrRemarks || "") + "</b>" : "____________________________"}</div>${approved && r.hrRemarks ? `<small>Remarks: ${esc(r.hrRemarks)}</small>` : ""}</td></tr>
    <tr><td colspan="3"><div class="sig"></div><div class="line">${esc(school && school.principal ? school.principal : "School Head / Principal")}<br><small style="font-weight:400">Authorized official</small></div>
      ${r.decidedByName ? `<small>Decision recorded in the portal by ${esc(r.decidedByName)}${r.decidedAt && r.decidedAt.toDate ? " on " + esc(r.decidedAt.toDate().toLocaleDateString()) : ""}.</small>` : ""}</td></tr>
  </table><p style="font-size:9.5px;color:#444;margin-top:4px">Printed from the ARK Portal on ${esc(new Date().toLocaleString())}.</p></div>`;
}

/** Opens the print window for one or more requests.
 *  Every request is printed on ONE landscape A4 page, TWO copies side by side: the left half is the HR copy, the right half is the employee's copy. */
export function printLeaveForms(ctxs, win) {
  const w = win || window.open("", "_blank");
  if (!w) { alert("Your browser blocked the print window. Allow pop-ups for this site and try again."); return; }
  const base = new URL("css/style.css", location.href).href, css = new URL("css/schedule.css", location.href).href;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Application for Leave</title><link rel="stylesheet" href="${base}"><link rel="stylesheet" href="${css}">
    <style>@page{size:A4 landscape;margin:6mm}body{background:#fff;margin:0}.pg{display:flex;gap:0;page-break-after:always;height:196mm;overflow:hidden}.pg:last-child{page-break-after:auto}
    .half{flex:1 1 50%;width:50%;padding:0 4mm;box-sizing:border-box;position:relative}.half+.half{border-left:1.5px dashed #777}
    .tag{position:absolute;top:-1mm;right:4mm;font-size:8px;font-weight:700;letter-spacing:.08em;color:#555;text-transform:uppercase}
    .lf{font-size:9px;max-width:none}.lf h1{font-size:12px}.lf h2{font-size:10px;margin-bottom:.3rem}.lf td,.lf th{padding:2px 4px}.lf small{font-size:7.5px}.lf .head img{width:44px;height:44px}.lf .sig{height:30px}
    .lf .box,.lf th,.lf .stamp{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style></head>
    <body>${ctxs.map((c) => `<div class="pg"><div class="half"><span class="tag">HR copy</span>${leaveFormHtml(c)}</div><div class="half"><span class="tag">Employee copy</span>${leaveFormHtml(c)}</div></div>`).join("")}
    <script>addEventListener("load",function(){setTimeout(function(){focus();print()},300)})<\/script></body></html>`);
  w.document.close();
}
