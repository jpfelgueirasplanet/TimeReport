import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
  Code,
  CodeBlock,
  DynamicTable,
  Heading,
  HelperMessage,
  Inline,
  Label,
  Link,
  LoadingButton,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  RadioGroup,
  SectionMessage,
  Select,
  Stack,
  Strong,
  Text,
  TextArea,
  Textfield,
  xcss,
} from '@forge/react';
import { invoke, view } from '@forge/bridge';

// Styles are declared with `xcss`, which only accepts Atlassian design tokens.
// Using tokens (rather than raw pixel/hex values) is what makes the app pick up
// Jira's own spacing, colours and dark mode automatically.
const toolbarStyles = xcss({
  backgroundColor: 'elevation.surface.raised',
  borderColor: 'color.border',
  borderStyle: 'solid',
  borderWidth: 'border.width',
  borderRadius: 'border.radius.200',
  padding: 'space.200',
});

const filterFieldStyles = xcss({
  minWidth: '320px',
});

const daysFieldStyles = xcss({
  width: '120px',
});

// Columns that always appear before the per-day columns. Kept in one place so
// the table header and the CSV export can never drift apart.
const BASE_COLUMNS = [
  { key: 'user', label: 'User' },
  { key: 'issueKey', label: 'Issue Key' },
  { key: 'issueType', label: 'Issue Type' },
  { key: 'issueSummary', label: 'Summary' },
  { key: 'epicKey', label: 'Epic' },
  { key: 'epicSummary', label: 'Epic Summary' },
  { key: 'initiativeKey', label: 'Initiative' },
  { key: 'initiativeSummary', label: 'Initiative Summary' },
  { key: 'themeKey', label: 'Theme' },
  { key: 'themeSummary', label: 'Theme Summary' },
];

/**
 * Escapes a single CSV field: wraps it in quotes and doubles any quotes inside.
 *
 * @param {string|number|null} value
 * @returns {string}
 */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Converts the report payload into CSV text, matching the column order used by
 * the on-screen table (and by the old ScriptRunner export button).
 *
 * @param {object} report
 * @returns {string}
 */
function buildCsv(report) {
  const header = [
    ...BASE_COLUMNS.map((column) => column.label),
    ...report.dateColumns,
    'Total',
  ];

  const lines = [header.map(csvCell).join(',')];

  for (const row of report.rows) {
    const cells = [
      ...BASE_COLUMNS.map((column) => row[column.key]),
      ...report.dateColumns.map((date) => row.hours[date]),
      row.totalHours,
    ];
    lines.push(cells.map(csvCell).join(','));
  }

  return lines.join('\r\n');
}

const App = () => {
  // How the user wants to scope the report: by filter id, by searching for a
  // filter by name, or by typing JQL directly.
  const [sourceMode, setSourceMode] = useState('id');
  const [filterId, setFilterId] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const [jqlText, setJqlText] = useState('');

  const [filterMatches, setFilterMatches] = useState([]);
  const [selectedMatch, setSelectedMatch] = useState(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState(null);

  const [daysBack, setDaysBack] = useState('7');

  const [report, setReport] = useState(null);
  const [reportError, setReportError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isCsvOpen, setIsCsvOpen] = useState(false);
  const [siteUrl, setSiteUrl] = useState('');

  // The app is sandboxed in an iframe, so links must be absolute. `view.getContext()`
  // tells us which Jira site the app is currently running on.
  useEffect(() => {
    view
      .getContext()
      .then((context) => setSiteUrl(context?.siteUrl || ''))
      .catch(() => setSiteUrl(''));
  }, []);

  /**
   * Builds an absolute URL to an issue, or `null` when we don't have a key yet.
   *
   * @param {string} issueKey
   * @returns {string|null}
   */
  const issueUrl = useCallback(
    (issueKey) => (issueKey ? `${siteUrl}/browse/${issueKey}` : null),
    [siteUrl]
  );

  /**
   * Searches Jira for filters matching the typed name and populates the picker.
   * An empty search box lists everything the user can see.
   */
  const searchForFilters = useCallback(async () => {
    setIsSearching(true);
    setSearchMessage(null);
    setSelectedMatch(null);

    try {
      const result = await invoke('searchFilters', { name: nameQuery });

      if (result.error) {
        setFilterMatches([]);
        setSearchMessage({ appearance: 'error', text: result.error });
        return;
      }

      setFilterMatches(result.filters);

      if (result.filters.length === 0) {
        setSearchMessage({
          appearance: 'warning',
          text: nameQuery
            ? `No filters matched "${nameQuery}". Note that Jira only searches filters you own or that are shared with you.`
            : 'Jira returned no saved filters for your account. Try entering a filter ID or JQL instead.',
        });
      }
    } catch (error) {
      setFilterMatches([]);
      setSearchMessage({
        appearance: 'error',
        text: error.message || 'Could not search saved filters.',
      });
    } finally {
      setIsSearching(false);
    }
  }, [nameQuery]);

  const filterOptions = useMemo(
    () =>
      filterMatches.map((filter) => ({
        label: filter.owner ? `${filter.name} — ${filter.owner} (${filter.id})` : `${filter.name} (${filter.id})`,
        value: filter.id,
      })),
    [filterMatches]
  );

  // Works out what to send to the backend based on the selected input mode.
  // Returns `null` when the current input is incomplete.
  const reportSource = useMemo(() => {
    if (sourceMode === 'jql') {
      return jqlText.trim() ? { sourceType: 'jql', sourceValue: jqlText.trim() } : null;
    }

    if (sourceMode === 'name') {
      return selectedMatch ? { sourceType: 'filter', sourceValue: selectedMatch.value } : null;
    }

    return filterId.trim() ? { sourceType: 'filter', sourceValue: filterId.trim() } : null;
  }, [sourceMode, jqlText, selectedMatch, filterId]);

  const runReport = useCallback(async () => {
    if (!reportSource) {
      return;
    }

    setIsLoading(true);
    setReportError(null);

    try {
      const result = await invoke('getTimeReport', {
        ...reportSource,
        daysBack: Number(daysBack),
      });

      if (result.error) {
        setReport(null);
        setReportError(result.error);
      } else {
        setReport(result);
      }
    } catch (error) {
      setReport(null);
      setReportError(error.message || 'Unexpected error while running the report.');
    } finally {
      setIsLoading(false);
    }
  }, [reportSource, daysBack]);

  // Build the DynamicTable header: fixed columns first, then one column per day,
  // then a total so users can sanity check a person's week at a glance.
  const tableHead = useMemo(() => {
    if (!report) {
      return { cells: [] };
    }

    return {
      cells: [
        ...BASE_COLUMNS.map((column) => ({
          key: column.key,
          content: column.label,
          isSortable: true,
        })),
        ...report.dateColumns.map((date) => ({
          key: date,
          content: date,
          isSortable: true,
        })),
        { key: 'total', content: 'Total', isSortable: true },
      ],
    };
  }, [report]);

  const tableRows = useMemo(() => {
    if (!report) {
      return [];
    }

    return report.rows.map((row) => ({
      key: row.id,
      cells: [
        { key: 'user', content: <Text>{row.user}</Text> },
        {
          key: 'issueKey',
          // Link straight to the issue so the report stays useful as a jumping-off point.
          content: <Link href={issueUrl(row.issueKey)} openNewTab>{row.issueKey}</Link>,
        },
        { key: 'issueType', content: <Text>{row.issueType}</Text> },
        { key: 'issueSummary', content: <Text>{row.issueSummary}</Text> },
        {
          key: 'epicKey',
          content: row.epicKey ? (
            <Link href={issueUrl(row.epicKey)} openNewTab>{row.epicKey}</Link>
          ) : (
            <Text> </Text>
          ),
        },
        { key: 'epicSummary', content: <Text>{row.epicSummary}</Text> },
        {
          key: 'initiativeKey',
          content: row.initiativeKey ? (
            <Link href={issueUrl(row.initiativeKey)} openNewTab>{row.initiativeKey}</Link>
          ) : (
            <Text> </Text>
          ),
        },
        { key: 'initiativeSummary', content: <Text>{row.initiativeSummary}</Text> },
        {
          key: 'themeKey',
          content: row.themeKey ? (
            <Link href={issueUrl(row.themeKey)} openNewTab>{row.themeKey}</Link>
          ) : (
            <Text> </Text>
          ),
        },
        { key: 'themeSummary', content: <Text>{row.themeSummary}</Text> },
        ...report.dateColumns.map((date) => ({
          key: date,
          // `null` hours mean nothing was logged that day, shown as a blank cell.
          content: <Text>{row.hours[date] === null ? ' ' : row.hours[date].toFixed(2)}</Text>,
        })),
        { key: 'total', content: <Text>{row.totalHours.toFixed(2)}</Text> },
      ],
    }));
  }, [report, issueUrl]);

  const csv = useMemo(() => (report ? buildCsv(report) : ''), [report]);

  // Sum of every row's total, shown as a lozenge next to the filter name so the
  // overall effort for the period is visible without scrolling the table.
  const grandTotalHours = useMemo(() => {
    if (!report) {
      return 0;
    }

    return report.rows.reduce((sum, row) => sum + row.totalHours, 0);
  }, [report]);

  return (
    <Box padding="space.200">
      <Stack space="space.300">
        {/* Jira renders the page title for us (layout: basic), so we only add a
            short subtitle here rather than repeating the heading. */}
        <Stack space="space.050">
          <Heading as="h2" size="medium">
            Logged time by person, issue and day
          </Heading>
          <Text color="color.text.subtle">
            Scope the report by filter ID, by searching for a filter by name, or with your own JQL.
            The report shows the hours each person logged against each issue, with its epic,
            initiative and theme.
          </Text>
        </Stack>

        {/* Toolbar card: a raised surface with a border makes the controls read as
            a distinct Jira-style panel instead of floating on the page. */}
        <Box xcss={toolbarStyles}>
          <Stack space="space.200">
            <Stack space="space.050">
              <Label labelFor="source-mode">Report scope</Label>
              <RadioGroup
                id="source-mode"
                name="source-mode"
                value={sourceMode}
                options={[
                  { name: 'source-mode', value: 'id', label: 'Filter ID' },
                  { name: 'source-mode', value: 'name', label: 'Search filter by name' },
                  { name: 'source-mode', value: 'jql', label: 'JQL' },
                ]}
                onChange={(event) => setSourceMode(event.target.value)}
              />
            </Stack>

            {sourceMode === 'id' && (
              <Box xcss={filterFieldStyles}>
                <Stack space="space.050">
                  <Label labelFor="filter-id">Filter ID</Label>
                  <Textfield
                    id="filter-id"
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
                  <Box xcss={filterFieldStyles}>
                    <Stack space="space.050">
                      <Label labelFor="filter-name">Filter name</Label>
                      <Textfield
                        id="filter-name"
                        placeholder="Type part of a filter name, or leave blank for all"
                        value={nameQuery}
                        onChange={(event) => setNameQuery(event.target.value)}
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
                  <Box xcss={filterFieldStyles}>
                    <Stack space="space.050">
                      <Label labelFor="filter-match">Matching filters</Label>
                      <Select
                        id="filter-match"
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
                <Label labelFor="jql-input">JQL</Label>
                <TextArea
                  id="jql-input"
                  isMonospaced
                  minimumRows={3}
                  placeholder='project = ABC AND assignee in membersOf("developers")'
                  value={jqlText}
                  onChange={(event) => setJqlText(event.target.value)}
                />
                <HelperMessage>
                  Any ORDER BY clause is ignored, and a worklog date condition is added
                  automatically.
                </HelperMessage>
              </Stack>
            )}

            <Inline space="space.200" alignBlock="end" shouldWrap>
              <Box xcss={daysFieldStyles}>
                <Stack space="space.050">
                  <Label labelFor="days-back">Days back</Label>
                  <Textfield
                    id="days-back"
                    type="number"
                    value={daysBack}
                    onChange={(event) => setDaysBack(event.target.value)}
                  />
                </Stack>
              </Box>

              <LoadingButton
                appearance="primary"
                isLoading={isLoading}
                isDisabled={!reportSource}
                onClick={runReport}
              >
                Run report
              </LoadingButton>
            </Inline>
          </Stack>
        </Box>

        {reportError && (
          <SectionMessage appearance="error" title="Could not build the report">
            <Text>{reportError}</Text>
          </SectionMessage>
        )}

        {report && report.truncated && (
          <SectionMessage appearance="warning" title="Results were truncated">
            <Text>
              The filter matched more issues than this report processes in one run. Narrow the
              filter or reduce the number of days to see the full picture.
            </Text>
          </SectionMessage>
        )}

        {report && (
          <Stack space="space.150">
            <Inline space="space.200" alignBlock="center" spread="space-between">
              <Inline space="space.100" alignBlock="center">
                <Strong>{report.sourceLabel}</Strong>
                <Lozenge appearance="inprogress">{`${report.rows.length} rows`}</Lozenge>
                <Lozenge appearance="default">{`${report.issueCount} issues`}</Lozenge>
                <Lozenge appearance="success">{`${grandTotalHours.toFixed(2)} h`}</Lozenge>
              </Inline>
              <ButtonGroup>
                <Button
                  iconBefore="download"
                  onClick={() => setIsCsvOpen(true)}
                  isDisabled={report.rows.length === 0}
                >
                  Export to CSV
                </Button>
              </ButtonGroup>
            </Inline>

            {/* Showing the query that actually ran makes it obvious why a report
                came back empty, which is hard to diagnose otherwise. */}
            <Text color="color.text.subtle" size="small">
              Query: <Code>{report.jql}</Code>
            </Text>

            <DynamicTable
              head={tableHead}
              rows={tableRows}
              rowsPerPage={50}
              emptyView="No work was logged in this period for the selected filter."
            />
          </Stack>
        )}
      </Stack>

      <ModalTransition>
        {isCsvOpen && (
          <Modal onClose={() => setIsCsvOpen(false)} width="x-large">
            <ModalHeader>
              <ModalTitle>CSV export</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Stack space="space.100">
                <Text>
                  Forge apps cannot write files to your computer, so copy the CSV below and save it
                  as <Strong>time-report.csv</Strong>. Use the copy button in the corner of the code
                  block.
                </Text>
                <CodeBlock language="text" text={csv} />
              </Stack>
            </ModalBody>
            <ModalFooter>
              <Button appearance="primary" onClick={() => setIsCsvOpen(false)}>
                Close
              </Button>
            </ModalFooter>
          </Modal>
        )}
      </ModalTransition>
    </Box>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
