import type { Jwk } from '@enbox/crypto';
import type {
  IonDocumentModel,
  IonPublicKeyModel,
  IonPublicKeyPurpose,
  JwkEs256k,
} from '@decentralized-identity/ion-sdk';

import type { DidService } from '../types/did-core.js';
import type { DidIonCreateRequest, DidIonVerificationMethod } from './did-ion.js';

import { computeJwkThumbprint } from '@enbox/crypto';
import { IonDid, IonRequest } from '@decentralized-identity/ion-sdk';

/**
 * The `DidIonUtils` class provides utility functions to support operations in the DID ION method.
 */
export class DidIonUtils {
  /**
   * Appends a specified path to a base URL, ensuring proper formatting of the resulting URL.
   *
   * This method is useful for constructing URLs for accessing various endpoints, such as Sidetree
   * nodes in the ION network. It handles the nuances of URL path concatenation, including the
   * addition or removal of leading/trailing slashes, to create a well-formed URL.
   *
   * @param params - The parameters for URL construction.
   * @param params.baseUrl - The base URL to which the path will be appended.
   * @param params.path - The path to append to the base URL.
   * @returns The fully constructed URL string with the path appended to the base URL.
   */
  public static appendPathToUrl({ baseUrl, path }: {
    baseUrl: string;
    path: string;
  }): string {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.endsWith('/') ? url.pathname : url.pathname + '/';
    url.pathname += path.startsWith('/') ? path.substring(1) : path;

    return url.toString();
  }

  /**
   * Computes the Long Form DID URI given an ION DID's recovery key, update key, services, and
   * verification methods.
   *
   * @param params - The parameters for computing the Long Form DID URI.
   * @param params.recoveryKey - The ION Recovery Key.
   * @param params.updateKey - The ION Update Key.
   * @param params.services - An array of services associated with the DID.
   * @param params.verificationMethods - An array of verification methods associated with the DID.
   * @returns A Promise resolving to the Long Form DID URI.
   */
  public static async computeLongFormDidUri({ recoveryKey, updateKey, services, verificationMethods }: {
    recoveryKey: Jwk;
    updateKey: Jwk;
    services: DidService[];
    verificationMethods: DidIonVerificationMethod[];
  }): Promise<string> {
    // Create the ION document.
    const ionDocument = await DidIonUtils.createIonDocument({ services, verificationMethods });

    // Normalize JWK to onnly include specific members and in lexicographic order.
    const normalizedRecoveryKey = DidIonUtils.normalizeJwk(recoveryKey);
    const normalizedUpdateKey = DidIonUtils.normalizeJwk(updateKey);

    // Compute the Long Form DID URI.
    const longFormDidUri = await IonDid.createLongFormDid({
      document    : ionDocument,
      recoveryKey : normalizedRecoveryKey as JwkEs256k,
      updateKey   : normalizedUpdateKey as JwkEs256k
    });

    return longFormDidUri;
  }

  /**
   * Constructs a Sidetree Create Operation request for a DID document within the ION network.
   *
   * This method prepares the necessary payload for submitting a Create Operation to a Sidetree
   * node, encapsulating the details of the DID document, recovery key, and update key.
   *
   * @param params - Parameters required to construct the Create Operation request.
   * @param params.ionDocument - The DID document model containing public keys and service endpoints.
   * @param params.recoveryKey - The recovery public key in JWK format.
   * @param params.updateKey - The update public key in JWK format.
   * @returns A promise resolving to the ION Create Operation request model, ready for submission to a Sidetree node.
   */
  public static async constructCreateRequest({ ionDocument, recoveryKey, updateKey }: {
    ionDocument: IonDocumentModel,
    recoveryKey: Jwk,
    updateKey: Jwk
  }): Promise<DidIonCreateRequest> {
    // Create an ION DID create request operation.
    const createRequest = await IonRequest.createCreateRequest({
      document    : ionDocument,
      recoveryKey : DidIonUtils.normalizeJwk(recoveryKey) as JwkEs256k,
      updateKey   : DidIonUtils.normalizeJwk(updateKey) as JwkEs256k
    }) as DidIonCreateRequest;

    return createRequest;
  }

  /**
   * Assembles an ION document model from provided services and verification methods
   *
   * This model serves as the foundation for a DID document in the ION network, facilitating the
   * creation and management of decentralized identities. It translates service endpoints and
   * public keys into a format compatible with the Sidetree protocol, ensuring the resulting DID
   * document adheres to the required specifications for ION DIDs. This method is essential for
   * constructing the payload needed to register or update DIDs within the ION network.
   *
   * @param params - The parameters containing the services and verification methods to include in the ION document.
   * @param params.services - A list of service endpoints to be included in the DID document, specifying ways to interact with the DID subject.
   * @param params.verificationMethods - A list of verification methods to be included, detailing the
   * cryptographic keys and their intended uses within the DID document.
   * @returns A Promise resolving to an `IonDocumentModel`, ready for use in Sidetree operations like DID creation and updates.
   */
  public static async createIonDocument({ services, verificationMethods }: {
    services: DidService[];
    verificationMethods: DidIonVerificationMethod[]
  }): Promise<IonDocumentModel> {
    /**
     * STEP 1: Convert verification methods to ION SDK format.
     */
    const ionPublicKeys: IonPublicKeyModel[] = [];

    for (const vm of verificationMethods) {
      // Use the given ID, the key's ID, or the key's thumbprint as the verification method ID.
      let methodId = vm.id ?? vm.publicKeyJwk.kid ?? await computeJwkThumbprint({ jwk: vm.publicKeyJwk });
      methodId = `${methodId.split('#').pop()}`; // Remove fragment prefix, if any.

      // Convert public key JWK to ION format.
      const publicKey: IonPublicKeyModel = {
        id           : methodId,
        publicKeyJwk : DidIonUtils.normalizeJwk(vm.publicKeyJwk),
        purposes     : vm.purposes as IonPublicKeyPurpose[],
        type         : 'JsonWebKey2020'
      };

      ionPublicKeys.push(publicKey);
    }

    /**
     * STEP 2: Convert service entries, if any, to ION SDK format.
     */
    const ionServices = services.map(service => ({
      ...service,
      id: `${service.id.split('#').pop()}` // Remove fragment prefix, if any.
    }));

    /**
     * STEP 3: Format as ION document.
     */
    const ionDocumentModel: IonDocumentModel = {
      publicKeys : ionPublicKeys,
      services   : ionServices
    };

    return ionDocumentModel;
  }

  /**
   * Normalize the given JWK to include only specific members and in lexicographic order.
   *
   * @param jwk - The JWK to normalize.
   * @returns The normalized JWK.
   */
  private static normalizeJwk(jwk: Jwk): Jwk {
    const keyType = jwk.kty;
    let normalizedJwk: Jwk;

    if (keyType === 'EC') {
      normalizedJwk = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
    } else if (keyType === 'oct') {
      normalizedJwk = { k: jwk.k, kty: jwk.kty };
    } else if (keyType === 'OKP') {
      normalizedJwk = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
    } else if (keyType === 'RSA') {
      normalizedJwk = { e: jwk.e, kty: jwk.kty, n: jwk.n };
    } else {
      throw new Error(`Unsupported key type: ${keyType}`);
    }

    return normalizedJwk;
  }
}
