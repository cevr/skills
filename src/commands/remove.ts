import { Console, Effect } from "effect"
import { SkillStore } from "../services/SkillStore.js"
import { SkillLock } from "../services/SkillLock.js"
import type { LockFileError, SkillNotFoundError } from "../lib/errors.js"

export const runRemove = (
  name: string,
): Effect.Effect<void, SkillNotFoundError | LockFileError, SkillStore | SkillLock> =>
  Effect.gen(function* () {
    const store = yield* SkillStore
    const lock = yield* SkillLock

    yield* store.remove(name)
    yield* lock.remove(name)
    yield* Console.log(`Removed: ${name}`)
  }).pipe(Effect.withSpan("command.remove", { attributes: { name } }))
