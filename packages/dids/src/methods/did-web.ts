import type {
  InferKeyGeneratorAlgorithm,
  KeyIdentifier,
  KeyImporterExporter,
  KeyManager,
  KmsExportKeyParams,
  KmsImportKeyParams,
} from '@enbox/crypto';

import { LocalKeyManager } from '@enbox/crypto';

import type { PortableDid } from '../types/portable-did.js';
import type { DidCreateOptions, DidCreateVerificationMethod } from './did-method.js';
import type {
  DidDocument,
  DidResolutionOptions,
  DidResolutionResult,
  DidService,
  DidVerificationMethod,
} from '../types/did-core.js';

import { BearerDid } from '../bearer-did.js';
import { Did } from '../did.js';
import { DidMethod } from './did-method.js';
import { EMPTY_DID_RESOLUTION_RESULT } from '../types/did-resolution.js';
import { extractDidFragment } from '../utils.js';
import { DidError, DidErrorCode } from '../did-error.js';

/** Default fetch timeout for DID document retrieval (30 seconds). */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Returns `true` when the hostname is a private, loopback, or link-local
 * address.  Used to block SSRF via crafted `did:web` identifiers such as
 * `did:web:169.254.169.254` or `did:web:localhost`.
 */
function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();

  if (h === 'localhost' || h === 'localhost.') { return true; }

  // IPv4 literal check
  const parts = h.split('.');
  if (parts.length === 4) {
    const octets = parts.map(Number);
    if (octets.every((o) => !Number.isNaN(o) && o >= 0 && o <= 255)) {
      const [a, b] = octets;
      if (a === 10) { return true; } // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) { return true; } // 172.16.0.0/12
      if (a === 192 && b === 168) { return true; } // 192.168.0.0/16
      if (a === 127) { return true; } // 127.0.0.0/8
      if (a === 169 && b === 254) { return true; } // 169.254.0.0/16
      if (a === 0) { return true; } // 0.0.0.0/8
    }
  }

  // IPv6 literal check (bracket-wrapped by URL parser)
  let v6 = h;
  if (v6.startsWith('[') && v6.endsWith(']')) { v6 = v6.slice(1, -1); }
  if (v6.includes(':')) {
    if (v6 === '::1' || v6 === '::') { return true; }
    if (v6.startsWith('fe80:') || v6.startsWith('fe80%')) { return true; }
    if (v6.startsWith('fc') || v6.startsWith('fd')) { return true; }
  }

  return false;
}

/**
 * Defines the set of options available when creating a new Decentralized Identifier (DID) with the
 * 'did:web' method.
 *
 * Unlike self-certifying DID methods (e.g., `did:jwk`, `did:dht`), `did:web` requires external
 * information — a domain and an optional path — to form the DID URI. The `create()` method
 * generates keys locally and constructs a DID document, but does NOT publish it. Registration
 * with a `did:web` hosting server is the caller's responsibility.
 *
 * @example
 * ```ts
 * // Create a did:web DID for enbox.id/users/alice
 * const did = await DidWeb.create({
 *   options: {
 *     domain: 'enbox.id',
 *     path:   'users:alice',
 *   }
 * });
 * // did.uri === 'did:web:enbox.id:users:alice'
 * ```
 */
export interface DidWebCreateOptions<TKms> extends DidCreateOptions<TKms> {
  /**
   * The domain (and optional port) that will host the DID document.
   *
   * Ports are percent-encoded per the did:web spec (e.g., `localhost%3A3000`).
   * This value forms the first segment of the method-specific identifier.
   *
   * @example 'enbox.id'
   * @example 'localhost%3A3000'
   */
  domain: string;

  /**
   * Optional colon-separated path segments appended after the domain.
   *
   * When present the DID document is served at `https://<domain>/<path>/did.json`.
   * When absent the DID document is served at `https://<domain>/.well-known/did.json`.
   *
   * @example 'users:alice'   // → did:web:enbox.id:users:alice
   * @example 'orgs:acme'     // → did:web:enbox.id:orgs:acme
   */
  path?: string;

  /**
   * Optionally specify the algorithm to be used for key generation of the primary
   * verification method. Defaults to Ed25519. Mutually exclusive with
   * `verificationMethods`.
   */
  algorithm?: TKms extends KeyManager
    ? InferKeyGeneratorAlgorithm<TKms>
    : InferKeyGeneratorAlgorithm<LocalKeyManager>;

  /**
   * Optional services to include in the DID document (e.g., DWN endpoints).
   */
  services?: DidService[];
}

/**
 * The `DidWeb` class provides an implementation of the `did:web` DID method.
 *
 * Features:
 * - DID Creation: Create new `did:web` DIDs with local key generation.
 * - DID Key Management: Instantiate a DID object from an existing verification method key set or
 *                       a key in a Key Management System (KMS). If supported by the KMS, a DID's
 *                       key can be exported to a portable DID format.
 * - DID Resolution: Resolve a `did:web` to its corresponding DID Document.
 * - Signature Operations: Sign and verify messages using keys associated with a DID.
 *
 * @remarks
 * The `did:web` method uses a web domain's existing reputation and aims to integrate decentralized
 * identities with the existing web infrastructure to drive adoption. It leverages familiar web
 * security models and domain ownership to provide accessible, interoperable digital identity
 * management.
 *
 * Unlike self-certifying methods, `did:web` creation generates keys and a DID document locally
 * but does NOT publish them. The caller is responsible for registering the DID document with
 * the hosting server.
 *
 * @see {@link https://w3c-ccg.github.io/did-method-web/ | DID Web Specification}
 *
 * @example
 * ```ts
 * // DID Creation
 * const did = await DidWeb.create({
 *   options: { domain: 'enbox.id', path: 'users:alice' }
 * });
 *
 * // DID Resolution
 * const resolutionResult = await DidWeb.resolve('did:web:enbox.id:users:alice');
 *
 * // Signature Operations
 * const signer = await did.getSigner();
 * const signature = await signer.sign({ data: new TextEncoder().encode('Message') });
 * const isValid = await signer.verify({ data: new TextEncoder().encode('Message'), signature });
 *
 * // Import / Export
 * const portableDid = await did.export();
 * const imported = await DidWeb.import({ portableDid });
 * ```
 */
export class DidWeb extends DidMethod {

  /**
   * Name of the DID method, as defined in the DID Web specification.
   */
  public static methodName = 'web';

  /**
   * Creates a new DID using the `did:web` method formed from a newly generated key.
   *
   * @remarks
   * The DID URI is formed from the given `domain` and optional `path`, prefixed with `did:web:`.
   * Keys are generated locally and a DID document is constructed, but the document is NOT
   * published to any server. Registration with a `did:web` hosting server is the caller's
   * responsibility.
   *
   * Notes:
   * - If no `options.algorithm` or `options.verificationMethods` are given, a new Ed25519 key is
   *   generated by default.
   * - The `algorithm` and `verificationMethods` options are mutually exclusive.
   * - The `domain` option is required.
   *
   * @example
   * ```ts
   * // DID Creation
   * const did = await DidWeb.create({
   *   options: { domain: 'enbox.id', path: 'users:alice' }
   * });
   * // did.uri === 'did:web:enbox.id:users:alice'
   *
   * // DID Creation with a KMS
   * const keyManager = new LocalKeyManager();
   * const did = await DidWeb.create({
   *   keyManager,
   *   options: { domain: 'enbox.id', path: 'users:alice' }
   * });
   * ```
   *
   * @param params - The parameters for the create operation.
   * @param params.keyManager - Optionally specify a Key Management System (KMS) used to generate
   *                            keys and sign data.
   * @param params.options - Parameters that specify the domain, path, algorithm, verification
   *                         methods, and services for the new DID.
   * @returns A Promise resolving to a {@link BearerDid} object representing the new DID.
   */
  public static async create<TKms extends KeyManager | undefined = undefined>({
    keyManager = new LocalKeyManager(),
    options,
  }: {
    keyManager?: TKms;
    options: DidWebCreateOptions<TKms>;
  }): Promise<BearerDid> {
    // Validate required options.
    if (!options.domain) {
      throw new DidError(DidErrorCode.InvalidDid, `The 'domain' option is required for did:web creation`);
    }

    // Validate that `algorithm` and `verificationMethods` are not both given.
    if (options.algorithm && options.verificationMethods) {
      throw new Error(`The 'algorithm' and 'verificationMethods' options are mutually exclusive`);
    }

    // Build the DID URI from the domain and optional path.
    const identifier = options.path
      ? `${options.domain}:${options.path}`
      : options.domain;
    const didUri = `did:${DidWeb.methodName}:${identifier}`;

    // Validate the constructed DID URI.
    const parsedDid = Did.parse(didUri);
    if (!parsedDid) {
      throw new DidError(DidErrorCode.InvalidDid, `The constructed DID URI is invalid: ${didUri}`);
    }

    // Determine verification methods to create.
    const verificationMethodsToAdd: DidCreateVerificationMethod<TKms>[] =
      options.verificationMethods ?? [{
        algorithm : (options.algorithm ?? 'Ed25519') as DidCreateVerificationMethod<TKms>['algorithm'],
        purposes  : ['authentication', 'assertionMethod', 'capabilityDelegation', 'capabilityInvocation'],
      }];

    // Begin constructing the DID Document.
    const document: DidDocument = {
      '@context' : ['https://www.w3.org/ns/did/v1'],
      id         : didUri,
    };

    // Generate key material for each verification method and add to the document.
    for (let i = 0; i < verificationMethodsToAdd.length; i++) {
      const vmOptions = verificationMethodsToAdd[i];

      // Generate a random key.
      const keyUri = await keyManager.generateKey({ algorithm: vmOptions.algorithm });
      const publicKey = await keyManager.getPublicKey({ keyUri });

      // Use the given ID or default to `key-N`.
      const fragment = vmOptions.id?.split('#').pop() ?? `key-${i}`;
      const methodId = `${didUri}#${fragment}`;

      // Initialize the `verificationMethod` array if needed.
      document.verificationMethod ??= [];

      // Add the verification method to the DID document.
      document.verificationMethod.push({
        id           : methodId,
        type         : 'JsonWebKey',
        controller   : vmOptions.controller ?? didUri,
        publicKeyJwk : publicKey,
      });

      // Add the verification method to the specified purpose properties.
      for (const purpose of vmOptions.purposes ?? []) {
        document[purpose] ??= [];
        document[purpose].push(methodId);
      }
    }

    // Add services, if any.
    if (options.services) {
      document.service = options.services.map(service => ({
        ...service,
        id: `${didUri}#${service.id.split('#').pop()}`,
      }));
    }

    // Create the BearerDid object. Metadata indicates unpublished state.
    const did = new BearerDid({
      uri      : didUri,
      document,
      metadata : { published: false },
      keyManager,
    });

    return did;
  }

  /**
   * Given the W3C DID Document of a `did:web` DID, return the verification method that will be
   * used for signing messages and credentials. If given, the `methodId` parameter is used to
   * select the verification method. If not given, the first verification method referenced in
   * `assertionMethod` is used, falling back to the first verification method in the document.
   *
   * @param params - The parameters for the `getSigningMethod` operation.
   * @param params.didDocument - DID Document to get the verification method from.
   * @param params.methodId - ID of the verification method to use for signing.
   * @returns Verification method to use for signing.
   */
  public static async getSigningMethod({ didDocument, methodId }: {
    didDocument: DidDocument;
    methodId?: string;
  }): Promise<DidVerificationMethod> {
    // Verify the DID method is supported.
    const parsedDid = Did.parse(didDocument.id);
    if (parsedDid && parsedDid.method !== this.methodName) {
      throw new DidError(DidErrorCode.MethodNotSupported, `Method not supported: ${parsedDid.method}`);
    }

    // Attempt to find a verification method that matches the given method ID, or if not given,
    // find the first verification method intended for signing claims.
    const targetFragment = extractDidFragment(methodId)
      ?? extractDidFragment(didDocument.assertionMethod?.[0]);

    const verificationMethod = targetFragment
      ? didDocument.verificationMethod?.find(vm => extractDidFragment(vm.id) === targetFragment)
      : didDocument.verificationMethod?.[0];

    if (!verificationMethod?.publicKeyJwk) {
      throw new DidError(
        DidErrorCode.InternalError,
        'A verification method intended for signing could not be determined from the DID Document'
      );
    }

    return verificationMethod;
  }

  /**
   * Instantiates a {@link BearerDid} object for the DID Web method from a given
   * {@link PortableDid}.
   *
   * This method allows for the creation of a `BearerDid` object using a previously created DID's
   * key material, DID document, and metadata.
   *
   * @example
   * ```ts
   * // Export an existing BearerDid to PortableDid format.
   * const portableDid = await did.export();
   * // Reconstruct a BearerDid object from the PortableDid.
   * const did = await DidWeb.import({ portableDid });
   * ```
   *
   * @param params - The parameters for the import operation.
   * @param params.portableDid - The PortableDid object to import.
   * @param params.keyManager - Optionally specify an external Key Management System (KMS) used to
   *                            generate keys and sign data. If not given, a new
   *                            {@link LocalKeyManager} instance will be created and used.
   * @returns A Promise resolving to a `BearerDid` object representing the DID formed from the
   *          provided keys.
   */
  public static async import({ portableDid, keyManager = new LocalKeyManager() }: {
    keyManager?: KeyManager & KeyImporterExporter<KmsImportKeyParams, KeyIdentifier, KmsExportKeyParams>;
    portableDid: PortableDid;
  }): Promise<BearerDid> {
    // Verify the DID method is supported.
    const parsedDid = Did.parse(portableDid.uri);
    if (parsedDid?.method !== DidWeb.methodName) {
      throw new DidError(DidErrorCode.MethodNotSupported, `Method not supported`);
    }

    // Use the given PortableDid to construct the BearerDid object.
    const did = await BearerDid.import({ portableDid, keyManager });

    return did;
  }

  /**
   * Resolves a `did:web` identifier to a DID Document.
   *
   * @param didUri - The DID to be resolved.
   * @param _options - Optional parameters for resolving the DID. Unused by this DID method.
   * @returns A Promise resolving to a {@link DidResolutionResult} object representing the result of the resolution.
   */
  public static async resolve(didUri: string, _options?: DidResolutionOptions): Promise<DidResolutionResult> {
    // Attempt to parse the DID URI.
    const parsedDid = Did.parse(didUri);

    // If parsing failed, the DID is invalid.
    if (!parsedDid) {
      return {
        ...EMPTY_DID_RESOLUTION_RESULT,
        didResolutionMetadata: { error: 'invalidDid' }
      };
    }

    // If the DID method is not "web", return an error.
    if (parsedDid.method !== DidWeb.methodName) {
      return {
        ...EMPTY_DID_RESOLUTION_RESULT,
        didResolutionMetadata: { error: 'methodNotSupported' }
      };
    }

    // Replace ":" with "/" in the identifier and prepend "https://" to obtain the fully qualified
    // domain name and optional path.
    let baseUrl = `https://${parsedDid.id.replace(/:/g, '/')}`;

    // If the domain contains a percent encoded port value, decode the colon.
    baseUrl = decodeURIComponent(baseUrl);

    // Append the expected location of the DID document depending on whether a path was specified.
    const didDocumentUrl = parsedDid.id.includes(':') ?
      `${baseUrl}/did.json` :
      `${baseUrl}/.well-known/did.json`;

    try {
      // Block requests to private/loopback/link-local addresses (SSRF protection).
      const parsedUrl = new URL(didDocumentUrl);
      if (isPrivateHostname(parsedUrl.hostname)) {
        return {
          ...EMPTY_DID_RESOLUTION_RESULT,
          didResolutionMetadata: { error: 'notFound' }
        };
      }

      // Perform an HTTP GET request to obtain the DID document.
      const response = await fetch(didDocumentUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      // If the response status code is not 200, return an error.
      if (!response.ok) {throw new Error('HTTP error status code returned');}

      // Parse the DID document.
      const didDocument = await response.json() as DidDocument;

      return {
        ...EMPTY_DID_RESOLUTION_RESULT,
        didDocument,
      };

    } catch {
      // If the DID document could not be retrieved, return an error.
      return {
        ...EMPTY_DID_RESOLUTION_RESULT,
        didResolutionMetadata: { error: 'notFound' }
      };
    }
  }
}