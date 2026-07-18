---
"@enbox/dwn-sdk-js": patch
"@enbox/agent": patch
---

feat: structured machine-readable error fields on DWN message replies — reply `status` now carries optional `errorCode` (the `DwnErrorCode` of the originating `DwnError`) and `info` (structured error data, e.g. the squash backstop floor timestamp) so consumers no longer parse `detail` prose
