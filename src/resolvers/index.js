import Resolver from '@forge/resolver';

import { searchFilters } from '../lib/jiraApi';
import { buildTimeReport } from '../lib/timeReport';
import { buildThemeReport } from '../lib/themeReport';

const resolver = new Resolver();

/**
 * Looks up saved filters by (partial) name so the user can find a filter
 * without knowing its numeric id.
 *
 * Errors are returned as data rather than thrown, so the UI can explain what
 * went wrong instead of silently showing an empty list.
 *
 * @param {object} req Forge resolver request; `payload.name` is the search text
 */
resolver.define('searchFilters', async (req) => {
  const { name } = req.payload || {};

  try {
    const filters = await searchFilters(name ? String(name).trim() : undefined);
    return { filters };
  } catch (error) {
    console.error('Failed to search filters', error);
    return { error: error.message || 'Could not search saved filters.' };
  }
});

/**
 * Validates the scope arguments shared by every report.
 *
 * Both reports accept the same two ways of choosing what to look at, so the
 * checks live here rather than being repeated (and drifting) in each resolver.
 *
 * @param {string} sourceType either `filter` or `jql`
 * @param {string} sourceValue a filter id or a JQL string
 * @returns {{sourceType: string, sourceValue: string}|{error: string}}
 */
function validateSource(sourceType, sourceValue) {
  const type = sourceType === 'jql' ? 'jql' : 'filter';
  const value = typeof sourceValue === 'string' ? sourceValue.trim() : '';

  if (!value) {
    return { error: type === 'jql' ? 'Please enter a JQL query.' : 'Please enter a filter ID.' };
  }

  // A filter is always referenced by its numeric id, so reject anything else
  // early with a clear message rather than letting Jira return a 404.
  if (type === 'filter' && !/^\d+$/.test(value)) {
    return { error: `"${value}" is not a valid filter ID. Filter IDs are numbers, e.g. 10042.` };
  }

  return { sourceType: type, sourceValue: value };
}

/**
 * Builds the time report for either a saved filter or a raw JQL query.
 *
 * @param {object} req Forge resolver request; `payload` carries the arguments
 */
resolver.define('getTimeReport', async (req) => {
  const { sourceType, sourceValue, daysBack } = req.payload || {};

  const source = validateSource(sourceType, sourceValue);

  if (source.error) {
    return { error: source.error };
  }

  const days = Number(daysBack);

  if (!Number.isInteger(days) || days < 0 || days > 180) {
    return { error: 'Days back must be a whole number between 0 and 180.' };
  }

  try {
    return await buildTimeReport({ ...source, daysBack: days });
  } catch (error) {
    // Surface the message in the UI and keep the stack in the Forge logs.
    console.error('Failed to build time report', error);
    return { error: error.message || 'Unexpected error while building the report.' };
  }
});

/**
 * Builds the theme report: one row per theme returned by the filter, with the
 * work logged across its whole subtree totalled per calendar month.
 *
 * @param {object} req Forge resolver request; `payload` carries the arguments
 */
resolver.define('getThemeReport', async (req) => {
  const { sourceType, sourceValue, months } = req.payload || {};

  const source = validateSource(sourceType, sourceValue);

  if (source.error) {
    return { error: source.error };
  }

  const monthCount = Number(months);

  if (!Number.isInteger(monthCount) || monthCount < 1 || monthCount > 36) {
    return { error: 'Months must be a whole number between 1 and 36.' };
  }

  try {
    return await buildThemeReport({ ...source, months: monthCount });
  } catch (error) {
    // Surface the message in the UI and keep the stack in the Forge logs.
    console.error('Failed to build theme report', error);
    return { error: error.message || 'Unexpected error while building the report.' };
  }
});

export const handler = resolver.getDefinitions();
