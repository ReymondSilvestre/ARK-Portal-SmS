# ARK Exam Portal (Google Sheets + GitHub Pages)

No Firebase. The website is static files hosted free on **GitHub Pages**. The database is a **Google Sheet**,
reached only through a small **Google Apps Script** web app that checks who is asking and applies the security rules.

```
GitHub Pages (this repo)  ->  Apps Script web app (apps-script/Code.gs)  ->  Google Sheet (database) + Google Drive (module files)
```

Accounts are created only by the **Super Admin** (schools + IT Admins) and the **IT Admin** (teachers, registrar, finance, custodian, guidance, HR);
teachers activate their own students. **Employees are added by HR first**; the IT Admin then creates the login from HR's list (see "HR and employee accounts" below). They are stored in the `users` tab; password hashes are in `_auth`.

## Setup (about 15 minutes, once)

### 1. The spreadsheet and the backend
1. Create a new Google Sheet (name it e.g. *ARK Exam Portal DB*). Use the school's Google account.
2. **Extensions > Apps Script**. Delete the sample code and paste all of `apps-script/Code.gs`.
3. In Apps Script: **Project Settings** (gear) > tick **Show "appsscript.json" manifest file**, open it and paste `apps-script/appsscript.json`. Save.
4. Go back to the spreadsheet and **reload the page**. A menu **ARK Portal** appears.
5. **ARK Portal > 1. First-time setup** (Google asks you to authorize: Advanced > Go to project > Allow).
6. **ARK Portal > 2. Create / reset the Super Admin**: enter your email, name and a password (10+ characters, letter + number).
7. **Deploy:** Apps Script > **Deploy > New deployment > Web app**. *Execute as:* **Me**. *Who has access:* **Anyone**. Deploy and **copy the Web app URL**.

### 2. The website
1. Open `js/config.js` and paste the Web app URL.
2. Create a GitHub repository, upload everything in this folder (keep the folder structure), then **Settings > Pages > Deploy from a branch > main / (root)**.
3. Your site is at `https://<you>.github.io/<repo>/`.
4. Back in the spreadsheet: **ARK Portal > 3. Set the website address** and enter that address (needed for password-reset emails).

### 3. First use
Open the site > **Teacher / Registrar / Finance / IT Admin** tab > sign in with the Super Admin email (school code blank).
Register a school and its IT Admin; the temporary password is shown once. The IT Admin then creates the teacher,
registrar and finance accounts, and teachers add and activate students, exactly as before.

### 4. The readable sheets (one Google Sheet per user type)
In the spreadsheet menu choose **ARK Portal > 4. Create the readable sheets (one per user type)**. It creates five separate Google Sheets: **Registrar, Finance, Custodian, Guidance and HR**.
Each one is filled in automatically with plain, readable rows. Share each sheet (Viewer) only with that user type, so the Finance sheet never exposes health records, and so on.
The same menu item turns on the background sync (below). Menu 5 rewrites a sheet from the portal data if it ever needs repair; menu 6 uses a Google Sheet you already made for one user type.

### 5. Speed
* **Saving** no longer waits for the readable sheets: the portal only notes which records changed, and a background job (every minute) copies them. Turn it on with **ARK Portal > 7. Speed up saving** (menu 4 does this too; Google asks for one extra permission the first time).
  The readable sheets can therefore be up to about a minute behind. The portal itself is always current.
* **Pages** open without waiting for a separate "who am I" request, repeated lists are remembered for a few seconds, and the sign-in page wakes the server while you type.

## When you change `Code.gs` later
Apps Script > **Deploy > Manage deployments > pencil > Version: New version > Deploy**. (The URL stays the same.)

## Important things to know
* **Keep the spreadsheet private.** Anyone with access to the Sheet can read student data and password hashes. Share it with nobody; use the app.
* **Never delete or rename the tabs** and do not edit cells by hand. The `_auth` tab holds password hashes.
* **Reset emails** use Gmail through Apps Script (about 100 emails/day on a free Google account, 1,500 on Workspace). Accounts without a real email are reset by the IT Admin as before.
* **Speed and size.** Each request takes roughly 1-3 seconds. One school with ~1,000 students a day is fine. Avoid having
  everyone *start the same exam in the same minute* (Apps Script handles about 30 requests at once; the rest wait), and start a **new spreadsheet each school year**
  (copy the setup steps) so the tabs stay small and fast.
* **Module files** are stored in the Drive folder *ARK Exam Portal files (do not delete)*, owned by the Google account that deployed the script.
* **Sessions** last 12 hours. Six wrong passwords lock that account for 5 minutes.
* The Web app URL is public but harmless: every request is checked against the signed-in person's role, school and owner.
* The old Firebase version's feature notes are kept in `docs/FEATURES-HISTORY-firebase-era.md` (ignore the Firebase setup parts).

## HR and employee accounts
1. The IT Admin creates **one HR account** first (Accounts > Account type *HR* > *New HR person*). The HR person's record is made automatically.
2. **HR** signs in and adds every employee (also people who will never sign in, such as a driver or guard): name, Employee No., birthday, position, department, contact, government IDs, and which portal account the person needs (if any).
   If accounts already existed before the HR page, HR presses **Settings > Add the existing accounts to the HR records** once.
3. The **IT Admin** opens Accounts, chooses the employee from HR's list and the account type, and creates the login. The IT Admin only sees name, Employee No., birthday and position, never the HR details.
4. The login is linked to the HR record. HR sees **Has an account**; removing the account keeps the employee in the HR records. An employee who has an account cannot be deleted from HR until the account is removed.

## Sign in
The sign-in page has two tabs: **Student** (Exam ID No.) and **Employee** (school code + Employee No., or your email when you are an IT Admin / Super Admin). The portal opens the right page for the account.

## What changed from the Firebase version
| Before | Now |
|---|---|
| Firestore | Google Sheet tabs (one per collection) |
| Firebase Authentication | `users` + `_auth` tabs, hashed passwords, signed 12-hour tokens |
| `firestore.rules` | the `RULES` section of `apps-script/Code.gs` (same rules, enforced on the server) |
| Cloud Functions | Apps Script actions (`createAccount`, `adminSetTempPassword`, `adminDeleteUser`, `superClearSchoolData`, `superDeleteSchool`, `allocIds`, ...) |
| Password reset email by Firebase | reset link e-mailed by Apps Script (valid 1 hour, one use) |
| Vercel | GitHub Pages |
