# Revision notes

## IMPORTANT: update Code.gs, then set up the readable Records sheet
1. Copy the new `apps-script/Code.gs` into Apps Script, then **Deploy > Manage deployments > pencil > Version: New version > Deploy**.
2. Reload the spreadsheet. In the **ARK Portal** menu choose **4. Create the readable Records sheet** (once). It creates a second Google Sheet and fills it with everything that already exists.
   * Menu 5 rewrites it from the portal data if you ever need to repair it. Menu 6 uses a Google Sheet you already made (empty).
3. Share that second sheet (Viewer) only with the people allowed to see it. The Guidance tabs hold health and counseling notes.
4. Upload the whole site folder to GitHub again (new files: `custodian.html`, `guidance.html`, `js/custodian.js`, `js/guidance.js`, `js/records-app.js`).

## Second Google Sheet: readable records
Every save, edit or delete by the Registrar, Finance, Custodian or Guidance is copied, in plain words, into tabs of the second sheet
(Registrar - Students / Requirements / Enrollment, Finance - Payments / Balances, Custodian - Items, Guidance - Health / Counseling).
One row per record, one column per fact, readable dates ("June 5, 2026"), amounts ("PHP 1,500.50"), filter buttons on the first row. The first sheet stays the portal's database.
Do not type in the readable sheet: the next save of that record overwrites the row. Deleting a record in the portal removes its row.

## Fixes
* **Drop-down lists turning white** (text invisible on wide screens): form controls now always use dark text on a white background, including the option list, whatever the browser / Windows theme is.

## IT Admin
* New account types: **Custodian** and **Guidance** (same sign-in as other staff: school code + Employee No.).
* **Reset password** and **Set password** buttons are removed from teacher accounts. (Email reset link, Suspend and Remove account stay.)

## Registrar
* New **School requirements** tab, right after Student registration: a checklist of documents per student (date + note for each), filters, Excel download. The list of required documents is edited under **Settings > School requirements**.
* **Enrollment status** is editable (Pending, Enrolled, Not Enrolled, Transferred Out, Drop Out, Cancelled Enrolled). New registrations start as Pending; enrolling a student makes it Enrolled; Transferred Out / Drop Out / Cancelled Enrolled also set the remark on the enrollment record, so the dashboard numbers stay correct. A student already in a section cannot be set to Pending / Not Enrolled (remove from the section first).
* Dashboard: requirements complete / incomplete cards, enrollment-status table, requirements per grade level. Status and requirements columns in the masterlists and Excel files.
* Students registered before this update get their status filled in automatically the first time the Registrar page opens.

## Custodian (new)
Dashboard, **Give an item** (uniform, P.E. uniform, ID, books, locker key ... with status Issued / Returned / Lost / Damaged / To be issued, size, quantity, received by), Records (filters, edit, delete, Excel), **Monitoring** (who has received which item; who has NOT), Student file, History, Settings (edit the item list, add your own fields).

## Guidance (new)
Dashboard, **Health record** (height, weight, BMI, vision, hearing, allergies, conditions, medicines, immunization, findings, treatment, follow-up) and **Guidance record** (counseling, behavior, referral, home visit ... with status, action taken, parent informed, follow-up), Records (filters, edit, delete, Excel), Student file, History, Settings. Only the Guidance account of the school can open these records.
