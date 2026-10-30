/* Custodian: records the uniforms, P.E. uniforms, IDs and other items given to students. */
import { startRecordsApp } from "./records-app.js";

const BADGES = { Issued: "st-enrolled", Returned: "st-ref", Lost: "st-out", Damaged: "st-out", "To be issued": "st-pending" };

await startRecordsApp({
  role: "custodian", title: "Custodian", settingsColl: "custodianSettings", logColl: "custodianLog",
  dashNote: "Items given to students (uniform, P.E. uniform, ID and so on), from the records you save.",
  lists: [{ key: "itemTypes", title: "Items given to students", one: "item", help: "Uniform, P.E. uniform, ID and so on. Add or remove items as your school needs.",
    defaults: ["School Uniform", "P.E. Uniform", "School ID", "ID Lace / Holder", "Textbooks", "Workbooks / Modules", "Locker", "Locker Key", "Library Card", "Other"] }],
  kinds: [{
    key: "items", coll: "custodianRecords", label: "Item record", plural: "Items issued", addTab: "Give an item", addTitle: "Record an item given to a student",
    addNote: "Find the student, choose the item and what happened to it (issued, returned, lost ...). Use the Additional information fields in Settings for anything else you want to keep.",
    fields: [
      { id: "date", label: "Date", type: "date", req: true, today: true },
      { id: "item", label: "Item", type: "list", list: "itemTypes", req: true },
      { id: "status", label: "Status", type: "select", options: ["Issued", "Returned", "Lost", "Damaged", "To be issued"], req: true, def: "Issued", badges: BADGES },
      { id: "size", label: "Size / details", type: "text", hint: "e.g. Medium, Set of 2, ID No." },
      { id: "qty", label: "Quantity", type: "number", def: "1" },
      { id: "dateReturned", label: "Date returned", type: "date", hint: "Only if returned" },
      { id: "receivedBy", label: "Received by", type: "text", hint: "Student or parent / guardian" },
      { id: "remarks", label: "Remarks", type: "textarea" },
    ],
    listCols: ["item", "status", "size", "qty", "dateReturned", "receivedBy", "remarks"],
    filters: [{ field: "item", label: "Item", list: "itemTypes" }, { field: "status", label: "Status" }],
    summary: (r) => `${r.item || ""} - ${r.status || ""}${r.size ? " (" + r.size + ")" : ""}${r.qty > 1 ? " x" + r.qty : ""}`,
  }],
  matrix: { title: "Monitoring: who has received what", note: "Each cell shows the latest status of an item for a student. Use 'Show students who have NOT received' to see who is still waiting for an item.",
    kind: "items", field: "item", list: "itemTypes", statusField: "status", ok: ["Issued"], bad: ["Lost", "Damaged"] },
  dashboard: ({ S, recs, students, h }) => {
    const rs = recs.items, issued = rs.filter((r) => r.status === "Issued"), n = (st) => rs.filter((r) => r.status === st).length;
    const withItem = new Set(issued.map((r) => r.registryId)), total = students.length;
    const items = S.lists.itemTypes, qty = (a) => a.reduce((t, r) => t + (Number(r.qty) || 1), 0);
    const perItem = h.hdr(["Item", "Issued", "Returned", "Lost / damaged", "To be issued", "Students who have it", "% of students"]) +
      (items.map((it) => { const a = rs.filter((r) => r.item === it), got = new Set(a.filter((r) => r.status === "Issued").map((r) => r.registryId)).size;
        return h.rowHtml([h.esc(it), qty(a.filter((r) => r.status === "Issued")), qty(a.filter((r) => r.status === "Returned")), qty(a.filter((r) => r.status === "Lost" || r.status === "Damaged")), qty(a.filter((r) => r.status === "To be issued")), got, `${h.pc(got, total)} ${h.bar(got, total)}`]); }).join("") || h.emptyRow(7, "No items on the list."));
    const grades = [...h.GRADES].filter((g) => students.some((s) => h.gradeOf(s) === g));
    const perGrade = h.hdr(["Grade level", "Students", "With at least one item", "No item yet"]) + (grades.map((g) => { const a = students.filter((s) => h.gradeOf(s) === g), w = a.filter((s) => withItem.has(s.id)).length; return h.rowHtml([h.esc(g), a.length, w, a.length - w]); }).join("") || h.emptyRow(4, "No registered students yet."));
    const recent = h.hdr(["Date", "Student", "Item", "Status"]) + (rs.slice(0, 10).map((r) => h.rowHtml([h.esc(h.dateText(r.date)), h.esc(r.name), h.esc(r.item), BADGES[r.status] ? h.badge(BADGES[r.status], r.status) : h.esc(r.status)])).join("") || h.emptyRow(4, "No records yet."));
    return { cards: [["Registered students", total], ["Items issued", qty(issued), "good"], ["Students with at least one item", withItem.size, "good"], ["Students with no item yet", total - withItem.size, "warn"], ["Returned", n("Returned"), "blue"], ["Lost or damaged", n("Lost") + n("Damaged"), "warn"], ["To be issued", n("To be issued"), "warn"]],
      panels: [{ title: "Per item", html: perItem }, { title: "Per grade level", html: perGrade }, { title: "Latest records", html: recent }] };
  },
});
