import { FilterUtility } from './filter.js';

/**
 * Minimal module-bound scope shape used by permission grant authorization.
 *
 * Permission grants and candidate records/filters are projected down to these
 * fields before matching so grant selection and server enforcement use the
 * same rules.
 */
export type ModuleScope = {
  module?: string;
  modulePath?: string;
  contextId?: string;
};

/**
 * Shared matching rules for module-scoped permission grants.
 *
 * Matching fails closed for invalid combinations: `modulePath` and
 * `contextId` are mutually exclusive, and either field requires `module`.
 * `module` matches by exact equality. `modulePath` and `contextId` scopes
 * match subtrees: the target value must equal the scoped value or begin with the
 * scoped value followed by `/`.
 */
export class PermissionScopeMatcher {
  /**
   * Determines whether a candidate target is within a grant scope.
   */
  public static matches(scope: ModuleScope, target: ModuleScope): boolean {
    if (scope.modulePath !== undefined && scope.contextId !== undefined) {
      return false;
    }

    if ((scope.modulePath !== undefined || scope.contextId !== undefined) && scope.module === undefined) {
      return false;
    }

    if (scope.module !== undefined && scope.module !== target.module) {
      return false;
    }

    if (scope.modulePath !== undefined) {
      return FilterUtility.matchesSubtree(scope.modulePath, target.modulePath);
    }

    if (scope.contextId !== undefined) {
      return FilterUtility.matchesSubtree(scope.contextId, target.contextId);
    }

    return true;
  }
}
