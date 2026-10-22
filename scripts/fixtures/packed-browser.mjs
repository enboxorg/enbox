import * as browser from '@enbox/browser';
import { AgentSession } from '@enbox/agent';

if (browser.AgentSession !== AgentSession) {
  throw new Error('browser entry points expose different session classes');
}
globalThis.packedBrowserExports = Object.keys(browser);
