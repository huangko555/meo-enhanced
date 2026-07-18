import { launchTestBrowser } from './browser-test-helpers';

const browser = await launchTestBrowser();
try {
  console.log(`browser launch checks passed (${await browser.version()})`);
} finally {
  await browser.close();
}
