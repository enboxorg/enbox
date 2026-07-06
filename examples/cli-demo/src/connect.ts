import type { EnboxConnectResult } from '../../../packages/cli/src/index.js';

import { AuthManager, CliConnectHandler, Enbox, defineProtocol } from '../../../packages/cli/src/index.js';

const DemoProtocol = defineProtocol({
  protocol  : 'https://example.com/enbox/cli-demo',
  published : true,
  types     : {
    note: {
      schema      : 'https://example.com/enbox/cli-demo/note',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    note: {},
  },
});

const connectServerUrl = process.env.ENBOX_CONNECT_SERVER_URL;
if (connectServerUrl === undefined || connectServerUrl.trim() === '') {
  throw new Error('Set ENBOX_CONNECT_SERVER_URL to your DWN server connect relay URL, for example https://example.com/connect.');
}

const dataPath = process.env.ENBOX_DATA_PATH ?? '.enbox-cli-demo';
const password = process.env.ENBOX_PASSWORD ?? 'enbox-cli-demo-password';
const openBrowser = process.argv.includes('--open');

const connected = await Enbox.connect({
  dataPath,
  password,
  connectHandler: CliConnectHandler({
    appName: 'Enbox CLI Demo',
    connectServerUrl,
    openBrowser,
  }),
  protocols: [DemoProtocol],
});

try {
  await writeDemoNote(connected, 'initial connect');
  console.log(`Connected as ${connected.session.did}. Wrote one demo note.`);
} finally {
  await connected.auth.shutdown();
}

const restoredAuth = await AuthManager.create({ dataPath, password });
try {
  const restoredSession = await restoredAuth.restoreSession();
  if (restoredSession === undefined) {
    throw new Error('Unable to restore the CLI demo session after restart.');
  }

  const restoredEnbox = Enbox.fromSession(restoredSession);
  await writeDemoNote({ enbox: restoredEnbox, session: restoredSession }, 'restored session');
  console.log(`Restored ${restoredSession.did}. Wrote one more demo note.`);

  await restoredAuth.disconnect();
  console.log('Disconnected and requested session revocation.');
} finally {
  await restoredAuth.shutdown();
}

type ActiveSession = Pick<EnboxConnectResult, 'enbox' | 'session'>;

async function writeDemoNote(active: ActiveSession, phase: string): Promise<void> {
  await active.enbox.records.write({
    protocol : DemoProtocol.protocol,
    schema   : 'https://example.com/enbox/cli-demo/note',
    data     : {
      body      : `CLI demo ${phase} write at ${new Date().toISOString()}`,
      connected : active.session.did,
    },
  });
}
