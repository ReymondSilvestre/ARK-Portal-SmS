/* What is kept about an employee (shared by the HR page and the IT Admin's Employee registration page). */
/* ---------- what is kept about an employee ---------- */
export const STATUSES = ["Active", "On leave", "Resigned", "Retired", "Terminated"];
export const TYPES = ["Regular", "Probationary", "Contractual", "Part-time", "Substitute"];
export const ACCESS = [["", "No portal account needed"], ["teacher", "Faculty / Teacher"], ["registrar", "Registrar"], ["finance", "Finance"], ["payroll", "Finance - Payroll"], ["custodian", "Custodian"], ["guidance", "Guidance"], ["hr", "HR"], ["staff", "Other staff (principal, librarian, nurse, guard, driver ...)"]];
export const ACCESS_NAME = Object.fromEntries(ACCESS.filter(([k]) => k).map(([k, v]) => [k, v])); ACCESS_NAME.admin = "IT Admin";
export const DEFAULT_LISTS = {
  positions: ["Teacher", "Head Teacher", "Principal", "Registrar", "Cashier / Finance Officer", "Payroll Officer", "Guidance Counselor", "Custodian", "School Nurse", "HR Officer", "IT Administrator", "Librarian", "Security Guard", "Janitor / Utility", "Driver", "Other"],
  departments: ["Elementary", "Junior High School", "Senior High School", "Administration", "Finance", "Registrar's Office", "Guidance", "Clinic", "Maintenance", "Security", "IT"],
};
export const FIELDS = [
  { id: "employeeId", label: "Employee No.", req: true, group: "Basic" },
  { id: "lastName", label: "Last name", req: true, group: "Basic" },
  { id: "firstName", label: "First name", req: true, group: "Basic" },
  { id: "middleInitial", label: "M.I.", narrow: true, max: 1, group: "Basic" },
  { id: "birthday", label: "Birthday", type: "date", req: true, group: "Basic" },
  { id: "gender", label: "Gender", type: "select", options: ["Male", "Female"], group: "Basic" },
  { id: "civilStatus", label: "Civil status", type: "select", options: ["Single", "Married", "Widowed", "Separated"], group: "Basic" },
  { id: "position", label: "Position", type: "list", list: "positions", group: "Job" },
  { id: "department", label: "Department", type: "list", list: "departments", group: "Job" },
  { id: "employmentType", label: "Employment type", type: "select", options: TYPES, group: "Job" },
  { id: "dateHired", label: "Date hired", type: "date", group: "Job" },
  { id: "status", label: "Status", type: "select", options: STATUSES, req: true, def: "Active", group: "Job" },
  { id: "accessType", label: "Portal account", type: "access", group: "Job", hint: "Only says what is needed. The IT Admin creates the account." },
  { id: "contact", label: "Contact No.", group: "Contact" },
  { id: "email", label: "Email", type: "email", group: "Contact", hint: "Optional. Used for password-reset links." },
  { id: "address", label: "Address", type: "textarea", group: "Contact" },
  { id: "emergencyName", label: "Emergency contact person", group: "Contact" },
  { id: "emergencyContact", label: "Emergency contact No.", group: "Contact" },
  { id: "sss", label: "SSS No.", group: "Government IDs" },
  { id: "philhealth", label: "PhilHealth No.", group: "Government IDs" },
  { id: "pagibig", label: "Pag-IBIG No.", group: "Government IDs" },
  { id: "tin", label: "TIN", group: "Government IDs" },
  { id: "prc", label: "PRC license No.", group: "Government IDs" },
];
export const GROUPS = ["Basic", "Job", "Contact", "Government IDs"];
/* the account type every position needs: the special pages for the offices below, "Other staff" for everybody else */
export const POSITION_ACCESS = { "Teacher": "teacher", "Head Teacher": "teacher", "Registrar": "registrar", "Cashier / Finance Officer": "finance", "Payroll Officer": "payroll", "Guidance Counselor": "guidance", "Custodian": "custodian", "HR Officer": "hr" };
export const accessFor = (pos) => (pos ? POSITION_ACCESS[pos] || "staff" : "");
