import { Context, Effect, Layer, Schema } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { LockFileError } from "../lib/errors.js"
import { SkillStore } from "./SkillStore.js"

export class LockEntry extends Schema.Class<LockEntry>("LockEntry")({
  source: Schema.String,
  skillPath: Schema.String,
  installedAt: Schema.String,
  updatedAt: Schema.String,
}) {}

export class LockFile extends Schema.Class<LockFile>("LockFile")({
  version: Schema.Literal(1),
  skills: Schema.Record({ key: Schema.String, value: LockEntry }),
}) {}

const decodeLockFile = Schema.decodeUnknown(LockFile)
const encodeLockFile = Schema.encodeUnknown(LockFile)

export class SkillLock extends Context.Tag("@skills/SkillLock")<
  SkillLock,
  {
    readonly read: Effect.Effect<LockFile, LockFileError>
    readonly get: (name: string) => Effect.Effect<LockEntry | null>
    readonly add: (
      name: string,
      source: string,
      skillPath: string,
    ) => Effect.Effect<void, LockFileError>
    readonly remove: (name: string) => Effect.Effect<void, LockFileError>
    readonly update: (name: string) => Effect.Effect<void, LockFileError>
  }
>() {}

export const SkillLockLive = Layer.effect(
  SkillLock,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const store = yield* SkillStore

    const lockPath = pathService.join(store.dir, ".skill-lock.json")

    const readLock: Effect.Effect<LockFile, LockFileError> = Effect.gen(function* () {
      const exists = yield* fs.exists(lockPath)
      if (!exists) {
        return new LockFile({ version: 1, skills: {} })
      }
      const raw = yield* fs.readFileString(lockPath)
      const json = JSON.parse(raw) as unknown
      return yield* decodeLockFile(json)
    }).pipe(
      Effect.mapError((cause) => new LockFileError({ cause })),
      Effect.withSpan("SkillLock.read"),
    )

    const writeLock = (lock: LockFile): Effect.Effect<void, LockFileError> =>
      Effect.gen(function* () {
        const encoded = yield* encodeLockFile(lock)
        yield* fs.makeDirectory(pathService.dirname(lockPath), { recursive: true })
        yield* fs.writeFileString(lockPath, JSON.stringify(encoded, null, 2) + "\n")
      }).pipe(
        Effect.mapError((cause) => new LockFileError({ cause })),
        Effect.withSpan("SkillLock.write"),
      )

    const get = (name: string) =>
      Effect.gen(function* () {
        const lock = yield* readLock.pipe(
          Effect.catchAll(() => Effect.succeed(new LockFile({ version: 1, skills: {} }))),
        )
        return lock.skills[name] ?? null
      }).pipe(Effect.withSpan("SkillLock.get", { attributes: { name } }))

    const add = (name: string, source: string, skillPath: string) =>
      Effect.gen(function* () {
        const lock = yield* readLock
        const now = new Date().toISOString()
        const entry = new LockEntry({
          source,
          skillPath,
          installedAt: now,
          updatedAt: now,
        })
        const updated = new LockFile({
          version: 1,
          skills: { ...lock.skills, [name]: entry },
        })
        yield* writeLock(updated)
      }).pipe(Effect.withSpan("SkillLock.add", { attributes: { name, source } }))

    const remove = (name: string) =>
      Effect.gen(function* () {
        const lock = yield* readLock
        const { [name]: _, ...rest } = lock.skills
        yield* writeLock(new LockFile({ version: 1, skills: rest }))
      }).pipe(Effect.withSpan("SkillLock.remove", { attributes: { name } }))

    const update = (name: string) =>
      Effect.gen(function* () {
        const lock = yield* readLock
        const entry = lock.skills[name]
        if (!entry) return
        const updated = new LockFile({
          version: 1,
          skills: {
            ...lock.skills,
            [name]: new LockEntry({ ...entry, updatedAt: new Date().toISOString() }),
          },
        })
        yield* writeLock(updated)
      }).pipe(Effect.withSpan("SkillLock.update", { attributes: { name } }))

    return { read: readLock, get, add, remove, update }
  }),
)
