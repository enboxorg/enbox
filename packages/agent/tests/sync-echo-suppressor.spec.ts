import { describe, expect, it } from 'bun:test';

import { SyncEchoSuppressor } from '../src/sync-echo-suppressor.js';

const ALICE = 'did:example:alice';
const BOB = 'did:example:bob';
const FIRST_REMOTE = 'https://first.example.com';
const SECOND_REMOTE = 'https://second.example.com';

describe('SyncEchoSuppressor', () => {
  it('scopes both directions independently by tenant and remote endpoint', () => {
    const suppressor = new SyncEchoSuppressor();

    suppressor.trackPushed(ALICE, 'cid-1', FIRST_REMOTE);

    expect(suppressor.hasRecentlyPushed(ALICE, 'cid-1', FIRST_REMOTE)).toBe(true);
    expect(suppressor.hasRecentlyPulled(ALICE, 'cid-1', FIRST_REMOTE)).toBe(false);
    expect(suppressor.hasRecentlyPushed(BOB, 'cid-1', FIRST_REMOTE)).toBe(false);
    expect(suppressor.hasRecentlyPushed(ALICE, 'cid-1', SECOND_REMOTE)).toBe(false);

    suppressor.trackPulled(ALICE, 'cid-1', FIRST_REMOTE);

    expect(suppressor.hasRecentlyPulled(ALICE, 'cid-1', FIRST_REMOTE)).toBe(true);
    expect(suppressor.hasRecentlyPushed(ALICE, 'cid-1', FIRST_REMOTE)).toBe(true);
  });

  it('expires entries at the TTL boundary and refreshes a repeated transfer', () => {
    let now = 1_000;
    const suppressor = new SyncEchoSuppressor({
      now   : (): number => now,
      ttlMs : 100,
    });

    suppressor.trackPushed(ALICE, 'cid-1', FIRST_REMOTE);
    now = 1_050;
    suppressor.trackPushed(ALICE, 'cid-1', FIRST_REMOTE);
    now = 1_100;

    expect(suppressor.hasRecentlyPushed(ALICE, 'cid-1', FIRST_REMOTE)).toBe(true);

    now = 1_150;
    expect(suppressor.hasRecentlyPushed(ALICE, 'cid-1', FIRST_REMOTE)).toBe(false);
  });

  it('bounds each direction independently by evicting oldest entries first', () => {
    const suppressor = new SyncEchoSuppressor({ maxEntries: 3 });

    for (let index = 0; index < 5; index++) {
      suppressor.trackPushed(ALICE, `pushed-${index}`, FIRST_REMOTE);
    }
    for (let index = 0; index < 4; index++) {
      suppressor.trackPulled(ALICE, `pulled-${index}`, FIRST_REMOTE);
    }

    expect(suppressor.hasRecentlyPushed(ALICE, 'pushed-0', FIRST_REMOTE)).toBe(false);
    expect(suppressor.hasRecentlyPushed(ALICE, 'pushed-1', FIRST_REMOTE)).toBe(false);
    expect(suppressor.hasRecentlyPushed(ALICE, 'pushed-2', FIRST_REMOTE)).toBe(true);
    expect(suppressor.hasRecentlyPushed(ALICE, 'pushed-4', FIRST_REMOTE)).toBe(true);
    expect(suppressor.hasRecentlyPulled(ALICE, 'pulled-0', FIRST_REMOTE)).toBe(false);
    expect(suppressor.hasRecentlyPulled(ALICE, 'pulled-1', FIRST_REMOTE)).toBe(true);
    expect(suppressor.hasRecentlyPulled(ALICE, 'pulled-3', FIRST_REMOTE)).toBe(true);
  });

  it('clears both transfer directions together', () => {
    const suppressor = new SyncEchoSuppressor();
    suppressor.trackPulled(ALICE, 'pulled', FIRST_REMOTE);
    suppressor.trackPushed(ALICE, 'pushed', FIRST_REMOTE);

    suppressor.clear();

    expect(suppressor.hasRecentlyPulled(ALICE, 'pulled', FIRST_REMOTE)).toBe(false);
    expect(suppressor.hasRecentlyPushed(ALICE, 'pushed', FIRST_REMOTE)).toBe(false);
  });
});
