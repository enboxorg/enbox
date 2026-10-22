import type { BrowserConnectHandler as BrowserConnectHandlerFactory } from '../src/browser-connect-handler.js';
import type { ConnectModalOptions } from '../src/ui/connect-modal.js';
import type { ConnectResult } from '@enbox/connect';

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const runConnectModal = mock(async (_options: ConnectModalOptions): Promise<ConnectResult | undefined> => undefined);
mock.module('../src/ui/connect-modal.js', () => ({ runConnectModal }));
let BrowserConnectHandler: typeof BrowserConnectHandlerFactory;

describe('BrowserConnectHandler request-time location', () => {
  let originalWindow: PropertyDescriptor | undefined;

  beforeAll(async (): Promise<void> => {
    ({ BrowserConnectHandler } = await import('../src/browser-connect-handler.js'));
  });

  beforeEach((): void => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    runConnectModal.mockClear();
  });

  afterEach((): void => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window');
    } else {
      Object.defineProperty(globalThis, 'window', originalWindow);
    }
  });

  it('should create a handler before browser globals exist', (): void => {
    Reflect.deleteProperty(globalThis, 'window');

    expect(() => BrowserConnectHandler({ appIcon: '/icons/app.svg' })).not.toThrow();
    expect(runConnectModal).not.toHaveBeenCalled();
  });

  it('should resolve relative icons against an opaque document URL', async (): Promise<void> => {
    Object.defineProperty(globalThis, 'window', {
      configurable : true,
      value        : { location: { origin: 'null', href: 'file:///opt/native-app/index.html' } },
    });
    const handler = BrowserConnectHandler({ appIcon: 'icons/app.svg' });

    await handler.requestAccess({ permissionRequests: [] });

    expect(runConnectModal).toHaveBeenCalledTimes(1);
    expect(runConnectModal.mock.calls[0][0].appIcon).toBe('file:///opt/native-app/icons/app.svg');
  });
});
