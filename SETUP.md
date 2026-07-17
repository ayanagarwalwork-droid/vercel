# Setup — connecting the deployed app to real infrastructure

All four phases are fully coded: schema, every API endpoint, and the entire frontend migration
(auth, users, roles, styles, listings, EAN, import, audit, reports/search, AI Copilot) are done
and verified locally to load and run with zero JS errors. Nothing is connected to a real Supabase
project yet — that's everything below, and it's entirely manual dashboard/account work (things
only you can do) rather than more code.

## 1. Create the Supabase project

1. Go to supabase.com → New project. Pick any name/region/password (the DB password isn't used
   directly by this app — only the API keys below matter).
2. Once it's provisioned, go to **Settings → API** and copy:
   - **Project URL**
   - **anon / public key**
   - **service_role key** (click reveal — keep this one secret)
3. Go to **Database → Extensions** and confirm `pgcrypto` is enabled (needed for `gen_random_uuid()`
   — it's on by default on new Supabase projects, but worth a quick check).

## 2. Run the migrations, in order

In the Supabase dashboard, open **SQL Editor**, paste and run each file from
`supabase/migrations/` **in this exact order**:

1. `0001_enums_and_tables.sql` — all enums + tables, revokes default public grants
2. `0002_seed_categories.sql` — the 25 fixed style categories + their SKU-group counters
3. `0003_seed_role_permissions.sql` — the 8×13 role/module permission matrix
4. `0004_sku_engine_function.sql` — the `create_style_with_code` RPC (race-condition-safe style
   code generation)
5. `0005_storage_buckets.sql` — creates the public `style-images` bucket

## 3. Wire up the real Supabase URL/anon key in the frontend

Edit `public/shared/supabase-client.js` and replace the two placeholder constants at the top with
your real Project URL and anon key from step 1. These are meant to be public/client-visible — see
the comment in that file for why.

## 4. Set the server-only env vars

Copy `.env.example` to `.env.local` and fill in:
- `SUPABASE_URL` — same Project URL as above
- `SUPABASE_SERVICE_ROLE_KEY` — the service_role key (never commit this, never put it in anything
  under `public/`)
- `ANTHROPIC_API_KEY` — from console.anthropic.com, powers the AI Copilot page. Every other page
  works fine without it; Copilot will just return a clear "not configured yet" error until it's set.
- `SITE_URL` — `http://localhost:3000` for local dev; your real Vercel URL once deployed

In Vercel (once the project exists, see step 8), set all four the same way under **Project
Settings → Environment Variables** (Production + Preview scopes).

## 5. Create the first Founder user

There's a chicken-and-egg problem: inviting a user requires being logged in as an Admin/Founder,
but nobody exists yet. Bootstrap the first one manually:

1. Supabase dashboard → **Authentication → Users → Add user** → enter your email + a password,
   check "Auto Confirm User" so you don't need to click an email link.
2. Copy the new user's UUID (shown in the users list).
3. Back in **SQL Editor**, run:
   ```sql
   insert into profiles (id, name, email, role, status)
   values ('PASTE-THE-UUID-HERE', 'Your Name', 'you@yourcompany.com', 'Founder', 'active');
   ```
4. You can now log in at `/desktop.html` with that email/password, and use the in-app **Invite**
   button to bring on everyone else properly from here on.

## 6. (Optional) Enable Google sign-in

1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID (type: Web
   application). Add `https://<your-supabase-project-ref>.supabase.co/auth/v1/callback` as an
   authorized redirect URI.
2. Supabase dashboard → **Authentication → Providers → Google** → paste the Client ID and Client
   Secret from Google, enable the provider.
3. That's it — the "Sign in with Google" button on the login page already calls
   `supabase.auth.signInWithOAuth({ provider: 'google' })`. Remember: a Google sign-in only works
   for an email that already has a `profiles` row (i.e. was invited) — it's an alternate
   credential for an existing account, not open self-signup.

## 7. (Optional) Confirm the storage bucket

Migration `0005` already created the `style-images` bucket via SQL, but it's worth a quick check
in **Storage** in the Supabase dashboard that it exists and is marked public. Nothing else to
configure — uploads go through signed URLs minted server-side, so no bucket policies are needed.

## 8. Push to GitHub + connect Vercel

```
git add .
git commit -m "AOBA PMOS: Supabase + Vercel backend for the full app"
```

Then create an empty repo on GitHub, and:
```
git remote add origin https://github.com/YOUR-ORG/aoba-pmos.git
git branch -M main
git push -u origin main
```

In Vercel: **Add New → Project → Import** the GitHub repo. Vercel auto-detects the `/api`
functions and serves `/public` as static files — no build command needed. Add all four env vars
from step 4 before the first deploy.

## 9. Smoke test

**Auth & permissions**
- Log in as the Founder user from step 5 → confirm the full sidebar is visible.
- Invite a second user with a restricted role (e.g. Warehouse) → have them accept the email
  invite and set a password → log in as them → confirm their sidebar only shows Dashboard,
  Listings, and Import.
- As Founder, open **Roles & Permissions**, change a cell, save, refresh the page, confirm the
  change persisted (i.e. it's really in Postgres).

**Styles / Listings / EAN**
- Create a new style, confirm the style code it gets follows `{CATEGORY}-{N}` and N looks right
  for that category's group.
- Add a listing for one of its SKUs, mark it "live", confirm a launch date gets set automatically.
- Assign an EAN to that SKU from the EAN page, confirm its status flips to Assigned.
- Edit the style and upload a product photo — confirm it appears in Supabase Storage under
  `style-images/` and the style's detail view shows it.

**Import / Audit**
- Download a CSV template from the Import page, fill in one row, upload it, confirm it appears in
  Import History and the new row shows up on the Styles/Listings/EAN page as appropriate.
- Open Audit Trail (after logging back in, so it re-fetches) and confirm the actions above are
  all logged with the right actor name.

**AI Copilot**
- Ask "how many active styles do we have?" and confirm the number matches the Dashboard stat
  exactly (that's the whole point of grounding it in real data instead of letting it guess).
