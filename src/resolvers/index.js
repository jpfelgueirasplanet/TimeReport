import Resolver from '@forge/resolver';

import { getVisibleFilters } from '../lib/jiraApi';
import { buildTimeReport } from '../lib/timeReport';

const resolver = new Resolver();

/**
 * Returns the saved filters the current user can see, so the UI can render a
 * dropdown instead of asking for a raw filter id like the old REST endpoint did.
 */
resolver.define('getFilters', async () => {
  return getVisibleFilters();
});

/**
 * Builds the time report for a saved filter over a rolling window of days.
 *
 * Errors are returned as data rather than thrown so the frontend can show a
 * friendly message instead of a generic Forge failure.
 *
 * @param {object} req Forge resolver request; `payload` carries the arguments
 */
resolver.define('getTimeReport', async (req) => {
  const { filterId, daysBack } = req.payload || {};

  if (!filterId) {
    return { error: 'Please choose a saved filter.' };
  }

  const days = Number(daysBack);

  if (!Number.isInteger(days) || days < 0 || days > 180) {
    return { error: 'Days back must be a whole number between 0 and 180.' };
  }

  try {
    return await buildTimeReport({ filterId: String(filterId), daysBack: days });
  } catch (error) {
    // Surface the message in the UI and keep the stack in the Forge logs.
    console.error('Failed to build time report', error);
    return { error: error.message || 'Unexpected error while building the report.' };
  }
});

export const handler = resolver.getDefinitions();
