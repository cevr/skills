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

## Services (Effect Context.Tag)

| Service      | Purpose                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `SkillStore` | CRUD for installed skill dirs. Dir from `$SKILLS_DIR` or `~/Developer/personal/dotfiles/skills` |
| `SkillLock`  | Lock file read/write. Lives at `<skills-dir>/.skill-lock.json`                                  |
| `GitHub`     | GitHub Contents API. Prefers `gh` CLI, falls back to HTTPS with `GITHUB_TOKEN`                  |

## Gotchas

- `fetchSkillDir` strips directory prefix from paths — files are relative to skill root
- `toKebab(frontmatter.name)` determines install dir name, not the directory name on disk
- `syncDir` deletes then re-creates — not a merge
- `Args.optional` from `@effect/cli` wraps in `Option` — unwrap with `Option.getOrUndefined`
