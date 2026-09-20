import { join } from 'node:path';
import { PkarrPublicationJournal } from '../src/pkarr-publication-journal.js';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';

describe('PkarrPublicationJournal', () => {
  it('should retain exact packet bytes and 64-bit sequence precision after reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-pkarr-journal-'));
    const location = join(directory, 'journal.sqlite');
    const packet = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    const sequence = 0x7fff_ffff_ffff_fff0n;

    const first = new PkarrPublicationJournal(location);
    first.set({
      acceptedAt : '2026-09-20T12:00:00.000Z',
      identifier : 'key-one',
      packet,
      sequence,
    });
    first.close();

    const reopened = new PkarrPublicationJournal(location);
    try {
      expect(reopened.get('key-one')).toEqual({
        acceptedAt : '2026-09-20T12:00:00.000Z',
        identifier : 'key-one',
        packet,
        sequence,
      });
    } finally {
      reopened.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
