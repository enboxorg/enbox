# @enbox/protocols

## 0.2.109

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.82

## 0.2.108

### Patch Changes

- Updated dependencies [[`8f4715d`](https://github.com/enboxorg/enbox/commit/8f4715d461862ea11ab560b75338ebdcd87b79bf)]:
  - @enbox/api@0.6.81

## 0.2.107

### Patch Changes

- Updated dependencies [[`1af0250`](https://github.com/enboxorg/enbox/commit/1af0250c6632002121d43cc3a8d37ce20db1bc84)]:
  - @enbox/dwn-sdk-js@0.4.25
  - @enbox/api@0.6.80

## 0.2.106

### Patch Changes

- Updated dependencies [[`54cb801`](https://github.com/enboxorg/enbox/commit/54cb80166846b3395cd3543ae8a1c387ae5857d3), [`7435259`](https://github.com/enboxorg/enbox/commit/743525922b963264c909f25c6a98d688807b5fb0), [`eebdf97`](https://github.com/enboxorg/enbox/commit/eebdf9754773c1c8fb4836c8f3e106c2a1f60a62), [`137ce5f`](https://github.com/enboxorg/enbox/commit/137ce5f652af3f469329039cdd1cca4b675c7a36), [`7435259`](https://github.com/enboxorg/enbox/commit/743525922b963264c909f25c6a98d688807b5fb0), [`1eabea1`](https://github.com/enboxorg/enbox/commit/1eabea135a67906fb9730c58244f40077e312bec), [`7435259`](https://github.com/enboxorg/enbox/commit/743525922b963264c909f25c6a98d688807b5fb0), [`85dfa69`](https://github.com/enboxorg/enbox/commit/85dfa69369c3ff28c41320a7a79336b2416735b1)]:
  - @enbox/dwn-sdk-js@0.4.24
  - @enbox/api@0.6.79

## 0.2.105

### Patch Changes

- Updated dependencies [[`6cfbbd5`](https://github.com/enboxorg/enbox/commit/6cfbbd5fef64846aeb54fff8c07f94266cf4c5ec), [`b5c2d3e`](https://github.com/enboxorg/enbox/commit/b5c2d3eb59ac0f63d8deccca12706303318667e0), [`5ecf249`](https://github.com/enboxorg/enbox/commit/5ecf249c93a0a820e26bbcab9d10673acd6cb4eb), [`aa471e4`](https://github.com/enboxorg/enbox/commit/aa471e429731ae612f92e5df65a95c1c36036f79), [`7d9e946`](https://github.com/enboxorg/enbox/commit/7d9e9469d6d642329e38e7a8281b5ed0af01bc02), [`2cf5cfc`](https://github.com/enboxorg/enbox/commit/2cf5cfcaf8046fe4895233e45ff5760e083bf6bc), [`b5c2d3e`](https://github.com/enboxorg/enbox/commit/b5c2d3eb59ac0f63d8deccca12706303318667e0)]:
  - @enbox/api@0.6.78
  - @enbox/dwn-sdk-js@0.4.23

## 0.2.104

### Patch Changes

- Updated dependencies [[`2eee007`](https://github.com/enboxorg/enbox/commit/2eee007892807d44dad8ce828afe19aee7dfe18d)]:
  - @enbox/dwn-sdk-js@0.4.22
  - @enbox/api@0.6.77

## 0.2.103

### Patch Changes

- Updated dependencies [[`aa2f44c`](https://github.com/enboxorg/enbox/commit/aa2f44c13245b76e3494974a63a94e6416b26ee5)]:
  - @enbox/api@0.6.76
  - @enbox/dwn-sdk-js@0.4.21

## 0.2.102

### Patch Changes

- Updated dependencies [[`23b11e8`](https://github.com/enboxorg/enbox/commit/23b11e899f8f463ea897a6af17858ae639b34c48), [`20e1c7c`](https://github.com/enboxorg/enbox/commit/20e1c7c12cb829dd8c0da0a76bc0064df49598e6), [`69a1c6a`](https://github.com/enboxorg/enbox/commit/69a1c6ad9c68a36e19c3f93dcc379e7ac16f4f15), [`e6b1c06`](https://github.com/enboxorg/enbox/commit/e6b1c0636c3c63a9fba2dd154db38f147358c460), [`a2848ac`](https://github.com/enboxorg/enbox/commit/a2848acf96fee15fba5701ddb3e04f4b98787f3e), [`16b7cbc`](https://github.com/enboxorg/enbox/commit/16b7cbc5e7d5f69dc0b87738c0cc6e69951ce649), [`fa8346c`](https://github.com/enboxorg/enbox/commit/fa8346cd21c2edb91270b0d198312d0855244584)]:
  - @enbox/api@0.6.75
  - @enbox/dwn-sdk-js@0.4.20

## 0.2.101

### Patch Changes

- [#1470](https://github.com/enboxorg/enbox/pull/1470) [`8291bcd`](https://github.com/enboxorg/enbox/commit/8291bcd45de6a48b15a49871bcc48df4a5430e18) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove `SocialGraphProtocol`, `StatusProtocol`, and `ListsProtocol` from the shipped catalog together with their definitions, data types, codecs, and JSON Schemas. The removed Social Graph definition allowed anyone to create a `friend` role record, while current role invocation accepts a matching role recipient without independently binding the role to a trusted issuer. A caller could therefore self-assign friend authority and reach friend-gated data in protocols composed with that role. Profile no longer composes with Social Graph and no longer exposes `PrivateNoteData` or the friend-gated `privateNote` path.

  This removal does not change engine role verification, uninstall definitions, revoke existing role records, or migrate stored data. Applications that installed these protocols should stop treating their role-gated records as confidential, install a corrected protocol under a new URI, migrate and re-encrypt sensitive records, and retire the old records. No replacement or compatibility aliases are provided.

- Updated dependencies [[`00dafdf`](https://github.com/enboxorg/enbox/commit/00dafdf88c517df248639680dc89616e9f42616d), [`fb7ca10`](https://github.com/enboxorg/enbox/commit/fb7ca10fdc7b58a2e97d59658063033805491a9a), [`c625d63`](https://github.com/enboxorg/enbox/commit/c625d6398feff887d2051bba6e5d5e306eaa3fdf), [`d818618`](https://github.com/enboxorg/enbox/commit/d8186183f76b5556c26dd94a3ece5fc3db411a44), [`8d288dd`](https://github.com/enboxorg/enbox/commit/8d288dd80fab6e4bcf0f92f3cde37799a13fcf05), [`659372d`](https://github.com/enboxorg/enbox/commit/659372de22c2cf7481fa4d28ba2b6380483e93a4), [`2a4223a`](https://github.com/enboxorg/enbox/commit/2a4223a8255c7c9c6efc1245021fd620f11902ba), [`9511e65`](https://github.com/enboxorg/enbox/commit/9511e6566d92bb7b89e8c35fe3f0602c3a313e4b), [`d257e04`](https://github.com/enboxorg/enbox/commit/d257e04b5001f596d28691c942ca5d0bf25c2c22), [`8b0dc99`](https://github.com/enboxorg/enbox/commit/8b0dc99476d7981a2f2bd97fabbf0ecbe4754d33), [`80dab68`](https://github.com/enboxorg/enbox/commit/80dab686cb24691f6df5fdc46a61552cbeb5faf4), [`33dba16`](https://github.com/enboxorg/enbox/commit/33dba165f9f5770044ccafb9f1f0572f2f555abf)]:
  - @enbox/dwn-sdk-js@0.4.19
  - @enbox/api@0.6.74

## 0.2.100

### Patch Changes

- [#1463](https://github.com/enboxorg/enbox/pull/1463) [`96c5dbd`](https://github.com/enboxorg/enbox/commit/96c5dbddfb921a4972dc552a4d64ea9c7086b6ad) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Replace phantom schema-map typing with runtime record codecs. Typed records now encode and decode through their protocol declaration, expose application values through `Record.value()`, and use `within` as the single hierarchy selector. Remove the superseded schema-map types, caller-controlled `Record.update()` data-format overrides, generic `RecordData.json<T>()`, and root utilities namespace. Typed protocol declarations reject `$ref` composition until referenced protocol metadata can be supplied explicitly.

  Replace the public `generateTypes()` and `CodegenOptions.emitDefinition` codegen surface with `generateProtocolModule()`, which emits complete codec-backed protocol modules from protocol definitions and declared MIME formats. Expose the codec primitives through the browser and CLI facades.

- Updated dependencies [[`ddff1e1`](https://github.com/enboxorg/enbox/commit/ddff1e18e854053a901ba601cb4102ead4b6e36c), [`5e9f5ce`](https://github.com/enboxorg/enbox/commit/5e9f5cecffa18004af2c891f833eb743c9f14d7e), [`f8a7ff1`](https://github.com/enboxorg/enbox/commit/f8a7ff1f9a40af66e1bdeb313e1131d7cbe12a48), [`96c5dbd`](https://github.com/enboxorg/enbox/commit/96c5dbddfb921a4972dc552a4d64ea9c7086b6ad), [`ddff1e1`](https://github.com/enboxorg/enbox/commit/ddff1e18e854053a901ba601cb4102ead4b6e36c)]:
  - @enbox/api@0.6.73
  - @enbox/dwn-sdk-js@0.4.18

## 0.2.99

### Patch Changes

- [#1446](https://github.com/enboxorg/enbox/pull/1446) [`23d84a4`](https://github.com/enboxorg/enbox/commit/23d84a4cd94d169423d9fbe5c84b5e7bd803b134) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: make `$recordLimit: { max }` one deterministic read-time visibility contract

  Query, Read, Count, and subscription snapshots now select at most `max` occupants independently for every direct-parent scope in an ancestor selection. Occupancy is ranked by initial creation time and record ID before authorization, caller filters, sorting, and pagination. Level, browser, SQLite, MySQL, and PostgreSQL share that definition.

  Observed typed views widen only limited paths to the structural occupancy scope, so a sibling write or delete can wake and rematerialize an exact-record view when its record is promoted or demoted.

  Protocol definitions no longer select a write-time strategy. Valid competing records remain stored, and the unused `purgeOldest` wire value, strategy enum, and write-time strategy guard have been removed.

- Updated dependencies [[`ca04167`](https://github.com/enboxorg/enbox/commit/ca04167e6e6e61eea56eedd5eb7acbc3b909fd4c), [`f804103`](https://github.com/enboxorg/enbox/commit/f80410366f4e3798018618f2f15ed014fd3796e8), [`764a470`](https://github.com/enboxorg/enbox/commit/764a470290d7167f1e1d8bb0702947aceeec3c0c), [`23d84a4`](https://github.com/enboxorg/enbox/commit/23d84a4cd94d169423d9fbe5c84b5e7bd803b134), [`2c78d33`](https://github.com/enboxorg/enbox/commit/2c78d3371c3cb26fea33245866326b9e43df528e), [`e07585c`](https://github.com/enboxorg/enbox/commit/e07585ce0e7ffcb65a32c51e1da22d48588339e0), [`fe5f985`](https://github.com/enboxorg/enbox/commit/fe5f9859438ce1e9663cfc7bda1b5c6eb82b7774), [`50c40fd`](https://github.com/enboxorg/enbox/commit/50c40fd50950d5a25c0d5c342f55b078adf247e9)]:
  - @enbox/dwn-sdk-js@0.4.17
  - @enbox/api@0.6.72

## 0.2.98

### Patch Changes

- Updated dependencies [[`7a437b2`](https://github.com/enboxorg/enbox/commit/7a437b2bed8cdb88b30eec86fb6420801845a352)]:
  - @enbox/dwn-sdk-js@0.4.16
  - @enbox/api@0.6.71

## 0.2.97

### Patch Changes

- Updated dependencies [[`f688ea7`](https://github.com/enboxorg/enbox/commit/f688ea711b3bb3547e47f8f1697e3af54c441b2c)]:
  - @enbox/api@0.6.70

## 0.2.96

### Patch Changes

- Updated dependencies [[`bad337e`](https://github.com/enboxorg/enbox/commit/bad337e27a7f5e1029780401a419bc5c313c03ff), [`7267cf1`](https://github.com/enboxorg/enbox/commit/7267cf1e406484d3361d926368a97e2b0353a9a3)]:
  - @enbox/api@0.6.69
  - @enbox/dwn-sdk-js@0.4.15

## 0.2.95

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.68

## 0.2.94

### Patch Changes

- Updated dependencies [[`33a4dea`](https://github.com/enboxorg/enbox/commit/33a4deab2e15b46d545154cbca2836ef0af0f7ca)]:
  - @enbox/dwn-sdk-js@0.4.14
  - @enbox/api@0.6.67

## 0.2.93

### Patch Changes

- [#1353](https://github.com/enboxorg/enbox/pull/1353) [`ab5d3c9`](https://github.com/enboxorg/enbox/commit/ab5d3c940ab4edd4c81fc18303084ee22632d14b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: add `createProfileReader` — a cached read layer for other users' public profiles

  `@enbox/protocols` now ships a profile reader implementing the fetch shape wallets write: one records query for the published profile JSON singleton plus direct anyone-read `RecordsRead`s for the unpublished avatar/hero image singletons. It provides `get()`, refcounted `watch()` with field-level settlement, `getSnapshot()` for `useSyncExternalStore`-style bindings, a retry ladder for retryable statuses (401/403/408/410/425/429/5xx + transport errors), access-driven negative caching, bounded fetch concurrency, idle release, and an injectable clock. Works over a connected records surface (`DwnApi` from `@enbox/api/advanced`) and over `Enbox.anonymous()`. `@enbox/browser` re-exports the reader for batteries-included dapp setups.

  Profile JSON is treated as untrusted input: fields are validated against a strict allowlist (string-valued `displayName`/`bio`/`tagline`/`location`/`website`/`pronouns` only) and the requested DID plus separately-fetched image Blobs always win over anything in the JSON. Images load lazily by default (`images: 'eager' | 'lazy' | 'off'`, `loadImages()` on demand), are fetched only after the root profile record is confirmed (orphaned avatar/hero records left by non-pruning deletes are suppressed), are size-validated against the protocol maxima before and after download, and retained Blobs are bounded by a configurable LRU byte budget (default 128 MiB).

- Updated dependencies [[`c4ee0bc`](https://github.com/enboxorg/enbox/commit/c4ee0bc057fb5b2278926fe1d9d1add618acc08d), [`48149b9`](https://github.com/enboxorg/enbox/commit/48149b970383af60d1113019c7a54b3f26cdd24c), [`851ffb4`](https://github.com/enboxorg/enbox/commit/851ffb40396e710b596463c62b055034b3882fad), [`1774805`](https://github.com/enboxorg/enbox/commit/1774805f09934ff839c3008bfcbf2bf4fff04963), [`4430d0d`](https://github.com/enboxorg/enbox/commit/4430d0df16b34215f3db6965960e07a67f6d8441), [`6151a52`](https://github.com/enboxorg/enbox/commit/6151a5249e4cee07673cff0290cdbcb03d80db86), [`a4fb419`](https://github.com/enboxorg/enbox/commit/a4fb419d9475b9d21e518028411ef149c47cbdc9), [`cd6940e`](https://github.com/enboxorg/enbox/commit/cd6940e28434cac31587bd2745ce3411d670bfa3), [`eabdec5`](https://github.com/enboxorg/enbox/commit/eabdec5c9efe2580ec3412edd07f8f2f0a3e5b67), [`28407c2`](https://github.com/enboxorg/enbox/commit/28407c2fe21b5dab27a42c1ccef6786be6b8c211), [`1e8c7bb`](https://github.com/enboxorg/enbox/commit/1e8c7bb3e6b2df88ca3a6630c4bbdf408bedaefb), [`e22ac1d`](https://github.com/enboxorg/enbox/commit/e22ac1d30c09f7bce3bc4e634a4d5c7cdf95603e), [`12ce706`](https://github.com/enboxorg/enbox/commit/12ce706f9412d8405f130c2fd56c3c8f898db8c1), [`a3c42d7`](https://github.com/enboxorg/enbox/commit/a3c42d777b9bb23448c3b8fd58f26c100ee42dd0), [`76be6bb`](https://github.com/enboxorg/enbox/commit/76be6bba0e0f7a3ae25ee1829915974581960982)]:
  - @enbox/api@0.6.66
  - @enbox/dwn-sdk-js@0.4.13

## 0.2.92

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.65

## 0.2.91

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.64

## 0.2.90

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.63

## 0.2.89

### Patch Changes

- Updated dependencies [[`949fa2d`](https://github.com/enboxorg/enbox/commit/949fa2d1fa01e6aea41862b77cee64b42ca73c83)]:
  - @enbox/api@0.6.62

## 0.2.88

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.61
  - @enbox/dwn-sdk-js@0.4.12

## 0.2.87

### Patch Changes

- Updated dependencies [[`48e3db8`](https://github.com/enboxorg/enbox/commit/48e3db8764e67e8e719cb0557fa7bf739768d9ca)]:
  - @enbox/dwn-sdk-js@0.4.11
  - @enbox/api@0.6.60

## 0.2.86

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.59

## 0.2.85

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.58

## 0.2.84

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.57

## 0.2.83

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.56

## 0.2.82

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.55

## 0.2.81

### Patch Changes

- Updated dependencies [[`2501b96`](https://github.com/enboxorg/enbox/commit/2501b96d643124baebe7632ee369e893789c938b)]:
  - @enbox/dwn-sdk-js@0.4.10
  - @enbox/api@0.6.54

## 0.2.80

### Patch Changes

- Updated dependencies [[`cb7b51c`](https://github.com/enboxorg/enbox/commit/cb7b51c1ad3576fc8851e4ec41e55e46e5cb187f), [`5ac59ff`](https://github.com/enboxorg/enbox/commit/5ac59fff9e1e2804def54b6b63cf49b75199b57c)]:
  - @enbox/api@0.6.53
  - @enbox/dwn-sdk-js@0.4.9

## 0.2.79

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.52

## 0.2.78

### Patch Changes

- Updated dependencies [[`96ea6cb`](https://github.com/enboxorg/enbox/commit/96ea6cbda08a4bb6540d8a4e2664278f82d6fba8), [`6b5b978`](https://github.com/enboxorg/enbox/commit/6b5b9786ee931f8d80d84e5f2865166c39568eb6)]:
  - @enbox/api@0.6.51
  - @enbox/dwn-sdk-js@0.4.8

## 0.2.77

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.50

## 0.2.76

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.49

## 0.2.75

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.48

## 0.2.74

### Patch Changes

- Updated dependencies [[`d006765`](https://github.com/enboxorg/enbox/commit/d00676570a8645ab440e017695351828354a2251), [`7ddb0d6`](https://github.com/enboxorg/enbox/commit/7ddb0d677065483968ef9d80773e3fd81048f4ad), [`37895ff`](https://github.com/enboxorg/enbox/commit/37895ff511258ed48d10660b1f73ce597e818921), [`cda1d31`](https://github.com/enboxorg/enbox/commit/cda1d31b4c8a7df444beadd0271ff50a3482fa00), [`5de6973`](https://github.com/enboxorg/enbox/commit/5de6973f98216a3732800a6ec461520b47171902), [`6660507`](https://github.com/enboxorg/enbox/commit/6660507d9fe4d1157c9afa2f870bd3f54b92c9f6), [`c33b1ae`](https://github.com/enboxorg/enbox/commit/c33b1ae23c152c9f27fb740fd650199acc958ad2), [`042879e`](https://github.com/enboxorg/enbox/commit/042879ea1e05d45b99ab35e23f1ab2f730afa757), [`efa5171`](https://github.com/enboxorg/enbox/commit/efa5171b36aa0f46e957e74506323f9cbd4d8dc7), [`97dced6`](https://github.com/enboxorg/enbox/commit/97dced6b0eb80fccbd71ea5a8a1c250ba40153bb), [`c6feb1c`](https://github.com/enboxorg/enbox/commit/c6feb1c1b80ef2646308c3499476802d12af702e), [`6bb25d3`](https://github.com/enboxorg/enbox/commit/6bb25d3f5cfa8dadbd3ae7cfe36f9c5d24bd554c), [`a9106f1`](https://github.com/enboxorg/enbox/commit/a9106f17c94aee5f236cd5a8e81d93b70da53f58), [`23ae738`](https://github.com/enboxorg/enbox/commit/23ae7389a4c14aedf360c5b3b3bbdd8c274ef53a), [`b38dd5e`](https://github.com/enboxorg/enbox/commit/b38dd5ec24129a37e8e2bb17b3173144ac9bb863), [`ed62ddc`](https://github.com/enboxorg/enbox/commit/ed62ddc55aeb364000ef5eda2c0ae9fb16da73cc), [`96bc5f5`](https://github.com/enboxorg/enbox/commit/96bc5f5c2d80f0cb543042e3f41f5c2d4156c3d3), [`f0a65e9`](https://github.com/enboxorg/enbox/commit/f0a65e917fe4b694ecb555f7e639607c5f5c41e6), [`c921621`](https://github.com/enboxorg/enbox/commit/c92162135f165c1e06423d72180994b27434bc4c), [`25a0d8c`](https://github.com/enboxorg/enbox/commit/25a0d8ca35157762aad360459bb81800e6e2d688), [`cd08e9a`](https://github.com/enboxorg/enbox/commit/cd08e9a2dfbf060244744d88bfdf5b4b6c6b3852), [`d3e267e`](https://github.com/enboxorg/enbox/commit/d3e267e3ca259432e477715cba1b9c50db5fdb97), [`57c66a3`](https://github.com/enboxorg/enbox/commit/57c66a34079625793c8b26028f29d1eb63b969ef)]:
  - @enbox/api@0.6.47
  - @enbox/dwn-sdk-js@0.4.7

## 0.2.73

### Patch Changes

- Updated dependencies [[`f06e984`](https://github.com/enboxorg/enbox/commit/f06e984f0a512fa1e53729e31e186328595af1a1)]:
  - @enbox/dwn-sdk-js@0.4.6
  - @enbox/api@0.6.46

## 0.2.72

### Patch Changes

- Updated dependencies [[`03740b9`](https://github.com/enboxorg/enbox/commit/03740b975d39f74337d1f292ba9115dd799ad6e7), [`4863c1a`](https://github.com/enboxorg/enbox/commit/4863c1a17f132d7ffd8a8c2ac46472f8585d7d37), [`e27f4f6`](https://github.com/enboxorg/enbox/commit/e27f4f647189535ffe32a9f6a16c5859afadb3fc)]:
  - @enbox/dwn-sdk-js@0.4.5
  - @enbox/api@0.6.45

## 0.2.71

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.44

## 0.2.70

### Patch Changes

- Updated dependencies [[`25fd7d4`](https://github.com/enboxorg/enbox/commit/25fd7d433055809f4d96543807f0669ab036383f)]:
  - @enbox/dwn-sdk-js@0.4.4
  - @enbox/api@0.6.43

## 0.2.69

### Patch Changes

- Updated dependencies [[`6bd4199`](https://github.com/enboxorg/enbox/commit/6bd419937c06ff1edf27c148896157e7310631d1)]:
  - @enbox/dwn-sdk-js@0.4.3
  - @enbox/api@0.6.42

## 0.2.68

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.41

## 0.2.67

### Patch Changes

- Updated dependencies [[`05f5621`](https://github.com/enboxorg/enbox/commit/05f56216adcbdba09ae039238055a4591674ef88), [`7ff772b`](https://github.com/enboxorg/enbox/commit/7ff772bc41965463e571471f54800ce019c0f625)]:
  - @enbox/dwn-sdk-js@0.4.2
  - @enbox/api@0.6.40

## 0.2.66

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.39

## 0.2.65

### Patch Changes

- Updated dependencies [[`8bb1af2`](https://github.com/enboxorg/enbox/commit/8bb1af25e772c730de185a4e4b6fdf5b1aead052), [`970aa97`](https://github.com/enboxorg/enbox/commit/970aa972013c61d9acc6a077f2f5ec2ae72ebf54), [`18bf512`](https://github.com/enboxorg/enbox/commit/18bf51241aaad1628255a2c56e28ed5f7450a069), [`211049b`](https://github.com/enboxorg/enbox/commit/211049bd7727c80b701e8d6be243a5c464b8bc81), [`5c1e8dc`](https://github.com/enboxorg/enbox/commit/5c1e8dc6bdfee56dce59d9aa963e74c7b4e7ce77), [`44941d3`](https://github.com/enboxorg/enbox/commit/44941d381f784aa6c22430c0ab6ee57c0ac22670), [`e781263`](https://github.com/enboxorg/enbox/commit/e78126309fc09e20be025ac2bf793632234a58f3), [`05c3203`](https://github.com/enboxorg/enbox/commit/05c3203e5e1cec054754200388e8470785d356a7), [`6a8907d`](https://github.com/enboxorg/enbox/commit/6a8907de94386b714a96ac9409af26dec974cb87), [`25821ed`](https://github.com/enboxorg/enbox/commit/25821eda3a551cc9b2f6605e2716a9705ebf3f63), [`543b834`](https://github.com/enboxorg/enbox/commit/543b8340b8ef8914d52bc79fe8dbe0231e44d801), [`9b51592`](https://github.com/enboxorg/enbox/commit/9b51592a00c9e5cec0d8f01bb7b41168ffee3549), [`028dd78`](https://github.com/enboxorg/enbox/commit/028dd78442a2217044595fdd7253982af92a1e57), [`a2bfa0d`](https://github.com/enboxorg/enbox/commit/a2bfa0dafff6a60d3b0343fcade2c6e4d7d871cf), [`f90c4b8`](https://github.com/enboxorg/enbox/commit/f90c4b8a77007337b9ec7711c14885759efab383)]:
  - @enbox/api@0.6.38
  - @enbox/dwn-sdk-js@0.4.1

## 0.2.64

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.37

## 0.2.63

### Patch Changes

- Updated dependencies [[`fee3aa0`](https://github.com/enboxorg/enbox/commit/fee3aa0d7862380707fbd3fbe6c8bd85090543b5), [`7c0f246`](https://github.com/enboxorg/enbox/commit/7c0f2462dc390683943d0266be5696ef1da1dbbd), [`8a5b999`](https://github.com/enboxorg/enbox/commit/8a5b999b75a49867b9460fa9eec83667a9953361)]:
  - @enbox/dwn-sdk-js@0.4.0
  - @enbox/api@0.6.36

## 0.2.62

### Patch Changes

- Updated dependencies [[`5908941`](https://github.com/enboxorg/enbox/commit/590894124552537f9088638b7a3527d4f7f3fda9)]:
  - @enbox/dwn-sdk-js@0.3.9
  - @enbox/api@0.6.35

## 0.2.61

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.34

## 0.2.60

### Patch Changes

- Updated dependencies [[`22dffaa`](https://github.com/enboxorg/enbox/commit/22dffaa13cceb18935a20508fb131f5bb83993dd), [`e0badc8`](https://github.com/enboxorg/enbox/commit/e0badc848e26b23e45fbdf79b53cb49bbf0afcc2), [`1a9ba9d`](https://github.com/enboxorg/enbox/commit/1a9ba9db3aa09e7dd73e22e6f555c63eba978fb1), [`923b14f`](https://github.com/enboxorg/enbox/commit/923b14ffc986a7c98ee11a73d979d5d869579881), [`151ab89`](https://github.com/enboxorg/enbox/commit/151ab894a7a2f18a7805a6b984b137dcef009e19), [`650f630`](https://github.com/enboxorg/enbox/commit/650f6306d42b6aaece08a811c437a59f4eb896b3), [`c801dc7`](https://github.com/enboxorg/enbox/commit/c801dc7045a109f210a1a6d7306f3e215bca9db7), [`eea8c4a`](https://github.com/enboxorg/enbox/commit/eea8c4a10d41fd034773c2d543d1c400cc6d2926), [`2910f50`](https://github.com/enboxorg/enbox/commit/2910f503f62b6a0d1fda09666defad44475fd97c), [`67947ca`](https://github.com/enboxorg/enbox/commit/67947ca12d3e5e1343f3ade8dd8c6e261ad41ac3), [`d89d29e`](https://github.com/enboxorg/enbox/commit/d89d29ec27de665afe6a12619d3aa3ae73be48d3)]:
  - @enbox/dwn-sdk-js@0.3.8
  - @enbox/api@0.6.33

## 0.2.59

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.32

## 0.2.58

### Patch Changes

- Updated dependencies [[`3dafab2`](https://github.com/enboxorg/enbox/commit/3dafab2cf0c7ba2880c6446143df3e30929dac02)]:
  - @enbox/dwn-sdk-js@0.3.7
  - @enbox/api@0.6.31

## 0.2.57

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.30

## 0.2.56

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.29

## 0.2.55

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.28

## 0.2.54

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.27

## 0.2.53

### Patch Changes

- Updated dependencies [[`0ece8cc`](https://github.com/enboxorg/enbox/commit/0ece8cc4254bedc9fc6762b05ed0b49b43b8ca27)]:
  - @enbox/api@0.6.26

## 0.2.52

### Patch Changes

- Updated dependencies [[`03899ca`](https://github.com/enboxorg/enbox/commit/03899ca7d20ad48b874f7e6253381f19cd7c3480)]:
  - @enbox/api@0.6.25
  - @enbox/dwn-sdk-js@0.3.6

## 0.2.51

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.24

## 0.2.50

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.23

## 0.2.49

### Patch Changes

- Updated dependencies [[`75c7d00`](https://github.com/enboxorg/enbox/commit/75c7d00bb37aac5e1b1286cfebfec2c8772678f0)]:
  - @enbox/dwn-sdk-js@0.3.5
  - @enbox/api@0.6.22

## 0.2.48

### Patch Changes

- Updated dependencies [[`b35f5cb`](https://github.com/enboxorg/enbox/commit/b35f5cb8eb726dd26bcb83b2082d3190a83a36f7)]:
  - @enbox/api@0.6.21

## 0.2.47

### Patch Changes

- Updated dependencies [[`578362d`](https://github.com/enboxorg/enbox/commit/578362d85a18ab1a3ea806d305edfc74196a1f0d)]:
  - @enbox/dwn-sdk-js@0.3.4
  - @enbox/api@0.6.20

## 0.2.46

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.19

## 0.2.45

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.18

## 0.2.44

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.17

## 0.2.43

### Patch Changes

- Updated dependencies [[`2b89675`](https://github.com/enboxorg/enbox/commit/2b896756caf48c627ad7a48ca960dd8730fb8c1e)]:
  - @enbox/dwn-sdk-js@0.3.3
  - @enbox/api@0.6.16

## 0.2.42

### Patch Changes

- Updated dependencies [[`57b1b52`](https://github.com/enboxorg/enbox/commit/57b1b52dcf80f2a4e995d649bb64c9e0b9eac9d8)]:
  - @enbox/api@0.6.15

## 0.2.41

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.14

## 0.2.40

### Patch Changes

- Updated dependencies [[`d3ae193`](https://github.com/enboxorg/enbox/commit/d3ae193f546443e0a3ceb059cd721aaae2844ae3)]:
  - @enbox/api@0.6.13

## 0.2.39

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.12

## 0.2.38

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.11

## 0.2.37

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.10

## 0.2.36

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.9

## 0.2.35

### Patch Changes

- Updated dependencies [[`f268675`](https://github.com/enboxorg/enbox/commit/f268675af32dc383795c94841d163e25f881186e)]:
  - @enbox/dwn-sdk-js@0.3.2
  - @enbox/api@0.6.8

## 0.2.34

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.7

## 0.2.33

### Patch Changes

- Updated dependencies [[`5818860`](https://github.com/enboxorg/enbox/commit/5818860e2bca5201ff368d4748393efb1544d7a2)]:
  - @enbox/dwn-sdk-js@0.3.1
  - @enbox/api@0.6.6

## 0.2.32

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.5

## 0.2.31

### Patch Changes

- Updated dependencies [[`802a7a9`](https://github.com/enboxorg/enbox/commit/802a7a9a1e402d4800d1c2c8176b7e5bdce36b95)]:
  - @enbox/dwn-sdk-js@0.3.0
  - @enbox/api@0.6.4

## 0.2.30

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.3

## 0.2.29

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.2

## 0.2.28

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.6.1

## 0.2.27

### Patch Changes

- Updated dependencies [[`efd0116`](https://github.com/enboxorg/enbox/commit/efd011676082e098d17a26de82f15c3669ff43ae)]:
  - @enbox/api@0.6.0

## 0.2.26

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.5.11

## 0.2.25

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.5.10

## 0.2.24

### Patch Changes

- Updated dependencies [[`0a17914`](https://github.com/enboxorg/enbox/commit/0a17914b84e030ccdfbc44f2d9edd8e4730b46e3)]:
  - @enbox/dwn-sdk-js@0.2.2
  - @enbox/api@0.5.9

## 0.2.23

### Patch Changes

- Updated dependencies [[`8e262f1`](https://github.com/enboxorg/enbox/commit/8e262f18b109a0864adf2b48b155b498c7cac373)]:
  - @enbox/dwn-sdk-js@0.2.1
  - @enbox/api@0.5.8

## 0.2.22

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.5.7

## 0.2.21

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.5.6

## 0.2.20

### Patch Changes

- Updated dependencies [[`12804b1`](https://github.com/enboxorg/enbox/commit/12804b1a0e4d97b811691b9bdc79f3a897eac161)]:
  - @enbox/api@0.5.5

## 0.2.19

### Patch Changes

- Updated dependencies [[`c9c817a`](https://github.com/enboxorg/enbox/commit/c9c817a7c58e0cacb113044949749c60ea9ca3d2)]:
  - @enbox/api@0.5.4

## 0.2.18

### Patch Changes

- Updated dependencies [[`219dbe8`](https://github.com/enboxorg/enbox/commit/219dbe8d0bda309f465e88857deef7aad32469de)]:
  - @enbox/api@0.5.3

## 0.2.17

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.5.2

## 0.2.16

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.5.1

## 0.2.15

### Patch Changes

- Updated dependencies [[`af0145e`](https://github.com/enboxorg/enbox/commit/af0145e5084ad32105584d9e5e6a131b188ca531)]:
  - @enbox/api@0.5.0
  - @enbox/dwn-sdk-js@0.2.0

## 0.2.14

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.4.4

## 0.2.13

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.4.3

## 0.2.12

### Patch Changes

- Updated dependencies [[`34f02a8`](https://github.com/enboxorg/enbox/commit/34f02a8a7883fbdff925c2191dc7486b01909711)]:
  - @enbox/api@0.4.2

## 0.2.11

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.4.1

## 0.2.10

### Patch Changes

- Updated dependencies [[`652f5bd`](https://github.com/enboxorg/enbox/commit/652f5bd8f5ac1017405099dee337821a8b731c4b), [`dc0b65d`](https://github.com/enboxorg/enbox/commit/dc0b65da49fca793b5ec5737aa6a584f3a4edf47), [`5982088`](https://github.com/enboxorg/enbox/commit/5982088c868ec20cce1949afbe042805d412e60d)]:
  - @enbox/api@0.4.0
  - @enbox/dwn-sdk-js@0.1.2

## 0.2.9

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.3.2

## 0.2.8

### Patch Changes

- Updated dependencies [[`4c74a79`](https://github.com/enboxorg/enbox/commit/4c74a794ca9b05fd063371661c0ac45867c6daf2)]:
  - @enbox/dwn-sdk-js@0.1.1
  - @enbox/api@0.3.1

## 0.2.7

### Patch Changes

- Updated dependencies [[`0eb40d4`](https://github.com/enboxorg/enbox/commit/0eb40d4d111732262de01258c0f7f8c727466714)]:
  - @enbox/dwn-sdk-js@0.1.0
  - @enbox/api@0.3.0

## 0.2.6

### Patch Changes

- [`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: provider-auth-v0 tenant registration, immutable records, content-addressed data stores, and admin dashboard

- Updated dependencies [[`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3)]:
  - @enbox/api@0.2.4
  - @enbox/dwn-sdk-js@0.0.8

## 0.2.5

### Patch Changes

- Updated dependencies [[`c36ffb2`](https://github.com/enboxorg/enbox/commit/c36ffb203d8b5eaefffc698f053be6262f1b4ca6)]:
  - @enbox/api@0.2.3

## 0.2.4

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.2.2

## 0.2.3

### Patch Changes

- [#261](https://github.com/enboxorg/enbox/pull/261) [`8a2f650`](https://github.com/enboxorg/enbox/commit/8a2f650c88f4b78f415dcacc23d7f4c82bc9a67b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(protocols): increase avatar size limit to 12 MB and hero banner to 24 MB

- Updated dependencies []:
  - @enbox/api@0.2.1

## 0.2.2

### Patch Changes

- [#254](https://github.com/enboxorg/enbox/pull/254) [`d399df5`](https://github.com/enboxorg/enbox/commit/d399df5490e248703cec59b1b3265d3566689e5c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(protocols): remove empty `$actions` arrays from `ListsDefinition` folder structure

  The DWN JSON schema requires `$actions` arrays to have at least one item (`minItems: 1`).
  Empty `$actions: []` on the `folder` type caused `ProtocolsConfigure` to fail with
  `SchemaValidatorFailure` when installing the Lists protocol.

## 0.2.1

### Patch Changes

- Updated dependencies [[`bb0bfa3`](https://github.com/enboxorg/enbox/commit/bb0bfa31917d296968d3e6f2a41daa9ce5d603b1)]:
  - @enbox/api@0.2.0
  - @enbox/dwn-sdk-js@0.0.7

## 0.2.0

### Minor Changes

- [#200](https://github.com/enboxorg/enbox/pull/200) [`95781ac`](https://github.com/enboxorg/enbox/commit/95781ac7cc656bd617cdc64466ab55f4a098b7cb) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(protocols): add hero image support to Profile and new Connect protocol

  - ProfileProtocol: added `hero` type (binary images nested under `profile/hero`, 2MB size limit, publicly readable) and `tagline` field to `ProfileData`
  - New ConnectProtocol: stores wallet discovery info (`{ webWallets: string[] }`) at `https://identity.foundation/protocols/connect`, publicly readable

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.1.1
  - @enbox/dwn-sdk-js@0.0.6

## 0.1.0

### Minor Changes

- New package: standard reusable DWN protocol definitions (Social Graph, Profile, Preferences, Status, Lists) with TypeScript data types and typed protocol exports

### Patch Changes

- Updated dependencies []:
  - @enbox/api@0.1.0
  - @enbox/dwn-sdk-js@0.0.5
