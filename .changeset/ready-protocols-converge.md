---
"@enbox/agent": minor
"@enbox/api": minor
"@enbox/browser": minor
"@enbox/cli": minor
---

Add application protocol readiness with an explicit publication policy. Owner
sessions install locally and converge the exact signed protocol artifact across
reachable remote DWN endpoints; delegated sessions verify and import the exact
wallet-owned artifact without publishing it. Readiness failures now expose
typed stage, target, recovery, and DWN status details. Exact convergence reuses
the current authoritative local artifact and verifies that it is still current
before reporting success.

Queried protocol handles now resend their exact raw signed configuration when
no local message CID is available, and typed configuration repairs encrypted
installs whose definition matches but whose `$keyAgreement` coverage is
incomplete.
