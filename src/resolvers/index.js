import Resolver from '@forge/resolver';

import { searchFilters } from '../lib/jiraApi';
import { buildTimeReport } from '../lib/timeReport';

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
 * Builds the time report for either a saved filter or a raw JQL query.
 *
 * @param {object} req Forge resolver request; `payload` carries the arguments
 */
resolver.define('getTimeReport', async (req) => {
  const { sourceType, sourceValue, daysBack } = req.payload || {};

  const type = sourceType === 'jql' ? 'jql' : 'filter';
  const value = typeof sourceValue === 'string' ? sourceValue.trim() : '';

  if (!value) {
    return {
      error: type === 'jql' ? 'Please enter a JQL query.' : 'Please enter a filter ID.',
    };
  }

  // A filter is always referenced by its numeric id, so reject anything else
  // early with a clear message rather than letting Jira return a 404.
  if (type === 'filter' && !/^\d+$/.test(value)) {
    return { error: `"${value}" is not a valid filter ID. Filter IDs are numbers, e.g. 10042.` };
  }

  const days = Number(daysBack);

  if (!Number.isInteger(days) || days < 0 || days > 180) {
    return { error: 'Days back must be a whole number between 0 and 180.' };
  }

  try {
    return await buildTimeReport({ sourceType: type, sourceValue: value, daysBack: days });
  } catch (error) {
    // Surface the message in the UI and keep the stack in the Forge logs.
    console.error('Failed to build time report', error);
    return { error: error.message || 'Unexpected error while building the report.' };
  }
});

export const handler = resolver.getDefinitions();
