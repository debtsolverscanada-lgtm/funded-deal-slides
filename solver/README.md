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

- `ADMIN_*` creates the admin if missing and resets its password and admin role on every start (two-factor stays on; see `ADMIN_RESET_2FA`).
- Serve it over HTTPS (every host above does this for you) and set `COOKIE_SECURE=1`.
- Back up `/data/solver.db` daily. That one file is the whole CRM.
- Add the rest of the team from **Team** in the sidebar (admins only).

## Roles

| Role | Can |
|---|---|
| Admin | everything, plus add people, change roles, reset passwords and two-factor, set board access and permissions |
| Member | view and change boards and items, import and export |
| Viewer | view only (and export what they can see) |
| Guest | for a lender or lawyer: sees only the boards an admin shared with them, reads items, posts updates, attaches files, and changes only the columns marked "Guests edit" |

Members and viewers see open boards and the private boards that list their email. **Guests never see open boards**:
they see a board only when their email is on its access list (open or private). They don't see Team & settings,
Integrations, the workspace switcher, other people's emails or the Monday copy controls, and they always see a
"Guest" badge. Add a guest under **Team & settings > Add a person > Guest** and tick their boards, or later use
"+ Share a board…" on their row. From a shell: `node scripts/create-user.js lender@bank.ca "Name" guest "password" --boards=<boardId>,<boardId>`.
All of this is checked on the server (boards, items, live updates, search, home summary, exports, files, notifications),
not just hidden in the page.

## Sign-in security

**Two-factor sign-in (TOTP).** Anyone can turn it on under **Security** (sidebar, or Profile on phones): scan the QR
code with Google Authenticator, 1Password or Authy (or type the key shown under it), enter the 6-digit code, then save
the 10 one-time backup codes (only their hashes are stored). After that, signing in takes the password and then a code
or a backup code. Wrong codes are limited: 5 per sign-in attempt and 8 per person per 15 minutes; a code can't be
used twice. The QR code is drawn in the browser by `public/qr.js` (no outside service sees the key).

- **Require two-factor for everyone** (Team & settings > Sign-in security): people without it must set it up right
  after signing in; nothing else works until they do. It can't be turned off by the person while this is on.
- **Reset two-factor** (Team & settings, on a person's row): for someone who lost their phone and backup codes.
- **Admin locked out?** `ADMIN_EMAIL` + `ADMIN_PASSWORD` still reset the admin's password and role on every start,
  but they do **not** turn two-factor off. To clear the admin's two-factor, set `ADMIN_RESET_2FA=1` (with
  `ADMIN_EMAIL`) and restart: the log says `ADMIN_RESET_2FA: two-factor sign-in was turned OFF for …`. Sign in, set it
  up again, then **remove `ADMIN_RESET_2FA`**. With shell access you can also run
  `DATA_DIR=/data node scripts/reset-2fa.js person@example.com`.

**Sign in with Google (optional).** Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (Google Cloud console >
APIs & Services > Credentials > OAuth client ID, type "Web application") and add this authorized redirect URI:
`https://<your-site>/api/auth/google/callback`. The login page then shows "Sign in with Google". Only people who
already have a Solver.ca account (matched by email) get in; nobody is created automatically. The server checks the
state and nonce and verifies Google's ID token (RS256 signature against Google's published keys, issuer, audience,
expiry, verified email). Two-factor still applies after Google unless the admin turns on **Google sign-in counts as
two-factor**.

| Setting | What it does |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | turn on Sign in with Google (both needed) |
| `GOOGLE_ALLOWED_DOMAINS` | optional, comma list like `mortgagesolvers.ca`: only Google accounts on these domains |
| `GOOGLE_REDIRECT_URI` or `PUBLIC_URL` | optional: the exact callback address, when the server can't work it out from the request (behind some proxies) |
| `ADMIN_RESET_2FA` | `1` clears `ADMIN_EMAIL`'s two-factor on the next start (logged). Remove it afterwards |

## Board permissions (admins, in the board's **Access** window)

- **Column locks.** Lock a column so only admins (and the emails you list on it) can change it. Everyone else sees it
  read-only with a lock icon. The server refuses changes to locked columns from the app, the API (`/api/v1`) and
  imports with a clear message; when a member creates or duplicates an item, locked values are left out.
- **Members see only items assigned to them.** Pick person columns; non-admins then only get items where their
  Solver.ca name is in one of them (full name, any case, or a first name no one else on the team has). This applies to
  the board, single items, live updates, the home summary, exports, files and notifications. Admins see everything.
- **Guests edit.** Mark the columns guests may change (none by default).

## Export and import

- **Export** (board header) downloads the current view as Excel (.xlsx) or CSV: the filters, search, sort, saved
  view and visible columns you have on screen. Numbers stay numbers, dates are YYYY-MM-DD text, statuses are their
  labels, formulas are calculated. Only items you're allowed to see are included.
- **Import** (admins and members) reads a CSV or .xlsx with a header row, matches its columns to the board's by name,
  lets you change the matching and pick the group, then adds the rows through the same path as the API, so the
  board's automations and outgoing webhooks run for each new item. Up to 5,000 rows / 10 MB at a time.

## Notifications and files

- The bell in the sidebar (Profile on phones) shows in-app notifications: @mentions in updates (`@Jan` or
  `@Jan Smith`), being assigned in a person column, Monday "notify someone" automations, and date reminders.
  They stay inside Solver.ca; nothing is emailed or texted.
- File columns and updates take attachments up to 25 MB. They're stored in `DATA_DIR/files` (on the same disk as
  `solver.db`, so back up the whole `/data` folder) and only people who can see the board can download them.

## What's not here yet

Calls/texts, email sequences, dashboards, two-way sync with Monday (Solver.ca only reads Monday).
