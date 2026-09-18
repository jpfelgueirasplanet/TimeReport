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

const monthsFieldStyles = xcss({
  width: '120px',
});

// Columns shown before the per-month columns. Single source of truth for both
// the table header and the CSV export.
const BASE_COLUMNS = [
  { key: 'themeKey', label: 'Theme' },
  { key: 'themeSummary', label: 'Summary' },
  { key: 'components', label: 'Components' },
  { key: 'issueCount', label: 'Issues Worked' },
];

/**
 * Turns `2025-03` into `Mar 2025` for display. The raw `yyyy-MM` value is kept
 * for the CSV so the export stays sortable in a spreadsheet.
 *
 * @param {string} month
 * @returns {string}
 */
function monthLabel(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1, 1));

  return `${date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${year}`;
}

/**
 * The theme report: one row per theme returned by the filter, with the work
 * logged across everything beneath it totalled per calendar month.
 *
 * @param {object} props
 * @param {(issueKey: string) => string|null} props.issueUrl builds absolute
 *   issue links, which the sandboxed iframe requires
 */
export const ThemeReport = ({ issueUrl }) => {
  const [source, setSource] = useState(null);
  const [months, setMonths] = useState('6');

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
      const result = await invoke('getThemeReport', { ...source, months: Number(months) });

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
  }, [source, months]);

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
        ...report.monthColumns.map((month) => ({
          key: month,
          content: monthLabel(month),
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
        {
          key: 'themeKey',
          content: (
            <Link href={issueUrl(row.themeKey)} openNewTab>
              {row.themeKey}
            </Link>
          ),
        },
        { key: 'themeSummary', content: <Text>{row.themeSummary}</Text> },
        // Components live on the theme itself; an empty string means none are set.
        { key: 'components', content: <Text>{row.components || ' '}</Text> },
        { key: 'issueCount', content: <Text>{String(row.issueCount)}</Text> },
        ...report.monthColumns.map((month) => ({
          key: month,
          // `null` hours mean nothing was logged that month, shown as blank.
          content: <Text>{row.hours[month] === null ? ' ' : row.hours[month].toFixed(2)}</Text>,
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
      [...BASE_COLUMNS.map((column) => column.label), ...report.monthColumns, 'Total'],
      report.rows.map((row) => [
        ...BASE_COLUMNS.map((column) => row[column.key]),
        ...report.monthColumns.map((month) => row.hours[month]),
        row.totalHours,
      ])
    );
  }, [report]);

  const grandTotalHours = useMemo(
    () => (report ? report.rows.reduce((sum, row) => sum + row.totalHours, 0) : 0),
    [report]
  );

  return (
    <Stack space="space.300">
      <Text color="color.text.subtle">
        Your filter or JQL selects the <Strong>themes</Strong>. For each one the report walks down
        the hierarchy — initiatives, epics, stories and sub-tasks — and totals the work logged
        across that whole subtree, month by month.
      </Text>

      <Box xcss={toolbarStyles}>
        <Stack space="space.200">
          <ScopeSelector
            idPrefix="theme"
            onSourceChange={setSource}
            jqlPlaceholder="project = ABC AND issuetype = Theme"
            jqlHelperText="The query should return the themes themselves, not the work items underneath them."
          />

          <Inline space="space.200" alignBlock="end" shouldWrap>
            <Box xcss={monthsFieldStyles}>
              <Stack space="space.050">
                <Label labelFor="months-back">Months</Label>
                <Textfield
                  id="months-back"
                  type="number"
                  value={months}
                  onChange={(event) => setMonths(event.target.value)}
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
            The selected themes cover more issues than this report processes in one run, so some
            hours are missing. Narrow the filter or reduce the number of months.
          </Text>
        </SectionMessage>
      )}

      {report && (
        <Stack space="space.150">
          <Inline space="space.200" alignBlock="center" spread="space-between">
            <Inline space="space.100" alignBlock="center">
              <Strong>{report.sourceLabel}</Strong>
              <Lozenge appearance="inprogress">{`${report.themeCount} themes`}</Lozenge>
              <Lozenge appearance="default">{`${report.descendantCount} child issues`}</Lozenge>
              <Lozenge appearance="success">{`${grandTotalHours.toFixed(2)} h`}</Lozenge>
            </Inline>
            <CsvExport
              csv={csv}
              fileName="theme-report.csv"
              isDisabled={report.rows.length === 0}
            />
          </Inline>

          <Text color="color.text.subtle" size="small">
            Query: <Code>{report.jql}</Code>
          </Text>

          <DynamicTable
            head={tableHead}
            rows={tableRows}
            rowsPerPage={50}
            emptyView="That query did not return any themes."
          />
        </Stack>
      )}
    </Stack>
  );
};
