# AOBA PMOS — Progress Notes

Internal product/catalog management tool for AOBA. Read this first in any new session
to pick up where things left off — chat history does not persist across sessions
started from a different working directory, so this file is the source of truth.

## Stack

- Frontend: static HTML/CSS/JS, no build step — `public/desktop.html`
- Backend: Vercel serverless functions (Node, no framework) — `api/`
- Data: Supabase (Postgres + Auth + Storage) — migrations in `supabase/migrations/`
- Repo: https://github.com/ayanagarwalwork-droid/vercel (branch `main`)

## Local dev

```bash
npm install
npx vercel dev
```

Needs `.env.local` (copy from `.env.example`) with real Supabase credentials — see `SETUP.md`.

## Modules (all implemented per README)

Dashboard, Styles, Listings, EAN/Barcode, Reports, Costing, Search, Audit Trail, Import,
User Management, Roles & Permissions, Stitch, Settings, Guide.

API routes under `api/`: `_lib`, `agent`, `audit`, `auth`, `ean`, `import`,
`invites`, `listings`, `roles`, `styles`, `users`. That's 10 of Vercel Hobby's 12-function cap —
two slots of headroom; consolidate into an existing catch-all handler before adding a 13th.

## EAN is a SKU property, not a Listing property

Originally EAN lived on `listings` (one row per SKU-on-a-marketplace), which meant a SKU needed a
Listing to exist before it could get an EAN. In practice Listings were never created for most of
the catalog (54 Styles, 0 Listings, ever) — every EAN assign/import silently had nothing to
attach to. Root-caused by inspecting the live Supabase data and the Audit Trail (four identical
"Imported 0 rows from ean-template.csv" entries from 1 Aug), then fixed by decoupling EAN from
Listings entirely:

- New `skus` table (migration `0008_add_skus_table.sql`) — one row per style+color+size,
  independent of Listings. Backfilled for all existing styles.
- `skus` rows are auto-created whenever a style is created (manually or via CSV import) or has
  its sizes changed — see `api/_lib/skus.js`'s `syncSkusForStyle()`, called from
  `api/styles/handler.js` and `api/import/handler.js`. Only ever adds rows, never deletes, so a
  shrunk size list can't silently drop a SKU that already has an EAN.
- `api/ean/handler.js` (replaces the old `api/ean/assign.js`) now reads/writes `skus`, not
  `listings`. `GET /api/ean` lists all SKUs (joined with style name/category) for the EAN/Barcode
  page; `POST /api/ean/assign` is unchanged at the URL level.
- `api/import/handler.js`'s EAN import now matches by SKU directly against `skus`, validates the
  EAN format (8/12/13/14 digits) before writing, and reports a `skipped` count for rows that
  didn't match or had a bad EAN — so a bad import is visibly non-silent now.
- Frontend: new `SKUS_DATA` array (`public/desktop.html`), fetched via `GET /api/ean` in
  `loadAllData()`. EAN/Barcode page, Dashboard's "Missing EANs" stat, and Reports' "Missing EAN"/
  "Barcode Pending" tabs all read from it instead of `LISTINGS_DATA`. The EAN page's Marketplace
  filter/column was removed since EAN is no longer marketplace-specific.
- `listings.ean` / `listings.ean_status` columns were deliberately **not** dropped from the DB
  (still there, just unused going forward) to avoid a destructive migration.
- Also fixed while in there: Audit Trail showed "UNDEFINED" for every Import/Assign action — its
  action-label/class maps and filter dropdown only knew about Create/Update/Delete/Login/Export/
  Permission. Added Import and Assign.
- **Not yet applied to the live Supabase project** — migration `0008` needs to be run (SQL
  Editor) before this deploys correctly. Until then the live site is still on the old
  listings-based EAN code.

## Combined Style + Image + EAN import

Added as a 4th, separate Import tab (`Style + Image + EAN`) — not merged into the existing Styles
import, per explicit request. New route `POST /api/import/style-ean` in `api/import/handler.js`
(`importStyleEan`), new migration `0009_add_combined_import_type.sql` (adds `style_ean` to the
`import_type` enum — run and commit on its own, same enum-in-a-transaction restriction as 0006).

Shape is **one row per SKU** (Style ID, Style Name, Color, Size, Status, HSN, MRP, Cost Price,
Description, up to 4 Image URLs, EAN) — unlike the plain Styles import, which is one row per style
with a comma-separated sizes list. Rows are grouped by Style ID server-side: the style is
created/updated once (colors/sizes = the distinct values seen across that style's rows — since
they're explicit here, not guessed, colors *can* be safely updated on re-import, unlike the plain
Styles import path), `syncSkusForStyle()` ensures every color×size SKU exists, then each row's EAN
(if present and valid) is assigned to that specific SKU. `updateExisting` checkbox works the same
as the Styles tab.

## Costing dashboard

New standalone "Costing" sidebar page (per user's explicit choice — not a tab inside Style
Detail). Bill-of-materials cost breakdown per style, modeled directly on the team's existing
per-style Excel costing sheets: item x consumption x rate = amount, rolled up to SKU Cost, plus a
per-style editable Overhead % (defaults 15%), to Total Cost.

- New table `style_costing_items` (migration `0011_add_costing_tables.sql`) — one row per line
  item per style. New `styles.overhead_pct` column (default 15), also added in 0011.
- New module `Costing` (migration `0010_add_costing_module.sql` — must run and commit alone
  first, same enum restriction as 0006/0009). Default permissions: none for everyone except
  Founder/Admin (edit) — conservative default, same pattern as Stitch.
- Backend: folded into `api/styles/handler.js` as a `costing` sub-route (`GET`/`POST
  /api/styles/costing`) rather than a new serverless function — the app was already at 11/12 of
  Vercel Hobby's function cap.
- Frontend: overview table (image, code, name, category, SKU Cost, Overhead, Total Cost) plus an
  edit modal with an editable item grid. Default item list (Fabric, Cups, swimwear tap, Buckle,
  Cutting, Stiching, Finish/Pack, Tag, Photoshoot, Thread, Pattern) is shown as a **starting
  point** for styles with no costing yet — freely editable/addable/removable per style, not a
  fixed schema (per explicit instruction: "many things are fixed only some additions will be
  there... use this template as of now").

**IMPORTANT — open question, ask before considering this done:** whether the computed Total Cost
should feed into/replace the existing `styles.cost_price` field (used by Reports' "Costing
Pending" tab, Dashboard health stats, etc.) or stay a separate, independent number. The user
explicitly said "will tell later — remember it for now that you have to ask it later." **Ask
about this the next time Costing comes up**, don't just decide it. Right now `cost_price` and the
new costing breakdown are completely independent — Total Cost does not touch `cost_price`.

## Stitch (the only AI chat feature now — AI Copilot was removed; renamed from "AI Agent")

Renamed via migration `0012_rename_ai_agent_to_stitch.sql` (`alter type app_module rename value
'AI Agent' to 'Stitch'` — renames every existing `role_permissions` row in place, no data
migration needed, unlike adding a new enum value this doesn't need to run in isolation but was
kept as its own migration file for consistency anyway).

`api/agent/chat.js` — a real tool-using agent (Sonnet). It queries Supabase live via read tools
(`search_styles`, `search_listings`, `search_skus`, `get_audit_log`, `get_import_history`,
`get_catalog_health_summary`) and, only for callers with **edit** access to the `Stitch` module,
can invoke a small whitelisted set of write tools (`assign_ean`, `update_listing_status`,
`update_style_status`) — each one mirrors an existing manual endpoint's validation and writes the
same audit log entry (tagged "via Stitch"). View-only access to the module still allows chat/read
tools, just not the write ones — enforced per-call server-side, not just at the door.

**"Get Feedback" quick action** (per explicit request: "should give me feedback time to time on
what I can improve"): a prominent button on the Stitch page sends a prompt asking for a
prioritized improvement report. `get_catalog_health_summary` is a dedicated one-shot tool
(counts: missing images/EAN/costing, listing status breakdown, days since last import, recent
audit+import activity) so the model doesn't have to piece this together from several slower
`search_*` calls — the system prompt tells it to call this tool first whenever asked for
feedback/a health check. **Deliberately on-demand, not scheduled** — the user chose "on-demand
button" over "automatic scheduled digest" (which would need a new table, Vercel Cron, and a
notification UI) when asked to pick; that's a real follow-up to build later if they want it, not
implemented now.
enforced per-call server-side, not just at the door.

New DB migrations `0006_add_ai_agent_module.sql` (adds the `Stitch` enum value — must be run
and committed on its own) and `0007_seed_ai_agent_permissions.sql` (grants edit to Founder/Admin
only by default; grant more roles via Roles & Permissions in-app). Confirmed working live.

**AI Copilot was removed** (originally a simpler stats-snapshot-only chat, Haiku-based, no tool
use — superseded by Stitch). Removed: `api/copilot/` (whole folder, deleted), the `page-ai`
frontend page/nav item/JS in `desktop.html`, and all `AI Copilot` references from ROLES fallback
perms, `PERM_SECTIONS`, and the Guide article text. The `AI Copilot` value in the `app_module`
Postgres enum and any `role_permissions` rows referencing it were **not** removed (Postgres can't
drop a single enum value without recreating the type — left as harmless unused data, same
philosophy as the unused `listings.ean` columns). Function count dropped back to 10/12.

## Recent work (most recent first, from git log)

- Verified single Vercel production deployment
- Option to update existing styles on re-import instead of skipping
- Normalize Google Drive links in CSV style imports
- Allow deleting users who have history (styles/imports/invites/audit log)
- Auto-clear accepted invites from Pending list; add forgot-password
- Set-password step for first login after an invite
- Redirect bare domain root to `/desktop.html`
- Photo reordering + Google Drive share-link support
- Fixed API routing to use `vercel.json` rewrites (Vercel Hobby's 12-function limit)
- Removed Google sign-in UI (revisit later)

## Known open items / things to revisit

- Google sign-in was removed from the login UI — intentionally deferred, not implemented.
- No other outstanding TODOs known as of this note; check `git log` and `git status`
  for anything newer than the entries above.

## Working-directory note (why this file exists)

A prior work session on this project was run from `E:\Ayan Artifi` (the parent folder)
rather than from inside this project directory, so its Claude Code session transcript
was not saved under a project-specific history and could not be recovered. To avoid
losing context again:

- Always start Claude Code **from inside this folder** (`AOBA-Catalogue-Builder`), not a parent.
- Commit early and often — git history is the durable record, chat history is not.
- Update this file at the end of a session with anything not yet committed or worth
  flagging for next time.
