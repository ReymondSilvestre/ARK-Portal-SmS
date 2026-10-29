# SylverVibe Code - Exam Portal

## Update: Registrar dashboard + enrolled masterlist, and the new FINANCE user
**Do this first:** Firestore > Rules > paste `firestore.rules` > Publish (adds the Finance role and the `payments`, `studentAccounts`, `financeSettings` and `financeLog` collections). Then upload the whole project (new files: `finance.html`, `js/finance.js`; changed: `registrar.html`, `js/registrar.js`, `js/auth.js`, `js/admin.js`, `js/student.js`, `admin.html`, `student.html`, `login.html`, `change-password.html`, `css/style.css`, `js/superadmin.js`). If you use the Cloud Functions, deploy `functions/` again. No index changes.

### Registrar
- **Uploads removed.** The "Upload a section list" (Enrollment) and "Upload a list" (Master list) panels are gone: students are registered and enrolled one by one. Excel *downloads* stay.
- **Dashboard** (first tab, filter by school year and term / quarter). A student is *enrolled* when he or she has an enrollment record for the chosen school year (and term, if chosen); every other registered student is *not enrolled*. Shows: enrolled / not enrolled per grade level, total enrolled, total not enrolled, enrolled per cluster / strand, enrolled and not enrolled per term / quarter, male / female for the registration masterlist, for the enrolled masterlist, and per section.
- **Registration masterlist** (was "Master list"): every registered student, enrolled or not.
- **Enrolled masterlist** (new tab): only enrolled students, from the enrollment records, with filters (school year, term, grade, strand, section, voucher, search), Excel download, and the existing "View / download per section".

### Finance (new role)
1. **IT Admin > Accounts > Account type: Finance.** Signs in on the *Teacher / Registrar / Finance / IT Admin* tab with school code + Employee No. (same temporary password rule) and lands on `finance.html`.
2. **Settings > Payment transactions:** the kinds of payment (Tuition, Miscellaneous, Intramurals by default; add your own).
3. **Settings > Fee schedule:** per school year, pick a voucher group (Default for all, PUB, ALS, ESC ..., No voucher) and type the amount per grade level for each transaction. A blank cell uses the *Default for all students* amount; 0 makes it free. The calculation is therefore separate per voucher type. Voucher types come from the Registrar's settings.
4. **Payment computation:** grade level x voucher type table of the total each student pays, with the fees that make it up and the number of enrolled students.
5. **Record a payment:** find an enrolled student, see total to pay / paid / balance per transaction, then enter the date, transaction, amount and receipt No. A payment is never deleted: it can be **voided** with a reason (kept in the history, not counted).
6. **Payment transactions** (filter by date, transaction, grade; Excel), **Student balances** (filter; Excel; "Pay" button), **History**.
7. **Dashboard:** total student collection, total collection today, total student balance, total to collect, students fully paid / with a balance, and breakdowns per transaction, voucher type and grade level.
- **Student page > Balance & payments:** each student sees the total to pay, paid, balance and own payment transactions. Finance's page keeps these in step automatically (`studentAccounts`), so open the Finance page after changing fees or enrolling students to refresh the balances.
- Students are the **enrolled masterlist** of the chosen school year; their grade level (from the enrollment) and voucher type (from the registration) decide the total to pay.

---

## Update: Registrar history log, header order
**Do this first:** Firestore > Rules > paste `firestore.rules` > Publish (it adds the `registrarLog` collection). Then replace `registrar.html`, `js/registrar.js`, `js/auth.js` and `css/style.css`. No Cloud Functions or index changes.
- **Header (all pages):** the school logo and school name are on top, and the signed-in user's name is underneath them.
- **Registrar > History** (new tab): every registrar action is recorded with who did it (name and Employee No.), the date and time, the action and the record. Recorded: registering, **editing** (each changed field shown as old -> new), deleting a student, enrolling, removing from a section, adding / deleting a section, changing an adviser, importing a list (with the list of new / updated students), and changes to voucher types, clusters / strands and additional fields. A save with no changes is not recorded.
- Filter by text, action, person and date range; **Download history (Excel)**; **Clear filters**. In the **Master list**, each student has a **History** button that opens the log filtered to that student.
- Entries are append-only: the Firestore rules do not let the registrar change or delete them (only the super admin can delete).
- Entries made before this update do not exist, so the log starts empty. The History tab shows the latest 300 matching entries; the Excel download has all matching entries.

---

## Update: Registrar page structure, per-section view and download
- **Every registrar page now has its own button bar.** Each button shows one part of the page and hides the rest, so nothing is stacked: *Enrollment* (Enroll a student / Upload a section list / Enrolled in the section), *Sections & advisers* (Add a section / All sections / Section students), *Master list* (All students / View / download per section / Upload a list), *Settings* (Voucher types / Clusters / strands / Additional information).
- **Master list > Download all (Excel)** downloads every student, as before.
- **Master list > View / download per section**: a list of sections (filter by grade level, school year, term / quarter) with a **View** and a **Download** button on each row, plus **Not enrolled in any section**. *View* shows that section's students with their full master-list details (and an Edit button); *Download* saves that one section as Excel. **Download all sections** saves one Excel file with a sheet per section.
- **Sections & advisers** now has a **Download** button per section and a section picker under *Section students*.
- Only `registrar.html`, `js/registrar.js` and `css/style.css` changed. No new Firestore rules are needed.

---

## Update: Registrar additional information, A-Z master list, header layout
- **Registrar > Settings > Additional information**: add your own fields (text, number, date, dropdown, yes/no) for **Student registration**, **Enrollment** and **Master list**. Registration fields appear on the registration form, enrollment fields on the Enrollment form, master-list fields while editing a student from the Master list. All show as columns, are included in the Excel download/template, and are read from uploaded lists by matching the column title.
- **Master list**: sort A-Z / Z-A / Student ID No., A-Z letter bar (first letter of the last name), and a scrolling list that shows about 12 students at a time with the scroll bar on the right.
- **All users**: the signed-in user's name is on its own line; the school logo and school name are together as one block underneath it. (Admin side bar shows the school code under "IT Admin".)
- No new Firestore rules are needed beyond the previous update.

---

## New in this update: REGISTRAR role, master list, enrollment, advisers
**Do this first:** Firestore > Rules > paste `firestore.rules` > Publish. Then replace the whole project (new files: `registrar.html`, `js/registrar.js`). If you deploy the Cloud Functions, deploy `functions/` again.

**Flow**
1. **IT Admin** > Accounts > *Add a faculty / teacher or registrar account* > **Account type: Registrar**. The registrar signs in on the *Teacher / Registrar / IT Admin* tab with **school code + Employee No.** (temporary password = birth year + first letter of last name, same as teachers) and lands on `registrar.html`.
2. **Registrar** (`registrar.html`):
   - **Student registration**: grade level, Student ID No., LRN, voucher type (PUB / ALS / ESC, more can be added in *Settings*), last / first / middle name, suffix (optional), birthdate (age is automatic), gender, contact no., address; father, mother, guardian (required when there is no father or mother), guardian contact and address.
   - **Master list**: every registered student, search / filter, edit, delete, **Download Excel**, and **upload the overall master list** (Excel or CSV; blank template included). Existing Student ID Nos. are updated, blank cells never erase saved data.
   - **Sections & advisers**: create Grade / Cluster-Strand / Section and **choose the adviser from the teacher accounts**. The adviser can be changed at any time (the section's students move to the new adviser; the old classroom code is cleared).
   - **Enrollment**: find the student (name, birthday, age, gender come from the registration), choose grade level, term / quarter, school year, cluster / strand and section. You can also **upload a list for one section** (it registers new students and enrolls everyone in the chosen section, term and year).
3. **Teacher (adviser)**: the section and its students appear on the Teacher page. The teacher presses **Activate account** (or *Activate all student accounts in this section*). Teachers no longer add sections or students themselves.
4. **Student** signs in with the **Exam ID No. = LRN**, or the **Student ID No. if there is no LRN yet**. Password stays birth year + first letter of last name until the first sign-in. The Exam ID No. is printed on answer sheets and used everywhere an "Exam ID" was used before.

**Notes**
- The Exam ID No. is fixed at the first enrollment. If an LRN is entered later for an already-enrolled student, the old Exam ID No. stays so the login and results are not broken.
- A registration of a student whose account is already activated can only be deleted after the IT Admin removes the account.
- New Firestore collections: `registry` (master list), `enrollmentRecords`, `registrarSettings`. Sections made by the registrar are normal `classes` documents owned by the adviser.
- Guardian details, address and voucher type stay in the registrar's records; teachers only receive name, birthday, gender, LRN and Student ID No.

---

## New in this update: phone-friendly layout, hamburger menu, modules for one student
**Do this first:** Firestore > Rules > paste `firestore.rules` > Publish (needed for one-student modules). Then replace the whole project (new file: `js/mobile.js`).

- **Hamburger menu on phones / small screens (760 px and below).** Teacher and Student pages: the row of tab buttons is replaced by a menu button (shows the current page name). It opens a slide-in menu with every tab, the IT Admin link (if shown) and Sign out. IT Admin page: the side bar slides in from the left. Close with the X, by tapping outside, or Esc. Desktop layout is unchanged.
- **Readable tables on phones.** Every table is shown as stacked cards (label above value, action buttons at the bottom of each card) instead of side-scrolling. Done automatically by `js/mobile.js`, so no table code had to change.
- **Easier forms on phones.** One field per line, 16 px inputs (no zoom on iPhone), larger tap targets, filter panel opens as a bottom sheet, full-width buttons.
- **Modules: send to one student only.** Modules > *Send to* > **One student only**, then choose the section and the student. Only that student (and you) can see it; the student's list shows a "For you only" tag. *A whole section* works as before.

---

## New in this update: real emails + auto-capture scanner
**Do this first:** Firestore > Rules > paste `firestore.rules` > Publish (a new `loginIndex` rule is needed). Replace the `js/` files, `css/style.css`, `login.html`, `admin.html`, `teacher.html`. No Cloud Function is needed for any of this (re-deploy `functions/` only if you use them, so removing an account also removes its lookup entry).

- **Optional real email for teacher and student accounts.**
  - IT Admin > Accounts > *Add a faculty / teacher account* has an **Email** box. Teachers add the same box when adding a student (and the import file may have an **Email** column). Leave it blank and nothing changes.
  - With an email, that email *is* the Firebase login. The person can still sign in with **school code + Employee No.** (teacher) or **Exam ID No.** (student), or with the email itself. Temporary password is unchanged (birth year + first letter of last name).
  - **Forgot your password?** on the sign-in page sends Firebase's reset email to that real address (type the email, or Employee No. + school code, or Exam ID No.). Accounts without an email are told to ask their IT Admin / teacher.
  - Accounts with an email also get an **Email reset link** button (IT Admin accounts list, teacher student list), so the person sets their own new password from their inbox.
  - Enter the email *before* the account/login is created: the sign-in address of an existing account cannot be changed from the browser.
  - How the Employee No. / Exam ID sign-in finds the email: a small document `loginIndex/{school.empno}` or `loginIndex/{examid}` holding the email can be read only by its exact key (no listing). Anyone who already knows a school code + Employee No. could therefore look up that one email. If that is not acceptable, give out email sign-in only and skip the Employee No. route.
  - Optional: customise the reset email text in Firebase console > Authentication > Templates > Password reset.
- **Scanner: auto-detect and auto-capture.** Scanner tab > Start camera. The four black corner squares are searched for continuously, anywhere in the picture and with uneven light or a tilted sheet. The sheet is outlined (blue = found, green = steady, orange = move closer); when it is fully in view, large enough and still for about 0.8 s, the picture is taken with a beep/vibration and read automatically. The camera then waits while you check the answers; **Save result** or **Rescan this sheet** resumes it for the next sheet. *Capture now* and *Auto-capture* (on/off) remain; uploading a photo also works better because the sheet no longer has to fill the picture.

Folder layout (same as before, plus `superadmin.html` and `js/superadmin.js`):
```
index.html login.html change-password.html superadmin.html admin.html teacher.html student.html
css/style.css
js/  auth.js superadmin.js admin.js teacher.js student.js omr.js files.js firebase-config.js
functions/  index.js package.json
firestore.rules firebase.json firestore.indexes.json
```

## New in this update
- **Delete all data of a school, or delete the school with its data (Super Admin).** Each school row on the Super Admin page has two buttons:
  - **Delete all data** (red button): wipes every teacher and student account, section, exam, result, module, classroom code and activity log of that school, but **keeps the school registered and its IT Admin**, who can sign in to an empty school. Confirm by typing the *school code*. Cloud Function: `superClearSchoolData`.
  - **Trash icon**: deletes everything above **and** the IT Admin and the school itself. Confirm by typing the *school name*. Cloud Function: `superDeleteSchool`.
  - With the Cloud Functions deployed (`firebase deploy --only functions`) the sign-in logins in Firebase Authentication are removed too. Without them the page falls back to deleting the Firestore records from the browser (this needs the updated `firestore.rules`, which let the Super Admin read school data for that purpose); the logins are then left in Authentication until removed by hand.
  - Both functions are safe to run again if a very large school times out: they pick up whatever is left.
- **School branding (IT Admin).** IT Admin > Branding: set the school name shown on screen and upload a logo (stored on the school's own document). Replaces the "ARK" mark across that school's Teacher, Student and IT Admin pages (not the sign-in page). Works with no Cloud Function.
- **Delete a school (Super Admin).** Super Admin page: a trash icon on each row permanently deletes a school - its IT Admin, every teacher and student account in it, and everything they own (sections, exams, results, modules). Needs typing the school's name to confirm.
  - With the `superDeleteSchool` Cloud Function deployed: also deletes the accounts' sign-in logins from Firebase Authentication.
  - Without it: everything above still happens straight from the browser, except the sign-in logins themselves - those are left behind (harmless, since the Firestore profile they need to sign in to anything is gone) until removed by hand in Firebase console > Authentication > Users.
- **Self-service "Forgot your password?" is removed**, from the sign-in page and from the IT Admin's reset-requests inbox. In its place, each account row has a **"Set password"** button: the IT Admin (or, for an IT Admin's own account, the Super Admin) types a password and it becomes that account's sign-in password immediately, overriding whatever the person had changed it to. They are not told what it is or that it was changed, beyond needing to pick a new one at their next sign-in. Reuses the same `adminSetTempPassword` Cloud Function as "Reset password" - **needs that function deployed** (README step G); there is no way to change another person's password without it, since Firebase blocks that from the browser by design.

## New in version 5
- **Filter icon** (Students list and Results page): pick a section or *All sections* (grouped per section) and sort names A-Z, Z-A or by Exam ID No.
- **Online exams.** Examinations > tick *Students answer this exam online*. Type each question (and the choices for multiple choice) or paste a link to your exam paper. Set a time limit if you want, then *Open* it. Students see it under **Online exams**, answer, submit once, and get the score at once. Results land in the normal Results page (ranking, Excel, item analysis work as before). Identification answers that match your accepted answers (separate several with `|`) are marked correct automatically when you open Results; other identification answers and essays wait for your check (*Check* button shows what the student wrote). *Retake* on a result lets a student start over. *Close* stops new submissions.
- **Answer sheet**: the footer line (title / Exam ID / "ARK sheet v3") is removed.

### Examination page (teacher)
- Top buttons: **My exams**, **+ Create exam**, **Answer key**, **Answer sheets**.
- **My exams**: one card per exam with a green switch to open or close it for students, plus Edit, Answer key, Answer sheet and Delete.
- **+ Create exam** has 3 steps: (1) details, (2) how students take it: *Type the questions*, *Use an exam paper link*, or *Printed only*, (3) questions and key. For typed multiple choice, write each choice and click its letter to mark the correct one. *+ Add question* and *Remove this question* change the number of items.
- **Answer key**: pick an exam, see its key, print it.
- **Student room**: the exam paper (typed questions, or your link embedded) sits on the left and the answer sheet on the right. On a phone the two are switched with tabs.

### Deploy for v5 (no Cloud Function needed)
1. Replace the files, keep your `js/firebase-config.js`.
2. Firestore > Rules: paste `firestore.rules` > Publish. That is all.

How grading stays fair without a server: students read questions from `examPapers` (no key). When they press Submit, their answers are saved once in `examSubmissions` and locked. Only then do the rules let them read `examKeys`, so the browser can score the locked answers. The Results page re-scores every online result from the locked answers, so a changed score on a student's device never counts.
Limits: after submitting, a student could look up the key and tell others, so use *Close* when the class period ends. Identification matches and identification/essay points are applied when you open the Results page (the student's first score shows them as "to check").
Time limit: the timer runs from when the student opens the exam; work sent more than 2 minutes after the limit is kept and marked **Late**.

## Who does what
| Role | Created by | Signs in with | Can do |
|---|---|---|---|
| **Super Admin** (you) | Firebase console, once | email + password | Register schools (name + school code) and each school's IT Admin. Suspend a school. |
| **IT Admin** (one per school) | Super Admin | email + password | Create faculty / teacher accounts, suspend, reset password, remove. Sees only their own school. Also has every teacher tool. |
| **Faculty / Teacher** | School IT Admin | **school code + Employee No.** | Sections (each with a unique classroom code), advisory students, exams, scanner, modules, results. |
| **Student** | Their adviser (teacher) | **Exam ID No.** | Own results and modules. Can join other teachers' classrooms with the classroom code. |

Temporary password for teachers AND students = **birth year + first letter of last name** (example `1985D`). Everyone must choose a new password at first sign-in. Teacher self sign-up and student self sign-up are removed.

## Classroom codes
Every section has a code (6 characters, e.g. `K7M2QX`). A student of any teacher in the **same school** types it under *My classrooms > Join*. Each join is its own record, so classes never mix:
- the student appears in that teacher's section (labelled "Joined by code") and can be scanned, graded and sorted there;
- the student sees that teacher's exam results and modules next to their own;
- the teacher cannot see the student's other classes, birthday or login;
- *New code* stops further joins; students already joined stay. A teacher can remove a student, and a student can leave.

## Set up (do these in order)
1. Replace all files. Keep your own `js/firebase-config.js`.
2. **Make yourself Super Admin.** Firebase console > Firestore > `users` > your old admin document: change `role` to `superadmin`, delete `schoolId` if present. Sign in with that email: you land on `superadmin.html`.
3. **Firestore > Rules**: paste `firestore.rules` > Publish.
4. **Indexes**: `firebase deploy --only firestore:indexes` (needed for the reset-request list and activity log). Or open the page, click the link in the console error Firebase shows, and create it.
5. **Cloud Function** (Blaze plan; school use stays in the free quota). Needed for resetting passwords and removing accounts:
```
firebase use exam-scanner-ac29e
cd functions && npm install && cd ..
firebase deploy --only functions
```
Adds `adminSetTempPassword`, `adminDeleteUser` and `superDeleteSchool`. This needs the Blaze (pay-as-you-go) plan, but a
school this size stays inside Firebase's free monthly quota - Blaze only means billing is turned on, not that you'll be
charged. Everything else in this app (branding, suspending/reactivating, signing in, scanning, exams) works with no
Cloud Function at all; without it, "Set password", "Reset password" and the login-deletion part of "Remove account" and
"Delete school" simply aren't available (their buttons show a clear message instead of failing silently).
6. Super Admin page: **Register a school** (name, code, IT Admin name + email). Give the IT Admin the temporary password shown once.
7. IT Admin signs in with email, changes the password, then **Accounts > Add a faculty / teacher account**.
8. Teacher signs in with the school code + Employee No. + temporary password, adds sections, adds students, **Create logins**.

## Existing data
Teachers, students, exams and results made with version 3 have no `schoolId`, so version 4 will not show them. Easiest: start fresh with the test data. To keep it, add a `schoolId` field (the school code) to each document in `users`, `students`, `classes`, `examinations` and `scanResults`, and register the school first.

## Limits
- Classroom codes work inside one school only.
- Teachers have no email, so password help goes through their IT Admin (sign-in page > Forgot your password > school code + Employee No.).
- A school IT Admin's own forgotten password is reset by the Super Admin (*Reset IT Admin password*).
- Exam ID No. stay unique across all schools (shared counter).
