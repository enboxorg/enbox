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
 * `protocol` and `protocolPath` match by exact equality. `contextId` scopes
 * match a context subtree: the target context must equal the scoped context or
 * begin with the scoped context followed by `/`.
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
      return scope.protocolPath === target.protocolPath;
    }

    if (scope.contextId !== undefined) {
      return PermissionScopeMatcher.matchesContextId(scope.contextId, target.contextId);
    }

    return true;
  }

  private static matchesContextId(scopeContextId: string, candidateContextId: string | undefined): boolean {
    return candidateContextId === scopeContextId || candidateContextId?.startsWith(scopeContextId + '/') === true;
  }
}
