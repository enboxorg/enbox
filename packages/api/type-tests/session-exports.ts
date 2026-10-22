import type { AgentSession, AgentSessionIdentity, AuthEventMap, AuthManager } from '@enbox/auth';
import type { AgentSessionIdentity as BrowserIdentity, AgentSession as BrowserSession } from '@enbox/auth/browser';
import type { AgentSessionIdentity as CoreIdentity, AgentSession as CoreSession } from '@enbox/agent';

declare const session: CoreSession;
declare const identity: CoreIdentity;
declare const auth: AuthManager;

const authSession: AgentSession = session;
const browserSession: BrowserSession = authSession;
const coreSession: CoreSession = browserSession;
const authIdentity: AgentSessionIdentity = identity;
const browserIdentity: BrowserIdentity = authIdentity;
const coreIdentity: CoreIdentity = browserIdentity;
const addedIdentity: AuthEventMap['identity-added']['identity'] = coreIdentity;
const connected: Promise<AgentSession> = auth.connectVault();
const current: AgentSession | undefined = auth.session;
void coreSession;
void addedIdentity;
void connected;
void current;
