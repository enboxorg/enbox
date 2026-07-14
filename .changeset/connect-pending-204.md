---
"@enbox/dwn-server": patch
"@enbox/connect": patch
---

fix(connect): answer the token poll with 204 (not 404) while the wallet response is pending

The relay's `GET /connect/token/{state}.jwt` route now returns `204 No Content`
(empty body) while the wallet has not yet posted its sealed response, instead of
`404 Not Found`. The requesting app long-polls this route, so "not ready yet" is
the steady state of that loop — not an error — and the 404 was surfaced by
browsers as console noise on every poll. This matches the always-2xx contract the
sibling `/connect/status` and `/connect/complete` observation routes already use;
an unknown or already-consumed state reads the same clean 204.

`@enbox/connect`'s relay transport now treats an empty 2xx (204) as "keep
polling" and resolves the handshake only on a non-empty body, so it works against
both current relays (204) and older relays that still answer 404.

Rollout: ship the `@enbox/connect` change to apps **before** the relay flips to
204. A client that predates this change treats any 2xx as a completed response
and would misread the empty 204 body as an empty token.
