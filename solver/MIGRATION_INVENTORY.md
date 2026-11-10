# Monday.com to Solver.ca: migration inventory

**What this is.** A list of everything built by Ethan, by Claude (sessions, scheduled tasks, skills) and by the agency (Alborz's server, n8n and the company tools catalog) that reads from, writes to, or is triggered by Monday.com, plus what has to change for each when the team moves to Solver.ca. Things with no Monday link are listed at the end so nothing is forgotten.

**Date:** 2026-11-10. Read-only sweep: nothing was changed anywhere.

**Sources checked**

| Source | What was read |
|---|---|
| MortgageSolvers connector (company tools catalog) | Every catalog tool (about 75), plus the Monday reference page (boards, column ids, webhooks, API traps) |
| Claude scheduled tasks | All 44 (enabled and disabled; one-shots that already fired are hidden) |
| n8n (cloud workspace) | All 79 workflows by name and description |
| Zapier | Saved Zapier skills (none of ours) and the connected apps list |
| Artifacts | All 93 (80 mine, 13 shared), plus the three build-recap pages (Deal Desk Buttons, MortgageSolvers Weekend Build, DebtSolvers Weekend Build) |
| Work library | Its database (Sept to Nov entries) in search mode |
| Claude Code sessions | 27 session titles and summaries |
| Skills | Descriptions of the 15 MortgageSolvers skills |
| Solver.ca repo | README and developers page, to know what Solver.ca can and cannot do yet |

**Could not access / not fully visible**
- **The agency's own n8n** (the server running the 5 Facebook lead routers, the 15 speed-to-lead / responder / re-engage workflows, the quiz and referral routers and the "Monday.com Group Change Workflow"). The n8n workspace connected here is the cloud one used by Claude sessions; the agency workflows are only known through the catalog.
- **Zapier zaps themselves.** Zapier's tools only list connected apps and actions, not Zaps. Zapier has 9 monday.com connections, so some Zaps that touch Monday may still exist (the Google quiz relay and the Scarlett push use Zapier; the DebtSolvers lead Zaps were turned off on Nov 6).
- **Native Monday automations, Monday forms and Monday email automations** built inside Monday by the team. I did not open Monday (read-only rule plus scope). These must be listed from Monday itself before switching off (see Can't tell).
- **Session transcripts** were not read in full; scratchpad scripts named by scheduled tasks (for example `closer_daily.py`, `ms_alarms.py`, `fu_export.py`, `missed.py`) live in session scratch folders I cannot see.

**Key facts that shape the move**
- Solver.ca already has: boards, groups, status columns, subitems, updates, activity log, simple automations, API keys, outgoing webhooks (`item.created`, `item.updated`, `item.moved`, `item.status_changed`, `item.deleted`, `update.created`, `reminder.due`), and incoming lead links.
- Solver.ca does **not** have yet (from its README): files / file columns, recalculating formulas, doc columns, calls and texts, email sequences, dashboards, two-way sync with Monday. Several important tools depend on these (Client Documents column, Request Documents formula, Deal DNA doc column, Book of Business LTV formula, the Monday buttons).
- Almost every agency report reads Monday **through the Postgres copy** (`ms.contacts`, `ms.stage_moves`, `ms.crm_activity`, `ms.monday_fields`, the `ms.v_*` views). Repoint the sync once and dozens of reports keep working. Item ids matter: Monday item ids (`pulse_id` / `contact_id`) are used as keys everywhere, so Solver.ca must keep the Monday id on imported items (or a mapping table) and new items need a stable id the sync can use.
- Monday is used by **both businesses**: MortgageSolvers (setter desks, Closer Desk, Fish Tank, Book of Business) and DebtSolvers (rep boards, Clients board, Admin workspace boards). Both are listed.

Legend. Built in: **Agency server cron** = jobs on Alborz's VPS; **Agency n8n** = the agency's n8n; **n8n cloud** = the n8n workspace Claude sessions built in; **Sched. task** = a Claude scheduled task; **Skill** = a Claude skill; **Artifact** = a claude.ai page. Effort: S = config or a URL/ID swap, M = code changes in one tool, L = a feature Solver.ca does not have yet, or a rewrite.

---

## 1. Lead intake and routing

| Tool | Built in | What it does | How it uses Monday | What changes for Solver.ca | Effort | Owner |
|---|---|---|---|---|---|---|
| Facebook lead routers (5 forms) | Agency n8n | Each new FB Instant Form lead is dealt to a setter and created on their board within a minute | **Writes**: creates the item on the setter board | Create the item with `POST /api/v1/boards/{board}/items` (API key) or an incoming lead link; map board ids and column ids | M | Alborz-agency |
| Google quiz leads (Borrow quiz) | Zapier relay + agency n8n | Quiz on the lander goes to a setter's board with all Google click ids | **Writes**: creates or updates the item, incl. GCLID/OCI columns | Point the n8n step at the Solver.ca API; keep the GCLID/OCI columns on the setter boards; the Zapier relay can stay or be replaced by a Solver.ca lead link | M | Alborz-agency |
| Referral page | Agency n8n | Referred people land in New Uncontacted on a setter board, kept out of automations | **Writes**: creates item | Point at Solver.ca API; make sure the "keep out of automations" flag exists as a column in Solver.ca | S | Alborz-agency |
| Lead Desk and rotation (rotator) | Agency server + Postgres | Picks which setter gets the next lead (weights, time off, daily cap) | Indirect: returns a Monday board id per setter | Replace the Monday board ids in the rotator config with Solver.ca board ids | S | Alborz-agency |
| Lead cap alerts and rotator audit | Agency server cron | Ops alerts when a setter hits the cap or settings change | Indirect (rotator tables) | No change once the rotator board ids are swapped | S | Alborz-agency |
| Nightly lead summary | Agency server cron | "NEW LEADS" post per setter and source | Reads the synced lead table | No change once the board sync is repointed | S | Alborz-agency |
| Fish Tank hand-off (raised hands) | Agency server cron | A nurture lead who replies or calls is moved back to a setter by round robin | **Moves items** between Fish Tank and setter boards | Use Solver.ca move (`item.moved`) via the API; remap board/group ids | M | Alborz-agency |
| Website lead router (new WordPress site) | Agency server / site plugin | Website form leads, live since Nov 5 | Probably creates the item (not confirmed) | Point at Solver.ca lead link or API | S | Alborz-agency |
| Deal OS CRM pilot shadow intake | Agency (test server) | Copies Google quiz leads into the EspoCRM test | None (shadow of the quiz router) | Decide: retire the pilot, or treat Solver.ca as the replacement it was testing for | S | Alborz-agency |
| DS Facebook leads to Monday | n8n cloud | Every 2 min, new DebtSolvers FB leads, duplicate check, rotate to 5 reps (replaced Zapier Nov 6) | **Writes**: creates items on rep boards; reads boards for duplicates | Point create + duplicate search at Solver.ca API (`/api/v1/search`) | M | Claude session |
| DS "Check If You Qualify" quiz (Google/YouTube) | n8n cloud | Public form, round robin to reps | **Writes**: rep board items (also a data table) | Point at Solver.ca API or swap the form for a Solver.ca lead link | S | Claude session |
| DS Missing Leads (hourly, Mon-Fri) | Sched. task | Compares the leads sheet and the Leads Center table with every rep board; recovers missing leads | **Reads** 10 rep boards; **writes** recovered items | Rewrite the board reads and item creates against the Solver.ca API (needs a Solver.ca connector or API key in the task) | M | Claude session |
| DS missing-lead check (every 2 hours) | Sched. task | Older twin of the hourly check, same logic, posts a Discord summary | Same as above | Merge with the hourly check and repoint, or retire one of the two | M | Claude session |
| DS Monday lead stages to Meta | n8n cloud | Sends Lead / Pitched / Signed / Junk stages to Meta Conversions API | **Reads** rep board groups | Use Solver.ca `item.moved` / `item.status_changed` webhooks, or poll the API | M | Claude session |
| DS Leads Center match / send (2 workflows, off) | n8n cloud | Earlier version of the stage feed | Reads Monday | Retire | S | Claude session |
| Facebook audiences | Agency n8n | Keeps FB customer-list audiences in step with Monday (junk, funded, quiet, working) | Reads Monday stages (via sync) | No change once the board sync is repointed; check any direct Monday query | S | Alborz-agency |
| Facebook CAPI (2+ min conversation events) | Agency n8n | Tells Meta which leads talked to a setter | Reads lead/item mapping from the sync | No change after sync repoint | S | Alborz-agency |
| Google Ads ad names + offline conversions | Agency server cron | Writes readable ad names onto quiz leads; uploads booked / application / funded conversions to Google | **Writes** Monday name/OCI columns; reads stages | Write the same columns through the Solver.ca API; read stages from the repointed sync | M | Alborz-agency |
| Lead forms tie-in | Agency (Postgres view) | Ties each lead to the FB form it came from | Reads router log keyed by Monday item id | Keep Monday ids on imported items, store new Solver.ca ids the same way | S | Alborz-agency |

## 2. Texting and email follow-up

| Tool | Built in | What it does | How it uses Monday | What changes for Solver.ca | Effort | Owner |
|---|---|---|---|---|---|---|
| NA follow-ups (NA 1 to NA 5 ladder) | Agency server cron | Setter sets Status NA 1..5; within a minute the lead gets the matching email and text, and a note is posted | **Triggered by Status column** (polled); **writes** an update | Use Solver.ca webhook `item.status_changed` (or poll the API); post the note with the updates API; keep the exact labels NA 1..NA 5 | M | Alborz-agency |
| SMS speed-to-lead (5 setter lines) | Agency n8n | Texts a brand-new lead from the setter's line, plus a 2nd text 5 min later | **Triggered by Monday `create_item` webhook** on each setter board | Subscribe to Solver.ca `item.created` per board; read phone from the webhook payload | M | Alborz-agency |
| After-hours inbound SMS responder (5 lines) | Agency n8n | AI reply to texts that arrive after hours, tries to book a callback | Looks up the lead's item | Swap the lookup to `/api/v1/search` | S | Alborz-agency |
| 3-day re-engage (5 lines) | Agency n8n | "Reply Y" opener to leads silent for 3+ days | Reads items / groups | Read from the Solver.ca API (or the repointed sync) | S | Alborz-agency |
| New-lead intro emails (dry run, not sending) | Agency server cron | Intro email 1 h and 24 h after arrival until a setter acts | Reads status/activity; **writes** an update | Same as NA follow-ups: `item.created` + `item.status_changed`, updates API | M | Alborz-agency |
| Deal-stage client updates (paused) | Agency server cron | Email + text from the closer as a deal moves stage | **Triggered by group moves** on Closer Desk; writes update | Use `item.moved` webhook; updates API | M | Alborz-agency |
| Fish Tank (nurture board, sequence, testimonials, promos) | Agency server cron | Moves cold leads into the Fish Tank board, texts them, and returns raised hands to setters | **Moves items**, writes `ft_*` columns, reads board | Recreate the Fish Tank board in Solver.ca (it is deliberately not in the reporting registry); move via API; status "Fish Tank" trigger via `item.status_changed` | L | Alborz-agency |
| SMS campaigns (blasts) | Agency scripts (manual) | Reactivation texts to a hand-built list | Reads Monday to build exclusions; outcomes tracked via sync | Build lists from Solver.ca API / repointed sync | S | Alborz-agency |
| Callback alerts, missed-call alerts, SMS classifier | Agency server cron | #engagedleads alerts and READY/CHASING labels | Indirect: maps phones to live Monday items via sync | No change after sync repoint | S | Alborz-agency |
| Missed-call texts (built, not live) | Agency | Would text after an unanswered dial | None live | No action | S | Alborz-agency |
| MortgageSolvers neglect alarms (hourly) + morning neglect check | Sched. tasks | Posts stuck / missed follow-up / uncontacted alerts to #engagedleads; ticks items when acted on | **Reads** boards, groups, follow-up dates, updates | Rewrite scripts against Solver.ca API (needs API key or a Solver.ca connector for Claude) | M | Claude session |
| DS Text Bookings (hourly) | Sched. task + artifact | Finds calls clients agreed to by text; sets Follow-Up Date, adds a note, sends the rep a Monday notification | **Writes** Follow-Up Date column, update, notification | Write the date and note via Solver.ca API; use `reminder.due` instead of Monday notifications | M | Claude session |
| DS follow-ups page + morning post | Sched. task + artifact | Per-rep follow-up list with reasons, posted 8:30 AM | **Reads** rep boards, notes, comments | Rewrite `fu_export` / `fu_notes` against Solver.ca API | M | Claude session |
| Debtsolvers follow-ups to Discord | n8n cloud | Posts rep board changes (new leads, callbacks, pitched, signed, junked) instantly, plus 9 AM digest | **Triggered by Monday board webhooks** | Subscribe to Solver.ca `item.created`, `item.moved`, `item.status_changed` | M | Claude session |
| DS instant intro text (off) | n8n cloud | New lead text from rep line + Monday note | Reads new items, writes note | Repoint if it is ever turned on, else retire | S | Claude session |
| DS missed-call alerts + engaged leads board | Sched. tasks | Missed-call pings and the live engaged board for 6 reps | Reads rep boards to name the client and rep | Repoint the name/rep lookup to Solver.ca | S | Claude session |
| DS client care scan (9 AM) | Sched. task | Flags refund / upset / trustee / payment threads to Discord | Reads Monday name and rep for each phone | Repoint lookup | S | Claude session |
| DS e-Transfer thank-you text + note | n8n cloud | Matches deposits to clients, texts thank-you, adds card note | **Reads** Clients board; **writes** update | Search + updates via Solver.ca API | S | Claude session |
| DS client texts when trustee status changes | n8n cloud | Texts the client when the trustee status changes | **Triggered by a Status column** | Use `item.status_changed` webhook | M | Claude session |
| DS win-back reply handling (off since Nov 6) | Sched. task | Answered win-back replies | Read Monday card links | Retire | S | Claude session |

## 3. Deals, closers and lenders

| Tool | Built in | What it does | How it uses Monday | What changes for Solver.ca | Effort | Owner |
|---|---|---|---|---|---|---|
| Closer Desk mover | Agency server cron | Setter puts a deal in Needs Approval - Private/Bank; it moves (same id, updates, files, subitems) to the shared Closer Desk and repairs lost fields | **Triggered by group**; **moves items between boards** | Use a Solver.ca automation (move to board on group) or the API; keep item id stable; native Monday move automations must stay off | M | Alborz-agency |
| Closer Desk and setter desks (board design) | Agency + Monday | How data follows a lead across boards and how setters keep credit | Board structure, Appointment Setter column by title | Recreate boards/groups/columns with the same titles (reports read columns by TITLE) | M | Alborz-agency |
| Monday.com Group Change Workflow | Agency n8n | Receives every group move from every tracked board | **Monday webhook** `item_moved_to_any_group` | Replace with Solver.ca `item.moved` webhook | S | Alborz-agency |
| Closer Desk stage posts | Agency server cron | "NEW COMMITMENT / DEAL ACCEPTED / CLOSED" to Discord | Triggered by group moves (via sync) | No change after sync repoint, or use `item.moved` | S | Alborz-agency |
| Closed deals to Google Sheet | Agency server cron | New row in the closed-deals sheet when a deal hits Closed; optional Monday update | Triggered by group Closed; may write update | `item.moved` to Closed; updates API | S | Alborz-agency |
| Renewal cards | Agency server cron | 60 days before renewal, creates a card in the Renewals group of the Closer Desk | **Creates items** + update; reads Book of Business | Create via API in the Solver.ca Renewals group; Book of Business must be copied | S | Alborz-agency |
| Book of Business import (legacy revenue, closer splits) | Agency server cron | Copies the Book of Business board | Reads that board | Read from Solver.ca API | S | Alborz-agency |
| Deal DNA briefs | Agency server cron | Brief from discovery calls, published as a Monday **doc** in a Deal DNA column + update | **Writes doc column** + update | Solver.ca has no doc columns: post as a long-text column or update with a link to the brief page | M | Alborz-agency |
| Call transcription notes | Agency server cron | Posts a call note as an Update on the lead's item | **Writes** updates | `POST .../items/{id}/updates`; keep the "skip deleted items" check | S | Alborz-agency |
| Pineapple mailbox lender assistant | Agency server cron | Drafts replies to lender emails and matches the deal | Matches deal via sync | No change after sync repoint | S | Alborz-agency |
| Lender scorecard / submissions (GHOST v3 Lender Submissions board) | Agency + connector | Per-lender turnaround and approval rate | Reads the Lender Submissions board (via sync) | Copy that board into Solver.ca and include it in the sync | S | Alborz-agency |
| Deal debrief (paused) | Agency server cron | Questionnaire when a deal is won, lost or parked | Triggered by group moves | `item.moved` if it is turned back on | S | Alborz-agency |
| Hourly Scarlett push | Sched. task | Finds Needs Approval cards with a `Lastname_Scarlett.json` file and no "Pushed to Scarlett" note, creates the Scarlett deal, posts the update | **Reads files** on items, reads updates, **writes** update | Needs Solver.ca file support (or keep the JSON on Drive and link it); updates API; remap Closer Desk and Fish Tank board ids | L | Claude session |
| Daily meeting Monday updates | Sched. task | Posts next steps from the Fathom daily meeting onto each Closer Desk card, @mentioning the owner | Reads Closer Desk; **writes** updates with mentions | Updates API; map Monday user ids to Solver.ca users for mentions | M | Claude session |
| Auto application drafts | Sched. task | Builds an application draft from each long closer call; posts a note on the card | **Writes** update | Updates API | S | Claude session |
| Lender Match weekly learning | Sched. task + artifact | Learns lender profiles from funded deals | Reads Book of Business view (via connector); never writes Monday | No change after sync repoint | S | Claude session |
| MortgageSolvers closer report (9 PM) + weekly (Fri) | Sched. tasks | Per closer: transfers, moved to Needs Approval, accepted, closed | Reads moves (Monday / sync) | Repoint the script's Monday reads | S | Claude session |
| Weekly loss debrief (Fri) | Sched. task | Reason codes for every lost deal, Discord + Doc | Reads cards, notes, stage history | Repoint reads | M | Claude session |
| DS Consult assessment (rep page) | n8n cloud | Rep finds the client, fills the assessment live; saves summary update + PDF to the card | **Search** items; **writes** update + PDF file | Search + updates via API; PDF needs file support or a Drive link | M | Claude session |
| DS Agreement sender (rep page) | n8n cloud | Sends the engagement agreement through DocuSign | Not clear whether it reads Monday | Check; see Can't tell | S | Claude session |
| DS Power dialer (Michael) + Power dialer from Monday (off) | n8n cloud | Dialer page with a queue from Monday; status column Start triggered dialing | **Reads** queue, **writes** "Calling now / Dialed" | Michael left Nov 3: retire, or repoint if reused | S | Claude session |
| DS client file numbers (Clients board) | n8n cloud | Gives each new client the next DS File # | **Writes** column | Solver.ca automation or API write | S | Claude session |
| DS welcome pack when agreement signed | n8n cloud | Welcome email/text + Pipefile link once signed and paid | Reads/moves the card to Signed (rep moves card when paid from another name) | `item.moved` to Signed; API reads | M | Claude session |
| DS intake rotation (Chris / Zach / Zandra) | n8n cloud (part of welcome flow) | Assigns each sign-up an intake admin | Writes person column / reads sign-ups | API write of the person column | S | Claude session |

## 4. Documents and applications

| Tool | Built in | What it does | How it uses Monday | What changes for Solver.ca | Effort | Owner |
|---|---|---|---|---|---|---|
| Texted documents to Drive (MMS bot) | Agency server cron | Saves texted photos/PDFs to the client's Drive folder and the Monday item | **Writes Client Documents file column** | Needs file columns in Solver.ca, or write a Drive link column / update instead | L | Alborz-agency |
| Email documents bot | Agency server cron | Files emailed attachments to Drive and the Monday item | **Writes Client Documents file column** | Same as above | L | Alborz-agency |
| Client document links (upload portal) | Agency server | Client uploads from a phone link; files land in Drive + Monday + notes | **Writes file column** + notes; item id drives the portal link | Same as above; portal must key on the Solver.ca item id | L | Alborz-agency |
| Request Documents formula column | Monday formula | Formula link from the Item ID column into the portal | **Formula + Item ID column** | Solver.ca does not recalculate formulas: generate the link server-side or add a link column filled by API | S | Alborz-agency |
| Build Application / Validate File (Monday buttons) | n8n cloud | Draft application in Pineapple format; file checklist; sets File Check column | **Triggered by Monday button / File Tools status**; reads updates + files; writes updates, File Check column | Add button or status triggers in Solver.ca that fire a webhook (`item.status_changed` on a "File Tools" status works today); reads/writes via API; file reading needs file support | L | Claude session |
| Savings Report (Monday button) | n8n cloud | One-page savings PDF into the row's Files | Button trigger; **writes file** | Same trigger approach; PDF to Drive + link until Solver.ca has files | L | Claude session |
| Client Report (Monday button) | n8n cloud | Plan PDF + Gmail draft to the client | Button trigger; reads card; writes file | Same | M | Claude session |
| Signing Package (Monday button) | n8n cloud | DocuSign draft with savings summary | Button trigger; reads card | Same trigger approach | M | Claude session |
| Conditions Reply (Monday button) | n8n cloud | Gmail draft reply to the lender with the matching row documents attached | Button trigger; **reads files** on the row | Needs file access in Solver.ca (or Drive folder) | L | Claude session |
| Send to Scarlett (Monday button) | n8n cloud | Builds `Lastname_Scarlett.json` + missing-items update | Button trigger (also chained from Build App by setting the status); **writes file** + update | Same trigger approach; file to Drive or Solver.ca files | L | Claude session |
| mortgage-application-builder | Skill | Builds a Pineapple/Scarlett application by finding the client in Monday and reading notes, calls and uploads | **Reads** Monday items and updates | Point the skill at the Solver.ca API (or a Solver.ca MCP connector) | S | Ethan / Claude session |
| DS client documents Drive to Monday (Pipefile, email, text) | n8n cloud | Puts received documents on the card's Documents column | **Writes file column** | Needs Solver.ca files, or a Drive link column | L | Claude session |
| DS client documents by email/text to Drive | n8n cloud | Files and sorts documents; keeps creditor messages apart | Matches sender to the client card | Repoint the match to Solver.ca search | S | Claude session |
| DS document reminders to clients (day 2, 4, 7) | n8n cloud | Texts/emails what is still missing | Reads the card's document state | Repoint reads; may need file state | M | Claude session |
| DS document follow-ups (Pipefile + 5/10-day pings) | n8n cloud | Pings admins when documents are late or complete | Reads cards; triggered by Documents Collected | `item.status_changed` webhook | M | Claude session |
| DS intake form on Monday (form + PDF + AI pre-fill) | n8n cloud | Intake form opened from the card, pre-filled, makes a PDF | Opened from the card; writes back to the card | Link the form from a Solver.ca column; write back via API; PDF to Drive | M | Claude session |
| DS intake reminder button (Send Reminder) | n8n cloud | One click sends the booking link by text + email | **Monday button column** | Status-column trigger + webhook in Solver.ca | M | Claude session |
| DS check intake form before trustee | n8n cloud | Checks the intake form is complete before sending | Reads the card / status | Repoint | S | Claude session |
| DS send client file to trustee (Monday button) | n8n cloud | Brandon picks a trustee; admin@ emails the file | **Monday button / dropdown trigger** | `item.status_changed` webhook on the trustee column | M | Claude session |
| DS trustee follow-up emails (2 days, no answer) | n8n cloud | Chases trustees who did not reply | Reads the Sent to Trustee board | Copy the Admin workspace boards; repoint | S | Claude session |
| DS Trustee Contacts + Sent to Trustee boards | Monday (Admin workspace) | Trustee list and sent-file tracker | Boards | Copy into Solver.ca | S | Claude session |
| DS add sign-ups to CLIENT TRACKER (off) | n8n cloud | Would copy sign-ups to the sheet | Reads Monday | Repoint if turned on | S | Claude session |
| "Confirmation of Document Filing" email | Native Monday email automation (DS) | Emails the client their filing confirmation with DS File # | Native Monday automation | Rebuild in Solver.ca or n8n | M | Ethan / Brandon |

## 5. Reporting, dashboards and scoring

| Tool | Built in | What it does | How it uses Monday | What changes for Solver.ca | Effort | Owner |
|---|---|---|---|---|---|---|
| **Monday board sync** (poll_leads, sync_board, poll_activity, enrich_contacts, pull_created_at) | Agency server cron + webhook | Copies every item, stage move and activity into Postgres; feeds the dashboard, connector and most automations | **Reads** all tracked boards + activity log + webhook | Rewrite against Solver.ca API + webhooks (`item.created/updated/moved/status_changed`, activity log). Keep ids stable. Single biggest job | L | Alborz-agency |
| Monday full fields (all ~130 columns per lead) | Agency server cron | One JSONB row per lead keyed by column TITLE | Reads every column | Repoint; keep column titles identical | M | Alborz-agency |
| Monday updates ingest | Agency server cron | Copies every item's Updates feed | Reads updates | Use `update.created` webhook or API | M | Alborz-agency |
| Monday contact dates (Last Date Contacted / Texted) | Agency server cron | Writes two date columns from phone data every 15 min | **Writes** columns | Write via API; formula columns built on them need a Solver.ca replacement | S | Alborz-agency |
| Company Scorecard (stats dashboard), Setter Scorecard, Company portal views | Agency server | Main KPI dashboard | Indirect via sync | No change after sync repoint | S | Alborz-agency |
| Sales leaderboard, setter leaderboard, dial report, dial quality, media buying report | Agency server cron | Discord reports | Indirect via sync (credit rules use Monday moves) | No change after sync repoint | S | Alborz-agency |
| Armory + Closer Armory (file notes, file metrics) | Agency server | Coaching apps | Indirect; armory file notes read Monday items | Repoint any direct Monday read | S | Alborz-agency |
| Client data connector (MortgageSolvers MCP) | Agency server | Plain-English questions over `ms.v_*` views | Indirect; views are named by Monday ids | No change after sync repoint; rename "pulse_id" only if ids change | S | Alborz-agency |
| Revenue (closed-deals sheet) | Agency server cron | Revenue numbers | Sheet, plus Book of Business for closer splits | Only the Book of Business part changes | S | Alborz-agency |
| Setters daily report | Sched. task | Per-setter score, speed to lead, dial padding, meeting check | **Reads** account update feed, board groups, moves | Rewrite Monday reads (updates feed, groups) to Solver.ca API / activity log | M | Claude session |
| Closers daily report (+ Gurnidhi scorecard) | Sched. task | Per-closer score, live files, Court updates, lender replies | **Reads** groups, updates and replies, **activity logs** (Court column edits) | Needs Solver.ca activity log via API; column ids remap | M | Claude session |
| Fulfillment daily report (+ Aysha, Anwesha scorecards) | Sched. task | Coverage, touches, Book of Business edits, KPI checks | Reads Fulfillment Officer column, updates, **activity logs on Book of Business** | Same as above | M | Claude session |
| Fulfillment morning action list | Sched. task | What to handle today and stale files | Reads fulfillment groups + updates | Repoint reads | M | Claude session |
| Court report | Sched. task | Whose move it is on every active file | Reads Court column + updates on 6 boards | Repoint reads | M | Claude session |
| Junk and Lost tag audit | Sched. task | Tags every dropped card with a drop reason | Reads groups; **writes Status column** | Read + write via API; keep the same labels | M | Claude session |
| Setter focus list (8 AM MT) | Sched. task | Per-setter coaching items + files to call today | Reads 6 boards' groups, columns, updates | Repoint reads | M | Claude session |
| Daily setter call reports | Sched. task | Per-setter call review emails + Drive copies | Reads item updates for file context | Repoint `get_updates` | S | Claude session |
| Daily closer call reports | Sched. task | Per-closer transfer review emails + Drive copies | Reads item updates | Repoint `get_updates` | S | Claude session |
| Mark mortgage daily to-do | Sched. task | Gmail draft to-do from Mark's board stages | Reads 13 groups + updates on Mark's board | Repoint reads | S | Claude session |
| MortgageSolvers weekly scorecard refresh | Sched. task + artifact | 9 KPIs with targets and plays | Reads via connector (sync) | Mostly no change | S | Claude session |
| Weekly MVP Discord draft | Sched. task | Setter/closer/fulfillment MVPs | Reads moves via connector | No change after sync repoint | S | Claude session |
| MortgageSolvers Command Board | Sched. task + artifact | One page of alerts, email tasks, callbacks | Reads Monday + matches emails to cards | Repoint `clients.py` / `match_email.py` | M | Claude session |
| DS daily pipeline post (11:59 PM) | Sched. task | Pitched / signed / junked per rep | Reads every rep board | Repoint | M | Claude session |
| DS weekly rep report + monthly rep report | Sched. tasks + artifacts | Sign-ups, deal size, leads per rep | CLIENT TRACKER sheet; lead counts may come from boards | Check `ds_weekly.py` for Monday reads, repoint | S | Claude session |
| DS weekly scorecard (Mon) | Sched. task | Lead sheet + spend + first payments | Not clear (lead sheet) | See Can't tell | S | Claude session |
| DS dial updates / daily SMS speed / call reviews | Sched. tasks | Discord dial and speed posts, Mon/Fri call reviews | Phone data; may map phones to Monday names | Repoint name lookups if any | S | Claude session |
| Debtsolvers dashboard refresh (Stats repo) | Sched. task | Meta numbers; tries Monday (still blocked) | Tries to read rep boards | Point it at Solver.ca instead of Monday (this also unblocks it) | S | Claude session |
| DS admin morning to-do lists | n8n cloud | #admin morning lists | Probably reads Clients board | Repoint | S | Claude session |
| DS weekly unsigned agreements | n8n cloud | Weekly Discord post | Probably reads rep boards (Pitched) or DocuSign | See Can't tell | S | Claude session |
| MS Closer EOD task report | n8n cloud | Each closer's open Monday **subitems** to Discord at 5 PM | Reads subitems | Solver.ca has subitems: repoint | S | Claude session |
| MS inbox triage (shadow, off) + inbox daily review (off) | n8n cloud | Inbox bot that created Monday subitems | Writes subitems | Retire or repoint | S | Claude session |
| team-daily-scoring | Skill | Scores every setter, closer, fulfillment officer from Monday, phone and email | **Reads** Monday | Point at Solver.ca | S | Ethan / Claude |
| mortgagesolvers-commission | Skill | Monthly payouts using closed deals sheet, Pineapple statement and Monday setter boards | **Reads** setter boards | Point at Solver.ca | S | Ethan / Claude |
| closer-call-scoring | Skill | Scores closer transfer calls, emails each closer | Reads call data; file context from Monday updates | Repoint update reads | S | Ethan / Claude |
| linkedin-organic-skill | Skill | LinkedIn posts with data hooks pulled from Monday | **Reads** Monday | Point at Solver.ca / connector | S | Ethan / Claude |
| fractional-cfo-review | Skill | Monthly CFO review with pipeline data | Pipeline via connector | No change after sync repoint | S | Ethan / Claude |
| Artifacts fed by the above | Artifacts | Text Bookings Board, DS Follow-Ups, Command Board, Weekly Scorecard, DS Weekly/Monthly Rep Report, Fulfillment Checklist, Blast Builder, Lender Match, Funding Tracker (x2), Upcoming Deals by Source, Junk and Lost Leads | Data refreshed by the tasks above | Nothing to change in the pages; their feeder tasks change | S | Claude session |

## 6. Monday-specific helpers and plumbing

| Tool | Built in | What it does | How it uses Monday | What changes for Solver.ca | Effort | Owner |
|---|---|---|---|---|---|---|
| Monday change watcher | Agency server cron | Snapshots boards every 30 min; alerts on renamed columns, labels, groups, webhooks | Reads board schemas | Repoint to Solver.ca schema (or retire once Solver.ca is the only CRM) | S | Alborz-agency |
| `ms.monday_boards` board registry | Agency Postgres | Which boards reporting sees (Fish Tank excluded on purpose) | Monday board ids | New registry rows for Solver.ca boards | S | Alborz-agency |
| People directory | Agency Postgres | Each person's Monday user id, phone extension, Discord id | Monday user ids | Add Solver.ca user ids | S | Alborz-agency |
| Setter-board `create_item` webhooks | Monday | Fire speed-to-lead | Monday webhooks | Replace with Solver.ca `item.created` subscriptions; check cloned boards do not inherit stale webhooks | S | Alborz-agency |
| Native Monday automations (client-built) | Monday | Moves, notifications, emails inside Monday | Native | List them in Monday, rebuild under Solver.ca **Automations** or n8n. "Move item to board" must stay off while the Closer Desk mover runs | M | Ethan / team |
| Monday button columns (7 MS deal-desk buttons, DS Send Reminder, Send to Trustee, Send Text + Email) | Monday + n8n cloud | One-click actions on a row | Button columns calling n8n webhooks | Solver.ca needs a button column or a status column + `item.status_changed` webhook | L | Claude session |
| Monday doc columns, formula columns, Item ID column, file columns | Monday | Deal DNA doc, Request Documents link, BoB LTV / Total Mortgages formulas, Client Documents | Column types Solver.ca does not support yet | Decide per column: long text, server-computed value, Drive link | L | Alborz-agency + Claude |
| Claude's Monday connector use | Sched. tasks, skills | About 20 tasks call `all_monday_api` / `get_updates` / `create_updates` | Monday MCP connector | Give Claude a way into Solver.ca: an MCP server for Solver.ca, or an API key stored as a network credential for the task environment | M | Claude session |
| `solver/monday.js` + import scripts | Solver.ca repo | Copies Monday into Solver.ca | Reads Monday | Run a final copy at cutover, then switch off | S | Claude session |
| Recruitment funnel: submit candidate | Agency n8n (cloud listing) | Scores a candidate test; creates the candidate card with recordings | **Creates items** on the Recruitment Pipeline board | Copy the board; create via API (recordings need files or links) | M | Claude session / agency |
| Closer certification: grade recordings (off) | n8n cloud | Grades training recordings from the Training Board form, writes score to the card | Monday form + board | Repoint if turned on | S | Claude session |
| Monday notifications to reps | Monday | Used by Text Bookings and new-lead alerts | Monday notifications | Solver.ca `reminder.due` / in-app notifications | S | Claude session |

## 7. Content and other (no Monday link, or only through the connector)

These do not need changes unless noted. Listed so nothing is missed.

| Tool | Built in | What it does | How it uses Monday | What changes for Solver.ca | Effort | Owner |
|---|---|---|---|---|---|---|
| Funded deal post to Instagram + safety net | Sched. tasks | Instagram carousel for each newly Closed deal | Reads Closed moves (sync), **Monday item assets** (commitment PDFs), Book of Business **LTV formula** and Property Address columns | Repoint reads; the LTV formula and file reads need Solver.ca equivalents | M | Claude session |
| Funded deal reel (scheduled) + funded-deal-reel skill | Sched. task / skill | Reel for each closed deal | Reads closed deals (connector) | No change after sync repoint | S | Claude session |
| topic-ideator | Skill | Weekly content ideas from client data | Client data via connector | No change | S | Ethan |
| Bank of Canada news to Instagram, daily Instagram draft, daily organic video | Sched. tasks | Social content | None | No change | - | Claude session |
| Meta C1 ads on/off (weekly) | Sched. tasks | Pause/resume a DS campaign | None | No change | - | Claude session |
| Payment-reminder replies check, Nov 10 DS sign-up check, Ifglass growth check | Sched. tasks | One-offs and reminders | None (sign-up check matches leads by phone) | No change | - | Claude session |
| Organize downloads/desktop, work library update, Fathom playbook builder, daily report filing | Sched. tasks | Housekeeping and filing | None | No change | - | Claude session |
| e-Transfers to Discord, Interac payment checker, Stripe payments to Discord, new-payment welcome-pack ping, Zoho payments reminder, payment plan screenshots to Zoho, missed payment notices (off) | n8n cloud | DebtSolvers payments | None (welcome-pack ping reads its own table) | No change | - | Claude session |
| Complaints from admin@, payment messages from texts/emails | n8n cloud | Discord alerts | None | No change | - | Claude session |
| Discord reader (messages, PDFs), Discord Q&A bot (off), DS quiz visit counter, intake booking pages, read-only peeks (Drive, DocuSign, calendar, inboxes, RingCentral) | n8n cloud | Utilities | None | No change | - | Claude session |
| Recruitment funnel: grade recording | n8n cloud | Grades a candidate recording | None | No change | - | Claude session |
| Facebook ad spend, search terms, FB lead qualifier, quiz lander, quiz funnel tracking, careers/reviews/refresh pages, client WordPress site sync, agency website | Agency | Marketing data and pages | None (FB ad spend links leads by the Monday Ad ID column, via sync) | No change after sync repoint | - | Alborz-agency |
| Academy, setter manual, training portal, lender matcher, closer call library, fulfillment email builder, fulfillment certification | Agency pages | Training and tools | None | No change | - | Alborz-agency |
| automation-health, pr-checks, discord-archive, ringcentral calls/SMS import | Agency | Ops plumbing | None directly | No change | - | Alborz-agency |
| aspire-underwriter, mortgage-package-dater, mortgage-package-filler, mortgage-associate-agreement, action-style-profile, ms-video-edit, morning | Skills | Underwriting, forms, contracts, video, morning brief | None stated | No change | - | Ethan |
| Trading bot (off) | Sched. tasks | Personal | None | No change | - | Ethan |
| Training/report/marketing artifacts (scripts, playbooks, CFO reports, funded deal write-ups, agreements, ad reviews, careers pages) | Artifacts | Static pages | None | No change | - | Claude session |

---

## Move order

Solver.ca can run beside Monday for a while because its import is read-only on Monday's side. The order below keeps leads flowing and nobody double-texted. Do not switch a tool to Solver.ca until the team is working in Solver.ca for that board, or leads will be texted from one system and worked in the other.

**Step 0. Before anything moves (prerequisites)**
1. List every native Monday automation, form, email automation and webhook on every board in both businesses (MortgageSolvers and DebtSolvers), since this sweep could not see them.
2. Decide the id rule: imported items keep their Monday id (or a `monday_id` column), and new items get a stable id the sync, portal links and reports can use.
3. Recreate boards with the **same column titles and status labels** (NA 1..NA 5, Transferred, Fish Tank, Court values, drop reasons). Reports read columns by title.
4. Close the feature gaps that block the most tools: file columns (documents bots, Scarlett, Conditions Reply), a button column or status-triggered webhooks (all buttons), a way to compute or store formula values (Request Documents link, Book of Business LTV), and a long-text or link field for Deal DNA.
5. Give automations access: Solver.ca API keys for the agency server and n8n, and a Solver.ca connector or credential for Claude scheduled tasks.

**Step 1. Data spine (agency)**
6. Repoint the Monday board sync, full fields, updates ingest and activity feed to Solver.ca (API + webhooks). Run both in parallel and compare counts for a few days. Most dashboards, leaderboards, alerts and the MortgageSolvers connector follow automatically.

**Step 2. Lead intake (must move before Monday can be switched off; cut over on the same day per business)**
7. MortgageSolvers: the 5 Facebook lead routers, Google quiz router, referral router, website router and the rotator board ids.
8. DebtSolvers: DS Facebook leads workflow, the qualify quiz, and both missing-lead checks (merge them).
9. On the same day: speed-to-lead texting (switch from Monday `create_item` to Solver.ca `item.created`) so new leads still get their first text, and the Debtsolvers follow-ups to Discord feed.

**Step 3. Follow-up ladders and alerts**
10. NA follow-ups (status trigger), new-lead intro emails, 3-day re-engage, after-hours responder lookups.
11. Fish Tank: recreate the board, the move-in rules and the raised-hand hand-off.
12. Neglect alarms, Command Board, DS Text Bookings, DS follow-ups page, client care and missed-call lookups.

**Step 4. Deal desk**
13. Closer Desk mover (or a Solver.ca move automation), Group Change webhook, stage posts, closed-deals sheet, renewal cards.
14. Deal-desk buttons: Build Application, Validate File, Savings Report, Client Report, Signing Package, Conditions Reply, Send to Scarlett; then the hourly Scarlett push.
15. Call transcription notes, Deal DNA, auto application drafts, daily meeting updates.
16. Documents: MMS bot, email documents bot, client document links and the Request Documents link (needs file support or the Drive-link fallback).
17. DebtSolvers after-signing flow: welcome pack, intake rotation, file numbers, intake form, Send Reminder and Send to Trustee buttons, document reminders and follow-ups, trustee status texts, e-Transfer notes, Admin workspace boards, the filing confirmation email.

**Step 5. Reports and skills**
18. Claude scheduled reports: setters, closers, fulfillment, fulfillment action list, court report, junk/lost audit (writes Status), setter focus list, call reports, Mark's to-do, closer reports, loss debrief, DS daily pipeline, DS rep reports, Stats dashboard.
19. Skills that read Monday: mortgage-application-builder, team-daily-scoring, mortgagesolvers-commission, closer-call-scoring, linkedin-organic-skill; funded deal posts (Book of Business LTV and commitment files).

**Step 6. Switch off**
20. Final Monday copy into Solver.ca, freeze Monday (read-only), turn off Monday webhooks and the Monday change watcher, remove Zapier monday.com connections, retire `solver/monday.js` import, then cancel Monday once a month of reports reconcile.

**Can retire instead of moving:** DS power dialers (Michael left), DS instant intro text (off), DS Leads Center match/send (off), DS add sign-ups to CLIENT TRACKER (off), MS inbox triage and daily review (off), DS win-back replies (off), missed-call texts (never live), Deal OS CRM pilot (if Solver.ca replaces it).

## Can't tell

- **Native Monday automations, forms, email automations and webhooks** on every board: not visible from here. Need a list from Monday (Integrations and Automations center per board).
- **Zapier Zaps**: Zapier's tools only show 9 monday.com connections, not Zaps. Still-running Zaps that touch Monday are unknown (the Google quiz relay is known; the closer stage Zap was replaced; DS lead Zaps were turned off Nov 6).
- **Agency n8n workflows beyond those named in the catalog**: the agency n8n was not readable here.
- **Website lead router** (new WordPress site): live since Nov 5, but whether it creates a Monday item directly or goes through a router is not stated.
- **DS Agreement sender** and **DS weekly unsigned agreements** (n8n cloud): may read Monday cards or only DocuSign.
- **DS admin morning to-do lists** (n8n cloud): likely reads the Clients board, not confirmed.
- **DS weekly scorecard** (Monday 10:17 AM task): reads the lead sheet; unclear whether its scripts also read Monday.
- **DS dial updates, daily SMS speed and call reviews**: phone-based; unclear whether the scripts look up Monday names.
- **MortgageSolvers closer report and loss debrief scripts** (`closer_daily.py`, loss runbook): they read moves and cards, but whether through Monday directly or the connector is in scratch files I could not open.
- **Shared artifacts** (Keystone CRM, Funding Tracker x2, Upcoming Deals by Source, Junk and Lost Leads, Deal Velocity report, Armory Call Scorecards, Deal Debrief page): data source not checked; static snapshots need nothing, live ones follow their feeder.
- **The morning skill**: description does not say whether the brief reads Monday.
- **Book of Business board**: maintained by hand by fulfillment; its formula columns (LTV, Total Mortgages) are used by the funded deal posts and need a Solver.ca equivalent.
- **Monday Docs already attached to items** (Deal DNA docs): whether the Solver.ca import copies doc contents is not stated in its README.
