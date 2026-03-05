import { describe, expect, it } from "effect-bun-test/v3"
import { ConfigProvider, Effect, Layer } from "effect"
import { NodeContext } from "@effect/platform-node"
import { SkillStore, SkillStoreLive } from "../../src/services/SkillStore.js"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const makeTempDir = () => mkdtempSync(join(tmpdir(), "skills-test-"))

const makeTestLayer = (dir: string) =>
  SkillStoreLive.pipe(
    Layer.provide(NodeContext.layer),
    Layer.provide(Layer.setConfigProvider(ConfigProvider.fromMap(new Map([["SKILLS_DIR", dir]])))),
  )

describe("SkillStore", () => {
  it.live("list returns empty for fresh dir", () => {
    const dir = makeTempDir()
    return Effect.gen(function* () {
      const store = yield* SkillStore
      const skills = yield* store.list
      expect(skills).toEqual([])
    }).pipe(Effect.provide(makeTestLayer(dir)))
  })

  it.live("install and list round-trip", () => {
    const dir = makeTempDir()
    return Effect.gen(function* () {
      const store = yield* SkillStore

      yield* store.install(
        "test-skill",
        `---
name: test-skill
description: A test skill
---

# Test Skill`,
      )

      const skills = yield* store.list
      expect(skills.length).toBe(1)
      expect(skills[0]!.name).toBe("test-skill")
      expect(skills[0]!.description).toBe("A test skill")
    }).pipe(Effect.provide(makeTestLayer(dir)))
  })

  it.live("remove deletes skill directory", () => {
    const dir = makeTempDir()
    return Effect.gen(function* () {
      const store = yield* SkillStore
      yield* store.install("to-remove", "---\nname: to-remove\ndescription: bye\n---\n")
      yield* store.remove("to-remove")
      const skills = yield* store.list
      expect(skills.length).toBe(0)
    }).pipe(Effect.provide(makeTestLayer(dir)))
  })

  it.live("remove fails for nonexistent skill", () => {
    const dir = makeTempDir()
    return Effect.gen(function* () {
      const store = yield* SkillStore
      const result = yield* store
        .remove("nope")
        .pipe(Effect.catchTag("SkillNotFoundError", () => Effect.succeed("not-found")))
      expect(result).toBe("not-found")
    }).pipe(Effect.provide(makeTestLayer(dir)))
  })

  it.live("syncDir removes stale files before writing new ones", () => {
    const dir = makeTempDir()
    return Effect.gen(function* () {
      const store = yield* SkillStore

      yield* store.installDir("test-skill", [
        {
          path: "SKILL.md",
          content: "---\nname: test-skill\ndescription: First\n---\n",
        },
        {
          path: "references/old.md",
          content: "old",
        },
      ])

      yield* store.syncDir("test-skill", [
        {
          path: "SKILL.md",
          content: "---\nname: test-skill\ndescription: Second\n---\n",
        },
        {
          path: "references/new.md",
          content: "new",
        },
      ])
    }).pipe(
      Effect.provide(makeTestLayer(dir)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(existsSync(join(dir, "test-skill", "references", "old.md"))).toBe(false)
          expect(readFileSync(join(dir, "test-skill", "references", "new.md"), "utf8")).toBe("new")
        }),
      ),
    )
  })
})
