/**
 * Integration tests for `createProfileReader` against a real in-process DWN
 * engine (`@enbox/dwn-sdk-js`), exercising real protocol authorization:
 *
 * - the profile JSON singleton is written PUBLISHED (queryable by anyone),
 * - the avatar singleton is written UNPUBLISHED — queries cannot see it,
 *   but its `{ who: 'anyone', can: ['read'] }` rule makes a direct
 *   `RecordsRead` succeed (authorization-gated, not publication-gated) —
 *   the wallet write shape the reader is built for.
 *
 * Two sources are covered end to end:
 * - the real `DwnReaderApi` (the `Enbox.anonymous()` surface) over a local
 *   transport that swaps only the network hop for `dwn.processMessage()` —
 *   message construction stays the real unsigned-path code, and
 * - a signed records surface (a second identity, Bob) matching the shape a
 *   connected `DwnApi` presents.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { AnonymousDwnApi } from '@enbox/agent';
import type { BearerDid } from '@enbox/dids';
import type {
  DateSort,
  Pagination,
  PrivateKeyJwk,
  ProtocolDefinition,
  RecordsFilter,
  RecordsQueryReply,
  RecordsReadReply,
} from '@enbox/dwn-sdk-js';

import type { ProfileReaderRecordsSurface } from '../src/profile-reader.js';

import { rm } from 'node:fs/promises';

import { createProfileReader } from '../src/profile-reader.js';
import { DidJwk } from '@enbox/dids';
import { ProfileDefinition } from '../src/profile.js';
import { SocialGraphDefinition } from '../src/social-graph.js';
import { DataStoreLevel, MessageStoreLevel, ResumableTaskStoreLevel } from '@enbox/dwn-sdk-js/stores/level';
import {
  DataStream,
  Dwn,
  Encoder,
  PrivateKeySigner,
  ProtocolsConfigure,
  RecordsQuery,
  RecordsRead,
  RecordsWrite,
} from '@enbox/dwn-sdk-js';
import { DwnReaderApi, ReadOnlyRecord } from '@enbox/api';

const TEST_DATA_DIR = '__TESTDATA__/profile-reader-dwn';

const AVATAR_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const PROFILE_DATA = {
  displayName : 'Alice Example',
  bio         : 'Decentralized identity enthusiast',
  tagline     : 'hello from the DWN',
};

/**
 * Local replacement for the network transport underneath `DwnReaderApi`:
 * identical unsigned message construction (`RecordsQuery.create` /
 * `RecordsRead.create` without a signer), processed by the in-process DWN
 * instead of being sent over RPC.
 */
class LocalAnonymousTransport {
  private readonly _dwn: Dwn;

  constructor(dwn: Dwn) {
    this._dwn = dwn;
  }

  public async recordsQuery(
    target: string,
    params: { filter: RecordsFilter; dateSort?: DateSort; pagination?: Pagination },
  ): Promise<RecordsQueryReply> {
    const query = await RecordsQuery.create({
      filter     : params.filter,
      dateSort   : params.dateSort,
      pagination : params.pagination,
    });
    return await this._dwn.processMessage(target, query.message);
  }

  public async recordsRead(target: string, params: { filter: RecordsFilter }): Promise<RecordsReadReply> {
    const read = await RecordsRead.create({ filter: params.filter });
    return await this._dwn.processMessage(target, read.message);
  }
}

/** Create a message signer for a `did:jwk` bearer DID. */
async function signerForDid(did: BearerDid): Promise<PrivateKeySigner> {
  const portable = await did.export();
  const privateKey = portable.privateKeys?.[0];
  if (privateKey === undefined) {
    throw new Error('test setup: expected an exportable private key');
  }
  return new PrivateKeySigner({
    privateJwk : privateKey as PrivateKeyJwk,
    algorithm  : 'EdDSA',
    keyId      : `${did.uri}#0`,
  });
}

/**
 * A records surface backed by SIGNED messages from `signer` — the shape a
 * connected `DwnApi` presents (a non-owner identity reading someone else's
 * DWN), minus the agent plumbing.
 */
function signedRecordsSurface(dwn: Dwn, signer: PrivateKeySigner, transport: LocalAnonymousTransport): ProfileReaderRecordsSurface {
  const anonymousDwn = transport as unknown as AnonymousDwnApi;
  return {
    query: async ({ from, filter }): ReturnType<ProfileReaderRecordsSurface['query']> => {
      const query = await RecordsQuery.create({ filter, signer });
      const reply = await dwn.processMessage(from, query.message);
      return {
        status  : reply.status,
        records : (reply.entries ?? []).map((entry) => new ReadOnlyRecord({
          rawMessage   : entry,
          encodedData  : entry.encodedData,
          remoteOrigin : from,
          anonymousDwn,
        })),
      };
    },
    read: async ({ from, filter }): ReturnType<ProfileReaderRecordsSurface['read']> => {
      const read = await RecordsRead.create({ filter, signer });
      const reply = await dwn.processMessage(from, read.message);
      const entry = reply.entry;
      return {
        status : reply.status,
        record : entry?.recordsWrite === undefined ? undefined : new ReadOnlyRecord({
          rawMessage   : entry.recordsWrite,
          initialWrite : entry.initialWrite,
          data         : entry.data,
          remoteOrigin : from,
          anonymousDwn,
        }),
      };
    },
  };
}

describe('createProfileReader against an in-process DWN', () => {
  let dwn: Dwn;
  let messageStore: MessageStoreLevel;
  let dataStore: DataStoreLevel;
  let resumableTaskStore: ResumableTaskStoreLevel;
  let alice: BearerDid;
  let bob: BearerDid;
  let localTransport: LocalAnonymousTransport;

  beforeAll(async () => {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });

    messageStore = new MessageStoreLevel({ location: `${TEST_DATA_DIR}/MESSAGESTORE` });
    dataStore = new DataStoreLevel({ blockstoreLocation: `${TEST_DATA_DIR}/DATASTORE` });
    resumableTaskStore = new ResumableTaskStoreLevel({ location: `${TEST_DATA_DIR}/TASKSTORE` });
    dwn = await Dwn.create({ messageStore, dataStore, resumableTaskStore });

    alice = await DidJwk.create();
    bob = await DidJwk.create();
    const aliceSigner = await signerForDid(alice);
    localTransport = new LocalAnonymousTransport(dwn);

    // Install the protocols on Alice's DWN the way a wallet does: Social
    // Graph first (Profile composes with it via `uses`), then Profile.
    for (const definition of [SocialGraphDefinition, ProfileDefinition]) {
      const configure = await ProtocolsConfigure.create({
        definition : definition as ProtocolDefinition,
        signer     : aliceSigner,
      });
      const configureReply = await dwn.processMessage(alice.uri, configure.message);
      expect(configureReply.status.code).toBe(202);
    }

    // Wallet write shape: the profile JSON singleton is PUBLISHED...
    const profileBytes = Encoder.objectToBytes(PROFILE_DATA);
    const profileWrite = await RecordsWrite.create({
      signer       : aliceSigner,
      protocol     : ProfileDefinition.protocol,
      protocolPath : 'profile',
      schema       : ProfileDefinition.types.profile.schema,
      dataFormat   : 'application/json',
      published    : true,
      data         : profileBytes,
    });
    const profileReply = await dwn.processMessage(alice.uri, profileWrite.message, {
      dataStream: DataStream.fromBytes(profileBytes),
    });
    expect(profileReply.status.code).toBe(202);

    // ...while the avatar singleton is written UNPUBLISHED (anyone-read only).
    const avatarWrite = await RecordsWrite.create({
      signer          : aliceSigner,
      protocol        : ProfileDefinition.protocol,
      protocolPath    : 'profile/avatar',
      parentContextId : profileWrite.message.contextId,
      dataFormat      : 'image/png',
      data            : AVATAR_BYTES,
    });
    const avatarReply = await dwn.processMessage(alice.uri, avatarWrite.message, {
      dataStream: DataStream.fromBytes(AVATAR_BYTES),
    });
    expect(avatarReply.status.code).toBe(202);
  });

  afterAll(async () => {
    await dwn.close();
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('should confirm the wallet write shape: queries cannot see the unpublished avatar, but an anonymous read can', async () => {
    // An anonymous protocol-wide query returns only the published profile JSON.
    const queryReply = await localTransport.recordsQuery(alice.uri, {
      filter: { protocol: ProfileDefinition.protocol },
    });
    expect(queryReply.status.code).toBe(200);
    const paths = (queryReply.entries ?? []).map((entry) => entry.descriptor.protocolPath);
    expect(paths).toEqual(['profile']);

    // A direct anonymous RecordsRead of the avatar path succeeds via anyone-read.
    const readReply = await localTransport.recordsRead(alice.uri, {
      filter: { protocol: ProfileDefinition.protocol, protocolPath: 'profile/avatar' },
    });
    expect(readReply.status.code).toBe(200);
    expect(readReply.entry?.recordsWrite?.descriptor.published).not.toBe(true);
  });

  describe('anonymous source (real DwnReaderApi over a local transport)', () => {
    it('should resolve displayName and the unpublished-but-readable avatar for a wallet-shaped profile', async () => {
      const anonymousSource = { dwn: new DwnReaderApi(localTransport as unknown as AnonymousDwnApi) };
      const reader = createProfileReader(anonymousSource);

      const profile = await reader.get(alice.uri);

      expect(profile.did).toBe(alice.uri);
      expect(profile.displayName).toBe(PROFILE_DATA.displayName);
      expect(profile.bio).toBe(PROFILE_DATA.bio);
      expect(profile.tagline).toBe(PROFILE_DATA.tagline);

      expect(profile.avatar).toBeInstanceOf(Blob);
      expect(new Uint8Array(await profile.avatar!.arrayBuffer())).toEqual(AVATAR_BYTES);

      // No hero was written: field-level not-found, entry still settled.
      expect(profile.hero).toBeUndefined();
      const snapshot = reader.getSnapshot(alice.uri);
      expect(snapshot?.status).toBe('settled');
      expect(snapshot?.avatar.status).toBe('settled');
      expect(snapshot?.hero.status).toBe('not-found');

      reader.dispose();
    });

    it('should conclude not-found for an identity with no profile', async () => {
      const anonymousSource = { dwn: new DwnReaderApi(localTransport as unknown as AnonymousDwnApi) };
      const reader = createProfileReader(anonymousSource);

      const profile = await reader.get(bob.uri);

      expect(profile).toEqual({ did: bob.uri });
      expect(reader.getSnapshot(bob.uri)?.status).toBe('not-found');

      reader.dispose();
    });
  });

  describe('connected-shaped source (signed queries and reads from a second identity)', () => {
    it('should resolve the same profile through a signed records surface', async () => {
      const bobSigner = await signerForDid(bob);
      const reader = createProfileReader(signedRecordsSurface(dwn, bobSigner, localTransport));

      const profile = await reader.get(alice.uri);

      expect(profile.displayName).toBe(PROFILE_DATA.displayName);
      expect(profile.avatar).toBeInstanceOf(Blob);
      expect(new Uint8Array(await profile.avatar!.arrayBuffer())).toEqual(AVATAR_BYTES);
      expect(profile.hero).toBeUndefined();
      expect(reader.getSnapshot(alice.uri)?.status).toBe('settled');

      reader.dispose();
    });

    it('should support watch() settlement over the signed surface', async () => {
      const bobSigner = await signerForDid(bob);
      const reader = createProfileReader(signedRecordsSurface(dwn, bobSigner, localTransport));

      const settled = new Promise<void>((resolve) => {
        const unwatch = reader.watch([alice.uri], (snapshot) => {
          if (snapshot.status === 'settled') {
            expect(snapshot.profile.value?.displayName).toBe(PROFILE_DATA.displayName);
            expect(snapshot.avatar.value).toBeInstanceOf(Blob);
            unwatch();
            resolve();
          }
        });
      });

      await settled;
      reader.dispose();
    });
  });
});
