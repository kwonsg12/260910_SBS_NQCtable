# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install              # first-time setup only
node server.js           # or: npm start — runs the shared server on :8000 (PORT env overrides)
npm test                 # node --test; runs every *.test.js in test/
node --test test/security.test.js          # run a single test file
node --test test/security.test.js -t "이름"  # run a single test by name (node:test -t filter)
npm run digest -- --dry-run   # preview today's daily summary email without sending
npm run digest -- --check     # verify SMTP login only
npm run digest                # send the daily summary email immediately
```

Node.js >= 22.5 is required (uses the built-in `node:sqlite` module — no native build step).

Tests spin up their own temporary server/DB per file (see `test/server-static.test.js`, `test/state-api.test.js`, etc.) and never touch `geunmupyo.db` or send real email/notifications.

## Architecture

This is a shift-scheduling ("근무표") web app for a small on-site team (4 employees, day/night/swing/off rotation), originally a localStorage-only prototype and now a small Node/Express server backed by SQLite.

**`index.html` is the entire client app** (~3300 lines, one inline `<script>`): rendering, state mutations, the admin/employee UI, PDF export, etc. all live there — there is no build step or bundler. `app.js` is legacy/unused (not referenced by `index.html`); don't confuse it with the real client code.

**State shape**: the client keeps one big `STATE` object (employees, approvers, requests, protects, approvals, excuses, settings, scheduleOverrides/Snapshots/Ranges, rotationAnchors, versions, monthlyApprovals, auditLogs, …) and either:
- persists it to `localStorage` under `ncq_schedule_v1` when opened as a static file / with `?storage=local` (no cross-PC sharing), or
- syncs it with the server via `GET/POST /api/state` when served by `server.js` (the normal, recommended mode).

**Server layers** (`server.js` wires these together):
- `db.js` — `node:sqlite` wrapper storing the *entire* STATE as one JSON blob in a `kv_store` table (`schedule_state` key), versioned by an integer `revision` for optimistic-concurrency writes (`setState` fails if `baseRevision` doesn't match — surfaced to the client as a save conflict).
- `security.js` — all trust boundary logic: strips secret fields before ever sending state to the browser (`publicState`), deep-validates every incoming `/api/state` write against the previous state (`validateSave`) to stop clients from forging approval outcomes, editing others' requests, exceeding protect quotas, or removing pending approvers, and implements admin/employee PIN auth (scrypt + timing-safe compare, in-memory session tokens, 5-attempt/15-min lockout). Approval decisions (`decide`) and self-cancellation (`cancelOwn`) bypass the normal "existing records are immutable" rule in `validateSave` because they're the one place server-side state mutation is allowed outside a client-submitted full-state save.
- `notifier.js` — Gmail SMTP sending (via `nodemailer`); no-ops (console-log only) when `SMTP_HOST` isn't configured, so the app runs fully without mail set up.
- `digest.js` — once-daily per-person summary email, run on an internal `setInterval` scheduler (checks time every minute against `DIGEST_TIME`, KST) or manually via CLI. Tracks a per-email `digest_cursor` (last-sent timestamp) so failed sends catch up next run instead of being dropped.
- `activityLog.js` — writes a plain-text, human-readable line per day (`logs/YYYY-MM-DD.txt`, gitignored) for leave/protect/excuse submissions and for decisions/self-cancellations, independent of the SQLite state blob. Called from `security.js`'s `save`/`decide`/`cancelOwn` right after each successful `persist(...)`.

**Auth model**: two independent token types (`X-Admin-Token` for the single shared admin password from `ADMIN_PASSWORD` env, `X-Employee-Token` per-employee PIN login), both short-lived in-memory sessions (15 min, lost on server restart). Approver PINs are checked per-decision in `security.decide`, except an authenticated admin can approve/reject any pending approval without a PIN (still attributes the decision to a chosen approver's name). A server-memory edit lock (`lockStatus`/`acquireLock`/`heartbeatLock`/`releaseLock` in `security.js`, `/api/lock*` routes) lets only one of {admin, one employee} be logged in at a time — heartbeat-based, auto-expires after `LOCK_TIMEOUT_MS` (default 3 min) if the holder's tab goes away.

**Adding a static asset**: files served to the browser must be explicitly added to the `publicFiles` map in `server.js` — the project folder (DB, server source, `.env`) is otherwise not exposed over HTTP.

**Approval workflow**: leave requests, protect-quota-exceeded requests, and monthly schedule finalization all go through the same `approvals` array/`decide()` path; `docs/PR3-security.md`, `docs/PR4-schedule-rules.md`, and `docs/PR5-monthly-versions.md` document the business rules and server/client split for each in more depth than is worth repeating here — read them before changing approval, quota, or monthly-versioning logic.

## Language

Code comments, commit messages, docs, and UI strings in this repo are in Korean; match that when editing.
