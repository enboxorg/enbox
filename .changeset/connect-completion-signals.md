---
"@enbox/connect": patch
"@enbox/dwn-server": patch
"@enbox/browser": patch
---

feat: bidirectional completion signals for the connect handshake. The relay gains an observational completion marker (`POST /connect/complete` + `GET /connect/complete/{state}`, mirroring the claimed marker): clients signal it automatically after successfully opening the wallet's response (`ConnectTransport.confirmComplete`, wired into `ConnectClient` and the browser relay runner, `keepalive` so it survives immediate navigation), and wallets can poll `pollRelayComplete` to flip their pairing screen to a confirmed "connected" state instead of asking the user to dismiss it blind. The popup channel gets the same signal as a payload-less `enbox-connect-ack` postMessage: dapps send it automatically, and wallets can await it via `WalletPostMessageTransport.sendResponseAwaitingAck` to show confirmed success before closing themselves. All signals are best-effort and backward compatible — older relays, wallets, and dapps simply never see them.
