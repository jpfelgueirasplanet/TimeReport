/**
 * Thin wrappers around the Jira Cloud REST API.
 *
 * Every call is made with `.asUser()` so that Jira itself enforces the
 * permissions of the person looking at the report. This mirrors the behaviour
 * of the old ScriptRunner endpoint, which ran the search as the logged in user
 * and therefore only ever returned issues that user was allowed to see.
 */

import api, { route } from '@forge/api';

/**
 * Small helper that performs a request and throws a descriptive error when
 * Jira responds with a non-2xx status code.
 *
 * @param {Promise<Response>} responsePromise a fetch-like promise from @forge/api
 * @param {string} description used in the error message so failures are traceable
 * @returns {Promise<object>} the parsed JSON body
 */
async function readJson(responsePromise, description) {
  const response = await responsePromise;

  if (!response.ok) {
    // Jira usually returns a JSON error body, but fall back to plain text.
    const body = await response.text();
    throw new Error(`${description} failed with HTTP ${response.status}: ${body}`);
  }

  return response.json();
}

/**
 * Returns saved filters the current user can see, optionally narrowed by name.
 *
 * Passing a `nameQuery` uses Jira's own `filterName` matching, which is much
 * more reliable than downloading every filter on a large site.
 *
 * @param {string} [nameQuery] partial filter name to search for
 * @returns {Promise<Array<{id: string, name: string, owner: string, jql: string}>>}
 */
export async function searchFilters(nameQuery) {
  const filters = [];
  let startAt = 0;
  const maxResults = 50;

  // `expand=jql,owner` gives us enough to show a helpful label in the picker.
  // `route` must be used as a tagged template so that interpolated values are
  // URL-encoded, so we branch rather than concatenating the optional parameter.
  for (let page = 0; page < 10; page += 1) {
    const request = nameQuery
      ? api
          .asUser()
          .requestJira(
            route`/rest/api/3/filter/search?startAt=${startAt}&maxResults=${maxResults}&orderBy=name&expand=jql,owner&filterName=${nameQuery}`
          )
      : api
          .asUser()
          .requestJira(
            route`/rest/api/3/filter/search?startAt=${startAt}&maxResults=${maxResults}&orderBy=name&expand=jql,owner`
          );

    const data = await readJson(request, 'Searching saved filters');

    for (const filter of data.values || []) {
      filters.push({
        id: String(filter.id),
        name: filter.name,
        owner: filter.owner?.displayName || '',
        jql: filter.jql || '',
      });
    }

    if (data.isLast || !data.values || data.values.length === 0) {
      break;
    }

    startAt += maxResults;
  }

  return filters;
}

/**
 * Loads a single saved filter and returns its JQL.
 *
 * @param {string} filterId the numeric id of the saved filter
 * @returns {Promise<{id: string, name: string, jql: string}>}
 */
export async function getFilter(filterId) {
  const filter = await readJson(
    api.asUser().requestJira(route`/rest/api/3/filter/${filterId}?expand=jql`),
    `Loading filter ${filterId}`
  );

  return {
    id: String(filter.id),
    name: filter.name,
    // Depending on the Jira version the JQL lives either directly on the filter
    // or inside the `searchUrl`; `jql` is the documented field for API v3.
    jql: filter.jql || '',
  };
}

/**
 * Runs a JQL search and returns every matching issue.
 *
 * Uses the modern `/rest/api/3/search/jql` endpoint, which pages through
 * results with an opaque `nextPageToken` rather than `startAt`.
 *
 * @param {string} jql the query to run
 * @param {string[]} fields the issue fields to return
 * @param {number} maxIssues safety cap so a huge filter cannot hang the resolver
 * @returns {Promise<{issues: object[], truncated: boolean}>}
 */
export async function searchIssues(jql, fields, maxIssues) {
  const issues = [];
  let nextPageToken = null;
  let truncated = false;

  do {
    const body = {
      jql,
      fields,
      maxResults: 100,
    };

    if (nextPageToken) {
      body.nextPageToken = nextPageToken;
    }

    const data = await readJson(
      api.asUser().requestJira(route`/rest/api/3/search/jql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      }),
      'Searching issues'
    );

    issues.push(...(data.issues || []));
    nextPageToken = data.nextPageToken || null;

    // Stop early if the filter matches more issues than we are willing to process.
    if (issues.length >= maxIssues) {
      truncated = Boolean(nextPageToken);
      break;
    }
  } while (nextPageToken);

  return { issues: issues.slice(0, maxIssues), truncated };
}

/**
 * Fetches every worklog on an issue that was started after the given instant.
 *
 * The issue search endpoint only ever returns the first 20 worklogs per issue,
 * so we ask for them explicitly. `startedAfter` lets Jira do the date filtering
 * for us, which keeps the payloads small.
 *
 * @param {string} issueKey e.g. "ABC-123"
 * @param {number} startedAfterEpochMs only return worklogs started after this time
 * @returns {Promise<object[]>} the raw worklog entries
 */
export async function getWorklogsForIssue(issueKey, startedAfterEpochMs) {
  const worklogs = [];
  let startAt = 0;
  const maxResults = 100;

  for (let page = 0; page < 50; page += 1) {
    const data = await readJson(
      api
        .asUser()
        .requestJira(
          route`/rest/api/3/issue/${issueKey}/worklog?startAt=${startAt}&maxResults=${maxResults}&startedAfter=${startedAfterEpochMs}`
        ),
      `Loading worklogs for ${issueKey}`
    );

    const batch = data.worklogs || [];
    worklogs.push(...batch);

    startAt += maxResults;

    if (batch.length === 0 || startAt >= (data.total || 0)) {
      break;
    }
  }

  return worklogs;
}

/**
 * Loads a batch of issues by key. Used to walk up the parent hierarchy without
 * issuing one request per ancestor.
 *
 * @param {string[]} issueKeys the keys to load (should be <= 100)
 * @param {string[]} fields the issue fields to return
 * @returns {Promise<object[]>}
 */
export async function getIssuesByKeys(issueKeys, fields) {
  if (issueKeys.length === 0) {
    return [];
  }

  // `key in (...)` is the cheapest way to fetch an arbitrary set of issues.
  const jql = `key in (${issueKeys.join(',')})`;
  const { issues } = await searchIssues(jql, fields, issueKeys.length);

  return issues;
}
