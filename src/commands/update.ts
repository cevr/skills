import { Console, Effect } from "effect"
import { SkillStore } from "../services/SkillStore.js"
import { fetchSkillDir } from "../services/GitHub.js"
import { SkillLock, type LockEntry } from "../services/SkillLock.js"
import { parseSource } from "../lib/source.js"

const skillDirFromPath = (skillPath: string) =>
  skillPath === "SKILL.md" ? "" : skillPath.split("/").slice(0, -1).join("/")

const resolveRepoSource = (source: string) => {
  const parsed = parseSource(source)

  switch (parsed._tag) {
    case "GitHubRepo":
      return {
        owner: parsed.owner,
        repo: parsed.repo,
        ref: parsed.ref,
      }
    case "GitHubRepoWithSkill":
      return {
        owner: parsed.owner,
        repo: parsed.repo,
        ref: undefined,
      }
    case "SearchQuery":
      return null
  }
}

const updateSkill = Effect.fn("command.update.updateSkill")(function* (
  name: string,
  entry: LockEntry,
) {
  const store = yield* SkillStore
  const lock = yield* SkillLock

  const source = resolveRepoSource(entry.source)
  if (!source) {
    yield* Console.error(`  Skipping ${name}: invalid source "${entry.source}"`)
    return false
  }

  const files = yield* fetchSkillDir(
    source.owner,
    source.repo,
    skillDirFromPath(entry.skillPath),
    source.ref ?? "main",
  ).pipe(
    Effect.catchTag("FetchError", (error) =>
      Console.error(`  Failed to update ${name}: ${error.message}`).pipe(
        Effect.andThen(Effect.succeed(null)),
      ),
    ),
  )

  if (files === null) return false

  yield* store.syncDir(name, files)
  yield* lock.update(name).pipe(Effect.catchAll(() => Effect.void))

  return true
})

export const runUpdate = Effect.fn("command.update")(function* () {
  const lock = yield* SkillLock
  const lockFile = yield* lock.read

  const entries = Object.entries(lockFile.skills)
  if (entries.length === 0) {
    yield* Console.log("No skills to update. Lock file is empty.")
    return
  }

  yield* Console.log(`Updating ${entries.length} skill(s)...\n`)

  let updated = 0
  for (const [name, entry] of entries) {
    const success = yield* updateSkill(name, entry)
    if (!success) continue

    yield* Console.log(`  Updated: ${name}`)
    updated++
  }

  yield* Console.log(`\n${updated}/${entries.length} skill(s) updated.`)
})
