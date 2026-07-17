// Server-only Supabase client using the service-role key. This bypasses RLS
// entirely by design — see supabase/migrations/0001_enums_and_tables.sql for
// why (the Edit/View/None permission matrix is enforced in auth.js instead of
// RLS policies). NEVER import this file from anything under /public.
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  // Fail loudly at cold-start rather than surfacing a confusing runtime error
  // on the first request.
  throw new Error(
    'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars. ' +
    'Set them in .env.local (dev) or Vercel Project Settings (prod).'
  );
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

module.exports = { supabaseAdmin };
