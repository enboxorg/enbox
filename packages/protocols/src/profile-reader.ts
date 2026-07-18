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
 * Trust boundary: profile JSON comes from ANOTHER user's DWN and is
 * untrusted input. The reader validates it against a strict allowlist of
 * the Profile protocol's text fields, discards everything else, and always
 * assigns the authoritative requested DID and the separately-fetched image
 * Blobs after the JSON-derived fields — a profile record cannot claim a
 * different `did` or inject fake `avatar`/`hero` values.
 *
 * Image fields are fetched only after the root profile JSON record is
 * confirmed to exist. Deleting a profile without pruning leaves orphaned
 * avatar/hero records behind; the reader suppresses those (a missing
 * profile resolves to a bare `{ did }`). Wallets deleting a profile should
 * pass `prune: true` on the root `RecordsDelete` to remove the images too.
 *
 * Images default to LAZY loading ({@link ProfileReaderOptions.images}):
 * `get()`/`watch()` settle the text profile without downloading image
 * bytes, and callers opt in per DID via {@link ProfileReader.loadImages}.
 * Retained image Blobs are bounded by an LRU byte budget
 * ({@link ProfileReaderOptions.imageByteBudget}); least-recently-used
 * entries' images are released under pressure and can be re-requested.
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
  /**
   * Declared size of the record data in bytes, when known. Used to reject
   * over-budget image records BEFORE downloading their bytes.
   */
  dataSize?: number;
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

/**
 * Settlement status of a single profile field (JSON, avatar, or hero).
 *
 * `'idle'` means the field has not been requested: image fields under
 * `images: 'lazy'` before {@link ProfileReader.loadImages} is called,
 * under `images: 'off'` always, and images released under
 * {@link ProfileReaderOptions.imageByteBudget} pressure.
 */
export type ProfileFieldStatus = 'idle' | 'loading' | 'settled' | 'not-found' | 'error';

/**
 * Aggregate status of a profile entry.
 *
 * Derived from the field statuses with the precedence:
 * profile `error` → `'error'`; profile `not-found` → `'not-found'`;
 * any field still `loading` → `'loading'`; otherwise `'settled'`.
 * Image-field failures do NOT fail the entry — the per-field snapshot
 * carries the failure while text fields stay usable — and `'idle'` image
 * fields do not keep an entry in `'loading'`.
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
 *
 * The profile field value is `Partial<ProfileData>`: it contains only the
 * allowlisted Profile protocol text fields that validated as strings —
 * unknown or wrong-typed properties from the remote JSON are discarded.
 */
export type ProfileSnapshot = {
  did: string;
  status: ProfileEntryStatus;
  profile: ProfileFieldSnapshot<Partial<ProfileData>>;
  avatar: ProfileFieldSnapshot<Blob>;
  hero: ProfileFieldSnapshot<Blob>;
};

/**
 * The resolved public profile returned by {@link ProfileReader.get}.
 *
 * Text fields come from the profile JSON singleton after allowlist
 * validation; `avatar`/`hero` are raw image Blobs fetched separately from
 * their own records (object-URL creation is the caller's job — see the
 * module docs for why). The `did` is always the DID that was requested —
 * never a value from the fetched JSON.
 */
export type PublicProfile = Partial<ProfileData> & {
  did: string;
  avatar?: Blob;
  hero?: Blob;
};

/** Image Blobs resolved by {@link ProfileReader.loadImages}. */
export type ProfileImages = {
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

/**
 * Image loading policy for {@link createProfileReader}.
 *
 * - `'lazy'` (default) — `get()`/`watch()` settle the text profile without
 *   downloading image bytes; call {@link ProfileReader.loadImages} to
 *   fetch a DID's images on demand.
 * - `'eager'` — images are fetched automatically once the root profile
 *   record is confirmed to exist.
 * - `'off'` — images are never fetched; `loadImages()` throws.
 */
export type ProfileReaderImagesMode = 'eager' | 'lazy' | 'off';

/** Options for {@link createProfileReader}. */
export type ProfileReaderOptions = {
  /**
   * Maximum number of DIDs fetched concurrently (each DID's fetch round
   * issues its requests within the slot). Defaults to `4`.
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
  /**
   * Image loading policy. Defaults to `'lazy'` — a protocol-valid
   * avatar + hero pair can weigh ~36 MiB, so images are only downloaded
   * when explicitly requested. See {@link ProfileReaderImagesMode}.
   */
  images?: ProfileReaderImagesMode;
  /**
   * Maximum total bytes of image Blobs retained across all cached entries.
   * When a newly stored image pushes the total over the budget, the
   * least-recently-used entries' images are released (their image fields
   * return to `'idle'` and can be re-requested via `loadImages()`); the
   * text profile stays cached. The budget is soft in one case: the most
   * recently stored entry's images are always retained even if they alone
   * exceed it. Defaults to `134217728` (128 MiB).
   */
  imageByteBudget?: number;
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
   * Resolves once every requested field has concluded (settled, not
   * found, or failed). A missing profile resolves to a bare `{ did }` —
   * without images, even when orphaned avatar/hero records exist. Under
   * the default `images: 'lazy'` policy the result contains no images
   * until {@link ProfileReader.loadImages} has loaded them. Rejects only
   * when the profile JSON field fails terminally — so callers can
   * distinguish "has no profile" from "could not fetch".
   */
  get(did: string): Promise<PublicProfile>;

  /**
   * Load the avatar/hero image Blobs for `did` on demand.
   *
   * Ensures the profile entry is active, fetches the images once the root
   * profile record is confirmed to exist, and resolves with whatever
   * images settled (image-field failures resolve without that image, like
   * `get()`). Resolves `{}` when the profile is missing — orphaned image
   * records without a root profile are never returned. Under
   * `images: 'eager'` this simply awaits the automatic image settlement.
   * Throws when the reader was created with `images: 'off'`.
   */
  loadImages(did: string): Promise<ProfileImages>;

  /**
   * Subscribe to profile snapshots for a set of DIDs.
   *
   * Subscriptions are refcounted per DID: a second watcher of an
   * already-cached DID triggers no new fetch. The listener is invoked
   * once per DID with the current snapshot on subscribe, then on every
   * field settlement (the text profile settles before images, which are
   * only fetched after the root profile is confirmed). After the last
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
   * Release all cached entries and cancel all timers. Pending `get()` and
   * `loadImages()` promises reject. Further calls throw.
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
// Untrusted-JSON sanitization
// ---------------------------------------------------------------------------

/**
 * The exhaustive allowlist of Profile protocol text fields. Everything
 * else in a fetched profile JSON — including `did`, `avatar`, `hero`, or
 * any unknown key — is discarded.
 */
const PROFILE_TEXT_FIELDS = ['displayName', 'bio', 'tagline', 'location', 'website', 'pronouns'] as const;

/**
 * Validate untrusted profile JSON from a remote DWN.
 *
 * Returns `undefined` when the payload is not a plain JSON object.
 * Otherwise returns a fresh object containing ONLY the allowlisted
 * {@link ProfileData} fields whose values are strings; wrong-typed values
 * and unknown properties are discarded. The result can never carry `did`,
 * `avatar`, `hero`, or any other injected key.
 */
function sanitizeProfileData(data: unknown): Partial<ProfileData> | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return undefined;
  }

  const source = data as Record<string, unknown>;
  const sanitized: Partial<ProfileData> = {};
  for (const key of PROFILE_TEXT_FIELDS) {
    const value = source[key];
    if (typeof value === 'string') {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const PROFILE_PROTOCOL_URI = ProfileDefinition.protocol;

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [250, 1000, 3000, 10000];
const DEFAULT_NEGATIVE_CACHE_MS: readonly number[] = [1000, 5000, 30000];
const DEFAULT_IDLE_RELEASE_MS = 300_000;
const DEFAULT_IMAGE_BYTE_BUDGET = 134_217_728; // 128 MiB

type ProfileFieldKey = 'profile' | 'avatar' | 'hero';
type ImageFieldKey = 'avatar' | 'hero';

const FIELD_KEYS: readonly ProfileFieldKey[] = ['profile', 'avatar', 'hero'];
const IMAGE_FIELD_KEYS: readonly ImageFieldKey[] = ['avatar', 'hero'];

/** Field key → protocol path of the record it reads. */
const FIELD_PROTOCOL_PATHS: Record<ProfileFieldKey, string> = {
  profile : 'profile',
  avatar  : 'profile/avatar',
  hero    : 'profile/hero',
};

/** Image field → maximum data size the Profile protocol allows for it. */
const IMAGE_MAX_BYTES: Record<ImageFieldKey, number> = {
  avatar : ProfileDefinition.structure.profile.avatar.$size.max,
  hero   : ProfileDefinition.structure.profile.hero.$size.max,
};

type FieldValue = Partial<ProfileData> | Blob;

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

type ImageWaiter = {
  resolve: (images: ProfileImages) => void;
  reject: (error: Error) => void;
};

type CacheEntry = {
  did: string;
  fields: Record<ProfileFieldKey, MutableFieldState>;
  snapshot: ProfileSnapshot;
  watchers: Set<WatchHandle>;
  waiters: Waiter[];
  imageWaiters: ImageWaiter[];
  /** Whether `loadImages()` has requested this entry's images (lazy mode). */
  imagesRequested: boolean;
  /** Total bytes of image Blobs currently retained for this entry. */
  imageBytes: number;
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
 * `not-found`, then any still-`loading` field, then `settled` (`'idle'`
 * fields never hold an entry in `'loading'`). See
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
    profile : toFieldSnapshot<Partial<ProfileData>>(fields.profile),
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
  private readonly _imagesMode: ProfileReaderImagesMode;
  private readonly _imageByteBudget: number;
  private readonly _timers: ProfileReaderTimers;

  private readonly _entries = new Map<string, CacheEntry>();
  private _disposed = false;

  /** Semaphore state: active fetch rounds + FIFO queue of waiting rounds. */
  private _activeRounds = 0;
  private readonly _roundQueue: Array<() => void> = [];

  /** LRU over entries that currently retain image Blobs (oldest first). */
  private readonly _imageLru = new Map<string, CacheEntry>();
  private _retainedImageBytes = 0;

  constructor(source: ProfileReaderSource, options: ProfileReaderOptions = {}) {
    this._surface = resolveRecordsSurface(source);
    this._concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this._retryDelaysMs = [...(options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS)];
    this._negativeCacheMs = [...(options.negativeCacheMs ?? DEFAULT_NEGATIVE_CACHE_MS)];
    this._idleReleaseMs = options.idleReleaseMs ?? DEFAULT_IDLE_RELEASE_MS;
    this._imagesMode = options.images ?? 'lazy';
    this._imageByteBudget = Math.max(0, options.imageByteBudget ?? DEFAULT_IMAGE_BYTE_BUDGET);
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
      this.touchImageLru(entry);
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

  public async loadImages(did: string): Promise<ProfileImages> {
    this.assertNotDisposed();
    if (this._imagesMode === 'off') {
      throw new Error('ProfileReader: loadImages() is unavailable — this reader was created with images: \'off\'.');
    }

    const entry = this.ensureEntry(did);
    this.cancelIdleTimer(entry);
    entry.imagesRequested = true;
    this.activate(entry);

    // Promote idle image fields to loading only while the root profile is
    // present or still being resolved — a concluded-missing profile means
    // no images (orphaned image records are never surfaced).
    const profileStatus = entry.fields.profile.status;
    if (profileStatus === 'settled' || profileStatus === 'loading') {
      let promoted = false;
      for (const key of IMAGE_FIELD_KEYS) {
        const field = entry.fields[key];
        if (field.status === 'idle') {
          field.status = 'loading';
          field.failure = undefined;
          field.attempts = 0;
          field.nextAttemptAt = undefined;
          promoted = true;
        }
      }
      if (promoted) {
        this.publish(entry);
      }
      if (!this.isConcluded(entry) && !entry.fetchQueued && entry.retryTimer === undefined) {
        this.startRound(entry);
      }
    }

    if (this.isConcluded(entry) && !entry.fetchQueued) {
      this.touchImageLru(entry);
      this.armIdleTimerIfQuiescent(entry);
      return this.buildImagesResult(entry);
    }

    return new Promise<ProfileImages>((resolve, reject) => {
      entry.imageWaiters.push({ resolve, reject });
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
      const error = new Error(`ProfileReader: disposed while loading profile for '${entry.did}'.`);
      for (const waiter of entry.waiters.splice(0)) {
        waiter.reject(error);
      }
      for (const imageWaiter of entry.imageWaiters.splice(0)) {
        imageWaiter.reject(error);
      }
    }
    this._entries.clear();
    this._imageLru.clear();
    this._retainedImageBytes = 0;
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

    // Image fields start idle unless images load eagerly; the fetch round
    // only attempts them after the root profile record is confirmed.
    const imageInitialStatus: ProfileFieldStatus = this._imagesMode === 'eager' ? 'loading' : 'idle';
    const fields: CacheEntry['fields'] = {
      profile : { status: 'loading', attempts: 0 },
      avatar  : { status: imageInitialStatus, attempts: 0 },
      hero    : { status: imageInitialStatus, attempts: 0 },
    };
    const entry: CacheEntry = {
      did,
      fields,
      snapshot            : buildSnapshot(did, fields),
      watchers            : new Set(),
      waiters             : [],
      imageWaiters        : [],
      imagesRequested     : false,
      imageBytes          : 0,
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

  /** Whether image fetching is enabled for this entry (mode + lazy request). */
  private imagesActive(entry: CacheEntry): boolean {
    return this._imagesMode === 'eager' || (this._imagesMode === 'lazy' && entry.imagesRequested);
  }

  // -------------------------------------------------------------------------
  // Fetch rounds
  // -------------------------------------------------------------------------

  private startRound(entry: CacheEntry): void {
    entry.fetchQueued = true;
    void this.runRound(entry);
  }

  /**
   * One fetch round for an entry: resolve the root profile field first,
   * then — only when the root record exists — the due image fields. When
   * the root concludes missing (or failed), still-pending image fields are
   * suppressed so orphaned image records are never surfaced.
   */
  private async runRound(entry: CacheEntry): Promise<void> {
    await this.acquireRoundSlot();
    try {
      if (entry.evicted || this._disposed) {
        return;
      }

      const profileField = entry.fields.profile;
      if (profileField.status === 'loading' && this.isFieldDue(profileField)) {
        await this.attemptField(entry, 'profile');
      }
      if (entry.evicted || this._disposed) {
        return;
      }

      if (profileField.status === 'settled') {
        if (this.imagesActive(entry)) {
          const dueImages = IMAGE_FIELD_KEYS.filter((key) => {
            const field = entry.fields[key];
            return field.status === 'loading' && this.isFieldDue(field);
          });
          await Promise.all(dueImages.map((key) => this.attemptField(entry, key)));
        }
      } else if (profileField.status === 'not-found' || profileField.status === 'error') {
        this.suppressPendingImages(entry);
      }
    } finally {
      this.releaseRoundSlot();
    }

    entry.fetchQueued = false;
    this.afterRound(entry);
  }

  private isFieldDue(field: MutableFieldState): boolean {
    return field.nextAttemptAt === undefined || field.nextAttemptAt <= this._timers.now();
  }

  /**
   * Conclude still-pending image fields as `not-found` when the root
   * profile record is missing or failed: without a root profile there is
   * no profile — orphaned avatar/hero records (e.g. left behind by a
   * non-pruning root delete) must not be returned.
   */
  private suppressPendingImages(entry: CacheEntry): void {
    let changed = false;
    for (const key of IMAGE_FIELD_KEYS) {
      const field = entry.fields[key];
      if (field.status === 'loading') {
        field.status = 'not-found';
        field.value = undefined;
        field.failure = undefined;
        field.nextAttemptAt = undefined;
        changed = true;
      }
    }
    if (changed) {
      this.publish(entry);
    }
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

  /** After a round: conclude the entry, or schedule the work that remains. */
  private afterRound(entry: CacheEntry): void {
    if (entry.evicted || this._disposed) {
      return;
    }

    if (this.isConcluded(entry)) {
      this.concludeEntry(entry);
      return;
    }

    // Fields that are due immediately (no scheduled retry): image fields
    // promoted by loadImages() while a round was already past its image
    // phase, or images that became eligible when the profile settled.
    const profileSettled = entry.fields.profile.status === 'settled';
    const hasImmediatelyDue = FIELD_KEYS.some((key) => {
      const field = entry.fields[key];
      if (field.status !== 'loading' || field.nextAttemptAt !== undefined) {
        return false;
      }
      return key === 'profile' || (profileSettled && this.imagesActive(entry));
    });
    if (hasImmediatelyDue) {
      this.startRound(entry);
      return;
    }

    const pendingDueTimes = FIELD_KEYS
      .map((key) => entry.fields[key])
      .filter((field) => field.status === 'loading' && field.nextAttemptAt !== undefined)
      .map((field) => field.nextAttemptAt as number);

    if (pendingDueTimes.length === 0) {
      // Defensive: a loading field that is neither due nor scheduled should
      // not exist; conclude it as a terminal error rather than hanging.
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

    const imagesResult = this.buildImagesResult(entry);
    for (const imageWaiter of entry.imageWaiters.splice(0)) {
      imageWaiter.resolve(imagesResult);
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
      if (key !== 'profile' && outcome.value instanceof Blob) {
        this.accountStoredImage(entry, outcome.value);
      }
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
    const sanitized = sanitizeProfileData(data);
    if (sanitized === undefined) {
      return {
        kind    : 'failure',
        failure : { retryable: false, message: 'profile record data is not a JSON object' },
      };
    }

    return { kind: 'settled', value: sanitized };
  }

  private async fetchImage(did: string, key: ImageFieldKey): Promise<FieldOutcome> {
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

    // Reject over-budget records by declared size BEFORE downloading bytes,
    // then re-check the actual bytes — a misbehaving server may understate.
    const maxBytes = IMAGE_MAX_BYTES[key];
    if (record.dataSize !== undefined && record.dataSize > maxBytes) {
      return this.oversizedImageFailure(key, record.dataSize, maxBytes, 'declares');
    }
    const value = await record.data.blob();
    if (value.size > maxBytes) {
      return this.oversizedImageFailure(key, value.size, maxBytes, 'contains');
    }
    return { kind: 'settled', value };
  }

  private oversizedImageFailure(key: ImageFieldKey, actual: number, maxBytes: number, verb: 'declares' | 'contains'): FieldOutcome {
    return {
      kind    : 'failure',
      failure : {
        retryable : false,
        message   : `${key} record ${verb} ${actual} bytes, exceeding the protocol maximum of ${maxBytes} bytes`,
      },
    };
  }

  private failureFromStatus(operation: string, status: ProfileReaderReplyStatus): FieldOutcome {
    const detail = status.detail === undefined ? '' : `: ${status.detail}`;
    return {
      kind    : 'failure',
      failure : {
        retryable : isRetryableProfileReadStatus(status.code),
        code      : status.code,
        message   : `${operation} failed with status ${status.code}${detail}`,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Image byte budget (LRU)
  // -------------------------------------------------------------------------

  /** Track a newly stored image Blob and enforce the byte budget. */
  private accountStoredImage(entry: CacheEntry, blob: Blob): void {
    entry.imageBytes += blob.size;
    this._retainedImageBytes += blob.size;
    this.touchImageLru(entry);
    this.enforceImageBudget(entry);
  }

  /** Mark the entry as most-recently-used in the image LRU. */
  private touchImageLru(entry: CacheEntry): void {
    if (entry.imageBytes > 0) {
      this._imageLru.delete(entry.did);
      this._imageLru.set(entry.did, entry);
    }
  }

  /**
   * Release least-recently-used entries' images until the retained total
   * fits the budget. The entry that just stored an image is protected, as
   * are entries with in-flight work or pending waiters (they conclude
   * shortly and the next store enforces again).
   */
  private enforceImageBudget(protectedEntry: CacheEntry): void {
    if (this._retainedImageBytes <= this._imageByteBudget) {
      return;
    }
    // Releasing an entry publishes to arbitrary watchers, which may synchronously
    // touch the LRU. Iterate a stable snapshot so re-entrancy cannot revisit or
    // add eviction candidates during this enforcement pass.
    this.releaseImageCandidates(Array.from(this._imageLru.values()), protectedEntry);
  }

  /** Release eligible entries from a stable image-LRU snapshot. */
  private releaseImageCandidates(candidates: readonly CacheEntry[], protectedEntry: CacheEntry): void {
    for (const candidate of candidates) {
      if (this._retainedImageBytes <= this._imageByteBudget) {
        return;
      }
      if (candidate === protectedEntry || candidate.fetchQueued || candidate.waiters.length > 0 || candidate.imageWaiters.length > 0) {
        continue;
      }
      this.releaseEntryImages(candidate);
    }
  }

  /**
   * Drop an entry's retained image Blobs: image fields return to `'idle'`
   * (re-requestable via `loadImages()`), the text profile stays cached,
   * and watchers are notified of the change.
   */
  private releaseEntryImages(entry: CacheEntry): void {
    this._retainedImageBytes -= entry.imageBytes;
    entry.imageBytes = 0;
    this._imageLru.delete(entry.did);
    let changed = false;
    for (const key of IMAGE_FIELD_KEYS) {
      const field = entry.fields[key];
      if (field.value !== undefined) {
        field.value = undefined;
        field.status = 'idle';
        field.failure = undefined;
        changed = true;
      }
    }
    // Released images must be explicitly re-requested in lazy mode.
    entry.imagesRequested = false;
    if (changed) {
      this.publish(entry);
    }
  }

  /** Remove an entry's contribution to the image accounting on eviction. */
  private dropImageAccounting(entry: CacheEntry): void {
    this._retainedImageBytes -= entry.imageBytes;
    entry.imageBytes = 0;
    this._imageLru.delete(entry.did);
  }

  // -------------------------------------------------------------------------
  // Snapshots + notification
  // -------------------------------------------------------------------------

  private publish(entry: CacheEntry): void {
    entry.snapshot = buildSnapshot(entry.did, entry.fields);
    this.notifyWatchers(Array.from(entry.watchers), entry.snapshot);
  }

  /** Notify the stable watcher snapshot captured by {@link publish}. */
  private notifyWatchers(watchers: readonly WatchHandle[], snapshot: ProfileSnapshot): void {
    for (const watcher of watchers) {
      this.notifyWatcher(watcher, snapshot);
    }
  }

  private notifyWatcher(handle: WatchHandle, snapshot: ProfileSnapshot): void {
    try {
      handle.listener(snapshot);
    } catch (error: unknown) {
      console.warn(`ProfileReader: watch listener threw for '${snapshot.did}'`, error);
    }
  }

  /**
   * Assemble the public result. Untrusted JSON contributes only its
   * sanitized allowlisted fields; the authoritative requested `did` and
   * the separately-fetched image Blobs are assigned AFTER the spread so
   * nothing from the remote JSON can shadow them.
   */
  private buildPublicProfile(entry: CacheEntry): PublicProfile {
    const profileData = entry.fields.profile.value as Partial<ProfileData> | undefined;
    const result: PublicProfile = { ...profileData, did: entry.did };
    const avatar = entry.fields.avatar.value;
    const hero = entry.fields.hero.value;
    if (avatar instanceof Blob) {
      result.avatar = avatar;
    }
    if (hero instanceof Blob) {
      result.hero = hero;
    }
    return result;
  }

  private buildImagesResult(entry: CacheEntry): ProfileImages {
    const images: ProfileImages = {};
    const avatar = entry.fields.avatar.value;
    const hero = entry.fields.hero.value;
    if (avatar instanceof Blob) {
      images.avatar = avatar;
    }
    if (hero instanceof Blob) {
      images.hero = hero;
    }
    return images;
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
   * watchers, no pending waiters, and no fetch activity. Re-arming
   * restarts the countdown.
   */
  private armIdleTimerIfQuiescent(entry: CacheEntry): void {
    if (entry.evicted || this._disposed) {
      return;
    }
    if (
      entry.watchers.size > 0 || entry.waiters.length > 0 || entry.imageWaiters.length > 0 ||
      entry.fetchQueued || entry.retryTimer !== undefined
    ) {
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
    if (entry.watchers.size > 0 || entry.waiters.length > 0 || entry.imageWaiters.length > 0 || entry.fetchQueued) {
      return; // Re-referenced since the timer was armed; keep the entry.
    }
    entry.evicted = true;
    this.cancelRetryTimer(entry);
    this.cancelIdleTimer(entry);
    this.dropImageAccounting(entry);
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
 * @param options - Cache/retry/image tuning; see {@link ProfileReaderOptions}.
 *
 * @example
 * ```ts
 * import { Enbox } from '@enbox/api';
 * import { createProfileReader } from '@enbox/protocols';
 *
 * const reader = createProfileReader(Enbox.anonymous());
 *
 * // Text profile only (images are lazy by default).
 * const { displayName } = await reader.get('did:dht:alice...');
 *
 * // Load images on demand — e.g. when the profile scrolls into view.
 * const { avatar } = await reader.loadImages('did:dht:alice...');
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
