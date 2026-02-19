import type { RecordsPermissionScope } from '../../src/types/permission-types.js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Jws } from '../../src/utils/jws.js';
import { Time } from '../../src/utils/time.js';
import { DwnInterfaceName, DwnMethodName, Encoder, PermissionGrant, PermissionsProtocol, TestDataGenerator } from '../../src/index.js';

describe('PermissionGrant', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should parse a permission grant message into a PermissionGrant', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const bob = await TestDataGenerator.generateDidKeyPersona();
    const scope: RecordsPermissionScope = {
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Write,
      protocol  : 'https://example.com/protocol/test'
    };

    const permissionGrant = await PermissionsProtocol.createGrant({
      signer      : Jws.createSigner(alice),
      grantedTo   : bob.did,
      dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
      scope
    });

    const parsed = await PermissionGrant.parse(permissionGrant.dataEncodedMessage);
    expect(parsed.id).toBe(permissionGrant.dataEncodedMessage.recordId);
    expect(parsed.grantor).toBe(alice.did);
    expect(parsed.grantee).toBe(bob.did);
    expect(parsed.scope).toEqual(scope);
    expect(parsed.dateExpires).toBeDefined();
  });

  describe('parse() validation', () => {
    it('should throw if encodedData is missing', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      const permissionGrant = await PermissionsProtocol.createGrant({
        signer      : Jws.createSigner(alice),
        grantedTo   : bob.did,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : { interface: DwnInterfaceName.Records, method: DwnMethodName.Write, protocol: 'https://example.com/protocol/test' }
      });

      const message = { ...permissionGrant.dataEncodedMessage };
      (message as any).encodedData = undefined;

      await expect(PermissionGrant.parse(message)).rejects.toThrow(DwnErrorCode.PermissionGrantParseMissingEncodedData);
    });

    it('should throw if authorization is missing (unable to extract grantor)', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      const permissionGrant = await PermissionsProtocol.createGrant({
        signer      : Jws.createSigner(alice),
        grantedTo   : bob.did,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : { interface: DwnInterfaceName.Records, method: DwnMethodName.Write, protocol: 'https://example.com/protocol/test' }
      });

      const message = { ...permissionGrant.dataEncodedMessage };
      delete (message as any).authorization;

      await expect(PermissionGrant.parse(message)).rejects.toThrow(DwnErrorCode.PermissionGrantParseMissingAuthorization);
    });

    it('should throw if descriptor.recipient (grantee) is missing', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      const permissionGrant = await PermissionsProtocol.createGrant({
        signer      : Jws.createSigner(alice),
        grantedTo   : bob.did,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : { interface: DwnInterfaceName.Records, method: DwnMethodName.Write, protocol: 'https://example.com/protocol/test' }
      });

      const message = {
        ...permissionGrant.dataEncodedMessage,
        descriptor: { ...permissionGrant.dataEncodedMessage.descriptor, recipient: undefined }
      };

      await expect(PermissionGrant.parse(message as any)).rejects.toThrow(DwnErrorCode.PermissionGrantParseMissingRecipient);
    });

    it('should throw if scope is missing from the grant data', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      const permissionGrant = await PermissionsProtocol.createGrant({
        signer      : Jws.createSigner(alice),
        grantedTo   : bob.did,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : { interface: DwnInterfaceName.Records, method: DwnMethodName.Write, protocol: 'https://example.com/protocol/test' }
      });

      // Re-encode data without `scope`
      const grantDataWithoutScope = { dateExpires: Time.createOffsetTimestamp({ seconds: 60 }) };
      const encodedData = Encoder.bytesToBase64Url(Encoder.objectToBytes(grantDataWithoutScope));
      const message = { ...permissionGrant.dataEncodedMessage, encodedData };

      await expect(PermissionGrant.parse(message)).rejects.toThrow(DwnErrorCode.PermissionGrantParseMissingScope);
    });

    it('should throw if dateExpires is missing from the grant data', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      const permissionGrant = await PermissionsProtocol.createGrant({
        signer      : Jws.createSigner(alice),
        grantedTo   : bob.did,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : { interface: DwnInterfaceName.Records, method: DwnMethodName.Write, protocol: 'https://example.com/protocol/test' }
      });

      // Re-encode data without `dateExpires`
      const grantDataWithoutExpiry = {
        scope: { interface: DwnInterfaceName.Records, method: DwnMethodName.Write, protocol: 'https://example.com/protocol/test' }
      };
      const encodedData = Encoder.bytesToBase64Url(Encoder.objectToBytes(grantDataWithoutExpiry));
      const message = { ...permissionGrant.dataEncodedMessage, encodedData };

      await expect(PermissionGrant.parse(message)).rejects.toThrow(DwnErrorCode.PermissionGrantParseMissingDateExpires);
    });
  });
});
