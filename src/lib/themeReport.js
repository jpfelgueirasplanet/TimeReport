/**
 * Builds the "Themes by month" report.
 *
 * The user's filter (or JQL) selects the THEMES themselves. For every theme we
 * walk DOWN the hierarchy to collect every descendant — initiatives, epics,
 * stories, sub-tasks — and then total the work logged against that whole
 * subtree, bucketed into calendar months.
 *
 * One row is produced per theme, with one column per month in the window.
 */

import { getIssuesByKeys, getWorklogsForIssue, searchIssues } from './jiraApi';
import { resolveSource } from './jql';
import {
  chunk,
  hierarchyLinkedKeys,
  isLinkedDescendant,
  mapWithConcurrency,
} from './hierarchy';

// Fields needed for the theme rows themselves. `components` is what the report
// displays alongside the summary.
const THEME_FIELDS = ['summary', 'issuetype', 'components', 'issuelinks'];

// Descendants only need enough to keep walking downwards.
const DESCENDANT_FIELDS = ['summary', 'issuetype', 'issuelinks'];

// Safety limits. Forge resolvers are killed after ~25 seconds, so we cap the
// amount of work rather than letting a very broad filter time the app out.
const MAX_THEMES = 100;
const MAX_DESCENDANTS = 2000;
const MAX_WORKLOG_ISSUES = 600;
const MAX_HIERARCHY_DEPTH = 5;
const WORKLOG_CONCURRENCY = 10;
const KEYS_PER_QUERY = 100;

/**
 * Produces the list of month columns, oldest first, ending with the current
 * month.
 *
 * `months = 6` yields six columns: the current month plus the previous five.
 *
 * @param {number} months how many months to include, including the current one
 * @returns {string[]} `yyyy-MM` strings
 */
export function buildMonthColumns(months) {
  const today = new Date();
  const columns = [];

  for (let offset = months - 1; offset >= 0; offset -= 1) {
    // Building from UTC year/month avoids the classic "31st of the month"
    // rollover bug you get from subtracting months on a full date.
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - offset, 1));
    columns.push(date.toISOString().slice(0, 7));
  }

  return columns;
}

/**
 * Returns the inclusive ISO date bounds (`yyyy-MM-dd`) covered by a list of
 * month columns: the first day of the first month to the last day of the last.
 *
 * @param {string[]} monthColumns `yyyy-MM` strings, oldest first
 * @returns {{start: string, end: string}}
 */
export function monthWindowBounds(monthColumns) {
  const first = monthColumns[0];
  const last = monthColumns[monthColumns.length - 1];

  const [lastYear, lastMonth] = last.split('-').map(Number);
  // Day 0 of the FOLLOWING month is the last day of `last`, which saves us from
  // hardcoding month lengths or leap year rules.
  const endOfLast = new Date(Date.UTC(lastYear, lastMonth, 0));

  return { start: `${first}-01`, end: endOfLast.toISOString().slice(0, 10) };
}

/**
 * Formats the component names attached to an issue as a single string.
 *
 * @param {object} issue
 * @returns {string} e.g. "Billing, Platform" (empty when there are none)
 */
function componentNames(issue) {
  return (issue?.fields?.components || [])
    .map((component) => component?.name)
    .filter(Boolean)
    .join(', ');
}

/**
 * Runs a JQL search but never throws.
 *
 * The descent relies on the `parent` JQL field, which a handful of older or
 * unusual Jira configurations reject outright. Rather than failing the whole
 * report we log the problem and carry on with whatever other edges we have.
 *
 * @param {string} jql
 * @param {string[]} fields
 * @param {number} maxIssues
 * @returns {Promise<object[]>} the matching issues, or an empty list on failure
 */
async function searchIssuesSafely(jql, fields, maxIssues) {
  try {
    const { issues } = await searchIssues(jql, fields, maxIssues);
    return issues;
  } catch (error) {
    console.warn(`Hierarchy search failed, continuing without it: ${error.message}`);
    return [];
  }
}

/**
 * Walks DOWN from every theme and returns a map of `issueKey -> themeKey`
 * covering the themes themselves and all of their descendants.
 *
 * Two kinds of edge are followed downwards:
 *   1. The `parent` field, queried in reverse with `parent in (...)` so one
 *      request returns a whole level of children rather than one per issue.
 *   2. Issue links whose type is a hierarchy type (e.g. "Implements"), accepted
 *      only when the linked issue's hierarchy level is LOWER than the issue we
 *      came from. That check is what distinguishes a child from a peer or a
 *      parent, regardless of which way round the link was created.
 *
 * A descendant reachable from two different themes is attributed to the first
 * theme that reached it, so its hours are never double counted.
 *
 * @param {object[]} themes the issues returned by the user's filter
 * @returns {Promise<{ownerByKey: Map<string, string>, truncated: boolean}>}
 */
async function collectDescendants(themes) {
  // Every issue we have seen, mapped to the theme whose subtree it belongs to.
  const ownerByKey = new Map();
  let truncated = false;

  // The issues we still need to expand, paired with their owning theme.
  let frontier = themes.map((theme) => {
    ownerByKey.set(theme.key, theme.key);
    return { issue: theme, themeKey: theme.key };
  });

  for (let depth = 0; depth < MAX_HIERARCHY_DEPTH && frontier.length > 0; depth += 1) {
    if (ownerByKey.size >= MAX_DESCENDANTS) {
      truncated = true;
      break;
    }

    // Owner lookup for the issues we are about to discover. A key may be
    // reachable from several frontier nodes, so first writer wins.
    const claimedBy = new Map();

    /**
     * Records that `key` belongs to `themeKey`, unless it is already spoken for.
     *
     * @param {string} key
     * @param {string} themeKey
     */
    const claim = (key, themeKey) => {
      if (!ownerByKey.has(key) && !claimedBy.has(key)) {
        claimedBy.set(key, themeKey);
      }
    };

    // --- Edge 1: children via the parent field -----------------------------
    // One query per 100 frontier issues returns that entire level of children.
    const frontierByKey = new Map(frontier.map((node) => [node.issue.key, node]));
    const childBatches = await mapWithConcurrency(
      chunk([...frontierByKey.keys()], KEYS_PER_QUERY),
      WORKLOG_CONCURRENCY,
      (keys) =>
        searchIssuesSafely(
          `parent in (${keys.join(',')})`,
          [...DESCENDANT_FIELDS, 'parent'],
          MAX_DESCENDANTS
        )
    );

    const discovered = new Map();

    for (const batch of childBatches) {
      for (const child of batch) {
        const parentKey = child.fields?.parent?.key;
        const owner = parentKey ? frontierByKey.get(parentKey)?.themeKey : undefined;

        if (owner) {
          claim(child.key, owner);
          discovered.set(child.key, child);
        }
      }
    }

    // --- Edge 2: children via hierarchy links ------------------------------
    // The linked issue stubs inside `issuelinks` are not guaranteed to carry a
    // hierarchy level, so candidates are fetched properly before being judged.
    const linkCandidates = new Map();

    for (const node of frontier) {
      for (const key of hierarchyLinkedKeys(node.issue)) {
        if (!ownerByKey.has(key) && !claimedBy.has(key)) {
          linkCandidates.set(key, node);
        }
      }
    }

    if (linkCandidates.size > 0) {
      const fetchedBatches = await mapWithConcurrency(
        chunk([...linkCandidates.keys()], KEYS_PER_QUERY),
        WORKLOG_CONCURRENCY,
        (keys) => getIssuesByKeys(keys, DESCENDANT_FIELDS)
      );

      for (const fetched of fetchedBatches) {
        for (const candidate of fetched) {
          const node = linkCandidates.get(candidate.key);

          // Only accept the link when the candidate really does sit lower.
          if (node && isLinkedDescendant(node.issue, candidate)) {
            claim(candidate.key, node.themeKey);
            discovered.set(candidate.key, candidate);
          }
        }
      }
    }

    // --- Promote this level's discoveries into the next frontier -----------
    const nextFrontier = [];

    for (const [key, themeKey] of claimedBy) {
      if (ownerByKey.size >= MAX_DESCENDANTS) {
        truncated = true;
        break;
      }

      ownerByKey.set(key, themeKey);

      const issue = discovered.get(key);
      if (issue) {
        nextFrontier.push({ issue, themeKey });
      }
    }

    frontier = nextFrontier;
  }

  return { ownerByKey, truncated };
}

/**
 * Narrows a set of issue keys down to those that actually have work logged
 * inside the reporting window.
 *
 * A subtree can easily contain thousands of issues while only a handful were
 * worked on recently. Asking Jira to do this filtering costs one search per 100
 * keys, which is far cheaper than fetching the worklogs of every descendant.
 *
 * @param {string[]} keys the candidate issue keys
 * @param {{start: string, end: string}} bounds inclusive ISO date bounds
 * @returns {Promise<string[]>} the keys with worklogs in the window
 */
async function keysWithWorklogsInWindow(keys, bounds) {
  const batches = await mapWithConcurrency(
    chunk(keys, KEYS_PER_QUERY),
    WORKLOG_CONCURRENCY,
    (batch) =>
      searchIssuesSafely(
        `key in (${batch.join(',')}) AND worklogDate >= "${bounds.start}" AND worklogDate <= "${bounds.end}"`,
        ['summary'],
        batch.length
      )
  );

  return batches.flatMap((batch) => batch.map((issue) => issue.key));
}

/**
 * Extracts the calendar month a worklog was logged against.
 *
 * Jira returns `started` with the author's UTC offset baked in, for example
 * `2024-05-01T09:30:00.000+0200`. Taking the leading `yyyy-MM` therefore gives
 * the month as the person who logged the work saw it.
 *
 * @param {object} worklog
 * @returns {string|null}
 */
function worklogMonth(worklog) {
  return typeof worklog.started === 'string' ? worklog.started.slice(0, 7) : null;
}

/**
 * Builds the complete theme report.
 *
 * @param {object} params
 * @param {string} params.sourceType either `filter` or `jql`
 * @param {string} params.sourceValue a filter id (when `filter`) or a JQL string
 * @param {number} params.months how many months to include, including this one
 * @returns {Promise<object>} report payload consumed by the frontend
 */
export async function buildThemeReport({ sourceType, sourceValue, months }) {
  const { baseJql, sourceLabel } = await resolveSource({ sourceType, sourceValue });

  const monthColumns = buildMonthColumns(months);
  const bounds = monthWindowBounds(monthColumns);

  // Unlike the daily report we do NOT add a worklog condition here: a theme
  // should still be listed (with zeroes) when nothing was logged beneath it,
  // so the user's query is run exactly as written.
  const jql = baseJql;
  const { issues: themes, truncated: themesTruncated } = await searchIssues(
    jql,
    THEME_FIELDS,
    MAX_THEMES
  );

  if (themes.length === 0) {
    return {
      sourceLabel,
      jql: baseJql,
      monthColumns,
      rows: [],
      truncated: false,
      themeCount: 0,
      descendantCount: 0,
    };
  }

  const { ownerByKey, truncated: descendantsTruncated } = await collectDescendants(themes);

  // Ask Jira which of those issues were actually worked on in the window.
  let workedKeys = await keysWithWorklogsInWindow([...ownerByKey.keys()], bounds);
  let worklogsTruncated = false;

  if (workedKeys.length > MAX_WORKLOG_ISSUES) {
    workedKeys = workedKeys.slice(0, MAX_WORKLOG_ISSUES);
    worklogsTruncated = true;
  }

  // Jira filters server side with `startedAfter`, which takes an instant. One
  // day of slack absorbs worklogs recorded in timezones ahead of UTC.
  const windowStartMs = Date.parse(`${bounds.start}T00:00:00.000Z`) - 24 * 60 * 60 * 1000;

  const worklogsPerIssue = await mapWithConcurrency(workedKeys, WORKLOG_CONCURRENCY, (key) =>
    getWorklogsForIssue(key, windowStartMs)
  );

  // Seconds logged, keyed by `themeKey` then by `yyyy-MM`.
  const secondsByTheme = new Map();
  // How many issues in each subtree contributed work, shown as a sanity check.
  const issuesByTheme = new Map();

  workedKeys.forEach((key, index) => {
    const themeKey = ownerByKey.get(key);
    if (!themeKey) {
      return;
    }

    let contributed = false;

    for (const worklog of worklogsPerIssue[index]) {
      const month = worklogMonth(worklog);

      // The `startedAfter` window is deliberately wider than the report, so
      // discard anything that falls outside the requested months.
      if (!month || month < monthColumns[0] || month > monthColumns[monthColumns.length - 1]) {
        continue;
      }

      let byMonth = secondsByTheme.get(themeKey);
      if (!byMonth) {
        byMonth = {};
        secondsByTheme.set(themeKey, byMonth);
      }

      byMonth[month] = (byMonth[month] || 0) + (worklog.timeSpentSeconds || 0);
      contributed = true;
    }

    if (contributed) {
      issuesByTheme.set(themeKey, (issuesByTheme.get(themeKey) || 0) + 1);
    }
  });

  const rows = themes
    .map((theme) => {
      const byMonth = secondsByTheme.get(theme.key) || {};
      const hours = {};
      let totalSeconds = 0;

      for (const month of monthColumns) {
        const seconds = byMonth[month] || 0;
        totalSeconds += seconds;
        // `null` means "no work logged", which the UI renders as an empty cell.
        hours[month] = seconds === 0 ? null : Math.round((seconds / 3600) * 100) / 100;
      }

      return {
        id: theme.key,
        themeKey: theme.key,
        themeSummary: theme.fields?.summary || '',
        components: componentNames(theme),
        issueCount: issuesByTheme.get(theme.key) || 0,
        hours,
        totalHours: Math.round((totalSeconds / 3600) * 100) / 100,
      };
    })
    // Busiest themes first, then alphabetically so the order is stable.
    .sort((a, b) => b.totalHours - a.totalHours || a.themeKey.localeCompare(b.themeKey));

  return {
    sourceLabel,
    jql,
    monthColumns,
    rows,
    truncated: themesTruncated || descendantsTruncated || worklogsTruncated,
    themeCount: themes.length,
    descendantCount: ownerByKey.size - themes.length,
  };
}
