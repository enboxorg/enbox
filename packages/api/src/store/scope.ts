import type { Enbox } from '../enbox.js';

/** Resources and commands belonging to one exact authorization generation. */
export interface StoreScope {
  readonly signal: AbortSignal;
  getEnbox(): Enbox;
  assertCurrent(): void;
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
