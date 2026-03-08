import { Console, Effect } from "effect"
import { FileSystem, Path } from "@effect/platform"
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
    case "LocalPath":
    case "SearchQuery":
      return null
  }
}

const readLocalDir = Effect.fn("command.update.readLocalDir")(function* (dirPath: string) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path

  const files: Array<{ path: string; content: string }> = []

  const walk = (currentDir: string, prefix: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectory(currentDir).pipe(Effect.orDie)
      for (const entry of entries) {
        if (entry.startsWith(".")) continue
        const fullPath = pathService.join(currentDir, entry)
        const stat = yield* fs.stat(fullPath).pipe(Effect.orDie)
        if (stat.type === "Directory") {
          yield* walk(fullPath, prefix ? `${prefix}/${entry}` : entry)
        } else {
          const content = yield* fs.readFileString(fullPath).pipe(Effect.orDie)
          files.push({ path: prefix ? `${prefix}/${entry}` : entry, content })
        }
      }
    })

  yield* walk(dirPath, "")
  return files
})

const updateLocalSkill = Effect.fn("command.update.updateLocalSkill")(function* (
  name: string,
  localPath: string,
) {
  const store = yield* SkillStore
  const lock = yield* SkillLock
  const fs = yield* FileSystem.FileSystem

  const exists = yield* fs.exists(localPath).pipe(Effect.orDie)
  if (!exists) {
    yield* Console.error(`  Skipping ${name}: local path no longer exists "${localPath}"`)
    return false
  }

  const files = yield* readLocalDir(localPath)
  yield* store.syncDir(name, files)
  yield* lock.update(name).pipe(Effect.catchAll(() => Effect.void))

  return true
})

const updateSkill = Effect.fn("command.update.updateSkill")(function* (
  name: string,
  entry: LockEntry,
) {
  const store = yield* SkillStore
  const lock = yield* SkillLock

  if (entry.source.startsWith("local:")) {
    const localPath = entry.source.slice("local:".length)
    return yield* updateLocalSkill(name, localPath)
  }

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
