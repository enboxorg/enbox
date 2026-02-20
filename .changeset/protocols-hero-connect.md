---
"@enbox/protocols": minor
---

feat(protocols): add hero image support to Profile and new Connect protocol

- ProfileProtocol: added `hero` type (binary images nested under `profile/hero`, 2MB size limit, publicly readable) and `tagline` field to `ProfileData`
- New ConnectProtocol: stores wallet discovery info (`{ webWallets: string[] }`) at `https://enbox.org/protocols/connect`, publicly readable
