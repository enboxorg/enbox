/**
 * Level-backed agent components.
 *
 * Import this subpath when you need direct access to the durable Level-backed
 * implementations. The root package keeps these behind lazy defaults so bare
 * browser imports do not resolve the Level stack until an agent is created.
 *
 * @module
 */

export * from './agent-did-resolver-cache.js';
export * from './sync-engine-level.js';
