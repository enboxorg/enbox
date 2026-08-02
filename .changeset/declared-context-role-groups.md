---
'@enbox/api': patch
'@enbox/browser': patch
---

Declare context role precedence once on a typed protocol, then manage members and follow shared contexts without passing role-path arrays at each call site. Named groups remain available for protocols with more than one membership policy, while the selected exact role order continues through the existing followed-context lifecycle.
