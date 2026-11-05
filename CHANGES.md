# Revision notes

## NEW: HR account, per-role readable sheets, faster pages, simpler sign-in
**To apply:** (1) paste the new `apps-script/Code.gs` and `appsscript.json` into Apps Script, then **Deploy > Manage deployments > pencil > New version > Deploy**; (2) reload the spreadsheet and run **ARK Portal > 4. Create the readable sheets** (allow the new permission when Google asks); (3) upload the whole site folder to GitHub again (new files: `hr.html`, `js/hr.js`).

* **HR account (new).** HR keeps the records of ALL employees, also those who never get a login. Fields: Employee No., name, birthday, gender, civil status, position, department, employment type, date hired, status, contact, email, address, emergency contact, SSS / PhilHealth / Pag-IBIG / TIN / PRC numbers, and the portal account the person needs. Dashboard, search and filters, Excel download, history, editable position and department lists.
* **HR first, then IT Admin.** The IT Admin can no longer type an employee from scratch: they choose someone HR has added, and the account type is suggested from HR's record. Name, Employee No. and birthday come from HR. (Only the very first HR account is typed by the IT Admin.) The login is linked to the HR record in both directions.
* **Old accounts.** HR > Settings > *Add the existing accounts to the HR records* creates HR records for teachers, registrars and others made before this update.
* **One readable Google Sheet per user type** (Registrar, Finance, Custodian, Guidance, HR) instead of one shared sheet, so each can be shared with only that user type. The old combined sheet is no longer updated.
* **Sign in:** only two tabs, **Student** and **Employee**. The school code is hidden when an email is typed.

### Faster
* Saving does not wait for the readable sheets any more (background sync, about once a minute; menu 7).
* Saving an employee is one request and the list updates without downloading it again.
* Pages open from the profile kept at sign-in instead of asking the server first; repeated lists are remembered for 15 seconds (and forgotten as soon as you save); the sign-in page wakes the server while you type.
* IT Admin page loads its four lists in one trip instead of one after another; creating an account no longer sends a duplicate activity-log entry.
* The server remembers a signed-in person for 5 minutes instead of 20 seconds, and skips a duplicate read on every save.

---

## Earlier revisions

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
