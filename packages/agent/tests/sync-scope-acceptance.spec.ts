import type { GenericMessage, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName, EncryptionModule, PermissionsModule, TestDataGenerator } from '@enbox/dwn-sdk-js';

import type { SyncScope } from '../src/types/sync.js';

import { classifySyncMessageScope } from '../src/sync-scope-acceptance.js';

describe('sync-scope-acceptance', () => {
  const profileModule = 'https://identity.foundation/modules/profile';
  const preferencesModule = 'https://identity.foundation/modules/preferences';
  const profileScope: SyncScope = { kind: 'moduleSet', modules: [profileModule] };
  const contextScope: SyncScope = {
    kind        : 'context',
    module      : profileModule,
    contextId   : 'notebook-a',
    modulePaths : ['notebook/page', 'notebook/page/delta'],
  };

  it.each([
    ['the context root', profileModule, 'notebook-a', 'notebook/page', 'in-scope'],
    ['a context descendant', profileModule, 'notebook-a/page-a', 'notebook/page/delta', 'in-scope'],
    ['an unreadable path', profileModule, 'notebook-a/page-a', 'notebook/private', 'out-of-scope'],
    ['a lexical sibling', profileModule, 'notebook-ab', 'notebook/page', 'out-of-scope'],
    ['the same context in another module', preferencesModule, 'notebook-a', 'notebook/page', 'out-of-scope'],
  ] as const)('classifies %s for an exact-context scope', (_name, module, contextId, modulePath, expected) => {
    const classification = classifySyncMessageScope({
      message : contextRecordsWrite(module, contextId, modulePath),
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
      initialWrite : contextRecordsWrite(profileModule, 'notebook-a/page-a', 'notebook/page/delta'),
      scope        : contextScope,
    })).toBe('in-scope');
    expect(classifySyncMessageScope({ message, scope: contextScope })).toBe('unknown');
  });

  it('accepts RecordsWrite messages for a covered module', async () => {
    const { message } = await TestDataGenerator.generateRecordsWrite({ module: profileModule });

    const classification = classifySyncMessageScope({ message, scope: profileScope });

    expect(classification).toBe('in-scope');
  });

  it('rejects RecordsWrite messages for a sibling module', async () => {
    const { message } = await TestDataGenerator.generateRecordsWrite({ module: preferencesModule });

    const classification = classifySyncMessageScope({ message, scope: profileScope });

    expect(classification).toBe('out-of-scope');
  });

  it('returns unknown for RecordsDelete without initial write metadata', async () => {
    const { message } = await TestDataGenerator.generateRecordsDelete();

    const classification = classifySyncMessageScope({ message, scope: profileScope });

    expect(classification).toBe('unknown');
  });

  it('accepts RecordsDelete when the initial write module is covered', async () => {
    const recordsWrite = await TestDataGenerator.generateRecordsWrite({ module: profileModule });
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

  it('rejects RecordsDelete when the initial write module is outside scope', async () => {
    const recordsWrite = await TestDataGenerator.generateRecordsWrite({ module: preferencesModule });
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

  it('accepts ModulesConfigure messages that install a covered module', async () => {
    const { message } = await TestDataGenerator.generateModulesConfigure({
      moduleDefinition: {
        module    : profileModule,
        published : true,
        types     : {},
        structure : {},
      },
    });

    const classification = classifySyncMessageScope({ message, scope: profileScope });

    expect(classification).toBe('in-scope');
  });

  it('accepts permission records tagged for a covered module', () => {
    const message = {
      recordId   : 'permission-grant-record',
      descriptor : {
        interface  : DwnInterfaceName.Records,
        method     : DwnMethodName.Write,
        module     : PermissionsModule.uri,
        modulePath : PermissionsModule.grantPath,
        tags       : { module: profileModule },
      },
      authorization: { signature: { payload: '', signatures: [] } },
    } as unknown as GenericMessage;

    const classification = classifySyncMessageScope({ message, scope: profileScope });

    expect(classification).toBe('in-scope');
  });

  it('rejects permission records tagged for a sibling module', () => {
    const message = {
      recordId   : 'permission-grant-record',
      descriptor : {
        interface  : DwnInterfaceName.Records,
        method     : DwnMethodName.Write,
        module     : PermissionsModule.uri,
        modulePath : PermissionsModule.grantPath,
        tags       : { module: preferencesModule },
      },
      authorization: { signature: { payload: '', signatures: [] } },
    } as unknown as GenericMessage;

    const classification = classifySyncMessageScope({ message, scope: profileScope });

    expect(classification).toBe('out-of-scope');
  });

  it('accepts encryption records tagged for a covered module', () => {
    for (const modulePath of [EncryptionModule.grantKeyPath, EncryptionModule.wrappedGrantKeyPath]) {
      const message = {
        recordId   : `grant-key-record-${modulePath}`,
        descriptor : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : EncryptionModule.uri,
          modulePath,
          tags      : { module: profileModule },
        },
        authorization: { signature: { payload: '', signatures: [] } },
      } as unknown as GenericMessage;

      const classification = classifySyncMessageScope({ message, scope: profileScope });

      expect(classification).toBe('in-scope');
    }
  });

  it('rejects encryption records tagged for a sibling module', () => {
    for (const modulePath of [EncryptionModule.grantKeyPath, EncryptionModule.wrappedGrantKeyPath]) {
      const message = {
        recordId   : `grant-key-record-${modulePath}`,
        descriptor : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : EncryptionModule.uri,
          modulePath,
          tags      : { module: preferencesModule },
        },
        authorization: { signature: { payload: '', signatures: [] } },
      } as unknown as GenericMessage;

      const classification = classifySyncMessageScope({ message, scope: profileScope });

      expect(classification).toBe('out-of-scope');
    }
  });

});

function contextRecordsWrite(module: string, contextId: string, modulePath: string): RecordsWriteMessage {
  return {
    contextId,
    recordId   : crypto.randomUUID(),
    descriptor : {
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Write,
      module,
      modulePath,
    },
  } as unknown as RecordsWriteMessage;
}
