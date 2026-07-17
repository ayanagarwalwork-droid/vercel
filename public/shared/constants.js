// New mapping needed for permission gating — the prototype's own ROLES/
// CATEGORIES consts already live inline in desktop.html's <script> and are
// left untouched, so this file only adds what didn't exist before: a way to
// translate a showPage(id) page id into the app_module name the permissions
// API uses, so the sidebar can be hidden/shown per the real permission matrix.
const MODULE_BY_PAGE_ID = {
  dashboard: 'Dashboard',
  styles: 'Styles',
  listings: 'Listings',
  ean: 'EAN / Barcode',
  reports: 'Reports',
  search: 'Search',
  audit: 'Audit Trail',
  ai: 'AI Copilot',
  import: 'Import',
  users: 'User Management',
  roles: 'Roles & Permissions',
  settings: 'Settings',
  guide: 'Guide',
};
