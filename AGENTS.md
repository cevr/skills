# Skills CLI

CLI to install, update, and manage AI agent skills. Effect-TS + Bun.

## Architecture

Sources → `parseSource` → tagged union → command dispatches by `_tag`.

| Source Type   | `_tag`                | Example                                             |
| ------------- | --------------------- | --------------------------------------------------- |
| GitHub repo   | `GitHubRepo`          | `owner/repo`, `owner/repo#ref/subpath`, GitHub URLs |
| Repo + filter | `GitHubRepoWithSkill` | `owner/repo@skill-name`                             |
| Local path    | `LocalPath`           | `.`, `./skills`, `/abs/path`, `~/path`              |
| Search        | `SearchQuery`         | anything else                                       |

## Key Patterns

- Skill = directory with `SKILL.md` (frontmatter: `name`, `description`)
- `installDir`/`syncDir` take `{ path, content }[]` — abstraction over GitHub API vs filesystem
- Lock file (`.skill-lock.json`) tracks `source` + `skillPath` for updates
- Local sources stored as `local:<absolute-path>` in lock; update re-reads from disk
- Discovery order: `skills/` → `skill/` → root `SKILL.md` → direct children
- Shared constants in `src/lib/constants.ts`: `SKILL_DIR_PREFIXES`, `DEFAULT_REF`
- Shared `walkDir` in `src/lib/fs.ts` — single recursive dir walker for all callers

## Services (Effect v4 ServiceMap.Service)

| Service      | Purpose                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `SkillStore` | CRUD for installed skill dirs. Dir from `$SKILLS_DIR` or `~/Developer/personal/dotfiles/skills`          |
| `SkillLock`  | Lock file read/write. Lives at `<skills-dir>/.skill-lock.json`. Has `addMany`/`updateMany` for batching. |
| `GitHub`     | GitHub Contents API. Lazy transport — `gh` CLI or HTTPS resolved on first API call, not at startup.      |

## Error Handling

| Error Tag            | Exit Code | When                                                      |
| -------------------- | --------- | --------------------------------------------------------- |
| `SkillNotFoundError` | 2         | Skill name doesn't match any installed/discoverable skill |
| `NoSkillsFoundError` | 2         | No skills found in repo/path/search                       |
| `LockFileError`      | 3         | Lock file read/write failure                              |
| `FetchError`         | 4         | GitHub API / network failure                              |
| `SearchError`        | 4         | skills.sh search failure                                  |

## Stream Discipline

- `Console.error` for progress/status messages (discovering, checking, etc.)
- `Console.log` only for actionable output (installed, updated, search results)
- `NO_COLOR` env var respected for ANSI codes

## Gotchas

- `fetchSkillDir` strips directory prefix from paths — files are relative to skill root
- `toKebab(frontmatter.name)` determines install dir name, not the directory name on disk
- `syncDir` deletes then re-creates — not a merge
- `Argument.optional` from `effect/unstable/cli` wraps in `Option` — unwrap with `Option.getOrUndefined`
- `tryParseFrontmatter` returns `Effect<Option<SkillFrontmatter>>` — use this over `parseFrontmatter` + `catch`
- `SkillLock.get` returns `Option<LockEntry>`, not `null`
- `SkillStore.readDir` calls shared `walkDir` but provides platform services internally — no leaked requirements
- GitHub transport resolves lazily via `Effect.cached` — `skills list` never spawns `gh auth status`
- Lock write errors propagate — never swallow with `Effect.catch`
- `effect-bun-test/v3` is broken with Effect v4 — use `effect-bun-test` (main export)
- `effect-bun-test` ships raw `.ts` — its `/v3` export causes tsc errors in node_modules; typecheck script filters these
