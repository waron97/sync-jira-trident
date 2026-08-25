# Plan: extend sync-jira-trident to all TESTML tickets

Status: brainstorm / exploration, not yet approved for implementation.
Written: 2026-08-21.

## 1. Goal

Today the script only syncs TESTML issues assigned to 4 hardcoded ML-team
developers. The ask is to extend it to **every open TESTML bug/enhancement
ticket whose Jira assignee resolves to a Team JIRA Sorgenia (project 41)
member** (not literally every open ticket regardless of assignee — see the
§4a correction, which superseded an earlier "fall back to Cristina for
anything unresolved" idea in favor of a hard skip), while:

- keeping the existing severity/cluster/description rules,
- correctly resolving the Trident assignee and "work package" (cluster) even
  when the raw Jira assignee string isn't already an exact match for a
  known dev (typos, login-style formatting, etc — via allowlist/fuzzy/LLM),
- optionally using an LLM to help with ambiguous matches,
- skipping (not creating) any ticket whose assignee doesn't resolve to a
  project-41 member — no fallback-to-PM default, no silently defaulting to
  a random dev either,
- (added mid-session) tagging tickets by type (Enhancement, Bug, ...) in
  Trident,
- (added mid-session) carrying the Jira "priority week" field into Trident's
  sprint field,
- (added mid-session) mirroring Jira close/reopen into the Trident stage:
  closed-in-Jira → closed-in-Trident, reopened-in-Jira → reopened-in-Trident.

## 2. Current behavior (for reference)

- `src/util/jira.js`: JQL restricted to
  `assignee in ("Aron Winkler","Selene Verna","Licia Matarrese","Giulia Cavicchia")`,
  status in (`DA VERIFICARE`, `IN RESOLUTION`), type in (`Bug`, `Bug UX/UI`,
  `Enhancement`, `Verifica`).
- `src/commands/run.js`: builds a Trident `project.task` per issue.
  Assignee/owner resolved via two hardcoded maps (`ASSIGNEE_MAP`,
  `OWNER_MAP`) keyed by Jira display name, both defaulting to Giovanni
  Corrado (`TRIDENT_ID_GIOVANNI`) for anyone not in the map.
- `src/util/trident.js`: `matchCluster()` does a substring/best-score match
  of `processoDiRiferimento` (e.g. `CROSS_12.2`) against `x_cluster.x_name`.
- Auto-reassignment of existing tasks based on Jira assignee was tried and
  **deliberately removed** (commit `71e0a9d`, "disable auto reassignment of
  tickets") — worth remembering as prior art / a cautionary precedent before
  reintroducing any continuous-reassignment behavior.

## 3. Research findings (data pulled live from Jira/Trident during this session)

### 3.1 Volume once the assignee filter is dropped

Same status/type filter, no assignee restriction: **289 open TESTML tickets**
(vs. the current handful). Breakdown by `Tipologia segnalazione`:
Bug 185, Enhancement 76, Bug UX/UI 17, Verifica 11.

### 3.2 The assignee field is mostly not a developer

~50 distinct Jira assignees on those 289 tickets. Top ones: Giovanni Corrado
(42), **Carmela Sannino** (39, tester), **Eleonora D'Agostino** (30, tester),
Francesco Bertelli (12), Filippo Vinci (9), Licia Matarrese (8)... The bulk
of assignees are UAT testers / RTI-CRM business users, not engineers. That
kills the naive idea of "map Jira assignee name → Trident person" as the
*sole* mechanism — most tickets are sitting with a tester as "assignee" in
Jira at any given time, not with the dev who should fix it.

**However** — per your explicit answer, this is still the primary
mechanism. It just needs to be robust and to fail closed (→ Cristina)
rather than fail into "assign to Giovanni no matter what," which is what
happens today.

### 3.3 Name matching is more solvable than it looks, but has a trap

Almost everyone in that assignee list — including testers like Carmela
Sannino, Ivana Della Pia, Sara Pompeo — **already exists as a `res.users`
record in Trident** (single shared Odoo instance across the org). Running a
normalized exact-name match (case-fold, `.`→space) against the *full*
`res.users` table resolves 35/52 sample names.

This is a trap, not a win: a name existing in Trident does not mean that
person is a valid engineering assignee for project 41 ("Team JIRA
Sorgenia"). If the resolver searches all of `res.users`, it will happily
"successfully" assign engineering tasks to testers and business users who
happen to have an Odoo login for unrelated purposes. **The match must be
constrained to an explicit allowlist of known engineers**, not the whole
user directory. Anyone not on that allowlist should be treated as
unresolved, even if a same-named Trident user exists.

**Resolved**: the allowlist doesn't need to be a hand-maintained list at
all. Checked live — `project.project` (id 41) has `message_partner_ids`
(its followers), which resolves to exactly 12 people, all real engineers/PM:
Giovanni Corrado, Selene Verna, Aron Winkler, Licia Matarrese, Giulio
Gulizia, Matteo Tognini, Sara Moretti, Najada Xara, Luca Carnevale, Giulia
Cavicchia, Cristina Passarello, Filippo Iovine. Each resolves cleanly to a
`res.users` record via its `partner_id` (ids 48, 65, 279, 62, 208, 342, 346,
305, 330, 49, 354, 47 respectively). This is a self-maintaining roster —
whoever is added/removed as a follower of project 41 in Trident
automatically updates the allowlist, no code change needed. (Note:
`favorite_user_ids`, labeled "Members," is empty for this project — not
usable; followers is the real roster here.)

Some Jira assignee strings are login-style (`luca.carnevale`,
`beatrice.zinchi`, `stefano.bartesaghi`, `marco.brugnano`, `tania di monda`)
rather than display-name style — normalization (dot→space, case-fold) is
required just to get exact matches for people who *are* legitimately on the
allowlist under a different string format.

Genuinely unmatchable examples confirmed in this dataset: `RTI-CRM RTI-CRM`,
`RTI-M2C-CREDITO RTI-M2C-CREDITO` (shared team accounts), `(unassigned)` —
these need no special-case detection. They're just allowlist misses like
any other non-dev assignee, and fall through the same generic pipeline to
Cristina as everyone else who isn't a recognized engineer.

### 3.4a Correction (found during Phase 1 implementation): archived clusters were invisible

Live-checked during Phase 1 implementation: `x_cluster.search_read([[]])`
with no context returns only **410** rows — but adding
`context: { active_test: false }` returns **1,061**. Odoo's default
active-record filter was silently hiding 651 archived `x_cluster` rows
(61% of the true total) from every prior run of this script, including the
existing production `run`/`generate` write path, not just the new report
command. This is almost certainly the mechanism behind the "clusters go
missing" behavior Aron described working around manually by cloning a
ticket that already had the desired work package (the same class of Odoo
record-visibility gotcha the `trident-work-item` skill documents for
`x_subpackage_id`, though there it's a follower-visibility rule rather
than the active filter).

Checked whether a *further* visibility restriction (like the
follower-based one for `x_subpackage_id`) also applies to `x_cluster`:
cross-referenced every distinct `x_cluster_id` referenced by existing
`project.task` rows (789 distinct ids across a 5k-row sample, all
projects) against the full 1,061-row `active_test:false` fetch — zero ids
were missing. So no second-layer visibility gate here; the active filter
was the whole gap. **Fix applied**: `fetchClusters()` now always passes
`context: { active_test: false }`.

### 3.4 Cluster ("work package") matching is already decent, gap is ~17%

Running the existing `matchCluster()` string algorithm against all 289
tickets: **239 matched (83%)**, 44 had a `processoDiRiferimento` but no
matching cluster, 6 had no `processoDiRiferimento` at all. So ~17% of
tickets land with `x_cluster_id: false` today, and would still need a
fallback (AI-assisted or Cristina) after extending scope.

`x_cluster` also has an `x_owner_id` field (a real "who owns this process
area" pointer) — but it's only populated on **17 of 410** clusters (e.g.
`ML | Inorder` → Ilaria Nicolella, `ML | Post-Sales - P` → Licia Matarrese).
Too sparse to be a primary mechanism, but worth using as a free, deterministic
signal for `x_tech_ownership_id` whenever it happens to be set, before
falling back to anything heuristic/AI-driven — this is a different field
than `user_ids` (assignee) so it doesn't conflict with the name-based
assignee logic you confirmed.

### 3.5 Cristina Passarello's Trident ID

Found: `res.users` id **354**, login `cristina.passarello@hoverture.com`.
Needs a new `TRIDENT_ID_CRISTINA` env var.

### 3.6 Tags (new requirement)

`project.tags` already has tags matching 3 of the 4 `Tipologia segnalazione`
values: `BUG` (id 21), `Enhancement` (id 251), `VERIFICA` (id 70). **There
is no `Bug UX/UI` tag** — 17 of the 289 tickets are this type.
**Resolved: fold `Bug UX/UI` into `BUG`**, no new tag created.

`project.task` also has `x_main_tag_id` (single tag) alongside `tag_ids`
(many2many). Checked live how it's actually used elsewhere: it's a real,
widely-used convention — **4,364 of 12,010 tasks org-wide** have it set,
including **78 of project 41's own 288 tasks already**. The pattern seen in
samples is "the one tag that matters most" mirrored into `tag_ids` too
(e.g. a task tagged `TISG` has both `tag_ids: [290]` and
`x_main_tag_id: [290, 'TISG']`), and at least one existing row already uses
a type tag as the main tag (`x_main_tag_id: [21, 'BUG']`) — confirming this
is exactly the kind of field the type tag belongs in. **Resolved: when a
type tag applies (`BUG` for Bug/Bug UX/UI, `Enhancement`, `VERIFICA`), set
it as both `x_main_tag_id` and inside `tag_ids`.**

### 3.7 Sprint / priority-week (new requirement)

Found the Jira field: `customfield_11690`, labelled **"BUG PRIORITARI -
SETTIMANA DI RIFERIMENTO"**, a select field. Only populated on **55 of 289**
tickets (19%) — this is specifically a "priority bug" scheduling field, not
something every ticket has. Values look like `"10.0. 17-21 Agosto"` (a
sortable rank prefix + day range + month, no year; and at least one
observed cross-month form: `"03.0. 29 Giugno - 3 Luglio"`).

Trident has a matching concept: `project.task.x_sprint_id` (many2one to
`x_project_sprint`), and `x_project_sprint` has `x_name` / `x_date_from` /
`x_date_to`. Sample records: `"17 a 21 | Agosto 2026"`,
`"31 Agosto a 4 Settembre | 2026"`. This model has **no `project_id`
field** — it's global, not scoped to a specific Trident project — so yes,
it's directly usable "wholesale" on project 41 (Team JIRA Sorgenia) tasks,
the same as on project 14 (Sorgenia ML Sviluppo). It's just almost entirely
unused today: 0/288 tasks in project 41 and 1/1000 in project 14 have
`x_sprint_id` set, so there's no existing convention to conflict with.

Two data-quality problems found in `x_project_sprint` that any matching code
needs to route around:
- **Duplicate records** for the same week exist (e.g. two separate rows both
  named `"17 a 21 | Agosto 2026"`, ids 6 and 55). Matching by name alone is
  ambiguous.
- At least one record has `x_date_from`/`x_date_to` **swapped** (id 4,
  `"3 - 7 Agosto 2026"` has `date_from = 2026-08-07`, `date_to =
  2026-08-03`). Matching by date range alone is unreliable for that record.

So: match primarily on a normalized text comparison of the day-range+month
(strip separators/year/pipe). **Resolved: on a duplicate match, deterministically
pick the lowest id** — you'll flag the duplicate-row data issue to whoever
owns the Trident sprint list yourself, the script doesn't need to do
anything special beyond picking consistently and logging which id it chose.

**Resolved: if no existing `x_project_sprint` matches after a thorough
normalized-text search (not just a literal `x_name` equality — check
day-range+month across all rows, not just the ones that happen to already
look clean), create a new one.** Checked live: `x_project_sprint` has no
required fields beyond the three data fields (`x_name`, `x_date_from`,
`x_date_to` are all technically optional per `fields_get`, but obviously
should be populated on create) and no `project_id` scoping to worry about —
creation is a plain, unblocked `create` call. The "be sure it's actually
missing" instruction matters here specifically because of the duplicate-row
mess found above — a naive check against a single canonical name could
false-negative and create a third duplicate; the search needs to normalize
the same way the match step does before concluding nothing exists.

### 3.8 Close/reopen mirroring — the Trident stage model, checked live

Project 41's kanban stages (`project.task.type`, live query):
`Backlog`(1972), `Da Fare Urgente`(1973), `In Corso`(1974), `Da
rilasciare`(1975), `Risolto su JIRA`(1976), `Da aggiornare Excel`(2002),
`Aggiornato su Excel`(2003), `In attesa Ingegneria`(1979),
`Chiarimenti`(1977), `Rifiutato`(1987), `Riassegnato su Jira`(2025).

There is **no separate "Chiuso"/"Closed" stage** — `Risolto su JIRA` (1976,
already referenced by `TRIDENT_RESOLVED_JIRA_STAGE_ID`) is already this
team's terminal/closed stage for successfully-fixed tickets, and
`Rifiutato` (1987) is the terminal stage for rejected ones. Current
distribution across project 41's 288 tasks: `Risolto su JIRA` holds by far
the most (182), `Rifiutato` holds 27, everything else is much smaller —
consistent with those two being the two "done" endpoints of this workflow.

Checked whether Odoo's `is_closed` boolean field on `project.task` could be
used as a generic "is this done" signal instead of stage IDs: live query
shows `is_closed` is **not stage-derived** — within the single
`Risolto su JIRA` stage, 146 tasks have `is_closed=false` and 36 have
`is_closed=true`. That's Odoo's personal/per-user kanban folding leaking
into a global field, not a reliable global signal — don't use it. Stage ID
is the right thing to write and read.

**What already exists**: the current `toReopen` logic in `run.js` already
implements the reopen direction, just implicitly — it moves any task
sitting in `Risolto su JIRA` back to `Backlog` if the ticket is still
present in the "open" Jira query result (i.e. Jira shows it as
`DA VERIFICARE`/`IN RESOLUTION` despite Trident marking it resolved). This
is effectively "Jira reopened it → Trident reopens," already working,
scoped only to the `Risolto su JIRA` stage.

**What's missing**: the forward direction. Nothing today moves a Trident
task *into* `Risolto su JIRA` (or `Rifiutato`) when the Jira issue actually
reaches `Resolved`/`Closed` (or `Rejected`). Those tickets simply fall out
of the current JQL's result set and are never touched again — the human has
to remember to drag the Trident card over manually. Also, Jira's `Bug`
issue-type workflow has one more terminal-ish status not yet mentioned:
`SRG Business Check` (seen in the earlier `/project/TESTML/statuses` dump)
— worth deciding whether that one counts as "still open" (probably yes,
it's a pre-closure review step) or is treated as done.

## 4. Decisions already confirmed with you this session

1. **Scope**: drop the assignee filter from the JQL entirely; keep status
   (`DA VERIFICARE`, `IN RESOLUTION`) and type filter as-is.
2. **"Work package" = `x_cluster`**, matched via `processoDiRiferimento` as
   today. Prefer `x_cluster.x_owner_id` when set (17/410 cases) before any
   heuristic/AI fallback, for the *ownership* field specifically.
3. **Assignee resolution stays primarily name-based** — try to match the
   Jira assignee to a known Trident engineer first; do not pivot to a
   cluster/AI-driven scheme as the primary mechanism.
4. **"Failed resolution" reinterpreted, then corrected**: not a Jira
   workflow status — it means *"the script could not confidently resolve
   the assignee to a Team JIRA Sorgenia (project 41) member."* First pass
   of this decision (superseded, see §4a below) said to fall back to
   **Cristina Passarello** (id 354) as the assignee. **Corrected during
   Phase 1 implementation**: there is no fallback assignee. A ticket whose
   Jira assignee doesn't resolve to a project-41 member (via
   exact/fuzzy/LLM against the allowlist) is **skipped — no Trident task
   is created for it at all**, full stop. Only tickets with a resolved
   member assignee get created. This makes the Cristina-fallback idea, and
   `TRIDENT_ID_CRISTINA`, dead — removed from `.env` and from the pipeline.
   See §4a, §5.2, §5.6.
5. **No re-sync of human-editable fields, at all, ever — with exactly one
   exception (stage).** Assignee, ownership, cluster, tags, and sprint are
   resolved and written only at task-creation time. Once a Trident task
   exists, the script never touches those fields again, even if a later
   sync run would resolve them differently — a human may have manually
   corrected any of them, and the script has no way to distinguish "still
   unresolved" from "a person already fixed it." The sole exception is
   `stage_id`, via the close/reopen mirroring in §5.7, because that field's
   entire purpose here is to track Jira's live status, not something a
   human is expected to hand-tune independently of Jira. This also settles
   the "continuous reassignment" question from the previous round the same
   way commit `71e0a9d` already did — no resurrecting it.

### 4a. Correction (2026-08-21, during Phase 1 implementation): no Cristina fallback — unresolved assignee means skip

Aron's original intent, confirmed after the Phase 1 dry-run surfaced the
Cristina-routed numbers: **only sync tickets whose Jira assignee resolves
to a project-41 (Team JIRA Sorgenia) member.** Everything else is simply
not created — the script is not the place to triage ambiguous ownership,
Jira's own assignee field already is that place. This also means:

- `x_tech_ownership_id` never needs a Cristina fallback either (§5.3) —
  it's cluster-owner-if-set, else the (now-guaranteed-resolved) assignee's
  id. Ownership resolution is only even attempted for tickets that pass
  the assignee gate.
- §5.6 ("marking unresolved/Cristina-routed tickets") is moot — there's
  nothing to mark on the Trident side, since nothing gets created for
  those tickets. The report command still logs *why* a ticket was skipped
  (for reviewing whether the allowlist/mapping needs work), it just
  doesn't need a Trident-visible marker.
- Keeping the allowlist → exact → fuzzy → LLM resolution chain accurate is
  now the single point of correctness for whether a ticket gets synced at
  all, not just for who it lands on — mapping quality matters more, not
  less, under this correction.

## 5. Proposed pipeline

### 5.1 JQL / scope

```
status in ("DA VERIFICARE","IN RESOLUTION","SRG Business Check")
AND cf[10312] in ("Bug","Bug UX/UI","Enhancement","Verifica")
```
(project clause implicit via the existing `/search/jql` base — confirm it's
still scoped to TESTML the same way it is today; `SRG Business Check` added
per the §5.7 resolution that it counts as open).

### 5.2 Assignee resolution (`user_ids`) — create-time only, per §4.5

1. Build the **allowlist** at runtime from project 41's followers
   (`project.project.message_partner_ids` → `res.users` via `partner_id`,
   confirmed live in §3.3) rather than a hardcoded/manually-maintained list.
   This is the safety net that prevents "name happens to exist in Trident"
   from turning into "task gets assigned to a tester," and it stays correct
   automatically as the team's follower list changes in Trident.
2. Normalize the Jira assignee string (case-fold, `.`→space, collapse
   whitespace) and try an **exact match against the allowlist only**.
3. If no exact match, try a **fuzzy match** (edit distance / token
   overlap) against the allowlist only, for typos and format drift.
4. If still no match, optionally ask an LLM: *"given this raw Jira
   assignee string and this fixed list of N known engineers, is one of them
   clearly the same person? Otherwise say no match."* Constrained to the
   same allowlist — the LLM is a smarter fuzzy-matcher here, not a free
   lookup against the whole org.
5. If nothing matches → **skip this ticket entirely, no Trident task
   created** (corrected per §4a — no Cristina fallback).

### 5.3 Work package / ownership (`x_cluster_id`, `x_tech_ownership_id`) — create-time only, per §4.5

1. Keep `matchCluster()` as the first pass (83% hit rate already).
2. If no match (or a weak score — consider exposing/using the score,
   currently discarded), optional LLM fallback: give it the ticket
   summary + description + `processoDiRiferimento` string + the full list
   of ~410 cluster names, ask for the best match or "none."
3. `x_tech_ownership_id`: if the resolved cluster has `x_owner_id` set, use
   it. Otherwise fall back to the resolved assignee's id (today's
   `OWNER_MAP` logic) — always available since ownership is only resolved
   for tickets that already passed the §5.2 assignee gate (corrected per
   §4a, no Cristina fallback needed here).
4. If cluster still can't be resolved after the LLM pass, keep
   `x_cluster_id: false` as today — this doesn't affect whether the ticket
   gets created (that's gated on assignee only, per §4a).

### 5.4 Type tag (`tag_ids`, `x_main_tag_id`) — create-time only, per §4.5

Map `tipologiaSegnalazione` → tag id:
- `Bug` **and** `Bug UX/UI` → `BUG` (21) — folded together, no new tag.
- `Enhancement` → `Enhancement` (251)
- `Verifica` → `VERIFICA` (70)

Add the resolved tag to `tag_ids` via `[[6, 0, [tagId]]]` (same idiom as
`user_ids`) **and** set it as `x_main_tag_id`, matching the convention
confirmed live in §3.6.

### 5.5 Sprint (`x_sprint_id`) — create-time only, per §4.5

Only applies when `customfield_11690` is populated (~19% of tickets):
1. Parse the raw value, strip the leading rank prefix (`"10.0. "`), extract
   the day-range + month(s) (handling the cross-month form).
2. Normalize the same way for `x_project_sprint.x_name` (strip `|`, unify
   `a`/`-` separators, drop the year) and look for a text match across
   *all* existing rows.
3. If exactly one match, set `x_sprint_id`. If multiple match (duplicate
   sprint rows, confirmed to exist), pick the lowest id, and log which one
   was picked so the duplication can be reported upstream. If genuinely no
   match after that normalized search, **create** a new `x_project_sprint`
   row (`x_name`/`x_date_from`/`x_date_to` derived from the parsed Jira
   value) and use it — confirmed unblocked, no required fields or
   project-scoping stand in the way (§3.7).

### 5.6 Marking unresolved tickets — superseded, see §4a

No longer applicable: an unresolved assignee means the ticket is skipped
(no Trident task created), not routed to Cristina with a marker. The
report command logs the skip reason for human review instead.

### 5.7 Close/reopen stage mirroring

**Correction (2026-08-21, after implementing and read-only-simulating this
against live data): the closing direction is permanently disabled.** Aron
explicitly rejected auto-closing after seeing what it would actually touch
(42 stage moves across the board on the first live simulation, including
some tasks bouncing between `Risolto su JIRA` and `Rifiutato` as Jira's
status changed) — this is the same class of decision as commit `71e0a9d`
("disable auto reassignment of tickets"): an auto-mirroring behavior that
looked reasonable in the abstract turned out to have more real-world blast
radius than wanted once its actual effect was visible. **Don't
reintroduce a Jira-closed/rejected → Trident-stage-move pass** without
this being explicitly re-requested. The code for it
(`fetchJiraStatusesForKeys`, the `TERMINAL_STATUS_STAGE` map, `syncCloses`)
was removed from `src/util/jira.js`/`src/commands/run.js` rather than left
disabled/commented out.

What follows below (the original design for the closing pass) is kept only
as a historical record of what was tried, in case this ever gets
re-requested — it is NOT current behavior.

Two directions were originally planned, both driven by comparing each
existing Trident task's current `stage_id` against its linked Jira issue's
current `status`:

**Closing** *(removed — see correction above)*. For every existing Trident
task (matched by the `[TESTML-xxxxx]` key in its name) whose Jira issue has
reached a terminal status and whose Trident stage isn't already the
matching terminal stage:
- Jira `Resolved` or `Closed` → move Trident task to `Risolto su JIRA`
  (1976).
- Jira `Rejected` → move Trident task to `Rifiutato` (1987).

This needed a second Jira query beyond the "open tickets" JQL, since
`Resolved`/`Closed`/`Rejected` issues are excluded from it by design,
scoped to only the keys that already have a Trident task (extract the Jira
key from each existing task's `name`), chunked for Jira's `key in (...)`
JQL size limit.

**Reopening** *(kept — this direction is still active)*. Generalize the existing `toReopen` logic (currently
`Risolto su JIRA` → back to `Backlog` if still open in Jira) to also cover
`Rifiutato` — a rejected ticket that gets reopened on the Jira side pops
back out of `Rifiutato` too. **Resolved: both reopen paths land in
`Backlog`** (`TRIDENT_STARTING_STAGE_ID`), same as today's behavior — no
separate target stage for the `Rifiutato` case.

**Resolved: `SRG Business Check` is treated as open.** It should be added
to the "open" JQL status list alongside `DA VERIFICARE`/`IN RESOLUTION` (so
those tickets keep getting tracked/synced normally) and, correspondingly,
is *not* one of the terminal statuses the closing pass reacts to.

## 6. LLM / OpenAI integration

Given the findings above, the LLM's job is narrower than "match everything
with AI" — deterministic passes already resolve the majority:
- Assignee: allowlist exact+fuzzy match already resolves most known
  engineers; LLM only sees the ~allowlist-sized residual.
- Cluster: string match already resolves 83%; LLM only sees the ~17%
  residual (~50 tickets today).

Design sketch:
- One structured call per unresolved item (or batch several per call to
  save on round-trips), with a strict output schema (`{match: string|null,
  confidence: number}}`), so a low-confidence "match" can still be treated
  as no-match above/below a threshold you pick.
- **Data sent matters**: ticket descriptions in this project routinely
  contain customer PII — codice fiscale-shaped values (e.g.
  `DNGTMS04C29B963C`), P.IVA/customer numbers, case numbers. Sending full
  descriptions to a third-party API is a real consideration, not a
  formality. Two ways to reduce exposure: (a) for assignee matching, you
  never need description text at all — only the raw assignee string; (b)
  for cluster matching, consider sending just the summary + processo code
  rather than the full HTML description, and/or check whether your OpenAI
  account has zero-data-retention / no-training terms before sending
  anything ticket-derived.
- Every AI-assisted match should be logged (ticket key, input, chosen
  match, confidence) to a report file for human spot-checking, at least for
  the first several runs — this is a case where a wrong guess has a real
  workflow cost (task lands on the wrong desk).

## 7. Follow-up round — all previously-open questions, now resolved

1. **Bug UX/UI tag** → fold into `BUG`, no new tag. (§3.6, §5.4)
2. **`x_main_tag_id`** → checked live usage (4,364/12,010 tasks org-wide,
   78/288 in project 41 itself, `BUG` already used as a main tag
   elsewhere) → set it whenever a type tag applies. (§3.6, §5.4)
3. **Sprint duplicates** → pick the lowest id deterministically and log it;
   you'll report the duplicate-row issue to whoever owns the Trident sprint
   list yourself. **Also**: if a thorough, normalized search finds no
   match at all, create the missing `x_project_sprint` row rather than
   leaving `x_sprint_id` unset — confirmed live that creation is unblocked
   (no required fields, no project scoping). (§3.7, §5.5)
4. **Allowlist maintenance** → not a hardcoded list at all: derive it from
   project 41's followers (`message_partner_ids`), confirmed live to
   resolve to exactly the 12 real engineers/PM. Self-maintaining. (§3.3,
   §5.2)
5. **Continuous reassignment** → never, for any field except `stage_id`.
   Formalized as decision §4.5: no data a human might manually edit gets
   re-synced by the script, stage is the sole exception because it exists
   specifically to track Jira's live status.
6. **Volume jump** → acknowledged, proceed as planned (dry-run phase in §8
   still recommended as the first sanity check).
7. **`x_project_sprint` applies wholesale to project 41** → confirmed.
8. **`SRG Business Check` status** → treated as open: added to the "open"
   JQL status list, excluded from the closing pass's terminal statuses.
   (§5.1, §5.7)
9. **Reopen-from-`Rifiutato` target stage** → `Backlog`, same target as the
   existing resolved→reopen path. (§5.7)
10. **Key-matching drift for the closing pass** → skip tasks whose name
    doesn't parse, log them, move on. Explicitly **not** worth building
    fuzzy recovery for hand-edited Trident task names — "weird anyway that
    there are such drifts," not something the script should babysit.

## 8. Suggested rollout phases

1. **Dry run / report only** *(done — see `src/commands/report.js`)*:
   broadened the JQL, ran the full resolution pipeline (allowlist match →
   fuzzy → LLM → skip; cluster match → LLM → none; tag; sprint) against
   all 307 currently-open tickets, wrote a report (no Trident writes) for
   human review. Superseded the original "→ Cristina" fallback with the
   §4a skip-gate correction mid-phase.
2. **Deterministic-only rollout**: ship allowlist name-matching, cluster
   string-matching, tag mapping, sprint mapping, and close/reopen stage
   mirroring, without any LLM calls yet; skip (don't create) anything
   unresolved. This alone should handle the large majority given the match
   rates found above.
3. **LLM-assisted fallback**: add the OpenAI pass for the remaining
   unresolved residual, with confidence logging, once you're comfortable
   with the data-sent question in §6.
4. **Monitor & tune**: watch the skipped-ticket bucket size over a few
   runs; if it stays large, that's a signal to grow the allowlist or adjust
   thresholds rather than lean harder on the LLM.

## 9. New config needed

- No hardcoded allowlist needed — fetched live from project 41's
  `message_partner_ids` at runtime (§5.2).
- Tag id constants: `BUG`=21, `Enhancement`=251, `VERIFICA`=70. No `Bug
  UX/UI` constant needed — folded into `BUG`.
- `TRIDENT_REJECTED_STAGE_ID` = 1987 (`Rifiutato`) — new, needed for the
  close-mirroring logic (`TRIDENT_RESOLVED_JIRA_STAGE_ID`=1976 already
  covers the resolved/closed case).
- `OPENAI_API_KEY` — **already added to `.env`**, ready for the §6/§8
  phase-3 LLM fallback whenever that's built; model choice and confidence
  threshold still to be picked at that point.

## 10. New feature (added 2026-08-21): sync Jira comments + attachments to Trident

Goal: for tickets that already have a Trident task, mirror Jira comments
over as traceable Trident comments, attachments included, without
duplicating on repeat runs.

### 10.1 Jira side — comment + embedded-media shape (verified live)

- `GET /issue/{key}/comment` returns each comment's `body` as ADF (same
  format as the description field, reuse `adfToHtml`).
- Comments can embed media two ways: `mediaSingle > media` (images, has an
  `alt` attribute usually equal to the original filename) and
  `mediaInline` (arbitrary files, no `alt`). Both carry an `attrs.id` that
  is a **media-platform UUID, not the same id space as `fields.attachment[].id`**
  — there is no public endpoint that maps one to the other directly.
- **Resolved matching strategy**: cross-reference against the issue's
  `fields.attachment` array by (a) filename === media node's `alt`, when
  present, and (b) fallback: attachment `created` timestamp within ~1s of
  the comment's `created` timestamp — verified live on a real example
  (`image-20260807-104427.png`, attachment id 86089, timestamps matched to
  the second with comment id 163026). No official/documented mapping
  exists; this is a best-effort heuristic like `matchCluster()`'s string
  scoring, not a guaranteed-correct join.
- `adfToHtml` (`src/util/jira.js`) currently has **no case for `mention`,
  `media`, `mediaSingle`, or `mediaInline`** — they fall through to the
  default case and get silently dropped. Needs new cases: `mention` →
  render `attrs.text` (already includes the `@`) as plain bold text;
  `media`/`mediaSingle`/`mediaInline` → resolve via the matching strategy
  above, then render as `<img src="/web/image/{tridentAttachmentId}">` for
  images or a plain link/filename mention for non-image files (only
  resolvable once the attachment has actually been uploaded to Trident and
  its new id is known — ordering matters: upload comment attachments
  before converting that comment's body to HTML).

### 10.2 Trident side — verified live via a real test-and-cleanup on task 18796

- Posting through `project.task.message_post` via this JSON-RPC path
  **double-escapes HTML** (confirmed independently; the `trident-work-item`
  skill already documented this same finding for its own `comment`
  command). Real HTML tags come back as literal `&lt;p&gt;` text.
- **Fix: create the `mail.message` record directly** (`mail.message.create`,
  not `message_post`). Verified live: HTML in `body` is preserved exactly
  as written, `<img src="/web/image/{id}">` embedded-image tags survive
  untouched, and `attachment_ids: [[6,0,[attId]]]` links correctly. Only DB-
  required field on `mail.message` is `message_type`.
- Comment attachments are plain `ir.attachment` rows with
  `res_model: "project.task"`, `res_id: <taskId>` — same shape as
  `createTridentAttachment()` already uses for task-level attachments —
  then linked to the specific message via `attachment_ids`.
- `subtype_id`: real human-posted comments observed in the wild split
  between `1` ("Discussions", notifies followers) and `2` ("Note", doesn't).
  Not yet decided which to use for synced comments — leaning `2` (Note) to
  avoid a notification storm on first backlog import, revisit for
  steady-state new comments. **Open question, not decided.**

### 10.3 Idempotency marker (resolved design, 2026-08-21)

Append a footer paragraph to every synced comment's HTML body:
```html
<p><small style="color:#999999">↪ Jira comment #{commentId} · {authorDisplayName} · {createdDateISO}</small></p>
```
`{commentId}` (Jira's own numeric comment id — stable, never reused) is
the actual idempotency key; author/date are for human readability.

Detection is one bulk query per sync run, not one per task:
```js
mail.message.search_read(
  [["model","=","project.task"],["res_id","in", taskIds]],
  { fields: ["id","res_id","body"] }
)
```
then regex `/Jira comment #(\d+)/` against each `body` to build
`Map<taskId, Set<jiraCommentId>>`; skip posting if the id is already in
that task's set.

**Why body-embedded, not a dedicated field**: `mail.message` has no
custom/external-id field exposed via this API without a schema change —
embedding in the rendered text is the only durable-enough option
available through plain RPC.

**Known limitation, accepted**: if a synced Trident message is manually
deleted, its marker goes with it and the next run will re-post it — no
external-id fallback exists. Same class of accepted edge case as the
sprint/cluster duplicate-row issues in §3.4a/§3.7, not worth building
recovery logic for.

**Open question, not decided**: the marker keys off comment id only, so an
*edited* Jira comment's Trident copy will NOT reflect the edit after the
first sync (post-once, never update) — consistent with this project's
broader "no re-sync after initial write" philosophy (§4.5), but flagged
explicitly since it's a real behavioral choice, not an accident.

### 10.4 Wiring (resolved 2026-08-21): part of `run`/`start`, not a separate command

Comment sync is a new stage inside the existing `runCommand` pipeline
(alongside `syncCreates`/`syncReopens`), not a standalone CLI command —
runs every `run`/`start` tick automatically. Scope = the same task
population `syncReopens` already iterates: every existing Trident task
with a parseable `[TESTML-xxxxx]` key, not just newly-created ones — old
tickets keep accumulating Jira discussion too. This also settles "one-time
backlog import vs ongoing": there's no separate backlog pass: the very
first run naturally does a full backlog import (nothing is marked synced
yet), and every run after that just picks up whatever's new, via the same
idempotency-marker check either way.

One Jira HTTP call per existing task per run (`/issue/{key}/comment`) —
there's no bulk multi-issue comment endpoint. Fine at ~288 tasks/10min;
revisit only if this becomes a real rate/latency problem.

### 10.5 Still not decided

- The `subtype_id` open question from §10.2 (Note vs Discussions).
- The edited-Jira-comment question from §10.3 (post-once vs reflect edits).
- No code written yet for this feature — §10.1–10.4 are confirmed design,
  not implementation.
