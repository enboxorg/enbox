import type { RecordsPermissionScope } from '../../src/types/permission-types.js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Jws } from '../../src/utils/jws.js';
import { DwnInterfaceName, DwnMethodName, Encoder, PermissionRequest, PermissionsProtocol, TestDataGenerator } from '../../src/index.js';

describe('PermissionRequest', () => {
  afterEach(() => {
    // restores all fakes, stubs, spies etc. not restoring causes a memory leak.
    // more info here: https://sinonjs.org/releases/v13/general-setup/
    sinon.restore();
  });

  it('should parse a permission request message into a PermissionRequest', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const scope: RecordsPermissionScope = {
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Query,
      protocol  : 'https://example.com/protocol/test'
    };

    const permissionRequest = await PermissionsProtocol.createRequest({
      signer    : Jws.createSigner(alice),
      delegated : true,
      scope
    });

    const parsedPermissionRequest = PermissionRequest.parse(permissionRequest.dataEncodedMessage);
    expect (parsedPermissionRequest.id).toBe(permissionRequest.dataEncodedMessage.recordId);
    expect (parsedPermissionRequest.delegated).toBe(true);
    expect (parsedPermissionRequest.scope).toEqual(scope);
  });

  describe('parse() validation', () => {
    it('should throw if encodedData is missing', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const permissionRequest = await PermissionsProtocol.createRequest({
        signer    : Jws.createSigner(alice),
        delegated : true,
        scope     : { interface: DwnInterfaceName.Records, method: DwnMethodName.Query, protocol: 'https://example.com/protocol/test' }
      });

      const message = { ...permissionRequest.dataEncodedMessage };
      (message as any).encodedData = undefined;

      expect(() => PermissionRequest.parse(message)).toThrow(DwnErrorCode.PermissionRequestParseMissingEncodedData);
    });

    it('should throw if authorization is missing (unable to extract requester)', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const permissionRequest = await PermissionsProtocol.createRequest({
        signer    : Jws.createSigner(alice),
        delegated : true,
        scope     : { interface: DwnInterfaceName.Records, method: DwnMethodName.Query, protocol: 'https://example.com/protocol/test' }
      });

      const message = { ...permissionRequest.dataEncodedMessage };
      delete (message as any).authorization;

      expect(() => PermissionRequest.parse(message)).toThrow(DwnErrorCode.PermissionRequestParseMissingAuthorization);
    });

    it('should throw if scope is missing from the request data', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const permissionRequest = await PermissionsProtocol.createRequest({
        signer    : Jws.createSigner(alice),
        delegated : true,
        scope     : { interface: DwnInterfaceName.Records, method: DwnMethodName.Query, protocol: 'https://example.com/protocol/test' }
      });

      // Re-encode data without `scope`
      const requestDataWithoutScope = { delegated: true };
      const encodedData = Encoder.bytesToBase64Url(Encoder.objectToBytes(requestDataWithoutScope));
      const message = { ...permissionRequest.dataEncodedMessage, encodedData };

      expect(() => PermissionRequest.parse(message)).toThrow(DwnErrorCode.PermissionRequestParseMissingScope);
    });
  });
});
