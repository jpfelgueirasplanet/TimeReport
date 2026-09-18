import React, { useCallback, useMemo, useState } from 'react';
import {
  Box,
  Code,
  DynamicTable,
  Inline,
  Label,
  Link,
  LoadingButton,
  Lozenge,
  SectionMessage,
  Stack,
  Strong,
  Text,
  Textfield,
  xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';

import { ScopeSelector } from './ScopeSelector';
import { buildCsv, CsvExport } from './csv';

const toolbarStyles = xcss({
  backgroundColor: 'elevation.surface.raised',
  borderColor: 'color.border',
  borderStyle: 'solid',
  borderWidth: 'border.width',
  borderRadius: 'border.radius.200',
  padding: 'space.200',
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

// Which of those columns hold an issue key and should therefore be a link.
const LINK_COLUMNS = new Set(['issueKey', 'epicKey', 'initiativeKey', 'themeKey']);

/**
 * The original report: one row per person and issue, one column per day.
 *
 * @param {object} props
 * @param {(issueKey: string) => string|null} props.issueUrl builds absolute
 *   issue links, which the sandboxed iframe requires
 */
export const DailyReport = ({ issueUrl }) => {
  const [source, setSource] = useState(null);
  const [daysBack, setDaysBack] = useState('7');

  const [report, setReport] = useState(null);
  const [reportError, setReportError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  const runReport = useCallback(async () => {
    if (!source) {
      return;
    }

    setIsLoading(true);
    setReportError(null);

    try {
      const result = await invoke('getTimeReport', { ...source, daysBack: Number(daysBack) });

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
  }, [source, daysBack]);

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
        ...report.dateColumns.map((date) => ({ key: date, content: date, isSortable: true })),
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
        ...BASE_COLUMNS.map((column) => {
          const value = row[column.key];

          // Link straight to the issue so the report stays useful as a
          // jumping-off point. A blank key renders as an empty cell.
          if (LINK_COLUMNS.has(column.key)) {
            return {
              key: column.key,
              content: value ? (
                <Link href={issueUrl(value)} openNewTab>
                  {value}
                </Link>
              ) : (
                <Text> </Text>
              ),
            };
          }

          return { key: column.key, content: <Text>{value}</Text> };
        }),
        ...report.dateColumns.map((date) => ({
          key: date,
          // `null` hours mean nothing was logged that day, shown as a blank cell.
          content: <Text>{row.hours[date] === null ? ' ' : row.hours[date].toFixed(2)}</Text>,
        })),
        { key: 'total', content: <Text>{row.totalHours.toFixed(2)}</Text> },
      ],
    }));
  }, [report, issueUrl]);

  const csv = useMemo(() => {
    if (!report) {
      return '';
    }

    return buildCsv(
      [...BASE_COLUMNS.map((column) => column.label), ...report.dateColumns, 'Total'],
      report.rows.map((row) => [
        ...BASE_COLUMNS.map((column) => row[column.key]),
        ...report.dateColumns.map((date) => row.hours[date]),
        row.totalHours,
      ])
    );
  }, [report]);

  // Sum of every row's total, shown as a lozenge next to the filter name so the
  // overall effort for the period is visible without scrolling the table.
  const grandTotalHours = useMemo(
    () => (report ? report.rows.reduce((sum, row) => sum + row.totalHours, 0) : 0),
    [report]
  );

  return (
    <Stack space="space.300">
      <Text color="color.text.subtle">
        Scope the report by filter ID, by searching for a filter by name, or with your own JQL. The
        report shows the hours each person logged against each issue, with its epic, initiative and
        theme.
      </Text>

      {/* Toolbar card: a raised surface with a border makes the controls read as
          a distinct Jira-style panel instead of floating on the page. */}
      <Box xcss={toolbarStyles}>
        <Stack space="space.200">
          <ScopeSelector
            idPrefix="daily"
            onSourceChange={setSource}
            jqlPlaceholder='project = ABC AND assignee in membersOf("developers")'
            jqlHelperText="Any ORDER BY clause is ignored, and a worklog date condition is added automatically."
          />

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
              isDisabled={!source}
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
            The filter matched more issues than this report processes in one run. Narrow the filter
            or reduce the number of days to see the full picture.
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
            <CsvExport
              csv={csv}
              fileName="time-report.csv"
              isDisabled={report.rows.length === 0}
            />
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
  );
};
