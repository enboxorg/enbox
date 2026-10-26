import type { StoreScope } from '../src/store/scope.js';

import { describe, expect, it } from 'bun:test';

import { createCommand } from '../src/store/command.js';
import { StoreRetiredError } from '../src/store/scope.js';

function createScope(): { scope: StoreScope; retire(): void } {
  const controller = new AbortController();
  const scope: StoreScope = {
    signal        : controller.signal,
    assertCurrent : (): void => {
      if (controller.signal.aborted) { throw new StoreRetiredError(); }
    },
    getEnbox : (): never => { throw new Error('Command fixture does not read protocols.'); },
    onClose  : (): void => {},
  };
  return { scope, retire: (): void => { controller.abort(); } };
}

describe('store commands', () => {
  it('preserves arbitrary rejected values while safely publishing a display error', async () => {
    const { scope } = createScope();
    const reason: object = Object.create(null);
    const command = createCommand(scope, (): Promise<never> => Promise.reject(reason));
    await expect(command.run(undefined)).rejects.toBe(reason);
    expect(command.getSnapshot().error).toBeInstanceOf(Error);
    expect(command.getSnapshot().error?.cause).toBe(reason);
    expect(command.getSnapshot().pendingCount).toBe(0);
  });

  it('preserves operation promises and tracks every concurrent input', async () => {
    const { scope } = createScope();
    let finishFirst!: (value: string) => void;
    let failSecond!: (reason: Error) => void;
    const first = new Promise<string>((resolve) => { finishFirst = resolve; });
    const second = new Promise<string>((_resolve, reject) => { failSecond = reject; });
    const command = createCommand(scope, (input: number) => input === 1 ? first : second);

    expect(command.run(1)).toBe(first);
    expect(command.run(2)).toBe(second);
    expect(command.getSnapshot().pendingVariables).toEqual([1, 2]);
    expect(command.getSnapshot().pendingCount).toBe(2);
    finishFirst('written');
    await first;
    expect(command.getSnapshot().pendingVariables).toEqual([2]);
    const failure = new Error('Rejected by owner');
    failSecond(failure);
    await expect(second).rejects.toBe(failure);
    expect(command.getSnapshot().pendingCount).toBe(0);
    expect(command.getSnapshot().error).toBe(failure);
    expect(command.getServerSnapshot().pendingCount).toBe(0);
  });

  it('keeps older failures from overwriting a newer outcome', async () => {
    const { scope } = createScope();
    let failFirst!: (reason: Error) => void;
    const first = new Promise<string>((_resolve, reject) => { failFirst = reject; });
    const command = createCommand(scope, (input: number) => input === 1 ? first : Promise.resolve('newer'));
    command.run(1);
    await command.run(2);
    failFirst(new Error('Old failure'));
    await expect(first).rejects.toThrow('Old failure');
    expect(command.getSnapshot().error).toBeUndefined();
    expect(command.getSnapshot().pendingCount).toBe(0);
  });

  it('fences a command retired by a pending-state subscriber before dispatch', async () => {
    const { scope, retire } = createScope();
    let calls = 0;
    const command = createCommand(scope, (): void => { calls += 1; });
    command.subscribe((snapshot): void => {
      if (snapshot.pendingCount > 0) { retire(); }
    });
    await expect(command.run(undefined)).rejects.toBeInstanceOf(StoreRetiredError);
    expect(calls).toBe(0);
    expect(command.getSnapshot().pendingCount).toBe(0);
    expect(command.isCurrent()).toBe(false);
  });

  it('preserves issued write outcomes while ignoring completion after retirement', async () => {
    const { scope, retire } = createScope();
    let finish!: (value: string) => void;
    const native = new Promise<string>((resolve) => { finish = resolve; });
    const command = createCommand(scope, () => native);
    const issued = command.run(undefined);
    retire();
    const retiredSnapshot = command.getSnapshot();
    finish('already committed');
    expect(await issued).toBe('already committed');
    expect(command.getSnapshot()).toBe(retiredSnapshot);
    await expect(command.run(undefined)).rejects.toBeInstanceOf(StoreRetiredError);
  });
});
