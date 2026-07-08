---
"@enbox/crypto": patch
"@enbox/agent": patch
"@enbox/dids": patch
"@enbox/dwn-sdk-js": patch
---

fix: resolve SonarCloud redundant-union-type issues (S6571)

Type-only, behavior-preserving cleanups:

- JOSE header/key types (`JweHeaderParams` `alg`/`enc`, `JwsHeaderParams` `alg`,
  `JwkUse`) and DID `@context` fields used `'literal' | … | string`, which
  TypeScript collapses to plain `string` — silently discarding the literal
  hints. Switched the trailing `| string` to `| (string & {})` so the
  registered/spec values provide editor autocomplete while any string is still
  accepted (required by the JOSE/DID specs). Matches the existing
  `(string & {})` pattern in `dwn-sdk-js` protocol types.
- `ProtocolRuleSetValue` dropped the redundant `ProtocolDeliveryStrategy`
  constituent, whose `'direct' | 'subscribe'` values are already covered by the
  union's `string` member.
