import type { Enbox } from '../enbox.js';

/** @internal SDK access and cleanup for one feature within an application session scope. */
export interface StoreScope {
  /** Ends this feature's authority before its asynchronous cleanup runs. */
  readonly signal: AbortSignal;
  /** Return the captured SDK facade after validating the current session scope. */
  getEnbox(): Enbox;
  /** Require a connected, current scope; throws when inactive or retired. */
  assertCurrent(): void;
  /** Register resource release; late registrations are scheduled immediately. */
  onClose(close: () => void | Promise<void>): void;
}

/** An inactive application cannot issue protocol operations. */
export class StoreNotConnectedError extends Error {
  public constructor() {
    super('The application has no usable Enbox session.');
    this.name = 'StoreNotConnectedError';
  }
}

/** Captured resources never acquire replacement-session authority. */
export class StoreRetiredError extends Error {
  public constructor() {
    super('This store belongs to a retired application session.');
    this.name = 'StoreRetiredError';
  }
}

/** @internal Display arbitrary rejections without changing their original promise outcome. */
export function toStoreError(cause: unknown): Error {
  try {
    return cause instanceof Error ? cause : new Error(String(cause), { cause });
  } catch {
    return new Error('An Enbox store operation failed.', { cause });
  }
}
