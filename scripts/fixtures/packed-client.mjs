import assert from 'node:assert/strict';

import { AgentSession } from '@enbox/agent';
import { AgentSession as AuthSession } from '@enbox/auth';
import { AgentSession as BrowserAuthSession } from '@enbox/auth/browser';
import { AgentSession as BrowserSession, BrowserConnectHandler, Enbox } from '@enbox/browser';
import { DidJwk } from '@enbox/dids';

assert.equal(AuthSession, AgentSession);
assert.equal(BrowserAuthSession, AgentSession);
assert.equal(BrowserSession, AgentSession);
assert.equal(typeof BrowserConnectHandler, 'function');
assert.equal(typeof Enbox, 'function');

const did = await DidJwk.create();
const portableDid = await did.export();
const restored = await DidJwk.import({ portableDid });
assert.equal(restored.uri, did.uri);
const signer = await restored.getSigner();
const data = new TextEncoder().encode('packed consumer');
const signature = await signer.sign({ data });
assert.equal(await signer.verify({ data, signature }), true);
console.log('Packed client imports, canonical sessions, and DID signing passed.');
