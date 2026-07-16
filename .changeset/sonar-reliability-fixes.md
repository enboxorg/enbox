---
"@enbox/dwn-sdk-js": patch
"@enbox/auth": patch
"@enbox/browser": patch
---

fix: resolve Sonar reliability findings

- **dwn-sdk-js** (S7746): drop the redundant `Promise.resolve()` wrapper in the async `Secp256r1.sign()`.
- **auth** (S8786): rewrite the `normalizeErrorText` status-prefix regex with first-character-disjoint separator alternation, eliminating super-linear backtracking. Behavior-preserving (verified equivalent across 36 inputs).
- **browser** (S2310, S1994): remove loop-counter mutations in the QR encoder — derive the shifted timing column instead of reassigning the counter, and use a `while` + toggle for pad-byte generation. Output is module-for-module identical to the reference encoder.
