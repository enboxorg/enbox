/**
 * A service tier offered by a DWN provider.
 */
export type DwnProviderTier = {
  /** Tier name (e.g. "Free", "Pro", "Enterprise"). */
  name : string;
  /** Human-readable description of what the tier includes. */
  description : string;
  /** Human-readable pricing (e.g. "$5/mo", "Free", "Contact us"). */
  pricing? : string;
};

/**
 * A single DWN provider listing in a provider directory.
 * Used by wallets to present a curated list of DWN providers to users.
 */
export type DwnProviderListing = {
  /** Display name of the provider (e.g. "Enbox Cloud"). */
  name : string;
  /** Short description of the provider. */
  description : string;
  /** DWN server base URL — used for `GET /info` discovery. */
  url : string;
  /** URL to the provider's logo image. */
  logoUrl? : string;
  /** Available service tiers. */
  tiers? : DwnProviderTier[];
};

/**
 * A directory of DWN providers.
 * This is a static JSON document maintained by the wallet provider.
 */
export type DwnProviderDirectory = {
  /** Schema version (e.g. "1.0"). */
  version : string;
  /** ISO 8601 timestamp of when the directory was last updated. */
  updated : string;
  /** List of DWN providers. */
  providers : DwnProviderListing[];
};
