import { describe, expect, it } from "effect-bun-test"
import { ConfigProvider, Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runUpdate } from "../../src/commands/update.js"
import { GitHub, type GitHubShape } from "../../src/services/GitHub.js"
import { SkillLock, SkillLockLive } from "../../src/services/SkillLock.js"
import { SkillStore, SkillStoreLive } from "../../src/services/SkillStore.js"
import { FetchError } from "../../src/lib/errors.js"

const makeTempDir = () => mkdtempSync(join(tmpdir(), "skills-update-test-"))

const makeTestLayer = (dir: string, github: GitHubShape) =>
  SkillLockLive.pipe(
    Layer.provideMerge(SkillStoreLive),
    Layer.provideMerge(GitHub.layerTest(github)),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ SKILLS_DIR: dir }))),
  )

const notImplemented = (..._args: Array<unknown>) =>
  Effect.fail(new FetchError({ url: "not-implemented" }))

describe("runUpdate", () => {
  it.live("updates multi-file skills installed from owner/repo@skill sources", () => {
    const dir = makeTempDir()

    const github: GitHubShape = {
      listContents: (_owner, _repo, path) => {
        switch (path) {
          case "skill/opentui":
            return Effect.succeed([
              { name: "SKILL.md", path: "skill/opentui/SKILL.md", type: "file" as const },
              { name: "references", path: "skill/opentui/references", type: "dir" as const },
            ])
          case "skill/opentui/references":
            return Effect.succeed([
              {
                name: "guide.md",
                path: "skill/opentui/references/guide.md",
                type: "file" as const,
              },
            ])
          default:
            return Effect.succeed([])
        }
      },
      fetchRaw: (_owner, _repo, path) => {
        switch (path) {
          case "skill/opentui/SKILL.md":
            return Effect.succeed(`---
name: OpenTUI
description: Updated skill
---

Fresh content
`)
          case "skill/opentui/references/guide.md":
            return Effect.succeed("new reference")
          default:
            return Effect.die(`unexpected path: ${path}`)
        }
      },
      listTree: notImplemented as GitHubShape["listTree"],
      discoverSkills: notImplemented as GitHubShape["discoverSkills"],
      fetchSkillDir: (owner, repo, dirPath, _ref) => {
        if (dirPath === "skill/opentui") {
          return Effect.succeed([
            {
              path: "SKILL.md",
              content: `---
name: OpenTUI
description: Updated skill
---

Fresh content
`,
            },
            {
              path: "references/guide.md",
              content: "new reference",
            },
          ])
        }
        return Effect.die(`unexpected dir: ${dirPath}`)
      },
    }

    return Effect.gen(function* () {
      const store = yield* SkillStore
      const lock = yield* SkillLock

      yield* store.installDir("opentui", [
        {
          path: "SKILL.md",
          content: `---
name: OpenTUI
description: Old skill
---

Old content
`,
        },
        {
          path: "references/guide.md",
          content: "old reference",
        },
        {
          path: "references/stale.md",
          content: "stale reference",
        },
      ])
      yield* lock.add("opentui", "msmps/opentui-skill@opentui", "skill/opentui/SKILL.md")

      yield* runUpdate()
    }).pipe(
      Effect.provide(makeTestLayer(dir, github)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(readFileSync(join(dir, "opentui", "SKILL.md"), "utf8")).toContain("Fresh content")
          expect(readFileSync(join(dir, "opentui", "references", "guide.md"), "utf8")).toBe(
            "new reference",
          )
          expect(existsSync(join(dir, "opentui", "references", "stale.md"))).toBe(false)
        }),
      ),
    )
  })
})
