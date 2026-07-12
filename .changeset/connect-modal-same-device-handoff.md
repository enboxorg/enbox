---
"@enbox/browser": patch
---

feat(browser): smoother same-device connect handoff. The connect modal's QR is now itself a handoff link and stays on screen on phones next to the Continue button; both open the wallet in a new tab (instead of navigating away) so the session — and the pairing-code entry — is waiting when the user switches back. Relay polling now resumes the instant the tab returns to the foreground, missed re-mints fire on return, and a wallet popup that posts its response and immediately closes itself no longer races into a false denial, and the wallet popup now opens centred over the calling window instead of wherever the browser parks it.
