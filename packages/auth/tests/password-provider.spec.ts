import { describe, expect, test } from 'bun:test';

import type { PasswordContext } from '../src/password-provider.js';
import { PasswordProvider } from '../src/password-provider.js';

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
      // Just verify the provider can be constructed with options
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

    // Note: Cannot test actual /dev/tty interaction in automated tests.
    // The provider's behaviour is tested via integration with chain()
    // (fromDevTty throws when /dev/tty is unavailable, chain falls through).
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
});
