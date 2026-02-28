/**
 * fast-check arbitraries for generating DWN message structures.
 * Used across multiple fuzz test files to generate valid, semi-valid, and invalid messages.
 */
import type { Arbitrary } from 'fast-check';

import fc from 'fast-check';

/** The set of valid DWN interface names. */
const dwnInterfaces = ['Records', 'Protocols', 'Messages'] as const;

/** Map from interface name to the set of valid method names. */
const dwnMethodsByInterface: Record<string, string[]> = {
  Records   : ['Write', 'Query', 'Read', 'Delete', 'Count', 'Subscribe'],
  Protocols : ['Configure', 'Query'],
  Messages  : ['Read', 'Subscribe', 'Sync'],
};

/** All valid (interface, method) pairs. */
const validInterfaceMethodPairs: [string, string][] = dwnInterfaces.flatMap(
  (iface) => dwnMethodsByInterface[iface].map((method): [string, string] => [iface, method])
);

/**
 * Generates a valid DWN interface+method pair.
 */
export function validInterfaceMethod(): Arbitrary<{ interface: string; method: string }> {
  return fc.constantFrom(...validInterfaceMethodPairs).map(([iface, method]) => ({
    interface : iface,
    method    : method,
  }));
}

/**
 * Generates a minimal DWN descriptor with valid interface and method.
 */
export function validDescriptor(): Arbitrary<Record<string, unknown>> {
  return fc.record({
    interfaceMethod  : validInterfaceMethod(),
    messageTimestamp : fc.constant('2024-01-01T00:00:00.000000Z'),
  }).map(({ interfaceMethod, messageTimestamp }) => ({
    interface        : interfaceMethod.interface,
    method           : interfaceMethod.method,
    messageTimestamp : messageTimestamp,
  }));
}

/**
 * Generates a completely arbitrary JSON object — used for negative/crash testing.
 */
export function arbitraryJsonObject(): Arbitrary<Record<string, unknown>> {
  return fc.dictionary(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.double({ noNaN: true }),
    ),
    { minKeys: 0, maxKeys: 10 },
  );
}

/**
 * Generates an object that looks vaguely like a DWN message but with random
 * descriptor contents. Exercises the schema validation layer.
 */
export function semiValidMessage(): Arbitrary<Record<string, unknown>> {
  return fc.record({
    descriptor: fc.record({
      interface        : fc.oneof(fc.constantFrom(...dwnInterfaces), fc.string({ minLength: 1, maxLength: 20 })),
      method           : fc.string({ minLength: 1, maxLength: 20 }),
      messageTimestamp : fc.oneof(fc.constant('2024-01-01T00:00:00.000000Z'), fc.string()),
    }),
    extraKeys: arbitraryJsonObject(),
  }).map(({ descriptor, extraKeys }) => ({
    descriptor,
    ...extraKeys,
  }));
}

/**
 * Generates a message that is completely arbitrary — may or may not have a descriptor.
 * This is the most aggressive fuzz target for processMessage().
 */
export function arbitraryMessage(): Arbitrary<unknown> {
  return fc.oneof(
    // Completely random JSON
    arbitraryJsonObject(),
    // Has descriptor but with random content
    semiValidMessage(),
    // Primitive types
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    // Array
    fc.array(fc.oneof(fc.string(), fc.integer(), fc.boolean())),
  );
}
