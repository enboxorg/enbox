---
"@enbox/crypto": patch
---

refactor: reduce cognitive complexity in JWE/COSE functions (Sonar S3776)

Behavior-preserving extract-method refactoring of 7 crypto functions flagged for
excessive cognitive complexity, bringing each to the ≤15 threshold. Every change
lifts a contiguous, self-contained block (a full algorithm branch, header-validation
pass, or CBOR-decode step — following the existing RFC-comment boundaries) into a
named private helper called at the exact same point. No validation, allow-list, or
security check was reordered, weakened, merged, or removed, and no error type/code/
message changed.

- `FlattenedJwe.decrypt` / `encrypt` — header validation, algorithm-allow-list
  enforcement (still before key management), CEK resolution (incl. the RFC 7516
  §11.5 timing-attack CEK-substitution fallback), and ciphertext dispatch extracted.
- `JweKeyManagement.decrypt` — per-`alg` branches (`dir` / `ECDH-ES` / `PBES2`, incl.
  the `minP2cCount` iteration-count guard) extracted; the switch dispatch is untouched.
- `CoseKey.fromJwk` / `toJwk`, `CoseSign1.decode`, `Eat.parseClaims` — OKP/EC2 key
  mapping, COSE_Sign1 envelope decoding, and CWT/EAT claim extraction extracted.

Verified: `@enbox/crypto` build + lint clean; all 748 crypto tests pass (including
the JWE/COSE security vectors and round-trips).
