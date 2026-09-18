import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box,
  HelperMessage,
  Inline,
  Label,
  LoadingButton,
  RadioGroup,
  SectionMessage,
  Select,
  Stack,
  Text,
  TextArea,
  Textfield,
  xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';

// Styles are declared with `xcss`, which only accepts Atlassian design tokens.
// Using tokens (rather than raw pixel/hex values) is what makes the app pick up
// Jira's own spacing, colours and dark mode automatically.
const fieldStyles = xcss({
  minWidth: '320px',
});

/**
 * Lets the user choose what a report should cover: a filter ID, a filter found
 * by name, or hand written JQL.
 *
 * Both reports need exactly the same choice, so this component owns that piece
 * of UI and simply reports the resulting scope upwards. `onSourceChange` is
 * called with `{ sourceType, sourceValue }`, or `null` while the input is
 * incomplete, which the parent uses to enable or disable its "Run" button.
 *
 * @param {object} props
 * @param {string} props.idPrefix unique prefix for field ids, because two
 *   instances of this component are on the page at once and ids must be unique
 * @param {(source: object|null) => void} props.onSourceChange
 * @param {string} [props.jqlPlaceholder] example query shown in the JQL box
 * @param {string} [props.jqlHelperText] report specific note about the JQL used
 */
export const ScopeSelector = ({ idPrefix, onSourceChange, jqlPlaceholder, jqlHelperText }) => {
  const [sourceMode, setSourceMode] = useState('id');
  const [filterId, setFilterId] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const [jqlText, setJqlText] = useState('');

  const [filterMatches, setFilterMatches] = useState([]);
  const [selectedMatch, setSelectedMatch] = useState(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState(null);
  // The text the currently displayed results were fetched for, so the label can
  // never imply the list matches something the user has since retyped.
  const [searchedFor, setSearchedFor] = useState('');

  /**
   * Searches Jira for filters matching the typed name and populates the picker.
   * An empty search box lists everything the user can see.
   */
  const searchForFilters = useCallback(async () => {
    const query = nameQuery.trim();

    setIsSearching(true);
    setSearchMessage(null);
    setSelectedMatch(null);

    try {
      const result = await invoke('searchFilters', { name: query });

      if (result.error) {
        setFilterMatches([]);
        setSearchedFor('');
        setSearchMessage({ appearance: 'error', text: result.error });
        return;
      }

      setFilterMatches(result.filters);
      setSearchedFor(query);

      if (result.filters.length === 0) {
        setSearchMessage({
          appearance: 'warning',
          text: query
            ? `No filter names contain "${query}". Jira only returns filters you own or that are shared with you.`
            : 'Jira returned no saved filters for your account. Try entering a filter ID or JQL instead.',
        });
      }
    } catch (error) {
      setFilterMatches([]);
      setSearchedFor('');
      setSearchMessage({
        appearance: 'error',
        text: error.message || 'Could not search saved filters.',
      });
    } finally {
      setIsSearching(false);
    }
  }, [nameQuery]);

  /**
   * Updates the search text and drops any previously fetched results, so the
   * dropdown never shows filters belonging to an earlier search term.
   *
   * @param {string} value the new search text
   */
  const changeNameQuery = useCallback((value) => {
    setNameQuery(value);
    setFilterMatches([]);
    setSelectedMatch(null);
    setSearchMessage(null);
    setSearchedFor('');
  }, []);

  const filterOptions = useMemo(
    () =>
      filterMatches.map((filter) => ({
        label: filter.owner
          ? `${filter.name} — ${filter.owner} (${filter.id})`
          : `${filter.name} (${filter.id})`,
        value: filter.id,
      })),
    [filterMatches]
  );

  // Works out what to send to the backend based on the selected input mode.
  // `null` means the current input is incomplete.
  const source = useMemo(() => {
    if (sourceMode === 'jql') {
      return jqlText.trim() ? { sourceType: 'jql', sourceValue: jqlText.trim() } : null;
    }

    if (sourceMode === 'name') {
      return selectedMatch ? { sourceType: 'filter', sourceValue: selectedMatch.value } : null;
    }

    return filterId.trim() ? { sourceType: 'filter', sourceValue: filterId.trim() } : null;
  }, [sourceMode, jqlText, selectedMatch, filterId]);

  // Push the scope up to the parent whenever it changes.
  useEffect(() => {
    onSourceChange(source);
  }, [source, onSourceChange]);

  return (
    <Stack space="space.200">
      <Stack space="space.050">
        <Label labelFor={`${idPrefix}-source-mode`}>Report scope</Label>
        <RadioGroup
          id={`${idPrefix}-source-mode`}
          name={`${idPrefix}-source-mode`}
          value={sourceMode}
          options={[
            { name: `${idPrefix}-source-mode`, value: 'id', label: 'Filter ID' },
            { name: `${idPrefix}-source-mode`, value: 'name', label: 'Search filter by name' },
            { name: `${idPrefix}-source-mode`, value: 'jql', label: 'JQL' },
          ]}
          onChange={(event) => setSourceMode(event.target.value)}
        />
      </Stack>

      {sourceMode === 'id' && (
        <Box xcss={fieldStyles}>
          <Stack space="space.050">
            <Label labelFor={`${idPrefix}-filter-id`}>Filter ID</Label>
            <Textfield
              id={`${idPrefix}-filter-id`}
              placeholder="e.g. 10042"
              value={filterId}
              onChange={(event) => setFilterId(event.target.value)}
            />
            <HelperMessage>
              The number at the end of a filter URL, e.g. /issues/?filter=10042
            </HelperMessage>
          </Stack>
        </Box>
      )}

      {sourceMode === 'name' && (
        <Stack space="space.100">
          <Inline space="space.100" alignBlock="end" shouldWrap>
            <Box xcss={fieldStyles}>
              <Stack space="space.050">
                <Label labelFor={`${idPrefix}-filter-name`}>Filter name</Label>
                <Textfield
                  id={`${idPrefix}-filter-name`}
                  placeholder="Type part of a filter name, or leave blank for all"
                  value={nameQuery}
                  onChange={(event) => changeNameQuery(event.target.value)}
                />
              </Stack>
            </Box>
            <LoadingButton isLoading={isSearching} onClick={searchForFilters}>
              Search
            </LoadingButton>
          </Inline>

          {searchMessage && (
            <SectionMessage appearance={searchMessage.appearance}>
              <Text>{searchMessage.text}</Text>
            </SectionMessage>
          )}

          {filterMatches.length > 0 && (
            <Box xcss={fieldStyles}>
              <Stack space="space.050">
                <Label labelFor={`${idPrefix}-filter-match`}>
                  {searchedFor
                    ? `Filters containing "${searchedFor}" (${filterMatches.length})`
                    : `All filters (${filterMatches.length})`}
                </Label>
                <Select
                  id={`${idPrefix}-filter-match`}
                  options={filterOptions}
                  value={selectedMatch}
                  onChange={setSelectedMatch}
                  placeholder="Choose a filter..."
                  isClearable
                />
              </Stack>
            </Box>
          )}
        </Stack>
      )}

      {sourceMode === 'jql' && (
        <Stack space="space.050">
          <Label labelFor={`${idPrefix}-jql-input`}>JQL</Label>
          <TextArea
            id={`${idPrefix}-jql-input`}
            isMonospaced
            minimumRows={3}
            placeholder={jqlPlaceholder}
            value={jqlText}
            onChange={(event) => setJqlText(event.target.value)}
          />
          {jqlHelperText && <HelperMessage>{jqlHelperText}</HelperMessage>}
        </Stack>
      )}
    </Stack>
  );
};
