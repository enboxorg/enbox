export class DwnConstant {
  /** Default number of entries returned by one query page when the caller omits a limit. */
  public static readonly defaultQueryPageSize = 100;

  /** Maximum number of entries a caller may request in one query page. */
  public static readonly maxQueryPageSize = 1000;

  /** Maximum number of values accepted by one query filter collection. */
  public static readonly maxFilterValues = 100;

  /**
   * The maximum size of raw data that will be returned as `encodedData`.
   *
   * We chose 30k, as after encoding it would give plenty of headroom up to the 65k limit in most SQL variants.
   * We currently encode using base64url which is a 33% increase in size.
   */
  public static readonly maxDataSizeAllowedToBeEncoded = 30_000;

  /**
   * Maximum supported `$recordLimit.max`. Level-backed occupancy projection retains
   * at most this many rank keys while finding a parent group's cutoff.
   */
  public static readonly maxRecordLimit = 1000;
}
