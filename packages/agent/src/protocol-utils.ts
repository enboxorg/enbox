import type { ProtocolDefinition, ProtocolRuleSet } from '@enbox/dwn-sdk-js';

/**
 * Navigates a protocol definition's structure to find the rule set at a given protocol path.
 * @param protocolDefinition - The protocol definition to search
 * @param protocolPath - The dot-separated protocol path (e.g. 'thread/message')
 * @returns The rule set at the given path, or undefined if the path doesn't exist
 */
export function getRuleSetAtPath(
  protocolDefinition: ProtocolDefinition,
  protocolPath: string,
): ProtocolRuleSet | undefined {
  const [first, ...rest] = protocolPath.split('/');
  // Top-level lookup uses the structure's declared `{ [key: string]:
  // ProtocolRuleSet }` index signature directly — no top-level cast.
  let ruleSet: ProtocolRuleSet | undefined = protocolDefinition.structure[first];
  for (const segment of rest) {
    if (!ruleSet) { return undefined; }
    // Nested rule sets index into a `ProtocolRuleSet`'s child map.
    // `ProtocolRuleSet` has typed `$keyAgreement`/`$actions`/etc. fields
    // alongside the child index signature, so the index access here
    // returns a union; narrow it back to `ProtocolRuleSet | undefined`.
    ruleSet = ruleSet[segment] as ProtocolRuleSet | undefined;
  }
  return ruleSet;
}

/**
 * Extracts the root context ID from a contextId or parentContextId.
 * e.g. 'abc/def/ghi' -> 'abc', 'abc' -> 'abc'
 * @param contextId - The context ID to extract the root from
 * @returns The root context ID
 */
export function getRootContextId(contextId: string): string {
  return contextId.split('/')[0] || contextId;
}

/**
 * Checks if a protocol path represents a multi-party context.
 * Returns true if the root path's subtree contains $role descendants
 * or relational who/of $actions rules that grant read access.
 *
 * @param protocolDefinition - The full protocol definition
 * @param rootProtocolPath - The root protocol path to check
 * @returns true if the protocol path represents a multi-party context
 */
export function isMultiPartyContext(
  protocolDefinition: ProtocolDefinition,
  rootProtocolPath: string,
): boolean {
  const ruleSet = getRuleSetAtPath(protocolDefinition, rootProtocolPath);
  if (!ruleSet) { return false; }

  // (a) Check for $role descendants in the subtree
  function hasRoleRecursive(rs: ProtocolRuleSet): boolean {
    for (const key in rs) {
      if (!key.startsWith('$')) {
        const child = rs[key] as ProtocolRuleSet;
        if (child.$role === true) { return true; }
        if (hasRoleRecursive(child)) { return true; }
      }
    }
    return false;
  }

  if (hasRoleRecursive(ruleSet)) {
    return true;
  }

  // (b) Check for relational who/of read rules anywhere in the protocol
  //     that reference a path within this subtree. A rule like
  //     { who: 'recipient', of: 'email', can: ['read'] } on any record
  //     type means the email recipient needs a context key.
  return hasRelationalReadAccess(
    undefined, rootProtocolPath, protocolDefinition,
  );
}

/**
 * Checks whether any relational who/of rule in the protocol grants
 * read access for a given actor type and ancestor path.
 *
 * Walks the *entire* protocol structure looking for any $actions rule that:
 *   - Has `who` equal to `actorType` ('recipient' or 'author'), or any actor
 *     type if `actorType` is `undefined`
 *   - Has `of` equal to `ofPath`
 *   - Has `can` including 'read'
 *
 * @param actorType  - 'author' | 'recipient', or undefined for any
 * @param ofPath     - The protocol path to check (e.g. 'thread', 'email')
 * @param protocolDefinition - The full protocol definition
 * @returns true if a matching relational read rule exists
 */
export function hasRelationalReadAccess(
  actorType: 'author' | 'recipient' | undefined,
  ofPath: string,
  protocolDefinition: ProtocolDefinition,
): boolean {
  function walkRuleSet(rs: ProtocolRuleSet): boolean {
    // Check $actions on this node
    if (rs.$actions) {
      for (const rule of rs.$actions) {
        if (
          rule.who &&
          rule.who !== 'anyone' &&
          (actorType === undefined || rule.who === actorType) &&
          rule.of === ofPath &&
          rule.can?.includes('read')
        ) {
          return true;
        }
      }
    }

    // Recurse into child record types
    for (const key in rs) {
      if (!key.startsWith('$')) {
        if (walkRuleSet(rs[key] as ProtocolRuleSet)) {
          return true;
        }
      }
    }
    return false;
  }

  // Walk every top-level type. The structure is typed as
  // `{ [key: string]: ProtocolRuleSet }`, so each child is directly a
  // ProtocolRuleSet — no top-level cast needed.
  for (const key in protocolDefinition.structure) {
    if (walkRuleSet(protocolDefinition.structure[key])) {
      return true;
    }
  }
  return false;
}

/**
 * Analyses a record write to determine which DIDs need context key delivery.
 *
 * Returns a set of participant DIDs that should receive `contextKey` records.
 * The DWN owner (tenantDid) is always excluded — they have ProtocolPath access.
 *
 * Cases handled:
 *   1. `$role` record with a recipient -> recipient is a participant
 *   2. Record has a recipient and a relational read rule grants access
 *      via `{ who: 'recipient', of: '<path>', can: ['read'] }`
 *   3. Record is authored by an external party -> if `{ who: 'author', of:
 *      '<path>', can: ['read'] }` rules grant read access, the author needs
 *      a context key.
 *
 * @param params.protocolDefinition - The installed protocol definition
 * @param params.protocolPath       - The written record's protocol path
 * @param params.recipient          - Recipient DID from the record, if any
 * @param params.tenantDid          - The DWN owner's DID (excluded from results)
 * @param params.authorDid          - Author DID if externally authored, undefined otherwise
 * @returns Set of DIDs that need context key delivery
 */
export function detectNewParticipants({ protocolDefinition, protocolPath, recipient, tenantDid, authorDid }: {
  protocolDefinition: ProtocolDefinition;
  protocolPath: string;
  recipient?: string;
  tenantDid: string;
  authorDid?: string;
}): Set<string> {
  const participants = new Set<string>();

  // Navigate to the rule set at the given protocol path
  const ruleSet = getRuleSetAtPath(protocolDefinition, protocolPath);
  if (!ruleSet) { return participants; }

  // Case 1: $role record -> recipient is a participant
  if (ruleSet.$role === true && recipient) {
    participants.add(recipient);
  }

  // Case 2: Record has a recipient -> check if relational read rules exist
  if (recipient && recipient !== tenantDid) {
    if (hasRelationalReadAccess('recipient', protocolPath, protocolDefinition)) {
      participants.add(recipient);
    }
  }

  // Case 3: External author -> check if author-based relational read rules exist.
  // If `{ who: 'author', of: '<path>', can: ['read'] }` is defined anywhere
  // in the protocol, the external author needs a context key to decrypt.
  if (authorDid && authorDid !== tenantDid) {
    if (hasRelationalReadAccess('author', protocolPath, protocolDefinition)) {
      participants.add(authorDid);
    }
  }

  // Remove the DWN owner — they always have ProtocolPath access
  participants.delete(tenantDid);

  return participants;
}
