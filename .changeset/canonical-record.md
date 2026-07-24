---
"@enbox/api": patch
"@enbox/browser": patch
---

Use `Record<T>` as the single mutable record handle returned by both the
protocol-scoped and low-level APIs. Protocol-scoped create, query, read,
observe, update, and delete operations now preserve their payload type directly
on that canonical record instead of allocating a forwarding wrapper;
`@enbox/browser` re-exports `Record` accordingly. The redundant `rawRecord`
escape hatch is removed because the returned object is already the underlying
record.

The `TypedRecord`, `TypedRecordData`, `TypedRecordUpdateParams`,
`TypedRecordPatch`, `TypedRecordUpdateResult`, and `TypedRecordDeleteResult`
exports are removed. Use `Record<T>`, `RecordData<T>`,
`RecordUpdateParams<T>`, `RecordPatch<T>`, `RecordUpdateResult<T>`, and
`RecordDeleteResult<T>` respectively. Payload typing now belongs to the record,
so consume typed JSON with `record.data.json()` rather than supplying a type
argument to `json()`. The internal `createRecordData` factory is no longer
exported from the package root; application code should consume `RecordData<T>`
through a `Record` or `ReadOnlyRecord`. `ReadOnlyRecord.data.json()` now returns
`unknown`; anonymous callers should validate the parsed value before use.

`Record.update({ data })` continues to replace the complete payload and now
requires the full `T` on a typed record. Use `Record.patch()` for shallow
partial JSON-object updates.
