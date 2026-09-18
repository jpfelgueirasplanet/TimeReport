import React, { useCallback, useState } from 'react';
import {
  Box,
  Button,
  CodeBlock,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  Stack,
  Strong,
  Text,
} from '@forge/react';

/**
 * Escapes a single CSV field: wraps it in quotes and doubles any quotes inside.
 *
 * @param {string|number|null} value
 * @returns {string}
 */
export function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Turns a header row and a list of value rows into CSV text.
 *
 * Both reports build their own matrix from the same column definitions they
 * use for the on-screen table, which is what keeps the export and the table
 * from ever drifting apart.
 *
 * @param {string[]} header the column labels
 * @param {Array<Array<string|number|null>>} rows one array of values per row
 * @returns {string}
 */
export function buildCsv(header, rows) {
  const lines = [header.map(csvCell).join(',')];

  for (const row of rows) {
    lines.push(row.map(csvCell).join(','));
  }

  return lines.join('\r\n');
}

/**
 * The "Export to CSV" button plus the modal it opens.
 *
 * Forge apps are sandboxed and cannot write files to the user's computer, so
 * instead of triggering a download we show the CSV in a `CodeBlock`, which
 * comes with its own copy button.
 *
 * @param {object} props
 * @param {string} props.csv the CSV text to display
 * @param {string} props.fileName the name we suggest the user saves it as
 * @param {boolean} props.isDisabled whether there is anything to export
 */
export const CsvExport = ({ csv, fileName, isDisabled }) => {
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);

  return (
    <Box>
      <Button iconBefore="download" onClick={() => setIsOpen(true)} isDisabled={isDisabled}>
        Export to CSV
      </Button>

      <ModalTransition>
        {isOpen && (
          <Modal onClose={close} width="x-large">
            <ModalHeader>
              <ModalTitle>CSV export</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Stack space="space.100">
                <Text>
                  Forge apps cannot write files to your computer, so copy the CSV below and save it
                  as <Strong>{fileName}</Strong>. Use the copy button in the corner of the code
                  block.
                </Text>
                <CodeBlock language="text" text={csv} />
              </Stack>
            </ModalBody>
            <ModalFooter>
              <Button appearance="primary" onClick={close}>
                Close
              </Button>
            </ModalFooter>
          </Modal>
        )}
      </ModalTransition>
    </Box>
  );
};
