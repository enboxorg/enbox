/**
 * Ambient type declarations for `bun:test` used during the tsc build.
 *
 * Bun runs tests directly with its own TS transpiler, so bun-types provides
 * full type checking at dev time. However, the tsc build (which compiles tests
 * for the published `@enbox/dwn-sdk-js/tests` export) cannot use bun-types
 * because it conflicts with the ES6 lib target. This shim provides just
 * enough type information for tsc to emit JS and .d.ts without errors.
 */
declare module 'bun:test' {
  type TestFn = (name: string, fn: () => void | Promise<void>, timeout?: number) => void;
  type SuiteFn = (name: string, fn: () => void) => void;
  type HookFn = (fn: () => void | Promise<void>, timeout?: number) => void;

  export const describe: SuiteFn & { skip: SuiteFn; only: SuiteFn; todo: SuiteFn; skipIf: (condition: boolean) => SuiteFn };
  export const it: TestFn & { skip: TestFn; only: TestFn; todo: TestFn; skipIf: (condition: boolean) => TestFn };
  export const test: TestFn & { skip: TestFn; only: TestFn; todo: TestFn; skipIf: (condition: boolean) => TestFn };
  export const beforeAll: HookFn;
  export const afterAll: HookFn;
  export const beforeEach: HookFn;
  export const afterEach: HookFn;

  interface Expect<T = unknown> {
    toBe(expected: any, message?: string): void;
    toEqual(expected: any, message?: string): void;
    toStrictEqual(expected: any): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toBeCloseTo(expected: number, numDigits?: number): void;
    toBeInstanceOf(expected: any): void;
    toContain(expected: any): void;
    toContainEqual(expected: any): void;
    toHaveLength(expected: number): void;
    toHaveProperty(path: string | string[], value?: any): void;
    toMatch(expected: string | RegExp): void;
    toThrow(expected?: string | RegExp | Error | (new (...args: any[]) => any)): void;
    toBeNaN(): void;
    toHaveBeenCalled(): void;
    toHaveBeenCalledTimes(count: number): void;
    toHaveBeenCalledWith(...args: any[]): void;
    not: Expect<T>;
    resolves: Expect<T>;
    rejects: Expect<T>;
  }

  interface ExpectStatic {
    <T>(value: T, message?: string): Expect<T>;
    arrayContaining(arr: any[]): any;
    objectContaining(obj: Record<string, any>): any;
    stringContaining(str: string): any;
    any(constructor: any): any;
    anything(): any;
  }

  export const expect: ExpectStatic;

  interface SpyInstance {
    mockResolvedValue(value: any): SpyInstance;
    mockResolvedValueOnce(value: any): SpyInstance;
    mockReturnValue(value: any): SpyInstance;
    mockReturnValueOnce(value: any): SpyInstance;
    mockImplementation(fn: (...args: any[]) => any): SpyInstance;
    mockImplementationOnce(fn: (...args: any[]) => any): SpyInstance;
    mockReset(): void;
    mockRestore(): void;
    mockClear(): void;
    calls: any[][];
    results: any[];
  }

  export function spyOn(object: any, method: string): SpyInstance;

  export const mock: {
    restore(): void;
    module(path: string, factory: () => any): void;
  };
}
