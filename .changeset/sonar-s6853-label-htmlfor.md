---
"@enbox/dwn-server-admin-ui": patch
---

fix(admin-ui): use `htmlFor` so label/control association is detected

The audit-log and passkey filter labels associated their inputs via `for`/`id`.
That is valid HTML a11y, but the `jsx-a11y` rule behind SonarCloud S6853 only
recognizes the `htmlFor` prop, so it kept flagging the labels as unassociated.
Preact 10 renders `htmlFor` to the same `for` attribute, so the output HTML is
unchanged — this just makes the association visible to the analyzer.
