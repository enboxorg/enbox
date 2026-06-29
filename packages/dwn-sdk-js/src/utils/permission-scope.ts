/**
 * Minimal protocol-bound scope shape used by permission grant authorization.
 *
 * Permission grants and candidate records/filters are projected down to these
 * fields before matching so grant selection and server enforcement use the
 * same rules.
 */
export type ProtocolScope = {
  protocol?: string;
  protocolPath?: string;
  contextId?: string;
};

/**
 * Shared matching rules for protocol-scoped permission grants.
 *
 * Matching fails closed for invalid combinations: `protocolPath` and
 * `contextId` are mutually exclusive, and either field requires `protocol`.
 * `protocol` matches by exact equality. `protocolPath` and `contextId` scopes
 * match subtrees: the target value must equal the scoped value or begin with the
 * scoped value followed by `/`.
 */
export class PermissionScopeMatcher {
  /**
   * Determines whether a candidate target is within a grant scope.
   */
  public static matches(scope: ProtocolScope, target: ProtocolScope): boolean {
    if (scope.protocolPath !== undefined && scope.contextId !== undefined) {
      return false;
    }

    if ((scope.protocolPath !== undefined || scope.contextId !== undefined) && scope.protocol === undefined) {
      return false;
    }

    if (scope.protocol !== undefined && scope.protocol !== target.protocol) {
      return false;
    }

    if (scope.protocolPath !== undefined) {
      return PermissionScopeMatcher.matchesSubtree(scope.protocolPath, target.protocolPath);
    }

    if (scope.contextId !== undefined) {
      return PermissionScopeMatcher.matchesContextId(scope.contextId, target.contextId);
    }

    return true;
  }

  private static matchesContextId(scopeContextId: string, candidateContextId: unknown): boolean {
    return PermissionScopeMatcher.matchesSubtree(scopeContextId, candidateContextId);
  }

  private static matchesSubtree(scopeValue: string, candidateValue: unknown): boolean {
    return typeof candidateValue === 'string' &&
      (candidateValue === scopeValue || candidateValue.startsWith(scopeValue + '/'));
  }
}
