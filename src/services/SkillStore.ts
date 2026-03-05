import { Context, Config, Effect, Layer, Option } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { SkillNotFoundError } from "../lib/errors.js"
import { parseFrontmatter, type SkillFrontmatter } from "../lib/frontmatter.js"

export interface InstalledSkill {
  readonly name: string
  readonly description: string
  readonly dirPath: string
}

export class SkillStore extends Context.Tag("@skills/SkillStore")<
  SkillStore,
  {
    readonly dir: string
    readonly list: Effect.Effect<ReadonlyArray<InstalledSkill>>
    readonly read: (name: string) => Effect.Effect<string, SkillNotFoundError>
    readonly install: (name: string, content: string) => Effect.Effect<void>
    readonly installDir: (
      name: string,
      files: ReadonlyArray<{ path: string; content: string }>,
    ) => Effect.Effect<void>
    readonly syncDir: (
      name: string,
      files: ReadonlyArray<{ path: string; content: string }>,
    ) => Effect.Effect<void>
    readonly remove: (name: string) => Effect.Effect<void, SkillNotFoundError>
  }
>() {}

const skillsDirConfig = Config.option(Config.string("SKILLS_DIR"))

const defaultSkillsDir = Config.string("HOME").pipe(
  Config.map((home) => `${home}/Developer/personal/dotfiles/skills`),
)

export const SkillStoreLive = Layer.effect(
  SkillStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    const configDir = yield* Effect.orDie(skillsDirConfig)
    const dir = Option.isSome(configDir) ? configDir.value : yield* Effect.orDie(defaultSkillsDir)

    const list: Effect.Effect<ReadonlyArray<InstalledSkill>> = Effect.gen(function* () {
      const exists = yield* fs.exists(dir)
      if (!exists) return []

      const entries = yield* fs.readDirectory(dir)
      const skills: Array<InstalledSkill> = []

      for (const entry of entries) {
        // Skip hidden files/dirs
        if (entry.startsWith(".")) continue

        const entryPath = pathService.join(dir, entry)
        const stat = yield* fs.stat(entryPath).pipe(Effect.catchAll(() => Effect.succeed(null)))
        if (!stat || stat.type !== "Directory") continue

        const skillMdPath = pathService.join(entryPath, "SKILL.md")
        const hasSkillMd = yield* fs.exists(skillMdPath)
        if (!hasSkillMd) continue

        const content = yield* fs.readFileString(skillMdPath)
        const frontmatter: SkillFrontmatter | null = yield* parseFrontmatter(content).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        )

        skills.push({
          name: frontmatter?.name ?? entry,
          description: frontmatter?.description ?? "",
          dirPath: entryPath,
        })
      }

      return skills.toSorted((a, b) => a.name.localeCompare(b.name))
    }).pipe(Effect.orDie, Effect.withSpan("SkillStore.list"))

    const read = (name: string) =>
      Effect.gen(function* () {
        const skillMdPath = pathService.join(dir, name, "SKILL.md")
        const exists = yield* fs.exists(skillMdPath).pipe(Effect.orDie)
        if (!exists) return yield* new SkillNotFoundError({ name })
        return yield* fs.readFileString(skillMdPath).pipe(Effect.orDie)
      }).pipe(Effect.withSpan("SkillStore.read", { attributes: { name } }))

    const install = (name: string, content: string) =>
      Effect.gen(function* () {
        const skillDir = pathService.join(dir, name)
        yield* fs.makeDirectory(skillDir, { recursive: true })
        yield* fs.writeFileString(pathService.join(skillDir, "SKILL.md"), content)
      }).pipe(Effect.orDie, Effect.withSpan("SkillStore.install", { attributes: { name } }))

    const installDir = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
      Effect.gen(function* () {
        const skillDir = pathService.join(dir, name)
        yield* fs.makeDirectory(skillDir, { recursive: true })
        for (const file of files) {
          const filePath = pathService.join(skillDir, file.path)
          const fileDir = pathService.dirname(filePath)
          yield* fs.makeDirectory(fileDir, { recursive: true })
          yield* fs.writeFileString(filePath, file.content)
        }
      }).pipe(Effect.orDie, Effect.withSpan("SkillStore.installDir", { attributes: { name } }))

    const syncDir = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
      Effect.gen(function* () {
        const skillDir = pathService.join(dir, name)
        const exists = yield* fs.exists(skillDir).pipe(Effect.orDie)
        if (exists) {
          yield* fs.remove(skillDir, { recursive: true }).pipe(Effect.orDie)
        }
        yield* installDir(name, files)
      }).pipe(Effect.orDie, Effect.withSpan("SkillStore.syncDir", { attributes: { name } }))

    const remove = (name: string) =>
      Effect.gen(function* () {
        const skillDir = pathService.join(dir, name)
        const exists = yield* fs.exists(skillDir).pipe(Effect.orDie)
        if (!exists) return yield* new SkillNotFoundError({ name })
        yield* fs.remove(skillDir, { recursive: true }).pipe(Effect.orDie)
      }).pipe(Effect.withSpan("SkillStore.remove", { attributes: { name } }))

    return { dir, list, read, install, installDir, syncDir, remove }
  }),
)
