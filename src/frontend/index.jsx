import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Heading,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from '@forge/react';
import { view } from '@forge/bridge';

import { DailyReport } from './DailyReport';
import { ThemeReport } from './ThemeReport';

/**
 * The app shell. It owns the one piece of state both reports need — the URL of
 * the Jira site we are running on — and puts each report on its own tab so they
 * can share a single global page (and therefore a single manifest module).
 */
const App = () => {
  const [siteUrl, setSiteUrl] = useState('');

  // The app is sandboxed in an iframe, so links must be absolute.
  // `view.getContext()` tells us which Jira site the app is currently running on.
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

  return (
    <Box padding="space.200">
      <Stack space="space.200">
        {/* Jira renders the page title for us (layout: native), so we only add a
            short subtitle here rather than repeating the heading. */}
        <Heading as="h2" size="medium">
          Worklog reports
        </Heading>

        <Tabs id="time-report-tabs">
          <TabList>
            <Tab>Daily by person</Tab>
            <Tab>Themes by month</Tab>
          </TabList>
          <TabPanel>
            <Box paddingBlockStart="space.200">
              <DailyReport issueUrl={issueUrl} />
            </Box>
          </TabPanel>
          <TabPanel>
            <Box paddingBlockStart="space.200">
              <ThemeReport issueUrl={issueUrl} />
            </Box>
          </TabPanel>
        </Tabs>
      </Stack>
    </Box>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
