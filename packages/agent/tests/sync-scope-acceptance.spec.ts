import type { GenericMessage, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName, EncryptionProtocol, PermissionsProtocol, TestDataGenerator } from '@enbox/dwn-sdk-js';

import type { SyncScope } from '../src/types/sync.js';

import { classifySyncMessageScope } from '../src/sync-scope-acceptance.js';

describe('sync-scope-acceptance', () => {
  const profileProtocol = 'https://identity.foundation/protocols/profile';
  const preferencesProtocol = 'https://identity.foundation/protocols/preferences';
  const profileScope: SyncScope = { kind: 'protocolSet', protocols: [profileProtocol] };
  const contextScope: SyncScope = {
    kind          : 'context',
    protocol      : profileProtocol,
    contextId     : 'notebook-a',
    protocolPaths : ['notebook/page', 'notebook/page/delta'],
  };

  it.each([
    ['the context root', profileProtocol, 'notebook-a', 'notebook/page', 'in-scope'],
    ['a context descendant', profileProtocol, 'notebook-a/page-a', 'notebook/page/delta', 'in-scope'],
    ['an unreadable path', profileProtocol, 'notebook-a/page-a', 'notebook/private', 'out-of-scope'],
    ['a lexical sibling', profileProtocol, 'notebook-ab', 'notebook/page', 'out-of-scope'],
    ['the same context in another protocol', preferencesProtocol, 'notebook-a', 'notebook/page', 'out-of-scope'],
  ] as const)('classifies %s for an exact-context scope', (_name, protocol, contextId, protocolPath, expected) => {
    const classification = classifySyncMessageScope({
      message : contextRecordsWrite(protocol, contextId, protocolPath),
      scope   : contextScope,
    });

    expect(classification).toBe(expected);
  });

  it('classifies RecordsDelete from its initial write context', () => {
    const message = {
      descriptor: {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Delete,
      },
    } as unknown as GenericMessage;

    expect(classifySyncMessageScope({
      message,
      initialWrite : contextRecordsWrite(profileProtocol, 'notebook-a/page-a', 'notebook/page/delta'),
      scope        : contextScope,
    })).toBe('in-scope');
    expect(classifySyncMessageScope({ message, scope: contextScope })).toBe('unknown');
  });

  it('accepts RecordsWrite messages for a covered protocol', async () => {
    const { message } = await TestDataGenerator.generateRecordsWrite({ protocol: profileProtocol });

    const classification = classifySyncMessageScope({ message, scope: profileScope });

    expect(classification).toBe('in-scope');
  });

  it('rejects RecordsWrite messages for a sibling protocol', async () => {
    const { message } = await TestDataGenerator.generateRecordsWrite({ protocol: preferencesProtocol });

    const classification = classifySyncMessageScope({ message, scope: profileScope });

    expect(classification).toBe('out-of-scope');
  });

  it('returns unknown for RecordsDelete without initial write metadata', async () => {
    const { message } = await TestDataGenerator.generateRecordsDelete();

    const classification = classifySyncMessageScope({ message, scope: profileScope });

    expect(classification).toBe('unknown');
  });

  it('accepts RecordsDelete when the initial write protocol is covered', async () => {
    const recordsWrite = await TestDataGenerator.generateRecordsWrite({ protocol: profileProtocol });
    const recordsDelete = await TestDataGenerator.generateRecordsDelete({
      author   : recordsWrite.author,
      recordId : recordsWrite.message.recordId,
    });

    const classification = classifySyncMessageScope({
      message      : recordsDelete.message,
      initialWrite : recordsWrite.message,
      scope        : profileScope,
    });

    expect(classification).toBe('in-scope');
  });

  it('rejects RecordsDelete when the initial write protocol is outside scope', async () => {
    const recordsWrite = await TestDataGenerator.generateRecordsWrite({ protocol: preferencesProtocol });
    const recordsDelete = await TestDataGenerator.generateRecordsDelete({
      author   : recordsWrite.author,
      recordId : recordsWrite.message.recordId,
    });

    const classification = classifySyncMessageScope({
      message      : recordsDelete.message,
      initialWrite : recordsWrite.message,
      scope        : profileScope,
    });

    expect(classification).toBe('out-of-scope');
  });

  it('accepts ProtocolsConfigure messages that install a covered protocol', async () => {
    const { message } = await TestDataGenerator.generateProtocolsConfigure({
      protocolDefinition: {
        protocol  : profileProtocol,
        published : true,
        types     : {},
        structure : {},
      },
    });

    const classification = classifySyncMessageScope({ message, scope: profileScope });

    expect(classification).toBe('in-scope');
  });

  it('accepts permission records tagged for a covered protocol', () => {
    const message = {
      recordId   : 'permission-grant-record',
      descriptor : {
        interface    : DwnInterfaceName.Records,
        method       : DwnMethodName.Write,
        protocol     : PermissionsProtocol.uri,
        protocolPath : PermissionsProtocol.grantPath,
        tags         : { protocol: profileProtocol },
      },
      authorization: { signature: { payload: '', signatures: [] } },
    } as unknown as GenericMessage;

    const classification = classifySyncMessageScope({ message, scope: profileScope });

    expect(classification).toBe('in-scope');
  });

  it('rejects permission records tagged for a sibling protocol', () => {
    const message = {
      recordId   : 'permission-grant-record',
      descriptor : {
        interface    : DwnInterfaceName.Records,
        method       : DwnMethodName.Write,
        protocol     : PermissionsProtocol.uri,
        protocolPath : PermissionsProtocol.grantPath,
        tags         : { protocol: preferencesProtocol },
      },
      authorization: { signature: { payload: '', signatures: [] } },
    } as unknown as GenericMessage;

    const classification = classifySyncMessageScope({ message, scope: profileScope });

    expect(classification).toBe('out-of-scope');
  });

  it('accepts encryption records tagged for a covered protocol', () => {
    for (const protocolPath of [EncryptionProtocol.grantKeyPath, EncryptionProtocol.wrappedGrantKeyPath]) {
      const message = {
        recordId   : `grant-key-record-${protocolPath}`,
        descriptor : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : EncryptionProtocol.uri,
          protocolPath,
          tags      : { protocol: profileProtocol },
        },
        authorization: { signature: { payload: '', signatures: [] } },
      } as unknown as GenericMessage;

      const classification = classifySyncMessageScope({ message, scope: profileScope });

      expect(classification).toBe('in-scope');
    }
  });

  it('rejects encryption records tagged for a sibling protocol', () => {
    for (const protocolPath of [EncryptionProtocol.grantKeyPath, EncryptionProtocol.wrappedGrantKeyPath]) {
      const message = {
        recordId   : `grant-key-record-${protocolPath}`,
        descriptor : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : EncryptionProtocol.uri,
          protocolPath,
          tags      : { protocol: preferencesProtocol },
        },
        authorization: { signature: { payload: '', signatures: [] } },
      } as unknown as GenericMessage;

      const classification = classifySyncMessageScope({ message, scope: profileScope });

      expect(classification).toBe('out-of-scope');
    }
  });

});

function contextRecordsWrite(protocol: string, contextId: string, protocolPath: string): RecordsWriteMessage {
  return {
    contextId,
    recordId   : crypto.randomUUID(),
    descriptor : {
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Write,
      protocol,
      protocolPath,
    },
  } as unknown as RecordsWriteMessage;
}
