---
"@cvr/skills": minor
---

Add local filesystem skill installation. `skills add` with no args discovers and installs skills from cwd. Supports absolute paths, relative paths (`./`, `../`), and `~`. Lock file tracks `local:<path>` sources for `skills update` re-sync.
