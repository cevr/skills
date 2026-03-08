import { Console, Effect } from "effect"
import { SkillStore } from "../services/SkillStore.js"
import { SkillLock } from "../services/SkillLock.js"

// B7: Clean lock even when dir is already gone
export const runRemove = Effect.fn("command.remove")(function* (name: string) {
  const store = yield* SkillStore
  const lock = yield* SkillLock

  yield* store
    .remove(name)
    .pipe(
      Effect.catchTag("SkillNotFoundError", () =>
        Console.error(`  Directory already removed, cleaning lock entry`),
      ),
    )
  yield* lock.remove(name)
  yield* Console.log(`Removed: ${name}`)
})
