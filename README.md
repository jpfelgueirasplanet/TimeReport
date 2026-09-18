# Time Report

A Forge app for Jira Cloud with two worklog reports:

- **Daily by person** — hours logged per person, per issue and per day, enriched with each issue's Epic, Initiative and Theme.
- **Themes by month** — one row per theme, with the work logged across its entire subtree totalled per calendar month.

It is the Jira Cloud replacement for the ScriptRunner scripts previously used on Jira Data Center (kept for reference in `../oldImplementation`).

---

## What it does

Both reports live on the same page, one per tab, and both are scoped the same way: by filter ID, by filter name, or by raw JQL.

### Daily by person

Pick a set of issues (by saved filter or JQL) and a reporting window. The app produces one row per **(user, issue)** pair, with one column per day:

| User | Issue Key | Issue Type | Summary | Epic | Epic Summary | Initiative | Initiative Summary | Theme | Theme Summary | 2026-09-11 | … | 2026-09-18 | Total |
| ---- | --------- | ---------- | ------- | ---- | ------------ | ---------- | ------------------ | ----- | ------------- | ---------- | - | ---------- | ----- |
| Ana  | ABC-1     | Task       | Do work | ABC-10 | Renamed epic | ABC-20 | An initiative | ABC-30 | A theme | 1.50 | … | 2.00 | 3.50 |

Cells are hours to two decimals, and are left blank when nothing was logged.

### Themes by month

Here the filter selects the **themes themselves**. For each theme the app walks *down* the hierarchy — initiatives, epics, stories, sub-tasks — and totals the work logged anywhere in that subtree, bucketed by calendar month:

| Theme | Summary | Components | Issues Worked | Apr 2026 | … | Sep 2026 | Total |
| ----- | ------- | ---------- | ------------- | -------- | - | -------- | ----- |
| ABC-30 | Payments | Billing, Platform | 12 | 40.00 | … | 18.50 | 240.75 |

Themes with no logged work are still listed, with zero totals, so the report doubles as a checklist of your themes. Rows are sorted by total hours, busiest first.

### Features

- **Two reports, one page** — daily detail and monthly theme roll-up on separate tabs.
- **Three ways to scope each report** — filter ID, filter name search, or raw JQL.
- **Sortable, paginated table** with links straight to each issue.
- **CSV export** for pasting into a spreadsheet.
- **Rename-proof hierarchy** — Epic/Initiative/Theme are resolved structurally, not by issue type name.
- **Link-aware hierarchy** — follows both `parent` and "Implements" issue links, in either direction.
- **Runs as the viewer** — every Jira call uses `asUser()`, so people only ever see data they already have permission to see.

---

## Using the app

Open Jira and go to **Apps → Time Report** in the top navigation, then choose a tab.

### 1. Choose a report scope

| Mode | What to enter | Notes |
| ---- | ------------- | ----- |
| **Filter ID** | e.g. `10042` | The number at the end of a filter URL: `/issues/?filter=10042`. |
| **Search filter by name** | e.g. `migration` | Press **Search**, then pick from the results. Leave blank to list every filter you can see. |
| **JQL** | e.g. `project = ABC` | Any `ORDER BY` clause is ignored. |

Only filters you own or that are shared with you are visible — this is Jira's permission model, not an app limitation.

On the **Themes by month** tab the query should return the *themes*, not the work items beneath them — for example `project = ABC AND issuetype = Theme`.

### 2. Choose a window

- **Daily by person → Days back** is inclusive of today, so `7` produces **8** columns (today plus the previous seven days). Allowed range is `0`–`180`.
- **Themes by month → Months** is a column count including the current month, so `6` produces **6** columns (this month plus the previous five). Allowed range is `1`–`36`.

### 3. Run it

The effective query is shown beneath the results, for example:

```
(project = ABC) AND worklogDate >= -7d AND worklogDate <= 1d
```

This is the quickest way to understand why a report came back empty.

### Exporting

**Export to CSV** opens a dialog containing the CSV text. Copy it and save it as `time-report.csv` (or `theme-report.csv`). Month columns are exported as `yyyy-MM` so a spreadsheet sorts them correctly.

> Forge apps are sandboxed in an iframe and cannot write files to your computer, so a true "download" is not possible. The old ScriptRunner `.xlsx` export relied on direct DOM access and loading a script from a CDN, neither of which Forge permits.

---

## How the hierarchy is resolved

Both reports share one set of rules, in `src/lib/hierarchy.js`, but travel in opposite directions: the daily report walks **up** from a worked issue to its Theme, and the theme report walks **down** from a Theme to everything beneath it.

### Walking up (daily report)

The Epic, Initiative and Theme columns are filled by walking **upwards** from each worked issue. This is deliberately independent of what your issue types are called.

### Edges that are followed

1. **The `parent` field** — the standard Jira Cloud hierarchy.
2. **"Implements" issue links** — configured in `HIERARCHY_LINK_TYPES` (`src/lib/hierarchy.js`), matched as a case-insensitive substring of the link *type* name.

### How an ancestor is assigned to a column

Classification uses `issuetype.hierarchyLevel`, the structural position of the type — **never its name**:

| `hierarchyLevel` | Column |
| ---------------- | ------ |
| `-1` (sub-task), `0` (Story/Task/Bug) | *none* |
| `1` | Epic |
| `2` | Initiative |
| `3` | Theme |

This is why types renamed to `"Epic (migrated)"` still resolve correctly.

### Safety rules

- **Link direction is ignored.** Both `outwardIssue` and `inwardIssue` are considered; a linked issue is accepted only when its hierarchy level is *strictly higher* than the issue it was reached from. This works whether the link was created as "implements" or "is implemented by".
- **Peer and child links are rejected** — an Epic that implements another Epic (level 1 → 1) is not mistaken for an Initiative.
- **Cycles terminate** via a `visited` set.
- **Sub-tasks are handled** — a sub-task's parent is a Story (level 0), which is skipped so the real Epic above it is found.
- **Fallback:** if Jira reports no `hierarchyLevel`, `parent` edges are classified by distance (1st ancestor → Epic, 2nd → Initiative, 3rd → Theme). Unverifiable *links* are skipped rather than guessed at.

### Walking down (theme report)

The same two edge types are followed in reverse:

1. **Children via `parent in (...)`** — one JQL query returns an entire level of children, so a five-level subtree costs five rounds of requests rather than one per issue.
2. **"Implements" links**, accepted only when the linked issue's hierarchy level is *strictly lower* than the issue it was reached from.

Extra rules that only apply going down:

- **No double counting.** A descendant reachable from two themes is attributed to the first theme that reached it.
- **The theme's own worklogs count** towards its total, since a theme is part of its own subtree.
- **Graceful degradation.** If a Jira site rejects the `parent` JQL field, the failure is logged and the report continues using link edges alone instead of erroring out.

---

## How worklogs are counted

- The filter's JQL is narrowed with `worklogDate >= -Nd AND worklogDate <= 1d` so Jira only returns issues with work logged in the window.
- Worklogs are fetched per issue via `startedAfter`, because the issue search endpoint returns at most 20 worklogs per issue.
- A worklog's date is the leading `yyyy-MM-dd` of its `started` timestamp, which carries the author's own UTC offset. The date therefore matches what the person who logged the work saw — the same behaviour as the Data Center report.
- Rows are keyed `"User|ISSUE-KEY"` and sorted by user, then issue key.

For the theme report:

- A worklog's **month** is the leading `yyyy-MM` of `started`, again the author's own view of the calendar.
- The theme query itself is run exactly as written — **no** worklog condition is added — so themes with no activity still appear with zero totals.
- Descendants are narrowed with `worklogDate >= "yyyy-MM-dd" AND worklogDate <= "yyyy-MM-dd"` before any worklogs are fetched.

---

## Architecture

```
src/
  index.js                    Forge function entry point
  resolvers/index.js          Resolvers: searchFilters, getTimeReport, getThemeReport
  lib/
    jiraApi.js                Jira REST wrappers (all asUser)
    jql.js                    Filter/JQL scope resolution and JQL composition
    hierarchy.js              Shared hierarchy rules, concurrency and chunking
    timeReport.js             Daily report: walks UP to Epic/Initiative/Theme
    themeReport.js            Theme report: walks DOWN to every descendant
  frontend/
    index.jsx                 App shell and tabs
    ScopeSelector.jsx         Filter ID / filter name / JQL picker (shared)
    csv.jsx                   CSV builder and export modal (shared)
    DailyReport.jsx           "Daily by person" tab
    ThemeReport.jsx           "Themes by month" tab
manifest.yml                  Modules, scopes and resources
```

The resolver returns plain data; the frontend renders it. The same data backs both the table and the CSV export, so they cannot drift apart.

### Jira APIs used

| Endpoint | Purpose |
| -------- | ------- |
| `GET /rest/api/3/filter/search` | Find filters by name |
| `GET /rest/api/3/filter/{id}` | Resolve a filter to its JQL |
| `POST /rest/api/3/search/jql` | Find issues, ancestors and descendants (`parent in (...)`) |
| `GET /rest/api/3/issue/{key}/worklog` | Fetch worklogs in the window |

### Scopes

| Scope | Why |
| ----- | --- |
| `read:jira-work` | Read filters, issues and worklogs |
| `read:jira-user` | Show worklog author display names |

### Limits

Forge resolvers are terminated after roughly 25 seconds, so the app caps a single run at:

**Daily by person** (`src/lib/timeReport.js`):

| Constant | Value | Meaning |
| -------- | ----- | ------- |
| `MAX_ISSUES` | 500 | Issues processed per run (a warning banner appears if exceeded) |
| `MAX_HIERARCHY_DEPTH` | 5 | Levels walked upwards |
| `WORKLOG_CONCURRENCY` | 10 | Parallel worklog requests |

**Themes by month** (`src/lib/themeReport.js`):

| Constant | Value | Meaning |
| -------- | ----- | ------- |
| `MAX_THEMES` | 100 | Themes (rows) per run |
| `MAX_DESCENDANTS` | 2000 | Issues discovered beneath those themes |
| `MAX_WORKLOG_ISSUES` | 600 | Descendants whose worklogs are actually fetched |
| `MAX_HIERARCHY_DEPTH` | 5 | Levels walked downwards |
| `WORKLOG_CONCURRENCY` | 10 | Parallel requests |

The theme report keeps its request count low by asking Jira, in batches of 100 keys, which descendants have worklogs in the window before fetching any. A subtree of 2,000 issues where only 30 were worked on costs 20 searches plus 30 worklog reads.

If you hit a cap, narrow the filter or shorten the window.

---

## Development

Requires the [Forge CLI](https://developer.atlassian.com/platform/forge/set-up-forge/).

```bash
npm install
```

### Validate

```bash
forge lint          # manifest and app checks
npx eslint src --ext .js,.jsx
```

### Deploy

```bash
forge deploy --non-interactive -e development
forge deploy --non-interactive -e production
```

> `forge lint` does not catch every invalid manifest property. Check the page renders after changing `manifest.yml`.

### Environments

Apps in the **development** environment are only accessible to the app owner. Anyone who opens one gets *"You don't have access to this app."* Colleagues must use the **production** install.

| Environment | Who can use it |
| ----------- | -------------- |
| `development` | The app owner only |
| `production` | Everyone on the site |

Production does **not** update automatically — deploy to it explicitly.

### Installing

```bash
forge install --non-interactive --site <site>.atlassian.net --product jira --environment production
```

Add `--upgrade` when scopes or permissions have changed. Changing only code needs a deploy, not a reinstall.

### Live development

```bash
forge tunnel
```

Code changes hot-reload. Changing `manifest.yml` requires a redeploy and a tunnel restart.

### Logs

```bash
forge logs -e development --since 15m
```

---

## Customising

| Change | Where |
| ------ | ----- |
| Hierarchy link types (both reports) | `HIERARCHY_LINK_TYPES` in `src/lib/hierarchy.js` |
| Level → column mapping | `LEVEL_TO_COLUMN` in `src/lib/timeReport.js` |
| Daily report caps | `MAX_ISSUES`, `WORKLOG_CONCURRENCY` in `src/lib/timeReport.js` |
| Theme report caps | `MAX_THEMES`, `MAX_DESCENDANTS`, `MAX_WORKLOG_ISSUES` in `src/lib/themeReport.js` |
| Table and CSV columns | `BASE_COLUMNS` in `src/frontend/DailyReport.jsx` / `ThemeReport.jsx` |
| Scope picker (shared by both tabs) | `src/frontend/ScopeSelector.jsx` |

Adding a fourth hierarchy level means adding an entry to `LEVEL_TO_COLUMN`, a row field in `buildTimeReport`, and a column in the relevant `BASE_COLUMNS`.

---

## Troubleshooting

| Symptom | Cause |
| ------- | ----- |
| *"You don't have access to this app."* | Opening the **development** install as a non-owner. Use the production link. |
| Filter search returns nothing | You may not own or have shared access to any filter. Use Filter ID or JQL instead. |
| Report is empty | Check the query shown under the results; no work was logged in that window. |
| Epic/Initiative/Theme blank | The ancestor may be linked by a type not listed in `HIERARCHY_LINK_TYPES`, or its issue type has no hierarchy level above 0. |
| *"Results were truncated"* | The filter matched more than `MAX_ISSUES` issues (or more than `MAX_DESCENDANTS` on the theme tab). Narrow it. |
| A theme shows 0 hours but work exists | Its descendants may be joined by a link type not in `HIERARCHY_LINK_TYPES`, or sit more than `MAX_HIERARCHY_DEPTH` levels below it. |
| Theme report lists work items, not themes | The query is selecting the children. Scope it to the themes, e.g. `issuetype = Theme`. |

## UI Kit constraints

The frontend may only use components exported by `@forge/react`. Standard HTML elements (`<div>`, `<span>`) and third-party React components will break rendering. There is no `Table` component — use `DynamicTable`. Styling uses `xcss` with Atlassian design tokens, which is what makes the app follow Jira's theming, including dark mode.

## Support

See [Get help](https://developer.atlassian.com/platform/forge/get-help/) for Forge platform support.
