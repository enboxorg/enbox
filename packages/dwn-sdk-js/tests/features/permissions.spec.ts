import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { PermissionScope } from '../../src/index.js';
import type { DataStore, MessageStore, ResumableTaskStore } from '../../src/index.js';

import minimalModuleDefinition from '../vectors/module-definitions/minimal.json' with { type: 'json' };
import sinon from 'sinon';

import { DataStream } from '../../src/utils/data-stream.js';
import { Dwn } from '../../src/dwn.js';
import { Jws } from '../../src/utils/jws.js';
import { PermissionGrant } from '../../src/modules/permission-grant.js';
import { PermissionsModule } from '../../src/modules/permissions.js';
import { RecordsRead } from '../../src/interfaces/records-read.js';
import { RecordsWrite } from '../../src/interfaces/records-write.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DidKey, UniversalResolver } from '@enbox/dids';
import { DwnErrorCode, DwnInterfaceName, DwnMethodName, Encoder, RecordsQuery, Time } from '../../src/index.js';


export function testPermissions(): void {
  describe('permissions', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let eventLog: EventLog;
    let dwn: Dwn;

    // important to follow the `before` and `after` pattern to initialize and clean the stores in tests
    // so that different test suites can reuse the same backend store for testing
    beforeAll(async () => {
      didResolver = new UniversalResolver({ didResolvers: [DidKey] });

      const stores = TestStores.get();
      messageStore = stores.messageStore;
      dataStore = stores.dataStore;
      resumableTaskStore = stores.resumableTaskStore;
      eventLog = TestEventLog.get();

      dwn = await Dwn.create({ didResolver, messageStore, dataStore, eventLog, resumableTaskStore });
    });

    beforeEach(async () => {
      sinon.restore(); // wipe all previous stubs/spies/mocks/fakes

      // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
      await messageStore.clear();
      await dataStore.clear();
      await resumableTaskStore.clear();
    });

    afterAll(async () => {
      sinon.restore();
      await dwn.close();
    });

    it('should include record tags using the createRequest, createGrant and createRevocation if provided', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const testModule = 'https://example.com/module/test';

      // createRequest with a module
      const requestWrite = await PermissionsModule.createRequest({
        signer      : Jws.createSigner(alice),
        description : 'Requesting to write',
        delegated   : false,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : testModule,
        }
      });
      expect(requestWrite.recordsWrite.message.descriptor.tags).toEqual({ module: testModule });

      // createGrant with a module
      const grantWrite = await PermissionsModule.createGrant({
        signer      : Jws.createSigner(alice),
        dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
        description : 'Allow Bob to write',
        grantedTo   : alice.did,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : testModule,
        }
      });
      expect(grantWrite.recordsWrite.message.descriptor.tags).toEqual({ module: testModule });

      // createRevocation with a module derived from the grant
      const revokeWrite = await PermissionsModule.createRevocation({
        signer      : Jws.createSigner(alice),
        grant       : PermissionGrant.parse(grantWrite.dataEncodedMessage),
        dateRevoked : Time.getCurrentTimestamp()
      });
      expect(revokeWrite.recordsWrite.message.descriptor.tags).toEqual({ module: testModule });
    });

    it('should normalize the module URL in the scope of a Request, Grant, and Revocation', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      // createRequest with a module that will be normalized to `http://any-module`
      const requestWrite = await PermissionsModule.createRequest({
        signer      : Jws.createSigner(bob),
        description : 'Requesting to write',
        delegated   : false,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : 'any-module' // URL will normalize to `http://any-module`
        }
      });
      expect(requestWrite.recordsWrite.message.descriptor.tags).toEqual({ module: 'http://any-module' });

      // createRequest with a module that is already normalized to `https://any-module`
      const requestWrite2 = await PermissionsModule.createRequest({
        signer      : Jws.createSigner(bob),
        description : 'Requesting to write',
        delegated   : false,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : 'https://any-module'
        }
      });
      expect(requestWrite2.recordsWrite.message.descriptor.tags).toEqual({ module: 'https://any-module' });

      // createGrant with a module that will be normalized to `http://any-module`
      const grantWrite = await PermissionsModule.createGrant({
        signer      : Jws.createSigner(alice),
        dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
        description : 'Allow Bob to write',
        grantedTo   : bob.did,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : 'any-module' // URL will normalize to `http://any-module`
        }
      });
      expect(grantWrite.recordsWrite.message.descriptor.tags).toEqual({ module: 'http://any-module' });

      // createGrant with a module that is already normalized to `https://any-module`
      const grantWrite2 = await PermissionsModule.createGrant({
        signer      : Jws.createSigner(alice),
        dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
        description : 'Allow Bob to write',
        grantedTo   : bob.did,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : 'https://any-module'
        }
      });
      expect(grantWrite2.recordsWrite.message.descriptor.tags).toEqual({ module: 'https://any-module' });
    });

    it('should derive the grantId and module from the grant record when creating a revocation', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      const grantModule = 'https://example.com/module/test';

      // alice creates a grant for bob
      const grantWrite = await PermissionsModule.createGrant({
        signer      : Jws.createSigner(alice),
        dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
        description : 'Allow Bob to write',
        grantedTo   : bob.did,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : grantModule,
        }
      });
      const grantWriteReply = await dwn.processMessage(alice.did, grantWrite.recordsWrite.message, {
        dataStream: DataStream.fromBytes(grantWrite.permissionGrantBytes)
      });
      expect(grantWriteReply.status.code).toBe(202);

      // derive the grantId and module from the grant record
      const revokeWrite = await PermissionsModule.createRevocation({
        signer      : Jws.createSigner(alice),
        grant       : PermissionGrant.parse(grantWrite.dataEncodedMessage),
        dateRevoked : Time.getCurrentTimestamp()
      });

      // check that the module is in the revocation record's tags
      expect(revokeWrite.recordsWrite.message.descriptor.tags).toEqual({ module: grantModule });

      // check that the revocation's parentId is the grant's recordId
      expect(revokeWrite.recordsWrite.message.descriptor.parentId).toBe(grantWrite.recordsWrite.message.recordId);
    });

    it('should support permission management through use of Request, Grants, and Revocations', async () => {
      // scenario:
      // 1. Verify anyone (Bob) can send a permission request to Alice
      // 2. Alice queries her DWN for new permission requests
      // 3. Verify a non-owner cannot create a grant for Bob in Alice's DWN
      // 4. Alice creates a permission grant for Bob in her DWN
      // 5. Verify that Bob can query the permission grant from Alice's DWN (even though Alice can also send it directly to Bob)
      // 6. Verify that any third-party can fetch revocation of the grant and find it is still active (not revoked)
      // 7. Verify that non-owner cannot revoke the grant
      // 8. Alice revokes the permission grant for Bob
      // 9. Verify that any third-party can fetch the revocation status of the permission grant

      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      // 1. Verify anyone (Bob) can send a permission request to Alice
      const permissionScope: PermissionScope = {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Write,
        module    : `any-module`
      };

      const requestToAlice = await PermissionsModule.createRequest({
        signer      : Jws.createSigner(bob),
        description : `Requesting to write to Alice's DWN`,
        delegated   : false,
        scope       : permissionScope
      });

      const requestWriteReply = await dwn.processMessage(
        alice.did,
        requestToAlice.recordsWrite.message,
        { dataStream: DataStream.fromBytes(requestToAlice.permissionRequestBytes) }
      );
      expect(requestWriteReply.status.code).toBe(202);

      // 2. Alice queries her DWN for new permission requests
      const requestQuery = await RecordsQuery.create({
        signer : Jws.createSigner(alice),
        filter : {
          modulePath  : PermissionsModule.requestPath,
          module      : PermissionsModule.uri,
          dateUpdated : { from: Time.createOffsetTimestamp({ seconds: -1 * 60 * 60 * 24 }) }// last 24 hours
        }
      });

      const requestQueryReply = await dwn.processMessage(alice.did, requestQuery.message);
      const requestFromBob = requestQueryReply.entries?.[0]!;
      expect(requestQueryReply.status.code).toBe(200);
      expect(requestQueryReply.entries).toHaveLength(1);
      expect(requestFromBob.recordId).toBe(requestToAlice.recordsWrite.message.recordId);

      // 3. Verify a non-owner cannot create a grant for Bob in Alice's DWN
      const decodedRequest = PermissionsModule.parseRequest(requestFromBob.encodedData!);
      const unauthorizedGrantWrite = await PermissionsModule.createGrant({
        signer      : Jws.createSigner(bob),
        dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
        description : 'Allow Bob to write',
        grantedTo   : bob.did,
        scope       : decodedRequest.scope
      });

      const unauthorizedGrantWriteReply = await dwn.processMessage(
        alice.did,
        unauthorizedGrantWrite.recordsWrite.message,
        { dataStream: DataStream.fromBytes(unauthorizedGrantWrite.permissionGrantBytes) }
      );
      expect(unauthorizedGrantWriteReply.status.code).toBe(401);
      expect(unauthorizedGrantWriteReply.status.detail).toContain(DwnErrorCode.ModuleAuthorizationActionNotAllowed);

      // 4. Alice creates a permission grant for Bob in her DWN
      const grantWrite = await PermissionsModule.createGrant({
        signer      : Jws.createSigner(alice),
        dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
        description : 'Allow Bob to write',
        grantedTo   : bob.did,
        scope       : decodedRequest.scope
      });

      const grantWriteReply = await dwn.processMessage(
        alice.did,
        grantWrite.recordsWrite.message,
        { dataStream: DataStream.fromBytes(grantWrite.permissionGrantBytes) }
      );
      expect(grantWriteReply.status.code).toBe(202);

      // 5. Verify that Bob can query the permission grant from Alice's DWN (even though Alice can also send it directly to Bob)
      const grantQuery = await RecordsQuery.create({
        signer : Jws.createSigner(bob),
        filter : {
          modulePath  : PermissionsModule.grantPath,
          module      : PermissionsModule.uri,
          dateUpdated : { from: Time.createOffsetTimestamp({ seconds: -1 * 60 * 60 * 24 }) }// last 24 hours
        }
      });

      const grantQueryReply = await dwn.processMessage(alice.did, grantQuery.message);
      const grantFromBob = grantQueryReply.entries?.[0]!;
      expect(grantQueryReply.status.code).toBe(200);
      expect(grantQueryReply.entries).toHaveLength(1);
      expect(grantFromBob.recordId).toBe(grantWrite.recordsWrite.message.recordId);

      // 6. Verify that any third-party can fetch revocation of the grant and find it is still active (not revoked)
      const revocationRead = await RecordsRead.create({
        signer : Jws.createSigner(bob),
        filter : {
          contextId  : grantWrite.recordsWrite.message.contextId,
          modulePath : PermissionsModule.revocationPath
        }
      });

      const revocationReadReply = await dwn.processMessage(alice.did, revocationRead.message);
      expect(revocationReadReply.status.code).toBe(404);

      // 7. Verify that non-owner cannot revoke the grant
      const unauthorizedRevokeWrite = await PermissionsModule.createRevocation({
        signer      : Jws.createSigner(bob),
        grant       : PermissionGrant.parse(grantWrite.dataEncodedMessage),
        dateRevoked : Time.getCurrentTimestamp(),
      });

      const unauthorizedRevokeWriteReply = await dwn.processMessage(
        alice.did,
        unauthorizedRevokeWrite.recordsWrite.message,
        { dataStream: DataStream.fromBytes(unauthorizedRevokeWrite.permissionRevocationBytes) }
      );
      expect(unauthorizedRevokeWriteReply.status.code).toBe(401);
      expect(unauthorizedGrantWriteReply.status.detail).toContain(DwnErrorCode.ModuleAuthorizationActionNotAllowed);

      // 8. Alice revokes the permission grant for Bob
      const revokeWrite = await PermissionsModule.createRevocation({
        signer      : Jws.createSigner(alice),
        grant       : PermissionGrant.parse(grantWrite.dataEncodedMessage),
        dateRevoked : Time.getCurrentTimestamp(),
      });

      const revokeWriteReply = await dwn.processMessage(
        alice.did,
        revokeWrite.recordsWrite.message,
        { dataStream: DataStream.fromBytes(revokeWrite.permissionRevocationBytes) }
      );
      expect(revokeWriteReply.status.code).toBe(202);

      // 9. Verify that any third-party can fetch the revocation status of the permission grant
      const revocationReadReply2 = await dwn.processMessage(alice.did, revocationRead.message);
      expect(revocationReadReply2.status.code).toBe(200);
      expect(revocationReadReply2.entry!.recordsWrite?.recordId).toBe(revokeWrite.recordsWrite.message.recordId);
    });

    it('should fail if a RecordsPermissionScope in a Request or Grant record is created without a module', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      const permissionScope = {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Write
      };

      const requestWrite = PermissionsModule.createRequest({
        signer      : Jws.createSigner(bob),
        description : `Requesting to write to Alice's DWN`,
        delegated   : false,
        scope       : permissionScope as any // explicity as any to test the validation
      });
      await expect(requestWrite).rejects.toThrow(DwnErrorCode.PermissionsModuleCreateRequestRecordsScopeMissingModule);


      const grantWrite = PermissionsModule.createGrant({
        signer      : Jws.createSigner(alice),
        dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
        description : 'Allow Bob to write',
        grantedTo   : bob.did,
        scope       : permissionScope as any // explicity as any to test the validation
      });
      await expect(grantWrite).rejects.toThrow(DwnErrorCode.PermissionsModuleCreateGrantRecordsScopeMissingModule);
    });

    it('should fail if a subtree permission scope is created without a module', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      const permissionScope = {
        interface  : DwnInterfaceName.Messages,
        method     : DwnMethodName.Read,
        modulePath : 'post'
      };

      const requestWrite = PermissionsModule.createRequest({
        signer      : Jws.createSigner(bob),
        description : `Requesting to read Alice's DWN`,
        delegated   : false,
        scope       : permissionScope as any
      });
      await expect(requestWrite).rejects.toThrow(DwnErrorCode.PermissionsModuleCreateRequestSubtreeScopeMissingModule);

      const grantWrite = PermissionsModule.createGrant({
        signer      : Jws.createSigner(alice),
        dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
        description : 'Allow Bob to read',
        grantedTo   : bob.did,
        scope       : permissionScope as any
      });
      await expect(grantWrite).rejects.toThrow(DwnErrorCode.PermissionsModuleCreateGrantSubtreeScopeMissingModule);
    });

    it('should fail if a permission scope is created with both modulePath and contextId', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      const permissionScope = {
        interface  : DwnInterfaceName.Messages,
        method     : DwnMethodName.Read,
        module     : 'https://example.com/module/test',
        modulePath : 'post',
        contextId  : 'root'
      };

      const requestWrite = PermissionsModule.createRequest({
        signer      : Jws.createSigner(bob),
        description : `Requesting to read Alice's DWN`,
        delegated   : false,
        scope       : permissionScope as any
      });
      await expect(requestWrite).rejects.toThrow(DwnErrorCode.PermissionsModuleCreateRequestScopeContextIdModulePathConflict);

      const grantWrite = PermissionsModule.createGrant({
        signer      : Jws.createSigner(alice),
        dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
        description : 'Allow Bob to read',
        grantedTo   : bob.did,
        scope       : permissionScope as any
      });
      await expect(grantWrite).rejects.toThrow(DwnErrorCode.PermissionsModuleCreateGrantScopeContextIdModulePathConflict);
    });

    it('should fail if an invalid modulePath is used during Permissions schema validation', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const { message, dataBytes } = await TestDataGenerator.generateRecordsWrite({
        author     : alice,
        module     : PermissionsModule.uri,
        modulePath : 'invalid/path',
        data       : Encoder.stringToBytes(JSON.stringify({}))
      });

      expect(
        () => PermissionsModule.validateSchema(message, dataBytes!)
      ).toThrow(DwnErrorCode.PermissionsModuleValidateSchemaUnexpectedRecord);
    });

    it('should fail if a permission scope modulePath exceeds the maximum length', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      await expect(PermissionsModule.createGrant({
        signer      : Jws.createSigner(alice),
        grantedTo   : bob.did,
        dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
        scope       : {
          interface  : DwnInterfaceName.Messages,
          method     : DwnMethodName.Read,
          module     : 'https://example.com/module/test',
          modulePath : 'a'.repeat(601)
        }
      })).rejects.toThrow('must NOT have more than 600 characters');
    });

    it('performs additional validation to the tagged module in a Revocation message ensuring it matches the Grant it is revoking', async () => {
      // scenario:
      //  Alice creates a grant scoped to a module.
      //  Alice then tries to revoke the grant without a module set, it should fail.
      //  Alice then tries to revoke the grant with an invalid module, it should fail.
      //  Alice finally tries to revoke the grant with a valid module, it should succeed.

      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      const grantModule = 'https://example.com/module/test';
      const invalidModule = 'https://example.com/module/invalid';

      // alice creates a grant for bob
      const grantWrite = await PermissionsModule.createGrant({
        signer      : Jws.createSigner(alice),
        dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
        description : 'Allow Bob to write',
        grantedTo   : bob.did,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : grantModule,
        }
      });
      const grantWriteReply = await dwn.processMessage(alice.did, grantWrite.recordsWrite.message, {
        dataStream: DataStream.fromBytes(grantWrite.permissionGrantBytes)
      });
      expect(grantWriteReply.status.code).toBe(202);

      // attempt to revoke the grant without a module set
      const permissionRevocationBytes = Encoder.objectToBytes({ description: 'Revoking the grant' });
      const revokeWithoutModuleRecordsWrite = await RecordsWrite.create({
        signer          : Jws.createSigner(alice),
        parentContextId : grantWrite.dataEncodedMessage.recordId,
        module          : PermissionsModule.uri,
        modulePath      : PermissionsModule.revocationPath,
        dataFormat      : 'application/json',
        data            : permissionRevocationBytes,
      });

      const revokeWriteWithoutModuleReply = await dwn.processMessage(alice.did, revokeWithoutModuleRecordsWrite.message, {
        dataStream: DataStream.fromBytes(permissionRevocationBytes)
      });
      expect(revokeWriteWithoutModuleReply.status.code).toBe(400);
      expect(revokeWriteWithoutModuleReply.status.detail).toContain(DwnErrorCode.PermissionsModuleValidateRevocationModuleTagMismatch);
      expect(revokeWriteWithoutModuleReply.status.detail).toContain(
        `Revocation module undefined does not match grant module ${grantModule}`
      );

      // revoke the grant with an invalid module
      const revokeWriteWithMissMatchedModule = await RecordsWrite.create({
        signer          : Jws.createSigner(alice),
        parentContextId : grantWrite.dataEncodedMessage.recordId,
        module          : PermissionsModule.uri,
        modulePath      : PermissionsModule.revocationPath,
        dataFormat      : 'application/json',
        data            : permissionRevocationBytes,
        tags            : { module: invalidModule }
      });

      const revokeWriteWithMissMatchedModuleReply = await dwn.processMessage(alice.did, revokeWriteWithMissMatchedModule.message, {
        dataStream: DataStream.fromBytes(permissionRevocationBytes)
      });
      expect(revokeWriteWithMissMatchedModuleReply.status.code).toBe(400);
      expect(revokeWriteWithMissMatchedModuleReply.status.detail).toContain(DwnErrorCode.PermissionsModuleValidateRevocationModuleTagMismatch);
      expect(revokeWriteWithMissMatchedModuleReply.status.detail).toContain(
        `Revocation module ${invalidModule} does not match grant module ${grantModule}`
      );

      // revoke the grant with a valid module
      const revokeWrite = await RecordsWrite.create({
        signer          : Jws.createSigner(alice),
        parentContextId : grantWrite.dataEncodedMessage.recordId,
        module          : PermissionsModule.uri,
        modulePath      : PermissionsModule.revocationPath,
        dataFormat      : 'application/json',
        data            : permissionRevocationBytes,
        tags            : { module: grantModule }
      });

      const revokeWriteReply = await dwn.processMessage(alice.did, revokeWrite.message, {
        dataStream: DataStream.fromBytes(permissionRevocationBytes)
      });
      expect(revokeWriteReply.status.code).toBe(202);
    });

    // These set of tets are primarily to ensure SchemaValidation passes for the various permission request and grant messages and their scopes
    describe('ensure loaded scope properties for permission requests are processed', () => {
      it('MessagesRead', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // create a permission grant with module
        const messagesReadPermissions = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          description : 'Requesting to read from Alice test-context',
          scope       : {
            interface : DwnInterfaceName.Messages,
            method    : DwnMethodName.Read,
            module    : 'https://example.com/module/test',
          }
        });

        const messagesReadPermissionsReply = await dwn.processMessage(alice.did, messagesReadPermissions.recordsWrite.message, {
          dataStream: DataStream.fromBytes(messagesReadPermissions.permissionGrantBytes)
        });
        expect(messagesReadPermissionsReply.status.code).toBe(202);
      });

      it('MessagesSubscribe', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // create a permission grant with module
        const messagesSubscribePermissions = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          description : 'Requesting to subscribe from Alice test-context',
          scope       : {
            interface : DwnInterfaceName.Messages,
            method    : DwnMethodName.Read,
            module    : 'https://example.com/module/test',
          }
        });

        const messagesSubscribePermissionsReply = await dwn.processMessage(alice.did, messagesSubscribePermissions.recordsWrite.message, {
          dataStream: DataStream.fromBytes(messagesSubscribePermissions.permissionGrantBytes)
        });
        expect(messagesSubscribePermissionsReply.status.code).toBe(202);
      });

      it('MessagesRead with modulePath and contextId scopes', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const withModulePath = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          scope       : {
            interface  : DwnInterfaceName.Messages,
            method     : DwnMethodName.Read,
            module     : 'https://example.com/module/test',
            modulePath : 'foo/bar'
          }
        });

        const withModulePathReply = await dwn.processMessage(alice.did, withModulePath.recordsWrite.message, {
          dataStream: DataStream.fromBytes(withModulePath.permissionGrantBytes)
        });
        expect(withModulePathReply.status.code).toBe(202);

        const withContextId = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          scope       : {
            interface : DwnInterfaceName.Messages,
            method    : DwnMethodName.Read,
            module    : 'https://example.com/module/test',
            contextId : 'test-context'
          }
        });

        const withContextIdReply = await dwn.processMessage(alice.did, withContextId.recordsWrite.message, {
          dataStream: DataStream.fromBytes(withContextId.permissionGrantBytes)
        });
        expect(withContextIdReply.status.code).toBe(202);
      });

      it('RecordsDelete', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // create a permission grant with module and contextId
        const withContextId = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          description : 'Requesting to delete from Alice test-context',
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Delete,
            module    : 'https://example.com/module/test',
            contextId : 'test-context'
          }
        });

        const withContextIdReply = await dwn.processMessage(alice.did, withContextId.recordsWrite.message, {
          dataStream: DataStream.fromBytes(withContextId.permissionGrantBytes)
        });
        expect(withContextIdReply.status.code).toBe(202);

        // create a permission request with module and modulePath
        const withModulePath = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          description : 'Requesting to delete from Alice foo/bar',
          scope       : {
            interface  : DwnInterfaceName.Records,
            method     : DwnMethodName.Delete,
            module     : 'https://example.com/module/test',
            modulePath : 'foo/bar'
          }
        });

        const withModulePathReply = await dwn.processMessage(alice.did, withModulePath.recordsWrite.message, {
          dataStream: DataStream.fromBytes(withModulePath.permissionGrantBytes)
        });
        expect(withModulePathReply.status.code).toBe(202);
      });

      it('RecordsRead authorizes read-like access', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // create a permission grant with module and contextId scope
        const withContextId = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          description : 'Requesting to query from Alice test-context',
          delegated   : true,
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Read,
            module    : 'https://example.com/module/test',
            contextId : 'test-context'
          }
        });

        const withContextIdReply = await dwn.processMessage(alice.did, withContextId.recordsWrite.message, {
          dataStream: DataStream.fromBytes(withContextId.permissionGrantBytes)
        });
        expect(withContextIdReply.status.code).toBe(202);

        // create a permission request with module and modulePath scope
        const withModulePath = await PermissionsModule.createRequest({
          signer      : Jws.createSigner(bob),
          description : 'Requesting to query from Alice foo/bar',
          delegated   : true,
          scope       : {
            interface  : DwnInterfaceName.Records,
            method     : DwnMethodName.Read,
            module     : 'https://example.com/module/test',
            modulePath : 'foo/bar'
          }
        });

        const withModulePathReply = await dwn.processMessage(bob.did, withModulePath.recordsWrite.message, {
          dataStream: DataStream.fromBytes(withModulePath.permissionRequestBytes)
        });
        expect(withModulePathReply.status.code).toBe(202);
      });

      it('RecordsRead', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // create a permission grant with module and contextId scope
        const withContextId = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          description : 'Requesting to read to Alice test-context',
          delegated   : true,
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Read,
            module    : 'https://example.com/module/test',
            contextId : 'test-context'
          }
        });

        const withContextIdReply = await dwn.processMessage(alice.did, withContextId.recordsWrite.message, {
          dataStream: DataStream.fromBytes(withContextId.permissionGrantBytes)
        });
        expect(withContextIdReply.status.code).toBe(202);

        // create a permission request with module and modulePath scope
        const withModulePath = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          description : 'Requesting to read to Alice foo/bar',
          delegated   : true,
          scope       : {
            interface  : DwnInterfaceName.Records,
            method     : DwnMethodName.Read,
            module     : 'https://example.com/module/test',
            modulePath : 'foo/bar'
          }
        });

        const withModulePathReply = await dwn.processMessage(alice.did, withModulePath.recordsWrite.message, {
          dataStream: DataStream.fromBytes(withModulePath.permissionGrantBytes)
        });
        expect(withModulePathReply.status.code).toBe(202);
      });

      it('RecordsRead supports subscribe-style scopes', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // create a permission grant with module and contextId scope
        const withContextId = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          description : 'Requesting to subscribe to Alice test-context',
          delegated   : true,
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Read,
            module    : 'https://example.com/module/test',
            contextId : 'test-context'
          }
        });

        const withContextIdReply = await dwn.processMessage(alice.did, withContextId.recordsWrite.message, {
          dataStream: DataStream.fromBytes(withContextId.permissionGrantBytes)
        });
        expect(withContextIdReply.status.code).toBe(202);

        // create a permission request with module and modulePath scope
        const withModulePath = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          description : 'Requesting to subscribe to Alice foo/bar',
          delegated   : true,
          scope       : {
            interface  : DwnInterfaceName.Records,
            method     : DwnMethodName.Read,
            module     : 'https://example.com/module/test',
            modulePath : 'foo/bar'
          }
        });

        const withModulePathReply = await dwn.processMessage(alice.did, withModulePath.recordsWrite.message, {
          dataStream: DataStream.fromBytes(withModulePath.permissionGrantBytes)
        });
        expect(withModulePathReply.status.code).toBe(202);
      });

      it('RecordsWrite', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // create a permission grant with module and contextId scope
        const withContextId = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          description : 'Requesting to write to Alice test-context',
          delegated   : true,
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Write,
            module    : 'https://example.com/module/test',
            contextId : 'test-context'
          }
        });

        const withContextIdReply = await dwn.processMessage(alice.did, withContextId.recordsWrite.message, {
          dataStream: DataStream.fromBytes(withContextId.permissionGrantBytes)
        });
        expect(withContextIdReply.status.code).toBe(202);

        // create a permission request with module and modulePath scope
        const withModulePath = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          description : 'Requesting to write to Alice foo/bar',
          delegated   : true,
          scope       : {
            interface  : DwnInterfaceName.Records,
            method     : DwnMethodName.Write,
            module     : 'https://example.com/module/test',
            modulePath : 'foo/bar'
          }
        });

        const withModulePathReply = await dwn.processMessage(alice.did, withModulePath.recordsWrite.message, {
          dataStream: DataStream.fromBytes(withModulePath.permissionGrantBytes)
        });
        expect(withModulePathReply.status.code).toBe(202);
      });

      it('ModulesQuery', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // create a permission grant with module query that is unrestricted
        const moduleQueryPermissions = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          description : 'Requesting to query from Alice test-context',
          scope       : {
            interface : DwnInterfaceName.Modules,
            method    : DwnMethodName.Query,
          }
        });

        const moduleQueryPermissionsReply = await dwn.processMessage(alice.did, moduleQueryPermissions.recordsWrite.message, {
          dataStream: DataStream.fromBytes(moduleQueryPermissions.permissionGrantBytes)
        });
        expect(moduleQueryPermissionsReply.status.code).toBe(202);
      });
    });

    describe('validateScopeAndTags', () => {
      it('should be called for a Request or Grant record', async () => {
        // spy on `validateScope`
        const validateScopeSpy = sinon.spy(PermissionsModule as any, 'validateScopeAndTags');

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const permissionScope: PermissionScope = {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : 'https://example.com/module/test'
        };

        // create a request
        const requestToAlice = await PermissionsModule.createRequest({
          signer      : Jws.createSigner(bob),
          description : `Requesting to write to Alice's DWN`,
          delegated   : false,
          scope       : permissionScope
        });
        const requestToAliceReply = await dwn.processMessage(
          alice.did,
          requestToAlice.recordsWrite.message,
          { dataStream: DataStream.fromBytes(requestToAlice.permissionRequestBytes) }
        );
        expect(requestToAliceReply.status.code).toBe(202);
        expect(validateScopeSpy.calledOnce).toBe(true);

        // create a grant
        const grantedToBob = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          description : 'Allow Bob to write',
          grantedTo   : bob.did,
          scope       : permissionScope
        });

        const grantWriteReply = await dwn.processMessage(
          alice.did,
          grantedToBob.recordsWrite.message,
          { dataStream: DataStream.fromBytes(grantedToBob.permissionGrantBytes) }
        );
        expect(grantWriteReply.status.code).toBe(202);
        expect(validateScopeSpy.calledTwice).toBe(true); // called twice, once for the request and once for the grant
      });

      it('should throw if the scope is a RecordsPermissionScope and a module tag is not defined on the Request and Grant record', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const permissionScope: PermissionScope = {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : 'https://example.com/module/test'
        };

        // create a permission request without a module tag
        const requestWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : PermissionsModule.uri,
          modulePath : PermissionsModule.requestPath,
          data       : Encoder.stringToBytes(JSON.stringify({})),
          tags       : { someTag: 'someValue' } // not a module tag
        });

        expect(
          () => PermissionsModule['validateScopeAndTags'](permissionScope, requestWrite.message)
        ).toThrow(DwnErrorCode.PermissionsModuleValidateScopeMissingModuleTag);

        // create a permission grant without a module tag
        const grantRecordsWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : PermissionsModule.uri,
          modulePath : PermissionsModule.grantPath,
          data       : Encoder.stringToBytes(JSON.stringify({})),
          tags       : { someTag: 'someValue' } // not a module tag
        });

        expect(
          () => PermissionsModule['validateScopeAndTags'](permissionScope, grantRecordsWrite.message)
        ).toThrow(DwnErrorCode.PermissionsModuleValidateScopeMissingModuleTag);
      });

      it('should throw if the scope is a RecordsPermissionScope and the Request and Grant record has no tags', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const permissionScope: PermissionScope = {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : 'https://example.com/module/test'
        };

        // create a permission request without a module tag
        const requestWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : PermissionsModule.uri,
          modulePath : PermissionsModule.requestPath,
          data       : Encoder.stringToBytes(JSON.stringify({}))
        });

        expect(
          () => PermissionsModule['validateScopeAndTags'](permissionScope, requestWrite.message)
        ).toThrow(DwnErrorCode.PermissionsModuleValidateScopeMissingModuleTag);

        // create a permission grant without a module tag
        const grantRecordsWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : PermissionsModule.uri,
          modulePath : PermissionsModule.grantPath,
          data       : Encoder.stringToBytes(JSON.stringify({})),
        });

        expect(
          () => PermissionsModule['validateScopeAndTags'](permissionScope, grantRecordsWrite.message)
        ).toThrow(DwnErrorCode.PermissionsModuleValidateScopeMissingModuleTag);
      });

      it('should throw if the module tag in the Request and Grant record does not match the module defined in the scope', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // create a permission scope to test against
        const permissionScope: PermissionScope = {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : 'https://example.com/module/test'
        };

        // create a permission request with a module tag that does not match the scope
        const requestWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : PermissionsModule.uri,
          modulePath : PermissionsModule.requestPath,
          data       : Encoder.stringToBytes(JSON.stringify({ })),
          tags       : { module: 'https://example.com/module/invalid' }
        });

        expect(
          () => PermissionsModule['validateScopeAndTags'](permissionScope, requestWrite.message)
        ).toThrow(DwnErrorCode.PermissionsModuleValidateScopeModuleMismatch);

        // create a permission grant with a module tag that does not match the scope
        const grantRecordsWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : PermissionsModule.uri,
          modulePath : PermissionsModule.grantPath,
          data       : Encoder.stringToBytes(JSON.stringify({ })),
          tags       : { module: 'https://example.com/module/invalid' }
        });

        expect(
          () => PermissionsModule['validateScopeAndTags'](permissionScope, grantRecordsWrite.message)
        ).toThrow(DwnErrorCode.PermissionsModuleValidateScopeModuleMismatch);
      });

      it('should throw if modulePath and contextId are both defined in the scope for a Request and Grant record', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const permissionScope: PermissionScope = {
          interface  : DwnInterfaceName.Records,
          method     : DwnMethodName.Write,
          module     : 'https://example.com/module/test',
          modulePath : 'test/path',
          contextId  : 'test-context'
        };

        // create a permission request with a scope that has both modulePath and contextId
        const requestRecordsWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : PermissionsModule.uri,
          modulePath : PermissionsModule.requestPath,
          data       : Encoder.stringToBytes(JSON.stringify({ })),
          tags       : { module: 'https://example.com/module/test' }
        });

        expect(
          () => PermissionsModule['validateScopeAndTags'](permissionScope, requestRecordsWrite.message)
        ).toThrow(DwnErrorCode.PermissionsModuleValidateScopeContextIdProhibitedProperties);

        // create a permission grant with a scope that has both modulePath and contextId
        const grantRecordsWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : PermissionsModule.uri,
          modulePath : PermissionsModule.grantPath,
          data       : Encoder.stringToBytes(JSON.stringify({ })),
          tags       : { module: 'https://example.com/module/test' }
        });

        expect(
          () => PermissionsModule['validateScopeAndTags'](permissionScope, grantRecordsWrite.message)
        ).toThrow(DwnErrorCode.PermissionsModuleValidateScopeContextIdProhibitedProperties);

        const messagesPermissionScope: PermissionScope = {
          interface  : DwnInterfaceName.Messages,
          method     : DwnMethodName.Read,
          module     : 'https://example.com/module/test',
          modulePath : 'test/path',
          contextId  : 'test-context'
        };

        expect(
          () => PermissionsModule['validateScopeAndTags'](messagesPermissionScope, requestRecordsWrite.message)
        ).toThrow(DwnErrorCode.PermissionsModuleValidateScopeContextIdProhibitedProperties);
      });

      it('should throw if a subtree permission scope is missing module during validation', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const permissionScope: PermissionScope = {
          interface  : DwnInterfaceName.Messages,
          method     : DwnMethodName.Read,
          modulePath : 'test/path'
        };

        const requestRecordsWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : PermissionsModule.uri,
          modulePath : PermissionsModule.requestPath,
          data       : Encoder.stringToBytes(JSON.stringify({ })),
        });

        expect(
          () => PermissionsModule['validateScopeAndTags'](permissionScope, requestRecordsWrite.message)
        ).toThrow(DwnErrorCode.PermissionsModuleValidateScopeSubtreeScopeMissingModule);
      });
    });

    describe('revocation cleanup', () => {
      it('should delete grant-authorized messages created at or after the revocation timestamp', async () => {
        // scenario:
        // 1. Alice installs a module and grants Bob write access
        // 2. Bob writes a record using the grant with a future timestamp
        // 3. Alice revokes the grant (the revocation's messageTimestamp is auto-set to "now")
        // 4. The record Bob wrote with a future dateCreated (>= revocation messageTimestamp) should be deleted

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const moduleDefinition = minimalModuleDefinition;

        // Alice installs the module
        const modulesConfig = await TestDataGenerator.generateModulesConfigure({
          author: alice,
          moduleDefinition,
        });
        const modulesConfigureReply = await dwn.processMessage(alice.did, modulesConfig.message);
        expect(modulesConfigureReply.status.code).toBe(202);

        // Alice grants Bob write permission
        const permissionGrant = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Write,
            module    : moduleDefinition.module,
          }
        });
        const grantWriteReply = await dwn.processMessage(
          alice.did,
          permissionGrant.recordsWrite.message,
          { dataStream: DataStream.fromBytes(permissionGrant.permissionGrantBytes) }
        );
        expect(grantWriteReply.status.code).toBe(202);

        // Bob writes a record using the grant with a future timestamp (guaranteed >= any revocation messageTimestamp)
        const futureTimestamp = Time.createOffsetTimestamp({ seconds: 60 });
        const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author            : bob,
          module            : moduleDefinition.module,
          modulePath        : 'foo',
          permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          dateCreated       : futureTimestamp,
          messageTimestamp  : futureTimestamp,
        });
        const writeReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // Verify the record exists before revocation
        const queryBefore = await RecordsQuery.create({
          signer : Jws.createSigner(alice),
          filter : { module: moduleDefinition.module },
        });
        const queryBeforeReply = await dwn.processMessage(alice.did, queryBefore.message);
        expect(queryBeforeReply.status.code).toBe(200);
        expect(queryBeforeReply.entries!).toHaveLength(1);

        // Alice revokes the grant (messageTimestamp is auto-set to current time, which is before futureTimestamp)
        const revokeWrite = await PermissionsModule.createRevocation({
          signer : Jws.createSigner(alice),
          grant  : PermissionGrant.parse(permissionGrant.dataEncodedMessage),
        });
        const revokeReply = await dwn.processMessage(
          alice.did,
          revokeWrite.recordsWrite.message,
          { dataStream: DataStream.fromBytes(revokeWrite.permissionRevocationBytes) }
        );
        expect(revokeReply.status.code).toBe(202);

        // The grant-authorized record should have been deleted by revocation cleanup
        const queryAfter = await RecordsQuery.create({
          signer : Jws.createSigner(alice),
          filter : { module: moduleDefinition.module },
        });
        const queryAfterReply = await dwn.processMessage(alice.did, queryAfter.message);
        expect(queryAfterReply.status.code).toBe(200);
        expect(queryAfterReply.entries!).toHaveLength(0);
      });

      it('should not delete grant-authorized messages created before the revocation timestamp', async () => {
        // scenario:
        // 1. Alice installs a module and grants Bob write access
        // 2. Bob writes a record using the grant (dateCreated is "now")
        // 3. Alice revokes the grant (messageTimestamp is auto-set to a slightly later "now")
        // 4. The record Bob wrote before the revocation should NOT be deleted

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const moduleDefinition = minimalModuleDefinition;

        // Alice installs the module
        const modulesConfig = await TestDataGenerator.generateModulesConfigure({
          author: alice,
          moduleDefinition,
        });
        const modulesConfigureReply = await dwn.processMessage(alice.did, modulesConfig.message);
        expect(modulesConfigureReply.status.code).toBe(202);

        // Alice grants Bob write permission
        const permissionGrant = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Write,
            module    : moduleDefinition.module,
          }
        });
        const grantWriteReply = await dwn.processMessage(
          alice.did,
          permissionGrant.recordsWrite.message,
          { dataStream: DataStream.fromBytes(permissionGrant.permissionGrantBytes) }
        );
        expect(grantWriteReply.status.code).toBe(202);

        // Bob writes a record using the grant (dateCreated defaults to current time)
        const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author            : bob,
          module            : moduleDefinition.module,
          modulePath        : 'foo',
          permissionGrantId : permissionGrant.recordsWrite.message.recordId,
        });
        const writeReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // Alice revokes the grant (messageTimestamp is auto-set slightly after the record's dateCreated)
        const revokeWrite = await PermissionsModule.createRevocation({
          signer : Jws.createSigner(alice),
          grant  : PermissionGrant.parse(permissionGrant.dataEncodedMessage),
        });
        const revokeReply = await dwn.processMessage(
          alice.did,
          revokeWrite.recordsWrite.message,
          { dataStream: DataStream.fromBytes(revokeWrite.permissionRevocationBytes) }
        );
        expect(revokeReply.status.code).toBe(202);

        // The record Bob wrote before the revocation should still exist
        const queryAfter = await RecordsQuery.create({
          signer : Jws.createSigner(alice),
          filter : { module: moduleDefinition.module },
        });
        const queryAfterReply = await dwn.processMessage(alice.did, queryAfter.message);
        expect(queryAfterReply.status.code).toBe(200);
        expect(queryAfterReply.entries!).toHaveLength(1);
      });

      it('should delete data from the data store for large records when revoking a grant', async () => {
        // scenario:
        // 1. Alice installs a module and grants Bob write access
        // 2. Bob writes a record with data larger than maxDataSizeAllowedToBeEncoded (30KB)
        // 3. Alice revokes the grant
        // 4. Both the message and the data blob should be deleted

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const moduleDefinition = minimalModuleDefinition;

        // Alice installs the module
        const modulesConfig = await TestDataGenerator.generateModulesConfigure({
          author: alice,
          moduleDefinition,
        });
        const modulesConfigureReply = await dwn.processMessage(alice.did, modulesConfig.message);
        expect(modulesConfigureReply.status.code).toBe(202);

        // Alice grants Bob write permission
        const permissionGrant = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Write,
            module    : moduleDefinition.module,
          }
        });
        const grantWriteReply = await dwn.processMessage(
          alice.did,
          permissionGrant.recordsWrite.message,
          { dataStream: DataStream.fromBytes(permissionGrant.permissionGrantBytes) }
        );
        expect(grantWriteReply.status.code).toBe(202);

        // Bob writes a record with large data (> 30KB) using the grant, with a future timestamp
        const futureTimestamp = Time.createOffsetTimestamp({ seconds: 60 });
        const largeData = TestDataGenerator.randomBytes(40_000);
        const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author            : bob,
          module            : moduleDefinition.module,
          modulePath        : 'foo',
          data              : largeData,
          permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          dateCreated       : futureTimestamp,
          messageTimestamp  : futureTimestamp,
        });
        const writeReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // Verify the data exists in the data store before revocation
        const dataResult = await dataStore.get(alice.did, recordsWrite.message.recordId, recordsWrite.message.descriptor.dataCid);
        expect(dataResult).toBeDefined();

        // Alice revokes the grant
        const revokeWrite = await PermissionsModule.createRevocation({
          signer : Jws.createSigner(alice),
          grant  : PermissionGrant.parse(permissionGrant.dataEncodedMessage),
        });
        const revokeReply = await dwn.processMessage(
          alice.did,
          revokeWrite.recordsWrite.message,
          { dataStream: DataStream.fromBytes(revokeWrite.permissionRevocationBytes) }
        );
        expect(revokeReply.status.code).toBe(202);

        // The record should be deleted from the message store
        const queryAfter = await RecordsQuery.create({
          signer : Jws.createSigner(alice),
          filter : { module: moduleDefinition.module },
        });
        const queryAfterReply = await dwn.processMessage(alice.did, queryAfter.message);
        expect(queryAfterReply.status.code).toBe(200);
        expect(queryAfterReply.entries!).toHaveLength(0);

        // The data blob should also be deleted from the data store
        const dataResultAfter = await dataStore.get(alice.did, recordsWrite.message.recordId, recordsWrite.message.descriptor.dataCid);
        expect(dataResultAfter).toBeUndefined();
      });

      it('should delete multiple grant-authorized messages when revoking a grant', async () => {
        // scenario:
        // 1. Alice installs a module and grants Bob write access
        // 2. Bob writes three records: one at current time, two with future timestamps
        // 3. Alice revokes the grant (at current time, between the first and future records)
        // 4. The current-time record survives; the two future records are deleted

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const moduleDefinition = minimalModuleDefinition;

        // Alice installs the module
        const modulesConfig = await TestDataGenerator.generateModulesConfigure({
          author: alice,
          moduleDefinition,
        });
        const modulesConfigureReply = await dwn.processMessage(alice.did, modulesConfig.message);
        expect(modulesConfigureReply.status.code).toBe(202);

        // Alice grants Bob write permission
        const permissionGrant = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Write,
            module    : moduleDefinition.module,
          }
        });
        const grantWriteReply = await dwn.processMessage(
          alice.did,
          permissionGrant.recordsWrite.message,
          { dataStream: DataStream.fromBytes(permissionGrant.permissionGrantBytes) }
        );
        expect(grantWriteReply.status.code).toBe(202);

        // Timestamps: future records will be deleted, current-time record will survive
        const futureTimestamp = Time.createOffsetTimestamp({ seconds: 60 });
        const farFutureTimestamp = Time.createOffsetTimestamp({ seconds: 120 });

        // Bob writes record 1 (current time — should survive)
        const write1 = await TestDataGenerator.generateRecordsWrite({
          author            : bob,
          module            : moduleDefinition.module,
          modulePath        : 'foo',
          permissionGrantId : permissionGrant.recordsWrite.message.recordId,
        });
        const write1Reply = await dwn.processMessage(alice.did, write1.recordsWrite.message, { dataStream: write1.dataStream });
        expect(write1Reply.status.code).toBe(202);

        // Bob writes record 2 (future — should be deleted)
        const write2 = await TestDataGenerator.generateRecordsWrite({
          author            : bob,
          module            : moduleDefinition.module,
          modulePath        : 'foo',
          permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          dateCreated       : futureTimestamp,
          messageTimestamp  : futureTimestamp,
        });
        const write2Reply = await dwn.processMessage(alice.did, write2.recordsWrite.message, { dataStream: write2.dataStream });
        expect(write2Reply.status.code).toBe(202);

        // Bob writes record 3 (far future — should be deleted)
        const write3 = await TestDataGenerator.generateRecordsWrite({
          author            : bob,
          module            : moduleDefinition.module,
          modulePath        : 'foo',
          permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          dateCreated       : farFutureTimestamp,
          messageTimestamp  : farFutureTimestamp,
        });
        const write3Reply = await dwn.processMessage(alice.did, write3.recordsWrite.message, { dataStream: write3.dataStream });
        expect(write3Reply.status.code).toBe(202);

        // Verify all 3 records exist before revocation
        const queryBefore = await RecordsQuery.create({
          signer : Jws.createSigner(alice),
          filter : { module: moduleDefinition.module },
        });
        const queryBeforeReply = await dwn.processMessage(alice.did, queryBefore.message);
        expect(queryBeforeReply.status.code).toBe(200);
        expect(queryBeforeReply.entries!).toHaveLength(3);

        // Alice revokes the grant (messageTimestamp is "now", between record 1 and records 2/3)
        const revokeWrite = await PermissionsModule.createRevocation({
          signer : Jws.createSigner(alice),
          grant  : PermissionGrant.parse(permissionGrant.dataEncodedMessage),
        });
        const revokeReply = await dwn.processMessage(
          alice.did,
          revokeWrite.recordsWrite.message,
          { dataStream: DataStream.fromBytes(revokeWrite.permissionRevocationBytes) }
        );
        expect(revokeReply.status.code).toBe(202);

        // Only the record written at current time should remain
        const queryAfter = await RecordsQuery.create({
          signer : Jws.createSigner(alice),
          filter : { module: moduleDefinition.module },
        });
        const queryAfterReply = await dwn.processMessage(alice.did, queryAfter.message);
        expect(queryAfterReply.status.code).toBe(200);
        expect(queryAfterReply.entries!).toHaveLength(1);
        expect(queryAfterReply.entries![0].recordId).toBe(write1.recordsWrite.message.recordId);
      });
    });

    describe('permission record immutability', () => {
      // Permission records (requests, grants, and revocations) are `$immutable`: a grant is
      // never amended — it is revoked and re-issued. Immutability also locks each record's
      // initial-write facts (notably the `module` tag), which replication fingerprint
      // domains and module-scoped shadow filters are computed from.

      it('should reject an update to an existing permission grant record', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // Alice creates a permission grant for Bob — the initial write is allowed.
        const grantWrite = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          description : 'Allow Bob to write',
          grantedTo   : bob.did,
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Write,
            module    : 'https://example.com/module/test'
          }
        });

        const grantWriteReply = await dwn.processMessage(
          alice.did,
          grantWrite.recordsWrite.message,
          { dataStream: DataStream.fromBytes(grantWrite.permissionGrantBytes) }
        );
        expect(grantWriteReply.status.code).toBe(202);

        // A non-initial RecordsWrite to the same grant record is rejected by `$immutable`.
        const grantUpdate = await RecordsWrite.createFrom({
          recordsWriteMessage : grantWrite.recordsWrite.message,
          data                : grantWrite.permissionGrantBytes,
          signer              : Jws.createSigner(alice),
        });

        const grantUpdateReply = await dwn.processMessage(
          alice.did,
          grantUpdate.message,
          { dataStream: DataStream.fromBytes(grantWrite.permissionGrantBytes) }
        );
        expect(grantUpdateReply.status.code).toBe(400);
        expect(grantUpdateReply.status.detail).toContain(DwnErrorCode.ModuleAuthorizationImmutableRecord);
      });

      it('should reject a tags-only mutation of an existing permission grant record', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // Alice creates a module-scoped grant; the scoped module is carried in `tags.module`.
        const grantWrite = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          description : 'Allow Bob to write',
          grantedTo   : bob.did,
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Write,
            module    : 'https://example.com/module/test'
          }
        });

        const grantWriteReply = await dwn.processMessage(
          alice.did,
          grantWrite.recordsWrite.message,
          { dataStream: DataStream.fromBytes(grantWrite.permissionGrantBytes) }
        );
        expect(grantWriteReply.status.code).toBe(202);

        // A tags-only mutation (no data change) is still a non-initial RecordsWrite and must be
        // rejected — a retagged grant would drift between the module shadow-filter stream
        // (current tags) and its replication fingerprint domain (initial-write tags).
        const grantUpdate = await RecordsWrite.createFrom({
          recordsWriteMessage : grantWrite.recordsWrite.message,
          tags                : { module: 'https://example.com/module/other' },
          signer              : Jws.createSigner(alice),
        });

        const grantUpdateReply = await dwn.processMessage(alice.did, grantUpdate.message);
        expect(grantUpdateReply.status.code).toBe(400);
        expect(grantUpdateReply.status.detail).toContain(DwnErrorCode.ModuleAuthorizationImmutableRecord);
      });

      it('should reject an update to an existing permission request record', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // Bob creates a permission request in Alice's DWN — the initial write is allowed.
        const requestWrite = await PermissionsModule.createRequest({
          signer      : Jws.createSigner(bob),
          description : 'Requesting to write',
          delegated   : false,
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Write,
            module    : 'https://example.com/module/test'
          }
        });

        const requestWriteReply = await dwn.processMessage(
          alice.did,
          requestWrite.recordsWrite.message,
          { dataStream: DataStream.fromBytes(requestWrite.permissionRequestBytes) }
        );
        expect(requestWriteReply.status.code).toBe(202);

        // Even the original author cannot update the request record.
        const requestUpdate = await RecordsWrite.createFrom({
          recordsWriteMessage : requestWrite.recordsWrite.message,
          data                : requestWrite.permissionRequestBytes,
          signer              : Jws.createSigner(bob),
        });

        const requestUpdateReply = await dwn.processMessage(
          alice.did,
          requestUpdate.message,
          { dataStream: DataStream.fromBytes(requestWrite.permissionRequestBytes) }
        );
        expect(requestUpdateReply.status.code).toBe(400);
        expect(requestUpdateReply.status.detail).toContain(DwnErrorCode.ModuleAuthorizationImmutableRecord);
      });

      it('should still allow revoking a grant but reject updates to the revocation record', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // Alice creates a permission grant for Bob.
        const grantWrite = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          description : 'Allow Bob to write',
          grantedTo   : bob.did,
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Write,
            module    : 'https://example.com/module/test'
          }
        });

        const grantWriteReply = await dwn.processMessage(
          alice.did,
          grantWrite.recordsWrite.message,
          { dataStream: DataStream.fromBytes(grantWrite.permissionGrantBytes) }
        );
        expect(grantWriteReply.status.code).toBe(202);

        // Revoking the grant still works: the revocation is a new record (an initial write
        // under the grant), so `$immutable` on the grant path does not block it.
        const revocationWrite = await PermissionsModule.createRevocation({
          signer : Jws.createSigner(alice),
          grant  : PermissionGrant.parse(grantWrite.dataEncodedMessage),
        });

        const revocationWriteReply = await dwn.processMessage(
          alice.did,
          revocationWrite.recordsWrite.message,
          { dataStream: DataStream.fromBytes(revocationWrite.permissionRevocationBytes) }
        );
        expect(revocationWriteReply.status.code).toBe(202);

        // The revocation record itself is immutable as well.
        const revocationUpdate = await RecordsWrite.createFrom({
          recordsWriteMessage : revocationWrite.recordsWrite.message,
          data                : revocationWrite.permissionRevocationBytes,
          signer              : Jws.createSigner(alice),
        });

        const revocationUpdateReply = await dwn.processMessage(
          alice.did,
          revocationUpdate.message,
          { dataStream: DataStream.fromBytes(revocationWrite.permissionRevocationBytes) }
        );
        expect(revocationUpdateReply.status.code).toBe(400);
        expect(revocationUpdateReply.status.detail).toContain(DwnErrorCode.ModuleAuthorizationImmutableRecord);
      });

      it('should reject replicated updates to permission records in applyReplicatedMessage', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // An initial grant write is admitted through replication apply.
        const grantWrite = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          dateExpires : Time.createOffsetTimestamp({ seconds: 100 }),
          description : 'Allow Bob to write',
          grantedTo   : bob.did,
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Write,
            module    : 'https://example.com/module/test'
          }
        });

        const applyInitialResult = await dwn.applyReplicatedMessage(
          alice.did,
          grantWrite.recordsWrite.message,
          { dataStream: DataStream.fromBytes(grantWrite.permissionGrantBytes) }
        );
        expect(applyInitialResult).toEqual(expect.objectContaining({ kind: 'Applied' }));

        // A replicated non-initial write to the same grant record is terminally invalid,
        // not a missing-dependency retry.
        const grantUpdate = await RecordsWrite.createFrom({
          recordsWriteMessage : grantWrite.recordsWrite.message,
          data                : grantWrite.permissionGrantBytes,
          signer              : Jws.createSigner(alice),
        });

        const applyUpdateResult = await dwn.applyReplicatedMessage(
          alice.did,
          grantUpdate.message,
          { dataStream: DataStream.fromBytes(grantWrite.permissionGrantBytes) }
        );
        expect(applyUpdateResult.kind).toBe('Invalid');
        if (applyUpdateResult.kind === 'Invalid') {
          expect(applyUpdateResult.reason).toContain(DwnErrorCode.ModuleAuthorizationImmutableRecord);
        }

        // A replicated tags-only mutation is rejected the same way.
        const grantTagsUpdate = await RecordsWrite.createFrom({
          recordsWriteMessage : grantWrite.recordsWrite.message,
          tags                : { module: 'https://example.com/module/other' },
          signer              : Jws.createSigner(alice),
        });

        const applyTagsUpdateResult = await dwn.applyReplicatedMessage(alice.did, grantTagsUpdate.message);
        expect(applyTagsUpdateResult.kind).toBe('Invalid');
        if (applyTagsUpdateResult.kind === 'Invalid') {
          expect(applyTagsUpdateResult.reason).toContain(DwnErrorCode.ModuleAuthorizationImmutableRecord);
        }
      });
    });
  });
}
