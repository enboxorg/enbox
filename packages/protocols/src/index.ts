/**
 * Standard reusable DWN protocol definitions for the Enbox ecosystem.
 *
 * Each protocol exports:
 * - A raw `ProtocolDefinition` (e.g. `SocialGraphDefinition`)
 * - A typed protocol created via `defineProtocol()` (e.g. `SocialGraphProtocol`)
 * - Data shape types for each record type (e.g. `FriendData`, `ProfileData`)
 * - Runtime codecs that map each protocol type to its application value
 *
 * @packageDocumentation
 */

export * from './connect.js';
export * from './lists.js';
export * from './preferences.js';
export * from './profile.js';
export * from './profile-reader.js';
export * from './social-graph.js';
export * from './status.js';
