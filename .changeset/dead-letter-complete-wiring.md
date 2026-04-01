---
"@enbox/agent": patch
---

fix: complete dead letter wiring for all sync failure paths

Records permanently failed messages in the dead letter store at every
failure point, not just push-permanent (400/401/403):

- push retry exhaustion: all CIDs in the batch recorded as `push-exhausted`
- pull processing failures: CIDs that fail after 3 retry passes recorded
  as `pull-processing` (pullMessages now returns failed CIDs)
- closure validation failures: the triggering message CID recorded as
  `closure` with the ClosureFailureCode and detail
- live pull processRawMessage exceptions: the failing CID recorded as
  `pull-processing` with the error message
