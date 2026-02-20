import { describe, expect, it } from "effect-bun-test/v3"
import { ConfigProvider, Effect, Layer } from "effect"
import { NodeContext } from "@effect/platform-node"
import { SkillStoreLive } from "../../src/services/SkillStore.js"
import { SkillLock, SkillLockLive } from "../../src/services/SkillLock.js"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const makeTempDir = () => mkdtempSync(join(tmpdir(), "skills-lock-test-"))

const makeTestLayer = (dir: string) =>
  SkillLockLive.pipe(
    Layer.provideMerge(SkillStoreLive),
    Layer.provide(NodeContext.layer),
    Layer.provide(Layer.setConfigProvider(ConfigProvider.fromMap(new Map([["SKILLS_DIR", dir]])))),
  )

describe("SkillLock", () => {
  it.live("read returns empty lock for fresh dir", () => {
    const dir = makeTempDir()
    return Effect.gen(function* () {
      const lock = yield* SkillLock
      const file = yield* lock.read
      expect(file.version).toBe(1)
      expect(Object.keys(file.skills).length).toBe(0)
    }).pipe(Effect.provide(makeTestLayer(dir)))
  })

  it.live("add and get round-trip", () => {
    const dir = makeTempDir()
    return Effect.gen(function* () {
      const lock = yield* SkillLock
      yield* lock.add("my-skill", "owner/repo", "skills/my-skill/SKILL.md")

      const entry = yield* lock.get("my-skill")
      expect(entry).not.toBe(null)
      expect(entry!.source).toBe("owner/repo")
      expect(entry!.skillPath).toBe("skills/my-skill/SKILL.md")
    }).pipe(Effect.provide(makeTestLayer(dir)))
  })

  it.live("remove deletes entry", () => {
    const dir = makeTempDir()
    return Effect.gen(function* () {
      const lock = yield* SkillLock
      yield* lock.add("to-remove", "owner/repo", "skills/to-remove/SKILL.md")
      yield* lock.remove("to-remove")

      const entry = yield* lock.get("to-remove")
      expect(entry).toBe(null)
    }).pipe(Effect.provide(makeTestLayer(dir)))
  })

  it.live("update writes updatedAt", () => {
    const dir = makeTempDir()
    return Effect.gen(function* () {
      const lock = yield* SkillLock
      yield* lock.add("test", "owner/repo", "skills/test/SKILL.md")
      yield* lock.update("test")
      const after = yield* lock.get("test")

      expect(after).not.toBe(null)
      expect(after!.source).toBe("owner/repo")
      expect(after!.updatedAt).toBeTruthy()
      expect(new Date(after!.updatedAt).toISOString()).toBe(after!.updatedAt)
    }).pipe(Effect.provide(makeTestLayer(dir)))
  })

  it.live("get returns null for nonexistent", () => {
    const dir = makeTempDir()
    return Effect.gen(function* () {
      const lock = yield* SkillLock
      const entry = yield* lock.get("nope")
      expect(entry).toBe(null)
    }).pipe(Effect.provide(makeTestLayer(dir)))
  })
})
