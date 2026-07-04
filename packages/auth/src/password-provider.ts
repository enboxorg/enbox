/**
 * PasswordProvider — composable password acquisition strategies.
 *
 * Replaces ad-hoc password prompting scattered across CLI consumers
 * (env vars, raw-mode TTY, `/dev/tty` + `stty`, `@clack/prompts`, etc.)
 * with a single, composable abstraction.
 *
 * @example Chained provider (env first, fall back to TTY)
 * ```ts
 * import { PasswordProvider } from '@enbox/auth';
 *
 * const provider = PasswordProvider.chain([
 *   PasswordProvider.fromEnv('ENBOX_PASSWORD'),
 *   PasswordProvider.fromTty({ prompt: 'Vault password: ' }),
 * ]);
 *
 * const auth = await AuthManager.create({ passwordProvider: provider });
 * ```
 *
 * @module
 */

import type { PasswordContext, PasswordProvider as PasswordProviderBase } from './password-provider-core.js';

import { PasswordProvider as BrowserSafePasswordProvider } from './password-provider-core.js';

// ─── Types ───────────────────────────────────────────────────────

export type { PasswordContext } from './password-provider-core.js';

/**
 * A strategy for obtaining a vault password.
 *
 * Implementations may be interactive (TTY prompts) or non-interactive
 * (environment variables, cached values). Use {@link PasswordProvider.chain}
 * to compose multiple strategies with automatic fallback.
 */
export interface PasswordProvider extends PasswordProviderBase {}

// ─── Internal I/O interfaces (for testing) ───────────────────────

/**
 * Minimal interface for an stdin-like readable stream.
 *
 * The signature shape mirrors Node's `tty.ReadStream` closely enough
 * that `process.stdin` is directly assignable without a cast — the
 * payoff is that `readPasswordRawMode` is testable with a tiny in-memory
 * stub and the production call site needs no `as` to bridge to Node's
 * actual stdin type.
 *
 * @internal
 */
export interface TtyReadable {
  isTTY?: boolean;
  setRawMode(mode: boolean): unknown;
  setEncoding(encoding?: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: string) => void): unknown;
}

/** @internal Minimal interface for an stdout-like writable stream. */
export interface TtyWritable {
  write(data: string): boolean;
}

// ─── Internal helpers ────────────────────────────────────────────

/**
 * Read a password from a raw-mode TTY stream.
 *
 * Reads character-by-character with no echo. Handles Enter (resolve),
 * Ctrl-C (reject), backspace, and printable characters.
 *
 * @internal Exported for testing only.
 */
export function readPasswordRawMode(
  stdin: TtyReadable,
  stdout: TtyWritable,
  prompt: string,
): Promise<string> {
  stdout.write(prompt);

  return new Promise<string>((resolve, reject) => {
    let buf = '';
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();

    const onData = (ch: string): void => {
      const code = ch.charCodeAt(0);

      if (ch === '\r' || ch === '\n') {
        // Enter — done.
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(buf);
      } else if (code === 3) {
        // Ctrl-C — abort.
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        reject(new Error('[@enbox/auth] PasswordProvider.fromTty: cancelled by user.'));
      } else if (code === 127 || code === 8) {
        // Backspace / Delete.
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
        }
      } else if (code >= 32) {
        // Printable character.
        buf += ch;
      }
    };

    stdin.on('data', onData);
  });
}

/**
 * @internal Injectable I/O for testing `readPasswordDevTty`.
 *
 * `execSync`'s `stdio` is narrowed to the literal-union Node accepts so
 * the implementation below can call `child_process.execSync` without a
 * `stdio: string -> stdio: StdioOptions` cast.
 */
export interface DevTtyIo {
  openSync(path: string, flags: string): number;
  readSync(fd: number, buf: Uint8Array, offset: number, length: number, position: null): number;
  writeSync(fd: number, data: string): number;
  closeSync(fd: number): void;
  execSync(cmd: string, opts: { stdio: 'pipe' | 'ignore' | 'inherit' }): void;
}

/**
 * Read a password from `/dev/tty` using synchronous I/O.
 *
 * Opens `/dev/tty` directly, uses `stty -echo` to suppress input,
 * reads until newline, then restores echo and closes file descriptors.
 *
 * @param prompt - The prompt string to display.
 * @param io - Injectable I/O functions (defaults to `node:fs` + `node:child_process`).
 * @internal Exported for testing only.
 */
export async function readPasswordDevTty(
  prompt: string,
  io?: DevTtyIo,
): Promise<string> {
  // Use injected I/O or import real modules.
  let fsIo: DevTtyIo;
  if (io) {
    fsIo = io;
  } else {
    const { openSync, readSync, writeSync, closeSync } = await import('node:fs');
    const { execSync } = await import('node:child_process');
    fsIo = {
      openSync,
      readSync,
      writeSync,
      closeSync,
      execSync: (cmd: string, opts: { stdio: 'pipe' | 'ignore' | 'inherit' }): void => { execSync(cmd, opts); },
    };
  }

  let readFd: number;
  let writeFd: number;

  try {
    readFd = fsIo.openSync('/dev/tty', 'r');
    writeFd = fsIo.openSync('/dev/tty', 'w');
  } catch {
    throw new Error(
      '[@enbox/auth] PasswordProvider.fromDevTty: cannot open /dev/tty. ' +
      'No controlling terminal available.'
    );
  }

  try {
    // Suppress echo.
    try {
      fsIo.execSync('stty -echo < /dev/tty', { stdio: 'ignore' });
    } catch {
      // Continue — the user sees their password but the flow works.
    }

    fsIo.writeSync(writeFd, prompt);

    // Cooked-mode read (line-buffered; terminal handles backspace).
    const readBuf = new Uint8Array(256);
    const decoder = new TextDecoder('utf-8');
    let password = '';

    while (true) {
      const bytesRead = fsIo.readSync(readFd, readBuf, 0, readBuf.length, null);
      if (bytesRead === 0) { break; }

      password += decoder.decode(readBuf.subarray(0, bytesRead), { stream: true });

      const nlIdx = password.indexOf('\n');
      if (nlIdx !== -1) { password = password.slice(0, nlIdx); break; }

      const crIdx = password.indexOf('\r');
      if (crIdx !== -1) { password = password.slice(0, crIdx); break; }
    }

    fsIo.writeSync(writeFd, '\n');
    return password;
  } finally {
    // Restore echo.
    try { fsIo.execSync('stty echo < /dev/tty', { stdio: 'ignore' }); } catch { /* best-effort */ }
    fsIo.closeSync(readFd);
    fsIo.closeSync(writeFd);
  }
}

// ─── Factory functions ───────────────────────────────────────────


export namespace PasswordProvider {

  /**
   * Read the password from an environment variable.
   *
   * Throws if the variable is not set or is empty, allowing `chain()`
   * to fall through to the next provider.
   *
   * @param envVar - Name of the environment variable. Default: `'ENBOX_PASSWORD'`.
   *
   * @example
   * ```ts
   * const provider = PasswordProvider.fromEnv('MY_APP_PASSWORD');
   * ```
   */
  export function fromEnv(envVar = 'ENBOX_PASSWORD'): PasswordProvider {
    return {
      async getPassword(): Promise<string> {
        const value = process.env[envVar];
        if (!value) {
          throw new Error(
            `[@enbox/auth] PasswordProvider.fromEnv: environment variable '${envVar}' is not set.`
          );
        }
        return value;
      },
    };
  }

  /**
   * Wrap an async callback as a password provider.
   *
   * This is the escape hatch for custom UI (e.g. `@clack/prompts`,
   * Electron dialog, browser modal).
   *
   * @param callback - Called with the password context; must return a password string.
   *
   * @example
   * ```ts
   * const provider = PasswordProvider.fromCallback(async ({ reason }) => {
   *   if (reason === 'create') {
   *     return await showCreatePasswordDialog();
   *   }
   *   return await showUnlockDialog();
   * });
   * ```
   */
  export function fromCallback(
    callback: (context: PasswordContext) => Promise<string>,
  ): PasswordProvider {
    return BrowserSafePasswordProvider.fromCallback(callback);
  }

  /**
   * Prompt for a password via `process.stdin` in raw mode.
   *
   * Input is read character-by-character with no echo. Handles
   * backspace and Ctrl-C (rejects with an error). Only works when
   * `process.stdin.isTTY` is `true`; throws otherwise so `chain()`
   * can fall through to the next provider.
   *
   * Suitable for main CLI processes that own stdin/stdout.
   *
   * @param options - Optional configuration.
   * @param options.prompt - Text to display before reading. Default: `'Vault password: '`.
   *
   * @example
   * ```ts
   * const provider = PasswordProvider.fromTty({ prompt: 'Password: ' });
   * ```
   */
  export function fromTty(options: { prompt?: string } = {}): PasswordProvider {
    const prompt = options.prompt ?? 'Vault password: ';

    return {
      async getPassword(): Promise<string> {
        if (!process.stdin.isTTY) {
          throw new Error(
            '[@enbox/auth] PasswordProvider.fromTty: stdin is not a TTY.'
          );
        }

        return readPasswordRawMode(
          process.stdin,
          process.stdout,
          prompt,
        );
      },
    };
  }

  /**
   * Prompt for a password via `/dev/tty` (Unix only).
   *
   * Opens `/dev/tty` directly, bypassing `process.stdin`. This is
   * essential for subprocesses where stdin is owned by the parent
   * (e.g. Git credential helpers, SSH, GPG). Uses `stty -echo` to
   * suppress input echo.
   *
   * Throws if `/dev/tty` cannot be opened (e.g. non-Unix platform,
   * no controlling terminal), allowing `chain()` to fall through.
   *
   * @param options - Optional configuration.
   * @param options.prompt - Text to display before reading. Default: `'Vault password: '`.
   *
   * @example
   * ```ts
   * // For git credential helpers:
   * const provider = PasswordProvider.fromDevTty();
   * ```
   */
  export function fromDevTty(options: { prompt?: string } = {}): PasswordProvider {
    const prompt = options.prompt ?? 'Vault password: ';

    return {
      async getPassword(): Promise<string> {
        return readPasswordDevTty(prompt);
      },
    };
  }

  /**
   * Compose multiple providers with automatic fallback.
   *
   * Tries each provider in order. If a provider throws, the next one
   * is tried. If all providers fail, the last error is rethrown.
   *
   * @param providers - Ordered list of providers to try.
   *
   * @example
   * ```ts
   * // Try env var first, then interactive TTY, then /dev/tty for subprocesses.
   * const provider = PasswordProvider.chain([
   *   PasswordProvider.fromEnv('ENBOX_PASSWORD'),
   *   PasswordProvider.fromTty(),
   *   PasswordProvider.fromDevTty(),
   * ]);
   * ```
   */
  export function chain(providers: PasswordProvider[]): PasswordProvider {
    return BrowserSafePasswordProvider.chain(providers);
  }
}
