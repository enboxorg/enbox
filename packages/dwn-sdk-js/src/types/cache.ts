/**
 * A generalized cache interface.
 * The motivation behind this interface is so that code that depend on the cache can remain independent to the underlying implementation.
 */
export interface Cache {
  /**
   * Sets a key-value pair. Does not throw error.
   */
  set<T = unknown>(key: string, value: T): Promise<void>;

  /**
   * Gets the value corresponding to the given key.
   * @returns value stored corresponding to the given key; `undefined` if key is not found or expired
   */
  get<T = unknown>(key: string): Promise<T | undefined>;
}
