import { describe, expect, it } from 'bun:test';

describe('@enbox/agent subpath exports', () => {
  it('should expose Level-backed implementations from the level subpath', async () => {
    const levelExports = await import('../src/level.js');

    expect(levelExports.AgentDidResolverCache).toBeDefined();
    expect(levelExports.SyncEngineLevel).toBeDefined();
  });

  it('should expose test harness utilities from the test subpath', async () => {
    const testExports = await import('../src/test.js');

    expect(testExports.PlatformAgentTestHarness).toBeDefined();
  });
});
