/**
 * Profile reader — a read/cache layer for OTHER users' public profiles.
 *
 * Apps repeatedly need the same thing: given a DID, fetch the owner's
 * published Profile protocol data (displayName + avatar/hero images) from
 * their DWN, cache it, retry transient failures, and expose the result to
 * UI code without every app hand-rolling settlement/retry/negative-cache
 * machinery.
 *
 * The reader implements the fetch shape that works against wallet-written
 * profiles:
 *
 * - one `RecordsQuery` (`{ from: did, filter: { protocol, protocolPath: 'profile' } }`)
 *   for the published profile JSON singleton, and
 * - direct `RecordsRead`s for the `profile/avatar` and `profile/hero`
 *   singletons — wallets write these UNPUBLISHED, so queries cannot see
 *   them, but their `{ who: 'anyone', can: ['read'] }` rules make a direct
 *   read succeed (a `RecordsRead` is authorization-gated, not
 *   publication-gated).
 *
 * Sources: works over a connected records surface (a `DwnApi` from
 * `@enbox/api/advanced`, or any compatible `{ query, read }` object) and
 * over the anonymous reader returned by `Enbox.anonymous()` — see
 * {@link ProfileReaderSource}.
 *
 * Images are exposed as `Blob`s. The reader deliberately does NOT mint
 * object URLs (`URL.createObjectURL`): revocation is tied to the consuming
 * component's lifecycle, which the framework layer owns — a reader-owned
 * URL would either leak or be revoked while still on screen. Bind
 * `avatar`/`hero` Blobs to object URLs in the framework binding and revoke
 * them when the consuming component unmounts.
 *
 * No framework dependencies, in-memory cache only, instance-scoped state.
 *
 * @module
 */

import type { RecordsFilter } from '@enbox/dwn-sdk-js';

import type { ProfileData } from './profile.js';

import { ProfileDefinition } from './profile.js';

// ---------------------------------------------------------------------------
// Source (structural) types
// ---------------------------------------------------------------------------

/**
 * Minimal record shape the profile reader needs from a records surface.
 *
 * Both `Record` (connected `DwnApi`) and `ReadOnlyRecord`
 * (`Enbox.anonymous()`) satisfy this structurally.
 */
export type ProfileReaderRecord = {
  /** Protocol path of the record (e.g. `'profile'`). */
  protocolPath?: string;
  /** MIME type of the record data. */
  dataFormat?: string;
  /** Data accessors. Reading may perform a network fetch for non-inlined data. */
  data: {
    blob(): Promise<Blob>;
    json(): Promise<unknown>;
  };
};

/** Status of a DWN reply as surfaced by the records surfaces. */
export type ProfileReaderReplyStatus = {
  code: number;
  detail?: string;
};

/** Request for a records query against a remote DWN. */
export type ProfileReaderQueryRequest = {
  /** The DID whose DWN is queried. */
  from: string;
  /** Filter criteria for the query. */
  filter: RecordsFilter;
};

/** Response of a records query. */
export type ProfileReaderQueryResponse = {
  status: ProfileReaderReplyStatus;
  records?: readonly ProfileReaderRecord[];
};

/** Request for a records read against a remote DWN. */
export type ProfileReaderReadRequest = {
  /** The DID whose DWN is read from. */
  from: string;
  /** Filter identifying the record. */
  filter: RecordsFilter;
};

/** Response of a records read. */
export type ProfileReaderReadResponse = {
  status: ProfileReaderReplyStatus;
  record?: ProfileReaderRecord;
};

/**
 * The minimal records surface the reader fetches through.
 *
 * Satisfied by `DwnApi.records` (connected, `@enbox/api/advanced`) and
 * `DwnReaderApi.records` (anonymous) without adapters.
 */
export type ProfileReaderRecordsSurface = {
  query(request: ProfileReaderQueryRequest): Promise<ProfileReaderQueryResponse>;
  read(request: ProfileReaderReadRequest): Promise<ProfileReaderReadResponse>;
};

/**
 * Accepted `source` shapes for {@link createProfileReader}:
 *
 * - a bare records surface (`{ query, read }`),
 * - an object exposing `records` — a connected `DwnApi` instance
 *   (`import { DwnApi } from '@enbox/api/advanced'`) or a `DwnReaderApi`,
 * - an object exposing `dwn.records` — the `Enbox.anonymous()` result.
 *
 * All requests carry an explicit `from` DID, so any surface that can read
 * a remote DWN works; whether messages are signed (connected) or unsigned
 * (anonymous) is the surface's concern. Published profiles and
 * anyone-read avatars resolve identically either way.
 */
export type ProfileReaderSource =
  | ProfileReaderRecordsSurface
  | { records: ProfileReaderRecordsSurface }
  | { dwn: { records: ProfileReaderRecordsSurface } };

// ---------------------------------------------------------------------------
// Snapshot / result types
// ---------------------------------------------------------------------------

/** Settlement status of a single profile field (JSON, avatar, or hero). */
export type ProfileFieldStatus = 'loading' | 'settled' | 'not-found' | 'error';

/**
 * Aggregate status of a profile entry.
 *
 * Derived from the field statuses with the precedence:
 * profile `error` → `'error'`; profile `not-found` → `'not-found'`;
 * any field still `loading` → `'loading'`; otherwise `'settled'`.
 * Image-field failures do NOT fail the entry — the per-field snapshot
 * carries the failure while text fields stay usable.
 */
export type ProfileEntryStatus = 'loading' | 'settled' | 'not-found' | 'error';

/** A terminal or in-progress failure descriptor for a field. */
export type ProfileReaderFailure = {
  /** Whether the failure class is retryable (transport error or retryable status code). */
  retryable: boolean;
  /** DWN reply status code, when the failure came from a reply rather than a thrown error. */
  code?: number;
  /** Human-readable failure summary. */
  message: string;
  /** The thrown error, when the failure was a transport-level exception. */
  cause?: unknown;
};

/** Immutable per-field state exposed on snapshots. */
export type ProfileFieldSnapshot<T> = {
  status: ProfileFieldStatus;
  /** The settled value, present when `status` is `'settled'`. */
  value?: T;
  /** The most recent failure, present when `status` is `'error'`. */
  failure?: ProfileReaderFailure;
};

/**
 * Immutable snapshot of a cached profile entry.
 *
 * A new snapshot object is produced on every change, so the reference is
 * stable between changes — safe to feed `useSyncExternalStore`-style
 * bindings directly.
 */
export type ProfileSnapshot = {
  did: string;
  status: ProfileEntryStatus;
  profile: ProfileFieldSnapshot<ProfileData>;
  avatar: ProfileFieldSnapshot<Blob>;
  hero: ProfileFieldSnapshot<Blob>;
};

/**
 * The resolved public profile returned by {@link ProfileReader.get}.
 *
 * Text fields come from the profile JSON singleton; `avatar`/`hero` are
 * raw image Blobs (object-URL creation is the caller's job — see the
 * module docs for why).
 */
export type PublicProfile = Partial<ProfileData> & {
  did: string;
  avatar?: Blob;
  hero?: Blob;
};

/** Listener invoked with a fresh {@link ProfileSnapshot} on every entry change. */
export type ProfileWatchListener = (snapshot: ProfileSnapshot) => void;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Injectable timer/clock facade so hosts and tests control time.
 * Defaults to `globalThis.setTimeout`/`clearTimeout` and `Date.now`.
 */
export type ProfileReaderTimers = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
};

/** Options for {@link createProfileReader}. */
export type ProfileReaderOptions = {
  /**
   * Maximum number of DIDs fetched concurrently (each DID's fetch round
   * issues its query/reads in parallel within the slot). Defaults to `4`.
   */
  concurrency?: number;
  /**
   * Delays (ms) between retry attempts for retryable failures, per field.
   * The ladder length bounds the retries: `retryDelaysMs.length + 1` total
   * attempts. Defaults to `[250, 1000, 3000, 10000]`.
   */
  retryDelaysMs?: readonly number[];
  /**
   * Revalidation windows (ms) for negative conclusions (`not-found` or
   * `error`). While the current window is fresh, repeated `get()`/`watch()`
   * calls serve the cached conclusion without refetching; once elapsed, the
   * next access revalidates. Consecutive negative conclusions step up the
   * ladder; the last window repeats. Revalidation is access-driven — the
   * reader never polls on its own. Defaults to `[1000, 5000, 30000]`.
   */
  negativeCacheMs?: readonly number[];
  /**
   * Idle time (ms) after the last watcher unsubscribes (or a one-shot
   * `get()` concludes) before the entry — including its image Blobs — is
   * released from the cache. Defaults to `300000` (5 minutes).
   */
  idleReleaseMs?: number;
  /** Timer/clock override, primarily for tests. */
  timers?: ProfileReaderTimers;
};

// ---------------------------------------------------------------------------
// Reader interface
// ---------------------------------------------------------------------------

/**
 * A caching reader for other users' public profiles.
 *
 * Create instances with {@link createProfileReader}. All state is
 * instance-scoped; dispose long-lived instances with
 * {@link ProfileReader.dispose} when the owning context shuts down.
 */
export type ProfileReader = {
  /**
   * Fetch (or serve from cache) the public profile for `did`.
   *
   * Resolves once every field has concluded (settled, not found, or
   * failed). A missing profile resolves to a bare `{ did }`; image-field
   * failures resolve without that image. Rejects only when the profile
   * JSON field fails terminally — so callers can distinguish "has no
   * profile" from "could not fetch".
   */
  get(did: string): Promise<PublicProfile>;

  /**
   * Subscribe to profile snapshots for a set of DIDs.
   *
   * Subscriptions are refcounted per DID: a second watcher of an
   * already-cached DID triggers no new fetch. The listener is invoked
   * once per DID with the current snapshot on subscribe, then on every
   * field settlement (name may arrive before images). After the last
   * watcher of a DID unsubscribes, the entry is released after the idle
   * window.
   *
   * @returns An idempotent unsubscribe function.
   */
  watch(dids: readonly string[], listener: ProfileWatchListener): () => void;

  /**
   * Read the current snapshot for `did` synchronously without triggering
   * a fetch. Returns `undefined` for DIDs never requested (or already
   * released). The returned reference only changes when the entry
   * changes, matching `useSyncExternalStore` expectations.
   */
  getSnapshot(did: string): ProfileSnapshot | undefined;

  /**
   * Release all cached entries and cancel all timers. Pending `get()`
   * promises reject. Further `get()`/`watch()` calls throw.
   */
  dispose(): void;
};

// ---------------------------------------------------------------------------
// Retryability classification
// ---------------------------------------------------------------------------

/**
 * Reply status codes classified as retryable, alongside all 5xx codes and
 * thrown transport errors: auth/tenancy hiccups (401, 403), timeouts
 * (408), gone-but-racing (410), too-early (425), and rate limiting (429).
 */
const RETRYABLE_STATUS_CODES = new Set([401, 403, 408, 410, 425, 429]);

/**
 * Whether a DWN reply status code is worth retrying.
 *
 * Retryable: 401, 403, 408, 410, 425, 429, and all 5xx. Everything else
 * (e.g. 400) is terminal. 404 is handled contextually by the reader
 * (record absence, not a failure).
 */
export function isRetryableProfileReadStatus(code: number): boolean {
  return RETRYABLE_STATUS_CODES.has(code) || code >= 500;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const PROFILE_PROTOCOL_URI = ProfileDefinition.protocol;

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [250, 1000, 3000, 10000];
const DEFAULT_NEGATIVE_CACHE_MS: readonly number[] = [1000, 5000, 30000];
const DEFAULT_IDLE_RELEASE_MS = 300_000;

type ProfileFieldKey = 'profile' | 'avatar' | 'hero';

const FIELD_KEYS: readonly ProfileFieldKey[] = ['profile', 'avatar', 'hero'];

/** Field key → protocol path of the record it reads. */
const FIELD_PROTOCOL_PATHS: Record<ProfileFieldKey, string> = {
  profile : 'profile',
  avatar  : 'profile/avatar',
  hero    : 'profile/hero',
};

type FieldValue = ProfileData | Blob;

type MutableFieldState = {
  status: ProfileFieldStatus;
  value?: FieldValue;
  failure?: ProfileReaderFailure;
  /** Attempts made in the current fetch sequence. */
  attempts: number;
  /** Due time of the next retry attempt, when one is scheduled. */
  nextAttemptAt?: number;
};

type WatchHandle = {
  listener: ProfileWatchListener;
};

type Waiter = {
  resolve: (profile: PublicProfile) => void;
  reject: (error: Error) => void;
};

type CacheEntry = {
  did: string;
  fields: Record<ProfileFieldKey, MutableFieldState>;
  snapshot: ProfileSnapshot;
  watchers: Set<WatchHandle>;
  waiters: Waiter[];
  /** True while a fetch round is queued or in flight. */
  fetchQueued: boolean;
  /** True once the entry has been evicted; in-flight work becomes a no-op. */
  evicted: boolean;
  retryTimer?: unknown;
  idleTimer?: unknown;
  /** Timestamp of the most recent full conclusion. */
  concludedAt?: number;
  /** Whether the most recent conclusion was negative (not-found / error). */
  lastOutcomeNegative: boolean;
  /** Index into the negative-cache ladder for the current window. */
  negativeStep: number;
};

/** Outcome of a single field fetch attempt. */
type FieldOutcome =
  | { kind: 'settled'; value: FieldValue }
  | { kind: 'not-found' }
  | { kind: 'failure'; failure: ProfileReaderFailure };

const DEFAULT_TIMERS: ProfileReaderTimers = {
  setTimeout   : (callback, delayMs): unknown => globalThis.setTimeout(callback, delayMs),
  clearTimeout : (handle): void => globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
  now          : (): number => Date.now(),
};

/**
 * Unref a Node/Bun timer handle when supported so pure-housekeeping timers
 * (idle release) never keep a process alive. Retry timers are NOT unref'd:
 * they drive pending work that `get()` callers await.
 */
function unrefIfSupported(handle: unknown): void {
  if (handle !== null && typeof handle === 'object' && 'unref' in handle && typeof (handle as { unref: unknown }).unref === 'function') {
    (handle as { unref(): void }).unref();
  }
}

function resolveRecordsSurface(source: ProfileReaderSource): ProfileReaderRecordsSurface {
  const bare = source as Partial<ProfileReaderRecordsSurface>;
  if (typeof bare.query === 'function' && typeof bare.read === 'function') {
    return bare as ProfileReaderRecordsSurface;
  }

  const withRecords = source as Partial<{ records: ProfileReaderRecordsSurface }>;
  if (withRecords.records !== undefined) {
    return withRecords.records;
  }

  const withDwn = source as Partial<{ dwn: { records: ProfileReaderRecordsSurface } }>;
  if (withDwn.dwn?.records !== undefined) {
    return withDwn.dwn.records;
  }

  throw new Error(
    'ProfileReader: unsupported source — expected a records surface ({ query, read }), ' +
    'an object with a `records` property (DwnApi / DwnReaderApi), or an Enbox.anonymous() result ({ dwn }).'
  );
}

function isSuccessCode(code: number): boolean {
  return code >= 200 && code <= 299;
}

/**
 * Build the immutable snapshot for an entry's current field states.
 *
 * Aggregate status precedence: profile `error` wins, then profile
 * `not-found`, then any still-`loading` field, then `settled`. See
 * {@link ProfileEntryStatus}.
 */
function buildSnapshot(did: string, fields: Record<ProfileFieldKey, MutableFieldState>): ProfileSnapshot {
  const toFieldSnapshot = <T>(field: MutableFieldState): ProfileFieldSnapshot<T> => ({
    status  : field.status,
    value   : field.value as T | undefined,
    failure : field.status === 'error' ? field.failure : undefined,
  });

  let status: ProfileEntryStatus;
  if (fields.profile.status === 'error') {
    status = 'error';
  } else if (fields.profile.status === 'not-found') {
    status = 'not-found';
  } else if (FIELD_KEYS.some((key) => fields[key].status === 'loading')) {
    status = 'loading';
  } else {
    status = 'settled';
  }

  return {
    did,
    status,
    profile : toFieldSnapshot<ProfileData>(fields.profile),
    avatar  : toFieldSnapshot<Blob>(fields.avatar),
    hero    : toFieldSnapshot<Blob>(fields.hero),
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class DwnProfileReader implements ProfileReader {
  private readonly _surface: ProfileReaderRecordsSurface;
  private readonly _concurrency: number;
  private readonly _retryDelaysMs: readonly number[];
  private readonly _negativeCacheMs: readonly number[];
  private readonly _idleReleaseMs: number;
  private readonly _timers: ProfileReaderTimers;

  private readonly _entries = new Map<string, CacheEntry>();
  private _disposed = false;

  /** Semaphore state: active fetch rounds + FIFO queue of waiting rounds. */
  private _activeRounds = 0;
  private readonly _roundQueue: Array<() => void> = [];

  constructor(source: ProfileReaderSource, options: ProfileReaderOptions = {}) {
    this._surface = resolveRecordsSurface(source);
    this._concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this._retryDelaysMs = [...(options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS)];
    this._negativeCacheMs = [...(options.negativeCacheMs ?? DEFAULT_NEGATIVE_CACHE_MS)];
    this._idleReleaseMs = options.idleReleaseMs ?? DEFAULT_IDLE_RELEASE_MS;
    this._timers = options.timers ?? DEFAULT_TIMERS;

    if (this._negativeCacheMs.length === 0) {
      throw new Error('ProfileReader: negativeCacheMs must contain at least one window.');
    }
  }

  public async get(did: string): Promise<PublicProfile> {
    this.assertNotDisposed();

    const entry = this.ensureEntry(did);
    this.cancelIdleTimer(entry);
    this.activate(entry);

    if (this.isConcluded(entry) && !entry.fetchQueued) {
      // Cache hit (fresh positive conclusion, or negative within its window).
      this.armIdleTimerIfQuiescent(entry);
      if (entry.fields.profile.status === 'error') {
        throw this.buildProfileError(entry);
      }
      return this.buildPublicProfile(entry);
    }

    return new Promise<PublicProfile>((resolve, reject) => {
      entry.waiters.push({ resolve, reject });
    });
  }

  public watch(dids: readonly string[], listener: ProfileWatchListener): () => void {
    this.assertNotDisposed();

    const handle: WatchHandle = { listener };
    const watched = [...new Set(dids)];

    for (const did of watched) {
      const entry = this.ensureEntry(did);
      this.cancelIdleTimer(entry);
      // Activate before registering the handle so a synchronous
      // revalidation reset is not delivered twice to the new watcher.
      this.activate(entry);
      entry.watchers.add(handle);
    }

    // Initial emission: current snapshot for each DID.
    for (const did of watched) {
      const entry = this._entries.get(did);
      if (entry !== undefined) {
        this.notifyWatcher(handle, entry.snapshot);
      }
    }

    let closed = false;
    return (): void => {
      if (closed) {
        return;
      }
      closed = true;
      for (const did of watched) {
        const entry = this._entries.get(did);
        if (entry === undefined) {
          continue;
        }
        entry.watchers.delete(handle);
        if (entry.watchers.size === 0) {
          this.armIdleTimerIfQuiescent(entry);
        }
      }
    };
  }

  public getSnapshot(did: string): ProfileSnapshot | undefined {
    return this._entries.get(did)?.snapshot;
  }

  public dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;

    for (const entry of this._entries.values()) {
      entry.evicted = true;
      this.cancelIdleTimer(entry);
      this.cancelRetryTimer(entry);
      const waiters = entry.waiters.splice(0);
      for (const waiter of waiters) {
        waiter.reject(new Error(`ProfileReader: disposed while loading profile for '${entry.did}'.`));
      }
    }
    this._entries.clear();
    this._roundQueue.length = 0;
  }

  // -------------------------------------------------------------------------
  // Entry lifecycle
  // -------------------------------------------------------------------------

  private assertNotDisposed(): void {
    if (this._disposed) {
      throw new Error('ProfileReader: instance has been disposed.');
    }
  }

  private ensureEntry(did: string): CacheEntry {
    const existing = this._entries.get(did);
    if (existing !== undefined) {
      return existing;
    }

    const fields: CacheEntry['fields'] = {
      profile : { status: 'loading', attempts: 0 },
      avatar  : { status: 'loading', attempts: 0 },
      hero    : { status: 'loading', attempts: 0 },
    };
    const entry: CacheEntry = {
      did,
      fields,
      snapshot            : buildSnapshot(did, fields),
      watchers            : new Set(),
      waiters             : [],
      fetchQueued         : false,
      evicted             : false,
      lastOutcomeNegative : false,
      negativeStep        : 0,
    };
    this._entries.set(did, entry);
    return entry;
  }

  /**
   * Ensure the entry is being fetched, or revalidate a stale negative
   * conclusion. Fresh conclusions (positive always; negative within the
   * current window) are served from cache with no request.
   */
  private activate(entry: CacheEntry): void {
    if (entry.fetchQueued || entry.retryTimer !== undefined) {
      return; // Fetch sequence already in progress.
    }

    if (!this.isConcluded(entry)) {
      // Newly created (or reset) entry with no round queued yet.
      this.startRound(entry);
      return;
    }

    if (!entry.lastOutcomeNegative) {
      return; // Positive conclusions are stable until the entry is released.
    }

    const windowIndex = Math.min(entry.negativeStep, this._negativeCacheMs.length - 1);
    const windowMs = this._negativeCacheMs[windowIndex];
    const age = this._timers.now() - (entry.concludedAt ?? 0);
    if (age < windowMs) {
      return; // Negative conclusion still fresh — serve from cache.
    }

    // Revalidate: refetch only the fields that concluded negatively.
    for (const key of FIELD_KEYS) {
      const field = entry.fields[key];
      if (field.status === 'not-found' || field.status === 'error') {
        field.status = 'loading';
        field.failure = undefined;
        field.attempts = 0;
        field.nextAttemptAt = undefined;
      }
    }
    this.publish(entry);
    this.startRound(entry);
  }

  private isConcluded(entry: CacheEntry): boolean {
    return FIELD_KEYS.every((key) => entry.fields[key].status !== 'loading');
  }

  // -------------------------------------------------------------------------
  // Fetch rounds
  // -------------------------------------------------------------------------

  private startRound(entry: CacheEntry): void {
    entry.fetchQueued = true;
    void this.runRound(entry);
  }

  private async runRound(entry: CacheEntry): Promise<void> {
    await this.acquireRoundSlot();
    try {
      if (entry.evicted || this._disposed) {
        return;
      }
      const now = this._timers.now();
      const dueFields = FIELD_KEYS.filter((key) => {
        const field = entry.fields[key];
        return field.status === 'loading' && (field.nextAttemptAt === undefined || field.nextAttemptAt <= now);
      });
      await Promise.all(dueFields.map((key) => this.attemptField(entry, key)));
    } finally {
      this.releaseRoundSlot();
    }

    entry.fetchQueued = false;
    this.afterRound(entry);
  }

  private async acquireRoundSlot(): Promise<void> {
    if (this._activeRounds < this._concurrency) {
      this._activeRounds += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this._roundQueue.push(resolve);
    });
    this._activeRounds += 1;
  }

  private releaseRoundSlot(): void {
    this._activeRounds -= 1;
    const next = this._roundQueue.shift();
    if (next !== undefined) {
      next();
    }
  }

  /** After a round: conclude the entry, or arm the retry timer for pending fields. */
  private afterRound(entry: CacheEntry): void {
    if (entry.evicted || this._disposed) {
      return;
    }

    if (this.isConcluded(entry)) {
      this.concludeEntry(entry);
      return;
    }

    const pendingDueTimes = FIELD_KEYS
      .map((key) => entry.fields[key])
      .filter((field) => field.status === 'loading' && field.nextAttemptAt !== undefined)
      .map((field) => field.nextAttemptAt as number);

    if (pendingDueTimes.length === 0) {
      // Defensive: a loading field with no scheduled retry should not
      // happen; conclude it as a terminal error rather than hanging.
      for (const key of FIELD_KEYS) {
        const field = entry.fields[key];
        if (field.status === 'loading') {
          field.status = 'error';
          field.failure = { retryable: false, message: 'ProfileReader: field fetch ended without outcome.' };
        }
      }
      this.publish(entry);
      this.concludeEntry(entry);
      return;
    }

    const delay = Math.max(0, Math.min(...pendingDueTimes) - this._timers.now());
    this.cancelRetryTimer(entry);
    entry.retryTimer = this._timers.setTimeout(() => {
      entry.retryTimer = undefined;
      if (!entry.evicted && !this._disposed) {
        this.startRound(entry);
      }
    }, delay);
  }

  private concludeEntry(entry: CacheEntry): void {
    entry.concludedAt = this._timers.now();

    const negative = entry.snapshot.status === 'not-found' || entry.snapshot.status === 'error';
    if (negative) {
      entry.negativeStep = entry.lastOutcomeNegative
        ? Math.min(entry.negativeStep + 1, this._negativeCacheMs.length - 1)
        : 0;
    } else {
      entry.negativeStep = 0;
    }
    entry.lastOutcomeNegative = negative;

    const waiters = entry.waiters.splice(0);
    if (entry.fields.profile.status === 'error') {
      const error = this.buildProfileError(entry);
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    } else {
      for (const waiter of waiters) {
        waiter.resolve(this.buildPublicProfile(entry));
      }
    }

    this.armIdleTimerIfQuiescent(entry);
  }

  // -------------------------------------------------------------------------
  // Field fetch + retry ladder
  // -------------------------------------------------------------------------

  private async attemptField(entry: CacheEntry, key: ProfileFieldKey): Promise<void> {
    const field = entry.fields[key];
    field.attempts += 1;
    field.nextAttemptAt = undefined;

    let outcome: FieldOutcome;
    try {
      outcome = key === 'profile'
        ? await this.fetchProfileJson(entry.did)
        : await this.fetchImage(entry.did, key);
    } catch (error: unknown) {
      outcome = {
        kind    : 'failure',
        failure : {
          retryable : true,
          message   : `transport error: ${error instanceof Error ? error.message : String(error)}`,
          cause     : error,
        },
      };
    }

    if (entry.evicted || this._disposed) {
      return;
    }

    if (outcome.kind === 'settled') {
      field.status = 'settled';
      field.value = outcome.value;
      field.failure = undefined;
      this.publish(entry);
      return;
    }

    if (outcome.kind === 'not-found') {
      field.status = 'not-found';
      field.value = undefined;
      field.failure = undefined;
      this.publish(entry);
      return;
    }

    field.failure = outcome.failure;
    if (outcome.failure.retryable && field.attempts <= this._retryDelaysMs.length) {
      // Stay 'loading'; the next round picks the field up at its due time.
      field.nextAttemptAt = this._timers.now() + this._retryDelaysMs[field.attempts - 1];
      return;
    }

    field.status = 'error';
    this.publish(entry);
  }

  private async fetchProfileJson(did: string): Promise<FieldOutcome> {
    const { status, records } = await this._surface.query({
      from   : did,
      filter : { protocol: PROFILE_PROTOCOL_URI, protocolPath: FIELD_PROTOCOL_PATHS.profile },
    });

    if (!isSuccessCode(status.code)) {
      return this.failureFromStatus('profile query', status);
    }

    const record = records?.[0];
    if (record === undefined) {
      return { kind: 'not-found' };
    }

    const data = await record.data.json();
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return {
        kind    : 'failure',
        failure : { retryable: false, message: 'profile record data is not a JSON object' },
      };
    }

    return { kind: 'settled', value: data as ProfileData };
  }

  private async fetchImage(did: string, key: 'avatar' | 'hero'): Promise<FieldOutcome> {
    const { status, record } = await this._surface.read({
      from   : did,
      filter : { protocol: PROFILE_PROTOCOL_URI, protocolPath: FIELD_PROTOCOL_PATHS[key] },
    });

    if (status.code === 404) {
      return { kind: 'not-found' };
    }
    if (!isSuccessCode(status.code)) {
      return this.failureFromStatus(`${key} read`, status);
    }
    if (record === undefined) {
      return { kind: 'not-found' };
    }

    const value = await record.data.blob();
    return { kind: 'settled', value };
  }

  private failureFromStatus(operation: string, status: ProfileReaderReplyStatus): FieldOutcome {
    return {
      kind    : 'failure',
      failure : {
        retryable : isRetryableProfileReadStatus(status.code),
        code      : status.code,
        message   : `${operation} failed with status ${status.code}${status.detail !== undefined ? `: ${status.detail}` : ''}`,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Snapshots + notification
  // -------------------------------------------------------------------------

  private publish(entry: CacheEntry): void {
    entry.snapshot = buildSnapshot(entry.did, entry.fields);
    for (const handle of [...entry.watchers]) {
      this.notifyWatcher(handle, entry.snapshot);
    }
  }

  private notifyWatcher(handle: WatchHandle, snapshot: ProfileSnapshot): void {
    try {
      handle.listener(snapshot);
    } catch (error: unknown) {
      console.warn(`ProfileReader: watch listener threw for '${snapshot.did}'`, error);
    }
  }

  private buildPublicProfile(entry: CacheEntry): PublicProfile {
    const profileData = entry.fields.profile.value as ProfileData | undefined;
    const result: PublicProfile = { did: entry.did, ...profileData };
    const avatar = entry.fields.avatar.value as Blob | undefined;
    const hero = entry.fields.hero.value as Blob | undefined;
    if (avatar !== undefined) {
      result.avatar = avatar;
    }
    if (hero !== undefined) {
      result.hero = hero;
    }
    return result;
  }

  private buildProfileError(entry: CacheEntry): Error {
    const failure = entry.fields.profile.failure;
    return new Error(
      `ProfileReader: failed to load profile for '${entry.did}': ${failure?.message ?? 'unknown failure'}`,
      { cause: failure?.cause ?? failure },
    );
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  private cancelIdleTimer(entry: CacheEntry): void {
    if (entry.idleTimer !== undefined) {
      this._timers.clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  private cancelRetryTimer(entry: CacheEntry): void {
    if (entry.retryTimer !== undefined) {
      this._timers.clearTimeout(entry.retryTimer);
      entry.retryTimer = undefined;
    }
  }

  /**
   * Arm the idle-release countdown when nothing holds the entry: no
   * watchers, no pending `get()` waiters, and no fetch activity. Re-arming
   * restarts the countdown.
   */
  private armIdleTimerIfQuiescent(entry: CacheEntry): void {
    if (entry.evicted || this._disposed) {
      return;
    }
    if (entry.watchers.size > 0 || entry.waiters.length > 0 || entry.fetchQueued || entry.retryTimer !== undefined) {
      return;
    }
    this.cancelIdleTimer(entry);
    const handle = this._timers.setTimeout(() => {
      entry.idleTimer = undefined;
      this.evict(entry);
    }, this._idleReleaseMs);
    entry.idleTimer = handle;
    unrefIfSupported(handle);
  }

  private evict(entry: CacheEntry): void {
    if (entry.watchers.size > 0 || entry.waiters.length > 0 || entry.fetchQueued) {
      return; // Re-referenced since the timer was armed; keep the entry.
    }
    entry.evicted = true;
    this.cancelRetryTimer(entry);
    this.cancelIdleTimer(entry);
    this._entries.delete(entry.did);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a {@link ProfileReader} over a records source.
 *
 * @param source - A records surface, a `DwnApi`/`DwnReaderApi`-shaped
 *   object, or an `Enbox.anonymous()` result. See {@link ProfileReaderSource}.
 * @param options - Cache/retry tuning; see {@link ProfileReaderOptions}.
 *
 * @example
 * ```ts
 * import { Enbox } from '@enbox/api';
 * import { createProfileReader } from '@enbox/protocols';
 *
 * const reader = createProfileReader(Enbox.anonymous());
 *
 * const { displayName, avatar } = await reader.get('did:dht:alice...');
 *
 * const unwatch = reader.watch([aliceDid, bobDid], (snapshot) => {
 *   render(snapshot.did, snapshot.profile.value?.displayName, snapshot.avatar.value);
 * });
 * // later
 * unwatch();
 * ```
 */
export function createProfileReader(source: ProfileReaderSource, options?: ProfileReaderOptions): ProfileReader {
  return new DwnProfileReader(source, options);
}
