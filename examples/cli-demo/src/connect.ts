import { CliConnectHandler, Enbox, defineProtocol } from '@enbox/cli';

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

const openBrowser = process.argv.includes('--open');
const { enbox, session } = await Enbox.connect({
  connectHandler: CliConnectHandler({
    appName: 'Enbox CLI Demo',
    connectServerUrl,
    openBrowser,
  }),
  protocols: [DemoProtocol],
});

await enbox.records.write({
  protocol : DemoProtocol.protocol,
  schema   : 'https://example.com/enbox/cli-demo/note',
  data     : {
    body      : `CLI demo write at ${new Date().toISOString()}`,
    connected : session.connectedDid,
  },
});

console.log(`Connected as ${session.connectedDid}. Wrote one demo note.`);
