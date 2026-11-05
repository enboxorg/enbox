import type * as Auth from '@enbox/auth';
import type * as Browser from '@enbox/browser';
import type * as BrowserAuth from '@enbox/auth/browser';
import type { ConnectClient, ConnectClientConnectParams, OpenConnectResponseOptions } from '@enbox/connect';

import { ConnectAuthenticationError as AuthError } from '@enbox/auth';
import { ConnectAuthenticationError as BrowserAuthError } from '@enbox/auth/browser';
import { ConnectAuthenticationError as BrowserError } from '@enbox/browser';
import { openAuthenticationResponse, openResponse, verifyOwnerAuthenticationProof } from '@enbox/connect';

// Every consumer-facing auth entrypoint exposes the same authentication contracts.
declare const fromAuth: [
  Auth.ConnectAuthenticationFailure,
  Auth.ConnectAuthenticationParams,
  Auth.ConnectAuthenticationReplayStore,
  Auth.ConnectAuthenticationResolver,
  Auth.ConnectAuthenticationResult,
  Auth.VerifiedConnectAuthentication,
];
const fromBrowserAuth: [
  BrowserAuth.ConnectAuthenticationFailure,
  BrowserAuth.ConnectAuthenticationParams,
  BrowserAuth.ConnectAuthenticationReplayStore,
  BrowserAuth.ConnectAuthenticationResolver,
  BrowserAuth.ConnectAuthenticationResult,
  BrowserAuth.VerifiedConnectAuthentication,
] = fromAuth;
const fromBrowser: [
  Browser.ConnectAuthenticationFailure,
  Browser.ConnectAuthenticationParams,
  Browser.ConnectAuthenticationReplayStore,
  Browser.ConnectAuthenticationResolver,
  Browser.ConnectAuthenticationResult,
  Browser.VerifiedConnectAuthentication,
] = fromBrowserAuth;
void fromBrowser;
const errors: Error[] = [new AuthError('invalid-request'), new BrowserAuthError('invalid-proof'), new BrowserError('unsupported-key')];
void errors;

// The same public envelope options work for each explicitly chosen response mode.
declare const responseOptions: OpenConnectResponseOptions;
void openResponse(responseOptions);
void openAuthenticationResponse(responseOptions);

// Proof verification requires a separate trusted transaction binding.
declare const proofInput: Pick<Parameters<typeof verifyOwnerAuthenticationProof>[0], 'proof' | 'request' | 'providerDid'>;
// @ts-expect-error the incoming request cannot substitute for the expected service audience and challenge.
void verifyOwnerAuthenticationProof(proofInput);
void verifyOwnerAuthenticationProof({ ...proofInput, expected: { audience: 'https://identity.example', challenge: 'abcdefghijklmnopqrstuv' } });

// Delegation APIs reject identity-only mode at compile time; refresh remains supported.
const connect: ConnectClientConnectParams = { appName: 'App', permissionRequests: [], requestType: 'refresh' };
declare const client: ConnectClient;
void client.connect(connect);
// @ts-expect-error identity-only requests must use authenticate().
void client.connect({ ...connect, requestType: 'authenticate' });
declare const wallet: Auth.WalletConnectClientOptions;
// @ts-expect-error identity-only requests must use WalletConnect.initAuthentication().
const invalidWallet: Auth.WalletConnectClientOptions = { ...wallet, requestType: 'authenticate' };
void invalidWallet;
declare const relay: Browser.RelayConnectOptions;
// @ts-expect-error the relay data-session runner does not accept identity-only requests.
const invalidRelay: Browser.RelayConnectOptions = { ...relay, requestType: 'authenticate' };
void invalidRelay;
declare const handler: Auth.ConnectHandler;
// @ts-expect-error session handlers return delegated credentials, not an identity-only result.
void handler.requestAccess({ permissionRequests: [], requestType: 'authenticate' });
declare const modal: Browser.ConnectModalOptions;
// @ts-expect-error the data-session modal has no identity-only mode.
const invalidModal: Browser.ConnectModalOptions = { ...modal, mode: 'authenticate' };
void invalidModal;
