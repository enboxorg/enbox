---
"@enbox/agent": patch
"@enbox/dwn-clients": patch
---

fix(agent): prefer locally-stored BearerDid for signing, avoiding unnecessary DID resolution round-trips that can fail on malformed cached data

fix(dwn-clients): handle ReadableStream fetch bodies correctly per runtime — buffer to Blob in Bun (workaround for stream upload bugs), set `duplex: 'half'` in browsers and Node as required by the Fetch spec
