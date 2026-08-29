# AOBA PMOS — Progress Notes

Internal product/catalog management tool for AOBA. Read this first in any new session
to pick up where things left off — chat history does not persist across sessions
started from a different working directory, so this file is the source of truth.

## Fixed — silent 1000-row data cap that was hiding most of the catalog

Discovered 2026-08-25 while testing unrelated features, after the Founder's 2026-08-24 bulk
import pushed the catalog well past 1000 styles / SKUs. Every `GET` that fetches a full table with
no `.limit()` is silently capped at **1000 rows by PostgREST's own default** — not something in
this app's code, and not something a bare `.select('*')` with no `.limit()` call overrides.
`STYLES_DATA` and `SKUS_DATA` on the frontend were confirmed truncated at exactly 1000, ordered
oldest-first (`styles`) or alphabetically (`skus`) — meaning most of the catalog was silently
invisible on Styles, EAN/Barcode, Reports, and Costing, with no error anywhere.

Fixed with a shared `fetchAll()` helper (`api/_lib/fetchAll.js`) that loops with `.range()` until
a page comes back short of 1000, so it correctly retrieves everything no matter how large a table
grows — no Supabase project setting needed, purely a code-level fix. Applied to every affected
`GET`: `/api/styles`, `/api/styles/costing`, `/api/ean`, `/api/listings`, `/api/import/history`.
`/api/audit` was deliberately left alone — it already does real range-based pagination with a
sane default (500, capped at 2000), which is the right design for an activity feed; the bug here
was specifically about tables the app needs to load *completely* to work correctly.

**Known scaling limit to watch, not fixed:** `fetchAll()` makes one sequential round-trip per
1000 rows within a single serverless function call, which stays comfortably under Vercel Hobby's
timeout at the catalog's current size, but would eventually need a different approach (real
UI-level pagination, caching, a materialized view) if any one table grows into the tens of
thousands of rows.

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

API routes under `api/`: `_lib`, `agent`, `audit`, `auth`, `backup`, `ean`, `import`,
`invites`, `listings`, `roles`, `styles`, `users`. That's 11 of Vercel Hobby's 12-function cap —
one slot of headroom left; consolidate into an existing catch-all handler before adding a 13th.

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

## Both Styles imports are one row per SKU, with a bundled SKU column

Both the plain **Styles & Images** import and the **Style + Image + EAN** import (added as a 4th,
separate Import tab, not merged into Styles, per explicit request) share the same row shape: one
row per SKU, not one row per style. The **SKU column bundles Style ID + Size into one field**
(`AOD-1A/S`) rather than separate Style ID / Size(s) columns — matches the format the team's own
master spreadsheet already uses, so that column can be copy-pasted straight in rather than split
apart first. Color stays its own column since the SKU Engine still needs it as a distinct value.
Style + Image + EAN adds one more column on top: EAN.

Originally the plain Styles import was one row *per style*, with a comma-separated `Sizes`
column — changed to match Style + Image + EAN's shape (and the master spreadsheet) on request.
Both routes now share one grouping/upsert helper, `upsertStylesFromRows()` in
`api/import/handler.js`: rows are grouped by Style ID server-side, the style is created/updated
once per group (colors/sizes = the distinct values seen across that style's rows — since they're
explicit here, not guessed, colors *can* be safely updated on re-import, unlike the old
one-row-per-style shape's `code.slice(-1)` guess), then `syncSkusForStyle()` ensures every
color×size SKU exists. `importStyleEan` calls the same helper and then does one extra pass
assigning each row's EAN (if present and valid) to its specific SKU. `splitBundledSku()` parses
the bundled SKU column, splitting on the *last* `/` (a Style ID can itself contain one).
`updateExisting` checkbox works the same on both tabs.

The Import page's "Export current data" button and the Styles page's "Export CSV" button
(`skuExportRows()` in `public/desktop.html`) were updated to the same bundled-SKU, one-row-per-SKU
shape too, so an exported CSV can be edited and dropped straight back into either import tab
without reshaping it — they'd otherwise have produced a CSV the new import format could no longer
read back in.

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

**Founder-only approval workflow** (migration `0013_add_costing_approval.sql`, adds
`styles.costing_status` text `'draft'|'approved'`, no enum — plain check constraint, no
transaction-isolation restriction to worry about): anyone with edit access to Costing (Founder,
Admin) can save the item grid and overhead %, but every save — Founder's own included — sets
`costing_status = 'draft'`. Only a Founder can flip it to `'approved'`, via a separate
`POST /api/styles/costing-approve` endpoint that checks `actor.role === 'Founder'` directly
(hardcoded, like Founder's permissions being immutable elsewhere) rather than going through the
Costing module's view/edit permission levels — approval is a sign-off, not a data-edit right, so
it's deliberately not something Roles & Permissions can delegate to another role. The "Approve &
Go Live" button in the costing modal only renders for `me.role === 'Founder'`, and only once
items exist and it isn't already approved.

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

## Reports — Old vs New SKUs

New "Old vs New SKUs" report tab (`sku-progress` in `REPORT_TABS`, `public/desktop.html`).
Splits every SKU into two tables using a rolling age window on `skus.created_at` (added to the
`GET /api/ean` response and `mapSkuFromApi` — wasn't previously sent to the frontend): "New" =
created within the last N days (7/14/30/60/90, selectable in the UI, defaults to 30), "Old" =
everything else. Deliberately a rolling window rather than a fixed cutoff date, so the split stays
useful as the catalog keeps growing rather than needing to be updated — this was one of a few
options discussed with the user (the others were a literal legacy-SKU-code-to-new-SKU-code
migration crosswalk, and a manual per-style Old/New tag); rolling window was their pick.

Each row shows a per-SKU completion checklist — Image (style has one), EAN (assigned), Costing
(style's `costing_status === 'approved'`), Listing (has a live listing for that SKU) — plus a
"Remaining" column listing exactly what's still missing, or "Complete" if nothing is. Logic lives
in `isNewSku()` / `skuRemainingItems()`, right above `renderReports()`.

## Real two-factor authentication (not just a toggle)

Found during a full-site audit: Settings → Security had a "Require 2FA for Founder & Admin"
toggle claiming to be "Enforced for all users with elevated roles," and User Management's
"Require 2FA on login for this user" checkbox saved `profiles.two_fa` — but nothing anywhere
actually checked that flag. Both were pure UI, no enforcement. Fixed for real, using Supabase
Auth's built-in MFA (TOTP):

- **Server-side (`api/_lib/auth.js`)** — the actual enforcement, not just a client gate. When
  `profile.two_fa` is true, `requireModulePermission()` decodes the bearer token's `aal`
  (Authenticator Assurance Level) claim — which Supabase's own servers set, not forgeable
  client-side — and rejects with `401 Two-factor authentication required.` unless it's `aal2`
  (meaning this session has actually completed an MFA challenge). `GET /api/auth/session` stays
  reachable at `aal1` regardless (it's called with no `module` argument), since the frontend needs
  it to even learn a challenge is required in the first place.
- **Login flow (`public/desktop.html`)** — new `checkMfaGate()`, called from the
  `onAuthStateChange` listener (both the normal password-login path and the invite/password-reset
  `submitNewPassword()` path) right before `completeLogin()`. Three outcomes: already `aal2` →
  proceed; a factor exists but unverified this session → show the code-entry screen
  (`showMfaPage('challenge')`); no factor and `profile.two_fa` is true → force enrollment
  immediately (`showMfaPage('enroll', totp)`, QR code + manual secret from
  `sb.auth.mfa.enroll()`) before letting them into the app at all. New `#mfaPage` markup mirrors
  the existing login-page split-screen layout.
- **Self-service (`Settings → Security`)** — the fake toggle is gone; replaced with a real
  "Two-Factor Authentication" card scoped to *your own* account (`renderMfaSettingsCard()`,
  `toggleMyMfa()`, `confirmMyMfaEnroll()`) — enroll/disable voluntarily, independent of whether an
  Admin has required it for you. `profiles.two_fa` stays purely the "does this account get forced
  into enrollment" policy flag; actual enrollment state lives in Supabase Auth
  (`sb.auth.mfa.listFactors()`), so the two can differ (required-but-not-yet-enrolled,
  or enrolled-voluntarily-but-not-required) without needing to keep them in sync.
- Session Timeout and IP Allowlist on the same Settings → Security page are **still fake** — out
  of scope for this pass, only 2FA was fixed. Their "Save changes" button still just shows a
  success toast.
- Known gap: if an Admin flips `two_fa` to required for someone **already logged in**, their next
  API call 401s with "Two-factor authentication required" rather than smoothly redirecting them
  into the enrollment screen — `checkMfaGate()` only runs on fresh login, not as a live mid-session
  interrupt. They'd need to log out and back in. Narrow edge case, not fixed yet.
- Both real accounts (Ayan Agarwal, aayuushi.aakar) are still `two_fa: false` — this change is
  purely additive, nothing forces either of them through enrollment until that's turned on
  per-account from User Management.

## Automated weekly backup

Also from the same audit — previously discussed as future work, never built, and became urgent
once Excel is being retired as the informal backup. `api/backup.js`, triggered by Vercel Cron
(`vercel.json`'s `crons` entry, `0 3 * * 0` — Sunday 3am UTC; Hobby plan allows once/day minimum
interval and actually fires sometime within that hour, not exactly on the second). Protected by a
new `CRON_SECRET` env var — Vercel automatically sends it as the request's Authorization header
once set, so no other wiring is needed.

Dumps `styles`, `skus`, `listings`, `style_costing_items`, `role_permissions`, `import_history`,
and `audit_log` (queried in parallel via `Promise.all`, to comfortably clear the Hobby plan's
10-second cron timeout) into one JSON bundle, uploads it to a new private Supabase Storage bucket
(migration `0014_add_backups_bucket.sql`), and logs an "Automated backup created" entry to the
Audit Trail via the existing `writeAudit()` helper — no new UI needed for visibility.
`profiles`/`invites` are exported as a count only, not full rows, so a leaked backup file doesn't
also leak every teammate's name/email.

**This is an interim storage location, not the final one** — the user explicitly said where it
should ultimately live is still to be decided. Everything above already produces a single
portable JSON file; only the final `supabaseAdmin.storage.from('backups').upload(...)` call in
`api/backup.js` needs to change once an external destination (email, Drive, S3, etc.) is chosen.
Storing it back in Supabase Storage today protects against a corrupted or accidentally-deleted
row, but *not* against losing the Supabase account itself — worth remembering that's still an
open gap until it moves off-platform.

## Founder-requested items (2026-08-25) — all 5 shipped (item 2 rebuilt 2026-08-29, see below)

Five items were requested together; #2 ("New Color of Existing Style") was built, tested, then
**deliberately reverted** on request — the user wants to make changes to it before it ships, so
it's fully absent from the codebase again for now, not just hidden. See below for what that
design was and where to pick it back up.

1. **Import history — no more 200-row cap, plus real pagination.** `GET /api/import/history` had a
   hardcoded `.limit(200)`; removed (needed the 1000-row PostgREST fix above too, done together).
   With the cap gone the list got genuinely long (283 real rows already) — added numbered-page
   pagination, 25 rows/page, via a new shared `renderPageNumbers()` helper (Prev/Next + a windowed
   run of page numbers with `…` for gaps, so it stays usable even at hundreds of pages). Reusable
   for other long lists later, not just this one.
2. **Costing defaults now prefilled**, not just item names: Finish/Pack ₹10, Tag ₹5, Photoshoot
   ₹10, Thread ₹2, Pattern ₹5 (consumption 1 × that rate). Fabric/Cups/swimwear tap/Buckle/
   Cutting/Stiching stay blank, still genuinely variable per style. `DEFAULT_COSTING_ITEMS` is now
   an array of objects instead of bare strings; still exactly 11 entries, still exactly one row
   each. Also added a **"↺ Reset to Default" button** (`resetCostingToDefault()`) next to "+ Add
   Item" — replaces the whole grid with the template, and works even on a style that already has
   saved costing (not just the auto-shown default on a brand-new one). Confirms before wiping the
   grid; nothing persists until Save Costing either way.
3. **MRP + Multiplier boxes on the Costing modal.** MRP is Founder-only (enforced both
   client-side — the input is disabled for anyone else — and server-side in
   `POST /api/styles/costing`, mirroring `costing-approve`'s pattern). Saving it writes straight to
   `styles.mrp`, so it shows up on the Styles page immediately. Multiplier = MRP ÷ Total Cost,
   computed live, shows "—" until both are non-zero.
4. **Reports: search SKUs by an explicit date range.** On the Old vs New SKU report, two date
   inputs sit alongside the rolling-window dropdown (same single row, not stacked — see layout
   note below) — when both are filled they override the New/Old bucket entirely (a separate
   "created between these two dates" search, not a refinement of it). Reuses the same per-SKU
   completion table already built for that report.

**Two follow-up tweaks after this shipped:** Reports now **defaults to the "New SKUs" view**
(`activeReportTab = 'sku-progress'`) instead of "Missing EAN" on first load. And the controls
above the SKU table were cluttered — the day-window dropdown and the date-range picker used to
stack on two separate lines; they're now one combined row (`or by exact date created:` sits
between them), same information, less vertical stacking.

All were tested against real production data (read-only, via a local proxy that serves edited
frontend files but forwards `/api/*` to the live backend — meaning backend-only changes couldn't
be exercised locally, only reviewed carefully and confirmed correct by re-reading). No live data
was written during testing.

### Held back: "New Color of Existing Style" — design notes for next time

A mode fork was built at the top of the New Style modal, alongside the existing "New Design"
flow: pick an existing style, type a new color name, PATCH that style's `colors` array instead of
creating a new style code — same name/MRP/cost price as the existing style, only the color (and
its SKUs) is new. Fully reverted from both frontend and backend (`git log --all --oneline -- public/desktop.html`
around 2026-08-25 shows the add-then-revert pair if picking this back up) —
`api/styles/handler.js`'s PATCH no longer accepts `colors` at all right now.

**Worth knowing before rebuilding it:** real catalog data uses full color names ("Magenta", "Navy
Blue"), not the single-letter A/B/C scheme the SKU Engine's own Guide article documents — the
reverted version had the user type the new color's name rather than auto-assigning the next
letter, since auto-lettering next to a real color name would've looked broken. This is the same
documented-rule-vs-real-practice mismatch already flagged in the SKU naming memory/open item, now
confirmed a second way — worth resolving that question generally before or alongside rebuilding
this feature, since it's the same underlying ambiguity.

**Update 2026-08-29 — rebuilt and shipped, letter-based.** The Founder confirmed auto-assigned
colors should stay letter-based (A, B, C…) rather than switching to real color names, so the
ambiguity above is resolved for *auto-generated* colors specifically (the letter is just the
internal SKU suffix, not a display name — real full-name colors elsewhere are untouched). See
"New Style & New Listing creation flows" below for the actual shipped design.

## New Style & New Listing creation flows (2026-08-29)

Both "+ New Style" and "+ Add Listing" now open a mode-chooser first instead of jumping straight
into a form, because each button was being asked to serve more than one real workflow.

**New Style → 3 modes** (`openStyleModeChooser()`):
- **A. New listing on an existing pattern** (`openSamePattern()` / `saveSamePattern()`) — pick an
  existing style, pick a *different* category, and the same pattern number carries over
  (`AISW-208` → `AIBW-208`). Only Name + Description prefill from the source (editable); sizes,
  images, and costing are fresh for the new category. Backend: new
  `POST /api/styles/same-pattern` — deliberately bypasses the `create_style_with_code` RPC and
  `style_number_counters` entirely (the number is reused, not drawn fresh), relying on the
  `styles.code` primary key for race-safe duplicate protection, same 23505-catch pattern as the
  main create endpoint.
- **B. A completely new listing** — unchanged, today's original `openNewStyle()` flow.
- **C. A new color in an existing SKU** (`openNewColorOnExisting()` / `saveNewColor()`) — this is
  the previously-reverted item 2, rebuilt: pick a style, the next letter (A, B, C…) is
  auto-assigned (not editable), nothing else to fill in since sizes/images/MRP/cost are style-level
  not per-color. Backend: `PATCH /api/styles/:code` gained an `add_color: true` flag that appends
  the next letter server-side and re-syncs `skus` — no new route needed.

**Add Listing → 2 modes** (`openListingModeChooser()`):
- **A. New listing** — unchanged `openAddListing()` form, minus the manual Master/Relisting `Type`
  dropdown (redundant now — the mode choice itself decides that, and `type` is derived
  server-side from `relist_prefix`).
- **B. Relisting of an existing listing** (`openRelistExisting()` / `saveRelist()`) — pick an
  existing listing, choose 1st (`M`) or 2nd (`T`) relisting (already-used prefixes are disabled;
  if both are taken, Save is blocked with a message pointing at the Founder rather than
  extrapolating a 3rd letter). Marketplace SKU prefills as `prefix + AOBA SKU`, editable.

  This finally implements the **relisting prefix rule** from 2026-08-25 (see "Known open items"
  below) — required a real schema change since `unique(sku, marketplace)` made a second row for
  the same pair physically impossible. Migration `0015_add_listing_relist_prefix.sql` adds
  `listings.relist_prefix text check (in '', 'M', 'T')` and replaces that constraint with
  `unique(sku, marketplace, relist_prefix)`. `openEditListing` had to move from a `(sku,
  marketplace)` lookup key to the listing's own `id`, since that pair is no longer unique on its
  own — this was a necessary side-effect fix, not optional.

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
- Settings → Security's Session Timeout and IP Allowlist fields are still fake — no backend,
  "Save changes" just shows a toast. Same issue 2FA had until this pass; not fixed yet.
- Settings → Integrations' "Google Drive — images & exports synced automatically" claim is still
  false — no real sync exists, same category of issue as the old 2FA toggle.
- Backup destination is still Supabase Storage (interim) — swap `api/backup.js`'s upload step for
  an external destination once one is chosen. See "Automated weekly backup" above.
- 2FA required-for-someone-already-logged-in doesn't redirect them into enrollment live — they
  hit a 401 until they log out and back in. See "Real two-factor authentication" above.
- Full-site audit findings not covered by the above (data completeness gaps, Reports'
  "Costing Pending" not reflecting the real Costing module, Roles & Permissions' off-by-one
  counter) are tracked in the PMOS Inspection Report artifact shared 20 Aug 2026, not duplicated
  here — the counter bug specifically is still unfixed as of this note.
- **SKU naming rule mismatch, pending Founder decision:** the documented SKU Engine rule (Guide →
  "SKU Engine explained") treats the color letter as a sub-variant of one shared style — same
  code, same MRP/cost price, just a different color. The team's real master spreadsheet instead
  uses codes like `AOD-1A` / `AOD-1B` as fully independent styles with different pricing each.
  Surfaced 2026-08-20; not yet resolved. Don't assume either convention is "correct" — ask before
  building anything that depends on style-code-vs-SKU pricing semantics.
- **Relisting prefix rule, given 2026-08-25 — implemented 2026-08-29.** See "New Style & New
  Listing creation flows" above for the shipped design (`openRelistExisting()`/`saveRelist()`,
  migration `0015_add_listing_relist_prefix.sql`). Still capped at `M`/`T` (2 relists) exactly as
  specified — the UI blocks a 3rd with a message rather than extrapolating a new letter; ask the
  Founder before ever raising that cap.

## Working-directory note (why this file exists)

A prior work session on this project was run from `E:\Ayan Artifi` (the parent folder)
rather than from inside this project directory, so its Claude Code session transcript
was not saved under a project-specific history and could not be recovered. To avoid
losing context again:

- Always start Claude Code **from inside this folder** (`AOBA-Catalogue-Builder`), not a parent.
- Commit early and often — git history is the durable record, chat history is not.
- Update this file at the end of a session with anything not yet committed or worth
  flagging for next time.
