import { describe, expect, it } from 'bun:test';

import { openView } from '../src/view-opening.js';

describe('openView', () => {
  it('preserves the opening error when cleanup also fails', async () => {
    const openError = new Error('open failed');
    let closeCalls = 0;

    const opening = openView({
      close: async (): Promise<void> => {
        closeCalls += 1;
        throw new Error('close failed');
      },
      open: async (): Promise<void> => { throw openError; },
    }, []);

    await expect(opening).rejects.toBe(openError);
    expect(closeCalls).toBe(1);
  });
});
