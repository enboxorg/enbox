import { describe, expect, it } from 'bun:test';

import { AgentSession } from '@enbox/agent';

import { AgentSession as AuthAgentSession } from '../src/index.js';
import { AgentSession as BrowserAgentSession } from '../src/browser.js';

describe('canonical session exports', () => {
  it('should expose the agent session class through both auth entrypoints', () => {
    expect(AuthAgentSession).toBe(AgentSession);
    expect(BrowserAgentSession).toBe(AgentSession);
  });
});
