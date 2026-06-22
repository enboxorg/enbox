import type { MessageStore, ProtocolRuleSet, ValidationStateReader } from '../../src/index.js';

import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { createTestValidationStateReader } from '../utils/test-validation-state-reader.js';
import { Jws } from '../../src/utils/jws.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestStores } from '../test-stores.js';
import { DwnConstant, DwnError, DwnErrorCode, DwnInterfaceName, DwnMethodName, Encoder, PermissionGrant, PermissionRequest, PermissionsProtocol, ProtocolsConfigure, Time } from '../../src/index.js';

describe('PermissionsProtocol', () => {
  let messageStore: MessageStore;
  let validationStateReader: ValidationStateReader;

  // important to follow the `beforeAll` and `afterAll` pattern to initialize and clean the stores in tests
  // so that different test suites can reuse the same backend store for testing
  beforeAll(async () => {

    const stores = TestStores.get();
    messageStore = stores.messageStore;
    validationStateReader = createTestValidationStateReader({ messageStore });
    await messageStore.open();
  });


  afterEach(async () => {
    // restores all fakes, stubs, spies etc. not restoring causes a memory leak.
    // more info here: https://sinonjs.org/releases/v13/general-setup/
    sinon.restore();
    await messageStore.clear();
  });

  afterAll(async () => {
    await messageStore.close();
  });

  describe('protocol definition', () => {
    it('should cap permission record sizes strictly below the inline-encoding threshold', () => {
      // This relationship is load-bearing for grant replay during sync: a record whose data size
      // is at most `DwnConstant.maxDataSizeAllowedToBeEncoded` is stored with `encodedData` inline
      // in the message store, so a replayed permission record re-admits as latest-with-data and
      // `PermissionGrant.parse()` (which requires `encodedData`) keeps working. If a `$size` max
      // ever reached the threshold, permission record data could be stored out-of-line in the data
      // store instead, and grant validation on replay would break.
      const { structure } = PermissionsProtocol.definition;
      const revocation = structure.grant.revocation as ProtocolRuleSet;

      expect(structure.request.$size!.max!).toBeLessThan(DwnConstant.maxDataSizeAllowedToBeEncoded);
      expect(structure.grant.$size!.max!).toBeLessThan(DwnConstant.maxDataSizeAllowedToBeEncoded);
      expect(revocation.$size!.max!).toBeLessThan(DwnConstant.maxDataSizeAllowedToBeEncoded);
    });

    it('should mark the request, grant, and revocation paths as $immutable', () => {
      // Permission records are write-once: immutability locks their initial-write facts
      // (notably the `protocol` tag) which replication fingerprint domains and
      // protocol-scoped shadow filters are computed from.
      const { structure } = PermissionsProtocol.definition;
      const revocation = structure.grant.revocation as ProtocolRuleSet;

      expect(structure.request.$immutable).toBe(true);
      expect(structure.grant.$immutable).toBe(true);
      expect(revocation.$immutable).toBe(true);
    });

    it('should define the canonical grant revocation store filter', () => {
      expect(PermissionsProtocol.grantRevocationFilter('grant-id')).toEqual({
        isLatestBaseState : true,
        parentId          : 'grant-id',
        protocolPath      : PermissionsProtocol.revocationPath,
      });
    });

    it('should pass ProtocolsConfigure validation without $immutable warnings', async () => {
      // `$immutable: true` combined with `update`/`co-update` actions triggers a `console.warn`
      // during ProtocolsConfigure rule-set validation. No permission record path grants update
      // actions (permission records are never updated semantically), so validating the live
      // definition must be warning-free.
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const warnSpy = sinon.spy(console, 'warn');

      const protocolsConfigure = await ProtocolsConfigure.create({
        definition : PermissionsProtocol.definition,
        signer     : Jws.createSigner(alice),
      });

      expect(protocolsConfigure.message).toBeDefined();
      expect(warnSpy.called).toBe(false);
    });

    it('should reject removed read-like Records grant methods at schema validation', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();
      const grant = await PermissionsProtocol.createGrant({
        signer      : Jws.createSigner(alice),
        grantedTo   : bob.did,
        dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Read,
          protocol  : 'https://example.com/protocol/test',
        }
      });

      expect(() => PermissionsProtocol.validateSchema(grant.recordsWrite.message, grant.permissionGrantBytes)).not.toThrow();

      for (const method of [DwnMethodName.Query, DwnMethodName.Subscribe, DwnMethodName.Count] as const) {
        const invalidGrantBytes = Encoder.objectToBytes({
          ...grant.permissionGrantData,
          scope: {
            ...grant.permissionGrantData.scope,
            method,
          },
        });

        let schemaError: unknown;
        try {
          PermissionsProtocol.validateSchema(grant.recordsWrite.message, invalidGrantBytes);
        } catch (error) {
          schemaError = error;
        }

        expect(schemaError).toBeInstanceOf(DwnError);
        expect((schemaError as DwnError).code).toBe(DwnErrorCode.SchemaValidatorFailure);
      }
    });
  });

  describe('getScopeFromPermissionRecord', () => {
    it('should get scope from a permission request record', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      // bob creates a request
      const permissionRequest = await PermissionsProtocol.createRequest({
        signer    : Jws.createSigner(bob),
        delegated : true,
        scope     : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Read,
          protocol  : 'https://example.com/protocol/test'
        }
      });

      const request = PermissionRequest.parse(permissionRequest.dataEncodedMessage);

      const scope = await PermissionsProtocol.getScopeFromPermissionRecord(
        alice.did,
        validationStateReader,
        permissionRequest.dataEncodedMessage
      );

      expect(scope).toEqual(request.scope);
    });

    it('should get scope from a permission grant record', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      const { dataEncodedMessage: grantMessage } = await PermissionsProtocol.createGrant({
        signer : Jws.createSigner(alice),
        scope  : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'https://example.com/protocol/test'
        },
        grantedTo   : bob.did,
        dateExpires : Time.createOffsetTimestamp({ seconds: 100 })
      });

      const grant = PermissionGrant.parse(grantMessage);

      const scope = await PermissionsProtocol.getScopeFromPermissionRecord(
        alice.did,
        validationStateReader,
        grantMessage
      );

      expect(scope).toEqual(grant.scope);
    });

    it('should get scope from a permission revocation record', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      const { dataEncodedMessage: grantMessage, recordsWrite: grantRecordsWrite } = await PermissionsProtocol.createGrant({
        signer : Jws.createSigner(alice),
        scope  : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'https://example.com/protocol/test'
        },
        grantedTo   : bob.did,
        dateExpires : Time.createOffsetTimestamp({ seconds: 100 })
      });

      // store grant in the messageStore so that that the original grant can be retrieved within `getScopeFromPermissionRecord`
      const indexes = await grantRecordsWrite.constructIndexes(true);
      await messageStore.put(alice.did, grantMessage, indexes);

      const grant = PermissionGrant.parse(grantMessage);

      const revocation = await PermissionsProtocol.createRevocation({
        signer : Jws.createSigner(alice),
        grant  : grant
      });

      const scope = await PermissionsProtocol.getScopeFromPermissionRecord(
        alice.did,
        validationStateReader,
        revocation.dataEncodedMessage
      );

      expect(scope).toEqual(grant.scope);
    });

    it('should throw if there is no grant for the revocation', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      const { dataEncodedMessage: grantMessage } = await PermissionsProtocol.createGrant({
        signer : Jws.createSigner(alice),
        scope  : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'https://example.com/protocol/test'
        },
        grantedTo   : bob.did,
        dateExpires : Time.createOffsetTimestamp({ seconds: 100 })
      });

      // notice the grant is not stored in the message store
      const grant = PermissionGrant.parse(grantMessage);

      const revocation = await PermissionsProtocol.createRevocation({
        signer : Jws.createSigner(alice),
        grant  : grant
      });

      await expect(PermissionsProtocol.getScopeFromPermissionRecord(
        alice.did,
        validationStateReader,
        revocation.dataEncodedMessage
      )).rejects.toThrow(DwnErrorCode.GrantAuthorizationGrantMissing);
    });

    it('should throw if the message is not a permission protocol record', async () => {
      const recordsWriteMessage = await TestDataGenerator.generateRecordsWrite();
      const dataEncodedMessage = {
        ...recordsWriteMessage.message,
        encodedData: Encoder.bytesToBase64Url(recordsWriteMessage.dataBytes!)
      };

      await expect(PermissionsProtocol.getScopeFromPermissionRecord(
        recordsWriteMessage.author.did,
        validationStateReader,
        dataEncodedMessage
      )).rejects.toThrow(DwnErrorCode.PermissionsProtocolGetScopeInvalidProtocol);
    });
  });
});
