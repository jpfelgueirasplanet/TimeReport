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

import { getFilter, getIssuesByKeys, getWorklogsForIssue, searchIssues } from './jiraApi';

// Issue type names we treat as "levels" above the working issue. These match the
// hierarchy that the old `IssueHierarchy` helper resolved on Jira Data Center.
const HIERARCHY_LEVELS = ['epic', 'initiative', 'theme'];

// Fields we need from every issue we touch.
const ISSUE_FIELDS = ['summary', 'issuetype', 'parent'];

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
 * Strips a trailing `ORDER BY` clause from a JQL string.
 *
 * We need to wrap the filter's JQL in parentheses so we can AND an extra
 * `worklogDate` condition onto it, and `(... ORDER BY x)` is not valid JQL.
 *
 * @param {string} jql
 * @returns {string}
 */
export function stripOrderBy(jql) {
  return jql.replace(/\s+order\s+by\s+[\s\S]*$/i, '').trim();
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
  const base = stripOrderBy(filterJql);
  const worklogClause = `worklogDate >= -${daysBack}d AND worklogDate <= 1d`;

  return base ? `(${base}) AND ${worklogClause}` : worklogClause;
}

/**
 * Walks the parent chain of every issue and returns a lookup of
 * `issueKey -> { epic, initiative, theme }`.
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

  // Keys whose details we still need in order to continue walking upwards.
  let pending = new Set();

  for (const issue of issues) {
    const parentKey = issue.fields?.parent?.key;
    if (parentKey && !issueCache.has(parentKey)) {
      pending.add(parentKey);
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

        const grandParentKey = ancestor.fields?.parent?.key;
        if (grandParentKey && !issueCache.has(grandParentKey)) {
          pending.add(grandParentKey);
        }
      }
    }
  }

  // Now walk each issue's chain and bucket ancestors by their issue type name.
  const hierarchies = new Map();

  for (const issue of issues) {
    const hierarchy = {};
    let current = issue;

    for (let depth = 0; depth < MAX_HIERARCHY_DEPTH; depth += 1) {
      const parentKey = current.fields?.parent?.key;
      if (!parentKey) {
        break;
      }

      const parent = issueCache.get(parentKey);
      if (!parent) {
        break;
      }

      const typeName = (parent.fields?.issuetype?.name || '').toLowerCase();

      // Only record the levels the report cares about, and never overwrite a
      // closer ancestor of the same type.
      if (HIERARCHY_LEVELS.includes(typeName) && !hierarchy[typeName]) {
        hierarchy[typeName] = {
          key: parent.key,
          summary: parent.fields?.summary || '',
        };
      }

      current = parent;
    }

    hierarchies.set(issue.key, hierarchy);
  }

  return hierarchies;
}

/**
 * Runs an async mapper over a list with a bounded number of parallel requests.
 * Keeps us well within Jira's rate limits while still being much faster than
 * fetching worklogs one issue at a time.
 *
 * @param {T[]} items
 * @param {number} limit maximum number of in-flight operations
 * @param {(item: T) => Promise<R>} mapper
 * @returns {Promise<R[]>}
 * @template T, R
 */
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  // Each "worker" repeatedly grabs the next unclaimed index until none remain.
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
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
  let baseJql;
  let sourceLabel;

  if (sourceType === 'jql') {
    baseJql = sourceValue;
    sourceLabel = 'Custom JQL';
  } else {
    const filter = await getFilter(sourceValue);
    baseJql = filter.jql;
    sourceLabel = `${filter.name} (filter ${filter.id})`;

    if (!baseJql) {
      throw new Error(
        `Filter ${filter.id} did not return any JQL. You may not have permission to view it.`
      );
    }
  }

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
