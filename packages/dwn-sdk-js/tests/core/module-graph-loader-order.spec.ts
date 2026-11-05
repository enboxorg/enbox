import type { ModuleDefinition } from '../../src/types/modules-types.js';

import { describe, expect, it } from 'bun:test';

import { preloadModuleDefinitions } from '../../src/core/module-graph-loader.js';

describe('module definition loading order', () => {
  it('bounds fetches and stops at the first canonical dependency failure', async () => {
    const first = 'https://example.com/loading/a-first';
    const later = 'https://example.com/loading/z-later';
    const root: ModuleDefinition = {
      module    : 'https://example.com/loading/root', published : true,
      uses      : { later, first }, types     : {}, structure : {},
    };
    const failure = new Error('dependency read failed');
    const fetched: string[] = [];
    let active = 0;
    let maximumActive = 0;

    await expect(preloadModuleDefinitions(root, async (module): Promise<ModuleDefinition> => {
      fetched.push(module);
      maximumActive = Math.max(maximumActive, ++active);
      try {
        await Promise.resolve();
        if (module === first) {
          throw failure;
        }
        return { module, published: true, types: {}, structure: {} };
      } finally {
        active--;
      }
    })).rejects.toBe(failure);

    expect(fetched).toEqual([first]);
    expect(maximumActive).toBe(1);
  });
});
