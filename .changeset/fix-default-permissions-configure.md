---
"@enbox/auth": patch
---

fix(auth): add 'configure' to DEFAULT_PERMISSIONS

Include `ProtocolsConfigure` in the default permission set requested
during `connect()`. Without this, dapps using the standard `TypedEnbox`
API fail with "No permissions found for ProtocolsConfigure" because
`_autoConfigureOnce()` needs a configure grant to install the protocol
on the delegate's local DWN.
