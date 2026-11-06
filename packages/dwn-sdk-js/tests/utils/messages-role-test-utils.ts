import type { Dwn, ModuleDefinition } from '../../src/index.js';
import type { GenerateRecordsWriteOutput, Persona } from './test-data-generator.js';

import threadRoleModuleDefinition from '../vectors/module-definitions/thread-role.json' with { type: 'json' };

import { TestDataGenerator } from './test-data-generator.js';

export type MessagesRoleContext = {
  delegate: Persona;
  member: Persona;
  otherThread: GenerateRecordsWriteOutput;
  moduleDefinition: ModuleDefinition;
  role: GenerateRecordsWriteOutput;
  source: Persona;
  thread: GenerateRecordsWriteOutput;
};

export async function createMessagesRoleContext(dwn: Dwn): Promise<MessagesRoleContext> {
  const source = await TestDataGenerator.generateDidKeyPersona();
  const member = await TestDataGenerator.generateDidKeyPersona();
  const delegate = await TestDataGenerator.generateDidKeyPersona();
  const moduleDefinition = threadRoleModuleDefinition as ModuleDefinition;

  const configure = await TestDataGenerator.generateModulesConfigure({ author: source, moduleDefinition });
  if ((await dwn.processMessage(source.did, configure.message)).status.code !== 202) {
    throw new Error('Failed to install role-feed test module');
  }

  const thread = await TestDataGenerator.generateRecordsWrite({
    author     : source,
    module     : moduleDefinition.module,
    modulePath : 'thread',
  });
  const otherThread = await TestDataGenerator.generateRecordsWrite({
    author     : source,
    module     : moduleDefinition.module,
    modulePath : 'thread',
  });
  for (const record of [thread, otherThread]) {
    if ((await dwn.processMessage(source.did, record.message, { dataStream: record.dataStream })).status.code !== 202) {
      throw new Error('Failed to create role-feed test context');
    }
  }

  const role = await TestDataGenerator.generateRecordsWrite({
    author          : source,
    parentContextId : thread.message.contextId,
    module          : moduleDefinition.module,
    modulePath      : 'thread/participant',
    recipient       : member.did,
  });
  if ((await dwn.processMessage(source.did, role.message, { dataStream: role.dataStream })).status.code !== 202) {
    throw new Error('Failed to create role-feed test role');
  }

  return { delegate, member, otherThread, moduleDefinition, role, source, thread };
}
