import { Effect, FileSystem, Layer, Option, Path, Schema, ServiceMap } from "effect"
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
  skills: Schema.Record(Schema.String, LockEntry),
}) {}

const decodeLockFileJson = Schema.decodeUnknownEffect(Schema.fromJsonString(LockFile))
const encodeLockFileJson = Schema.encodeUnknownEffect(Schema.fromJsonString(LockFile))

export class SkillLock extends ServiceMap.Service<
  SkillLock,
  {
    readonly read: Effect.Effect<LockFile, LockFileError>
    readonly get: (name: string) => Effect.Effect<Option.Option<LockEntry>>
    readonly add: (
      name: string,
      source: string,
      skillPath: string,
    ) => Effect.Effect<void, LockFileError>
    readonly addMany: (
      entries: ReadonlyArray<{ name: string; source: string; skillPath: string }>,
    ) => Effect.Effect<void, LockFileError>
    readonly remove: (name: string) => Effect.Effect<void, LockFileError>
    readonly update: (name: string) => Effect.Effect<void, LockFileError>
    readonly updateMany: (names: ReadonlyArray<string>) => Effect.Effect<void, LockFileError>
  }
>()("@skills/SkillLock") {}

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
      return yield* decodeLockFileJson(raw)
    }).pipe(
      Effect.mapError((cause) => new LockFileError({ cause })),
      Effect.withSpan("SkillLock.read"),
    )

    const writeLock = (lock: LockFile): Effect.Effect<void, LockFileError> =>
      Effect.gen(function* () {
        const encoded = yield* encodeLockFileJson(lock)
        yield* fs.makeDirectory(pathService.dirname(lockPath), { recursive: true })
        yield* fs.writeFileString(lockPath, encoded + "\n")
      }).pipe(
        Effect.mapError((cause) => new LockFileError({ cause })),
        Effect.withSpan("SkillLock.write"),
      )

    const get = (name: string) =>
      readLock.pipe(
        Effect.catch(() => Effect.succeed(new LockFile({ version: 1, skills: {} }))),
        Effect.map((lock) => Option.fromNullishOr(lock.skills[name])),
        Effect.withSpan("SkillLock.get", { attributes: { name } }),
      )

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

    const addMany = (entries: ReadonlyArray<{ name: string; source: string; skillPath: string }>) =>
      Effect.gen(function* () {
        if (entries.length === 0) return
        const lock = yield* readLock
        const now = new Date().toISOString()
        const newSkills = { ...lock.skills }
        for (const { name, source, skillPath } of entries) {
          newSkills[name] = new LockEntry({
            source,
            skillPath,
            installedAt: now,
            updatedAt: now,
          })
        }
        yield* writeLock(new LockFile({ version: 1, skills: newSkills }))
      }).pipe(Effect.withSpan("SkillLock.addMany"))

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

    const updateMany = (names: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (names.length === 0) return
        const lock = yield* readLock
        const now = new Date().toISOString()
        const newSkills = { ...lock.skills }
        for (const name of names) {
          const entry = newSkills[name]
          if (entry) {
            newSkills[name] = new LockEntry({ ...entry, updatedAt: now })
          }
        }
        yield* writeLock(new LockFile({ version: 1, skills: newSkills }))
      }).pipe(Effect.withSpan("SkillLock.updateMany"))

    return { read: readLock, get, add, addMany, remove, update, updateMany }
  }),
)
