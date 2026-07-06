import type { ConnectClientMetadata, ConnectPermissionRequest, DwnPermissionScope } from '@enbox/agent';
import type { ConnectHandler, ConnectResult, WalletConnectClientOptions } from '@enbox/auth';
import type { Readable, Writable } from 'node:stream';

import { WalletConnect } from '@enbox/auth';
import { DwnPermissionGrant, DwnPermissionsProtocol } from '@enbox/agent';

import { openBrowser as defaultOpenBrowser, promptLine, renderTerminalQr } from './terminal.js';

export const DEFAULT_CLI_WALLET_URL = 'https://enbox-wallet.pages.dev';
const DEFAULT_CONNECT_TIMEOUT_MS = 300_000;
const DEFAULT_WALLET_CONNECT_PATH = '/connect/app';

let lastPromptedWalletUrl: string | undefined;

export type PromptFunction = (question: string) => Promise<string>;
export type QrRenderer = (uri: string) => Promise<string> | string;
export type BrowserOpenFunction = (uri: string) => Promise<void> | void;

export interface CliConnectHandlerOptions {
  /** Wallet app URL. A bare origin is normalized to `/connect/app`. */
  walletUrl?: string;

  /**
   * Connect relay URL. Usually the dwn-server URL already configured by the
   * hosting tool, with `/connect` available on that server.
   */
  connectServerUrl?: string;

  /**
   * Optional late-bound relay URL provider for tool config stores.
   * `connectServerUrl` takes precedence when both are provided.
   */
  connectServerUrlProvider?: () => Promise<string | undefined> | string | undefined;

  /** Display name shown in the wallet approval screen. */
  appName?: string;

  /** Optional icon URL shown in the wallet approval screen. */
  appIcon?: string;

  /** Optional client/environment metadata for wallet session display. */
  clientMetadata?: ConnectClientMetadata;

  /**
   * Preferred session TTL in seconds. Wallets may clamp this to their policy maximum.
   */
  requestedSessionTtlSeconds?: number;

  /** Open the generated wallet URL in the local default browser instead of printing a QR code. */
  openBrowser?: boolean;

  /** Called with the wallet authorization URL for embedding hosts. */
  onAuthUrl?: (uri: string) => Promise<void> | void;

  /** Prompt for the PIN shown by the wallet. */
  pinPrompt?: PromptFunction;

  /** Prompt for a wallet URL when `walletUrl` is omitted. */
  walletPrompt?: PromptFunction;

  /** Prompt for a connect relay URL when no option/provider value is available. */
  connectServerUrlPrompt?: PromptFunction;

  /** Milliseconds to wait for wallet approval. Defaults to 300 seconds. */
  timeoutMs?: number;

  /** Milliseconds between relay polling attempts. Defaults to 3000. */
  pollIntervalMs?: number;

  /** Terminal input stream used by default prompts. */
  input?: Readable;

  /** Terminal output stream used by default prompts and QR/link rendering. */
  output?: Writable;

  /** Custom QR renderer, primarily for host integration and tests. */
  qrRenderer?: QrRenderer;

  /** Custom browser opener, primarily for host integration and tests. */
  browserOpener?: BrowserOpenFunction;
}

/**
 * Create a CLI connect handler backed by the encrypted relay/PIN flow.
 *
 * The handler plugs into `Enbox.connect({ connectHandler, protocols })` and
 * returns the same delegated session shape as the browser connect handler.
 */
export function CliConnectHandler(options: CliConnectHandlerOptions = {}): ConnectHandler {
  return {
    async requestAccess(params: {
      permissionRequests: ConnectPermissionRequest[];
    }): Promise<ConnectResult | undefined> {
      const walletUrl = await resolveWalletUrl(options);
      const connectServerUrl = await resolveConnectServerUrl(options);
      const walletUri = buildWalletUri(walletUrl);
      const result = await WalletConnect.initClient({
        displayName                : options.appName ?? 'Enbox CLI',
        appIcon                    : options.appIcon,
        clientMetadata             : options.clientMetadata,
        requestedSessionTtlSeconds : options.requestedSessionTtlSeconds,
        connectServerUrl,
        walletUri,
        permissionRequests         : params.permissionRequests,
        onWalletUriReady           : async (uri: string): Promise<void> => {
          await handleAuthUrl(uri, options);
        },
        validatePin    : async (): Promise<string> => resolvePin(options),
        timeoutMs      : options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        pollIntervalMs : options.pollIntervalMs,
      } satisfies WalletConnectClientOptions);

      if (result === undefined) {
        return undefined;
      }

      validateConnectResult(result, params.permissionRequests);
      return result;
    },
  };
}

async function resolveWalletUrl(options: CliConnectHandlerOptions): Promise<string> {
  if (options.walletUrl !== undefined && options.walletUrl.trim() !== '') {
    return options.walletUrl.trim();
  }

  const prompt = options.walletPrompt ?? defaultPrompt(options);
  const defaultWalletUrl = lastPromptedWalletUrl ?? DEFAULT_CLI_WALLET_URL;
  const answer = (await prompt(`Wallet [${defaultWalletUrl}]: `)).trim();
  const walletUrl = answer === '' ? defaultWalletUrl : answer;
  lastPromptedWalletUrl = walletUrl;
  return walletUrl;
}

async function resolveConnectServerUrl(options: CliConnectHandlerOptions): Promise<string> {
  if (options.connectServerUrl !== undefined && options.connectServerUrl.trim() !== '') {
    return options.connectServerUrl.trim();
  }

  const providedUrl = await options.connectServerUrlProvider?.();
  if (providedUrl !== undefined && providedUrl.trim() !== '') {
    return providedUrl.trim();
  }

  const prompt = options.connectServerUrlPrompt ?? defaultPrompt(options);
  const answer = (await prompt('Connect relay URL: ')).trim();
  if (answer === '') {
    throw new Error('@enbox/cli: connect relay URL is required.');
  }
  return answer;
}

function defaultPrompt(options: CliConnectHandlerOptions): PromptFunction {
  return (question: string): Promise<string> => promptLine({
    input  : options.input,
    output : options.output,
    question,
  });
}

function buildWalletUri(walletUrl: string): string {
  const url = new URL(walletUrl);
  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = DEFAULT_WALLET_CONNECT_PATH;
  }
  return url.toString();
}

async function resolvePin(options: CliConnectHandlerOptions): Promise<string> {
  const prompt = options.pinPrompt ?? defaultPrompt(options);
  const pin = (await prompt('Enter the PIN shown in your wallet: ')).trim();
  if (pin === '') {
    throw new Error('@enbox/cli: wallet PIN is required.');
  }
  return pin;
}

async function handleAuthUrl(uri: string, options: CliConnectHandlerOptions): Promise<void> {
  await options.onAuthUrl?.(uri);

  if (options.openBrowser === true) {
    await (options.browserOpener ?? defaultOpenBrowser)(uri);
    writeLine(options, 'Opening wallet for approval...');
    writeLine(options, 'Waiting for approval...');
    return;
  }

  writeLine(options, 'Scan with your wallet, or open the link in a browser:');
  writeLine(options, '');
  const qr = await (options.qrRenderer ?? renderTerminalQr)(uri);
  writeLine(options, qr);
  writeLine(options, '');
  writeLine(options, uri);
  writeLine(options, '');
  writeLine(options, 'Waiting for approval...');
}

function writeLine(options: CliConnectHandlerOptions, line: string): void {
  const output = options.output ?? process.stdout;
  output.write(`${line}\n`);
}

function validateConnectResult(result: ConnectResult, permissionRequests: ConnectPermissionRequest[]): void {
  const delegateDid = result.delegatePortableDid.uri;
  const revocationGrantIds = new Map<string, string>();

  for (const revocation of result.sessionRevocations ?? []) {
    revocationGrantIds.set(revocation.revocationGrantId, revocation.grantId);
  }

  for (const grantMessage of result.delegateGrants) {
    const grant = DwnPermissionGrant.parse(grantMessage);

    if (grant.grantee !== delegateDid) {
      throw new Error(
        `@enbox/cli: wallet returned a grant for '${grant.grantee}', but the delegate DID is '${delegateDid}'. ` +
        'Revoke the approved session in your wallet.'
      );
    }

    if (isSessionRevocationGrant(grant, revocationGrantIds)) {
      continue;
    }

    if (!isRequestedScope(grant.scope, permissionRequests)) {
      throw new Error('@enbox/cli: wallet returned a grant outside the requested permission scope. Revoke the approved session in your wallet.');
    }
  }
}

function isSessionRevocationGrant(
  grant: ReturnType<typeof DwnPermissionGrant.parse>,
  revocationGrantIds: Map<string, string>,
): boolean {
  const revokedGrantId = revocationGrantIds.get(grant.id);
  if (revokedGrantId === undefined) {
    return false;
  }

  return grant.scope.interface === 'Records' &&
    grant.scope.method === 'Write' &&
    'protocol' in grant.scope &&
    grant.scope.protocol === DwnPermissionsProtocol.uri &&
    'contextId' in grant.scope &&
    grant.scope.contextId === revokedGrantId;
}

function isRequestedScope(grantScope: DwnPermissionScope, permissionRequests: ConnectPermissionRequest[]): boolean {
  return permissionRequests.some((permissionRequest) =>
    permissionRequest.permissionScopes.some((requestedScope) => isScopeSubset(grantScope, requestedScope))
  );
}

function isScopeSubset(grantScope: DwnPermissionScope, requestedScope: DwnPermissionScope): boolean {
  if (grantScope.interface !== requestedScope.interface || grantScope.method !== requestedScope.method) {
    return false;
  }

  const requested = requestedScope as Record<string, unknown>;
  const granted = grantScope as Record<string, unknown>;
  for (const [key, requestedValue] of Object.entries(requested)) {
    if (!isEqualScopeValue(granted[key], requestedValue)) {
      return false;
    }
  }

  return true;
}

function isEqualScopeValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (left === undefined || right === undefined) {
    return false;
  }

  return JSON.stringify(left) === JSON.stringify(right);
}
