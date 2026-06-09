import type { GenericMessage } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName, PermissionsProtocol, TestDataGenerator } from '@enbox/dwn-sdk-js';

import type { SyncScope } from '../src/types/sync.js';

import { classifySyncMessageScope } from '../src/sync-scope-acceptance.js';

describe('sync-scope-acceptance', () => {
  const profileProtocol = 'https://identity.foundation/protocols/profile';
  const socialProtocol = 'https://identity.foundation/protocols/social-graph';
  const profileScope: SyncScope = { kind: 'protocolSet', protocols: [profileProtocol] };

  it('accepts RecordsWrite messages for a covered protocol', async () => {
    const { message } = await TestDataGenerator.generateRecordsWrite({ protocol: profileProtocol });

    const classification = classifySyncMessageScope({ message, scope: profileScope });

    expect(classification).toBe('in-scope');
  });

  it('rejects RecordsWrite messages for a sibling protocol', async () => {
    const { message } = await TestDataGenerator.generateRecordsWrite({ protocol: socialProtocol });

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
    const recordsWrite = await TestDataGenerator.generateRecordsWrite({ protocol: socialProtocol });
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
        tags         : { protocol: socialProtocol },
      },
      authorization: { signature: { payload: '', signatures: [] } },
    } as unknown as GenericMessage;

    const classification = classifySyncMessageScope({ message, scope: profileScope });

    expect(classification).toBe('out-of-scope');
  });

});
