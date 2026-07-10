/**
 * The `SimpleKeyDeriver` interface provides a single `deriveKey()` method for key derivation.
 *
 * This is useful for implementations that only need key derivation (not raw bit derivation).
 */
export interface SimpleKeyDeriver<
  DeriveKeyInput,
  DeriveKeyOutput,
> {
  /**
   * Derives a cryptographic key based on the provided input parameters.
   *
   * @param params - The parameters for the key derivation process.
   *
   * @returns A Promise resolving to the derived key in the specified output format.
   */
  deriveKey(params: DeriveKeyInput): Promise<DeriveKeyOutput>;
}

/**
 * The `KeyBytesDeriver` interface provides a method for deriving a byte array using a key
 * derivation algorithm.
 *
 * The `deriveKeyBytes()` method derives cryptographic bits from input data using the specified
 * key derivation algorithm. This interface is designed to support various key derivation
 * algorithms, accommodating different input and output types.
 */
export interface KeyBytesDeriver<
  DeriveKeyBytesInput,
  DeriveKeyBytesOutput
> {
  /**
   * Generates a specified number of cryptographic bits from given input parameters.
   *
   * @remarks
   * The `deriveKeyBytes()` method of the {@link KeyBytesDeriver | `KeyBytesDeriver`} interface is
   * used to create cryptographic material such as initialization vectors or keys from various
   * sources. The method takes in parameters specific to the chosen key derivation algorithm and
   * outputs a promise that resolves to a `Uint8Array` containing the derived bits.
   *
   * @param params - The parameters for the key derivation process, specific to the chosen
   *                 algorithm.
   *
   * @returns A Promise resolving to the derived bits in the specified format.
   */
  deriveKeyBytes(params: DeriveKeyBytesInput): Promise<DeriveKeyBytesOutput>;
}