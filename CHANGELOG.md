# @cvr/skills

## 0.2.0

### Minor Changes

- [`f01e737`](https://github.com/cevr/skills/commit/f01e737733c0acc3c507404b473ac4299904f623) Thanks [@cevr](https://github.com/cevr)! - Comprehensive audit: delete dead code, deduplicate walkers, fix bugs, proper error handling, parallel performance, Option migration
  - Delete dead `SourceParseError` and `SkillStore.install`
  - Extract shared `walkDir` to `src/lib/fs.ts` (3 copies → 1)
  - Extract `SKILL_DIR_PREFIXES` and `DEFAULT_REF` to `src/lib/constants.ts`
  - Fix `addFromRepoWithSkill` installing wrong skill when root SKILL.md name doesn't match filter
  - Fix `GitHubHttp.listContents` not URL-encoding path
  - Fix `discoverSkills` swallowing auth/rate-limit errors (now only catches FetchError)
  - Let lock write failures propagate instead of silently swallowing
  - Add `NoSkillsFoundError` — soft errors now exit with code 2 instead of 0
  - Error-specific exit codes: 2=input, 3=config, 4=network
  - Replace `process.exit(1)` with `process.exitCode` to not bypass Effect finalizers
  - Move progress messages to stderr, keep stdout for actionable output
  - Support `NO_COLOR` env var
  - Add help examples to `add` command
  - Include cause in `FetchError.message`
  - Parallel `discoverSkills` subdirectory checks
  - Parallel file fetching in `fetchSkillDir` (concurrency: 5)
  - Parallel skill installs in `addFromRepo` (concurrency: 5)
  - Parallel `SkillStore.list` stat/read
  - Lazy GitHub transport resolution (no `gh auth status` on non-GitHub commands)
  - Add `SkillLock.addMany`/`updateMany` for batched writes
  - `SkillLock.get` returns `Option<LockEntry>` instead of `null`
  - Add `tryParseFrontmatter` returning `Effect<Option<SkillFrontmatter>>`
  - `installLocalSkillDir` returns `Option<string>` instead of `null`
  - `addFromSearch` prefers exact name match when multiple results

- [`2374b0d`](https://github.com/cevr/skills/commit/2374b0d36a7bd453c6aec0dcfa2d0cd4c8a5447e) Thanks [@cevr](https://github.com/cevr)! - Migrate from Effect v3 to Effect v4 (4.0.0-beta.29)
  - Replace `@effect/cli` with `effect/unstable/cli` (Args→Argument, Options→Flag)
  - Replace `@effect/platform` imports: FileSystem/Path from `effect`, HTTP from `effect/unstable/http`
  - Migrate services from `Context.Tag` to `ServiceMap.Service`
  - Update Schema APIs: `decodeUnknown`→`decodeUnknownEffect`, `parseJson`→`fromJsonString`, `Record({key,value})`→`Record(K,V)`
  - Rename `Effect.catchAll`→`Effect.catch`, `Option.fromNullable`→`Option.fromNullishOr`
  - CLI args now read from Stdio service instead of `process.argv`
  - Update tests to use `effect-bun-test` (v4-compatible), `NodeServices`, `ConfigProvider.fromUnknown`

- [`c9e84ba`](https://github.com/cevr/skills/commit/c9e84ba64b0a4a1984c5287fbb7b502db35b0853) Thanks [@cevr](https://github.com/cevr)! - Add local filesystem skill installation. `skills add` with no args discovers and installs skills from cwd. Supports absolute paths, relative paths (`./`, `../`), and `~`. Lock file tracks `local:<path>` sources for `skills update` re-sync.

### Patch Changes

- [`6395e73`](https://github.com/cevr/skills/commit/6395e73b9941c2b3832f5eed0ac20e2bbf70972d) Thanks [@cevr](https://github.com/cevr)! - Comprehensive audit: fix bugs, align to Effect v4, improve performance, clean up code smells

  **Bugs fixed:**
  - Lock file race condition — concurrent `lock.add` calls during multi-skill install now batched via `addMany`
  - `SkillLock.get` no longer swallows `LockFileError` on corrupt JSON
  - `repoRe` ref group no longer includes `/` — `owner/repo#ref/subpath` parses correctly
  - `installedAt` preserved on re-add instead of being clobbered
  - `addFromSearch` uses safe `parseSource()` instead of unsafe `split("/") as [string, string]`
  - `discoverSkills` no longer mutates shared array with unbounded concurrency
  - `remove` cleans lock entry even when skill directory is already gone

  **Effect v4 alignment:**
  - All 5 error classes migrated from `Data.TaggedError` to `Schema.TaggedErrorClass`
  - Standalone effectful functions (`discoverSkills`, `fetchSkillDir`, `listContents`, `fetchRaw`) moved into `GitHub` service
  - Remaining functions wrapped in `Effect.fn`
  - Unnecessary `Effect.gen` wrappers flattened

  **Performance:**
  - Update loop parallelized (`concurrency: 5`) with batched `lock.updateMany`
  - Tree API (`listTree`) for skill discovery — single API call instead of N+1
  - Parallel `fetchSkillDir` + `store.readDir` in update

  **Code quality:**
  - `ref` stored in lock entry — `resolveRepoSource` reads ref from lock for `GitHubRepoWithSkill`
  - Typed `Effect.catchTags` in CLI instead of untyped `Effect.catch`
  - Per-stream TTY checks (`stdoutColor`/`stderrColor`)

- [`570fb12`](https://github.com/cevr/skills/commit/570fb129217d5df1856feeab672187559cfeff24) Thanks [@cevr](https://github.com/cevr)! - Fix skill updates to fully sync remote directories, respect explicit `GITHUB_TOKEN` auth over `gh`, and encapsulate GitHub transports behind Effect services.
