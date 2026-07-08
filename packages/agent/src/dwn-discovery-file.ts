/**
 * File-based local DWN discovery for CLI and native apps.
 *
 * When `electrobun-dwn` (or any local DWN server) starts, it writes a
 * well-known file (`~/.enbox/dwn.json`) containing the DWN endpoint URL
 * and the server PID. CLI tools and native apps read this file to discover
 * the local DWN without port probing.
 *
 * The filesystem operations are abstracted behind {@link DiscoveryFileFs}
 * so the module can be tested without touching the real filesystem, and
 * adapted to runtimes that provide different I/O primitives.
 *
 * @see https://github.com/enboxorg/enbox/issues/587
 * @module
 */

import { createNodeDiscoveryFileFs } from './dwn-discovery-file-fs.js';
import { normalizeBaseUrl } from './local-dwn.js';

export { createNodeDiscoveryFileFs } from './dwn-discovery-file-fs.js';

// ─── Types ────────────────────────────────────────────────────────

/**
 * The JSON shape persisted in the discovery file.
 *
 * @see https://identity.foundation/dwn-transport/#discovery-file
 */
export interface DwnDiscoveryRecord {
  /** Base URL of the running DWN server (e.g. `"http://127.0.0.1:55500"`). */
  endpoint: string;
  /** OS process ID of the DWN server. Used for liveness checking. */
  pid: number;
  /**
   * Transport capabilities advertised by the server (e.g. `["http", "ws"]`).
   * Optional per the DWN Transport Spec.
   */
  capabilities?: string[];
  /**
   * Bearer token for local non-browser clients that do not send an Origin header.
   * Browser origins receive their own tokens through the pairing flow.
   */
  localNodeToken?: string;
}

/**
 * Minimal filesystem interface required by {@link DwnDiscoveryFile}.
 *
 * Consumers can provide a custom implementation for testing or for
 * runtimes that do not expose Node-compatible `fs` and `os` modules.
 */
export interface DiscoveryFileFs {
  /** Read the file at `path` and return its UTF-8 contents, or `null` if not found. */
  readFile(path: string): Promise<string | null>;
  /** Write `contents` to the file at `path`, creating parent directories as needed. */
  writeFile(path: string, contents: string): Promise<void>;
  /** Delete the file at `path`. Must not throw if the file does not exist. */
  removeFile(path: string): Promise<void>;
  /** Return `true` if the process with the given PID is alive. */
  isProcessAlive(pid: number): boolean;
  /** Return the user's home directory (e.g. `/home/alice`). */
  homedir(): string;
}

// ─── Constants ────────────────────────────────────────────────────

/**
 * Directory under the user's home where the discovery file lives.
 * Shared with the `electrobun-dwn` app and other Enbox tooling.
 */
export const DISCOVERY_DIR = '.enbox';

/** Filename of the discovery file. */
export const DISCOVERY_FILENAME = 'dwn.json';

// ─── DwnDiscoveryFile ────────────────────────────────────────────

/**
 * Reads, writes, and validates the `~/.enbox/dwn.json` discovery file.
 *
 * This is the **file-based discovery channel** for CLI and native apps.
 * It is complementary to the `dwn://connect` browser redirect flow.
 *
 * @example Reading the discovery file
 * ```ts
 * const discoveryFile = new DwnDiscoveryFile();
 * const record = await discoveryFile.read();
 *
 * if (record) {
 *   console.log(`Local DWN at ${record.endpoint}`);
 * }
 * ```
 *
 * @example Writing the discovery file (from electrobun-dwn)
 * ```ts
 * const discoveryFile = new DwnDiscoveryFile();
 * await discoveryFile.write({
 *   endpoint : 'http://127.0.0.1:55557',
 *   pid      : process.pid,
 * });
 * ```
 */
export class DwnDiscoveryFile {
  private readonly _fs: DiscoveryFileFs;
  private readonly _filePath: string;

  /**
   * @param fs - Filesystem adapter. Defaults to Node/Bun built-ins.
   * @param filePath - Override the discovery file path (mainly for testing).
   * @throws If no filesystem adapter is available (e.g. in a browser).
   */
  constructor(fs?: DiscoveryFileFs, filePath?: string) {
    const resolvedFs = fs ?? createNodeDiscoveryFileFs();
    if (!resolvedFs) {
      throw new Error(
        'DwnDiscoveryFile: No filesystem adapter available. ' +
        'Provide a DiscoveryFileFs implementation or run in Node.js / Bun.'
      );
    }
    this._fs = resolvedFs;

    if (filePath) {
      this._filePath = filePath;
    } else {
      this._filePath = `${resolvedFs.homedir()}/${DISCOVERY_DIR}/${DISCOVERY_FILENAME}`;
    }
  }

  /** The absolute path of the discovery file. */
  public get path(): string {
    return this._filePath;
  }

  /**
   * Read and validate the discovery file.
   *
   * Returns the parsed {@link DwnDiscoveryRecord} if:
   * 1. The file exists and contains valid JSON.
   * 2. The `endpoint` is a non-empty string.
   * 3. The `pid` is a positive integer whose process is still alive.
   *
   * Returns `undefined` in all other cases (missing file, parse error,
   * stale PID). Stale files are automatically removed.
   */
  public async read(): Promise<DwnDiscoveryRecord | undefined> {
    const raw = await this._fs.readFile(this._filePath);
    if (raw === null) {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupted file — remove it.
      await this._fs.removeFile(this._filePath);
      return undefined;
    }

    if (!isValidRecord(parsed)) {
      await this._fs.removeFile(this._filePath);
      return undefined;
    }

    // Check that the server process is still alive.
    if (!this._fs.isProcessAlive(parsed.pid)) {
      await this._fs.removeFile(this._filePath);
      return undefined;
    }

    const result: DwnDiscoveryRecord = {
      endpoint : normalizeBaseUrl(parsed.endpoint),
      pid      : parsed.pid,
    };

    if (parsed.capabilities !== undefined) {
      result.capabilities = parsed.capabilities;
    }

    if (parsed.localNodeToken !== undefined) {
      result.localNodeToken = parsed.localNodeToken;
    }

    return result;
  }

  /**
   * Write the discovery file. Creates the `~/.enbox/` directory if needed.
   *
   * @param record - The endpoint and PID to persist.
   */
  public async write(record: DwnDiscoveryRecord): Promise<void> {
    const serialized: Record<string, unknown> = {
      endpoint : normalizeBaseUrl(record.endpoint),
      pid      : record.pid,
    };

    if (record.capabilities !== undefined && record.capabilities.length > 0) {
      serialized.capabilities = record.capabilities;
    }

    if (record.localNodeToken !== undefined) {
      serialized.localNodeToken = record.localNodeToken;
    }

    const json = JSON.stringify(serialized, null, 2);
    await this._fs.writeFile(this._filePath, json);
  }

  /**
   * Remove the discovery file. Does not throw if the file is already gone.
   */
  public async remove(): Promise<void> {
    await this._fs.removeFile(this._filePath);
  }
}

// ─── Internal helpers ─────────────────────────────────────────────

/** Type guard for a valid {@link DwnDiscoveryRecord}. */
function isValidRecord(value: unknown): value is DwnDiscoveryRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  if (typeof record.endpoint !== 'string' || record.endpoint.length === 0) {
    return false;
  }

  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) {
    return false;
  }

  // `capabilities` is optional, but when present must be a string array.
  if (record.capabilities !== undefined) {
    if (!Array.isArray(record.capabilities)) {
      return false;
    }

    if (!record.capabilities.every((item: unknown) => typeof item === 'string')) {
      return false;
    }
  }

  if (record.localNodeToken !== undefined && (typeof record.localNodeToken !== 'string' || record.localNodeToken.length === 0)) {
    return false;
  }

  return true;
}
