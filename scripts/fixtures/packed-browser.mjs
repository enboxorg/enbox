import * as browser from '@enbox/browser';
import { AgentSession } from '@enbox/agent';

// Keep both entrypoints reachable while checking the published browser bundle.
globalThis.packedBrowserExports = { exports: Object.keys(browser), AgentSession };
