import { Console, Effect } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { SkillNotFoundError } from "../lib/errors.js"
import { parseFrontmatter } from "../lib/frontmatter.js"
import { search } from "../lib/search-api.js"
import {
  parseSource,
  type GitHubRepo,
  type GitHubRepoWithSkill,
  type LocalPath,
} from "../lib/source.js"
import { toKebab } from "../lib/util.js"
import { discoverSkills, fetchRaw, fetchSkillDir } from "../services/GitHub.js"
import { SkillLock } from "../services/SkillLock.js"
import { SkillStore } from "../services/SkillStore.js"

const installSkillDir = Effect.fn("command.add.installSkillDir")(function* (
  owner: string,
  repo: string,
  skillDir: string,
  ref: string | undefined,
  sourceStr: string,
) {
  const store = yield* SkillStore
  const lock = yield* SkillLock
  const resolvedRef = ref ?? "main"

  const files = yield* fetchSkillDir(owner, repo, skillDir, resolvedRef)

  const skillMd = files.find((file) => file.path === "SKILL.md")
  const frontmatter = skillMd
    ? yield* parseFrontmatter(skillMd.content).pipe(Effect.catchAll(() => Effect.succeed(null)))
    : null

  const fallbackName = skillDir ? (skillDir.split("/").at(-1) ?? "unknown") : repo
  const name = frontmatter ? toKebab(frontmatter.name) : fallbackName
  const skillMdPath = skillDir ? `${skillDir}/SKILL.md` : "SKILL.md"

  yield* store.installDir(name, files)
  yield* lock.add(name, sourceStr, skillMdPath).pipe(Effect.catchAll(() => Effect.void))
  yield* Console.log(`  Installed: ${name} (${files.length} file${files.length === 1 ? "" : "s"})`)

  return name
})

const readLocalDir = Effect.fn("command.add.readLocalDir")(function* (dirPath: string) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path

  const files: Array<{ path: string; content: string }> = []

  const walk = (currentDir: string, prefix: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectory(currentDir).pipe(Effect.orDie)
      for (const entry of entries) {
        if (entry.startsWith(".")) continue
        const fullPath = pathService.join(currentDir, entry)
        const stat = yield* fs.stat(fullPath).pipe(Effect.orDie)
        if (stat.type === "Directory") {
          yield* walk(fullPath, prefix ? `${prefix}/${entry}` : entry)
        } else {
          const content = yield* fs.readFileString(fullPath).pipe(Effect.orDie)
          files.push({ path: prefix ? `${prefix}/${entry}` : entry, content })
        }
      }
    })

  yield* walk(dirPath, "")
  return files
})

const installLocalSkillDir = Effect.fn("command.add.installLocalSkillDir")(function* (
  dirPath: string,
  skillFilter?: string | undefined,
) {
  const store = yield* SkillStore
  const lock = yield* SkillLock
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path

  const absPath = pathService.resolve(dirPath)

  const skillMdPath = pathService.join(absPath, "SKILL.md")
  const hasSkillMd = yield* fs.exists(skillMdPath).pipe(Effect.orDie)
  if (!hasSkillMd) {
    yield* Console.error(`No SKILL.md found in ${absPath}`)
    return
  }

  const files = yield* readLocalDir(absPath)
  const skillMd = files.find((f) => f.path === "SKILL.md")
  const frontmatter = skillMd
    ? yield* parseFrontmatter(skillMd.content).pipe(Effect.catchAll(() => Effect.succeed(null)))
    : null

  const fallbackName = pathService.basename(absPath)
  const name = frontmatter ? toKebab(frontmatter.name) : fallbackName

  if (skillFilter && toKebab(skillFilter) !== name) return null

  const sourceStr = `local:${absPath}`
  yield* store.installDir(name, files)
  yield* lock.add(name, sourceStr, "SKILL.md").pipe(Effect.catchAll(() => Effect.void))
  yield* Console.log(`  Installed: ${name} (${files.length} file${files.length === 1 ? "" : "s"})`)

  return name
})

const addFromLocal = Effect.fn("command.add.fromLocal")(function* (
  source: LocalPath,
  skillFilter?: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path

  const inputPath = source.path.startsWith("~")
    ? pathService.join(process.env.HOME ?? "", source.path.slice(1))
    : source.path
  const absPath = pathService.resolve(inputPath)

  const exists = yield* fs.exists(absPath).pipe(Effect.orDie)
  if (!exists) {
    yield* Console.error(`Path not found: ${absPath}`)
    return
  }

  // Check if the path itself is a skill directory
  const hasRootSkillMd = yield* fs.exists(pathService.join(absPath, "SKILL.md")).pipe(Effect.orDie)
  if (hasRootSkillMd) {
    yield* installLocalSkillDir(absPath, skillFilter)
    return
  }

  // Discover skills in subdirectories (look in skills/, skill/, or direct children)
  const discovered: Array<string> = []

  for (const prefix of ["skills", "skill", "."]) {
    const searchDir = prefix === "." ? absPath : pathService.join(absPath, prefix)
    const searchExists = yield* fs.exists(searchDir).pipe(Effect.orDie)
    if (!searchExists) continue

    const entries = yield* fs.readDirectory(searchDir).pipe(Effect.orDie)
    for (const entry of entries) {
      if (entry.startsWith(".")) continue
      const entryPath = pathService.join(searchDir, entry)
      const stat = yield* fs.stat(entryPath).pipe(Effect.catchAll(() => Effect.succeed(null)))
      if (!stat || stat.type !== "Directory") continue

      const skillMdPath = pathService.join(entryPath, "SKILL.md")
      const hasSkillMd = yield* fs.exists(skillMdPath).pipe(Effect.orDie)
      if (!hasSkillMd) continue

      const name = yield* installLocalSkillDir(entryPath, skillFilter)
      if (name) discovered.push(name)
    }

    if (discovered.length > 0) break
  }

  if (discovered.length === 0) {
    if (skillFilter) {
      yield* Console.error(`Skill "${skillFilter}" not found in ${absPath}`)
    } else {
      yield* Console.error(`No skills found in ${absPath}`)
    }
    return
  }

  yield* Console.log(`\n${discovered.length} skill(s) installed from ${absPath}`)
})

const addFromRepo = Effect.fn("command.add.fromRepo")(function* (source: GitHubRepo) {
  const { owner, repo, ref, subpath } = source
  const sourceStr = `${owner}/${repo}${ref ? `#${ref}` : ""}`

  if (subpath) {
    const skillDir = subpath.endsWith("SKILL.md")
      ? subpath.split("/").slice(0, -1).join("/")
      : subpath
    yield* installSkillDir(owner, repo, skillDir, ref, sourceStr)
    return
  }

  yield* Console.log(`Discovering skills in ${owner}/${repo}...`)
  const skills = yield* discoverSkills(owner, repo, ref)

  if (skills.length === 0) {
    yield* Console.error("No skills found in this repository.")
    return
  }

  yield* Console.log(`Found ${skills.length} skill(s):\n`)
  for (const skill of skills) {
    yield* installSkillDir(owner, repo, skill.skillDir, ref, sourceStr)
  }
})

const SKILL_DIR_PREFIXES = ["skills", "skill"] as const

const addFromRepoWithSkill = Effect.fn("command.add.fromRepoWithSkill")(function* (
  source: GitHubRepoWithSkill,
) {
  const { owner, repo, skillFilter } = source
  const sourceStr = `${owner}/${repo}@${skillFilter}`

  for (const prefix of SKILL_DIR_PREFIXES) {
    const directPath = `${prefix}/${skillFilter}/SKILL.md`
    const direct = yield* fetchRaw(owner, repo, directPath).pipe(Effect.option)

    if (direct._tag === "Some") {
      yield* installSkillDir(owner, repo, `${prefix}/${skillFilter}`, undefined, sourceStr)
      return
    }
  }

  const rootContent = yield* fetchRaw(owner, repo, "SKILL.md").pipe(Effect.option)

  if (rootContent._tag === "Some") {
    yield* installSkillDir(owner, repo, "", undefined, sourceStr)
    return
  }

  const skills = yield* discoverSkills(owner, repo)

  for (const skill of skills) {
    const content = yield* fetchRaw(owner, repo, skill.skillMdPath)
    const frontmatter = yield* parseFrontmatter(content).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    )
    if (frontmatter && toKebab(frontmatter.name) === toKebab(skillFilter)) {
      yield* installSkillDir(owner, repo, skill.skillDir, undefined, sourceStr)
      return
    }
  }

  return yield* new SkillNotFoundError({ name: skillFilter })
})

const addFromSearch = Effect.fn("command.add.fromSearch")(function* (query: string) {
  yield* Console.log(`Searching for "${query}"...`)
  const result = yield* search(query)

  if (result.skills.length === 0) {
    yield* Console.error(`No skills found for "${query}"`)
    return
  }

  const skill = result.skills[0]!
  yield* Console.log(`Found: ${skill.name} (${skill.source})\n`)

  const [owner, repo] = skill.source.split("/") as [string, string]
  yield* addFromRepoWithSkill({
    _tag: "GitHubRepoWithSkill",
    owner,
    repo,
    skillFilter: skill.skillId,
  })
})

export const runAdd = Effect.fn("command.add")(
  function* (sourceInput: string | undefined, skillFilter?: string | undefined) {
    const parsed = parseSource(sourceInput ?? ".")

    if (skillFilter && parsed._tag === "GitHubRepo") {
      yield* addFromRepoWithSkill({
        _tag: "GitHubRepoWithSkill",
        owner: parsed.owner,
        repo: parsed.repo,
        skillFilter,
      })
      return
    }

    switch (parsed._tag) {
      case "GitHubRepo":
        yield* addFromRepo(parsed)
        break
      case "GitHubRepoWithSkill":
        yield* addFromRepoWithSkill(parsed)
        break
      case "LocalPath":
        yield* addFromLocal(parsed, skillFilter)
        break
      case "SearchQuery":
        yield* addFromSearch(parsed.query)
        break
    }
  },
  (effect, sourceInput) =>
    Effect.withSpan(effect, "command.add", { attributes: { sourceInput: sourceInput ?? "." } }),
)
