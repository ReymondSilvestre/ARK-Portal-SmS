# ARK Exam Portal (Google Sheets + GitHub Pages)

No Firebase. The website is static files hosted free on **GitHub Pages**. The database is a **Google Sheet**,
reached only through a small **Google Apps Script** web app that checks who is asking and applies the security rules.

```
GitHub Pages (this repo)  ->  Apps Script web app (apps-script/Code.gs)  ->  Google Sheet (database) + Google Drive (module files)
```

Accounts are created only by the **Super Admin** (schools + IT Admins) and the **IT Admin** (teachers, registrar, finance, custodian, guidance);
teachers activate their own students. They are stored in the `users` tab; password hashes are in `_auth`.

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

### 4. The readable Records sheet (second Google Sheet)
In the spreadsheet menu choose **ARK Portal > 4. Create the readable Records sheet**. Registrar, Finance, Custodian and Guidance records are then copied into it automatically as plain, readable rows
(see `CHANGES.md`). Share it as Viewer only with people allowed to read it.

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

## What changed from the Firebase version
| Before | Now |
|---|---|
| Firestore | Google Sheet tabs (one per collection) |
| Firebase Authentication | `users` + `_auth` tabs, hashed passwords, signed 12-hour tokens |
| `firestore.rules` | the `RULES` section of `apps-script/Code.gs` (same rules, enforced on the server) |
| Cloud Functions | Apps Script actions (`createAccount`, `adminSetTempPassword`, `adminDeleteUser`, `superClearSchoolData`, `superDeleteSchool`, `allocIds`, ...) |
| Password reset email by Firebase | reset link e-mailed by Apps Script (valid 1 hour, one use) |
| Vercel | GitHub Pages |
