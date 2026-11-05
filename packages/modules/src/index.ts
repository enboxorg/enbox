/**
 * Standard reusable DWN module definitions for the Enbox ecosystem.
 *
 * Each module exports:
 * - A raw `ModuleDefinition` (e.g. `ProfileDefinition`)
 * - A typed module created via `defineModule()` (e.g. `ProfileModule`)
 * - Data shape types for each record type (e.g. `ProfileData`)
 * - Runtime codecs that map each module type to its application value
 *
 * @packageDocumentation
 */

export * from './connect.js';
export * from './preferences.js';
export * from './profile.js';
export * from './profile-reader.js';
