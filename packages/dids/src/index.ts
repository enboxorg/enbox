export * from './types/did-core.js';
export * from './types/did-resolution.js';
export type * from './types/multibase.js';
export type * from './types/portable-did.js';

export * from './did.js';
export * from './did-error.js';
export * from './dwn-endpoint-resolution.js';
export * from './bearer-did.js';

export * from './methods/did-dht.js';
export * from './methods/did-jwk.js';
export * from './methods/did-key.js';
export * from './methods/did-method.js';
export * from './methods/did-web.js';

export * from './resolver/resolver-cache-memory.js';
export * from './resolver/resolver-cache-noop.js';
export * from './resolver/universal-resolver.js';

export { isPortableDid } from './utils.js';
export * as utils from './utils.js';
