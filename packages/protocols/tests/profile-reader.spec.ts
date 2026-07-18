import { describe, expect, expectTypeOf, it } from 'bun:test';

import type { DwnApi } from '@enbox/api/advanced';
import type { EnboxAnonymousApi } from '@enbox/api';

import type {
  ProfileReaderQueryRequest,
  ProfileReaderQueryResponse,
  ProfileReaderReadRequest,
  ProfileReaderReadResponse,
  ProfileReaderRecord,
  ProfileReaderRecordsSurface,
  ProfileReaderSource,
  ProfileReaderTimers,
  ProfileSnapshot,
} from '../src/profile-reader.js';

import { ProfileDefinition } from '../src/profile.js';
import { createProfileReader, isRetryableProfileReadStatus } from '../src/profile-reader.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain chained microtasks so awaited stub resolutions propagate. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await Promise.resolve();
  }
}

/** Poll a predicate across microtask drains without real timers. */
async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) {
      return;
    }
    await drainMicrotasks();
  }
  throw new Error(`waitUntil timed out: ${description}`);
}

/**
 * Deterministic clock implementing {@link ProfileReaderTimers}. `tick()`
 * advances time, firing due callbacks in order and draining microtasks
 * between them so retry rounds scheduled by one callback run to completion.
 */
class FakeClock implements ProfileReaderTimers {
  private _nowMs = 0;
  private _sequence = 0;
  private _scheduled: Array<{ id: number; at: number; callback: () => void }> = [];

  public now(): number {
    return this._nowMs;
  }

  public setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this._sequence;
    this._scheduled.push({ id, at: this._nowMs + delayMs, callback });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    this._scheduled = this._scheduled.filter((timer) => timer.id !== handle);
  }

  public async tick(ms: number): Promise<void> {
    const target = this._nowMs + ms;
    for (;;) {
      const due = this._scheduled
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) {
        break;
      }
      this._scheduled = this._scheduled.filter((timer) => timer.id !== due.id);
      this._nowMs = Math.max(this._nowMs, due.at);
      due.callback();
      await drainMicrotasks();
    }
    this._nowMs = target;
    await drainMicrotasks();
  }
}

function jsonRecord(data: unknown): ProfileReaderRecord {
  return {
    protocolPath : 'profile',
    dataFormat   : 'application/json',
    data         : {
      json : async (): Promise<unknown> => data,
      blob : async (): Promise<Blob> => new Blob([JSON.stringify(data)], { type: 'application/json' }),
    },
  };
}

function imageRecord(blob: Blob, protocolPath: string, options: { dataSize?: number; onBlobFetch?: () => void } = {}): ProfileReaderRecord {
  return {
    protocolPath,
    dataFormat : blob.type,
    dataSize   : options.dataSize ?? blob.size,
    data       : {
      json: async (): Promise<unknown> => {
        throw new Error('not json');
      },
      blob: async (): Promise<Blob> => {
        options.onBlobFetch?.();
        return blob;
      },
    },
  };
}

const OK = { code: 200, detail: 'OK' };
const NOT_FOUND = { code: 404, detail: 'Not Found' };

type QueryHandler = (request: ProfileReaderQueryRequest) => Promise<ProfileReaderQueryResponse>;
type ReadHandler = (request: ProfileReaderReadRequest) => Promise<ProfileReaderReadResponse>;

/**
 * Controllable records surface. Defaults: profile JSON found, images 404.
 * Tests can swap handlers per call site and inspect recorded requests.
 */
class FakeSurface implements ProfileReaderRecordsSurface {
  public queryCalls: ProfileReaderQueryRequest[] = [];
  public readCalls: ProfileReaderReadRequest[] = [];

  public queryHandler: QueryHandler;
  public readHandler: ReadHandler;

  constructor(profileData: unknown = { displayName: 'Alice' }, avatarBlob?: Blob) {
    this.queryHandler = async (): Promise<ProfileReaderQueryResponse> => ({
      status  : OK,
      records : [jsonRecord(profileData)],
    });
    this.readHandler = async (request): Promise<ProfileReaderReadResponse> => {
      if (avatarBlob !== undefined && request.filter.protocolPath === 'profile/avatar') {
        return { status: OK, record: imageRecord(avatarBlob, 'profile/avatar') };
      }
      return { status: NOT_FOUND };
    };
  }

  public async query(request: ProfileReaderQueryRequest): Promise<ProfileReaderQueryResponse> {
    this.queryCalls.push(request);
    return this.queryHandler(request);
  }

  public async read(request: ProfileReaderReadRequest): Promise<ProfileReaderReadResponse> {
    this.readCalls.push(request);
    return this.readHandler(request);
  }
}

const FAST_OPTIONS = {
  retryDelaysMs   : [250, 1000, 3000, 10000],
  negativeCacheMs : [1000, 5000, 30000],
  idleReleaseMs   : 300_000,
} as const;

const ALICE = 'did:example:alice';
const AVATAR_BLOB = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isRetryableProfileReadStatus', () => {
  it('should classify the production-tested retryable list plus 5xx as retryable', () => {
    for (const code of [401, 403, 408, 410, 425, 429, 500, 502, 503, 599]) {
      expect(isRetryableProfileReadStatus(code)).toBe(true);
    }
  });

  it('should classify other 4xx and success codes as not retryable', () => {
    for (const code of [200, 202, 400, 402, 404, 405, 409, 422, 451]) {
      expect(isRetryableProfileReadStatus(code)).toBe(false);
    }
  });
});

describe('createProfileReader', () => {
  describe('source compatibility', () => {
    it('should structurally accept a connected DwnApi and the Enbox.anonymous() result (compile-time)', () => {
      expectTypeOf<DwnApi>().toMatchTypeOf<ProfileReaderSource>();
      expectTypeOf<EnboxAnonymousApi>().toMatchTypeOf<ProfileReaderSource>();
    });
  });

  describe('source normalization', () => {
    it('should accept a bare records surface, a { records } object, and a { dwn: { records } } object', async () => {
      const clock = new FakeClock();
      for (const wrap of [
        (surface: FakeSurface): unknown => surface,
        (surface: FakeSurface): unknown => ({ records: surface }),
        (surface: FakeSurface): unknown => ({ dwn: { records: surface } }),
      ]) {
        const surface = new FakeSurface({ displayName: 'Alice' });
        const reader = createProfileReader(wrap(surface) as ProfileReaderRecordsSurface, { ...FAST_OPTIONS, timers: clock });
        const profile = await reader.get(ALICE);
        expect(profile.displayName).toBe('Alice');
        reader.dispose();
      }
    });

    it('should throw a descriptive error for an unsupported source shape', () => {
      expect(() => createProfileReader({} as ProfileReaderRecordsSurface)).toThrow('ProfileReader: unsupported source');
    });
  });

  describe('get()', () => {
    it('should resolve displayName and avatar for a wallet-shaped profile in eager mode using the documented fetch shape', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface({ displayName: 'Alice', bio: 'hi' }, AVATAR_BLOB);
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, images: 'eager', timers: clock });

      const profile = await reader.get(ALICE);

      expect(profile.did).toBe(ALICE);
      expect(profile.displayName).toBe('Alice');
      expect(profile.bio).toBe('hi');
      expect(profile.avatar).toBeInstanceOf(Blob);
      expect(profile.hero).toBeUndefined();

      // One query for the profile JSON + one read per image singleton.
      expect(surface.queryCalls).toHaveLength(1);
      expect(surface.queryCalls[0]).toEqual({
        from   : ALICE,
        filter : { protocol: ProfileDefinition.protocol, protocolPath: 'profile' },
      });
      expect(surface.readCalls.map((call) => call.filter.protocolPath).sort()).toEqual([
        'profile/avatar',
        'profile/hero',
      ]);

      const snapshot = reader.getSnapshot(ALICE);
      expect(snapshot?.status).toBe('settled');
      expect(snapshot?.profile.status).toBe('settled');
      expect(snapshot?.avatar.status).toBe('settled');
      expect(snapshot?.hero.status).toBe('not-found');
      reader.dispose();
    });

    it('should serve repeat get() calls for a settled profile from cache without refetching', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface({ displayName: 'Alice' });
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, images: 'eager', timers: clock });

      await reader.get(ALICE);
      const again = await reader.get(ALICE);

      expect(again.displayName).toBe('Alice');
      expect(surface.queryCalls).toHaveLength(1);
      expect(surface.readCalls).toHaveLength(2);
      reader.dispose();
    });

    it('should return a stable snapshot reference between changes', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface({ displayName: 'Alice' });
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      await reader.get(ALICE);
      const first = reader.getSnapshot(ALICE);
      const second = reader.getSnapshot(ALICE);
      expect(first).toBe(second as ProfileSnapshot);
      reader.dispose();
    });
  });

  describe('untrusted profile JSON sanitization', () => {
    it('should never let an injected did claim another identity — the requested DID is authoritative', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface({
        displayName : 'Mallory',
        did         : 'did:dht:attacker',
      });
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      const profile = await reader.get(ALICE);

      expect(profile.did).toBe(ALICE);
      expect(profile.displayName).toBe('Mallory');
      expect(Object.keys(profile).sort()).toEqual(['did', 'displayName']);
      reader.dispose();
    });

    it('should discard injected avatar/hero keys — images only come from their own records', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface({
        displayName : 'Alice',
        avatar      : 'https://evil.example/fake.png',
        hero        : { sneaky: true },
      });
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, images: 'eager', timers: clock });

      const profile = await reader.get(ALICE);

      // Images resolve only from the avatar/hero records (404 here).
      expect(profile.avatar).toBeUndefined();
      expect(profile.hero).toBeUndefined();
      expect(reader.getSnapshot(ALICE)?.profile.value).toEqual({ displayName: 'Alice' });
      reader.dispose();
    });

    it('should discard unknown properties from the profile JSON', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface({
        displayName : 'Alice',
        bio         : 'hi',
        isAdmin     : true,
        extra       : { deep: 'object' },
      });
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      const profile = await reader.get(ALICE);

      expect(Object.keys(profile).sort()).toEqual(['bio', 'did', 'displayName']);
      reader.dispose();
    });

    it('should drop allowlisted fields whose values are not strings', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface({
        displayName : 12345,
        bio         : ['not', 'a', 'string'],
        tagline     : { obj: true },
        location    : 'Berlin',
      });
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      const profile = await reader.get(ALICE);

      expect(profile.did).toBe(ALICE);
      expect(profile.displayName).toBeUndefined();
      expect(profile.bio).toBeUndefined();
      expect(profile.tagline).toBeUndefined();
      expect(profile.location).toBe('Berlin');
      expect(Object.keys(profile).sort()).toEqual(['did', 'location']);
      reader.dispose();
    });

    it('should fail the profile field terminally when the payload is not a JSON object', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface(['an', 'array']);
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      await expect(reader.get(ALICE)).rejects.toThrow('profile record data is not a JSON object');
      expect(reader.getSnapshot(ALICE)?.status).toBe('error');
      reader.dispose();
    });
  });

  describe('image loading modes', () => {
    it('should not fetch image bytes under the default lazy mode until loadImages() is called', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface({ displayName: 'Alice' }, AVATAR_BLOB);
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      const profile = await reader.get(ALICE);
      expect(profile.displayName).toBe('Alice');
      expect(profile.avatar).toBeUndefined();
      expect(surface.readCalls).toHaveLength(0);

      const snapshot = reader.getSnapshot(ALICE);
      expect(snapshot?.status).toBe('settled');
      expect(snapshot?.avatar.status).toBe('idle');
      expect(snapshot?.hero.status).toBe('idle');

      const images = await reader.loadImages(ALICE);
      expect(images.avatar).toBeInstanceOf(Blob);
      expect(images.hero).toBeUndefined();
      expect(surface.readCalls.map((call) => call.filter.protocolPath).sort()).toEqual([
        'profile/avatar',
        'profile/hero',
      ]);

      // Loaded images now appear in cached results and snapshots.
      const withImages = await reader.get(ALICE);
      expect(withImages.avatar).toBeInstanceOf(Blob);
      expect(reader.getSnapshot(ALICE)?.avatar.status).toBe('settled');
      expect(surface.readCalls).toHaveLength(2);
      reader.dispose();
    });

    it('should load images and profile together when loadImages() is called on a cold entry', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface({ displayName: 'Alice' }, AVATAR_BLOB);
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      const images = await reader.loadImages(ALICE);

      expect(images.avatar).toBeInstanceOf(Blob);
      expect(surface.queryCalls).toHaveLength(1);
      expect(reader.getSnapshot(ALICE)?.profile.value?.displayName).toBe('Alice');
      reader.dispose();
    });

    it('should throw from loadImages() when the reader was created with images: off', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface({ displayName: 'Alice' }, AVATAR_BLOB);
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, images: 'off', timers: clock });

      const profile = await reader.get(ALICE);
      expect(profile.avatar).toBeUndefined();
      expect(surface.readCalls).toHaveLength(0);
      await expect(reader.loadImages(ALICE)).rejects.toThrow('images: \'off\'');
      reader.dispose();
    });
  });

  describe('orphaned image suppression (missing root profile)', () => {
    it('should never fetch or return images when the root profile record is missing, even in eager mode', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface(undefined, AVATAR_BLOB);
      surface.queryHandler = async (): Promise<ProfileReaderQueryResponse> => ({ status: OK, records: [] });
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, images: 'eager', timers: clock });

      const profile = await reader.get(ALICE);

      // Orphaned avatar records exist on the surface, but without a root
      // profile the reader must not even issue the image reads.
      expect(profile).toEqual({ did: ALICE });
      expect(surface.readCalls).toHaveLength(0);

      const snapshot = reader.getSnapshot(ALICE);
      expect(snapshot?.status).toBe('not-found');
      expect(snapshot?.avatar.status).toBe('not-found');
      expect(snapshot?.hero.status).toBe('not-found');
      reader.dispose();
    });

    it('should resolve loadImages() with no images when the profile is missing', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface(undefined, AVATAR_BLOB);
      surface.queryHandler = async (): Promise<ProfileReaderQueryResponse> => ({ status: OK, records: [] });
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      const images = await reader.loadImages(ALICE);

      expect(images).toEqual({});
      expect(surface.readCalls).toHaveLength(0);
      expect(reader.getSnapshot(ALICE)?.status).toBe('not-found');
      reader.dispose();
    });
  });

  describe('image size validation', () => {
    it('should reject an image whose declared dataSize exceeds the protocol maximum without downloading it', async () => {
      const clock = new FakeClock();
      const avatarMax = ProfileDefinition.structure.profile.avatar.$size.max;
      let blobFetched = false;
      const surface = new FakeSurface({ displayName: 'Alice' });
      surface.readHandler = async (request): Promise<ProfileReaderReadResponse> => {
        if (request.filter.protocolPath === 'profile/avatar') {
          return {
            status : OK,
            record : imageRecord(AVATAR_BLOB, 'profile/avatar', {
              dataSize    : avatarMax + 1,
              onBlobFetch : () => {
                blobFetched = true;
              },
            }),
          };
        }
        return { status: NOT_FOUND };
      };
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, images: 'eager', timers: clock });

      const profile = await reader.get(ALICE);

      expect(profile.avatar).toBeUndefined();
      expect(blobFetched).toBe(false);
      const snapshot = reader.getSnapshot(ALICE);
      expect(snapshot?.avatar.status).toBe('error');
      expect(snapshot?.avatar.failure?.retryable).toBe(false);
      expect(snapshot?.avatar.failure?.message).toContain('declares');
      expect(snapshot?.avatar.failure?.message).toContain(`${avatarMax}`);
      reader.dispose();
    });

    it('should reject an image whose actual bytes exceed the protocol maximum after download', async () => {
      const clock = new FakeClock();
      const heroMax = ProfileDefinition.structure.profile.hero.$size.max;
      const oversized = new Blob([new Uint8Array(16).fill(1)], { type: 'image/png' });
      Object.defineProperty(oversized, 'size', { value: heroMax + 1 });
      const surface = new FakeSurface({ displayName: 'Alice' });
      surface.readHandler = async (request): Promise<ProfileReaderReadResponse> => {
        if (request.filter.protocolPath === 'profile/hero') {
          // Understated declared size sneaks past the pre-check; the
          // actual-bytes check must still reject.
          return { status: OK, record: imageRecord(oversized, 'profile/hero', { dataSize: 1024 }) };
        }
        return { status: NOT_FOUND };
      };
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, images: 'eager', timers: clock });

      const profile = await reader.get(ALICE);

      expect(profile.hero).toBeUndefined();
      const snapshot = reader.getSnapshot(ALICE);
      expect(snapshot?.hero.status).toBe('error');
      expect(snapshot?.hero.failure?.retryable).toBe(false);
      expect(snapshot?.hero.failure?.message).toContain('contains');
      reader.dispose();
    });
  });

  describe('image byte budget (LRU)', () => {
    it('should release the least-recently-used entries images when the budget is exceeded', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface();
      surface.queryHandler = async (request): Promise<ProfileReaderQueryResponse> => ({
        status  : OK,
        records : [jsonRecord({ displayName: request.from })],
      });
      surface.readHandler = async (request): Promise<ProfileReaderReadResponse> => {
        if (request.filter.protocolPath === 'profile/avatar') {
          return { status: OK, record: imageRecord(AVATAR_BLOB, 'profile/avatar') };
        }
        return { status: NOT_FOUND };
      };
      // Budget fits exactly one avatar blob.
      const reader = createProfileReader(surface, {
        ...FAST_OPTIONS,
        images          : 'eager',
        imageByteBudget : AVATAR_BLOB.size,
        timers          : clock,
      });

      const first = await reader.get('did:example:one');
      expect(first.avatar).toBeInstanceOf(Blob);
      expect(reader.getSnapshot('did:example:one')?.avatar.status).toBe('settled');

      // Loading a second DID's avatar evicts the first (LRU) under budget
      // pressure: its avatar field returns to idle, profile stays cached.
      const second = await reader.get('did:example:two');
      expect(second.avatar).toBeInstanceOf(Blob);
      const evicted = reader.getSnapshot('did:example:one');
      expect(evicted?.avatar.status).toBe('idle');
      expect(evicted?.avatar.value).toBeUndefined();
      expect(evicted?.profile.value?.displayName).toBe('did:example:one');
      expect(reader.getSnapshot('did:example:two')?.avatar.status).toBe('settled');

      // The evicted entry's images can be re-requested on demand.
      const reloaded = await reader.loadImages('did:example:one');
      expect(reloaded.avatar).toBeInstanceOf(Blob);
      expect(reader.getSnapshot('did:example:two')?.avatar.status).toBe('idle');
      reader.dispose();
    });
  });

  describe('not-found + negative cache', () => {
    it('should resolve a bare profile for a missing profile and honor the negative-cache ladder on repeat gets', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface();
      surface.queryHandler = async (): Promise<ProfileReaderQueryResponse> => ({ status: OK, records: [] });
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      const profile = await reader.get(ALICE);
      expect(profile).toEqual({ did: ALICE });
      expect(reader.getSnapshot(ALICE)?.status).toBe('not-found');
      expect(surface.queryCalls).toHaveLength(1);

      // Within the first window (1s): served from cache, no refetch.
      await reader.get(ALICE);
      expect(surface.queryCalls).toHaveLength(1);

      // Past the first window: revalidates once.
      await clock.tick(1000);
      await reader.get(ALICE);
      expect(surface.queryCalls).toHaveLength(2);

      // Still negative — the window steps up to 5s.
      await clock.tick(4999);
      await reader.get(ALICE);
      expect(surface.queryCalls).toHaveLength(2);
      await clock.tick(1);
      await reader.get(ALICE);
      expect(surface.queryCalls).toHaveLength(3);
      reader.dispose();
    });

    it('should reset the negative-cache ladder once the profile appears', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface();
      surface.queryHandler = async (): Promise<ProfileReaderQueryResponse> => ({ status: OK, records: [] });
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      await reader.get(ALICE);
      await clock.tick(1000);
      surface.queryHandler = async (): Promise<ProfileReaderQueryResponse> => ({ status: OK, records: [jsonRecord({ displayName: 'Alice' })] });
      const profile = await reader.get(ALICE);

      expect(profile.displayName).toBe('Alice');
      expect(reader.getSnapshot(ALICE)?.status).toBe('settled');

      // Settled entries are stable: no revalidation on later access.
      await clock.tick(60_000);
      await reader.get(ALICE);
      expect(surface.queryCalls).toHaveLength(2);
      reader.dispose();
    });
  });

  describe('retry ladder', () => {
    it('should retry retryable statuses on the ladder while gated images wait for the root profile', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface(undefined, AVATAR_BLOB);
      let queryAttempts = 0;
      surface.queryHandler = async (): Promise<ProfileReaderQueryResponse> => {
        queryAttempts += 1;
        if (queryAttempts <= 2) {
          return { status: { code: 429, detail: 'Too Many Requests' } };
        }
        return { status: OK, records: [jsonRecord({ displayName: 'Alice' })] };
      };
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, images: 'eager', timers: clock });

      const resultPromise = reader.get(ALICE);
      resultPromise.catch(() => { /* inspected below */ });

      // Attempt 1 fails (429); images are root-gated, so no reads yet.
      await waitUntil(() => queryAttempts === 1, 'first query attempt');
      const midFlight = reader.getSnapshot(ALICE);
      expect(midFlight?.status).toBe('loading');
      expect(midFlight?.avatar.status).toBe('loading');
      expect(surface.readCalls).toHaveLength(0);

      // Ladder step 1: +250ms → attempt 2 fails; step 2: +1000ms → attempt 3 succeeds.
      await clock.tick(250);
      expect(queryAttempts).toBe(2);
      await clock.tick(1000);
      expect(queryAttempts).toBe(3);

      const profile = await resultPromise;
      expect(profile.displayName).toBe('Alice');
      expect(profile.avatar).toBeInstanceOf(Blob);
      expect(reader.getSnapshot(ALICE)?.status).toBe('settled');
      reader.dispose();
    });

    it('should retry thrown transport errors', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface();
      let queryAttempts = 0;
      surface.queryHandler = async (): Promise<ProfileReaderQueryResponse> => {
        queryAttempts += 1;
        if (queryAttempts === 1) {
          throw new Error('network down');
        }
        return { status: OK, records: [jsonRecord({ displayName: 'Alice' })] };
      };
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      const resultPromise = reader.get(ALICE);
      await waitUntil(() => queryAttempts === 1, 'first query attempt');
      await clock.tick(250);

      const profile = await resultPromise;
      expect(profile.displayName).toBe('Alice');
      reader.dispose();
    });

    it('should reject get() and mark the entry error after exhausting the ladder', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface();
      let queryAttempts = 0;
      surface.queryHandler = async (): Promise<ProfileReaderQueryResponse> => {
        queryAttempts += 1;
        return { status: { code: 503, detail: 'Service Unavailable' } };
      };
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      const resultPromise = reader.get(ALICE);
      resultPromise.catch(() => { /* asserted below */ });

      await waitUntil(() => queryAttempts === 1, 'first query attempt');
      for (const delay of FAST_OPTIONS.retryDelaysMs) {
        await clock.tick(delay);
      }

      expect(queryAttempts).toBe(FAST_OPTIONS.retryDelaysMs.length + 1);
      await expect(resultPromise).rejects.toThrow(`ProfileReader: failed to load profile for '${ALICE}'`);

      const snapshot = reader.getSnapshot(ALICE);
      expect(snapshot?.status).toBe('error');
      expect(snapshot?.profile.failure?.code).toBe(503);
      expect(snapshot?.profile.failure?.retryable).toBe(true);
      reader.dispose();
    });

    it('should reject immediately on terminal statuses without retrying', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface();
      surface.queryHandler = async (): Promise<ProfileReaderQueryResponse> => ({ status: { code: 400, detail: 'Bad Request' } });
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      await expect(reader.get(ALICE)).rejects.toThrow('profile query failed with status 400');
      expect(surface.queryCalls).toHaveLength(1);

      const snapshot = reader.getSnapshot(ALICE);
      expect(snapshot?.status).toBe('error');
      expect(snapshot?.profile.failure?.retryable).toBe(false);

      // Error conclusions are negative-cached too: an immediate repeat get
      // rejects from cache without a new request.
      await expect(reader.get(ALICE)).rejects.toThrow();
      expect(surface.queryCalls).toHaveLength(1);
      reader.dispose();
    });

    it('should settle an image field with a terminal field error while keeping the entry settled', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface({ displayName: 'Alice' });
      surface.readHandler = async (request): Promise<ProfileReaderReadResponse> => {
        if (request.filter.protocolPath === 'profile/avatar') {
          return { status: { code: 400, detail: 'Bad Request' } };
        }
        return { status: NOT_FOUND };
      };
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, images: 'eager', timers: clock });

      const profile = await reader.get(ALICE);
      expect(profile.displayName).toBe('Alice');
      expect(profile.avatar).toBeUndefined();

      const snapshot = reader.getSnapshot(ALICE);
      expect(snapshot?.status).toBe('settled');
      expect(snapshot?.avatar.status).toBe('error');
      expect(snapshot?.avatar.failure?.code).toBe(400);
      reader.dispose();
    });
  });

  describe('watch()', () => {
    it('should emit the current snapshot on subscribe and settle the profile before the root-gated images', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface();
      const profileGate = deferred<void>();
      const avatarGate = deferred<void>();
      surface.queryHandler = async (): Promise<ProfileReaderQueryResponse> => {
        await profileGate.promise;
        return { status: OK, records: [jsonRecord({ displayName: 'Alice' })] };
      };
      surface.readHandler = async (request): Promise<ProfileReaderReadResponse> => {
        if (request.filter.protocolPath === 'profile/avatar') {
          await avatarGate.promise;
          return { status: OK, record: imageRecord(AVATAR_BLOB, 'profile/avatar') };
        }
        return { status: NOT_FOUND };
      };
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, images: 'eager', timers: clock });

      const seen: Array<{ status: string; profile: string; avatar: string }> = [];
      const unwatch = reader.watch([ALICE], (snapshot) => {
        seen.push({ status: snapshot.status, profile: snapshot.profile.status, avatar: snapshot.avatar.status });
      });

      // Initial emission: everything loading.
      expect(seen).toEqual([{ status: 'loading', profile: 'loading', avatar: 'loading' }]);

      // Name settles before the avatar: field-level settlement callback.
      profileGate.resolve();
      await waitUntil(() => seen.some((s) => s.profile === 'settled'), 'profile settlement');
      const profileSettled = seen.find((s) => s.profile === 'settled');
      expect(profileSettled?.avatar).toBe('loading');
      expect(profileSettled?.status).toBe('loading');

      avatarGate.resolve();
      await waitUntil(() => seen.some((s) => s.status === 'settled'), 'entry settlement');
      const last = seen[seen.length - 1];
      expect(last.avatar).toBe('settled');
      expect(last.status).toBe('settled');
      unwatch();
      reader.dispose();
    });

    it('should refcount subscriptions: a second watcher triggers no new fetch and sees the cached snapshot', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface({ displayName: 'Alice' });
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      const unwatchFirst = reader.watch([ALICE], () => { /* no-op */ });
      await waitUntil(() => reader.getSnapshot(ALICE)?.status === 'settled', 'first watcher settlement');
      const callsAfterFirst = surface.queryCalls.length;

      const secondSnapshots: ProfileSnapshot[] = [];
      const unwatchSecond = reader.watch([ALICE], (snapshot) => {
        secondSnapshots.push(snapshot);
      });

      expect(surface.queryCalls).toHaveLength(callsAfterFirst);
      expect(secondSnapshots).toHaveLength(1);
      expect(secondSnapshots[0].status).toBe('settled');
      expect(secondSnapshots[0].profile.value?.displayName).toBe('Alice');

      unwatchFirst();
      unwatchSecond();
      reader.dispose();
    });

    it('should finish notifying a stable watcher snapshot when a listener unsubscribes another listener', async () => {
      const clock = new FakeClock();
      const profileGate = deferred<void>();
      const surface = new FakeSurface();
      surface.queryHandler = async (): Promise<ProfileReaderQueryResponse> => {
        await profileGate.promise;
        return { status: OK, records: [jsonRecord({ displayName: 'Alice' })] };
      };
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });
      const deliveries: string[] = [];

      let unwatchSecond = (): void => { /* assigned after its initial emission */ };
      const unwatchFirst = reader.watch([ALICE], (snapshot) => {
        if (snapshot.status === 'settled') {
          deliveries.push('first');
          unwatchSecond();
        }
      });
      unwatchSecond = reader.watch([ALICE], (snapshot) => {
        if (snapshot.status === 'settled') {
          deliveries.push('second');
        }
      });

      profileGate.resolve();
      await waitUntil(() => deliveries.length === 2, 'stable watcher snapshot delivery');
      expect(deliveries).toEqual(['first', 'second']);

      const secondDeliveries = deliveries.filter((delivery) => delivery === 'second').length;
      await reader.loadImages(ALICE);
      expect(deliveries.filter((delivery) => delivery === 'second')).toHaveLength(secondDeliveries);

      unwatchFirst();
      unwatchSecond();
      reader.dispose();
    });

    it('should release an entry after the idle window once the last watcher unsubscribes', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface({ displayName: 'Alice' });
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      const unwatch = reader.watch([ALICE], () => { /* no-op */ });
      await waitUntil(() => reader.getSnapshot(ALICE)?.status === 'settled', 'settlement');

      unwatch();
      expect(reader.getSnapshot(ALICE)).toBeDefined();

      await clock.tick(FAST_OPTIONS.idleReleaseMs);
      expect(reader.getSnapshot(ALICE)).toBeUndefined();

      // A later get() refetches from scratch.
      await reader.get(ALICE);
      expect(surface.queryCalls).toHaveLength(2);
      reader.dispose();
    });

    it('should cancel the idle release when the DID is watched again before the window elapses', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface({ displayName: 'Alice' });
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      const unwatch = reader.watch([ALICE], () => { /* no-op */ });
      await waitUntil(() => reader.getSnapshot(ALICE)?.status === 'settled', 'settlement');
      unwatch();

      await clock.tick(FAST_OPTIONS.idleReleaseMs - 1);
      const rewatch = reader.watch([ALICE], () => { /* no-op */ });
      await clock.tick(FAST_OPTIONS.idleReleaseMs * 2);

      expect(reader.getSnapshot(ALICE)?.status).toBe('settled');
      expect(surface.queryCalls).toHaveLength(1);
      rewatch();
      reader.dispose();
    });

    it('should keep a still-subscribed watcher active when another unsubscribes twice', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface({ displayName: 'Alice' });
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      const unwatchFirst = reader.watch([ALICE], () => { /* no-op */ });
      reader.watch([ALICE], () => { /* no-op */ });
      await waitUntil(() => reader.getSnapshot(ALICE)?.status === 'settled', 'settlement');

      unwatchFirst();
      unwatchFirst(); // Idempotent: must not double-decrement the refcount.

      await clock.tick(FAST_OPTIONS.idleReleaseMs * 2);
      expect(reader.getSnapshot(ALICE)?.status).toBe('settled');
      reader.dispose();
    });
  });

  describe('bounded concurrency', () => {
    it('should cap concurrent per-DID fetch rounds at the configured limit', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface();
      const gates = new Map<string, Deferred<void>>();
      surface.queryHandler = async (request): Promise<ProfileReaderQueryResponse> => {
        const gate = deferred<void>();
        gates.set(request.from, gate);
        await gate.promise;
        return { status: OK, records: [jsonRecord({ displayName: request.from })] };
      };
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, concurrency: 2, timers: clock });

      const dids = ['did:example:1', 'did:example:2', 'did:example:3', 'did:example:4'];
      const unwatch = reader.watch(dids, () => { /* no-op */ });
      await waitUntil(() => surface.queryCalls.length === 2, 'first two rounds start');

      // Two rounds hold the only slots; the other two DIDs are queued.
      await drainMicrotasks();
      expect(surface.queryCalls).toHaveLength(2);

      // Completing one round frees a slot for the third DID.
      gates.get(surface.queryCalls[0].from)?.resolve();
      await waitUntil(() => surface.queryCalls.length === 3, 'third round starts');
      expect(surface.queryCalls).toHaveLength(3);

      for (const gate of gates.values()) {
        gate.resolve();
      }
      await waitUntil(() => surface.queryCalls.length === 4, 'fourth round starts');
      for (const gate of gates.values()) {
        gate.resolve();
      }
      await waitUntil(() => dids.every((did) => reader.getSnapshot(did)?.status === 'settled'), 'all settle');
      unwatch();
      reader.dispose();
    });
  });

  describe('dispose()', () => {
    it('should reject pending gets and loadImages, drop entries, and refuse further use', async () => {
      const clock = new FakeClock();
      const surface = new FakeSurface();
      surface.queryHandler = async (): Promise<ProfileReaderQueryResponse> => {
        await deferred<void>().promise; // Never resolves.
        return { status: OK };
      };
      const reader = createProfileReader(surface, { ...FAST_OPTIONS, timers: clock });

      const pending = reader.get(ALICE);
      pending.catch(() => { /* asserted below */ });
      const pendingImages = reader.loadImages(ALICE);
      pendingImages.catch(() => { /* asserted below */ });
      await waitUntil(() => surface.queryCalls.length === 1, 'fetch starts');

      reader.dispose();
      await expect(pending).rejects.toThrow('ProfileReader: disposed');
      await expect(pendingImages).rejects.toThrow('ProfileReader: disposed');
      expect(reader.getSnapshot(ALICE)).toBeUndefined();
      expect(() => reader.watch([ALICE], () => { /* no-op */ })).toThrow('ProfileReader: instance has been disposed');
      await expect(reader.get(ALICE)).rejects.toThrow('ProfileReader: instance has been disposed');
    });
  });
});
