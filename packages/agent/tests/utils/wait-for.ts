import { sleep } from '@enbox/common';

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options?: { intervalMs?: number; message?: string; timeoutMs?: number },
): Promise<void> {
  const intervalMs = options?.intervalMs ?? 5;
  const timeoutMs = options?.timeoutMs ?? 1_000;
  const message = options?.message ?? 'Timed out waiting for condition.';
  const expiresAt = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= expiresAt) {
      throw new Error(message);
    }
    await sleep(intervalMs);
  }
}
