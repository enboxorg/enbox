import type { ModuleActionRule } from '@enbox/dwn-sdk-js';

/** Empty owner-issued membership; its signed recipient identifies the member. */
export type RoleDefinition = {
  $role: true;
  $immutable: true;
  $size: { max: 2 };
  $actions: ModuleActionRule[];
};

/** Explicit roster and issuance choices; no role name has implied authority. */
export type RoleDefinitionOptions = {
  /** Include recipient-of-self read. Omit only when preserving an existing contract. */
  selfRead?: boolean;
  /** Roles permitted to inspect this assignment, in authored order. */
  readableBy?: readonly string[];
  /** Roles permitted to issue assignments at this path. Defaults to owner-only. */
  issuedBy?: readonly string[];
  /** Roles permitted to revoke another recipient's assignment. Defaults to owner-only. */
  revokedBy?: readonly string[];
};

/** Reuse policy source while retaining the consuming module's concrete membership identity. */
export function roleDefinition(path: string, options: RoleDefinitionOptions = {}): RoleDefinition {
  assertModulePath(path);
  const actions: ModuleActionRule[] = [];
  if (options.selfRead !== false) {
    actions.push({ who: 'recipient', of: path, can: ['read'] });
  }
  actions.push({ who: 'recipient', can: ['co-delete'] });
  const roleActions = new Map<string, ModuleActionRule>();
  for (const [roles, action] of [
    [options.readableBy, 'read'],
    [options.issuedBy, 'create'],
    [options.revokedBy, 'co-delete'],
  ] as const) {
    for (const role of roles ?? []) {
      assertRoleReference(role);
      let rule = roleActions.get(role);
      if (rule === undefined) {
        rule = { role, can: [] };
        roleActions.set(role, rule);
      }
      if (rule.can.includes(action)) {
        throw new TypeError(`roleDefinition: duplicate '${action}' authority for '${role}'.`);
      }
      rule.can.push(action);
    }
  }
  return { $role: true, $immutable: true, $size: { max: 2 }, $actions: [...actions, ...roleActions.values()] };
}

/** Canonical DWN record paths use alphabetic segments. */
export function assertModulePath(path: string): void {
  if (!/^[a-zA-Z]+(?:\/[a-zA-Z]+)*$/.test(path)) {
    throw new TypeError(`Invalid module path '${path}'.`);
  }
}

/** Validate a local role path or an explicitly qualified role reference. */
export function assertRoleReference(reference: string): void {
  const parts = reference.split(':');
  if (parts.length > 2 || (parts.length === 2 && !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(parts[0]))) {
    throw new TypeError(`Invalid role reference '${reference}'.`);
  }
  assertModulePath(parts.at(-1)!);
}
