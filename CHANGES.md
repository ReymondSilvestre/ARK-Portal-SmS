# Revision notes

## IMPORTANT: redeploy Code.gs
A new server action (`registrarDropStudentAccount`) was added so the Registrar can delete a student's login account.
Copy the new `apps-script/Code.gs` into Apps Script, then **Deploy > Manage deployments > pencil > Version: New version > Deploy**.
Without this step, "Delete student" and "Remark + delete account" will fail for students that already have an account.

## Registrar
* **Registration**: new required **School year** field (e.g. 2026-2027). Saved on the student, shown in the Registration masterlist, in the history log and in Excel.
* **Enrollment**: new **Learning modality** (Face to Face, Blended, Modular, Internal Agreement). Shown in the enrolled lists, dashboard (per modality table) and Excel.
* **Delete enrolled students**: Delete button in the Registration masterlist and the Enrolled masterlist. If the student already has a login account, the account is deleted too.
* **Remark**: Enrolled masterlist > Remark button: Transferred Out / Drop Out / Cancelled Enrolled (date + note). Ticking "Also delete this student's login account" removes the account but keeps the records. Remarked students are not counted as enrolled on the dashboard (separate card).
* **Filters + downloads (Registration and Enrolled masterlist)**: filter by school year and quarter/term; download as current filters, one sheet per school year, or one sheet per quarter/term.

## Finance
* **Fee schedule**: new Grade level dropdown (one grade at a time, or "All grade levels (overview)"). Typed amounts are kept while switching grade; one Save stores all.
* **Enrolled masterlist** tab (view only) with school year / quarter-term / grade / section / voucher / modality / remark filters and the same three download options.
