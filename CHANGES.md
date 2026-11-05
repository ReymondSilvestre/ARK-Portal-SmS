# Revision notes

## NEW (update 3): one side panel for every employee page, HR edits the IT Admin's information
**To apply:** paste the new `apps-script/Code.gs`, then **Deploy > Manage deployments > pencil > New version > Deploy**; upload the whole site folder to GitHub again (new file: `js/sidepanel.js`; changed: all employee pages, `css/style.css`, `js/mobile.js`, `js/leave.js`, `js/hr.js`).

* **Same side panel on every employee page** (IT Admin, teacher, registrar, finance, custodian, guidance, HR, other staff): the person's **photo** (initials circle if there is no photo yet), **account name**, **position** and **department**, then the page menu, then **Leave request** and **Sign out** at the bottom.
  The menu is built from the page's own tabs, so every page works as before. On a phone the panel is the slide-in menu.
* **School logo and school name** stay in the **upper centre** of every page, on **one line**: the logo is square with **no background** (80 px, 52 px on a phone; change `--logo` in `css/style.css` to resize). Set them under IT Admin > Branding.
* **HR > Employees has three buttons:** **All employees**, **Faculty / Teachers** and **Other employees** (registrar, finance, IT Admin, guards ...). Faculty = a teacher account or a position with "Teacher" in it.
* **IT Admin is part of HR > Employees** (no separate tab): the IT Admin is listed with the other employees; **Edit** opens the IT Admin's name, position, department, contact number and 2x2 photo. The IT Admin cannot be deleted from HR. HR keeps the IT Admin's full name, position, department, contact number and 2x2 photo. They show in the IT Admin's side panel the next time the IT Admin opens a page. The sign-in email and password stay with the Super Admin / IT Admin. The change is written to HR > History.
* **Drag to center the photo:** when HR picks a picture (employee or IT Admin), a window opens where the picture can be dragged to center the face inside the circle and zoomed (slider or mouse wheel). Press **Use photo**, then Save. Cancel keeps the old photo.
* Photo, position and department of the other employees still come from HR > Employees > Edit.
* The student page is unchanged.

---

## NEW (update 2): loading animation, HR own leave, leave for people without accounts, any position can have an account, HR delete with account, 2x2 photo
**To apply:** paste the new `apps-script/Code.gs`, then **Deploy > Manage deployments > pencil > New version > Deploy**; upload the whole site folder to GitHub again (new files: `staff.html`, `js/staff.js`). `js/config.js` already holds your Web app URL.

* **Loading / saving animation (all pages):** a moving bar at the top while anything loads, and a centered "Saving..." card with a spinner while something is saved or an account action runs (so nobody presses a button twice). Requests shorter than a quarter of a second show nothing.
* **HR can approve / reject its own leave** (no second HR account needed).
* **HR files a leave for any employee, also one without an account** (Leave > Leave request > *File a leave for an employee*). It can be saved as Approved at once or as Pending. HR can also delete a leave request.
* **Leave page has three buttons:** *Leave request*, *On leave and coming up*, *Leave monitoring*.
* **Every position can have an account:** new account type **Other staff** (principal, librarian, nurse, guard, driver, janitor ...). HR picks the account needed in the employee form (it is suggested from the Position); the IT Admin creates it as before. These people sign in to `staff.html`, see their photo and details, and send leave requests.
* **HR can delete an employee even with an active account:** the portal account is deleted at the same time (the confirmation says so; for a teacher it also deletes their students, sections and exams), together with the person's leave requests. HR cannot delete its own record.
* **2x2 photo:** HR > Add / Edit employee > *Photo*. The picture is cropped square and shrunk automatically. It shows in the employee list and details, and **beside the person's name and position** at the top of their own page.

---

## NEW: Leave requests (all employee accounts) and HR leave monitoring
**To apply:** (1) paste the new `apps-script/Code.gs` into Apps Script, then **Deploy > Manage deployments > pencil > New version > Deploy**; (2) upload the whole site folder to GitHub again (new file: `js/leave.js`; changed: `hr.html`, `js/hr.js`, `css/style.css` and the IT Admin, teacher, registrar, finance, custodian and guidance pages). No new spreadsheet tab setup is needed: the `leaveRequests` tab is created on first use, and the HR readable sheet gets a new tab **HR - Leave requests** (run menu 5 once if you want the tab to appear before the first request).

* **Every employee account can send a leave request to HR:** teacher, registrar, finance, custodian, guidance, HR and the **IT Admin**. A **Leave request** button appears in the top bar (the IT Admin has it on the left side bar). It opens the leave form (leave type, dates, working days, reason) and the person's own requests with their status and HR's remarks. Pending requests can be cancelled. The button shows "(1 new)" when HR has answered.
* **HR > Leave tab (new):** requests waiting for a decision (the tab shows the count), Approve / Reject (a reason is required to reject) / Reopen, filters, Excel download, who is on leave now and coming up, and **leave monitoring**: for each employee the days used and left per leave type for the chosen year, plus days waiting. Approving past the yearly limit asks for confirmation.
* **HR > Settings > Leave types:** edit the leave types and the days a year (default: Vacation 15, Sick 15, Emergency 3, Maternity/Paternity, Leave without pay, Other).
* HR dashboard: new cards "Leave requests waiting" and "On leave today"; the Employees list shows an **On leave today** badge. HR can still edit every employee's details (Employees > Edit). Decisions are written to HR > History.
* Security: an employee reads and cancels only their own requests; only HR of the same school reads and decides all of them, and HR cannot decide their own request (another HR account must).

---

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
