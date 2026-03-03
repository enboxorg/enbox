import { describe, expect, test } from 'bun:test';

import type { DevTtyIo, PasswordContext, TtyReadable, TtyWritable } from '../src/password-provider.js';
import { PasswordProvider, readPasswordDevTty, readPasswordRawMode } from '../src/password-provider.js';

/**
 * Create a mock TtyReadable that feeds characters to the onData handler.
 */
function createMockStdin(overrides: { isTTY?: boolean } = {}): TtyReadable & {
  feedChars: (chars: string) => void;
  feedChar: (char: string) => void;
} {
  let dataHandler: ((chunk: string) => void) | undefined;

  return {
    isTTY: overrides.isTTY ?? true,
    setRawMode(): void { /* no-op */ },
    setEncoding(): void { /* no-op */ },
    resume(): void { /* no-op */ },
    pause(): void { /* no-op */ },
    on(_event: 'data', listener: (chunk: string) => void): void {
      dataHandler = listener;
    },
    removeListener(_event: 'data', _listener: (chunk: string) => void): void {
      dataHandler = undefined;
    },
    feedChars(chars: string): void {
      for (const ch of chars) {
        dataHandler?.(ch);
      }
    },
    feedChar(char: string): void {
      dataHandler?.(char);
    },
  };
}

/** Create a mock TtyWritable that records writes. */
function createMockStdout(): TtyWritable & { output: string[] } {
  const output: string[] = [];
  return {
    output,
    write(data: string): boolean {
      output.push(data);
      return true;
    },
  };
}

describe('PasswordProvider', () => {
  describe('fromEnv()', () => {
    test('returns value from environment variable', async () => {
      const original = process.env.ENBOX_PASSWORD;
      try {
        process.env.ENBOX_PASSWORD = 'test-password';
        const provider = PasswordProvider.fromEnv();
        const password = await provider.getPassword({ reason: 'unlock' });
        expect(password).toBe('test-password');
      } finally {
        if (original === undefined) {
          delete process.env.ENBOX_PASSWORD;
        } else {
          process.env.ENBOX_PASSWORD = original;
        }
      }
    });

    test('reads from custom env var name', async () => {
      const original = process.env.MY_CUSTOM_PW;
      try {
        process.env.MY_CUSTOM_PW = 'custom-pw';
        const provider = PasswordProvider.fromEnv('MY_CUSTOM_PW');
        const password = await provider.getPassword({ reason: 'unlock' });
        expect(password).toBe('custom-pw');
      } finally {
        if (original === undefined) {
          delete process.env.MY_CUSTOM_PW;
        } else {
          process.env.MY_CUSTOM_PW = original;
        }
      }
    });

    test('throws when env var is not set', async () => {
      const original = process.env.ENBOX_PASSWORD;
      try {
        delete process.env.ENBOX_PASSWORD;
        const provider = PasswordProvider.fromEnv();
        await expect(provider.getPassword({ reason: 'unlock' })).rejects.toThrow(
          'environment variable \'ENBOX_PASSWORD\' is not set'
        );
      } finally {
        if (original !== undefined) {
          process.env.ENBOX_PASSWORD = original;
        }
      }
    });

    test('throws when env var is empty string', async () => {
      const original = process.env.ENBOX_PASSWORD;
      try {
        process.env.ENBOX_PASSWORD = '';
        const provider = PasswordProvider.fromEnv();
        await expect(provider.getPassword({ reason: 'unlock' })).rejects.toThrow(
          'environment variable \'ENBOX_PASSWORD\' is not set'
        );
      } finally {
        if (original === undefined) {
          delete process.env.ENBOX_PASSWORD;
        } else {
          process.env.ENBOX_PASSWORD = original;
        }
      }
    });

    test('defaults env var name to ENBOX_PASSWORD', async () => {
      const original = process.env.ENBOX_PASSWORD;
      try {
        delete process.env.ENBOX_PASSWORD;
        const provider = PasswordProvider.fromEnv();
        await expect(provider.getPassword({ reason: 'unlock' })).rejects.toThrow(
          '\'ENBOX_PASSWORD\''
        );
      } finally {
        if (original !== undefined) {
          process.env.ENBOX_PASSWORD = original;
        }
      }
    });
  });

  describe('fromCallback()', () => {
    test('calls callback with context and returns result', async () => {
      const contexts: PasswordContext[] = [];
      const provider = PasswordProvider.fromCallback(async (ctx) => {
        contexts.push(ctx);
        return 'callback-password';
      });

      const password = await provider.getPassword({ reason: 'create' });

      expect(password).toBe('callback-password');
      expect(contexts).toHaveLength(1);
      expect(contexts[0].reason).toBe('create');
    });

    test('passes unlock reason', async () => {
      const contexts: PasswordContext[] = [];
      const provider = PasswordProvider.fromCallback(async (ctx) => {
        contexts.push(ctx);
        return 'pw';
      });

      await provider.getPassword({ reason: 'unlock' });
      expect(contexts[0].reason).toBe('unlock');
    });

    test('propagates callback errors', async () => {
      const provider = PasswordProvider.fromCallback(async () => {
        throw new Error('dialog cancelled');
      });

      await expect(provider.getPassword({ reason: 'unlock' })).rejects.toThrow('dialog cancelled');
    });
  });

  describe('chain()', () => {
    test('returns first successful provider result', async () => {
      const provider = PasswordProvider.chain([
        PasswordProvider.fromCallback(async () => 'first'),
        PasswordProvider.fromCallback(async () => 'second'),
      ]);

      const password = await provider.getPassword({ reason: 'unlock' });
      expect(password).toBe('first');
    });

    test('falls through to next provider on failure', async () => {
      const provider = PasswordProvider.chain([
        PasswordProvider.fromCallback(async () => { throw new Error('fail'); }),
        PasswordProvider.fromCallback(async () => 'fallback'),
      ]);

      const password = await provider.getPassword({ reason: 'unlock' });
      expect(password).toBe('fallback');
    });

    test('falls through multiple failures', async () => {
      const provider = PasswordProvider.chain([
        PasswordProvider.fromCallback(async () => { throw new Error('fail 1'); }),
        PasswordProvider.fromCallback(async () => { throw new Error('fail 2'); }),
        PasswordProvider.fromCallback(async () => 'third'),
      ]);

      const password = await provider.getPassword({ reason: 'unlock' });
      expect(password).toBe('third');
    });

    test('throws last error when all providers fail', async () => {
      const provider = PasswordProvider.chain([
        PasswordProvider.fromCallback(async () => { throw new Error('fail 1'); }),
        PasswordProvider.fromCallback(async () => { throw new Error('fail 2'); }),
      ]);

      await expect(provider.getPassword({ reason: 'unlock' })).rejects.toThrow('fail 2');
    });

    test('passes context to each provider', async () => {
      const contexts: PasswordContext[] = [];
      const provider = PasswordProvider.chain([
        PasswordProvider.fromCallback(async (ctx) => {
          contexts.push(ctx);
          throw new Error('fail');
        }),
        PasswordProvider.fromCallback(async (ctx) => {
          contexts.push(ctx);
          return 'pw';
        }),
      ]);

      await provider.getPassword({ reason: 'create' });

      expect(contexts).toHaveLength(2);
      expect(contexts[0].reason).toBe('create');
      expect(contexts[1].reason).toBe('create');
    });

    test('throws when given empty array', () => {
      expect(() => PasswordProvider.chain([])).toThrow(
        'at least one provider is required'
      );
    });

    test('handles non-Error throws from providers', async () => {
      const provider = PasswordProvider.chain([
        PasswordProvider.fromCallback(async () => { throw 'string-error'; }),
        PasswordProvider.fromCallback(async () => { throw 42; }),
      ]);

      await expect(provider.getPassword({ reason: 'unlock' })).rejects.toThrow('42');
    });

    test('env-first pattern works end-to-end', async () => {
      const original = process.env.TEST_PW_CHAIN;
      try {
        process.env.TEST_PW_CHAIN = 'from-env';

        const provider = PasswordProvider.chain([
          PasswordProvider.fromEnv('TEST_PW_CHAIN'),
          PasswordProvider.fromCallback(async () => 'from-callback'),
        ]);

        const password = await provider.getPassword({ reason: 'unlock' });
        expect(password).toBe('from-env');
      } finally {
        if (original === undefined) {
          delete process.env.TEST_PW_CHAIN;
        } else {
          process.env.TEST_PW_CHAIN = original;
        }
      }
    });

    test('falls back to callback when env var missing', async () => {
      const original = process.env.TEST_PW_CHAIN2;
      try {
        delete process.env.TEST_PW_CHAIN2;

        const provider = PasswordProvider.chain([
          PasswordProvider.fromEnv('TEST_PW_CHAIN2'),
          PasswordProvider.fromCallback(async () => 'from-callback'),
        ]);

        const password = await provider.getPassword({ reason: 'unlock' });
        expect(password).toBe('from-callback');
      } finally {
        if (original !== undefined) {
          process.env.TEST_PW_CHAIN2 = original;
        }
      }
    });
  });

  describe('fromTty()', () => {
    test('throws when stdin is not a TTY', async () => {
      // In test environments, stdin is typically not a TTY
      if (process.stdin.isTTY) {
        // Skip — cannot reliably test this in a TTY environment
        return;
      }

      const provider = PasswordProvider.fromTty();
      await expect(provider.getPassword({ reason: 'unlock' })).rejects.toThrow(
        'stdin is not a TTY'
      );
    });

    test('uses custom prompt text', () => {
      const provider = PasswordProvider.fromTty({ prompt: 'Enter passphrase: ' });
      expect(provider).toBeDefined();
      expect(typeof provider.getPassword).toBe('function');
    });

    test('uses default prompt when none specified', () => {
      const provider = PasswordProvider.fromTty();
      expect(provider).toBeDefined();
    });
  });

  describe('fromDevTty()', () => {
    test('can be constructed with default options', () => {
      const provider = PasswordProvider.fromDevTty();
      expect(provider).toBeDefined();
      expect(typeof provider.getPassword).toBe('function');
    });

    test('can be constructed with custom prompt', () => {
      const provider = PasswordProvider.fromDevTty({ prompt: 'Passphrase: ' });
      expect(provider).toBeDefined();
    });

    // Note: readPasswordDevTty is tested separately below.
  });

  describe('interface compliance', () => {
    test('all factories return objects with getPassword method', () => {
      const providers = [
        PasswordProvider.fromEnv('TEST'),
        PasswordProvider.fromCallback(async () => 'pw'),
        PasswordProvider.fromTty(),
        PasswordProvider.fromDevTty(),
        PasswordProvider.chain([PasswordProvider.fromCallback(async () => 'pw')]),
      ];

      for (const provider of providers) {
        expect(typeof provider.getPassword).toBe('function');
      }
    });
  });

  describe('readPasswordRawMode()', () => {
    test('reads typed characters and resolves on Enter', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();

      const promise = readPasswordRawMode(stdin, stdout, 'Password: ');

      // Simulate typing "hello" then pressing Enter
      stdin.feedChars('hello\n');

      const password = await promise;
      expect(password).toBe('hello');
    });

    test('writes prompt to stdout', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();

      const promise = readPasswordRawMode(stdin, stdout, 'Vault password: ');
      stdin.feedChar('\n');

      await promise;
      expect(stdout.output[0]).toBe('Vault password: ');
    });

    test('writes newline to stdout after Enter', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();

      const promise = readPasswordRawMode(stdin, stdout, 'PW: ');
      stdin.feedChar('\n');

      await promise;
      expect(stdout.output).toEqual(['PW: ', '\n']);
    });

    test('handles carriage return as Enter', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();

      const promise = readPasswordRawMode(stdin, stdout, '> ');
      stdin.feedChars('test\r');

      const password = await promise;
      expect(password).toBe('test');
    });

    test('handles backspace (code 127)', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();

      const promise = readPasswordRawMode(stdin, stdout, '> ');

      // Type "ab", backspace, "c", Enter → "ac"
      stdin.feedChars('ab');
      stdin.feedChar(String.fromCharCode(127)); // backspace
      stdin.feedChars('c\n');

      const password = await promise;
      expect(password).toBe('ac');
    });

    test('handles delete (code 8)', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();

      const promise = readPasswordRawMode(stdin, stdout, '> ');

      stdin.feedChars('xyz');
      stdin.feedChar(String.fromCharCode(8)); // delete
      stdin.feedChar('\n');

      const password = await promise;
      expect(password).toBe('xy');
    });

    test('ignores backspace on empty buffer', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();

      const promise = readPasswordRawMode(stdin, stdout, '> ');

      // Backspace on empty buffer, then type "a", Enter
      stdin.feedChar(String.fromCharCode(127));
      stdin.feedChar(String.fromCharCode(8));
      stdin.feedChars('a\n');

      const password = await promise;
      expect(password).toBe('a');
    });

    test('rejects on Ctrl-C (code 3)', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();

      const promise = readPasswordRawMode(stdin, stdout, '> ');

      stdin.feedChars('par');
      stdin.feedChar(String.fromCharCode(3)); // Ctrl-C

      await expect(promise).rejects.toThrow('cancelled by user');
    });

    test('ignores control characters below code 32', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();

      const promise = readPasswordRawMode(stdin, stdout, '> ');

      // Tab (9), escape (27), and other control chars should be ignored
      stdin.feedChar(String.fromCharCode(9)); // tab
      stdin.feedChar(String.fromCharCode(27)); // escape
      stdin.feedChar(String.fromCharCode(1)); // Ctrl-A
      stdin.feedChars('ok\n');

      const password = await promise;
      expect(password).toBe('ok');
    });

    test('returns empty string when Enter pressed immediately', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();

      const promise = readPasswordRawMode(stdin, stdout, '> ');
      stdin.feedChar('\n');

      const password = await promise;
      expect(password).toBe('');
    });

    test('handles unicode characters', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();

      const promise = readPasswordRawMode(stdin, stdout, '> ');
      stdin.feedChars('\u00e9\u00fc\n'); // é, ü

      const password = await promise;
      expect(password).toBe('\u00e9\u00fc');
    });
  });

  describe('readPasswordDevTty()', () => {
    /** Create a mock DevTtyIo that simulates /dev/tty with given input. */
    function createMockDevTtyIo(input: string): DevTtyIo & {
      writes: Array<{ fd: number; data: string }>;
      execCalls: string[];
      closedFds: number[];
    } {
      const encoder = new TextEncoder();
      const inputBytes = encoder.encode(input);
      let readOffset = 0;

      const writes: Array<{ fd: number; data: string }> = [];
      const execCalls: string[] = [];
      const closedFds: number[] = [];

      return {
        writes,
        execCalls,
        closedFds,
        openSync(_path: string, flags: string): number {
          return flags === 'r' ? 10 : 11; // fake fds
        },
        readSync(_fd: number, buf: Uint8Array, offset: number, length: number): number {
          if (readOffset >= inputBytes.length) { return 0; }
          const chunk = inputBytes.subarray(readOffset, readOffset + length);
          buf.set(chunk, offset);
          readOffset += chunk.length;
          return chunk.length;
        },
        writeSync(fd: number, data: string): number {
          writes.push({ fd, data });
          return data.length;
        },
        closeSync(fd: number): void {
          closedFds.push(fd);
        },
        execSync(cmd: string): void {
          execCalls.push(cmd);
        },
      };
    }

    test('reads password until newline', async () => {
      const io = createMockDevTtyIo('secret\n');
      const password = await readPasswordDevTty('Password: ', io);
      expect(password).toBe('secret');
    });

    test('reads password until carriage return', async () => {
      const io = createMockDevTtyIo('mypass\r');
      const password = await readPasswordDevTty('PW: ', io);
      expect(password).toBe('mypass');
    });

    test('writes prompt to write fd', async () => {
      const io = createMockDevTtyIo('x\n');
      await readPasswordDevTty('Enter password: ', io);
      expect(io.writes[0]).toEqual({ fd: 11, data: 'Enter password: ' });
    });

    test('writes trailing newline after password', async () => {
      const io = createMockDevTtyIo('pw\n');
      await readPasswordDevTty('> ', io);
      const lastWrite = io.writes[io.writes.length - 1];
      expect(lastWrite).toEqual({ fd: 11, data: '\n' });
    });

    test('calls stty -echo before reading and stty echo after', async () => {
      const io = createMockDevTtyIo('pass\n');
      await readPasswordDevTty('> ', io);
      expect(io.execCalls[0]).toBe('stty -echo < /dev/tty');
      expect(io.execCalls[1]).toBe('stty echo < /dev/tty');
    });

    test('closes both file descriptors in finally', async () => {
      const io = createMockDevTtyIo('pass\n');
      await readPasswordDevTty('> ', io);
      expect(io.closedFds).toContain(10); // read fd
      expect(io.closedFds).toContain(11); // write fd
    });

    test('returns empty string when immediate newline', async () => {
      const io = createMockDevTtyIo('\n');
      const password = await readPasswordDevTty('> ', io);
      expect(password).toBe('');
    });

    test('handles EOF (zero bytes read)', async () => {
      const io = createMockDevTtyIo('');
      const password = await readPasswordDevTty('> ', io);
      expect(password).toBe('');
    });

    test('throws when openSync fails', async () => {
      const io = createMockDevTtyIo('');
      io.openSync = (): number => { throw new Error('ENOENT'); };

      await expect(readPasswordDevTty('> ', io)).rejects.toThrow(
        'cannot open /dev/tty'
      );
    });

    test('continues when stty -echo fails', async () => {
      const io = createMockDevTtyIo('pass\n');
      io.execSync = (cmd: string): void => {
        if (cmd.includes('-echo')) { throw new Error('stty not found'); }
        // stty echo in finally — also might fail, that's ok
      };

      const password = await readPasswordDevTty('> ', io);
      expect(password).toBe('pass');
    });

    test('closes fds even if read throws', async () => {
      const io = createMockDevTtyIo('');
      io.readSync = (): number => { throw new Error('read error'); };

      try {
        await readPasswordDevTty('> ', io);
      } catch {
        // expected
      }

      expect(io.closedFds).toContain(10);
      expect(io.closedFds).toContain(11);
    });
  });
});
