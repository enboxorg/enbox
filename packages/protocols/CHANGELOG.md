# @enbox/protocols

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
