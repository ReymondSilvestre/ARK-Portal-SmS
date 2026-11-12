# Revision notes

## NEW (update 10): payroll in three separate groups
**To apply:** upload the site folder to GitHub again (changed: `js/payroll.js`, `js/payroll-calc.js`). No `Code.gs` change.

* **Three payroll groups:** *Employee staff* (fixed monthly pay), *Teachers* (per hour) and *School administrators*. The group is chosen per employee under **Add information > Details > Payroll group** (without a choice it follows the position: teacher / instructor / professor / faculty = Teachers; principal, school head, director, administrator, dean ... = Administrators; everyone else = Staff).
* **Add information** now shows one list per group, each with its pay (monthly pay or rate per hour), allowances, **cash advance balance** and which benefits apply. The administrators list shows the salary range and flags a pay outside it.
* **Payroll > Payroll for:** *Everyone* (three tables, each with its own totals, and a grand total) or **one group only** (its own payroll, saved and finalized separately; the saved payroll is named e.g. "Nov 1 - 15, 2026 - Teachers"). The same cut-off can have one payroll per group.
* **Administrators:** the pay of each cut-off can be typed by hand in the payroll (blue = typed; clear it to return to the monthly pay); government benefits and cash advance / balance work as for everyone. **Settings > Administrators salary range** sets the lowest and highest monthly pay (0 = no limit).

---

## NEW (update 9): show / hide sections on every page, payroll cut-offs, teachers paid per hour, government benefits as fixed amounts
**To apply:** upload the whole site folder to GitHub again (new file: `js/collapse.js`; changed: `css/style.css`, `js/payroll.js`, `js/payroll-calc.js` and every page's `.html`). `apps-script/Code.gs` only got extra columns in the readable Payroll sheets (Pay type, Rate per hour, Hours worked): paste it, publish a New version of the deployment and run menu **ARK Portal > 5. Refresh the readable sheets**. No new tabs.

* **Show / hide on every page:** each section heading (panel, card, form group) has a small **Hide / Show** button that folds everything under it, up to the next heading. A **Show all / Hide all** bar sits at the top of the page (it acts on the tab you are looking at). What you folded is remembered while the page is open, also when the page redraws. Printing always shows everything.
* **Payroll > Payroll > Cut-off:** choose **26th - 10th**, **11th - 25th**, **1st - 15th** or **16th - 30th / 31st** (or a whole month, or other dates typed by hand). The dates and the pay day fill in by themselves and can still be changed. For 26th - 10th the *Month* is the month the cut-off ends in (Month = Nov 2026 gives Oct 26 - Nov 10). **Settings > Cut-off and pay date** sets which pair is offered first (26-10 / 11-25 or 1-15 / 16-end) and the pay days.
* **Teachers are calculated separately, per hour:** under **Add information** every employee is either *Fixed monthly pay* or *Per hour* with a **rate per hour** (a position with Teacher / Instructor / Professor / Faculty is Per hour until you choose otherwise). In the payroll the teachers have their own table: **hours worked x rate per hour** = basic pay (hours come from the biometric DTR, regular hours only, and can be corrected in the payroll). No daily rate, no absence or late deduction; overtime hours are paid on top at the overtime rate. Everyone else stays in the fixed monthly table. Each table has its own totals, plus a grand total. The payslip shows *Teaching pay (hours x rate)*.
* **Government benefits (Settings):** SSS, PhilHealth and Pag-IBIG each have **Fixed amount (a month)** or **Percent of the pay**. **Fixed amount is now the default.** Type the employee share and employer share per month in the Settings. An amount typed for one employee under Add information still replaces it, and every payroll can still overtype it. **Check that the fixed amounts are filled in (they start at 0).** Withholding tax is unchanged.

---

## NEW (update 8): update notice only, editable DTR / pay period / pay date, signatories, manual government amounts, cash advance and loans
**To apply:** paste the new `apps-script/Code.gs` (only the readable Payroll sheet columns changed), publish a New version of the deployment, upload the folder to GitHub again, then run menu **ARK Portal > 5. Refresh the readable sheets**. No new tabs: everything is stored in the existing `payrollInfo`, `payrollRuns`, `payslips`, `payrollDtr` and `payrollSettings` tabs.

* **No automatic reload, nothing saves by itself.** When somebody else saves something your page shows, a small notice **"There is a new update. [Update]"** appears in the corner. The page is never reloaded or redrawn until you press **Update** (the x closes the notice). Only the people whose open page shows the changed data get the notice. In Payroll, pressing Update never wipes an open payroll, form or DTR.
* **Payroll > Biometric / DTR > Edit DTR:** every day can be corrected: time in / out, a **status** (present, half day, absent, paid leave, holiday, rest day) and the **late / undertime / overtime minutes** typed by hand (blue = typed; clear it to go back to automatic). **Create DTR by hand** for an employee without biometric data, and **Delete this DTR**. Corrections survive a new upload and *Recalculate*.
* **Payroll > pay period and pay date:** *Period from / to* and *Pay date* are editable for every payroll (and on an open draft). A finalized payroll keeps its period but its **pay date can still be corrected**. **Settings > Pay period and pay date** sets the usual rules (day each half starts / ends, pay days; 0 = last day of the month).
* **Signatories (Settings):** a list of role - name - position (default *Prepared by - Finance Officer* and *Approved by - School Head / Principal*, both editable, up to 3). Printed under every payslip and the last one on the DTR. A finalized payroll keeps the signatories it was finalized with.
* **Government benefits typed by hand:** under *Add information* a fixed monthly amount for SSS, PhilHealth, Pag-IBIG and withholding tax (blank = automatic); and in every payroll each employee's SSS / PhilHealth / Pag-IBIG / tax box can be overtyped for that payroll (blue). *Use automatic government amounts* resets them.
* **Cash advance:** under *Add information*: balance, amount deducted every pay, *New cash advance given* (adds to the balance) and a small history. The payroll takes the deduction automatically (never more than the balance, editable per payroll); the payslip shows the balance after; the balance goes down when the payroll is **finalized**.
* **Loans and other deductions:** each row has a type (SSS salary loan, SSS calamity loan, Pag-IBIG loan, GSIS loan, bank / other loan, other), a name, the amount per month and an optional **balance**. With a balance the loan stops when it is paid off and the balance goes down on Finalize. *Other deductions* can still be typed per payroll.
* **Dashboard:** total cash advance balance, **who has a cash advance and the balance**, **who has loans and their balances**, the latest payroll totals (gross, SSS, PhilHealth, Pag-IBIG, tax, cash advance, loans, net, what to remit), this month's attendance from the DTR, department and recent payroll. *Download cash advance and loan balances (Excel)*. The same balance tables are in Reports (which also gets a Cash advance column).

---

## CHANGED (update 7): no more disturbing refresh
* The page is **never redrawn while you are working**. When another user saves a change, your page is updated by itself only after you have been idle for 20 seconds (no typing, clicking or touching) and nothing is open; otherwise a small notice **"Another user saved a change - Update now"** appears in the corner and nothing on your screen moves. The check is a tiny request every 20 seconds (60 s when idle, none while the tab is hidden).
* **Payroll > Add information:** typing a monthly pay no longer saves by itself; press **Save changed pay amounts**.
* Nothing in the system saves on a timer; every save is a button you press.

---


## NEW (update 6): Biometric upload -> automatic DTR -> payroll
**To apply:** paste the new `apps-script/Code.gs` (new tab `payrollDtr`), publish a New version of the deployment, upload the folder to GitHub again, then run menu **ARK Portal > 5. Refresh the readable sheets** (adds the *Payroll - DTR summary (biometric)* tab).

* **Payroll > Biometric / DTR:** upload the export of the biometric machine (Excel, CSV, or text / .dat). The columns (Employee No., date, time, optional time-in / time-out and name) are found automatically and shown for checking. Employees are matched by Biometric ID, then Employee No., then name.
* The DTR of every employee is made for every day: time in / out, **hours worked, days present, days absent, half day, late, undertime, overtime**, rest day / holiday / approved leave. First punch of the day = IN, last = OUT; a day with only one punch is flagged for correction. You can **correct any time** and the day is recalculated, **recalculate a whole month** after changing the Settings, and **print the DTR** (two copies on one landscape page, like the payslip). Uploading again for the same dates replaces those days.
* **Payroll:** when a pay period is computed, the absences, late + undertime minutes and overtime hours are filled in from the DTR automatically (and can be changed, or reloaded with *Reload from the biometric DTR*). The payslip shows the attendance summary.
* **Settings > Biometric DTR:** work start / end, lunch break deducted, grace period for late, when overtime starts and its block size, half-day limit, working days, whether rest-day work counts as overtime, date order of the file (Month/Day or Day/Month), and the list of holidays. Under **Add information** an employee can have a **Biometric ID** and an **own work start / end**.

---


## NEW (update 5): Payroll account, live updates, readable "ARK - Important Details" sheets, account lists, passwords
**To apply:** paste the new `apps-script/Code.gs`, then **Deploy > Manage deployments > pencil > New version > Deploy**. Upload the whole folder to GitHub again.
Then, in the spreadsheet menu **ARK Portal**, run **4. Create the readable sheets** once (it also renames the old books and creates the new IT Admin and Payroll books) and **5. Refresh the readable sheets**.

* **Readable sheets:** one Google Sheet per user type / department, named **ARK - Important Details - <department>** (Registrar, Finance, Finance - Payroll, Custodian, Guidance, HR, IT Admin). IT Admin book: *Employee accounts* and *Student accounts* (school year, section). Payroll book: pay information, payroll runs, payslips. They are filled in by the background job (about a minute after a save); passwords are never copied.
* **Live updates:** when somebody saves, every other open page reloads that list by itself (checked every 15 s while the page is in use, 45 s when idle, never while the tab is hidden; it waits while you are typing). Lists are also remembered longer (90 s) so pages open faster, and are forgotten as soon as anything changes.
* **Online indicator:** only the one under the user's picture is shown now.
* **HR leave form:** prints as **two copies side by side on one landscape A4 page** (left = HR copy, right = employee copy).
* **IT Admin > Accounts:** *Employee accounts* (Employee No. first, position, department, **Details** button) and *Student accounts* grouped by **school year, then section**. **Set password** and **Reset password** now work for EVERY account (teachers and students too), plus buttons to set the password of a whole section (birth-year default, or one typed password) or of all listed employees. Everyone must choose a new password at the next sign-in.
* **IT Admin > Employee registration:** full employee details including the Employee No. (added in update 4); the Accounts list shows the same details.
* **Finance - Payroll (new account type):** create it under IT Admin > Accounts > *Account type: Finance - Payroll* (the employee needs position "Payroll Officer" or access "Finance - Payroll" in the HR record). Pages: **Dashboard**, **Add information** (monthly pay, allowances, loans, which contributions apply per employee), **Payroll** (automatic computation per pay period: basic, allowances, overtime, absences, late, SSS, PhilHealth, Pag-IBIG, withholding tax, loans; approved *leave without pay* is deducted automatically), **Payslips** (two copies on one landscape page: employee copy left, payroll office copy right), **Reports** (register, by department, SSS / PhilHealth / Pag-IBIG / tax to remit, Excel) and **Settings** (all rates and the tax table).
  The default rates are the 2026 Philippine rates (SSS 5% employee on a salary credit of 5,000-35,000; PhilHealth 5% shared equally, 10,000-100,000; Pag-IBIG 2% up to 10,000; TRAIN tax table). **Please check them under Payroll > Settings against the latest government circulars before the first payroll.**

---


## NEW (update 4): printable leave form, IT Admin employee registration, class schedule maker
**To apply:** paste the new `apps-script/Code.gs`, then **Deploy > Manage deployments > pencil > New version > Deploy**. Upload the whole site folder to GitHub again
(new: `css/schedule.css`, `js/schedule.js`, `js/schedule-view.js`, `js/my-schedule.js`, `js/leave-form.js`, `js/admin-employees.js`, `js/employee-fields.js`; changed: `hr.js`, `admin.js`, `admin.html`, `registrar.html`, `teacher.html`, `student.html`).
No manual sheet setup: the tabs `scheduleSemesters`, `classSchedules`, `scheduleSettings` are created on first use in your main spreadsheet (no Firebase). Run menu **5** once if you want the new readable tab **Registrar - Class schedule**.

* **HR > Leave > Print form:** an *Application for Leave* is filled in automatically (employee, position, department, dates, days, reason, leave credits used / balance, status stamp, signature lines). Also **Print forms (list below)**, and **Approve and print the form** when approving.
* **IT Admin > Employee registration:** the IT Admin can register and edit the full employee record (same fields and 2x2 photo as HR), delete employees without an account, and press **Create account** from the list. HR sees these records and a "(by the IT Admin)" line in HR > History.
* **Registrar > Sections & advisers > Make schedule:** semesters (new / copy / delete), add classes by section, subject, teacher, room, days and time, conflict checks (teacher, room, section), teacher daily hour limit, break times, weekly grid with drag and drop, print (one or all), Excel, subject and room lists.
* **Send:** the Registrar presses *Send to teachers and students*. Each teacher gets a **Class schedule** tab with his or her own classes; each student gets the schedule of the section they are in. *Withdraw* hides it again. Only one semester is sent at a time.

---


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
