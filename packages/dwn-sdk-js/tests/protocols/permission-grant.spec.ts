import type { ConnectSessionMetadata, RecordsPermissionScope } from '../../src/types/permission-types.js';

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

    const parsed = PermissionGrant.parse(permissionGrant.dataEncodedMessage);
    expect(parsed.id).toBe(permissionGrant.dataEncodedMessage.recordId);
    expect(parsed.grantor).toBe(alice.did);
    expect(parsed.grantee).toBe(bob.did);
    expect(parsed.scope).toEqual(scope);
    expect(parsed.dateExpires).toBeDefined();
  });

  it('should parse connect session metadata from a permission grant', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const bob = await TestDataGenerator.generateDidKeyPersona();
    const createdAt = Time.getCurrentTimestamp();
    const connectSession: ConnectSessionMetadata = {
      id            : 'session-123',
      applicationId : 'https://example.com',
      appName       : 'Sample App',
      appIcon       : 'https://example.com/icon.png',
      origin        : 'https://example.com',
      userAgent     : 'ExampleBrowser/1.0',
      platform      : 'MacIntel',
      language      : 'en-US',
      languages     : ['en-US', 'en'],
      timezone      : 'America/New_York',
      transport     : 'postMessage',
      createdAt,
      expiresAt     : Time.createOffsetTimestamp({ seconds: 86_400 }, createdAt),
    };

    const permissionGrant = await PermissionsProtocol.createGrant({
      signer      : Jws.createSigner(alice),
      grantedTo   : bob.did,
      dateExpires : connectSession.expiresAt,
      scope       : {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Read,
        protocol  : 'https://example.com/protocol/test',
      },
      connectSession,
    });

    PermissionsProtocol.validateSchema(permissionGrant.recordsWrite.message, permissionGrant.permissionGrantBytes);
    const parsed = PermissionGrant.parse(permissionGrant.dataEncodedMessage);
    expect(parsed.connectSession).toEqual(connectSession);
    expect(parsed.dateExpires).toBe(connectSession.expiresAt);
  });

  it('should reject oversized connect session metadata', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const bob = await TestDataGenerator.generateDidKeyPersona();
    const createdAt = Time.getCurrentTimestamp();
    const permissionGrant = await PermissionsProtocol.createGrant({
      signer      : Jws.createSigner(alice),
      grantedTo   : bob.did,
      dateExpires : Time.createOffsetTimestamp({ seconds: 86_400 }, createdAt),
      scope       : {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Read,
        protocol  : 'https://example.com/protocol/test',
      },
      connectSession: {
        id        : 'x'.repeat(129),
        createdAt,
        expiresAt : Time.createOffsetTimestamp({ seconds: 86_400 }, createdAt),
      },
    });

    expect(() => PermissionsProtocol.validateSchema(
      permissionGrant.recordsWrite.message,
      permissionGrant.permissionGrantBytes,
    )).toThrow('must NOT have more than 128 characters');
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

      expect(() => PermissionGrant.parse(message)).toThrow(DwnErrorCode.PermissionGrantParseMissingEncodedData);
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

      expect(() => PermissionGrant.parse(message)).toThrow(DwnErrorCode.PermissionGrantParseMissingAuthorization);
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

      expect(() => PermissionGrant.parse(message as any)).toThrow(DwnErrorCode.PermissionGrantParseMissingRecipient);
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

      expect(() => PermissionGrant.parse(message)).toThrow(DwnErrorCode.PermissionGrantParseMissingScope);
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

      expect(() => PermissionGrant.parse(message)).toThrow(DwnErrorCode.PermissionGrantParseMissingDateExpires);
    });
  });
});
