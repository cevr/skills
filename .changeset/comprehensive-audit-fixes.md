---
"@cvr/skills": patch
---

Comprehensive audit: fix bugs, align to Effect v4, improve performance, clean up code smells

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
