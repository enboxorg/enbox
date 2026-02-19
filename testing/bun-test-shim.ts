/**
 * Shim that maps bun-test imports to vitest equivalents.
 *
 * Used by Vitest browser mode configs via resolve.alias.
 * This allows the same test files to run under both bun test (native)
 * and vitest --browser (real browsers via Playwright).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

/** Creates a mock function (equivalent to vi.fn). */
function mock(fn?: (...args: unknown[]) => unknown): ReturnType<typeof vi.fn> {
  return fn ? vi.fn(fn as any) : vi.fn();
}

/** Restores all mocks (equivalent to vi.restoreAllMocks). */
mock.restore = (): void => {
  vi.restoreAllMocks();
};

/**
 * Module mocking — not supported in Vitest browser mode.
 * bun:test mock.module() maps to vi.mock() which requires static hoisting.
 * In browser mode, use vi.mock with { spy: true } instead.
 */
mock.module = (_id: string, _factory?: () => Record<string, unknown>): void => {
  throw new Error('mock.module() is not supported in Vitest browser mode. Use vi.mock() directly in test files.');
};

const spyOn = vi.spyOn.bind(vi);

export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
};
