import type { AgentSession } from '@enbox/agent';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type {
  CreateEnboxTestContextOptions,
  CreateHostedDelegatedEnboxTestContextOptions,
  EnboxTestContext,
  HostedDelegatedEnboxTestContext,
} from '@enbox/api/testing';

import { createEnboxTestContext, createHostedDelegatedEnboxTestContext } from '@enbox/api/testing';
import { defineApplicationManifest, defineProtocol, recordCodecs } from '@enbox/api';

const NotesDefinition = {
  protocol  : 'https://example.com/protocols/testing-notes',
  published : false,
  types     : {
    note: { dataFormats: ['application/json'], encryptionRequired: true },
  },
  structure: { note: {} },
} as const satisfies ProtocolDefinition;

const NotesProtocol = defineProtocol(NotesDefinition, {
  note: recordCodecs.json<{ body: string }>(),
});
const application = defineApplicationManifest({ protocols: [NotesProtocol] } as const);
const options: CreateEnboxTestContextOptions = { application };

async function exerciseTestingContext(): Promise<void> {
  const context: EnboxTestContext = await createEnboxTestContext(options);
  const session: AgentSession = context.session;
  const notes = context.enbox.using(NotesProtocol);

  await notes.records.create('note', { data: { body: 'typed' } });
  // @ts-expect-error the protocol codec requires a string body.
  await notes.records.create('note', { data: { body: 42 } });
  const closing: Promise<void> = context.close();
  await closing;
  void session;
}

void exerciseTestingContext;

const hostedOptions: CreateHostedDelegatedEnboxTestContextOptions = {
  application,
  dwnEndpoints: ['https://dwn.example.com'],
};

async function exerciseHostedTestingContext(): Promise<void> {
  const context: HostedDelegatedEnboxTestContext =
    await createHostedDelegatedEnboxTestContext(hostedOptions);
  const session: AgentSession = context.session;
  const ownerDid: string = context.ownerDid;
  const delegateDid: string = context.delegateDid;
  await context.close();
  void delegateDid;
  void ownerDid;
  void session;
}

void exerciseHostedTestingContext;

// @ts-expect-error test contexts require a normalized application manifest.
void createEnboxTestContext({ application: { protocols: [NotesDefinition] } });

// @ts-expect-error hosted contexts require at least the endpoint array property.
void createHostedDelegatedEnboxTestContext({ application });
