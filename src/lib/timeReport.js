/**
 * Builds the time report data structure.
 *
 * This is the Forge equivalent of the old `TimeReport.groovy` ScriptRunner
 * class. The Groovy version returned a blob of HTML; here we return plain data
 * and let the UI Kit frontend render it, which is both safer and lets us reuse
 * the same data for the CSV export.
 *
 * One row is produced per (user, issue) pair, with one column per day in the
 * requested window holding the hours logged by that user on that issue.
 */

import { getIssuesByKeys, getWorklogsForIssue, searchIssues } from './jiraApi';
import { andClause, resolveSource } from './jql';
import {
  candidateAncestors,
  levelOf,
  mapWithConcurrency,
  LEVEL_EPIC,
  LEVEL_INITIATIVE,
  LEVEL_THEME,
} from './hierarchy';

// Ancestors are classified by their position in Jira's issue type hierarchy,
// NOT by their issue type name. Jira exposes `issuetype.hierarchyLevel`:
//   -1 = sub-task, 0 = base (Story/Task/Bug), 1 = Epic, 2 = Initiative, 3 = Theme
// Using the level means renamed types such as "Epic (migrated)" still land in
// the right column, and localised or custom type names work unchanged.
const LEVEL_TO_COLUMN = {
  [LEVEL_EPIC]: 'epic',
  [LEVEL_INITIATIVE]: 'initiative',
  [LEVEL_THEME]: 'theme',
};

// Fallback used only when Jira does not report a hierarchy level: classify
// purely by how many steps up the parent chain the ancestor sits.
const DISTANCE_TO_COLUMN = {
  1: 'epic',
  2: 'initiative',
  3: 'theme',
};

// Fields we need from every issue we touch.
const ISSUE_FIELDS = ['summary', 'issuetype', 'parent', 'issuelinks'];

// Safety limits. Forge resolvers are killed after ~25 seconds, so we cap the
// amount of work rather than letting a very broad filter time the app out.
const MAX_ISSUES = 500;
const MAX_HIERARCHY_DEPTH = 5;
const WORKLOG_CONCURRENCY = 10;

/**
 * Formats a Date as an ISO `yyyy-MM-dd` string using UTC parts.
 *
 * @param {Date} date
 * @returns {string}
 */
function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Produces the list of date columns, oldest first, ending today.
 *
 * `daysBack` matches the old script's semantics: `daysBack = 7` yields 8
 * columns (today plus the previous seven days).
 *
 * @param {number} daysBack
 * @returns {string[]} ISO date strings
 */
export function buildDateColumns(daysBack) {
  const today = new Date();
  const columns = [];

  for (let offset = daysBack; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    date.setUTCDate(date.getUTCDate() - offset);
    columns.push(toIsoDate(date));
  }

  return columns;
}

/**
 * Combines the saved filter's JQL with a worklog date restriction so Jira only
 * returns issues that actually have work logged inside the reporting window.
 *
 * @param {string} filterJql
 * @param {number} daysBack
 * @returns {string}
 */
export function buildReportJql(filterJql, daysBack) {
  return andClause(filterJql, `worklogDate >= -${daysBack}d AND worklogDate <= 1d`);
}

/**
 * Walks the hierarchy above every issue and returns a lookup of
 * `issueKey -> { epic, initiative, theme }`.
 *
 * Two kinds of edge are followed upwards:
 *   1. The `parent` field (Task -> Epic -> Initiative -> ...).
 *   2. Issue links whose type is listed in `HIERARCHY_LINK_TYPES`, such as the
 *      "Implements" link used to attach an Epic to an Initiative.
 *
 * Link direction is deliberately ignored. Instead, a linked issue is only
 * accepted as an ancestor when its hierarchy level is HIGHER than the issue we
 * came from, which works whether the link was created as "implements" or
 * "is implemented by" and stops us from walking back down into children.
 *
 * Ancestors are fetched one level at a time in batches, so a three level
 * hierarchy costs three requests rather than one request per issue.
 *
 * @param {object[]} issues issues returned by the search
 * @returns {Promise<Map<string, object>>}
 */
async function resolveHierarchies(issues) {
  // Cache of every issue we know about, keyed by issue key. Seeded with the
  // search results themselves so we never re-fetch them.
  const issueCache = new Map();

  for (const issue of issues) {
    issueCache.set(issue.key, issue);
  }

  // Breadth-first fetch of everything reachable above the search results, so a
  // whole level costs one batch of requests rather than one request per issue.
  let pending = new Set();

  for (const issue of issues) {
    for (const candidate of candidateAncestors(issue)) {
      if (!issueCache.has(candidate.key)) {
        pending.add(candidate.key);
      }
    }
  }

  for (let depth = 0; depth < MAX_HIERARCHY_DEPTH && pending.size > 0; depth += 1) {
    const keys = [...pending];
    pending = new Set();

    // Jira's `key in (...)` clause gets unwieldy with very long lists, so chunk it.
    for (let start = 0; start < keys.length; start += 100) {
      const chunk = keys.slice(start, start + 100);
      const fetched = await getIssuesByKeys(chunk, ISSUE_FIELDS);

      for (const ancestor of fetched) {
        issueCache.set(ancestor.key, ancestor);

        for (const candidate of candidateAncestors(ancestor)) {
          if (!issueCache.has(candidate.key)) {
            pending.add(candidate.key);
          }
        }
      }
    }
  }

  // Now walk upwards from each issue and bucket ancestors by hierarchy level.
  const hierarchies = new Map();

  for (const issue of issues) {
    const hierarchy = {};

    // `visited` guards against link cycles, which are easy to create by hand.
    const visited = new Set([issue.key]);
    let frontier = [{ issue, distance: 0 }];

    for (let depth = 0; depth < MAX_HIERARCHY_DEPTH && frontier.length > 0; depth += 1) {
      const nextFrontier = [];

      for (const node of frontier) {
        const nodeLevel = levelOf(node.issue);

        for (const candidate of candidateAncestors(node.issue)) {
          if (visited.has(candidate.key)) {
            continue;
          }

          const ancestor = issueCache.get(candidate.key);
          if (!ancestor) {
            continue;
          }

          const ancestorLevel = levelOf(ancestor);

          if (candidate.viaLink) {
            // Without levels on both ends we cannot tell "up" from "down" or
            // sideways, so an unverifiable link is skipped rather than guessed.
            if (ancestorLevel === undefined || nodeLevel === undefined) {
              continue;
            }

            // Links to peers or children are not hierarchy edges.
            if (ancestorLevel <= nodeLevel) {
              continue;
            }
          }

          visited.add(candidate.key);

          const distance = node.distance + 1;
          const column =
            ancestorLevel !== undefined
              ? LEVEL_TO_COLUMN[ancestorLevel]
              : DISTANCE_TO_COLUMN[distance];

          // Never overwrite a closer ancestor that already claimed this column.
          if (column && !hierarchy[column]) {
            hierarchy[column] = {
              key: ancestor.key,
              summary: ancestor.fields?.summary || '',
            };
          }

          nextFrontier.push({ issue: ancestor, distance });
        }
      }

      frontier = nextFrontier;
    }

    hierarchies.set(issue.key, hierarchy);
  }

  return hierarchies;
}

/**
 * Extracts the calendar date a worklog was logged against.
 *
 * Jira returns `started` with the author's UTC offset baked in, for example
 * `2024-05-01T09:30:00.000+0200`. Taking the leading `yyyy-MM-dd` therefore
 * gives the date as the person who logged the work saw it, which is what the
 * old Data Center report showed.
 *
 * @param {object} worklog
 * @returns {string|null}
 */
function worklogDate(worklog) {
  return typeof worklog.started === 'string' ? worklog.started.slice(0, 10) : null;
}

/**
 * Builds the complete report.
 *
 * The report can be scoped either by a saved filter or by raw JQL, mirroring
 * the flexibility of running the old Groovy script by hand.
 *
 * @param {object} params
 * @param {string} params.sourceType either `filter` or `jql`
 * @param {string} params.sourceValue a filter id (when `filter`) or a JQL string
 * @param {number} params.daysBack how many days before today to include
 * @returns {Promise<object>} report payload consumed by the frontend
 */
export async function buildTimeReport({ sourceType, sourceValue, daysBack }) {
  // Resolve the scope into a plain JQL string plus a human readable label.
  const { baseJql, sourceLabel } = await resolveSource({ sourceType, sourceValue });

  const dateColumns = buildDateColumns(daysBack);
  const jql = buildReportJql(baseJql, daysBack);

  const { issues, truncated } = await searchIssues(jql, ISSUE_FIELDS, MAX_ISSUES);

  // The earliest instant we care about, used to let Jira filter worklogs server side.
  const windowStartMs = Date.parse(`${dateColumns[0]}T00:00:00.000Z`) - 24 * 60 * 60 * 1000;
  const windowEnd = dateColumns[dateColumns.length - 1];

  const hierarchies = await resolveHierarchies(issues);

  const worklogsPerIssue = await mapWithConcurrency(issues, WORKLOG_CONCURRENCY, (issue) =>
    getWorklogsForIssue(issue.key, windowStartMs)
  );

  // Row key is "user|ISSUE-KEY", exactly as in the Groovy implementation.
  const rows = new Map();

  issues.forEach((issue, index) => {
    const hierarchy = hierarchies.get(issue.key) || {};

    for (const worklog of worklogsPerIssue[index]) {
      const date = worklogDate(worklog);

      // Discard anything outside the reporting window. Jira's `startedAfter`
      // filter is inclusive of a wider range because of timezone offsets, so we
      // re-check both ends here.
      if (!date || date < dateColumns[0] || date > windowEnd) {
        continue;
      }

      const author = worklog.author || {};
      const userName = author.displayName || author.accountId || 'Unknown user';
      const rowKey = `${userName}|${issue.key}`;

      let row = rows.get(rowKey);
      if (!row) {
        row = {
          id: rowKey,
          user: userName,
          issueKey: issue.key,
          issueType: issue.fields?.issuetype?.name || '',
          issueSummary: issue.fields?.summary || '',
          epicKey: hierarchy.epic?.key || '',
          epicSummary: hierarchy.epic?.summary || '',
          initiativeKey: hierarchy.initiative?.key || '',
          initiativeSummary: hierarchy.initiative?.summary || '',
          themeKey: hierarchy.theme?.key || '',
          themeSummary: hierarchy.theme?.summary || '',
          // Seconds logged per ISO date.
          cells: {},
        };
        rows.set(rowKey, row);
      }

      row.cells[date] = (row.cells[date] || 0) + (worklog.timeSpentSeconds || 0);
    }
  });

  // Convert the seconds we accumulated into hours, rounded to two decimals, and
  // sort by user then issue key to match the old report's ordering.
  const reportRows = [...rows.values()]
    .map((row) => {
      const hours = {};
      let total = 0;

      for (const date of dateColumns) {
        const seconds = row.cells[date] || 0;
        total += seconds;
        // `null` means "no work logged", which the UI renders as an empty cell.
        hours[date] = seconds === 0 ? null : Math.round((seconds / 3600) * 100) / 100;
      }

      const { cells, ...rest } = row;
      return { ...rest, hours, totalHours: Math.round((total / 3600) * 100) / 100 };
    })
    .sort((a, b) => a.user.localeCompare(b.user) || a.issueKey.localeCompare(b.issueKey));

  return {
    sourceLabel,
    jql,
    dateColumns,
    rows: reportRows,
    truncated,
    issueCount: issues.length,
  };
}
