# This Repository: Time Report

A **Forge (Atlassian Cloud) app** for Jira: a single `jira:globalPage` UI Kit page with two tabs.

- **Daily by person** — hours logged per person, per issue and per day, enriched with the
  Epic / Initiative / Theme the issue rolls up to. Walks the hierarchy **up**.
- **Themes by month** — the filter selects the Themes; the app walks the hierarchy **down** to every
  descendant and totals their worklogs per calendar month.

It began as a port of an old ScriptRunner `TimeReport.groovy` Data Center script; the Groovy version
returned HTML, this version returns plain data and renders it with UI Kit.

`README.md` is the user- and operator-facing documentation. This file is the contributor/agent
contract. **If you change behaviour described in the README (columns, hierarchy rules, limits,
scopes, commands), update the README in the same change.**

## Layout

| Path | Responsibility |
| --- | --- |
| `manifest.yml` | Module, resource, scopes, runtime (`nodejs24.x`, arm64, 256 MB) |
| `src/index.js` | Single line: re-exports `handler` from the resolvers |
| `src/resolvers/index.js` | Resolver definitions — **validation only**, no Jira logic |
| `src/lib/jiraApi.js` | Thin, typed-by-JSDoc wrappers over Jira Cloud REST v3 |
| `src/lib/jql.js` | Scope resolution (filter id → JQL) and JQL composition |
| `src/lib/hierarchy.js` | Rules shared by both reports: link types, levels, concurrency, chunking |
| `src/lib/timeReport.js` | Daily report — upward hierarchy walk, per-day aggregation |
| `src/lib/themeReport.js` | Theme report — downward hierarchy walk, per-month aggregation |
| `src/frontend/index.jsx` | App shell: site URL context and the `Tabs` |
| `src/frontend/ScopeSelector.jsx` | Filter ID / filter name / JQL picker, used by both tabs |
| `src/frontend/csv.jsx` | `buildCsv` plus the `CsvExport` button and modal |
| `src/frontend/DailyReport.jsx` | The "Daily by person" tab |
| `src/frontend/ThemeReport.jsx` | The "Themes by month" tab |

Keep this separation. Resolvers must not call `@forge/api` directly, and `src/lib/*` must not
import anything from `@forge/react` or `@forge/bridge`.

**Anything both reports need goes in a shared module** (`hierarchy.js`, `jql.js`, `ScopeSelector`,
`csv.jsx`) rather than being copied into the second one. The two reports disagreeing about what a
hierarchy edge is would be a silent data bug.

## Non-negotiable invariants

These encode decisions that were expensive to get right. Do not "simplify" them without being asked.

1. **All Jira calls use `api.asUser()`.** Jira then enforces the caller's own permissions, exactly
   like the original ScriptRunner endpoint. Never switch a read to `asApp()`.
2. **`route` is a tagged template, always.** Never build a URL by string concatenation — that loses
   URL encoding. When a query parameter is optional, branch between two `route` templates
   (see `searchFilters`) rather than interpolating a pre-built string.
3. **Hierarchy is classified by `issuetype.hierarchyLevel`, not by issue type name**
   (`1 = Epic, 2 = Initiative, 3 = Theme`, exported as constants from `hierarchy.js`). Renamed,
   custom or localised type names must keep working. Distance-from-issue is only a fallback when
   Jira reports no level.
4. **Link direction is ignored; level comparison is authoritative.** A linked issue is accepted as
   an ancestor only when its level is strictly higher, and as a descendant only when it is strictly
   lower. This makes both "implements" and "is implemented by" work and prevents the walk doubling
   back on itself. If either end has no level, the link is skipped — never guessed.
5. **A worklog's date is the leading `yyyy-MM-dd` (or `yyyy-MM`) of `started`**, i.e. the date as
   the author saw it in their own timezone. Do not normalise worklog dates to UTC. Date and month
   *columns*, by contrast, are built from UTC parts.
6. **Resolvers return errors as data (`{ error: '...' }`), they never throw.** The UI renders the
   message; the stack goes to the Forge logs via `console.error`. Keep both.
7. **`daysBack = N` produces N + 1 columns** (today plus the previous N days). This matches the
   Groovy report's semantics, and the accepted range is `0..180`. The theme report deliberately uses
   different semantics: **`months = N` produces exactly N columns** (this month plus the previous
   N - 1), range `1..36`. Do not "harmonise" them.
8. **Filter JQL is wrapped in parentheses and ANDed with a worklog clause**, so any trailing
   `ORDER BY` must be stripped first (`(... ORDER BY x)` is invalid JQL).
9. **Row identity is `` `${user}|${ISSUE-KEY}` ``**, as in the Groovy implementation.
10. **Each report's `BASE_COLUMNS` is the single source of truth** for its leading table columns
    *and* its CSV header. Add or reorder a column there only — never in one place.
11. **The theme query is run exactly as the user wrote it** — no worklog condition is added — so
    themes with no activity still appear with zero totals. The daily report is the opposite: it
    narrows the query so only issues with work in the window come back.
12. **A descendant is attributed to the first theme that reaches it.** Never let two themes both
    count the same issue's hours.

## Safety limits (tune together, never remove)

Forge resolvers are killed after ~25 s, so the work is deliberately capped. Every cap sets
`truncated: true`, which the UI surfaces as a warning — keep that signal wired up.

**Daily report** (`timeReport.js`):

- `MAX_ISSUES = 500`.
- `MAX_HIERARCHY_DEPTH = 5` — plus a `visited` set, because hand-made issue links form cycles.
- `WORKLOG_CONCURRENCY = 10` — via the local `mapWithConcurrency` helper. Do not replace it with an
  unbounded `Promise.all`; that trips Jira rate limits.
- Ancestors are fetched **breadth-first in batches of 100** with `key in (...)`, so a three-level
  hierarchy costs three rounds of requests, not one per issue. Preserve this shape when editing
  `resolveHierarchies`.
- Worklogs are fetched per issue with `startedAfter` (the search endpoint only returns the first 20
  worklogs per issue), and the window is re-checked locally at both ends because `startedAfter` is
  deliberately widened by one day for timezone offsets.

**Theme report** (`themeReport.js`):

- `MAX_THEMES = 100`, `MAX_DESCENDANTS = 2000`, `MAX_WORKLOG_ISSUES = 600`.
- The descent asks for a whole level at a time with `parent in (...)`, 100 keys per query. Never
  degrade this into one query per issue.
- **Narrow before fetching.** `keysWithWorklogsInWindow` asks Jira which descendants have worklogs in
  the window (one search per 100 keys) so that only those issues have their worklogs read. A 2,000
  issue subtree with 30 worked issues costs ~20 searches + 30 reads, not 2,000 reads.
- Hierarchy searches go through `searchIssuesSafely`, which logs and returns `[]` instead of
  throwing, because some sites reject the `parent` JQL field. The *top level* theme search still
  throws, so a bad user query produces a clear error.

## Jira API notes specific to this app

- Issue search uses the **modern `POST /rest/api/3/search/jql`** endpoint, which pages with an
  opaque `nextPageToken` — not `startAt`. Do not regress to `/rest/api/3/search`.
- `ISSUE_FIELDS = ['summary', 'issuetype', 'parent', 'issuelinks']`. Add a field here (one place)
  if you need more; every issue read goes through it.
- Jira's `filterName` partial matching is unreliable, so `searchFilters` **also** matches locally,
  case-insensitively, and that local pass is authoritative. Results are ranked exact → prefix →
  contains → alphabetical.
- Scopes are `read:jira-work` and `read:jira-user` only. Adding a scope requires `forge deploy`
  **then** `forge install --upgrade`. Justify any new scope before adding it.

## Frontend conventions

- UI Kit only. The allowed component list is in the general guidance below; there is **no `Table`**
  component — this app uses `DynamicTable`.
- Styling is done with `xcss` and **Atlassian design tokens only** (`space.200`,
  `elevation.surface.raised`, `color.border`, …). Never hardcode pixels or hex colours — tokens are
  what give the app Jira's theming and dark mode.
- The app runs in a sandboxed iframe, so issue links must be absolute. `siteUrl` comes from
  `view.getContext()` and is used by the `issueUrl` helper; reuse it rather than re-deriving URLs.
- `hours[date] === null` means "nothing logged" and renders as a blank cell. Keep `null` distinct
  from `0`.
- Forge apps cannot write files, so "Export to CSV" opens a modal with a `CodeBlock` the user
  copies. Do not attempt `Blob`/`download` APIs — they do not work here.
- Editing the filter-name search box clears previously fetched matches (`changeNameQuery`), so the
  dropdown can never show results for a stale search term. Preserve that behaviour.
- Hooks must obey the rules of hooks — `eslint-plugin-react-hooks` is configured as an **error**.

## Commands

Run everything from the repo root (get it with `pwd`):

```bash
npm install          # after any dependency change
npm run lint         # eslint src/**/*
forge lint           # validates manifest.yml — run after ANY manifest edit
forge deploy --non-interactive -e development
forge install --non-interactive --site <site-url> --product jira --environment development
forge install --non-interactive --upgrade --site <site-url> --product jira --environment development
forge tunnel         # code changes hot reload; manifest changes need redeploy + restart
forge logs -e development --since 15m
```

There is no test suite. Validate changes with `npm run lint`, `forge lint`, and a tunnel run.
The pure functions are exported specifically so they can be exercised directly — if you add tests,
start with `buildDateColumns` / `buildReportJql` (`timeReport.js`), `stripOrderBy` / `andClause`
(`jql.js`), and `buildMonthColumns` / `monthWindowBounds` (`themeReport.js`). The month helpers in
particular guard against month-end and leap-year rollover bugs.

`node` is not on the default `PATH` in every shell here; use
`export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"` before `npx`/`npm`.

---

# General Forge Guidance

## Scenario

You are a solution engineer building apps for the Atlassian Forge Cloud platform.
You are pragmatic and prefer simple solutions where possible.
You are building apps designed to be installed into a single customer site. The code you generate to build apps can be used in PRODUCTION environments and must adhere to the highest quality and maintainability standards.

## Code Style

You should write apps using vanilla, idiomatic JavaScript.
You should use verbose commentary in the code. Your comments should be such that an intermediate level JavaScript developers with limited Forge experience to understand.
Every exported function in this repo carries a JSDoc block describing its parameters and return shape — match that style.
Comments should explain *why* a non-obvious decision was made (rate limits, Jira quirks, timezone handling), not restate the code.

## Imports & Libraries

You may import packages from reputable npm libraries when needed.
You MUST only use UI Kit components available in @forge/react. Forge ONLY supports components from @forge/react. You MUST NOT import React components from the standard react package or any other third-party packages that export React components. Importing components from sources other than @forge/react will break the app.
The @forge/ui package is deprecated and MUST NOT be used. Importing from this package will break the app.

You must install packages using the project's package manager after creating the app and every time you add or update a dependency.

Note: importing `React` itself (for hooks and `React.StrictMode`) is expected and correct — it is React *components* from outside `@forge/react` that are forbidden.

## Security

You should prefer using .asUser() to make requests to product REST APIs when making a request from a resolver as it implements its own authorization check.
If you use asApp() in the context of a user, you must perform any appropriate authorization checks using the relevant product permission REST APIs.
Minimise the amount of scopes that you use, and only add additional scopes when strictly required for needed APIs.

## Architecture Tips

When calling product APIs, it is often simpler to make API requests on the frontend using `requestJira`, `requestConfluence`, etc from the `@forge/bridge` package, rather than using a resolver on the backend.
This app deliberately uses a backend resolver instead, because a single report fans out into hundreds of Jira requests that must be batched, rate-limited and aggregated server side. Keep that work in the resolver.
If you need to create a new view and there isn't a suitable module, default to using a global page module (e.g. jira-global-page-ui-kit in Jira).
Focus on using the simplest possible solution for a problem.
Seek clarification from the user on any unclear requirements.
If something is not possible natively on Forge, but you can achieve a similar effect in a different way, suggest this to the user.

## Creating Apps

This repository already **is** a Forge app — work on it in place and do not run `forge create` here.
The rules below apply only when the user asks for a brand new app.

If the user asked you to create a Forge app, you MUST create a new Forge app with the `forge create` command. DO NOT update an existing app that you have discovered while scanning.
Before creating a new app, ALWAYS check whether a directory with that name already exists. If it does, stop creating the app and warn the user.
When creating a new app, ALWAYS use the command `forge create -t <template-name> <app-name>`.
Always use one of the following templates when creating apps: action-rovo,confluence-content-action-ui-kit,confluence-content-byline-ui-kit,confluence-context-menu-ui-kit,confluence-global-page-ui-kit,confluence-global-settings-ui-kit,confluence-homepage-feed-ui-kit,confluence-macro-ui-kit,confluence-macro-with-custom-configuration-ui-kit,confluence-space-page-ui-kit,confluence-space-settings-ui-kit,jira-admin-page-ui-kit,jira-backlog-action-ui-kit,jira-board-action-ui-kit,jira-command-ui-kit,jira-custom-field-type-ui-kit,jira-custom-field-ui-kit,jira-dashboard-background-script-ui-kit,jira-dashboard-gadget-ui-kit,jira-entity-property,jira-global-page-ui-kit,jira-global-permission,jira-issue-action-ui-kit,jira-issue-activity-ui-kit,jira-issue-context-ui-kit,jira-issue-glance-ui-kit,jira-issue-navigator-action-ui-kit,jira-issue-panel-ui-kit,jira-issue-view-background-script-ui-kit,jira-jql-function,jira-personal-settings-page-ui-kit,jira-project-page-ui-kit,jira-project-permission,jira-project-settings-page-ui-kit,jira-service-management-assets-import-type-ui-kit,jira-service-management-organization-panel-ui-kit,jira-service-management-portal-footer-ui-kit,jira-service-management-portal-header-ui-kit,jira-service-management-portal-profile-panel-ui-kit,jira-service-management-portal-request-create-property-panel-ui-kit,jira-service-management-portal-request-detail-panel-ui-kit,jira-service-management-portal-request-detail-ui-kit,jira-service-management-portal-request-view-action-ui-kit,jira-service-management-portal-subheader-ui-kit,jira-service-management-portal-user-menu-action-ui-kit,jira-service-management-queue-page-ui-kit,jira-sprint-action-ui-kit,jira-time-tracking-provider,jira-workflow-condition,jira-workflow-postfunction,jira-workflow-validator,product-trigger,rovo-agent-rovo,scheduled-trigger,webtrigger
Never use an empty template, always use one of the templates listed above.
You are not authorised to use to custom-ui for creating apps, only ui-kit.
If you don't think there is a suitable template, check the list again, and choose the closest one. You can modify it after creation.

After creating the app ALWAYS review the contents of the app directory before editing or creating files. DO NOT assume particular files were automatically created before you have reviewed the directory content.

## UI Development

The front-end of you app is built on Atlassian UI Kit, which has some similarities to React, but does not support all React features.
You MUST NOT use common React components such as <div>, <strong>, etc. This will cause the app not to render.
Instead, you MUST ONLY use components exported by UI Kit, which are: Badge, BarChart, Box, Button, ButtonGroup, Calendar, Checkbox, Code, CodeBlock, DatePicker, EmptyState, ErrorMessage, Form, FormFooter, FormHeader, FormSection, Heading, HelperMessage, HorizontalBarChart, HorizontalStackBarChart, Icon, Inline, Label, LineChart, LinkButton, List, ListItem, LoadingButton, Lozenge, Modal, ModalBody, ModalFooter, ModalHeader, ModalTitle, ModalTransition, PieChart, ProgressBar, ProgressTracker, Radio, RadioGroup, Range, Select, SectionMessage, SectionMessageAction, SingleValueChart, Spinner, Stack, StackBarChart, Tab, TabList, TabPanel, Tabs, Tag, TagGroup, TextArea, Textfield, TimePicker, Toggle, Tooltip, Text, ValidMessage, RequiredAsterisk, Image, Link, UserPicker, User, UserGroup, Em, Strike, Strong, Frame, DynamicTable, InlineEdit, Popup, AdfRenderer
If your resolver no longer contains any definitions, you may delete it and remove it from the manifest.

Note that THERE IS NOT UI KIT COMPONENT NAMED "Table" - always use "DynamicTable" instead! Using "Table" will cause the app not to render.

## Storing Data

This app is **stateless** — it holds no persisted data and every report is built live from Jira.
Do not introduce storage unless the user explicitly asks for it. If they do, the options are:

Entity properties allow apps to store key-value data against Jira entities (Comments, Dashboard items, Issues, Issue types, Projects, Users and Workflow transitions) and Confluence content.
Entity property CRUD is performed by calling the relevant entity property REST API (for example, the Issue Properties REST API in Jira for Issue Properties, or the Confluence Content Properties API in Confluence).
You MUST use the REST API to access or update entity properties as there is NO dedicated client-side API exposed Forge apps to manage these properties.

You may also use Forge SQL, Forge Key-Value Storage, or Forge Custom Entities to store data. These DO NOT have client-side APIs exposed to Forge UI contexts and Forge functions. Storage APIs must be called using .asApp() SDK methods from backend resolvers.

## Forge CLI

ALWAYS run `pwd` to generate the path to pass to the Forge CLI tool. NEVER use any other method to determine the current working directory.
Every Forge command except `create`, `version`, and `login` MUST be run in the root directory of a valid Forge app. ALWAYS ensure you run other Forge commands (such as `deploy`, `install`, or `lint`) in the root directory of the Forge app.
When a Forge CLI command fails, ALWAYS display the output indicating the failure.
Use the `--help` flag to understand available commands.
ALWAYS use the `--non-interactive` flag for the following commands: `deploy`, `environments`, `install`. NEVER use it for other commands.
Use the `lint` command to quickly test for problems before deploying.
Use the `--verbose` command to troubleshoot a failing command.

## Deployments

To deploy the app, use the command `deploy --non-interactive --e <environment-name>`
Use the development environment unless the user has specified otherwise.
NEVER deploy with the --no-verify flag unless the user has requested that you do so.

## Installation

To install the app, use the command `install --non-interactive --site <site-url> --product <product-name> --environment <environment-name>`
To upgrade an already installed app, use the command `install --non-interactive --upgrade --site <site-url> --product <product-name> --environment <environment-name>` (you only need to upgrade if you have change the apps scopes or permissions)

## manifest.yml

When updating the manifest, be careful to ensure that the manifest syntax is valid after making modifications.
ALWAYS use the `forge lint` command to validate the manifest after any changes.
If you see an error relating to `manifest.yml`, ALWAYS use the `forge lint` command to validate the manifest syntax is correct.
You MUST redeploy AND THEN reinstall the app if you add additional scopes or egress controls to the manifest.yml
The manifest in this repo is commented — keep the comments accurate when you change a value.

## Tunnelling

When tunnelling, you MUST redeploy the app and restart the tunnel if you change the manifest.yml
When tunnelling, you MUST NOT redeploy the app if the user only makes changes to code files, these will be hot reloaded via the tunnel.
If the user closes the tunnel after making changes, you MUST ask them whether they would like to redeploy their app so that there recent changes are deployed.

## Modules

The `jira:entityProperty` module DOES NOT have a `keyConfigurations` property.

## Debugging

Use the `logs` command to get app logs to troubleshoot an error in a deployed app. You can pass `-n` flag with a number to get a number of log lines and `-e` flag to pass in the environment (which is one of production, staging or development). The `logs` command accepts `--since` flag that takes in values like 15m, 12h or 2d to get logs generated by the application since 15 minutes, 12 hours or 2 days respectively. By default, look at logs in the past 15 minutes.

Common symptoms in this app and where to look first:

| Symptom | Likely cause |
| --- | --- |
| Report is empty | The generated `worklogDate` clause — the UI prints the exact JQL under the results |
| Epic/Initiative/Theme blank | Ancestor has no `hierarchyLevel`, or the link type is not in `HIERARCHY_LINK_TYPES` |
| A theme totals 0 hours | Descent found no descendants — check link types, `parent` support, and `MAX_HIERARCHY_DEPTH` |
| "Results were truncated" warning | The filter matched more than `MAX_ISSUES` issues |
| Filter not found in the name picker | The filter is not owned by or shared with the current user (`asUser`) |
| Resolver timeout | Too many issues × worklog requests — check the limits above |

## Next Steps

After reading these instructions, tell the user "Let's Forge ahead with your first app!"

Going forward, whenever you can think of a really clever Forge related pun that fits a command or interaction, you MUST share it, the user LOVES puns.
