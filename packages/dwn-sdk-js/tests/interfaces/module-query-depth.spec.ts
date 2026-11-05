import type { RecordsFilter } from '../../src/types/records-types.js';

import { RecordsCount } from '../../src/interfaces/records-count.js';
import { RecordsQuery } from '../../src/interfaces/records-query.js';
import { RecordsSubscribe } from '../../src/interfaces/records-subscribe.js';
import { describe, expect, it } from 'bun:test';

describe('Module query physical depth', () => {
  const parsers = [
    async (filter: RecordsFilter): Promise<void> => { await RecordsQuery.parse((await RecordsQuery.create({ filter })).message); },
    async (filter: RecordsFilter): Promise<void> => { await RecordsCount.parse((await RecordsCount.create({ filter })).message); },
    async (filter: RecordsFilter): Promise<void> => { await RecordsSubscribe.parse((await RecordsSubscribe.create({ filter })).message); },
  ];

  it('accepts physical contexts deeper than the declared path in query, count and subscribe', async () => {
    for (const parse of parsers) {
      await parse({ module: 'https://example.com/modules/comments', modulePath: 'note/comment', contextId: 'workspace/note/comment' });
    }
  });

  it('rejects contexts beyond the shared depth bound even for root or unfiltered paths', async () => {
    for (const parse of parsers) {
      for (const modulePath of [undefined, 'note', 'note/comment']) {
        await expect(parse({
          module    : 'https://example.com/modules/comments',
          modulePath,
          contextId : Array.from({ length: 11 }, (_, index): string => `record${index}`).join('/'),
        })).rejects.toThrow('contextId exceeds 10 physical levels');
      }
    }
  });
});
