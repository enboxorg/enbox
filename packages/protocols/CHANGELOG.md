# @enbox/protocols

## 0.2.0

### Minor Changes

- [#200](https://github.com/enboxorg/enbox/pull/200) [`95781ac`](https://github.com/enboxorg/enbox/commit/95781ac7cc656bd617cdc64466ab55f4a098b7cb) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(protocols): add hero image support to Profile and new Connect protocol

  - ProfileProtocol: added `hero` type (binary images nested under `profile/hero`, 2MB size limit, publicly readable) and `tagline` field to `ProfileData`
  - New ConnectProtocol: stores wallet discovery info (`{ webWallets: string[] }`) at `https://enbox.org/protocols/connect`, publicly readable

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
