import { Console, Effect } from "effect"
import { FileSystem } from "@effect/platform"
import { SkillStore } from "../services/SkillStore.js"
import { fetchSkillDir } from "../services/GitHub.js"
import { SkillLock, type LockEntry } from "../services/SkillLock.js"
import { parseSource } from "../lib/source.js"
import { walkDir } from "../lib/fs.js"
import { DEFAULT_REF } from "../lib/constants.js"

type FileEntry = { readonly path: string; readonly content: string }

const filesEqual = (a: ReadonlyArray<FileEntry>, b: ReadonlyArray<FileEntry>): boolean => {
  if (a.length !== b.length) return false
  const mapA = new Map(a.map((f) => [f.path, f.content]))
  for (const file of b) {
    if (mapA.get(file.path) !== file.content) return false
  }
  return true
}

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
    return "error" as const
  }

  const [incoming, installed] = yield* Effect.all([walkDir(localPath), store.readDir(name)])

  if (filesEqual(incoming, installed)) return "unchanged" as const

  yield* store.syncDir(name, incoming)
  yield* lock.update(name)

  return "updated" as const
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
    return "error"
  }

  const incoming = yield* fetchSkillDir(
    source.owner,
    source.repo,
    skillDirFromPath(entry.skillPath),
    source.ref ?? DEFAULT_REF,
  ).pipe(
    Effect.catchTag("FetchError", (error) =>
      Console.error(`  Failed to update ${name}: ${error.message}`).pipe(
        Effect.andThen(Effect.succeed(null)),
      ),
    ),
  )

  if (incoming === null) return "error"

  const installed = yield* store.readDir(name)

  if (filesEqual(incoming, installed)) return "unchanged"

  yield* store.syncDir(name, incoming)
  yield* lock.update(name)

  return "updated"
})

export const runUpdate = Effect.fn("command.update")(function* () {
  const lock = yield* SkillLock
  const lockFile = yield* lock.read

  const entries = Object.entries(lockFile.skills)
  if (entries.length === 0) {
    yield* Console.log("No skills to update. Lock file is empty.")
    return
  }

  yield* Console.error(`Checking ${entries.length} skill(s)...\n`)

  let updated = 0
  let unchanged = 0
  for (const [name, entry] of entries) {
    const result = yield* updateSkill(name, entry)
    switch (result) {
      case "updated":
        yield* Console.log(`  Updated: ${name}`)
        updated++
        break
      case "unchanged":
        unchanged++
        break
      case "error":
        break
    }
  }

  if (updated === 0) {
    yield* Console.log("All skills up to date.")
  } else {
    yield* Console.log(`\n${updated} updated, ${unchanged} unchanged.`)
  }
})
