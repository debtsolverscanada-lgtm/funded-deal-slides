# Solver.ca CRM

A self-hosted, Monday-style CRM for MortgageSolvers: boards, groups, status columns, Main table and
Kanban views, subitems, updates, activity log, simple automations, person filter, team logins, and
live updates between everyone who has it open.

It's one Node process and one SQLite file. No packages to install, no outside services.
**Monday is not changed by anything here.** Solver.ca is a separate test copy.

## Run it on your computer

Needs Node 22.5 or newer.

```bash
cd solver
node scripts/create-user.js you@yourcompany.ca "Your Name" admin "a-strong-password"
npm start            # http://localhost:3000
```

## Copy your Monday workspaces in (read-only on Monday's side)

Easiest: set `MONDAY_API_TOKEN` and `MONDAY_WORKSPACE_IDS` on the server, then press
**Copy from Monday now** under **Team & settings**. Pressing it again refreshes the copy.
Items created in Solver.ca are kept; items that came from Monday are replaced by Monday's current version.

**Live pull.** While `MONDAY_API_TOKEN` is set, the server also reads what changed in Monday every 5 minutes
(edited, new, moved, deleted and archived items, and new updates) and copies just those items in. It never writes to
Monday and never runs webhooks or automations for these changes. Turn it off with `MONDAY_LIVE_PULL=off`.
**Team & settings** shows "Live from Monday · last pulled hh:mm" and has a **Pull changes now** button.

**Private boards.** A copy also brings over who can see each board: private and shareable Monday boards are only
visible to their Monday subscribers and owners (matched by email to Solver.ca accounts) and to admins. To set this
on a database copied before this existed, without a full re-copy, run once (reads Monday only):

```bash
MONDAY_API_TOKEN=... MONDAY_WORKSPACE_IDS=... DATA_DIR=/data node scripts/monday-board-access.js   # --dry-run to preview
```

Admins change it per board with the **Access** button in the board header.

Or offline, with files:

```bash
export MONDAY_API_TOKEN=...            # Monday: avatar > Developers > My access tokens
python3 scripts/monday_export.py import/monday_raw.json
python3 scripts/monday_transform.py import/monday_raw.json import
node scripts/import-monday.js import   # add --replace to wipe boards first
```

`import/` and `data/` hold real client data and are git-ignored. Never commit them.

## Try it in GitHub Codespaces (private to your GitHub account)

Open https://codespaces.new/debtsolverscanada-lgtm/funded-deal-slides?ref=claude/dreamy-hamilton-i65yx7
and add the suggested secrets (MONDAY_API_TOKEN, ADMIN_EMAIL, ADMIN_PASSWORD) when GitHub asks.
Solver.ca starts by itself on port 3000 and opens in a browser tab. The forwarded port is private,
so only you (signed in to GitHub) can open it. Without ADMIN_* secrets the sign-in is
admin@solver.local / solver-admin. Data lives in the codespace and is gone if you delete it.

## Put it on Render

The repo has a `render.yaml` Blueprint at its root.

1. In Render: **New > Blueprint**, connect GitHub, pick this repo, and apply.
2. Fill in `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` (your first login) and `MONDAY_API_TOKEN`
   (Monday: avatar > Developers > My access tokens; use an admin's token so every workspace is readable).
3. When it's live, sign in, open **Team & settings**, and press **Copy from Monday now**.
   It runs on the server. The first full copy takes roughly 20 to 40 minutes.

Cost: Starter instance plus a 2 GB disk, about US$7.50 a month. The disk keeps `solver.db`
and Render snapshots it daily.

## Put it online somewhere else

Any host that runs a Docker container **with a persistent disk** works (Render, Railway, Fly.io,
DigitalOcean, or your own server). Mount the disk at `/data`. That's where `solver.db` lives.

```bash
docker build -t solver .
docker run -p 3000:3000 -v solver-data:/data \
  -e ADMIN_EMAIL=you@yourcompany.ca -e ADMIN_PASSWORD='a-strong-password' -e ADMIN_NAME='Your Name' \
  -e COOKIE_SECURE=1 solver
```

- `ADMIN_*` only creates the first admin when there are no accounts yet.
- Serve it over HTTPS (every host above does this for you) and set `COOKIE_SECURE=1`.
- Back up `/data/solver.db` daily. That one file is the whole CRM.
- Add the rest of the team from **Team** in the sidebar (admins only).

## Roles

| Role | Can |
|---|---|
| Admin | everything, plus add people, change roles, reset passwords |
| Member | view and change boards and items |
| Viewer | view only |

Members and viewers only see open boards and the private boards that list their email.

## Notifications and files

- The bell in the sidebar (Profile on phones) shows in-app notifications: @mentions in updates (`@Jan` or
  `@Jan Smith`), being assigned in a person column, Monday "notify someone" automations, and date reminders.
  They stay inside Solver.ca; nothing is emailed or texted.
- File columns and updates take attachments up to 25 MB. They're stored in `DATA_DIR/files` (on the same disk as
  `solver.db`, so back up the whole `/data` folder) and only people who can see the board can download them.

## What's not here yet

Calls/texts, email sequences, dashboards, two-way sync with Monday (Solver.ca only reads Monday).
