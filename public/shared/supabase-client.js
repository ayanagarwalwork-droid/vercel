// Browser-side Supabase client. The project URL and anon key are safe to be
// public (that's how Supabase is designed to be used client-side) — access
// control is enforced by the /api/* layer, not by keeping these secret.
// See supabase/migrations/0001_enums_and_tables.sql for why RLS is skipped
// and revoked instead.
//
const SUPABASE_URL = 'https://bhiffvwkiwzbxgnychpx.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_4v9dVKkzm-ezxfvr319R1w_5SA1UK89';

// Loaded via the Supabase CDN <script> tag in desktop.html, which exposes a
// global `supabase.createClient`.
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function getAccessToken() {
  const { data } = await sb.auth.getSession();
  return data?.session?.access_token || null;
}
