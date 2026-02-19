import type { Jwk } from '../jose/jwk.js';

/**
 * The `KeyImporterExporter` interface provides methods for importing and exporting cryptographic
 * keys. It includes `importKey()` for importing external keys, and `exportKey()` for exporting a
 * cryptographic key to an external JWK object.
 *
 * This interface is designed to handle various key formats and is adaptable for different
 * cryptographic environments and requirements.
 */
export interface KeyImporterExporter<
  ImportKeyInput,
  ImportKeyOutput,
  ExportKeyInput
> {
  /**
   * Exports a cryptographic key to an external JWK object.
   *
   * @remarks
   * The `exportKey()` method of the {@link KeyImporterExporter | `KeyImporterExporter`} interface
   * returns a cryptographic key in JWK format, facilitating interoperability and backup.
   *
   * @param params - The parameters for the key export operation.
   *
   * @returns A Promise resolving to the exported key in JWK format.
   */
  exportKey(params: ExportKeyInput): Promise<Jwk>;

  /**
   * Imports an external key in JWK format.
   *
   * @remarks
   * The `importKey()` method of the {@link KeyImporterExporter | `KeyImporterExporter`} interface
   * takes as input an external key in JWK format and typically returns a key identifier reference
   * for the imported key.
   *
   * @param params - The parameters for the key import operation.
   *
   * @returns A Promise resolving to the key identifier of the imported key.
   */
  importKey(params: ImportKeyInput): Promise<ImportKeyOutput>;
}

/**
 * The `KeyExporter` interface provides a method for exporting cryptographic keys.
 */
export interface KeyExporter<ExportKeyInput, ExportKeyOutput = Jwk> {
  /**
   * Exports a cryptographic key to an external JWK object.
   *
   * @remarks
   * The `exportKey()` method returns a cryptographic key in JWK format, facilitating
   * interoperability and backup.
   *
   * @param params - The parameters for the key export operation.
   *
   * @returns A Promise resolving to the exported key in the specified format.
   */
  exportKey(params: ExportKeyInput): Promise<ExportKeyOutput>;
}

/**
 * The `KeyImporter` interface provides a method for importing cryptographic keys.
 */
export interface KeyImporter<ImportKeyInput, ImportKeyOutput = void> {
  /**
   * Imports an external key in JWK format.
   *
   * @remarks
   * The `importKey()` method takes as input an external key in JWK format and typically returns a
   * key identifier reference for the imported key.
   *
   * @param params - The parameters for the key import operation.
   *
   * @returns A Promise resolving to the key identifier of the imported key.
   */
  importKey(params: ImportKeyInput): Promise<ImportKeyOutput>;
}

/**
 * The `KeyDeleter` interface provides a method for deleting cryptographic keys.
 */
export interface KeyDeleter<DeleteKeyInput> {
  /**
   * Deletes a cryptographic key.
   *
   * @remarks
   * The `deleteKey()` method removes a cryptographic key from the key store.
   *
   * @param params - The parameters for the key deletion operation.
   */
  deleteKey(params: DeleteKeyInput): Promise<void>;
}
