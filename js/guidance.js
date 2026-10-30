/* Guidance: the health records and the guidance (counseling) records of the students. */
import { startRecordsApp } from "./records-app.js";

const HB = { "No concern": "st-enrolled", "Needs monitoring": "st-pending", "Referred to a doctor": "st-ref", Resolved: "st-done" };
const GB = { Open: "st-open", Ongoing: "st-going", Referred: "st-ref", Resolved: "st-done" };
const bmi = (r) => { const h = Number(r.height), w = Number(r.weight); return h > 0 && w > 0 ? String(Math.round((w / ((h / 100) ** 2)) * 10) / 10) : ""; };

await startRecordsApp({
  role: "guidance", title: "Guidance", settingsColl: "guidanceSettings", logColl: "guidanceLog",
  dashNote: "Health and guidance records of the students. These are confidential: only the Guidance account can open them.",
  lists: [
    { key: "healthTypes", title: "Kinds of health record", one: "kind of health record", defaults: ["Annual physical exam", "Dental check-up", "Vision / hearing screening", "Clinic visit", "Immunization", "Illness / injury report", "Nutrition assessment", "Other"] },
    { key: "caseTypes", title: "Kinds of guidance record", one: "kind of guidance record", defaults: ["Counseling", "Behavior / discipline", "Academic concern", "Attendance concern", "Family / home concern", "Peer / bullying concern", "Career guidance", "Referral", "Home visit", "Other"] },
  ],
  kinds: [
    { key: "health", coll: "healthRecords", label: "Health record", plural: "Health records", addTab: "Health record", addTitle: "Add a health record",
      addNote: "Height and weight give the BMI automatically. Leave blank anything that does not apply.",
      fields: [
        { id: "date", label: "Date", type: "date", req: true, today: true }, { id: "type", label: "Kind of record", type: "list", list: "healthTypes", req: true },
        { id: "healthStatus", label: "Health status", type: "select", options: ["No concern", "Needs monitoring", "Referred to a doctor", "Resolved"], badges: HB },
        { id: "height", label: "Height (cm)", type: "number" }, { id: "weight", label: "Weight (kg)", type: "number" },
        { id: "vision", label: "Vision", type: "text", hint: "e.g. 20/20, wears glasses" }, { id: "hearing", label: "Hearing", type: "text" },
        { id: "allergies", label: "Allergies", type: "text" }, { id: "conditions", label: "Medical conditions", type: "text", hint: "e.g. asthma" },
        { id: "medications", label: "Medicines taken", type: "text" }, { id: "immunization", label: "Immunization / vaccines", type: "text" },
        { id: "findings", label: "Findings / complaint", type: "textarea" }, { id: "treatment", label: "Treatment / action taken", type: "textarea" },
        { id: "followUp", label: "Follow-up date", type: "date" },
      ],
      listCols: ["type", "healthStatus", "height", "weight", "allergies", "conditions", "findings", "followUp"], derived: [{ label: "BMI", fn: bmi }],
      filters: [{ field: "type", label: "Kind of record", list: "healthTypes" }, { field: "healthStatus", label: "Health status" }],
      summary: (r) => `${r.type || ""}${r.healthStatus ? " - " + r.healthStatus : ""}${r.conditions ? " (" + r.conditions + ")" : ""}${r.findings ? ": " + String(r.findings).slice(0, 80) : ""}` },
    { key: "guidance", coll: "guidanceRecords", label: "Guidance record", plural: "Guidance records", addTab: "Guidance record", addTitle: "Add a guidance record",
      addNote: "Counseling sessions, behavior or academic concerns, referrals, home visits and so on.",
      fields: [
        { id: "date", label: "Date", type: "date", req: true, today: true }, { id: "category", label: "Kind of record", type: "list", list: "caseTypes", req: true },
        { id: "status", label: "Status", type: "select", options: ["Open", "Ongoing", "Referred", "Resolved"], req: true, def: "Open", badges: GB },
        { id: "concern", label: "Concern / reason", type: "textarea", req: true }, { id: "action", label: "Action taken / intervention", type: "textarea" },
        { id: "referredTo", label: "Referred to", type: "text" }, { id: "parentNotified", label: "Parent / guardian informed", type: "yesno" },
        { id: "followUp", label: "Follow-up date", type: "date" }, { id: "remarks", label: "Remarks", type: "textarea" },
      ],
      listCols: ["category", "status", "concern", "action", "referredTo", "parentNotified", "followUp"],
      filters: [{ field: "category", label: "Kind of record", list: "caseTypes" }, { field: "status", label: "Status" }],
      summary: (r) => `${r.category || ""}${r.status ? " - " + r.status : ""}${r.concern ? ": " + String(r.concern).slice(0, 80) : ""}` },
  ],
  dashboard: ({ S, recs, students, today, h }) => {
    const hr = recs.health, gr = recs.guidance, total = students.length;
    const openCases = gr.filter((r) => r.status === "Open" || r.status === "Ongoing");
    const hNeed = hr.filter((r) => r.healthStatus === "Needs monitoring" || r.healthStatus === "Referred to a doctor");
    const due = [...hr.filter((r) => r.followUp && r.followUp <= today && r.healthStatus !== "No concern" && r.healthStatus !== "Resolved").map((r) => ({ r, kind: "Health" })),
      ...gr.filter((r) => r.followUp && r.followUp <= today && r.status !== "Resolved").map((r) => ({ r, kind: "Guidance" }))].sort((a, b) => a.r.followUp.localeCompare(b.r.followUp));
    const withCond = new Set(hr.filter((r) => r.allergies || r.conditions).map((r) => r.registryId));
    const caseRows = S.lists.caseTypes.map((v) => { const a = gr.filter((r) => r.category === v); return [v, a.length, a.filter((r) => r.status === "Open" || r.status === "Ongoing").length]; }).filter((x) => x[1]);
    const healthRows = S.lists.healthTypes.map((v) => [v, hr.filter((r) => r.type === v).length]).filter((x) => x[1]);
    const stRows = ["Open", "Ongoing", "Referred", "Resolved"].map((v) => [v, gr.filter((r) => r.status === v).length]);
    const recent = [...hr.map((r) => ({ r, kind: "Health", t: r.type, st: r.healthStatus, b: HB })), ...gr.map((r) => ({ r, kind: "Guidance", t: r.category, st: r.status, b: GB }))].sort((a, b) => String(b.r.date).localeCompare(String(a.r.date))).slice(0, 10);
    return { cards: [["Registered students", total], ["Health records", hr.length, "blue"], ["Guidance records", gr.length, "blue"], ["Open / ongoing cases", openCases.length, "warn"], ["Health records needing follow-up", hNeed.length, "warn"], ["Follow-ups due", due.length, "warn"], ["Students with allergies / conditions", withCond.size]],
      panels: [
        { title: "Guidance records by kind", html: h.hdr(["Kind", "Records", "Open / ongoing"]) + (caseRows.map((x) => h.rowHtml([h.esc(x[0]), x[1], x[2]])).join("") || h.emptyRow(3, "No guidance records yet.")) },
        { title: "Guidance records by status", html: h.hdr(["Status", "Records"]) + stRows.map((x) => h.rowHtml([h.badge(GB[x[0]], x[0]), x[1]])).join("") },
        { title: "Health records by kind", html: h.hdr(["Kind", "Records"]) + (healthRows.map((x) => h.rowHtml([h.esc(x[0]), x[1]])).join("") || h.emptyRow(2, "No health records yet.")) },
        { title: "Follow-ups due", note: "Records whose follow-up date is today or earlier and are not resolved.", html: h.hdr(["Follow-up", "Student", "Kind", "Record"]) + (due.slice(0, 15).map(({ r, kind }) => h.rowHtml([h.esc(h.dateText(r.followUp)), h.esc(r.name), kind, h.esc(r.type || r.category || "")])).join("") || h.emptyRow(4, "Nothing is due.")) },
        { title: "Latest records", html: h.hdr(["Date", "Student", "Kind", "Record", "Status"]) + (recent.map(({ r, kind, t, st, b }) => h.rowHtml([h.esc(h.dateText(r.date)), h.esc(r.name), kind, h.esc(t || ""), st && b[st] ? h.badge(b[st], st) : h.esc(st || "-")])).join("") || h.emptyRow(5, "No records yet.")) },
      ] };
  },
});
