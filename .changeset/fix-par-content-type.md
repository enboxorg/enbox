---
"@enbox/agent": patch
---

Fix WalletConnect PAR request to send JSON instead of form-urlencoded

The dwn-server's /connect/par endpoint parses the request body with
req.json(), so sending application/x-www-form-urlencoded would fail
with a JSON parse error.
