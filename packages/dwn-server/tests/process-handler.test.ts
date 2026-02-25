import type { Dwn } from '@enbox/dwn-sdk-js';

import { Poller } from '@enbox/dwn-sdk-js';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { config } from '../src/config.js';
import { DwnServer } from '../src/dwn-server.js';
import { getTestDwn } from './test-dwn.js';

describe('Process Handlers', () => {
  let dwn: Dwn;
  let dwnServer: DwnServer;
  let processExitStub: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    ({ dwn } = await getTestDwn());
    dwnServer = new DwnServer({ dwn, config: { ...config, port: 0 } });
    await dwnServer.start();
    processExitStub = spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(async () => {
    await dwnServer.stop();
    processExitStub.mockRestore();
  });

  it('should stop when SIGINT is emitted', async () => {
    process.emit('SIGINT');

    Poller.pollUntilSuccessOrTimeout(async () => {
      expect(dwnServer.serverState).toBe(0); // DwnServerState.Stopped
      expect(processExitStub).not.toHaveBeenCalled(); // Ensure process.exit is not called
    });
  });

  it('should stop when SIGTERM is emitted', async () => {
    process.emit('SIGTERM');

    Poller.pollUntilSuccessOrTimeout(async () => {
      expect(dwnServer.serverState).toBe(0); // DwnServerState.Stopped
      expect(processExitStub).not.toHaveBeenCalled(); // Ensure process.exit is not called
    });
  });

  it('should log an error for an unhandled rejection', async () => {
    const consoleErrorStub = spyOn(console, 'error').mockImplementation(() => {});
    const reason = 'Test unhandled rejection reason';
    const promise = Promise.resolve();

    process.emit('unhandledRejection', reason, promise);

    expect(consoleErrorStub).toHaveBeenCalledTimes(1);
    const callArgs = consoleErrorStub.mock.calls[0];
    expect(callArgs[0]).toContain('Unhandled promise rejection');
    expect(callArgs[0]).toContain(reason);

    consoleErrorStub.mockRestore();
  });

  it('should log an error for an uncaught exception', async () => {

    // IMPORTANT: this test is a bit tricky to write because
    // existing process `uncaughtException` listener/handler will result will trigger an error when we force an `uncaughtException` event
    // causing the test to fail. So we need to remove the existing listener and add them back after the test.
    // To be in full control of the test, we also create the DWN server (which adds it's own `uncaughtException` listener)
    // AFTER removing the existing listener.
    await dwnServer.stop();

    // storing then removing existing listeners and adding back at the very end of the test
    const existingUncaughtExceptionListeners = [...process.listeners('uncaughtException')];
    process.removeAllListeners('uncaughtException');

    dwnServer = new DwnServer({ dwn, config: { ...config, port: 0 } });
    await dwnServer.start();

    const consoleErrorStub = spyOn(console, 'error').mockImplementation(() => {}); // Stub console.error
    const errorMessage = 'Test uncaught exception';
    const error = new Error(errorMessage);
    process.emit('uncaughtException', error);

    // Ensure console.error was called with the expected error message
    console.log('console.error call count', consoleErrorStub.mock.calls.length);
    expect(consoleErrorStub).toHaveBeenCalledTimes(1);

    // Restore the original console.error
    consoleErrorStub.mockRestore();

    // add back original listeners
    existingUncaughtExceptionListeners.forEach(listener => process.on('uncaughtException', listener));
  });
});
