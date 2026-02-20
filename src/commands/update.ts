import { Console, Effect } from "effect"
import { HttpClient } from "@effect/platform"
import { SkillStore } from "../services/SkillStore.js"
import { SkillLock, type LockEntry } from "../services/SkillLock.js"
import { fetchRaw } from "../lib/github.js"
import { parseFrontmatter } from "../lib/frontmatter.js"
import { toKebab } from "../lib/util.js"
import type { LockFileError } from "../lib/errors.js"

const updateSkill = (
  name: string,
  entry: LockEntry,
): Effect.Effect<boolean, never, SkillStore | SkillLock | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const store = yield* SkillStore
    const lock = yield* SkillLock

    const parts = entry.source.replace(/#.*$/, "").split("/")
    if (parts.length < 2) {
      yield* Console.error(`  Skipping ${name}: invalid source "${entry.source}"`)
      return false
    }
    const [owner, repo] = parts as [string, string]
    const ref = entry.source.includes("#") ? entry.source.split("#")[1] : undefined

    const content = yield* fetchRaw(owner, repo, entry.skillPath, ref ?? "main").pipe(
      Effect.catchTag("FetchError", (e) =>
        Console.error(`  Failed to update ${name}: ${e.message}`).pipe(
          Effect.andThen(Effect.succeed(null)),
        ),
      ),
    )

    if (content === null) return false

    const frontmatter = yield* parseFrontmatter(content).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    )
    const skillName = frontmatter ? toKebab(frontmatter.name) : name

    yield* store.install(skillName, content)
    yield* lock.update(name).pipe(Effect.catchAll(() => Effect.void))

    return true
  })

export const runUpdate = (): Effect.Effect<
  void,
  LockFileError,
  SkillStore | SkillLock | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
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
      if (success) {
        yield* Console.log(`  Updated: ${name}`)
        updated++
      }
    }

    yield* Console.log(`\n${updated}/${entries.length} skill(s) updated.`)
  }).pipe(Effect.withSpan("command.update"))
