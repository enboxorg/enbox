---
"@enbox/common": patch
"@enbox/crypto": patch
"@enbox/dids": patch
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-clients": patch
"@enbox/dwn-server": patch
"@enbox/agent": patch
"@enbox/browser": patch
---

refactor: resolve SonarCloud maintainability findings — remove redundant type aliases (`KeyIdentifier`, `AlgorithmIdentifier`, `MulticodecCode`, `LinkId`, `DataStoreListParams`, `JsonRpcParams`, `ConnectRequest`/`ConnectResponse`, `AudienceDeliveryMessage`), extract a nested ternary in the browser connect modal, and convert early-return test skips to `test.skipIf()`
