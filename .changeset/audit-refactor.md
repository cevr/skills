---
"@cvr/skills": minor
---

Comprehensive audit: delete dead code, deduplicate walkers, fix bugs, proper error handling, parallel performance, Option migration

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
