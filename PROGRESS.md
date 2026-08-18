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

Dashboard, Styles, Listings, EAN/Barcode, Reports, Search, Audit Trail, Import,
User Management, Roles & Permissions, AI Copilot, Settings, Guide.

API routes under `api/`: `_lib`, `audit`, `auth`, `copilot`, `ean`, `import`,
`invites`, `listings`, `roles`, `styles`, `users`.

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
