/**
 * Integration tests for `createProfileReader` against a real in-process DWN
 * engine (`@enbox/dwn-sdk-js`), exercising real protocol authorization:
 *
 * - the profile JSON singleton is written PUBLISHED (queryable by anyone),
 * - the avatar singleton is written UNPUBLISHED — queries cannot see it,
 *   but its `{ who: 'anyone', can: ['read'] }` rule makes a direct
 *   `RecordsRead` succeed (authorization-gated, not publication-gated) —
 *   the wallet write shape the reader is built for,
 * - a root profile deleted WITHOUT `prune: true` leaves an orphaned avatar
 *   record behind, which the reader must suppress, and
 * - profile JSON is untrusted input: injected `did`/`avatar`/unknown keys
 *   written by a wallet must never survive into reader results.
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
  RecordsDelete,
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
 * Install the profile protocol stack and write a wallet-shaped profile for
 * a tenant: Social Graph first (Profile composes with it via `uses`), a
 * PUBLISHED profile JSON singleton, and optionally an UNPUBLISHED avatar.
 */
async function writeWalletProfile(
  dwn: Dwn,
  did: BearerDid,
  profileJson: Record<string, unknown>,
  options: { avatarBytes?: Uint8Array } = {},
): Promise<{ profileRecordId: string }> {
  const signer = await signerForDid(did);

  for (const definition of [SocialGraphDefinition, ProfileDefinition]) {
    const configure = await ProtocolsConfigure.create({
      definition: definition as ProtocolDefinition,
      signer,
    });
    const configureReply = await dwn.processMessage(did.uri, configure.message);
    if (configureReply.status.code !== 202) {
      throw new Error(`test setup: protocol install failed with ${configureReply.status.code}`);
    }
  }

  const profileBytes = Encoder.objectToBytes(profileJson);
  const profileWrite = await RecordsWrite.create({
    signer,
    protocol     : ProfileDefinition.protocol,
    protocolPath : 'profile',
    schema       : ProfileDefinition.types.profile.schema,
    dataFormat   : 'application/json',
    published    : true,
    data         : profileBytes,
  });
  const profileReply = await dwn.processMessage(did.uri, profileWrite.message, {
    dataStream: DataStream.fromBytes(profileBytes),
  });
  if (profileReply.status.code !== 202) {
    throw new Error(`test setup: profile write failed with ${profileReply.status.code}`);
  }

  if (options.avatarBytes !== undefined) {
    const avatarWrite = await RecordsWrite.create({
      signer,
      protocol        : ProfileDefinition.protocol,
      protocolPath    : 'profile/avatar',
      parentContextId : profileWrite.message.contextId,
      dataFormat      : 'image/png',
      data            : options.avatarBytes,
    });
    const avatarReply = await dwn.processMessage(did.uri, avatarWrite.message, {
      dataStream: DataStream.fromBytes(options.avatarBytes),
    });
    if (avatarReply.status.code !== 202) {
      throw new Error(`test setup: avatar write failed with ${avatarReply.status.code}`);
    }
  }

  return { profileRecordId: profileWrite.message.recordId };
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

  function anonymousSource(): { dwn: DwnReaderApi } {
    return { dwn: new DwnReaderApi(localTransport as unknown as AnonymousDwnApi) };
  }

  beforeAll(async () => {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });

    messageStore = new MessageStoreLevel({ location: `${TEST_DATA_DIR}/MESSAGESTORE` });
    dataStore = new DataStoreLevel({ blockstoreLocation: `${TEST_DATA_DIR}/DATASTORE` });
    resumableTaskStore = new ResumableTaskStoreLevel({ location: `${TEST_DATA_DIR}/TASKSTORE` });
    dwn = await Dwn.create({ messageStore, dataStore, resumableTaskStore });

    alice = await DidJwk.create();
    bob = await DidJwk.create();
    localTransport = new LocalAnonymousTransport(dwn);

    // Alice: the canonical wallet write shape used across the tests below.
    await writeWalletProfile(dwn, alice, PROFILE_DATA, { avatarBytes: AVATAR_BYTES });
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
      const reader = createProfileReader(anonymousSource(), { images: 'eager' });

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

    it('should defer image bytes under the default lazy mode until loadImages() is called', async () => {
      const reader = createProfileReader(anonymousSource());

      const profile = await reader.get(alice.uri);
      expect(profile.displayName).toBe(PROFILE_DATA.displayName);
      expect(profile.avatar).toBeUndefined();
      expect(reader.getSnapshot(alice.uri)?.avatar.status).toBe('idle');

      const images = await reader.loadImages(alice.uri);
      expect(images.avatar).toBeInstanceOf(Blob);
      expect(new Uint8Array(await images.avatar!.arrayBuffer())).toEqual(AVATAR_BYTES);
      expect(images.hero).toBeUndefined();
      expect(reader.getSnapshot(alice.uri)?.avatar.status).toBe('settled');

      reader.dispose();
    });

    it('should conclude not-found for an identity with no profile', async () => {
      const reader = createProfileReader(anonymousSource());

      const profile = await reader.get(bob.uri);

      expect(profile).toEqual({ did: bob.uri });
      expect(reader.getSnapshot(bob.uri)?.status).toBe('not-found');

      reader.dispose();
    });
  });

  describe('untrusted profile JSON (real wallet-written record)', () => {
    it('should strip injected did/avatar/unknown keys and keep the requested DID authoritative', async () => {
      const mallory = await DidJwk.create();
      await writeWalletProfile(dwn, mallory, {
        displayName : 'Mallory',
        did         : 'did:dht:attacker',
        avatar      : 'https://evil.example/fake.png',
        isAdmin     : true,
        bio         : 42,
      });

      const reader = createProfileReader(anonymousSource(), { images: 'eager' });
      const profile = await reader.get(mallory.uri);

      expect(profile.did).toBe(mallory.uri);
      expect(profile.displayName).toBe('Mallory');
      // Injected `did`/`avatar`, unknown `isAdmin`, and the wrong-typed
      // `bio` are all discarded; no avatar record exists, so no Blob.
      expect(Object.keys(profile).sort()).toEqual(['did', 'displayName']);

      reader.dispose();
    });
  });

  describe('orphaned images after a non-pruning root delete', () => {
    it('should resolve a bare profile and suppress the orphaned avatar when the root profile was deleted without prune', async () => {
      const carol = await DidJwk.create();
      const carolSigner = await signerForDid(carol);
      const { profileRecordId } = await writeWalletProfile(dwn, carol, { displayName: 'Carol' }, { avatarBytes: AVATAR_BYTES });

      // Delete the root profile WITHOUT prune — the avatar record stays.
      const rootDelete = await RecordsDelete.create({
        recordId : profileRecordId,
        signer   : carolSigner,
      });
      const deleteReply = await dwn.processMessage(carol.uri, rootDelete.message);
      expect(deleteReply.status.code).toBe(202);

      // Sanity: the orphaned avatar record is still directly readable — the
      // suppression below is the reader's doing, not the engine's.
      const orphanRead = await localTransport.recordsRead(carol.uri, {
        filter: { protocol: ProfileDefinition.protocol, protocolPath: 'profile/avatar' },
      });
      expect(orphanRead.status.code).toBe(200);

      const reader = createProfileReader(anonymousSource(), { images: 'eager' });
      const profile = await reader.get(carol.uri);

      expect(profile).toEqual({ did: carol.uri });
      const snapshot = reader.getSnapshot(carol.uri);
      expect(snapshot?.status).toBe('not-found');
      expect(snapshot?.avatar.status).toBe('not-found');
      expect(snapshot?.avatar.value).toBeUndefined();

      // loadImages() must not resurrect the orphan either.
      const reloaded = createProfileReader(anonymousSource());
      expect(await reloaded.loadImages(carol.uri)).toEqual({});
      reloaded.dispose();
      reader.dispose();
    });
  });

  describe('connected-shaped source (signed queries and reads from a second identity)', () => {
    it('should resolve the same profile through a signed records surface', async () => {
      const bobSigner = await signerForDid(bob);
      const reader = createProfileReader(signedRecordsSurface(dwn, bobSigner, localTransport), { images: 'eager' });

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
      const reader = createProfileReader(signedRecordsSurface(dwn, bobSigner, localTransport), { images: 'eager' });

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
