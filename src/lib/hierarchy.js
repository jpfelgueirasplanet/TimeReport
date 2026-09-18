/**
 * Shared rules for interpreting Jira's issue hierarchy.
 *
 * Both reports in this app need to understand how issues relate to each other
 * vertically, but they travel in opposite directions: the daily report walks
 * UP from a work item to its Theme, while the theme report walks DOWN from a
 * Theme to everything underneath it. Keeping the rules in one module means the
 * two reports can never disagree about what counts as a hierarchy edge.
 */

// Issue link types that represent a hierarchy relationship rather than a plain
// association. Matching is a case-insensitive substring of the link TYPE name,
// so "implement" covers both the "implements" and "is implemented by"
// directions. Add further type names here if your site uses others.
export const HIERARCHY_LINK_TYPES = ['implement'];

// Jira's issue type hierarchy levels:
//   -1 = sub-task, 0 = base (Story/Task/Bug), 1 = Epic, 2 = Initiative, 3 = Theme
// We always classify by LEVEL rather than by issue type name, so renamed types
// such as "Epic (migrated)" and localised names keep working.
export const LEVEL_EPIC = 1;
export const LEVEL_INITIATIVE = 2;
export const LEVEL_THEME = 3;

/**
 * Reads the hierarchy level of an issue, or `undefined` when Jira did not
 * report one (older sites and some custom types omit it).
 *
 * @param {object} issue an issue as returned by the search API
 * @returns {number|undefined}
 */
export function levelOf(issue) {
  const level = issue?.fields?.issuetype?.hierarchyLevel;
  return typeof level === 'number' ? level : undefined;
}

/**
 * Returns the key of the issue's parent, if it has one.
 *
 * @param {object} issue
 * @returns {string|undefined}
 */
export function parentKeyOf(issue) {
  return issue?.fields?.parent?.key;
}

/**
 * Returns the keys of every issue joined to this one by a hierarchy link type.
 *
 * Link DIRECTION is deliberately ignored here. A link created as "implements"
 * and the same link viewed from the other end as "is implemented by" are the
 * same edge, and Jira reports them under `outwardIssue`/`inwardIssue`
 * respectively. Callers decide whether the linked issue is above or below by
 * comparing hierarchy levels, which is the only reliable signal.
 *
 * @param {object} issue
 * @returns {string[]} linked issue keys (possibly empty)
 */
export function hierarchyLinkedKeys(issue) {
  const keys = [];

  for (const link of issue?.fields?.issuelinks || []) {
    const typeName = (link?.type?.name || '').toLowerCase();

    if (!HIERARCHY_LINK_TYPES.some((allowed) => typeName.includes(allowed))) {
      continue;
    }

    const linked = link.outwardIssue || link.inwardIssue;
    if (linked?.key) {
      keys.push(linked.key);
    }
  }

  return keys;
}

/**
 * Returns every issue key that might sit ABOVE the given issue, tagged with how
 * we found it so the caller can apply the right safety checks.
 *
 * @param {object} issue
 * @returns {Array<{key: string, viaLink: boolean}>}
 */
export function candidateAncestors(issue) {
  const candidates = [];

  const parentKey = parentKeyOf(issue);
  if (parentKey) {
    candidates.push({ key: parentKey, viaLink: false });
  }

  for (const key of hierarchyLinkedKeys(issue)) {
    candidates.push({ key, viaLink: true });
  }

  return candidates;
}

/**
 * Decides whether `candidate` can be accepted as sitting BELOW `node` when the
 * two are joined by a hierarchy LINK (not by the parent field).
 *
 * Without a level on both ends we cannot tell "down" from "up" or sideways, so
 * an unverifiable link is skipped rather than guessed. Links to peers or
 * ancestors are not descent edges either.
 *
 * @param {object} node the issue we are travelling from
 * @param {object} candidate the linked issue
 * @returns {boolean}
 */
export function isLinkedDescendant(node, candidate) {
  const nodeLevel = levelOf(node);
  const candidateLevel = levelOf(candidate);

  if (nodeLevel === undefined || candidateLevel === undefined) {
    return false;
  }

  return candidateLevel < nodeLevel;
}

/**
 * Runs an async mapper over a list with a bounded number of parallel requests.
 * Keeps us well within Jira's rate limits while still being much faster than
 * issuing one request at a time.
 *
 * @param {T[]} items
 * @param {number} limit maximum number of in-flight operations
 * @param {(item: T) => Promise<R>} mapper
 * @returns {Promise<R[]>}
 * @template T, R
 */
export async function mapWithConcurrency(items, limit, mapper) {
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
 * Splits an array into chunks of at most `size` entries. Used because Jira's
 * `key in (...)` clause gets unwieldy with very long lists.
 *
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 * @template T
 */
export function chunk(items, size) {
  const chunks = [];

  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }

  return chunks;
}
