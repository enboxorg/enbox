import type { RecordsPermissionScope } from '../../src/types/permission-types.js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { Jws } from '../../src/utils/jws.js';
import { DwnInterfaceName, DwnMethodName, PermissionRequest, PermissionsProtocol, TestDataGenerator } from '../../src/index.js';

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

    const parsedPermissionRequest = await PermissionRequest.parse(permissionRequest.dataEncodedMessage);
    expect (parsedPermissionRequest.id).toBe(permissionRequest.dataEncodedMessage.recordId);
    expect (parsedPermissionRequest.delegated).toBe(true);
    expect (parsedPermissionRequest.scope).toEqual(scope);
  });
});
