/**
 * Object helpers used throughout the DWN engine.
 *
 * Re-exported from `@enbox/common` so the helpers have a single canonical
 * implementation across the monorepo. Internal call sites continue to
 * import from `./object.js` so the engine's own module structure stays
 * unchanged; only the implementation moved.
 */

export { isEmptyObject, omitUndefined, removeEmptyObjects, removeUndefinedProperties } from '@enbox/common';
