---
"@enbox/crypto": patch
---

fix(crypto): publish updated barrel with algorithm class exports

The `@enbox/crypto@0.0.3` dist was built before the algorithm barrel
exports (`AesKwAlgorithm`, `HkdfAlgorithm`, `Pbkdf2Algorithm`,
`X25519Algorithm`, `EciesSecp256k1`) were added to `index.ts`.
`@enbox/agent@0.1.4` imports these symbols, causing Vite/Rollup build
failures in downstream apps (`"AesKwAlgorithm" is not exported`).

The source was already correct — this bump triggers a fresh publish so
the dist matches the source.
