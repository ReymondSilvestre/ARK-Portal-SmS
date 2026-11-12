/**
 * ARK Exam Portal - backend (Google Apps Script + Google Sheets)
 * -----------------------------------------------------------------------------
 * Replaces Firebase (Firestore + Authentication + Cloud Functions).
 *   - Every Firestore collection is one TAB of this spreadsheet (created on first use).
 *   - Accounts (Super Admin, IT Admin, teachers, registrar, finance, HR, students) are created by the
 *     Super Admin / IT Admin and stored in the `users` tab; password hashes live in the `_auth` tab.
 *   - The website (GitHub Pages) NEVER touches the spreadsheet directly: it only calls this web app,
 *     which checks who is asking and applies the same rules that used to be in firestore.rules.
 * Setup: see README.md (menu "ARK Portal" appears in the spreadsheet after you reload it).
 */

/* ============================== settings ============================== */
var SESSION_MS = 12 * 3600 * 1000;      // a sign-in lasts 12 hours
var PW_ROUNDS = 1000;                   // password hashing rounds
var MAX_FAILS = 6, LOCK_MS = 5 * 60 * 1000;   // 6 wrong passwords -> that account waits 5 minutes
var RESET_MS = 60 * 60 * 1000;          // reset links last 1 hour
var COLS = ['id', 'schoolId', 'ownerUid', 'studentId', 'data', 'updatedAt'];
var AUTH_TAB = '_auth';
var AUTH_COLS = ['uid', 'keys', 'salt', 'hash', 'ver', 'resetHash', 'resetExp', 'fails', 'lockUntil'];
var CELL_MAX = 45000;                   // a cell holds 50,000 characters
var BLOB_MIN = 20000;                   // bigger text fields (module file pieces) go to Google Drive
var KNOWN = ['schools', 'users', 'auditLogs', 'systemSettings', 'counters', 'classCodes', 'enrollments', 'teacherLinks', 'students',
  'scanResults', 'modules', 'moduleChunks', 'examPapers', 'examKeys', 'examSubmissions', 'examAttempts', 'classes', 'registry',
  'enrollmentRecords', 'registrarSettings', 'registrarLog', 'payments', 'studentAccounts', 'financeSettings', 'financeLog',
  'examinations', 'answerKeys', 'answerSheets', 'custodianRecords', 'custodianSettings', 'custodianLog', 'healthRecords', 'guidanceRecords', 'guidanceSettings', 'guidanceLog',
  'employees', 'hrSettings', 'hrLog', 'leaveRequests',
  'scheduleSemesters', 'classSchedules', 'scheduleSettings', 'payrollSettings', 'payrollInfo', 'payrollRuns', 'payslips', 'payrollDtr'];
var SCHOOL_COLLECTIONS = ['scanResults', 'examAttempts', 'examSubmissions', 'examKeys', 'examPapers', 'moduleChunks', 'modules',
  'examinations', 'answerKeys', 'answerSheets', 'enrollments', 'teacherLinks', 'classCodes', 'students', 'classes',
  'enrollmentRecords', 'registry', 'registrarSettings', 'payments', 'studentAccounts', 'financeSettings', 'financeLog', 'registrarLog',
  'custodianRecords', 'custodianSettings', 'custodianLog', 'healthRecords', 'guidanceRecords', 'guidanceSettings', 'guidanceLog',
  'employees', 'hrSettings', 'hrLog', 'leaveRequests',
  'scheduleSemesters', 'classSchedules', 'scheduleSettings', 'payrollSettings', 'payrollInfo', 'payrollRuns', 'payslips', 'payrollDtr'];
/* Every kind of employee account. HR adds the employee first (collection `employees`); the IT Admin then creates the login. */
var EMP_ROLES = ['teacher', 'registrar', 'finance', 'payroll', 'custodian', 'guidance', 'hr', 'schooladmin', 'staff'];   // 'schooladmin' = School Admin (principal / school head): READ-ONLY view of every department's dashboards and reports; 'payroll' = Finance - Payroll officer;   // 'staff' = every other position (principal, librarian, nurse, guard, driver, janitor ...)
var MANAGED_ROLES = EMP_ROLES.concat(['student']);
var LEAVE_ROLES = EMP_ROLES.concat(['admin']);   // everyone who can file a leave request to HR
var ACTOR_TTL = 300;                    // seconds a signed-in person's profile is remembered between requests (was 20)

/* ============================== helpers ============================== */
function fail(code, message) { var e = new Error(message || code); e.code = code; throw e; }
var DENIED = 'You do not have permission for that action.';
function deny() { fail('permission-denied', DENIED); }
function prop(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function setProp(k, v) { PropertiesService.getScriptProperties().setProperty(k, v); }
function nowMs() { return Date.now(); }
function newId() { return Utilities.getUuid().replace(/-/g, '').slice(0, 20); }
function isStr(v) { return typeof v === 'string'; }
function jeq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function slug(s) { return String(s).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-'); }
function staffKey(school, emp) { return slug(school) + '.' + slug(emp); }
function studentKey(id) { return slug(id); }
function isEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim()); }
function defaultPassword(lastName, birthday) {
  var y = /^(\d{4})-/.exec(birthday || ''), l = String(lastName || '').trim()[0];
  return y && l ? y[1] + l.toUpperCase() : '';
}
function normPw(p) { p = String(p || ''); return /^\d{4}[a-z]$/i.test(p) ? p.slice(0, 4) + p.slice(4).toUpperCase() : p; }
function strongEnough(role, pw) {
  var min = role === 'student' ? 6 : 10;
  if (!isStr(pw) || pw.length < min) return false;
  return role === 'student' || (/[A-Za-z]/.test(pw) && /\d/.test(pw));
}
function keysOnly(o, list) { for (var k in o) if (list.indexOf(k) < 0) return false; return true; }
function diffKeys(a, b) {
  var out = {}; a = a || {}; b = b || {};
  for (var k in a) if (!jeq(a[k], b[k])) out[k] = 1;
  for (var k2 in b) if (!(k2 in a)) out[k2] = 1;
  return Object.keys(out);
}
function subset(list, allowed) { return list.every(function (k) { return allowed.indexOf(k) >= 0; }); }
function tsOf(v) { return v && typeof v === 'object' && '__ts' in v ? v.__ts : v; }
function getPath(o, path) { var p = String(path).split('.'); for (var i = 0; i < p.length; i++) { if (o == null) return undefined; o = o[p[i]]; } return o; }

/* ============================== crypto ============================== */
function b64(bytes) { return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ''); }
function hmac(msg) { return b64(Utilities.computeHmacSha256Signature(msg, prop('SECRET'))); }
function sha(s) { return b64(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s)); }
function hashPw(pw, salt) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, prop('PEPPER') + ':' + salt + ':' + pw);
  for (var i = 0; i < PW_ROUNDS; i++) d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, d.concat(Utilities.newBlob(salt).getBytes()));
  return b64(d);
}
function same(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; var r = 0; for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function makeToken(uid, ver) { var exp = nowMs() + SESSION_MS, body = uid + '.' + exp + '.' + ver; return { token: body + '.' + hmac(body), exp: exp }; }
function readToken(token) {
  var p = String(token || '').split('.');
  if (p.length !== 4) return null;
  var body = p[0] + '.' + p[1] + '.' + p[2];
  if (!same(hmac(body), p[3]) || +p[1] < nowMs()) return null;
  return { uid: p[0], ver: p[2] };
}

/* ============================== spreadsheet tables ============================== */
var _ss = null, _tabs = {}, _newBlobs = [], _oldBlobs = [];
function ss() { return _ss || (_ss = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(prop('SHEET_ID'))); }
function T(name) {
  if (_tabs[name]) return _tabs[name];
  var cols = name === AUTH_TAB ? AUTH_COLS : COLS, sh = ss().getSheetByName(name);
  if (!sh) {
    try {
      sh = ss().insertSheet(name);
      sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
      sh.setFrozenRows(1);
      sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    } catch (e) { sh = ss().getSheetByName(name); if (!sh) throw e; }   // another request created it first
  }
  var n = Math.max(0, sh.getLastRow() - 1);
  return (_tabs[name] = { name: name, sh: sh, cols: cols, n: n, nSheet: n, c: {}, idx: null, rows: {}, dirty: {}, dirtyN: 0, deleted: {}, delN: 0, pend: [], ecell: {} });
}
function colOf(t, k) {   // one column, loaded on demand (strings)
  if (!t.c[k]) {
    var a = t.nSheet ? t.sh.getRange(2, k + 1, t.nSheet, 1).getValues().map(function (r) { return String(r[0]); }) : [];
    t.pend.forEach(function (r) { a.push(r ? String(r[k]) : ''); });
    t.c[k] = a;
  }
  return t.c[k];
}
function indexOf(t) {
  if (!t.idx) { var a = colOf(t, 0), m = {}; for (var i = 0; i < a.length; i++) if (!t.deleted[i]) m[a[i]] = i; t.idx = m; }
  return t.idx;
}
function cellJson(t, i) {   // the data cell of row i
  if (t.ecell[i] !== undefined) return t.ecell[i];
  if (t.c[4]) return t.c[4][i];
  if (i >= t.nSheet) return String(t.pend[i - t.nSheet][4]);
  return (t.ecell[i] = String(t.sh.getRange(i + 2, 5).getValue()));
}
function tPut(t, id, row) {
  var m = indexOf(t), i = m[id];
  if (i === undefined) {
    i = t.n++; t.pend.push(row); m[id] = i;
    for (var k in t.c) t.c[k].push(String(row[k]));
  } else {
    if (i >= t.nSheet) t.pend[i - t.nSheet] = row; else { t.rows[i] = row; if (!t.dirty[i]) { t.dirty[i] = 1; t.dirtyN++; } }
    for (var k2 in t.c) t.c[k2][i] = String(row[k2]);
  }
  t.ecell[i] = String(row[4]);
}
function tDel(t, id) {
  var m = indexOf(t), i = m[id]; if (i === undefined) return;
  delete m[id]; t.deleted[i] = 1; t.delN++;
}
function ensureRows(t, upto) {
  var max = t.sh.getMaxRows();
  if (upto > max) t.sh.insertRowsAfter(max, upto - max + 500);
}
function flush(t) {
  if (!t.dirtyN && !t.delN && !t.pend.length) return;
  var sh = t.sh, nc = t.cols.length, i;
  if (t.delN > 10 || t.dirtyN > 15) {            // big change: rewrite the whole tab in one go
    var all = t.nSheet ? sh.getRange(2, 1, t.nSheet, nc).getValues().map(function (r) { return r.map(String); }) : [];
    for (i in t.rows) all[+i] = t.rows[i].map(String);
    t.pend.forEach(function (r) { all.push(r ? r.map(String) : null); });
    var keep = all.filter(function (r, j) { return r && !t.deleted[j]; });
    if (all.length) sh.getRange(2, 1, all.length, nc).clearContent();
    if (keep.length) { ensureRows(t, keep.length + 1); var rg = sh.getRange(2, 1, keep.length, nc); rg.setNumberFormat('@'); rg.setValues(keep); }
  } else {
    for (i in t.dirty) if (!t.deleted[i]) sh.getRange(+i + 2, 1, 1, nc).setValues([t.rows[i].map(String)]);
    var gone = Object.keys(t.deleted).map(Number).filter(function (j) { return j < t.nSheet; }).sort(function (a, b) { return b - a; });
    gone.forEach(function (j) { sh.deleteRow(j + 2); });
    var add = t.pend.filter(function (r, j) { return r && !t.deleted[t.nSheet + j]; }).map(function (r) { return r.map(String); });
    if (add.length) {
      var start = t.nSheet - gone.length + 2; ensureRows(t, start + add.length);
      var r2 = sh.getRange(start, 1, add.length, nc); r2.setNumberFormat('@'); r2.setValues(add);
    }
  }
  delete _tabs[t.name];
}
function flushAll() {
  Object.keys(_tabs).forEach(function (k) { if (_tabs[k]) flush(_tabs[k]); });
  _oldBlobs.forEach(trashBlob); _oldBlobs = []; _newBlobs = [];
}
function rollback() { _tabs = {}; _newBlobs.forEach(trashBlob); _newBlobs = []; _oldBlobs = []; }

/* ---------- big text goes to Drive ---------- */
function newBlob(text) {
  var f = DriveApp.getFolderById(prop('FOLDER_ID')).createFile(newId() + '.txt', text, MimeType.PLAIN_TEXT);
  _newBlobs.push(f.getId()); return f.getId();
}
function readBlob(id) { return DriveApp.getFileById(id).getBlob().getDataAsString(); }
function trashBlob(id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { } }
function blobsIn(json) { var out = [], re = /"__(?:blob|doc)":"([A-Za-z0-9_-]+)"/g, m; while ((m = re.exec(json))) out.push(m[1]); return out; }
function pack(data) {
  var d = {};
  for (var k in data) { var v = data[k]; d[k] = isStr(v) && v.length > BLOB_MIN ? { __blob: newBlob(v) } : v; }
  var js = JSON.stringify(d);
  if (js.length > CELL_MAX) js = JSON.stringify({ __doc: newBlob(JSON.stringify(data)) });
  return js;
}
function unpack(json) {
  var d = JSON.parse(json);
  if (d && d.__doc) return JSON.parse(readBlob(d.__doc));
  for (var k in d) if (d[k] && typeof d[k] === 'object' && d[k].__blob) d[k] = readBlob(d[k].__blob);
  return d;
}

/* ---------- documents ---------- */
function getDoc(coll, id) {
  var t = T(coll), i = indexOf(t)[id];
  return i === undefined ? null : unpack(cellJson(t, i));
}
function putDoc(coll, id, data) {
  var t = T(coll), i = indexOf(t)[id];
  if (i !== undefined) _oldBlobs = _oldBlobs.concat(blobsIn(cellJson(t, i)));
  tPut(t, id, [id, isStr(data.schoolId) ? data.schoolId : '', isStr(data.ownerUid) ? data.ownerUid : '', isStr(data.studentId) ? data.studentId : '', pack(data), nowMs()]);
}
function delDoc(coll, id) {
  var t = T(coll), i = indexOf(t)[id];
  if (i === undefined) return;
  _oldBlobs = _oldBlobs.concat(blobsIn(cellJson(t, i)));
  tDel(t, id);
}
/** All documents of a collection that pass `cheap` (indexed columns) - returns [{id, i}] */
function scan(coll, eq) {
  var t = T(coll), ids = colOf(t, 0), out = [], cols = { schoolId: 1, ownerUid: 2, studentId: 3 }, use = [];
  if (eq) for (var f in eq) if (cols[f]) use.push([colOf(t, cols[f]), eq[f]]);
  for (var i = 0; i < ids.length; i++) {
    if (t.deleted[i]) continue;
    var ok = true;
    for (var u = 0; u < use.length; u++) if (!(use[u][1].indexOf(use[u][0][i]) >= 0)) { ok = false; break; }
    if (ok) out.push({ id: ids[i], i: i });
  }
  return { t: t, hits: out };
}

/* ============================== accounts / sessions ============================== */
function authRow(uid) {
  var t = T(AUTH_TAB), i = indexOf(t)[uid]; if (i === undefined) return null;
  var r = t.rows[i] || (i >= t.nSheet ? t.pend[i - t.nSheet] : t.sh.getRange(i + 2, 1, 1, AUTH_COLS.length).getValues()[0]);
  var o = {}; AUTH_COLS.forEach(function (c, k) { o[c] = String(r[k]); }); return o;
}
function authPut(o) { var t = T(AUTH_TAB); tPut(t, o.uid, AUTH_COLS.map(function (c) { return o[c] === undefined ? '' : o[c]; })); }
function authFindByKey(key) {
  var t = T(AUTH_TAB), keys = colOf(t, 1), needle = '|' + key + '|';
  for (var i = 0; i < keys.length; i++) if (!t.deleted[i] && keys[i].indexOf(needle) >= 0) return authRow(colOf(t, 0)[i]);
  return null;
}
function keysString(keys) { return '|' + keys.join('|') + '|'; }
function authCreate(uid, keys, password) {
  var salt = newId();
  authPut({ uid: uid, keys: keysString(keys), salt: salt, hash: hashPw(password, salt), ver: '1', resetHash: '', resetExp: '', fails: '0', lockUntil: '0' });
}
function authSetPassword(uid, password) {
  var a = authRow(uid); if (!a) fail('not-found', 'That account was not found.');
  a.salt = newId(); a.hash = hashPw(password, a.salt); a.ver = String(+a.ver + 1); a.resetHash = ''; a.resetExp = ''; a.fails = '0'; a.lockUntil = '0';
  authPut(a); return a;
}
function epoch() { try { return CacheService.getScriptCache().get('epoch') || '0'; } catch (e) { return '0'; } }
function bumpEpoch() { try { CacheService.getScriptCache().put('epoch', newId(), 21600); } catch (e) { } }   // a school changed: forget every remembered profile
function dropActor(uid) { try { CacheService.getScriptCache().remove('a:' + epoch() + ':' + uid); } catch (e) { } }

function loadActor(token) {
  var tk = readToken(token); if (!tk) fail('unauthenticated', 'Please sign in again.');
  var cache = CacheService.getScriptCache(), ck = 'a:' + epoch() + ':' + tk.uid, c = cache.get(ck), a = c ? JSON.parse(c) : null;
  if (!a) {
    var me = getDoc('users', tk.uid), au = authRow(tk.uid);
    if (!me || !au) fail('unauthenticated', 'Please sign in again.');
    var sc = me.schoolId ? getDoc('schools', me.schoolId) : null;
    a = { me: me, schoolStatus: sc ? sc.status : '', ver: au.ver };
    cache.put(ck, JSON.stringify(a), ACTOR_TTL);
  }
  if (a.ver !== tk.ver) fail('unauthenticated', 'Please sign in again.');
  return { uid: tk.uid, me: a.me, schoolStatus: a.schoolStatus, ver: a.ver };
}

/* ============================== security rules (was firestore.rules) ============================== */
function makeS(actor, now) {
  var me = actor.me || {}, S = { uid: actor.uid, me: me, sid: me.schoolId, now: now || nowMs() };
  S.hasProfile = !!actor.me;
  S.schoolLive = me.role === 'superadmin' || (isStr(me.schoolId) && actor.schoolStatus === 'active');
  S.live = S.hasProfile && me.status === 'active' && me.mustChangePassword !== true && S.schoolLive;
  S.isSuper = S.live && me.role === 'superadmin'; S.isAdmin = S.live && me.role === 'admin';
  S.isTeacher = S.live && me.role === 'teacher'; S.isRegistrar = S.live && me.role === 'registrar';
  S.isFinance = S.live && me.role === 'finance'; S.isPayroll = S.live && me.role === 'payroll'; S.isHR = S.live && me.role === 'hr'; S.isCustodian = S.live && me.role === 'custodian'; S.isGuidance = S.live && me.role === 'guidance'; S.isSchoolAdmin = S.live && me.role === 'schooladmin'; S.isStaff = S.isAdmin || S.isTeacher; S.isStudent = S.live && me.role === 'student';
  S.get = function (c, id) { return isStr(id) && id ? getDoc(c, id) : null; };
  S.exists = function (c, id) { return !!S.get(c, id); };
  S.validAdviser = function (uid) { var u = S.get('users', uid); return !!u && u.role === 'teacher' && u.schoolId === S.sid; };
  S.studentRec = function (sid) { return S.get('students', sid) || {}; };
  S.myStudent = function () { return S._ms || (S._ms = S.studentRec(me.studentId)); };
  S.studentSees = function (ownerUid, classId) {
    if (!S.isStudent) return false;
    var ms = S.myStudent();
    return (ownerUid === ms.ownerUid && [ms.classId, ''].indexOf(classId) >= 0) ||
      (S.exists('teacherLinks', me.studentId + '_' + ownerUid) && (classId === '' || S.exists('enrollments', me.studentId + '_' + classId)));
  };
  S.sentToMe = function (d) { return S.isStudent && (d.studentId || '') === me.studentId; };
  S.mayRead = function (d) { return d.ownerUid === S.uid; };
  S.inMySchool = function (d) { return d.schoolId === S.sid; };
  return S;
}

var RULES = {
  schools: {
    read: function (S, d, id) { return S.hasProfile && (S.me.role === 'superadmin' || S.me.schoolId === id); },
    create: function (S, id, n) { return S.isSuper && keysOnly(n, ['name', 'code', 'adminEmail', 'status', 'createdAt', 'createdBy']) && n.code === id && n.status === 'active'; },
    update: function (S, id, o, n) {
      var df = diffKeys(o, n);
      if (S.isSuper && subset(df, ['status', 'updatedAt']) && ['active', 'suspended'].indexOf(n.status) >= 0) return true;
      return S.isAdmin && S.me.schoolId === id && subset(df, ['displayName', 'logo', 'adminEmail', 'updatedAt']) &&
        (!('adminEmail' in n) || n.adminEmail === S.me.email) &&
        (!('displayName' in n) || (isStr(n.displayName) && n.displayName.length <= 80)) &&
        (!('logo' in n) || (isStr(n.logo) && n.logo.length <= 900000));
    },
    del: function (S) { return S.isSuper; }
  },
  users: {
    read: function (S, d, id) { return (S.hasProfile && S.uid === id) || S.isSuper || (S.isAdmin && S.inMySchool(d)) || (S.isRegistrar && d.role === 'teacher' && S.inMySchool(d)); },
    create: function () { return false; },     // accounts are made by the createAccount action only
    update: function (S, id, o, n) {
      var df = diffKeys(o, n);
      return (S.isAdmin && MANAGED_ROLES.indexOf(o.role) >= 0 && S.inMySchool(o) && subset(df, ['status', 'updatedAt']) && ['active', 'suspended'].indexOf(n.status) >= 0) ||
        (S.isSuper && o.role === 'admin' && subset(df, ['status', 'updatedAt']) && ['active', 'suspended'].indexOf(n.status) >= 0);
    },
    del: function (S, id, o) {
      return (S.isAdmin && MANAGED_ROLES.indexOf(o.role) >= 0 && S.inMySchool(o)) ||
        (S.isSuper && ['admin'].concat(MANAGED_ROLES).indexOf(o.role) >= 0) ||
        (S.isStaff && o.role === 'student' && S.studentRec(o.studentId).ownerUid === S.uid);
    }
  },
  auditLogs: {
    read: function (S, d) { return S.isSuper || (S.isAdmin && S.inMySchool(d)); },
    create: function (S, id, n) { return (S.isSuper || (S.isAdmin && n.schoolId === S.sid)) && n.actorUid === S.uid; },
    update: function () { return false; },
    del: function (S) { return S.isSuper; }
  },
  systemSettings: { read: function (S) { return S.live; }, create: function (S) { return S.isSuper; }, update: function (S) { return S.isSuper; }, del: function (S) { return S.isSuper; } },
  counters: { read: function (S) { return S.isStaff; }, create: function (S) { return S.isStaff; }, update: function (S) { return S.isStaff; }, del: function (S) { return S.isStaff; } },
  classCodes: {
    read: function (S, d, id, mode) { return mode === 'get' ? S.live : (S.isSuper || (S.isStaff && d.ownerUid === S.uid)); },
    create: function (S, id, n) { return S.isStaff && n.ownerUid === S.uid && n.schoolId === S.sid && n.code === id; },
    update: function (S, id, o) { return S.isStaff && o.ownerUid === S.uid; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper || (S.isRegistrar && S.inMySchool(o)); }
  },
  enrollments: {
    read: function (S, d) { return S.isSuper || (S.isStaff && d.ownerUid === S.uid) || (S.isStudent && d.studentId === S.me.studentId); },
    create: function (S, id, n) {
      if (!S.isStudent || !keysOnly(n, ['studentId', 'studentUid', 'studentName', 'studentNumber', 'classId', 'className', 'code', 'ownerUid', 'teacherName', 'schoolId', 'joinedAt'])) return false;
      var cc = S.get('classCodes', n.code) || {};
      return n.studentId === S.me.studentId && n.studentUid === S.uid && id === S.me.studentId + '_' + n.classId && n.schoolId === S.sid &&
        tsOf(n.joinedAt) === S.now && cc.classId === n.classId && cc.ownerUid === n.ownerUid && cc.schoolId === S.sid;
    },
    update: function () { return false; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || (S.isStudent && o.studentId === S.me.studentId) || S.isSuper; }
  },
  teacherLinks: {
    read: function (S, d) { return S.isSuper || (S.isStaff && d.ownerUid === S.uid) || (S.isStudent && d.studentId === S.me.studentId); },
    create: function (S, id, n) {
      if (!S.isStudent || !keysOnly(n, ['studentId', 'ownerUid', 'classId', 'schoolId', 'createdAt'])) return false;
      var en = S.get('enrollments', S.me.studentId + '_' + n.classId);
      return n.studentId === S.me.studentId && id === S.me.studentId + '_' + n.ownerUid && n.schoolId === S.sid && tsOf(n.createdAt) === S.now && !!en && en.ownerUid === n.ownerUid;
    },
    update: function () { return false; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || (S.isStudent && o.studentId === S.me.studentId) || S.isSuper; }
  },
  students: {
    read: function (S, d, id) { return S.isSuper || (S.isStaff && S.mayRead(d)) || (S.isAdmin && S.inMySchool(d)) || (S.isRegistrar && S.inMySchool(d)) || (S.isStudent && S.me.studentId === id); },
    create: function (S, id, n) {
      return (S.isStaff && n.ownerUid === S.uid && n.schoolId === S.sid && n.number === id) ||
        (S.isRegistrar && n.schoolId === S.sid && n.number === id && S.validAdviser(n.ownerUid));
    },
    update: function (S, id, o, n) {
      return (S.isStaff && o.ownerUid === S.uid && n.ownerUid === o.ownerUid) ||
        (S.isRegistrar && S.inMySchool(o) && n.schoolId === S.sid && n.number === id && (n.ownerUid === o.ownerUid || S.validAdviser(n.ownerUid))) ||
        (S.isStudent && S.me.studentId === id && jeq(diffKeys(o, n), ['accountUid']) && n.accountUid === S.uid);
    },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper || (S.isRegistrar && S.inMySchool(o) && !('accountUid' in o)); }
  },
  scanResults: {
    read: function (S, d) { return S.isSuper || (S.isStaff && S.mayRead(d)) || (S.isAdmin && S.inMySchool(d)) || (S.isStudent && d.studentId === S.me.studentId); },
    create: function (S, id, n) {
      if (S.isStaff && n.ownerUid === S.uid && n.schoolId === S.sid) return true;
      if (!S.isStudent) return false;
      if (!keysOnly(n, ['ownerUid', 'schoolId', 'examId', 'studentId', 'studentName', 'studentNumber', 'classId', 'className', 'answers', 'correct', 'wrong', 'blank', 'multi', 'pending', 'total', 'points', 'maxPoints', 'pct', 'final', 'pass', 'teacherName', 'examTitle', 'subject', 'term', 'passingPct', 'missedList', 'via', 'startedAt', 'submittedAt', 'scannedAt', 'reviewedFlags'])) return false;
      var sub = S.get('examSubmissions', id) || {}, att = S.get('examAttempts', id) || {};
      return n.via === 'online' && n.studentId === S.me.studentId && id === n.examId + '_' + S.me.studentId && n.schoolId === S.sid &&
        n.ownerUid === sub.ownerUid && jeq(n.answers, sub.answers) && jeq(n.submittedAt, sub.submittedAt) && jeq(n.startedAt, att.startedAt) && tsOf(n.scannedAt) === S.now;
    },
    update: function (S, id, o, n) { return S.isStaff && o.ownerUid === S.uid && n.ownerUid === o.ownerUid; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  },
  modules: {
    read: function (S, d) { return S.isSuper || (S.isStaff && S.mayRead(d)) || S.studentSees(d.ownerUid, d.classId) || S.sentToMe(d); },
    create: function (S, id, n) { return S.isStaff && n.ownerUid === S.uid && (!('studentId' in n) || (isStr(n.studentId) && S.studentRec(n.studentId).schoolId === S.sid)); },
    update: function (S, id, o, n) { return S.isStaff && o.ownerUid === S.uid && n.ownerUid === o.ownerUid; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  },
  moduleChunks: {
    read: function (S, d) {
      if (S.isSuper || (S.isStaff && S.mayRead(d))) return true;
      var m = S.get('modules', d.moduleId); return !!m && (S.studentSees(m.ownerUid, m.classId) || S.sentToMe(m));
    },
    create: function (S, id, n) { return S.isStaff && n.ownerUid === S.uid; },
    update: function (S, id, o, n) { return S.isStaff && o.ownerUid === S.uid && n.ownerUid === o.ownerUid; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  },
  examPapers: {
    read: function (S, d) { return S.isSuper || (S.isStaff && S.mayRead(d)) || (S.isAdmin && S.inMySchool(d)) || (S.studentSees(d.ownerUid, d.classId) && d.open === true); },
    create: function (S, id, n) { return S.isStaff && n.ownerUid === S.uid && n.schoolId === S.sid; },
    update: function (S, id, o, n) { return S.isStaff && o.ownerUid === S.uid && n.ownerUid === o.ownerUid; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  },
  examKeys: {
    read: function (S, d, id) { return S.isSuper || (S.isStaff && S.mayRead(d)) || (S.isStudent && S.exists('examSubmissions', id + '_' + S.me.studentId)); },
    create: function (S, id, n) { return S.isStaff && n.ownerUid === S.uid && n.schoolId === S.sid; },
    update: function (S, id, o, n) { return S.isStaff && o.ownerUid === S.uid && n.ownerUid === o.ownerUid; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  },
  examSubmissions: {
    read: function (S, d) { return S.isSuper || (S.isStaff && S.mayRead(d)) || (S.isStudent && d.studentId === S.me.studentId); },
    create: function (S, id, n) {
      if (!S.isStudent || !keysOnly(n, ['examId', 'studentId', 'studentUid', 'ownerUid', 'schoolId', 'answers', 'submittedAt'])) return false;
      var p = S.get('examPapers', n.examId) || {};
      return n.studentId === S.me.studentId && n.studentUid === S.uid && id === n.examId + '_' + S.me.studentId && n.schoolId === S.sid &&
        tsOf(n.submittedAt) === S.now && Array.isArray(n.answers) && n.answers.length <= 100 && p.open === true && p.ownerUid === n.ownerUid &&
        S.studentSees(n.ownerUid, p.classId) && S.exists('examAttempts', id);
    },
    update: function () { return false; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  },
  examAttempts: {
    read: function (S, d) { return S.isSuper || (S.isStaff && S.mayRead(d)) || (S.isStudent && d.studentId === S.me.studentId); },
    create: function (S, id, n) {
      if (!S.isStudent || !keysOnly(n, ['examId', 'studentId', 'studentUid', 'ownerUid', 'schoolId', 'startedAt'])) return false;
      var p = S.get('examPapers', n.examId) || {};
      return n.studentId === S.me.studentId && n.studentUid === S.uid && id === n.examId + '_' + S.me.studentId && n.schoolId === S.sid &&
        tsOf(n.startedAt) === S.now && p.open === true && p.ownerUid === n.ownerUid && S.studentSees(n.ownerUid, p.classId);
    },
    update: function () { return false; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  },
  classes: {   // registrar-made sections, or the teacher's own
    read: function (S, d) { return (S.isRegistrar && S.inMySchool(d)) || S.isSuper || (S.isStaff && S.mayRead(d)) || (S.isAdmin && S.inMySchool(d)); },
    create: function (S, id, n) { return (S.isRegistrar && n.schoolId === S.sid && S.validAdviser(n.ownerUid)) || (S.isStaff && n.ownerUid === S.uid && n.schoolId === S.sid); },
    update: function (S, id, o, n) { return (S.isRegistrar && S.inMySchool(o) && n.schoolId === S.sid && S.validAdviser(n.ownerUid)) || (S.isStaff && o.ownerUid === S.uid && n.ownerUid === o.ownerUid); },
    del: function (S, id, o) { return (S.isRegistrar && S.inMySchool(o)) || (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  },
  registry: {
    read: function (S, d) { return ((S.isRegistrar || S.isAdmin || S.isFinance || S.isCustodian || S.isGuidance) && S.inMySchool(d)) || S.isSuper; },
    create: function (S, id, n) { return S.isRegistrar && n.schoolId === S.sid && n.createdBy === S.uid; },
    update: function (S, id, o, n) { return S.isRegistrar && S.inMySchool(o) && n.schoolId === S.sid; },
    del: function (S, id, o) { return (S.isRegistrar && S.inMySchool(o)) || S.isSuper; }
  },
  enrollmentRecords: {
    read: function (S, d) { return ((S.isRegistrar || S.isAdmin || S.isFinance || S.isCustodian || S.isGuidance) && S.inMySchool(d)) || S.isSuper; },
    create: function (S, id, n) { return S.isRegistrar && n.schoolId === S.sid && S.validAdviser(n.adviserUid); },
    update: function (S, id, o, n) { return S.isRegistrar && S.inMySchool(o) && n.schoolId === S.sid && S.validAdviser(n.adviserUid); },
    del: function (S, id, o) { return (S.isRegistrar && S.inMySchool(o)) || S.isSuper; }
  },
  registrarSettings: {
    read: function (S, d, id) { return ((S.isRegistrar || S.isAdmin || S.isFinance) && id === S.sid) || S.isSuper; },
    create: function (S, id, n) { return S.isRegistrar && id === S.sid && n.schoolId === S.sid; },
    update: function (S, id, o, n) { return S.isRegistrar && id === S.sid && n.schoolId === S.sid; },
    del: function (S) { return S.isSuper; }
  },
  registrarLog: {
    read: function (S, d) { return ((S.isRegistrar || S.isAdmin) && S.inMySchool(d)) || S.isSuper; },
    create: function (S, id, n) { return S.isRegistrar && n.schoolId === S.sid && n.byUid === S.uid; },
    update: function () { return false; },
    del: function (S) { return S.isSuper; }
  },
  payments: {
    read: function (S, d) { return ((S.isFinance || S.isAdmin) && S.inMySchool(d)) || S.isSuper || (S.isStudent && d.studentId === S.me.studentId); },
    create: function (S, id, n) { return S.isFinance && n.schoolId === S.sid && n.createdBy === S.uid && typeof n.amount === 'number' && n.amount > 0; },
    update: function (S, id, o, n) { return S.isFinance && S.inMySchool(o) && n.schoolId === S.sid && subset(diffKeys(o, n), ['status', 'voidReason', 'voidedAt', 'voidedBy', 'voidedByName']); },
    del: function (S) { return S.isSuper; }
  },
  studentAccounts: {
    read: function (S, d) { return ((S.isFinance || S.isAdmin) && S.inMySchool(d)) || S.isSuper || (S.isStudent && d.studentId === S.me.studentId); },
    create: function (S, id, n) { return S.isFinance && n.schoolId === S.sid; },
    update: function (S, id, o, n) { return S.isFinance && S.inMySchool(o) && n.schoolId === S.sid; },
    del: function (S, id, o) { return (S.isFinance && S.inMySchool(o)) || S.isSuper; }
  },
  financeSettings: {
    read: function (S, d, id) { return ((S.isFinance || S.isAdmin) && id === S.sid) || S.isSuper; },
    create: function (S, id, n) { return S.isFinance && id === S.sid && n.schoolId === S.sid; },
    update: function (S, id, o, n) { return S.isFinance && id === S.sid && n.schoolId === S.sid; },
    del: function (S) { return S.isSuper; }
  },
  financeLog: {
    read: function (S, d) { return ((S.isFinance || S.isAdmin) && S.inMySchool(d)) || S.isSuper; },
    create: function (S, id, n) { return S.isFinance && n.schoolId === S.sid && n.byUid === S.uid; },
    update: function () { return false; },
    del: function (S) { return S.isSuper; }
  }
};

/* ---- Custodian (uniforms, P.E. uniforms, IDs ...) and Guidance (health + guidance records): each sees only their own school's records ---- */
function ownRoleRules(flag) {
  return {
    read: function (S, d) { return (S[flag] && S.inMySchool(d)) || S.isSuper; },
    create: function (S, id, n) { return S[flag] && n.schoolId === S.sid && n.createdBy === S.uid; },
    update: function (S, id, o, n) { return S[flag] && S.inMySchool(o) && n.schoolId === S.sid; },
    del: function (S, id, o) { return (S[flag] && S.inMySchool(o)) || S.isSuper; }
  };
}
function ownRoleSettings(flag) {
  return {
    read: function (S, d, id) { return (S[flag] && id === S.sid) || S.isSuper; },
    create: function (S, id, n) { return S[flag] && id === S.sid && n.schoolId === S.sid; },
    update: function (S, id, o, n) { return S[flag] && id === S.sid && n.schoolId === S.sid; },
    del: function (S) { return S.isSuper; }
  };
}
function ownRoleLog(flag) {
  return {
    read: function (S, d) { return (S[flag] && S.inMySchool(d)) || S.isSuper; },
    create: function (S, id, n) { return S[flag] && n.schoolId === S.sid && n.byUid === S.uid; },
    update: function () { return false; },
    del: function (S) { return S.isSuper; }
  };
}
/* ---- Finance - Payroll: pay information per employee, payroll settings, payroll runs and payslips. Only the Payroll account of the school reads or writes them. ---- */
RULES.payrollSettings = ownRoleSettings('isPayroll'); RULES.payrollInfo = ownRoleRules('isPayroll'); RULES.payrollRuns = ownRoleRules('isPayroll'); RULES.payslips = ownRoleRules('isPayroll'); RULES.payrollDtr = ownRoleRules('isPayroll');   // payrollDtr = the Daily Time Record made from the biometric file (one document per employee per month)
RULES.custodianRecords = ownRoleRules('isCustodian'); RULES.custodianSettings = ownRoleSettings('isCustodian'); RULES.custodianLog = ownRoleLog('isCustodian');
RULES.healthRecords = ownRoleRules('isGuidance'); RULES.guidanceRecords = ownRoleRules('isGuidance');
RULES.guidanceSettings = ownRoleSettings('isGuidance'); RULES.guidanceLog = ownRoleLog('isGuidance');
/* ---- HR: the employee records of the school. Only HR reads / writes them (the IT Admin sees just name, birthday and position through the `hrCandidates` action).
   The link to a login (accountUid / accountRole) is written by the server only, never by the browser. ---- */
var ACCT_FIELDS = ['accountUid', 'accountRole', 'accountCreatedAt'];
function sameAcct(a, b) { return ACCT_FIELDS.every(function (k) { return jeq(a[k], b[k]); }); }
function photoOk(n) { return !('photo' in n) || n.photo === '' || (isStr(n.photo) && n.photo.length <= 19000 && n.photo.indexOf('data:image/') === 0); }
/* HR and the IT Admin both register and edit employees (the IT Admin may also fill in the full record, not only the account details). */
RULES.employees = {
  read: function (S, d) { return ((S.isHR || S.isAdmin || S.isPayroll) && S.inMySchool(d)) || S.isSuper; },   // Payroll reads the employee records (read only)
  create: function (S, id, n) { return (S.isHR || S.isAdmin) && n.schoolId === S.sid && n.createdBy === S.uid && !n.accountUid && id === staffKey(S.sid, n.employeeId) && photoOk(n); },
  update: function (S, id, o, n) { return (S.isHR || S.isAdmin) && S.inMySchool(o) && n.schoolId === S.sid && n.employeeId === o.employeeId && sameAcct(o, n) && photoOk(n); },
  del: function (S, id, o) { return ((S.isHR || S.isAdmin) && S.inMySchool(o) && !o.accountUid) || S.isSuper; }
};
RULES.hrSettings = ownRoleSettings('isHR'); RULES.hrLog = ownRoleLog('isHR');
/* the IT Admin's registrations are written to HR's history too (HR reads them, the IT Admin only adds lines) */
RULES.hrLog.create = function (S, id, n) { return (S.isHR || S.isAdmin) && n.schoolId === S.sid && n.byUid === S.uid; };
/* every employee account may READ HR's settings (it holds only the leave types and drop-down lists); only HR writes them */
RULES.hrSettings.read = function (S, d, id) { return ((S.isHR || (S.live && LEAVE_ROLES.indexOf(S.me.role) >= 0)) && id === S.sid) || S.isSuper; };

/* ---- Leave requests: every employee account (teacher, registrar, finance, custodian, guidance, HR and the IT Admin) files a request to HR.
   The filer reads / cancels only their own; HR of the same school reads all and decides (never on their own request). ---- */
function leaveFiler(S) { return S.live && LEAVE_ROLES.indexOf(S.me.role) >= 0; }
function isYmd(v) { return isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v); }
RULES.leaveRequests = {
  read: function (S, d) { return S.isSuper || (S.isHR && S.inMySchool(d)) || (S.isPayroll && S.inMySchool(d) && d.status === 'Approved') || (leaveFiler(S) && d.requesterUid === S.uid); },   // Payroll sees approved leave (unpaid days)
  create: function (S, id, n) {
    var okBody = isStr(n.leaveType) && n.leaveType.length > 0 && n.leaveType.length <= 60 && isYmd(n.startDate) && isYmd(n.endDate) && n.endDate >= n.startDate &&
      +n.days > 0 && +n.days <= 366 && (!('reason' in n) || (isStr(n.reason) && n.reason.length <= 1000)) && n.schoolId === S.sid;
    if (!okBody) return false;
    if (leaveFiler(S) && n.requesterUid === S.uid && n.status === 'Pending' && !n.decidedBy) return true;           // my own request
    // HR files a leave for an employee (also one without an account); it can be approved at once
    return S.isHR && n.filedBy === S.uid && isStr(n.requesterName) && (n.status === 'Pending' || (n.status === 'Approved' && n.decidedBy === S.uid));
  },
  update: function (S, id, o, n) {
    var df = diffKeys(o, n);
    if (S.isHR && S.inMySchool(o) && n.schoolId === S.sid && subset(df, ['status', 'hrRemarks', 'decidedBy', 'decidedByName', 'decidedAt', 'updatedAt']) &&
        ['Pending', 'Approved', 'Rejected', 'Cancelled'].indexOf(n.status) >= 0) return true;
    return leaveFiler(S) && o.requesterUid === S.uid && o.status === 'Pending' && subset(df, ['status', 'updatedAt']) && n.status === 'Cancelled';
  },
  del: function (S, id, o) { return S.isSuper || (S.isHR && S.inMySchool(o)) || (leaveFiler(S) && o.requesterUid === S.uid && o.status !== 'Approved'); }
};
/* ---- Class schedules (made by the Registrar). Teachers and students only read what the Registrar has SENT (semester.published === true):
   a teacher reads the entries that name him / her, a student reads the entries of his / her own section. ---- */
var SCHED_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function isHm(v) { return isStr(v) && /^\d{2}:\d{2}$/.test(v); }
function schedSem(S, id) { S._sem = S._sem || {}; if (!(id in S._sem)) S._sem[id] = (isStr(id) && id) ? (getDoc('scheduleSemesters', id) || null) : null; return S._sem[id]; }
function schedSent(S, d) { var sm = schedSem(S, d.semesterId); return !!sm && sm.schoolId === S.sid && sm.published === true; }
function schedBody(S, n) {
  var sm = schedSem(S, n.semesterId);
  return !!sm && sm.schoolId === S.sid && isStr(n.subject) && n.subject.length > 0 && n.subject.length <= 80 && isStr(n.sectionId) && n.sectionId.length > 0 &&
    SCHED_DAYS.indexOf(n.day) >= 0 && isHm(n.start) && isHm(n.end) && n.end > n.start && (!('room' in n) || (isStr(n.room) && n.room.length <= 60)) &&
    (!('teacherName' in n) || (isStr(n.teacherName) && n.teacherName.length <= 120));
}
RULES.scheduleSemesters = {
  read: function (S, d) { return S.isSuper || ((S.isRegistrar || S.isAdmin) && S.inMySchool(d)) || ((S.isTeacher || S.isStudent) && S.inMySchool(d) && d.published === true); },
  create: function (S, id, n) { return S.isRegistrar && n.schoolId === S.sid && isStr(n.name) && n.name.length > 0 && n.name.length <= 80 && n.published !== true; },
  update: function (S, id, o, n) { return S.isRegistrar && S.inMySchool(o) && n.schoolId === S.sid && isStr(n.name) && n.name.length > 0 && n.name.length <= 80; },
  del: function (S, id, o) { return (S.isRegistrar && S.inMySchool(o)) || S.isSuper; }
};
RULES.classSchedules = {
  read: function (S, d) {
    if (S.isSuper || ((S.isRegistrar || S.isAdmin) && S.inMySchool(d))) return true;
    if (!S.inMySchool(d)) return false;
    if (S.isTeacher) return d.teacherUid === S.uid && schedSent(S, d);
    if (S.isStudent) return !!d.sectionId && d.sectionId === S.myStudent().classId && schedSent(S, d);
    return false;
  },
  create: function (S, id, n) { return S.isRegistrar && n.schoolId === S.sid && schedBody(S, n); },
  update: function (S, id, o, n) { return S.isRegistrar && S.inMySchool(o) && n.schoolId === S.sid && schedBody(S, n); },
  del: function (S, id, o) { return (S.isRegistrar && S.inMySchool(o)) || S.isSuper; }
};
RULES.scheduleSettings = {   // the Registrar's own lists (subjects, rooms) and the daily hour limit
  read: function (S, d, id) { return ((S.isRegistrar || S.isAdmin) && id === S.sid) || S.isSuper; },
  create: function (S, id, n) { return S.isRegistrar && id === S.sid && n.schoolId === S.sid; },
  update: function (S, id, o, n) { return S.isRegistrar && id === S.sid && n.schoolId === S.sid; },
  del: function (S) { return S.isSuper; }
};
['examinations', 'answerKeys', 'answerSheets'].forEach(function (c) {
  RULES[c] = {
    read: function (S, d) { return S.isSuper || (S.isStaff && S.mayRead(d)) || (S.isAdmin && S.inMySchool(d)); },
    create: function (S, id, n) { return S.isStaff && n.ownerUid === S.uid && n.schoolId === S.sid; },
    update: function (S, id, o, n) { return S.isStaff && o.ownerUid === S.uid && n.ownerUid === o.ownerUid; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  };
});
/* ---- School Admin: READ-ONLY. May read the data behind every department's dashboards and reports (registrar, finance, payroll, HR, custodian, guidance)
   for their own school, and nothing else. No create / update / delete rule is touched, so the School Admin can never change a record here. ---- */
var SCHOOL_ADMIN_READ = ['registry', 'enrollmentRecords', 'registrarSettings', 'registrarLog', 'students', 'classes', 'scheduleSemesters', 'classSchedules', 'scheduleSettings',
  'payments', 'studentAccounts', 'financeSettings', 'financeLog', 'custodianRecords', 'custodianSettings', 'custodianLog', 'healthRecords', 'guidanceRecords', 'guidanceSettings', 'guidanceLog',
  'employees', 'hrSettings', 'hrLog', 'leaveRequests', 'payrollSettings', 'payrollInfo', 'payrollRuns', 'payslips', 'payrollDtr', 'users'];
SCHOOL_ADMIN_READ.forEach(function (c) {
  var old = RULES[c].read;
  RULES[c].read = function (S, d, id, mode) {
    if (S.isSchoolAdmin && ((d && d.schoolId === S.sid) || (isStr(id) && id === S.sid))) return true;
    return old(S, d, id, mode);
  };
});
function rulesOf(coll) { if (KNOWN.indexOf(coll) < 0) deny(); return RULES[coll]; }

/* ============================== reading and writing documents ============================== */
function resolveSV(v, now) {
  if (Array.isArray(v)) return v.map(function (x) { return resolveSV(x, now); });
  if (v && typeof v === 'object') {
    if (v.__sv === 'ts') return { __ts: now };
    var o = {}; for (var k in v) o[k] = resolveSV(v[k], now); return o;
  }
  return v;
}
function opGet(S, p) {
  var rules = rulesOf(p.coll), d = getDoc(p.coll, p.id);
  if (!d) { if (!S.live && !(S.hasProfile && p.coll === 'users' && p.id === S.uid)) deny(); return { exists: false }; }
  if (!rules.read(S, d, p.id, 'get')) deny();
  return { exists: true, data: d };
}
function matchWhere(d, w) {
  var x = getPath(d, w[0]), op = w[1], v = w[2];
  x = tsOf(x);
  switch (op) {
    case '==': return jeq(x, v);
    case '!=': return !jeq(x, v);
    case '<': return x < v; case '<=': return x <= v; case '>': return x > v; case '>=': return x >= v;
    case 'in': return Array.isArray(v) && v.some(function (y) { return jeq(x, y); });
    case 'array-contains': return Array.isArray(x) && x.some(function (y) { return jeq(y, v); });
    case 'array-contains-any': return Array.isArray(x) && Array.isArray(v) && x.some(function (y) { return v.some(function (z) { return jeq(y, z); }); });
    case 'not-in': return Array.isArray(v) && !v.some(function (y) { return jeq(x, y); });
  }
  return false;
}
function listDocs(S, p) {
  var rules = rulesOf(p.coll), wheres = p.wheres || [], eq = {};
  wheres.forEach(function (w) {   // use the indexed columns to skip most rows without parsing them
    if (['schoolId', 'ownerUid', 'studentId'].indexOf(w[0]) >= 0) {
      if (w[1] === '==') eq[w[0]] = [String(w[2])]; else if (w[1] === 'in' && Array.isArray(w[2])) eq[w[0]] = w[2].map(String);
    }
  });
  var s = scan(p.coll, eq), t = s.t, hits = s.hits, ids = colOf(t, 0);
  if (hits.length > 12 && t.c[4] === undefined) colOf(t, 4);   // many rows: one column read is cheaper than many cell reads
  var out = [];
  for (var h = 0; h < hits.length; h++) {
    var d = unpack(cellJson(t, hits[h].i));
    if (!wheres.every(function (w) { return matchWhere(d, w); })) continue;
    if (!rules.read(S, d, ids[hits[h].i], 'list')) continue;
    if (p.coll === 'users' && d.photo && ids[hits[h].i] !== S.uid) delete d.photo;   // keeps account lists small
    out.push({ id: ids[hits[h].i], data: d });
  }
  (p.orders || []).slice().reverse().forEach(function (o) {
    out.sort(function (a, b) {
      var x = tsOf(getPath(a.data, o[0])), y = tsOf(getPath(b.data, o[0]));
      var c = x < y ? -1 : x > y ? 1 : 0; return o[1] === 'desc' ? -c : c;
    });
  });
  return out;
}
function opList(S, p) { var out = listDocs(S, p); if (p.limit) out = out.slice(0, p.limit); return { docs: out }; }
function opCount(S, p) { return { count: listDocs(S, p).length }; }

function applyWrite(S, op) {
  var coll = op.coll, id = op.id, rules = rulesOf(coll);
  if (!isStr(id) || !id || id.indexOf('/') >= 0) fail('invalid-argument', 'Bad document id.');
  var cur = getDoc(coll, id), data;
  if (op.op === 'delete') {
    if (!cur) return;
    if (!rules.del(S, id, cur)) deny();
    delDoc(coll, id);
    if (coll === 'users') { var t = T(AUTH_TAB); tDel(t, id); S.touched.push(id); }
    return;
  }
  if (op.op === 'set' && !op.merge) data = resolveSV(op.data, S.now);
  else {
    if (!cur) { if (op.op === 'update') fail('not-found', 'No document to update.'); cur = null; }
    data = JSON.parse(JSON.stringify(cur || {}));
    for (var k in op.data) {
      var v = op.data[k];
      if (v && typeof v === 'object' && v.__sv === 'del') delete data[k]; else data[k] = resolveSV(v, S.now);
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('invalid-argument', 'Bad data.');
  var existing = cur;
  if (!existing) { if (!rules.create(S, id, data)) deny(); }
  else if (!rules.update(S, id, existing, data)) deny();
  putDoc(coll, id, data);
  if (coll === 'employees' && data.accountUid) syncEmpToUser(S, data);
  if (coll === 'users' || coll === 'schools') S.touched.push(coll === 'users' ? id : '*');
}
/** The photo / position / department HR keeps are copied onto the person's login, so their own page can show them beside their name. */
function syncEmpToUser(S, e) {
  var u = getDoc('users', e.accountUid); if (!u || u.schoolId !== e.schoolId) return;
  ['photo', 'position', 'department'].forEach(function (k) { if (e[k]) u[k] = e[k]; else delete u[k]; });
  putDoc('users', e.accountUid, u); S.touched.push(e.accountUid);
}
/* ---- live updates: every save notes the time on the collections it touched (kept in the script cache, one small key per school + collection).
   Every open page asks "poll" every few seconds; when a number changed, that page reloads the lists it shows. ---- */
function verKey(sid, coll) { return 'v:' + (sid || '-') + ':' + coll; }
function bumpVersions(sid, colls) {
  var t = nowMs(), out = {};
  try { var c = CacheService.getScriptCache(), o = {}; colls.forEach(function (k) { o[verKey(sid, k)] = String(t); out[k] = t; }); c.putAll(o, 21600); } catch (e) { }
  return out;
}
function pollVersions(actor) {
  var sid = actor.me.schoolId || '', keys = KNOWN.map(function (k) { return verKey(sid, k); }), got = {}, out = {};
  try { got = CacheService.getScriptCache().getAll(keys); } catch (e) { }
  KNOWN.forEach(function (k) { var v = got[verKey(sid, k)]; if (v) out[k] = +v; });
  return { v: out, now: nowMs() };
}
function commit(actor, ops) {
  var S = makeS(actor); S.touched = [];
  try { ops.forEach(function (op) { applyWrite(S, op); }); flushAll(); }
  catch (e) { rollback(); throw e; }
  S.touched.forEach(function (u) { if (u !== '*') dropActor(u); });
  if (S.touched.indexOf('*') >= 0) bumpEpoch();
  var seen = {}; ops.forEach(function (o) { seen[o.coll] = 1; }); var vv = bumpVersions(actor.me.schoolId, Object.keys(seen));
  return { ok: true, v: vv };
}

/* ============================== actions ============================== */
function meInfo(actor) {
  var sc = actor.me.schoolId ? getDoc('schools', actor.me.schoolId) : null;
  return { profile: actor.me, school: sc ? Object.assign({ id: actor.me.schoolId }, sc) : null };
}
function logAudit(actorUid, schoolId, action, targetUid, details) {
  putDoc('auditLogs', newId(), { actorUid: actorUid, schoolId: schoolId || '', action: action, targetUid: targetUid || '', details: details || {}, createdAt: { __ts: nowMs() } });
}
function loginKeyFor(p) {
  var who = String(p.who || '').trim();
  if (!who) fail('auth/invalid-credential', 'Enter your username and password.');
  return who.indexOf('@') >= 0 ? who.toLowerCase() : (String(p.school || '').trim() ? staffKey(p.school, who) : studentKey(who));
}
function actLogin(p) {
  var key = loginKeyFor(p), pw = normPw(p.password), a = authFindByKey(key);
  if (!a) fail('auth/invalid-credential');
  if (+a.lockUntil > nowMs()) fail('auth/too-many-requests');
  var ok = same(hashPw(pw, a.salt), a.hash);
  if (!ok) {
    var lock = LockService.getScriptLock(); lock.waitLock(20000);
    try {
      a = authRow(a.uid); a.fails = String(+a.fails + 1);
      if (+a.fails >= MAX_FAILS) { a.lockUntil = String(nowMs() + LOCK_MS); a.fails = '0'; }
      authPut(a); flushAll();
    } finally { lock.releaseLock(); }
    fail('auth/invalid-credential');
  }
  if (+a.fails > 0) {
    var lk = LockService.getScriptLock(); lk.waitLock(20000);
    try { a = authRow(a.uid); a.fails = '0'; a.lockUntil = '0'; authPut(a); flushAll(); } finally { lk.releaseLock(); }
  }
  var me = getDoc('users', a.uid); if (!me) fail('auth/invalid-credential');
  var tk = makeToken(a.uid, a.ver), sc = me.schoolId ? getDoc('schools', me.schoolId) : null;
  return { token: tk.token, exp: tk.exp, uid: a.uid, profile: me, school: sc ? Object.assign({ id: me.schoolId }, sc) : null };
}
function actChangePassword(actor, p) {
  var role = actor.me.role, pw = String(p.newPassword || '');
  var min = role === 'student' ? 8 : 10;
  if (pw.length < min || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) fail('auth/weak-password', 'Use at least ' + min + ' characters with a letter and a number.');
  var a = authSetPassword(actor.uid, pw), me = getDoc('users', actor.uid);
  me.mustChangePassword = false; me.passwordChangedAt = { __ts: nowMs() };
  putDoc('users', actor.uid, me); flushAll(); dropActor(actor.uid);
  var tk = makeToken(actor.uid, a.ver);
  return { token: tk.token, exp: tk.exp };
}
function siteUrl() { var u = prop('SITE_URL') || ''; return u.replace(/\/+$/, ''); }
function sendResetMail(uid, email, name) {
  var a = authRow(uid); if (!a) return;
  var raw = newId() + newId(); a.resetHash = sha(raw); a.resetExp = String(nowMs() + RESET_MS); authPut(a); flushAll();
  var base = siteUrl(); if (!base) fail('failed-precondition', 'The website address is not set (menu ARK Portal > Set website address).');
  var link = base + '/login?reset=' + raw + '&u=' + uid;
  MailApp.sendEmail({ to: email, subject: 'Reset your Exam Portal password', name: 'Exam Portal',
    body: 'Hello ' + (name || '') + ',\n\nOpen this link to choose a new password (valid for 1 hour):\n' + link + '\n\nIf you did not ask for this, ignore this email.' });
}
function actResetRequest(p) {
  var who = String(p.who || '').trim(); if (!who) return { result: 'noemail' };
  var a = authFindByKey(loginKeyFor(p)); if (!a) return { result: 'noemail' };
  var me = getDoc('users', a.uid);
  if (!me || me.status !== 'active' || !me.hasRealEmail || !isEmail(me.email)) return { result: 'noemail' };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { sendResetMail(a.uid, me.email, me.displayName); } finally { lock.releaseLock(); }
  return { result: 'sent' };
}
function actResetConfirm(p) {
  var a = authRow(String(p.uid || '')), pw = String(p.password || '');
  if (!a || !a.resetHash || +a.resetExp < nowMs() || !same(sha(String(p.token || '')), a.resetHash)) fail('invalid-argument', 'This reset link is invalid or has expired. Ask for a new one.');
  var me = getDoc('users', a.uid); if (!me) fail('invalid-argument', 'Account not found.');
  var min = me.role === 'student' ? 8 : 10;
  if (pw.length < min || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) fail('auth/weak-password', 'Use at least ' + min + ' characters with a letter and a number.');
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    authSetPassword(a.uid, pw); me.mustChangePassword = false; me.passwordChangedAt = { __ts: nowMs() }; putDoc('users', a.uid, me); flushAll(); dropActor(a.uid);
  } finally { lock.releaseLock(); }
  return { ok: true };
}

/* ---- create an account (Super Admin -> IT Admin; IT Admin -> teacher / registrar / finance; staff -> own student) ---- */
function actCreateAccount(actor, p) {
  var S = makeS(actor), role = String(p.role || ''), now = S.now, me = actor.me, doc, keys = [], pw, school = null, empDoc = null, newEmp = false;
  var real = isEmail(p.realEmail) ? String(p.realEmail).trim().toLowerCase() : '';
  if (role === 'admin') {
    if (!S.isSuper) deny();
    var sp = p.school || {}, code = String(sp.code || '').toUpperCase(), name = String(sp.name || '').trim();
    if (!/^[A-Z0-9-]{3,20}$/.test(code) || name.length < 3) fail('invalid-argument', 'Enter a school name and a code (3-20 letters, numbers or hyphens).');
    if (getDoc('schools', code)) fail('invalid-argument', 'That school code is already used. Choose another.');
    var email = String(p.email || '').trim().toLowerCase(); if (!isEmail(email)) fail('auth/invalid-email');
    pw = String(p.password || ''); if (!strongEnough('admin', pw)) fail('auth/weak-password');
    keys = [email];
    doc = { uid: '', role: 'admin', displayName: String(p.displayName || '').trim(), email: email, schoolId: code, schoolName: name, status: 'active', mustChangePassword: true, createdAt: { __ts: now }, createdBy: actor.uid };
    school = { name: name, code: code, adminEmail: email, status: 'active', createdAt: { __ts: now }, createdBy: actor.uid };
  } else if (EMP_ROLES.indexOf(role) >= 0) {
    if (!S.isAdmin) deny();
    var sc = getDoc('schools', S.sid) || {}, empKey = String(p.employeeKey || ''), emp;
    empDoc = empKey ? getDoc('employees', empKey) : null;
    if (empDoc && empDoc.schoolId !== S.sid) empDoc = null;
    if (!empDoc && role === 'hr') {
      // The very first HR account: nobody can add the HR employee yet, so the IT Admin types it here and the record is made for them.
      emp = String(p.employeeId || '').trim(); if (!emp) fail('invalid-argument', 'Enter the Employee No.');
      empKey = staffKey(S.sid, emp); if (getDoc('employees', empKey)) fail('auth/email-already-in-use', 'That Employee No. is already in the HR list. Choose it from the list instead.');
      empDoc = { schoolId: S.sid, employeeId: emp, lastName: String(p.lastName || '').trim(), firstName: String(p.firstName || '').trim(), middleInitial: String(p.middleInitial || '').slice(0, 1),
        birthday: String(p.birthday || ''), position: 'HR', status: 'Active', accessType: 'hr', createdBy: actor.uid, createdAt: { __ts: now } };
      newEmp = true;
    }
    if (!empDoc) fail('failed-precondition', 'HR must add this employee first. Ask HR to add them, then choose them from the list.');
    if (empDoc.accountUid) fail('auth/email-already-in-use', 'That employee already has an account.');
    if (empDoc.status && empDoc.status !== 'Active') fail('failed-precondition', 'That employee is not active in the HR records.');
    emp = empDoc.employeeId;
    pw = defaultPassword(empDoc.lastName, empDoc.birthday); if (!pw) fail('invalid-argument', 'HR must save the birthday and last name of this employee first.');
    if (!real && isEmail(empDoc.email)) real = String(empDoc.email).trim().toLowerCase();
    keys = [staffKey(S.sid, emp)]; if (real) keys.push(real);
    doc = { uid: '', role: role, displayName: fullName(empDoc), lastName: empDoc.lastName, firstName: empDoc.firstName, middleInitial: String(empDoc.middleInitial || '').slice(0, 1),
      email: real || String(p.email || ''), employeeId: emp, birthday: empDoc.birthday, schoolId: S.sid, schoolName: sc.name || '', status: 'active', mustChangePassword: true, createdAt: { __ts: now }, createdBy: actor.uid };
    ['photo', 'position', 'department'].forEach(function (k) { if (empDoc[k]) doc[k] = empDoc[k]; });
    if (real) doc.hasRealEmail = true;
  } else if (role === 'student') {
    if (!S.isStaff) deny();
    var st = getDoc('students', String(p.studentId || ''));
    if (!st || st.ownerUid !== actor.uid || st.schoolId !== S.sid) deny();
    if (st.accountUid) fail('auth/email-already-in-use', 'That student already has an account.');
    pw = defaultPassword(st.lastName, st.birthday); if (!pw) fail('invalid-argument', 'Add the birthday and last name first.');
    keys = [studentKey(st.number)]; if (real) keys.push(real);
    doc = { uid: '', role: 'student', displayName: st.name, email: real || String(p.email || ''), studentId: st.number, birthday: st.birthday, schoolId: S.sid, schoolName: me.schoolName || '', status: 'active', mustChangePassword: true, createdAt: { __ts: now }, createdBy: actor.uid };
    if (real) doc.hasRealEmail = true;
  } else fail('invalid-argument', 'Unknown account type: ' + role);
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    if (role === 'admin' && getDoc('schools', school.code)) fail('invalid-argument', 'That school code is already used. Choose another.');
    keys.forEach(function (k) { if (authFindByKey(k)) fail('auth/email-already-in-use', 'That account already exists (same school code and Employee No., or same email).'); });
    var uid = newId(); doc.uid = uid;
    if (school) putDoc('schools', school.code, school);
    putDoc('users', uid, doc);
    authCreate(uid, keys, pw);
    if (role === 'student') { var s2 = getDoc('students', doc.studentId); s2.accountUid = uid; if (real) s2.email = real; putDoc('students', doc.studentId, s2); }
    if (empDoc) {   // tie the login to the HR record
      empDoc.accountUid = uid; empDoc.accountRole = role; empDoc.accountCreatedAt = { __ts: now }; empDoc.updatedAt = { __ts: now };
      putDoc('employees', empKey, empDoc);
    }
    logAudit(actor.uid, doc.schoolId, role + '.create', uid, { username: doc.employeeId || doc.studentId || doc.email });
    flushAll();
    if (empDoc) mirrorOps([{ op: 'set', coll: 'employees', id: empKey }]);
    return { uid: uid, password: pw };
  } catch (e) { rollback(); throw e; } finally { lock.releaseLock(); }
}
function fullName(e) { return String(e.lastName || '') + ', ' + String(e.firstName || '') + (e.middleInitial ? ' ' + e.middleInitial + '.' : ''); }
/** IT Admin: the employees HR has added who do not have a login yet. Only what is needed to make the login is returned (no ID numbers, address ...). */
function actHrCandidates(actor) {
  var S = makeS(actor); if (!S.isAdmin) deny();
  var s = scan('employees', { schoolId: [S.sid] }), t = s.t, ids = colOf(t, 0), out = [];
  if (s.hits.length > 12) colOf(t, 4);
  s.hits.forEach(function (h) {
    var d = unpack(cellJson(t, h.i));
    if (d.accountUid || (d.status && d.status !== 'Active')) return;
    out.push({ key: ids[h.i], employeeId: d.employeeId, lastName: d.lastName, firstName: d.firstName, middleInitial: d.middleInitial || '', birthday: d.birthday || '',
      position: d.position || '', department: d.department || '', accessType: d.accessType || '', email: isEmail(d.email) ? d.email : '' });
  });
  out.sort(function (a, b) { return String(a.lastName).localeCompare(String(b.lastName)) || String(a.firstName).localeCompare(String(b.firstName)); });
  return { employees: out };
}
/** HR, once: makes an HR record for every teacher / registrar / finance / custodian / guidance / HR login the IT Admin created BEFORE the HR page existed. */
function actHrSyncAccounts(actor) {
  var S = makeS(actor); if (!S.isHR) deny();
  var lock = LockService.getScriptLock(), added = []; lock.waitLock(25000);
  try {
    var us = scan('users', { schoolId: [S.sid] }), uids = colOf(us.t, 0), now = nowMs();
    if (us.hits.length > 12) colOf(us.t, 4);
    us.hits.forEach(function (h) {
      var u = unpack(cellJson(us.t, h.i)); if (EMP_ROLES.indexOf(u.role) < 0 || !u.employeeId) return;
      var key = staffKey(S.sid, u.employeeId); if (getDoc('employees', key)) return;
      var nm = String(u.displayName || '').split(',');
      putDoc('employees', key, { schoolId: S.sid, employeeId: u.employeeId, lastName: u.lastName || nm[0].trim(), firstName: u.firstName || (nm[1] || '').trim(), middleInitial: u.middleInitial || '',
        birthday: u.birthday || '', email: u.hasRealEmail ? u.email : '', position: u.role === 'teacher' ? 'Teacher' : (REC_ROLE_NAME[u.role] || u.role.charAt(0).toUpperCase() + u.role.slice(1)), status: 'Active', accessType: u.role,
        accountUid: uids[h.i], accountRole: u.role, accountCreatedAt: u.createdAt || { __ts: now }, createdBy: actor.uid, createdAt: { __ts: now } });
      added.push(key);
    });
    flushAll();
  } catch (e) { rollback(); throw e; } finally { lock.releaseLock(); }
  if (added.length) mirrorOps(added.map(function (k) { return { op: 'set', coll: 'employees', id: k }; }));
  return { added: added.length };
}
function canManage(actor, t) {
  var me = actor.me;
  if (me.role === 'superadmin') return t.role === 'admin';
  if (me.role === 'admin') return MANAGED_ROLES.indexOf(t.role) >= 0 && t.schoolId === me.schoolId;
  return false;
}
function actSetPassword(actor, p) {
  var S = makeS(actor); if (!S.isSuper && !S.isAdmin) deny();
  var t = getDoc('users', String(p.uid || '')); if (!t || ['admin'].concat(MANAGED_ROLES).indexOf(t.role) < 0) fail('not-found', 'That account was not found.');
  if (!canManage(actor, t)) fail('permission-denied', 'You cannot reset that account.');
  var pw = p.password;
  if (p.useDefault) {
    var st = t.role === 'student' ? (getDoc('students', t.studentId) || {}) : t;
    pw = defaultPassword(st.lastName || String(t.displayName || '').split(',')[0], st.birthday || t.birthday);
    if (!pw) fail('failed-precondition', 'This account needs a birthday and last name first.');
  } else if (!strongEnough(t.role, pw)) fail('auth/weak-password', 'The password is too weak.');
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    authSetPassword(t.uid, pw); t.mustChangePassword = true; t.passwordResetAt = { __ts: nowMs() }; t.updatedAt = { __ts: nowMs() };
    putDoc('users', t.uid, t); logAudit(actor.uid, t.schoolId || actor.me.schoolId, t.role + '.temp_password_set', t.uid, { username: t.employeeId || t.studentId || t.email });
    flushAll(); dropActor(t.uid);
  } catch (e) { rollback(); throw e; } finally { lock.releaseLock(); }
  return { ok: true };
}
/** The IT Admin sets passwords for MANY accounts at once (every teacher, every student of one section ...): the birth-year default, or one password they type.
    Everybody must choose their own new password at the next sign-in. At most 40 accounts per request. */
function actBulkSetPassword(actor, p) {
  var S = makeS(actor); if (!S.isAdmin) deny();
  var uids = Array.isArray(p.uids) ? p.uids.slice(0, 40) : []; if (!uids.length) fail('invalid-argument', 'Choose at least one account.');
  var lock = LockService.getScriptLock(), done = 0, skipped = []; lock.waitLock(30000);
  try {
    uids.forEach(function (uid) {
      var t = getDoc('users', String(uid)); if (!t || !canManage(actor, t)) { skipped.push(String(uid)); return; }
      var pw = p.password;
      if (p.useDefault) { var st = t.role === 'student' ? (getDoc('students', t.studentId) || {}) : t; pw = defaultPassword(st.lastName || String(t.displayName || '').split(',')[0], st.birthday || t.birthday); }
      if (!pw || (!p.useDefault && !strongEnough(t.role, pw))) { skipped.push(t.displayName || t.uid); return; }
      authSetPassword(t.uid, pw); t.mustChangePassword = true; t.passwordResetAt = { __ts: nowMs() }; t.updatedAt = { __ts: nowMs() }; putDoc('users', t.uid, t); done++;
    });
    logAudit(actor.uid, actor.me.schoolId, 'bulk.temp_password_set', '', { count: done, how: p.useDefault ? 'birth-year default' : 'typed password' });
    flushAll(); uids.forEach(dropActor);
  } catch (e) { rollback(); throw e; } finally { lock.releaseLock(); }
  return { ok: true, done: done, skipped: skipped };
}
function actSendReset(actor, p) {
  var S = makeS(actor); if (!S.isAdmin) deny();
  var t = getDoc('users', String(p.uid || '')); if (!t || !canManage(actor, t)) deny();
  if (!t.hasRealEmail || !isEmail(t.email)) fail('failed-precondition', 'This account has no email.');
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { sendResetMail(t.uid, t.email, t.displayName); logAudit(actor.uid, t.schoolId, t.role + '.reset_email_sent', t.uid, {}); flushAll(); } finally { lock.releaseLock(); }
  return { ok: true };
}
function purgeWhere(coll, field, values) {
  var s = scan(coll, (function () { var o = {}; o[field] = values; return o; })()), t = s.t, ids = colOf(t, 0), n = 0;
  s.hits.forEach(function (h) { delDoc(coll, ids[h.i]); n++; });
  return n;
}
function dropAccount(uid) { delDoc('users', uid); tDel(T(AUTH_TAB), uid); dropActor(uid); }
function actDeleteUser(actor, p) {
  var S = makeS(actor); if (!S.isSuper && !S.isAdmin) fail('permission-denied', 'Only an administrator can remove accounts.');
  var uid = String(p.uid || ''); if (!uid || uid === actor.uid) fail('invalid-argument', 'Invalid account.');
  var t = getDoc('users', uid); if (!t) { var l0 = LockService.getScriptLock(); l0.waitLock(20000); try { tDel(T(AUTH_TAB), uid); flushAll(); } finally { l0.releaseLock(); } return { ok: true }; }
  if (t.role === 'superadmin') fail('permission-denied', 'That account cannot be removed here.');
  if (!canManage(actor, t)) fail('permission-denied', 'You cannot remove that account.');
  return deleteUserCore(actor, uid, t);
}
function deleteUserCore(actor, uid, t) {
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    if (t.role === 'teacher') {
      var studs = scan('students', { ownerUid: [uid] }), ids = colOf(studs.t, 0);
      studs.hits.forEach(function (h) { var a = unpack(cellJson(studs.t, h.i)).accountUid; if (a) dropAccount(a); });
      var mods = scan('modules', { ownerUid: [uid] }); var mids = mods.hits.map(function (h) { return colOf(mods.t, 0)[h.i]; });
      ['scanResults', 'examAttempts', 'examSubmissions', 'examKeys', 'examPapers', 'moduleChunks', 'modules', 'examinations', 'answerKeys', 'answerSheets', 'enrollments', 'teacherLinks', 'classCodes', 'students', 'classes'].forEach(function (c) { purgeWhere(c, 'ownerUid', [uid]); });
    } else if (t.role === 'student' && t.studentId) {
      var st = getDoc('students', t.studentId); if (st) { delete st.accountUid; putDoc('students', t.studentId, st); }
      ['enrollments', 'teacherLinks', 'examAttempts', 'examSubmissions'].forEach(function (c) { purgeWhere(c, 'studentId', [t.studentId]); });
    }
    dropAccount(uid);
    var unlinked = null;
    if (EMP_ROLES.indexOf(t.role) >= 0 && t.employeeId) {   // the person stays in the HR records, but without a login
      unlinked = staffKey(t.schoolId, t.employeeId); var e0 = getDoc('employees', unlinked);
      if (e0 && e0.accountUid === uid) { ACCT_FIELDS.forEach(function (k) { delete e0[k]; }); e0.updatedAt = { __ts: nowMs() }; putDoc('employees', unlinked, e0); } else unlinked = null;
    }
    logAudit(actor.uid, t.schoolId || '', t.role + '.deleted', uid, { username: t.employeeId || t.studentId || t.email });
    flushAll();
    if (unlinked) mirrorOps([{ op: 'set', coll: 'employees', id: unlinked }]);
  } catch (e) { rollback(); throw e; } finally { lock.releaseLock(); }
  return { ok: true };
}
/** HR: remove an employee from the HR records. The login account (if any) is removed too, and so are the leave requests of that person. */
function actHrDeleteEmployee(actor, p) {
  var S = makeS(actor); if (!S.isHR) fail('permission-denied', 'Only HR can remove an employee.');
  var key = String(p.key || ''), e = getDoc('employees', key);
  if (!e || e.schoolId !== S.sid) fail('not-found', 'That employee was not found.');
  if (e.accountUid) {
    if (e.accountUid === actor.uid) fail('failed-precondition', 'You cannot remove your own account. Ask another HR account to do it.');
    var u = getDoc('users', e.accountUid);
    if (u) { if (u.schoolId !== S.sid || EMP_ROLES.indexOf(u.role) < 0) deny(); deleteUserCore(actor, e.accountUid, u); }
    else { var l0 = LockService.getScriptLock(); l0.waitLock(20000); try { tDel(T(AUTH_TAB), e.accountUid); flushAll(); } finally { l0.releaseLock(); } }
  }
  var ops = [{ op: 'delete', coll: 'employees', id: key }], lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var lv = scan('leaveRequests', { schoolId: [S.sid] }), lids = colOf(lv.t, 0);
    lv.hits.forEach(function (h) { var d = unpack(cellJson(lv.t, h.i)); if ((e.accountUid && d.requesterUid === e.accountUid) || (d.employeeId && d.employeeId === e.employeeId)) { delDoc('leaveRequests', lids[h.i]); ops.push({ op: 'delete', coll: 'leaveRequests', id: lids[h.i] }); } });
    delDoc('employees', key);
    putDoc('hrLog', newId(), { schoolId: S.sid, byUid: actor.uid, byName: actor.me.displayName || '', action: e.accountUid ? 'Deleted (account removed too)' : 'Deleted', targetName: fullName(e), targetNo: e.employeeId, createdAt: { __ts: nowMs() } });
    flushAll();
  } catch (err) { rollback(); throw err; } finally { lock.releaseLock(); }
  mirrorOps(ops);
  return { ok: true };
}
/** HR: the IT Admin of the school is an employee too, but has no HR record (the Super Admin creates that account).
 *  HR keeps the IT Admin's name, position, department, contact number and 2x2 photo here; they show in the IT Admin's side panel.
 *  The sign-in email, password and account status stay with the Super Admin / IT Admin. */
function actHrAdminGet(actor) {
  var S = makeS(actor); if (!S.isHR) fail('permission-denied', 'Only HR can open this.');
  var us = scan('users', { schoolId: [S.sid] }), uids = colOf(us.t, 0), out = [];
  if (us.hits.length > 12) colOf(us.t, 4);
  us.hits.forEach(function (h) {
    var u = unpack(cellJson(us.t, h.i)); if (u.role !== 'admin') return;
    out.push({ uid: uids[h.i], displayName: u.displayName || '', email: u.email || '', position: u.position || '', department: u.department || '', contact: u.contact || '', photo: u.photo || '', status: u.status || 'active' });
  });
  return { admins: out };
}
function actHrAdminSave(actor, p) {
  var S = makeS(actor); if (!S.isHR) fail('permission-denied', 'Only HR can change the IT Admin information.');
  var uid = String(p.uid || ''), u = getDoc('users', uid);
  if (!u || u.role !== 'admin' || u.schoolId !== S.sid) fail('not-found', 'That IT Admin account was not found in your school.');
  var name = String(p.displayName || '').trim(), pos = String(p.position || '').trim(), dep = String(p.department || '').trim(), con = String(p.contact || '').trim(), photo = String(p.photo || '');
  if (name.length < 3 || name.length > 100) fail('invalid-argument', 'Enter the IT Admin name (3 to 100 characters).');
  if (pos.length > 80 || dep.length > 80 || con.length > 40) fail('invalid-argument', 'The position, department or contact number is too long.');
  if (!photoOk({ photo: photo })) fail('invalid-argument', 'The photo is not valid. Choose a JPG or PNG picture again.');
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    u.displayName = name;
    [['position', pos], ['department', dep], ['contact', con], ['photo', photo]].forEach(function (kv) { if (kv[1]) u[kv[0]] = kv[1]; else delete u[kv[0]]; });
    putDoc('users', uid, u);
    putDoc('hrLog', newId(), { schoolId: S.sid, byUid: actor.uid, byName: actor.me.displayName || '', action: 'Edited the IT Admin information', targetName: name, targetNo: '', createdAt: { __ts: nowMs() } });
    flushAll();
  } catch (e) { rollback(); throw e; } finally { lock.releaseLock(); }
  dropActor(uid);   // the IT Admin's next page load shows the new photo / name
  return { ok: true };
}
/** IT Admin: replace or remove the 2x2 photo of ANY employee account of the school (and their own). p.uid empty = the IT Admin's own photo.
 *  The photo is also written to the person's HR record, so HR and the person's own page show the same picture. */
function actAdminSetPhoto(actor, p) {
  var S = makeS(actor); if (!S.isAdmin) fail('permission-denied', 'Only the IT Admin can change photos.');
  var photo = String(p.photo || '');
  if (!photoOk({ photo: photo })) fail('invalid-argument', 'The photo is not valid. Choose a JPG or PNG picture again.');
  var uid = String(p.uid || actor.uid), u = getDoc('users', uid);
  if (!u || u.schoolId !== S.sid || (u.role !== 'admin' && EMP_ROLES.indexOf(u.role) < 0)) fail('not-found', 'That account was not found in your school.');
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    if (photo) u.photo = photo; else delete u.photo;
    putDoc('users', uid, u);
    if (u.role !== 'admin' && u.employeeId) {
      var key = staffKey(S.sid, u.employeeId), e = getDoc('employees', key);
      if (e && e.accountUid === uid) { if (photo) e.photo = photo; else delete e.photo; putDoc('employees', key, e); }
    }
    putDoc('auditLogs', newId(), { actorUid: actor.uid, schoolId: S.sid, action: u.role + (photo ? '.photo_changed' : '.photo_removed'), targetUid: uid, details: { username: u.employeeId || u.email || '' }, createdAt: { __ts: nowMs() } });
    flushAll();
  } catch (e) { rollback(); throw e; } finally { lock.releaseLock(); }
  dropActor(uid);
  return { ok: true };
}
/* Registrar: delete the login account of one student of the registrar's own school (even if it is already created).
   The registration / enrollment records are NOT touched here; the web page removes or marks them afterwards. */
function actRegistrarDropStudentAccount(actor, p) {
  var S = makeS(actor); if (!S.isRegistrar) fail('permission-denied', 'Only the registrar can remove a student account here.');
  var reg = getDoc('registry', String(p.registryId || ''));
  if (!reg || reg.schoolId !== S.sid) fail('not-found', 'That student was not found.');
  var examNo = String(reg.examNo || ''); if (!examNo) return { ok: true, removed: false };
  var st = getDoc('students', examNo); if (!st || st.schoolId !== S.sid || !st.accountUid) return { ok: true, removed: false };
  var uid = st.accountUid, lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    ['enrollments', 'teacherLinks', 'examAttempts', 'examSubmissions'].forEach(function (c) { purgeWhere(c, 'studentId', [examNo]); });
    delete st.accountUid; delete st.email; putDoc('students', examNo, st);
    dropAccount(uid);
    logAudit(actor.uid, S.sid, 'student.account_deleted_by_registrar', uid, { username: examNo });
    flushAll();
  } catch (e) { rollback(); throw e; } finally { lock.releaseLock(); }
  return { ok: true, removed: true };
}
function purgeSchool(schoolId, removeAdmins) {
  var us = scan('users', { schoolId: [schoolId] }), uids = colOf(us.t, 0), people = [];
  us.hits.forEach(function (h) { var d = unpack(cellJson(us.t, h.i)); d.uid = uids[h.i]; if (d.role !== 'superadmin') people.push(d); });
  var doomed = people.filter(function (p) { return removeAdmins || p.role !== 'admin'; });
  var owners = people.filter(function (p) { return p.role === 'teacher' || p.role === 'admin'; }).map(function (p) { return p.uid; });
  var gone = {}; doomed.forEach(function (p) { gone[p.uid] = 1; });
  var n = 0;
  SCHOOL_COLLECTIONS.forEach(function (c) { if (owners.length) n += purgeWhere(c, 'ownerUid', owners); n += purgeWhere(c, 'schoolId', [schoolId]); });
  n += purgeWhere('auditLogs', 'schoolId', [schoolId]);
  Object.keys(gone).forEach(function (u) { dropAccount(u); });
  return { deleted: n + Object.keys(gone).length, accounts: Object.keys(gone).length };
}
function actEraseSchool(actor, p, removeSchool) {
  var S = makeS(actor); if (!S.isSuper) fail('permission-denied', 'Only the Super Admin can do that.');
  var sid = String(p.schoolId || ''), sc = getDoc('schools', sid); if (!sc) fail('not-found', 'That school was not found.');
  var lock = LockService.getScriptLock(), r; lock.waitLock(30000);
  try {
    r = purgeSchool(sid, removeSchool);
    if (removeSchool) delDoc('schools', sid);
    logAudit(actor.uid, removeSchool ? '' : sid, removeSchool ? 'school.deleted' : 'school.data_cleared', sid, { name: sc.name, code: sc.code, deleted: r.deleted, accounts: r.accounts });
    flushAll();
  } catch (e) { rollback(); throw e; } finally { lock.releaseLock(); }
  return { ok: true, deleted: r.deleted, accounts: r.accounts };
}
function actAllocIds(actor, p) {
  var S = makeS(actor); if (!S.isStaff) deny();
  var year = Math.floor(+p.year), n = Math.floor(+p.n);
  if (!(year > 2000 && year < 3000) || !(n >= 1 && n <= 5000)) fail('invalid-argument', 'Bad request.');
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var id = 'students-' + year, c = getDoc('counters', id), cur = c ? +c.last : 0;
    putDoc('counters', id, { last: cur + n }); flushAll(); return { start: cur };
  } catch (e) { rollback(); throw e; } finally { lock.releaseLock(); }
}

/* ============================== the readable Records sheet ==============================
   A SECOND Google Sheet, written for people: one row per record, plain words, one column per fact (no code, no formulas).
   The Registrar, Finance, Custodian and Guidance each get their own tabs. The portal still works from the first (technical) sheet;
   this one is a copy that is kept up to date every time somebody saves, edits or deletes a record.
   Create it once from the menu:  ARK Portal > 4. Create the readable Records sheet. */
var REC_ID_HEAD = 'Record ID (please do not change)';
var REC_DEFAULT_REQS = [
  { id: 'form138', label: 'Form 138 / Report Card' }, { id: 'psa', label: 'PSA Birth Certificate' }, { id: 'goodmoral', label: 'Good Moral Certificate' },
  { id: 'form137', label: 'Form 137 / SF10 (Permanent Record)' }, { id: 'pictures', label: '2x2 ID Pictures' }, { id: 'enrollform', label: 'Signed Enrollment Form' },
  { id: 'transfer', label: 'Certificate of Transfer (transferees only)' }];
var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function rcx() { return { sch: {}, set: {} }; }
function rSchool(cx, sid) {
  if (!(sid in cx.sch)) { var s = sid ? getDoc('schools', sid) : null; cx.sch[sid] = s ? (s.displayName || s.name || sid) : (sid || ''); }
  return cx.sch[sid];
}
function rSettings(cx, coll, sid) {
  var k = coll + '|' + sid; if (!(k in cx.set)) cx.set[k] = (sid && getDoc(coll, sid)) || {}; return cx.set[k];
}
function rDate(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1] : String(s || ''); }
function rTs(v) {
  var ms = tsOf(v); if (typeof ms !== 'number' || !ms) return '';
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone() || 'Asia/Manila', 'MMM d, yyyy h:mm a');
}
function rAge(b) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b || '')); if (!m) return '';
  var t = new Date(), a = t.getFullYear() - +m[1];
  if (t.getMonth() + 1 < +m[2] || (t.getMonth() + 1 === +m[2] && t.getDate() < +m[3])) a--;
  return a >= 0 && a < 120 ? String(a) : '';
}
function rMoney(n) { n = Number(n) || 0; return 'PHP ' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function rYN(v) { return v === true || v === 'Yes' ? 'Yes' : v === false || v === 'No' ? 'No' : String(v || ''); }
function rUnit(v, u) { return v === undefined || v === null || v === '' ? '' : v + ' ' + u; }
function rBmi(h, w) { h = +h; w = +w; return h > 0 && w > 0 ? (Math.round(w / Math.pow(h / 100, 2) * 10) / 10) + '' : ''; }
function rExtra(extra, fields) {
  extra = extra || {};
  return (fields || []).map(function (f) { var v = extra[f.id]; return v === undefined || v === '' || v === null ? '' : f.label + ': ' + (f.type === 'date' ? rDate(v) : v); }).filter(String).join('; ');
}
function rReqs(cx, sid) { var s = rSettings(cx, 'registrarSettings', sid); return s.requirements && s.requirements.length ? s.requirements : REC_DEFAULT_REQS; }
function rRegFields(cx, sid, groups) { var f = rSettings(cx, 'registrarSettings', sid).fields || {}, out = []; groups.forEach(function (g) { out = out.concat(f[g] || []); }); return out; }
function rKindFields(cx, coll, sid, kind) { return ((rSettings(cx, coll, sid).fields || {})[kind]) || []; }
function rReqLists(d, reqs) {
  var have = d.reqs || {}, ok = [], miss = [], notes = [];
  reqs.forEach(function (r) {
    var x = have[r.id];
    if (x) { ok.push(r.label + (x.d ? ' (' + rDate(x.d) + ')' : '')); if (x.n) notes.push(r.label + ': ' + x.n); } else miss.push(r.label);
  });
  return { ok: ok, miss: miss, notes: notes, n: ok.length, total: reqs.length };
}

var _books = {};
var REC = {
  regStudents: { grp: 'registrar', src: 'registry', tab: 'Registrar - Students', wide: [15, 16, 17, 18, 19, 20, 24],
    head: ['School', 'Student ID No.', 'LRN', 'Last name', 'First name', 'Middle name', 'Suffix', 'Birthdate', 'Age', 'Gender', 'Grade level', 'School year registered', 'Voucher type', 'Contact No.', 'Address',
      "Father's name", "Mother's name", "Guardian's name", 'Guardian contact No.', "Guardian's address", 'Exam ID No. (login)', 'Enrollment status', 'Additional information', 'Last updated'],
    row: function (d, id, cx) {
      return [rSchool(cx, d.schoolId), d.studentNo, d.lrn, d.lastName, d.firstName, d.middleName, d.suffix, rDate(d.birthday), rAge(d.birthday), d.gender, d.gradeLevel, d.schoolYear, d.voucherType, d.contact, d.address,
        d.father, d.mother, d.guardianName, d.guardianContact, d.guardianAddress, d.examNo, d.enrollStatus || 'Pending', rExtra(d.extra, rRegFields(cx, d.schoolId, ['reg', 'master'])), rTs(d.updatedAt || d.createdAt)];
    } },
  regReqs: { grp: 'registrar', src: 'registry', tab: 'Registrar - Requirements', wide: [9, 10, 11],
    head: ['School', 'Student ID No.', 'Student name', 'Grade level', 'School year', 'Enrollment status', 'Documents submitted (count)', 'Checklist result', 'Documents submitted (with dates)', 'Documents still missing', 'Notes', 'Checklist last updated'],
    row: function (d, id, cx) {
      var L = rReqLists(d, rReqs(cx, d.schoolId));
      return [rSchool(cx, d.schoolId), d.studentNo, d.name, d.gradeLevel, d.schoolYear, d.enrollStatus || 'Pending', L.n + ' of ' + L.total, L.n >= L.total && L.total ? 'Complete' : 'Incomplete', L.ok.join('; '), L.miss.join('; '), L.notes.join('; '), rTs(d.reqUpdatedAt)];
    } },
  regEnroll: { grp: 'registrar', src: 'enrollmentRecords', tab: 'Registrar - Enrollment', wide: [16],
    head: ['School', 'Student ID No.', 'LRN', 'Student name', 'Gender', 'Grade level', 'Section', 'Cluster / strand', 'Term / quarter', 'School year', 'Learning modality', 'Adviser', 'Remark', 'Remark date', 'Remark note', 'Additional information', 'Enrolled on'],
    row: function (d, id, cx) {
      return [rSchool(cx, d.schoolId), d.studentNo, d.lrn, d.name, d.gender, d.gradeLevel, d.sectionName, d.strand, d.term, d.schoolYear, d.modality, d.adviserName, d.remark, rDate(d.remarkDate), d.remarkNote, rExtra(d.extra, rRegFields(cx, d.schoolId, ['enroll'])), rTs(d.createdAt)];
    } },
  regSched: { grp: 'registrar', src: 'classSchedules', tab: 'Registrar - Class schedule', wide: [],
    head: ['School', 'Semester', 'Grade level', 'Section', 'Day', 'Start', 'End', 'Subject', 'Teacher', 'Room', 'Cluster / strand'],
    row: function (d, id, cx) {
      return [rSchool(cx, d.schoolId), d.semesterName, d.gradeLevel, d.sectionName, d.day, d.start, d.end, d.subject, d.teacherName, d.room, d.cluster];
    } },
  finPay: { grp: 'finance', src: 'payments', tab: 'Finance - Payments', wide: [13],
    head: ['School', 'Date of payment', 'Receipt / OR No.', 'Student ID No.', 'Student name', 'Grade level', 'School year', 'Voucher type', 'Payment for', 'Amount paid', 'Status', 'Reason (if voided)', 'Remarks', 'Recorded by', 'Recorded on'],
    row: function (d, id, cx) {
      return [rSchool(cx, d.schoolId), rDate(d.date), d.receiptNo, d.studentNo, d.name, d.gradeLevel, d.schoolYear, d.voucherType, d.type, rMoney(d.amount), d.status === 'void' ? 'Voided' : 'Paid', d.voidReason, d.remarks, d.createdByName, rTs(d.createdAt)];
    } },
  finBal: { grp: 'finance', src: 'studentAccounts', tab: 'Finance - Balances', wide: [11],
    head: ['School', 'School year', 'Student ID No.', 'Student name', 'Grade level', 'Voucher type', 'Section', 'Total to pay', 'Total paid', 'Balance', 'Breakdown', 'Payment status'],
    row: function (d, id, cx) {
      var due = +d.totalDue || 0, paid = +d.totalPaid || 0, bal = +d.balance || 0;
      var st = !due ? 'No fees set' : bal <= 0 ? 'Fully paid' : paid > 0 ? 'Partly paid' : 'No payment yet';
      return [rSchool(cx, d.schoolId), d.schoolYear, d.studentNo, d.name, d.gradeLevel, d.voucherType, d.section, rMoney(due), rMoney(paid), rMoney(Math.max(0, bal)),
        (d.lines || []).map(function (l) { return l.type + ': to pay ' + rMoney(l.due) + ', paid ' + rMoney(l.paid); }).join('; '), st];
    } },
  cusItems: { grp: 'custodian', src: 'custodianRecords', tab: 'Custodian - Items', wide: [13, 14],
    head: ['School', 'Date', 'Student ID No.', 'Student name', 'Grade level', 'Section', 'Item', 'Status', 'Size / details', 'Quantity', 'Date returned', 'Received by', 'Remarks', 'Additional information', 'Recorded by', 'Recorded on'],
    row: function (d, id, cx) {
      return [rSchool(cx, d.schoolId), rDate(d.date), d.studentNo, d.name, d.gradeLevel, d.sectionName, d.item, d.status, d.size, d.qty, rDate(d.dateReturned), d.receivedBy, d.remarks, rExtra(d.extra, rKindFields(cx, 'custodianSettings', d.schoolId, 'items')), d.createdByName, rTs(d.createdAt)];
    } },
  guiHealth: { grp: 'guidance', src: 'healthRecords', tab: 'Guidance - Health', wide: [14, 15, 16, 17, 18],
    head: ['School', 'Date', 'Student ID No.', 'Student name', 'Grade level', 'Section', 'Kind of record', 'Height', 'Weight', 'BMI', 'Vision', 'Hearing', 'Allergies', 'Medical conditions', 'Medicines taken', 'Immunization', 'Findings / complaint', 'Treatment / action', 'Health status', 'Follow-up date', 'Additional information', 'Recorded by', 'Recorded on'],
    row: function (d, id, cx) {
      return [rSchool(cx, d.schoolId), rDate(d.date), d.studentNo, d.name, d.gradeLevel, d.sectionName, d.type, rUnit(d.height, 'cm'), rUnit(d.weight, 'kg'), rBmi(d.height, d.weight), d.vision, d.hearing, d.allergies, d.conditions, d.medications, d.immunization,
        d.findings, d.treatment, d.healthStatus, rDate(d.followUp), rExtra(d.extra, rKindFields(cx, 'guidanceSettings', d.schoolId, 'health')), d.createdByName, rTs(d.createdAt)];
    } },
  guiCases: { grp: 'guidance', src: 'guidanceRecords', tab: 'Guidance - Counseling', wide: [8, 9, 14],
    head: ['School', 'Date', 'Student ID No.', 'Student name', 'Grade level', 'Section', 'Kind of record', 'Concern / reason', 'Action taken', 'Referred to', 'Status', 'Parent / guardian informed', 'Follow-up date', 'Remarks', 'Additional information', 'Recorded by', 'Recorded on'],
    row: function (d, id, cx) {
      return [rSchool(cx, d.schoolId), rDate(d.date), d.studentNo, d.name, d.gradeLevel, d.sectionName, d.category, d.concern, d.action, d.referredTo, d.status, rYN(d.parentNotified), rDate(d.followUp), d.remarks, rExtra(d.extra, rKindFields(cx, 'guidanceSettings', d.schoolId, 'guidance')), d.createdByName, rTs(d.createdAt)];
    } },
  hrLeave: { grp: 'hr', src: 'leaveRequests', tab: 'HR - Leave requests', wide: [10, 13],
    head: ['School', 'Filed on', 'Employee No.', 'Employee name', 'Account type', 'Leave type', 'From', 'To', 'Working days', 'Reason', 'Status', 'HR remarks', 'Decided by', 'Decided on'],
    row: function (d, id, cx) {
      return [rSchool(cx, d.schoolId), rTs(d.createdAt), d.employeeId, d.requesterName, d.requesterRole === 'admin' ? 'IT Admin' : d.requesterRole, d.leaveType, rDate(d.startDate), rDate(d.endDate), d.days, d.reason, d.status, d.hrRemarks, d.decidedByName, rTs(d.decidedAt)];
    } },
  hrEmp: { grp: 'hr', src: 'employees', tab: 'HR - Employees', wide: [18, 26],
    head: ['School', 'Employee No.', 'Last name', 'First name', 'Middle name', 'Birthdate', 'Age', 'Gender', 'Civil status', 'Position', 'Department', 'Employment type', 'Date hired', 'Status', 'Contact No.', 'Email', 'Address',
      'Emergency contact', 'Emergency contact No.', 'SSS No.', 'PhilHealth No.', 'Pag-IBIG No.', 'TIN', 'PRC license No.', 'Portal account', 'Account type', 'Additional information', 'Last updated'],
    row: function (d, id, cx) {
      return [rSchool(cx, d.schoolId), d.employeeId, d.lastName, d.firstName, d.middleName || d.middleInitial, rDate(d.birthday), rAge(d.birthday), d.gender, d.civilStatus, d.position, d.department, d.employmentType, rDate(d.dateHired), d.status || 'Active',
        d.contact, d.email, d.address, d.emergencyName, d.emergencyContact, d.sss, d.philhealth, d.pagibig, d.tin, d.prc, d.accountUid ? 'Has an account' : 'No account yet', d.accountRole || '',
        rExtra(d.extra, ((rSettings(cx, 'hrSettings', d.schoolId).fields || {}).employee) || []), rTs(d.updatedAt || d.createdAt)];
    } },
  admEmpAcct: { grp: 'admin', src: 'users', tab: 'IT Admin - Employee accounts', wide: [],
    head: ['School', 'Employee No.', 'Name', 'Account type', 'Position', 'Department', 'Status', 'Email', 'Account created'],
    row: function (d, id, cx) {
      if (!d.role || d.role === 'student' || d.role === 'superadmin') return null;
      return [rSchool(cx, d.schoolId), d.employeeId, d.displayName, d.role === 'admin' ? 'IT Admin' : (REC_ROLE_NAME[d.role] || d.role), d.position, d.department, d.status === 'suspended' ? 'Suspended' : 'Active', d.hasRealEmail ? d.email : '', rTs(d.createdAt)];
    } },
  admStuAcct: { grp: 'admin', src: 'users', tab: 'IT Admin - Student accounts', wide: [],
    head: ['School', 'School year', 'Grade / section', 'Exam ID No.', 'Student name', 'Birthdate', 'Status', 'Email', 'Account created'],
    row: function (d, id, cx) {
      if (d.role !== 'student') return null;
      var st = getDoc('students', d.studentId) || {};
      return [rSchool(cx, d.schoolId), recSchoolYear(d.createdAt), st.className || '', d.studentId, d.displayName, rDate(d.birthday || st.birthday), d.status === 'suspended' ? 'Suspended' : 'Active', d.hasRealEmail ? d.email : '', rTs(d.createdAt)];
    } },
  payInfo: { grp: 'payroll', src: 'payrollInfo', tab: 'Payroll - Employee pay information', wide: [12],
    head: ['School', 'Employee No.', 'Employee name', 'Position', 'Department', 'Monthly basic pay', 'Pay frequency', 'Allowances', 'SSS', 'PhilHealth', 'Pag-IBIG', 'Other deductions / loans', 'Cash advance balance', 'Cash advance deducted every pay', 'Status', 'Pay type', 'Rate per hour', 'Daily rate'],
    row: function (d, id, cx) {
      var al = (d.allowances || []).map(function (x) { return (x.label ? x.label + ': ' : '') + rMoney(x.amount) + (x.perDay ? ' per day' : ' per month'); }).join('; ');
      return [rSchool(cx, d.schoolId), d.employeeId, d.name, d.position, d.department, rMoney(d.basicMonthly), d.frequency === 'semi' ? 'Twice a month' : 'Monthly', al, rYN(d.sss !== false), rYN(d.philhealth !== false), rYN(d.pagibig !== false),
        (d.deductions || []).map(function (x) { return (x.type ? x.type + ' ' : '') + x.label + ': ' + rMoney(x.amount) + (x.balance !== undefined && x.balance !== '' && x.balance !== null ? ' (balance ' + rMoney(x.balance) + ')' : ''); }).join('; '), rMoney((d.ca || {}).balance), rMoney((d.ca || {}).perPay), d.active === false ? 'Inactive' : 'Active', d.payType === 'hourly' ? 'Per hour' : (d.payType === 'monthly' ? 'Fixed monthly' : ''), d.payType === 'hourly' ? rMoney(d.hourlyRate) : '', d.payType === 'hourly' ? '' : rMoney(d.dailyRate)];
    } },
  payRuns: { grp: 'payroll', src: 'payrollRuns', tab: 'Payroll - Payroll runs', wide: [],
    head: ['School', 'Payroll period', 'From', 'To', 'Pay date', 'Employees', 'Total gross pay', 'Total deductions', 'Total net pay', 'Status', 'Prepared by'],
    row: function (d, id, cx) { return [rSchool(cx, d.schoolId), d.label, rDate(d.start), rDate(d.end), rDate(d.payDate), d.count, rMoney(d.gross), rMoney(d.deductions), rMoney(d.net), d.status, d.createdByName]; } },
  payDtr: { grp: 'payroll', src: 'payrollDtr', tab: 'Payroll - DTR summary (biometric)', wide: [],
    head: ['School', 'Month', 'Employee No.', 'Employee name', 'Days present', 'Days absent', 'Late (minutes)', 'Undertime (minutes)', 'Overtime (hours)', 'Hours worked', 'Days with a missing punch'],
    row: function (d, id, cx) { var t = d.totals || {}; return [rSchool(cx, d.schoolId), d.month, d.employeeId, d.name, t.present, t.absent, t.late, t.ut, Math.round((t.ot || 0) / 6) / 10, t.hours, t.inc]; } },
  paySlips: { grp: 'payroll', src: 'payslips', tab: 'Payroll - Payslips', wide: [],
    head: ['School', 'Payroll period', 'Employee No.', 'Employee name', 'Position', 'Department', 'Basic pay', 'Allowances', 'Overtime', 'Other earnings', 'Gross pay', 'Absences / late', 'SSS', 'PhilHealth', 'Pag-IBIG', 'Withholding tax', 'Cash advance', 'Cash advance balance after', 'Loans / other deductions', 'Total deductions', 'NET PAY', 'Status', 'Hours worked (per hour)', 'Rate per hour', 'Daily rate', 'Days present', 'Days absent', 'Overtime (hours)', 'No. of holidays', 'Holiday pay'],
    row: function (d, id, cx) {
      var dt = (d.inputs || {}).dtr || {};
      return [rSchool(cx, d.schoolId), d.runLabel, d.employeeId, d.name, d.position, d.department, rMoney(d.basic), rMoney(d.allow), rMoney(d.ot), rMoney(d.otherEarn), rMoney(d.gross), rMoney((+d.absent || 0) + (+d.late || 0)), rMoney(d.sssEe), rMoney(d.phicEe), rMoney(d.hdmfEe), rMoney(d.tax), rMoney(d.caDed), rMoney(d.caAfter), rMoney(d.other), rMoney(d.totalDed), rMoney(d.net), d.status, d.perHour ? d.hours : '', d.perHour ? rMoney(d.rate) : '', d.perHour ? '' : rMoney(d.dailyRate), (d.presentDays !== undefined && d.presentDays !== null) ? d.presentDays : (dt.present !== undefined ? dt.present : ''), d.perHour ? (dt.absent !== undefined ? dt.absent : '') : (d.absentDays || 0), (d.otHours !== undefined && d.otHours !== null) ? d.otHours : ((d.inputs || {}).otHours || 0), d.holidays || 0, rMoney(d.holPay)];
    } }
};
var REC_GROUPS = { registrar: 'Registrar', finance: 'Finance', payroll: 'Finance - Payroll', custodian: 'Custodian', guidance: 'Guidance', hr: 'HR', admin: 'IT Admin' };
var REC_ORDER = ['registrar', 'finance', 'payroll', 'custodian', 'guidance', 'hr', 'admin'];
/** Every user type / department has its own book, named "ARK - Important Details - <department>". */
function recBookTitle(grp) { return 'ARK - Important Details - ' + REC_GROUPS[grp]; }
var REC_ROLE_NAME = { teacher: 'Teacher', registrar: 'Registrar', finance: 'Finance', payroll: 'Finance - Payroll', custodian: 'Custodian', guidance: 'Guidance', hr: 'HR', schooladmin: 'School Admin', staff: 'Other staff' };
function recSchoolYear(ts) { var ms = tsOf(ts); if (typeof ms !== 'number' || !ms) return ''; var d = new Date(ms), y = d.getFullYear(); return d.getMonth() >= 5 ? y + '-' + (y + 1) : (y - 1) + '-' + y; }
function recKeysOf(grp) { return Object.keys(REC).filter(function (k) { return REC[k].grp === grp; }); }
function recIdProp(grp) { return 'RECORDS_ID_' + grp.toUpperCase(); }

function recBook(grp) {
  var id = prop(recIdProp(grp)); if (!id) return null;
  return _books[grp] || (_books[grp] = SpreadsheetApp.openById(id));
}
function recSheet(book, key) {
  var def = REC[key], sh = book.getSheetByName(def.tab), n = def.head.length + 1;
  if (!sh) {
    try {
      sh = book.insertSheet(def.tab);
      sh.getRange(1, 1, 1, n).setValues([def.head.concat([REC_ID_HEAD])]).setFontWeight('bold').setBackground('#b3121f').setFontColor('#ffffff').setWrap(true).setVerticalAlignment('middle');
      sh.setFrozenRows(1);
      sh.getRange(1, 1, sh.getMaxRows(), n).setNumberFormat('@');
      for (var c = 1; c <= n; c++) sh.setColumnWidth(c, def.wide.indexOf(c) >= 0 ? 300 : c === n ? 150 : Math.max(95, Math.min(190, def.head[c - 1].length * 9 + 24)));
      def.wide.forEach(function (c) { sh.getRange(2, c, sh.getMaxRows() - 1, 1).setWrap(true); });
      sh.getRange(2, n, sh.getMaxRows() - 1, 1).setFontColor('#9aa0a6').setFontSize(8);
      sh.getRange(2, 1, sh.getMaxRows() - 1, n - 1).setVerticalAlignment('top');
      try { sh.getRange(1, 1, sh.getMaxRows(), n).createFilter(); } catch (e) { }
    } catch (e) { sh = book.getSheetByName(def.tab); if (!sh) throw e; }
  }
  return sh;
}
function recRows(sh, from, count) { var need = from + count - 1, max = sh.getMaxRows(); if (need > max) sh.insertRowsAfter(max, need - max + 200); }
function recClean(row, id) { var r = row.map(function (v) { return v === undefined || v === null ? '' : String(v); }); r.push(id); return r; }

/** Brings the readable sheet in step with a few changed records (called after every save). */
function recSync(book, key, putIds, delIds, cx) {
  var def = REC[key], sh = recSheet(book, key), n = def.head.length + 1, last = sh.getLastRow(), pos = {};
  if (last > 1) sh.getRange(2, n, last - 1, 1).getValues().forEach(function (r, i) { pos[String(r[0])] = i + 2; });
  if (putIds.length > 12) colOf(T(def.src), 4);
  var add = [], upd = [];
  putIds.forEach(function (id) {
    var d = getDoc(def.src, id);
    if (!d) { delIds.push(id); return; }
    var r0 = def.row(d, id, cx); if (!r0) { delIds.push(id); return; }     // this record does not belong on this tab
    var row = recClean(r0, id);
    if (pos[id]) upd.push({ at: pos[id], row: row }); else add.push(row);
  });
  if (upd.length > 8 && last > 1) {          // many changed rows: read the tab once, change them in memory, write it back once
    var all = sh.getRange(2, 1, last - 1, n).getValues();
    upd.forEach(function (u) { all[u.at - 2] = u.row; });
    var big = sh.getRange(2, 1, last - 1, n); big.setNumberFormat('@'); big.setValues(all);
  } else upd.forEach(function (u) { var rg = sh.getRange(u.at, 1, 1, n); rg.setNumberFormat('@'); rg.setValues([u.row]); });
  if (add.length) { var start = Math.max(sh.getLastRow(), 1) + 1; recRows(sh, start, add.length); var r2 = sh.getRange(start, 1, add.length, n); r2.setNumberFormat('@'); r2.setValues(add); }
  delIds.map(function (id) { return pos[id]; }).filter(Boolean).sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
}
/* ---- keeping the readable sheets up to date ----
   Saving must be FAST, so the portal does not write to the readable sheets while the person waits.
   It only notes WHICH records changed (a tiny list kept in the script's properties); a background job that runs every minute
   (menu: ARK Portal > 7. Speed up saving) copies those records into the right sheet. Without that job the copy is made at once (slower saves). */
var MQ = 'MIRROR_Q';
function mirrorWork(ops) {
  var work = {};
  (ops || []).forEach(function (op) {
    Object.keys(REC).forEach(function (k) {
      if (REC[k].src !== op.coll || !prop(recIdProp(REC[k].grp))) return;
      var w = work[k] || (work[k] = { put: {}, del: {} });
      if (op.op === 'delete') { w.del[op.id] = 1; delete w.put[op.id]; } else { w.put[op.id] = 1; delete w.del[op.id]; }
    });
  });
  return work;
}
function mirrorQueueAdd(work) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) { setProp('RECORDS_STALE', '1'); return; }
  try {
    var q = {}; try { q = JSON.parse(prop(MQ) || '{}'); } catch (e) { q = {}; }
    Object.keys(work).forEach(function (k) {
      var e = q[k] || (q[k] = { p: {}, d: {} });
      Object.keys(work[k].put).forEach(function (id) { e.p[id] = 1; delete e.d[id]; });
      Object.keys(work[k].del).forEach(function (id) { e.d[id] = 1; delete e.p[id]; });
    });
    var js = JSON.stringify(q);
    if (js.length > 8000) { setProp('RECORDS_STALE', '1'); setProp(MQ, ''); } else setProp(MQ, js);   // too big for a list: the background job rewrites the sheets instead
  } finally { lock.releaseLock(); }
}
function mirrorApply(work) {   // writes the changed records into their sheets (call while holding the script lock)
  var cx = rcx(), done = {};
  Object.keys(work).forEach(function (k) {
    var grp = REC[k].grp, book = recBook(grp); if (!book) return;
    recSync(book, k, Object.keys(work[k].put), Object.keys(work[k].del), cx); done[k] = 1;
  });
}
function mirrorOps(ops) {
  try {
    var work = mirrorWork(ops); if (!Object.keys(work).length) return;
    if (prop('MIRROR_ASYNC') === '1') { mirrorQueueAdd(work); return; }
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) { setProp('RECORDS_STALE', '1'); return; }
    try { mirrorApply(work); } catch (e) { setProp('RECORDS_STALE', '1'); console.error('Records sheet: ' + (e && e.stack || e)); } finally { lock.releaseLock(); }
  } catch (e2) { console.error('Records sheet: ' + (e2 && e2.stack || e2)); }
}
/** Runs every minute (time-driven trigger). */
function mirrorFlush() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return;
  try {
    var stale = prop('RECORDS_STALE') === '1', raw = prop(MQ);
    if (!stale && !raw) return;
    var q = {}; try { q = JSON.parse(raw || '{}'); } catch (e) { stale = true; }
    setProp(MQ, '');
    if (stale) { setProp('RECORDS_STALE', ''); REC_ORDER.forEach(function (g) { var b = recBook(g); if (b) { try { recRebuild(b, g); } catch (e) { setProp('RECORDS_STALE', '1'); console.error('Rebuild ' + g + ': ' + (e && e.stack || e)); } } }); return; }
    var work = {}; Object.keys(q).forEach(function (k) { if (REC[k]) work[k] = { put: q[k].p || {}, del: q[k].d || {} }; });
    try { mirrorApply(work); } catch (e2) { setProp('RECORDS_STALE', '1'); console.error('Records sheet: ' + (e2 && e2.stack || e2)); }
  } finally { lock.releaseLock(); }
}
/** Rewrites every tab of ONE readable sheet from the portal's data (first fill, or to repair it). */
function recRebuild(book, grp) {
  var cx = rcx(), report = [];
  recKeysOf(grp).forEach(function (k) {
    var def = REC[k], sh = recSheet(book, k), n = def.head.length + 1, t = T(def.src), ids = colOf(t, 0), rows = [];
    colOf(t, 4);
    for (var i = 0; i < ids.length; i++) {
      if (t.deleted[i]) continue;
      var d; try { d = unpack(cellJson(t, i)); } catch (e) { continue; }
      var r0 = def.row(d, ids[i], cx); if (r0) rows.push(recClean(r0, ids[i]));
    }
    var last = sh.getLastRow(); if (last > 1) sh.getRange(2, 1, last - 1, n).clearContent();
    if (rows.length) { recRows(sh, 2, rows.length); var rg = sh.getRange(2, 1, rows.length, n); rg.setNumberFormat('@'); rg.setValues(rows); }
    report.push(def.tab + ': ' + rows.length);
  });
  _tabs = {};
  return report;
}
function recReadMe(book, grp) {
  var sh = book.getSheets()[0];
  if (sh.getName() !== 'Read me') { try { sh.setName('Read me'); } catch (e) { } }
  var who = REC_GROUPS[grp], tabs = recKeysOf(grp).map(function (k) { return '  ' + REC[k].tab; });
  var lines = [recBookTitle(grp), '',
    'This sheet is written for people to read. Every row is one record in plain words.',
    'It is filled in AUTOMATICALLY (within about a minute) each time the ' + who + ' account saves, edits or deletes a record in the portal.',
    '', 'Tabs:'].concat(tabs).concat([
    '', 'Please do NOT type in these tabs: the next save would overwrite your change. To correct a record, edit it in the portal.',
    'The last column of every tab (Record ID) is how the portal finds the row. Do not change or delete it.',
    'Use the filter buttons in the first row to search, sort or filter. Use File > Download to get Excel or PDF copies.',
    '', 'PRIVACY: this sheet is for the ' + who + ' account only. Share it (Share > Viewer) only with people allowed to see these records.',
    grp === 'payroll' ? 'It holds salaries and pay deductions. Share it only with the Payroll officer and the school head.' : grp === 'admin' ? 'It lists the portal accounts (never passwords): employee accounts and student accounts.' : grp === 'guidance' ? 'It holds health and counseling information.' : grp === 'hr' ? 'It holds personal and government ID numbers of employees.' : '',
    'Each school appears in the School column.']);
  sh.clear(); sh.getRange(1, 1, lines.length, 1).setValues(lines.map(function (l) { return [l]; }));
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(14); sh.setColumnWidth(1, 760);
}

/* ============================== web app entry ============================== */
function runCall(actor, c) {
  switch (c.k) {
    case 'me': return meInfo(actor);
    case 'get': return opGet(makeS(actor), c);
    case 'list': return opList(makeS(actor), c);
    case 'count': return opCount(makeS(actor), c);
    case 'poll': return pollVersions(actor);
    case 'batch': {
      if (!Array.isArray(c.ops) || c.ops.length > 500) fail('invalid-argument', 'Too many changes at once.');
      var lock = LockService.getScriptLock(), res; lock.waitLock(25000);
      try { res = commit(actor, c.ops); } finally { lock.releaseLock(); }
      mirrorOps(c.ops);          // copy the change into the readable Records sheet (never blocks or fails the save)
      return res;
    }
    case 'fn':
      bumpVersions(actor.me.schoolId, ['users', 'employees', 'students', 'registry', 'classes', 'enrollmentRecords', 'studentAccounts']);   // account actions change these
      switch (c.name) {
        case 'changePassword': return actChangePassword(actor, c.data || {});
        case 'createAccount': return actCreateAccount(actor, c.data || {});
        case 'adminSetTempPassword': return actSetPassword(actor, c.data || {});
        case 'adminBulkSetPassword': return actBulkSetPassword(actor, c.data || {});
        case 'adminSendReset': return actSendReset(actor, c.data || {});
        case 'adminDeleteUser': return actDeleteUser(actor, c.data || {});
        case 'registrarDropStudentAccount': return actRegistrarDropStudentAccount(actor, c.data || {});
        case 'superClearSchoolData': return actEraseSchool(actor, c.data || {}, false);
        case 'superDeleteSchool': return actEraseSchool(actor, c.data || {}, true);
        case 'allocIds': return actAllocIds(actor, c.data || {});
        case 'hrCandidates': return actHrCandidates(actor);
        case 'hrSyncAccounts': return actHrSyncAccounts(actor);
        case 'hrDeleteEmployee': return actHrDeleteEmployee(actor, c.data || {});
        case 'hrAdminGet': return actHrAdminGet(actor);
        case 'hrAdminSave': return actHrAdminSave(actor, c.data || {});
        case 'adminSetPhoto': return actAdminSetPhoto(actor, c.data || {});
      }
  }
  fail('invalid-argument', 'Unknown request.');
}
function handle(req) {
  switch (req.action) {
    case 'login': return { ok: true, data: actLogin(req) };
    case 'resetRequest': return { ok: true, data: actResetRequest(req) };
    case 'resetConfirm': return { ok: true, data: actResetConfirm(req) };
    case 'ping': return { ok: true, data: { time: nowMs() } };
    case 'multi': {
      var actor = loadActor(req.token), results = [];
      (req.calls || []).forEach(function (c) {
        try { results.push({ ok: true, data: runCall(actor, c) }); }
        catch (e) { _tabs = {}; results.push({ ok: false, error: { code: e.code || 'internal', message: e.code ? e.message : 'Something went wrong. Please try again.' } }); }
      });
      return { ok: true, results: results };
    }
  }
  fail('invalid-argument', 'Unknown request.');
}
function doPost(e) {
  var out;
  try { out = handle(JSON.parse(e.postData.contents)); }
  catch (err) { _tabs = {}; out = { ok: false, error: { code: err.code || 'internal', message: err.code ? err.message : 'Something went wrong. Please try again.' } }; if (!err.code) console.error(err && err.stack || err); }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
var CODE_VERSION = 'HR-4';
function doGet() { return ContentService.createTextOutput('ARK Exam Portal API is running. Version: ' + CODE_VERSION); }

/* ============================== spreadsheet menu: first-time setup ============================== */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('ARK Portal')
    .addItem('1. First-time setup', 'menuSetup')
    .addItem('2. Create / reset the Super Admin', 'menuSuper')
    .addItem('3. Set the website address (for password-reset emails)', 'menuSite')
    .addSeparator()
    .addItem('4. Create the readable sheets (one per user type)', 'menuRecordsCreate')
    .addItem('5. Refresh the readable sheets (rewrite everything)', 'menuRecordsRefresh')
    .addItem('6. Use an existing Google Sheet for one user type', 'menuRecordsLink')
    .addItem('7. Speed up saving (turn on background sync)', 'menuSpeedOn')
    .addToUi();
}
function menuSetup() {
  var ui = SpreadsheetApp.getUi();
  if (!prop('SECRET')) { setProp('SECRET', newId() + newId() + newId()); setProp('PEPPER', newId() + newId()); }
  setProp('SHEET_ID', SpreadsheetApp.getActiveSpreadsheet().getId());
  if (!prop('FOLDER_ID')) setProp('FOLDER_ID', DriveApp.createFolder('ARK Exam Portal files (do not delete)').getId());
  ['users', 'schools', AUTH_TAB].forEach(function (n) { T(n); });
  _tabs = {};
  ui.alert('Setup done', 'Next: ARK Portal > "2. Create / reset the Super Admin". Then deploy this script as a Web app (see README).', ui.ButtonSet.OK);
}
function menuSuper() {
  var ui = SpreadsheetApp.getUi();
  if (!prop('SECRET')) { ui.alert('Run "1. First-time setup" first.'); return; }
  var e = ui.prompt('Super Admin email', 'This is the Super Admin sign-in (no school code).', ui.ButtonSet.OK_CANCEL); if (e.getSelectedButton() !== ui.Button.OK) return;
  var n = ui.prompt('Super Admin name', 'Shown at the top of the page.', ui.ButtonSet.OK_CANCEL); if (n.getSelectedButton() !== ui.Button.OK) return;
  var p = ui.prompt('Password', 'At least 10 characters, with a letter and a number. You can change it later.', ui.ButtonSet.OK_CANCEL); if (p.getSelectedButton() !== ui.Button.OK) return;
  var email = e.getResponseText().trim().toLowerCase(), pw = p.getResponseText();
  if (!isEmail(email) || !strongEnough('superadmin', pw)) { ui.alert('Enter a valid email and a password of at least 10 characters with a letter and a number.'); return; }
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var a = authFindByKey(email), uid = a ? a.uid : newId(), old = a ? getDoc('users', uid) : null;
    putDoc('users', uid, Object.assign(old || {}, { uid: uid, role: 'superadmin', displayName: n.getResponseText().trim() || 'Super Admin', email: email, status: 'active', mustChangePassword: false, createdAt: (old && old.createdAt) || { __ts: nowMs() } }));
    if (a) authSetPassword(uid, pw); else authCreate(uid, [email], pw);
    flushAll();
  } catch (err) { rollback(); throw err; } finally { lock.releaseLock(); }
  ui.alert('Super Admin ready', 'Sign in with ' + email + ' (leave the school code blank).', ui.ButtonSet.OK);
}
function menuSite() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Website address', 'The address of your site WITHOUT the page name, for example https://yourname.github.io/ARK-Exam-Portal', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var u = r.getResponseText().trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^\s]+$/.test(u)) { ui.alert('Enter a full address starting with https://'); return; }
  setProp('SITE_URL', u); ui.alert('Saved', u, ui.ButtonSet.OK);
}

/* ---------- readable sheets: menu actions ---------- */
function groupLinks() { return REC_ORDER.map(function (g) { var id = prop(recIdProp(g)); return REC_GROUPS[g] + ': ' + (id ? SpreadsheetApp.openById(id).getUrl() : '(not created)'); }); }
function finishRecords(book, grp) { recReadMe(book, grp); var rep = recRebuild(book, grp); try { book.setActiveSheet(book.getSheets()[0]); } catch (e) { } return rep; }
function installMirrorTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'mirrorFlush') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('mirrorFlush').timeBased().everyMinutes(1).create();
  setProp('MIRROR_ASYNC', '1');
}
function menuRecordsCreate() {
  var ui = SpreadsheetApp.getUi();
  if (!prop('SECRET')) { ui.alert('Run "1. First-time setup" first.'); return; }
  var made = [], rep = [];
  REC_ORDER.forEach(function (g) {
    if (prop(recIdProp(g))) return;
    var book = SpreadsheetApp.create(recBookTitle(g));
    setProp(recIdProp(g), book.getId()); made.push(g);
    rep = rep.concat(finishRecords(book, g));
  });
  try { installMirrorTrigger(); } catch (e) { ui.alert('Almost done', 'The sheets were created, but the background sync could not be turned on (' + e.message + '). Run "7. Speed up saving" and allow the permission it asks for.', ui.ButtonSet.OK); }
  ui.alert(made.length ? 'Readable sheets created' : 'The readable sheets already exist',
    groupLinks().join('\n') + (rep.length ? '\n\n' + rep.join('\n') : '') + '\n\nEach user type has its OWN Google Sheet: share each one (Viewer) only with that user type. They fill in automatically about a minute after each save.' +
    (prop('RECORDS_ID') ? '\n\nThe old combined Records sheet is no longer updated. You can keep it as an archive or delete it.' : ''), ui.ButtonSet.OK);
}
function menuRecordsRefresh() {
  var ui = SpreadsheetApp.getUi(), rep = [], any = false;
  REC_ORDER.forEach(function (g) { var b = recBook(g); if (!b) return; any = true; try { b.rename(recBookTitle(g)); } catch (e) { } rep = rep.concat(finishRecords(b, g)); });
  if (!any) { ui.alert('Create the readable sheets first (menu item 4).'); return; }
  setProp('RECORDS_STALE', ''); setProp(MQ, '');
  ui.alert('Readable sheets refreshed', groupLinks().join('\n') + '\n\n' + rep.join('\n'), ui.ButtonSet.OK);
}
function menuRecordsLink() {
  var ui = SpreadsheetApp.getUi();
  if (!prop('SECRET')) { ui.alert('Run "1. First-time setup" first.'); return; }
  var g = ui.prompt('Which user type?', 'Type one of: ' + REC_ORDER.join(', '), ui.ButtonSet.OK_CANCEL); if (g.getSelectedButton() !== ui.Button.OK) return;
  var grp = g.getResponseText().trim().toLowerCase(); if (REC_ORDER.indexOf(grp) < 0) { ui.alert('Please type exactly one of: ' + REC_ORDER.join(', ')); return; }
  var r = ui.prompt('Existing Google Sheet for ' + REC_GROUPS[grp], 'Paste the address (URL) of an EMPTY Google Sheet you own. The portal will add its tabs to it.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var m = /\/d\/([A-Za-z0-9_-]+)/.exec(r.getResponseText()) || /^([A-Za-z0-9_-]{20,})$/.exec(r.getResponseText().trim());
  if (!m) { ui.alert('That does not look like a Google Sheet address.'); return; }
  var book; try { book = SpreadsheetApp.openById(m[1]); } catch (e) { ui.alert('That sheet could not be opened. Make sure you own it or can edit it.'); return; }
  setProp(recIdProp(grp), book.getId()); delete _books[grp];
  var rep = finishRecords(book, grp);
  ui.alert(REC_GROUPS[grp] + ' sheet linked', book.getUrl() + '\n\n' + rep.join('\n'), ui.ButtonSet.OK);
}
function menuSpeedOn() {
  var ui = SpreadsheetApp.getUi();
  try { installMirrorTrigger(); } catch (e) { ui.alert('Could not turn it on', e.message + '\n\nIf Google asks for permission, allow it, then run this menu item again.', ui.ButtonSet.OK); return; }
  ui.alert('Background sync is on', 'Saving in the portal is now faster: the readable sheets are updated by a background job that runs every minute (so they can be up to about a minute behind).', ui.ButtonSet.OK);
}
