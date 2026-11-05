import type { DataEncodedRecordsWriteMessage } from '../../../src/types/records-types.js';
import type { PermissionScope } from '../../../src/types/permission-types.js';

import { Encoder } from '../../../src/utils/encoder.js';
import { Jws } from '../../../src/utils/jws.js';
import { Message } from '../../../src/core/message.js';
import { PermissionGrant } from '../../../src/modules/permission-grant.js';
import { PermissionRequest } from '../../../src/modules/permission-request.js';
import { PermissionsModule } from '../../../src/modules/permissions.js';
import { TestDataGenerator } from '../../utils/test-data-generator.js';
import { validateJsonSchema } from '../../../src/schema-validator.js';
import { beforeAll, describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName } from '../../../src/enums/dwn-interface-method.js';

type WireObject = Record<string, unknown>;

const moduleUri = 'https://example.com/modules/vocabulary';
const timestamp = '2026-01-01T00:00:00.000000Z';

function moduleDefinition(): WireObject {
  return {
    module    : moduleUri,
    published : false,
    types     : { note: { dataFormats: ['application/json'] } },
    structure : { note: {} },
  };
}

function configureMessage(definition: WireObject = moduleDefinition()): WireObject {
  return {
    authorization : TestDataGenerator.generateAuthorization(),
    descriptor    : {
      interface        : 'Modules',
      method           : 'Configure',
      messageTimestamp : timestamp,
      definition,
    },
  };
}

function writeDescriptor(): WireObject {
  return {
    interface        : 'Records',
    method           : 'Write',
    module           : moduleUri,
    modulePath       : 'note',
    dataCid          : 'data-cid',
    dataFormat       : 'application/json',
    dataSize         : 2,
    dateCreated      : timestamp,
    messageTimestamp : timestamp,
  };
}

function writeMessage(descriptor: WireObject = writeDescriptor()): WireObject {
  return {
    recordId      : 'recordId',
    contextId     : 'recordId',
    authorization : TestDataGenerator.generateAuthorization(),
    descriptor,
  };
}

function grantData(scope: WireObject): WireObject {
  return { dateExpires: timestamp, scope };
}

function encryptionEntry(derivationScheme: string): WireObject {
  const entry: WireObject = {
    algorithm          : 'X25519-HKDF-SHA256+A256KW',
    keyId              : 'a'.repeat(43),
    derivationScheme,
    ephemeralPublicKey : { kty: 'OKP', crv: 'X25519', x: 'a'.repeat(43) },
    encryptedKey       : 'a'.repeat(54),
  };
  if (derivationScheme === 'roleAudience') {
    entry.module = moduleUri;
    entry.rolePath = 'member';
  }
  return entry;
}

function encryptedWrite(entry: WireObject): WireObject {
  return {
    ...writeMessage(),
    encryption: {
      algorithm            : 'A256CTR',
      initializationVector : 'a'.repeat(22),
      keyEncryption        : [entry],
    },
  };
}

function legacyField(input: WireObject, currentName: string, oldName: string, mixed: boolean): WireObject {
  const output = { ...input, [oldName]: input[currentName] };
  if (!mixed) {
    delete output[currentName];
  }
  return output;
}

describe('module wire vocabulary', () => {
  let signedGrant: DataEncodedRecordsWriteMessage;
  let signedRequest: DataEncodedRecordsWriteMessage;

  beforeAll(async () => {
    const author = await TestDataGenerator.generateDidKeyPersona();
    const signer = Jws.createSigner(author);
    const scope = { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, module: moduleUri } as const;
    signedGrant = (await PermissionsModule.createGrant({
      signer,
      grantedTo   : 'did:example:reader',
      dateExpires : '2099-01-01T00:00:00.000000Z',
      scope,
    })).dataEncodedMessage;
    signedRequest = (await PermissionsModule.createRequest({ signer, scope, delegated: false })).dataEncodedMessage;
  });

  it('accepts new-format configure, record, query, role, and grant objects', () => {
    expect(() => Message.validateJsonSchema(configureMessage())).not.toThrow();
    expect(() => Message.validateJsonSchema(writeMessage())).not.toThrow();
    expect(() => validateJsonSchema('RecordsFilter', { module: moduleUri, modulePath: 'note' })).not.toThrow();
    expect(() => validateJsonSchema('RecordsWriteSignaturePayload', {
      descriptorCid : 'descriptor-cid',
      recordId      : 'recordId',
      moduleRole    : 'member',
    })).not.toThrow();
    expect(() => validateJsonSchema('PermissionGrantData', grantData({
      interface  : 'Records',
      method     : 'Write',
      module     : moduleUri,
      modulePath : 'note',
    }))).not.toThrow();
    expect(() => validateJsonSchema('PermissionGrantData', grantData({
      interface : 'Modules',
      method    : 'Configure',
      module    : moduleUri,
    }))).not.toThrow();
  });

  it('rejects the old Protocols interface in messages and grant scopes', () => {
    const message = configureMessage();
    (message.descriptor as WireObject).interface = 'Protocols';
    expect(() => Message.validateJsonSchema(message)).toThrow();
    expect(() => validateJsonSchema('PermissionGrantData', grantData({
      interface : 'Protocols',
      method    : 'Configure',
      module    : moduleUri,
    }))).toThrow();
  });

  for (const mixed of [false, true]) {
    const form = mixed ? 'mixed old/new' : 'old-only';

    it(`rejects ${form} definition identity fields`, () => {
      const definition = legacyField(moduleDefinition(), 'module', 'protocol', mixed);
      expect(() => Message.validateJsonSchema(configureMessage(definition))).toThrow();
    });

    it(`rejects ${form} role invocation fields in signed payloads`, () => {
      const payload = legacyField({
        descriptorCid : 'descriptor-cid',
        recordId      : 'recordId',
        moduleRole    : 'member',
      }, 'moduleRole', 'protocolRole', mixed);
      expect(() => validateJsonSchema('RecordsWriteSignaturePayload', payload)).toThrow();
    });

    for (const [currentName, oldName] of [['module', 'protocol'], ['modulePath', 'protocolPath']]) {
      it(`rejects ${form} ${oldName} fields in record descriptors`, () => {
        const descriptor = legacyField(writeDescriptor(), currentName, oldName, mixed);
        expect(() => Message.validateJsonSchema(writeMessage(descriptor))).toThrow();
      });

      it(`rejects ${form} ${oldName} fields in record filters`, () => {
        const filter = legacyField({ module: moduleUri, modulePath: 'note' }, currentName, oldName, mixed);
        expect(() => validateJsonSchema('RecordsFilter', filter)).toThrow();
      });

      it(`rejects ${form} ${oldName} fields in permission grant scopes`, () => {
        const scope = legacyField({
          interface  : 'Records',
          method     : 'Write',
          module     : moduleUri,
          modulePath : 'note',
        }, currentName, oldName, mixed);
        expect(() => validateJsonSchema('PermissionGrantData', grantData(scope))).toThrow();
      });
    }

    it(`rejects ${form} module identity in role-audience encryption entries`, () => {
      const entry = legacyField(encryptionEntry('roleAudience'), 'module', 'protocol', mixed);
      expect(() => Message.validateJsonSchema(encryptedWrite(entry))).toThrow();
    });

    it(`rejects ${form} Messages grant scope instead of interpreting it as unscoped`, () => {
      expect(PermissionGrant.parse(signedGrant).scope).toEqual({ interface: 'Messages', method: 'Read', module: moduleUri });
      const data = Encoder.base64UrlToObject(signedGrant.encodedData) as { scope: WireObject };
      data.scope = legacyField(data.scope, 'module', 'protocol', mixed);
      const message = { ...signedGrant, encodedData: Encoder.bytesToBase64Url(Encoder.objectToBytes(data)) };
      expect(() => PermissionGrant.parse(message)).toThrow();
    });

    it(`rejects ${form} Messages request scope instead of interpreting it as unscoped`, () => {
      expect(PermissionRequest.parse(signedRequest).scope).toEqual({ interface: 'Messages', method: 'Read', module: moduleUri });
      const data = Encoder.base64UrlToObject(signedRequest.encodedData) as { scope: WireObject };
      data.scope = legacyField(data.scope, 'module', 'protocol', mixed);
      const message = { ...signedRequest, encodedData: Encoder.bytesToBase64Url(Encoder.objectToBytes(data)) };
      expect(() => PermissionRequest.parse(message)).toThrow();
    });

    it(`rejects ${form} Messages scope during grant and request creation`, async () => {
      const scope = legacyField({ interface: 'Messages', method: 'Read', module: moduleUri }, 'module', 'protocol', mixed);
      await expect(PermissionsModule.createGrant({
        grantedTo   : 'did:example:reader',
        dateExpires : '2099-01-01T00:00:00.000000Z',
        scope       : scope as PermissionScope,
      })).rejects.toThrow();
      await expect(PermissionsModule.createRequest({ scope: scope as PermissionScope, delegated: false })).rejects.toThrow();
    });
  }

  for (const derivationScheme of ['modulePath', 'roleAudience']) {
    it(`accepts the supported ${derivationScheme} derivation scheme`, () => {
      expect(() => Message.validateJsonSchema(encryptedWrite(encryptionEntry(derivationScheme)))).not.toThrow();
    });
  }

  it('rejects the old protocolPath derivation scheme without translating it', () => {
    const entry = encryptionEntry('modulePath');
    entry.derivationScheme = 'protocolPath';
    expect(() => Message.validateJsonSchema(encryptedWrite(entry))).toThrow();
    expect(entry.derivationScheme).toBe('protocolPath');
  });
});
