/**
 * fast-check arbitraries for generating store-layer data structures:
 * IndexedItems, KeyValues for indexing, GenericMessage-like objects, and data blobs.
 */
import type { Arbitrary } from 'fast-check';
import type { GenericMessage } from '../../../src/types/message-types.js';
import type { KeyValues } from '../../../src/types/query-types.js';

import fc from 'fast-check';

/**
 * Generates a hex string of a given length range.
 * Replaces `fc.hexaString` which was removed in fast-check v4.
 */
function hexString(opts: { minLength: number; maxLength: number }): Arbitrary<string> {
  return fc.stringMatching(
    new RegExp(`^[0-9a-f]{${opts.minLength},${opts.maxLength}}$`)
  );
}

/** Property names commonly indexed in DWN messages. */
const indexPropertyNames = [
  'protocol', 'protocolPath', 'schema', 'contextId',
  'recordId', 'parentId', 'recipient', 'author',
  'dataFormat', 'attester',
];

/**
 * Generates a plausible messageCid string.
 * Uses a simplified format — real CIDs are longer but we need unique, deterministic strings.
 */
export function messageCid(): Arbitrary<string> {
  return hexString({ minLength: 20, maxLength: 40 }).map((hex) => `bafyrei${hex}`);
}

/**
 * Generates a DWN-style ISO-8601 timestamp with microsecond precision.
 * Filters out invalid dates that `fc.date()` may produce.
 */
export function dwnTimestamp(): Arbitrary<string> {
  return fc.date({
    min : new Date('2020-01-01T00:00:00Z'),
    max : new Date('2030-12-31T23:59:59Z'),
  }).filter((d) => !isNaN(d.getTime()))
    .map((d) => d.toISOString().replace('Z', '000Z'));
}

/**
 * Generates KeyValues suitable for indexing in IndexLevel.
 * Always includes a sortable timestamp property.
 *
 * All non-timestamp index values are strings, matching real-world DWN behaviour
 * where protocol, protocolPath, schema, etc. are always URIs or path strings.
 */
export function indexKeyValues(): Arbitrary<KeyValues> {
  return fc.record({
    timestamps: fc.record({
      messageTimestamp : dwnTimestamp(),
      dateCreated      : dwnTimestamp(),
    }),
    properties: fc.dictionary(
      fc.constantFrom(...indexPropertyNames),
      fc.string({ minLength: 1, maxLength: 30 }),
      { minKeys: 1, maxKeys: 4 },
    ),
  }).map(({ timestamps, properties }) => ({
    ...timestamps,
    ...properties,
  }));
}

/**
 * Generates a set of N indexed items (messageCid + KeyValues) with unique CIDs.
 * All items share the same sort properties to ensure they are comparable.
 */
export function indexedItemSet(opts: { minSize?: number; maxSize?: number } = {}): Arbitrary<{ cid: string; indexes: KeyValues }[]> {
  const { minSize = 3, maxSize = 15 } = opts;
  return fc.array(
    fc.record({
      cid     : messageCid(),
      indexes : indexKeyValues(),
    }),
    { minLength: minSize, maxLength: maxSize }
  ).map((items) => {
    // Ensure unique CIDs by appending index
    return items.map((item, i) => ({
      ...item,
      cid: `${item.cid}${String(i).padStart(4, '0')}`,
    }));
  });
}

/**
 * Generates a tenant DID string.
 */
export function tenantDid(): Arbitrary<string> {
  return hexString({ minLength: 10, maxLength: 20 }).map((hex) => `did:example:${hex}`);
}

/**
 * Generates arbitrary binary data suitable for DataStore testing.
 */
export function dataBlob(opts: { minSize?: number; maxSize?: number } = {}): Arbitrary<Uint8Array> {
  const { minSize = 1, maxSize = 1024 } = opts;
  return fc.uint8Array({ minLength: minSize, maxLength: maxSize });
}

/**
 * Generates a record ID string.
 */
export function recordId(): Arbitrary<string> {
  return hexString({ minLength: 10, maxLength: 30 }).map((hex) => `rec_${hex}`);
}

/** DWN interface names. */
const dwnInterfaces = ['Records', 'Protocols', 'Messages', 'Events', 'Permissions'] as const;

/** DWN method names. */
const dwnMethods = ['Write', 'Query', 'Read', 'Delete', 'Configure', 'Subscribe', 'Request', 'Revoke', 'Grant'] as const;

/**
 * Generates a minimal GenericMessage with a valid descriptor.
 * The message is CID-computable (DAG-CBOR + SHA-256) via `Message.getCid()`.
 *
 * Each generated message has a unique descriptor (varied interface, method, timestamp,
 * and an optional extra field) so that different messages produce different CIDs.
 */
export function genericMessage(): Arbitrary<GenericMessage> {
  return fc.record({
    interface        : fc.constantFrom(...dwnInterfaces),
    method           : fc.constantFrom(...dwnMethods),
    messageTimestamp : dwnTimestamp(),
    nonce            : hexString({ minLength: 4, maxLength: 16 }),
  }).map(({ interface: iface, method, messageTimestamp, nonce }) => ({
    descriptor: {
      interface: iface,
      method,
      messageTimestamp,
      nonce, // extra field to ensure unique CIDs across generated messages
    },
  }));
}

/**
 * Generates a set of N GenericMessage objects with guaranteed unique descriptors.
 * Returns messages paired with their index KeyValues for MessageStoreLevel.put().
 */
export function genericMessageSet(opts: { minSize?: number; maxSize?: number } = {}): Arbitrary<{ message: GenericMessage; indexes: KeyValues }[]> {
  const { minSize = 3, maxSize = 10 } = opts;
  return fc.array(
    fc.record({
      message : genericMessage(),
      indexes : indexKeyValues(),
    }),
    { minLength: minSize, maxLength: maxSize }
  ).map((items) => {
    // Ensure unique messages by appending unique nonce suffix
    return items.map((item, i) => ({
      message: {
        descriptor: {
          ...item.message.descriptor,
          nonce: `${(item.message.descriptor as Record<string, unknown>).nonce}_${String(i).padStart(4, '0')}`,
        },
      },
      indexes: {
        ...item.indexes,
        messageTimestamp: item.indexes.messageTimestamp as string,
      },
    }));
  });
}
