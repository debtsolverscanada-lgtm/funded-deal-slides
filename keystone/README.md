# Keystone CRM

A self-hosted, Monday-style CRM for MortgageSolvers: boards, groups, status columns, Main table and
Kanban views, subitems, updates, activity log, simple automations, person filter, team logins, and
live updates between everyone who has it open.

It's one Node process and one SQLite file. No packages to install, no outside services.
**Monday is not changed by anything here.** Keystone is a separate test copy.

## Run it on your computer

Needs Node 22.5 or newer.

```bash
cd keystone
node scripts/create-user.js you@yourcompany.ca "Your Name" admin "a-strong-password"
npm start            # http://localhost:3000
```

## Copy your Monday workspace in (read-only on Monday's side)

```bash
export MONDAY_API_TOKEN=...            # Monday: avatar > Developers > My access tokens
python3 scripts/monday_export.py import/monday_raw.json
python3 scripts/monday_transform.py import/monday_raw.json import
node scripts/import-monday.js import   # add --replace to wipe boards first
```

`import/` and `data/` hold real client data and are git-ignored. Never commit them.

## Put it online

Any host that runs a Docker container **with a persistent disk** works (Render, Railway, Fly.io,
DigitalOcean, or your own server). Mount the disk at `/data`. That's where `keystone.db` lives.

```bash
docker build -t keystone .
docker run -p 3000:3000 -v keystone-data:/data \
  -e ADMIN_EMAIL=you@yourcompany.ca -e ADMIN_PASSWORD='a-strong-password' -e ADMIN_NAME='Your Name' \
  -e COOKIE_SECURE=1 keystone
```

- `ADMIN_*` only creates the first admin when there are no accounts yet.
- Serve it over HTTPS (every host above does this for you) and set `COOKIE_SECURE=1`.
- Back up `/data/keystone.db` daily. That one file is the whole CRM.
- Add the rest of the team from **Team** in the sidebar (admins only).

## Roles

| Role | Can |
|---|---|
| Admin | everything, plus add people, change roles, reset passwords |
| Member | view and change boards and items |
| Viewer | view only |

## What's not here yet

Monday automations (rebuild under **Automations**), recalculating formulas, files, calls/texts,
email sequences, dashboards, two-way sync with Monday.
