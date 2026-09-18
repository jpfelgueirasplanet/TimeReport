/**
 * Helpers for turning the user's chosen scope (a saved filter or raw JQL) into
 * a JQL string that both reports can build on.
 */

import { getFilter } from './jiraApi';

/**
 * Strips a trailing `ORDER BY` clause from a JQL string.
 *
 * We need to wrap the filter's JQL in parentheses so we can AND extra
 * conditions onto it, and `(... ORDER BY x)` is not valid JQL.
 *
 * @param {string} jql
 * @returns {string}
 */
export function stripOrderBy(jql) {
  return jql.replace(/\s+order\s+by\s+[\s\S]*$/i, '').trim();
}

/**
 * ANDs an extra condition onto a base JQL query, parenthesising the base so
 * its own OR clauses cannot leak out and change the meaning of the query.
 *
 * @param {string} baseJql
 * @param {string} clause the condition to add
 * @returns {string}
 */
export function andClause(baseJql, clause) {
  const base = stripOrderBy(baseJql || '');
  return base ? `(${base}) AND ${clause}` : clause;
}

/**
 * Resolves the report scope into a plain JQL string plus a human readable
 * label for the UI.
 *
 * @param {object} params
 * @param {string} params.sourceType either `filter` or `jql`
 * @param {string} params.sourceValue a filter id (when `filter`) or a JQL string
 * @returns {Promise<{baseJql: string, sourceLabel: string}>}
 */
export async function resolveSource({ sourceType, sourceValue }) {
  if (sourceType === 'jql') {
    return { baseJql: sourceValue, sourceLabel: 'Custom JQL' };
  }

  const filter = await getFilter(sourceValue);

  if (!filter.jql) {
    throw new Error(
      `Filter ${filter.id} did not return any JQL. You may not have permission to view it.`
    );
  }

  return { baseJql: filter.jql, sourceLabel: `${filter.name} (filter ${filter.id})` };
}
