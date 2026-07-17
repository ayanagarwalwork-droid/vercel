# AOBA PMOS

Internal product/catalog management tool for AOBA. Static HTML/CSS/JS frontend
(`public/desktop.html`), Vercel serverless API (`/api`), Supabase for Postgres + Auth + Storage.

All app code is complete — Dashboard, Styles, Listings, EAN/Barcode, Reports, Search, Audit Trail,
Import, User Management, Roles & Permissions, AI Copilot, Settings, Guide. See `SETUP.md` for the
manual steps to connect it to a real Supabase project and deploy it.

## Local structure

- `public/desktop.html` — the app (migrated from the original prototype)
- `public/shared/` — browser-side Supabase client, API fetch wrapper, shared constants
- `api/` — Vercel serverless functions (Node, no framework, no build step)
- `supabase/migrations/` — SQL migrations, run in order against your Supabase project

## Local dev

```
npm install
npx vercel dev
```

Requires `.env.local` (copy from `.env.example`) with real Supabase credentials — see `SETUP.md`.
