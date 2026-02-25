---
"@enbox/dwn-server": patch
---

Allow passing RegistrationManager and OpenAuthHandler via DwnServerOptions when using a pre-built DWN instance. This enables registration endpoints and open-auth flow for consumers like dwn-relay that construct their own DWN with custom store wrappers. Also exports RegistrationManager and OpenAuthHandler from the package index.
