/**
 * Standard reusable DWN protocol definitions for the Enbox ecosystem.
 *
 * Each protocol exports:
 * - A raw `ProtocolDefinition` (e.g. `SocialGraphDefinition`)
 * - A typed protocol created via `defineProtocol()` (e.g. `SocialGraphProtocol`)
 * - Data shape types for each record type (e.g. `FriendData`, `ProfileData`)
 * - A `SchemaMap` type mapping type names to data shapes
 *
 * @packageDocumentation
 */

export * from './lists.js';
export * from './preferences.js';
export * from './profile.js';
export * from './social-graph.js';
export * from './status.js';
