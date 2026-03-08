---
"@cvr/skills": minor
---

Migrate from Effect v3 to Effect v4 (4.0.0-beta.29)

- Replace `@effect/cli` with `effect/unstable/cli` (Args→Argument, Options→Flag)
- Replace `@effect/platform` imports: FileSystem/Path from `effect`, HTTP from `effect/unstable/http`
- Migrate services from `Context.Tag` to `ServiceMap.Service`
- Update Schema APIs: `decodeUnknown`→`decodeUnknownEffect`, `parseJson`→`fromJsonString`, `Record({key,value})`→`Record(K,V)`
- Rename `Effect.catchAll`→`Effect.catch`, `Option.fromNullable`→`Option.fromNullishOr`
- CLI args now read from Stdio service instead of `process.argv`
- Update tests to use `effect-bun-test` (v4-compatible), `NodeServices`, `ConfigProvider.fromUnknown`
