import type { Dwn, ProtocolDefinition } from '../../src/index.js';
import type { GenerateRecordsWriteOutput, Persona } from './test-data-generator.js';

import threadRoleProtocolDefinition from '../vectors/protocol-definitions/thread-role.json' with { type: 'json' };

import { TestDataGenerator } from './test-data-generator.js';

export type MessagesRoleContext = {
  delegate: Persona;
  member: Persona;
  otherThread: GenerateRecordsWriteOutput;
  protocolDefinition: ProtocolDefinition;
  role: GenerateRecordsWriteOutput;
  source: Persona;
  thread: GenerateRecordsWriteOutput;
};

export async function createMessagesRoleContext(dwn: Dwn): Promise<MessagesRoleContext> {
  const source = await TestDataGenerator.generateDidKeyPersona();
  const member = await TestDataGenerator.generateDidKeyPersona();
  const delegate = await TestDataGenerator.generateDidKeyPersona();
  const protocolDefinition = threadRoleProtocolDefinition as ProtocolDefinition;

  const configure = await TestDataGenerator.generateProtocolsConfigure({ author: source, protocolDefinition });
  if ((await dwn.processMessage(source.did, configure.message)).status.code !== 202) {
    throw new Error('Failed to install role-feed test protocol');
  }

  const thread = await TestDataGenerator.generateRecordsWrite({
    author       : source,
    protocol     : protocolDefinition.protocol,
    protocolPath : 'thread',
  });
  const otherThread = await TestDataGenerator.generateRecordsWrite({
    author       : source,
    protocol     : protocolDefinition.protocol,
    protocolPath : 'thread',
  });
  for (const record of [thread, otherThread]) {
    if ((await dwn.processMessage(source.did, record.message, { dataStream: record.dataStream })).status.code !== 202) {
      throw new Error('Failed to create role-feed test context');
    }
  }

  const role = await TestDataGenerator.generateRecordsWrite({
    author          : source,
    parentContextId : thread.message.contextId,
    protocol        : protocolDefinition.protocol,
    protocolPath    : 'thread/participant',
    recipient       : member.did,
  });
  if ((await dwn.processMessage(source.did, role.message, { dataStream: role.dataStream })).status.code !== 202) {
    throw new Error('Failed to create role-feed test role');
  }

  return { delegate, member, otherThread, protocolDefinition, role, source, thread };
}
