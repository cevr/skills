import { Console, Effect, Option } from "effect"
import { FileSystem, Path } from "effect"
import { NoSkillsFoundError, SkillNotFoundError } from "../lib/errors.js"
import { walkDir } from "../lib/fs.js"
import { DEFAULT_REF, SKILL_DIR_PREFIXES } from "../lib/constants.js"
import { tryParseFrontmatter } from "../lib/frontmatter.js"
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
  const resolvedRef = ref ?? DEFAULT_REF

  const files = yield* fetchSkillDir(owner, repo, skillDir, resolvedRef)

  const skillMd = files.find((file) => file.path === "SKILL.md")
  const frontmatter = skillMd ? yield* tryParseFrontmatter(skillMd.content) : Option.none()

  const fallbackName = skillDir ? (skillDir.split("/").at(-1) ?? "unknown") : repo
  const name = Option.match(frontmatter, {
    onNone: () => fallbackName,
    onSome: (fm) => toKebab(fm.name),
  })
  const skillMdPath = skillDir ? `${skillDir}/SKILL.md` : "SKILL.md"

  yield* store.installDir(name, files)
  yield* lock.add(name, sourceStr, skillMdPath)
  yield* Console.log(`  Installed: ${name} (${files.length} file${files.length === 1 ? "" : "s"})`)

  return name
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
    return yield* new NoSkillsFoundError({ message: `No SKILL.md found in ${absPath}` })
  }

  const files = yield* walkDir(absPath)
  const skillMd = files.find((f) => f.path === "SKILL.md")
  const frontmatter = skillMd ? yield* tryParseFrontmatter(skillMd.content) : Option.none()

  const fallbackName = pathService.basename(absPath)
  const name = Option.match(frontmatter, {
    onNone: () => fallbackName,
    onSome: (fm) => toKebab(fm.name),
  })

  if (skillFilter && toKebab(skillFilter) !== name) return Option.none()

  const sourceStr = `local:${absPath}`
  yield* store.installDir(name, files)
  yield* lock.add(name, sourceStr, "SKILL.md")
  yield* Console.log(`  Installed: ${name} (${files.length} file${files.length === 1 ? "" : "s"})`)

  return Option.some(name)
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
    return yield* new NoSkillsFoundError({ message: `Path not found: ${absPath}` })
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
      const stat = yield* fs.stat(entryPath).pipe(Effect.catch(() => Effect.succeed(null)))
      if (!stat || stat.type !== "Directory") continue

      const skillMdPath = pathService.join(entryPath, "SKILL.md")
      const hasSkillMd = yield* fs.exists(skillMdPath).pipe(Effect.orDie)
      if (!hasSkillMd) continue

      const name = yield* installLocalSkillDir(entryPath, skillFilter)
      if (Option.isSome(name)) discovered.push(name.value)
    }

    if (discovered.length > 0) break
  }

  if (discovered.length === 0) {
    return yield* new NoSkillsFoundError({
      message: skillFilter
        ? `Skill "${skillFilter}" not found in ${absPath}`
        : `No skills found in ${absPath}`,
    })
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

  yield* Console.error(`Discovering skills in ${owner}/${repo}...`)
  const skills = yield* discoverSkills(owner, repo, ref)

  if (skills.length === 0) {
    return yield* new NoSkillsFoundError({ message: "No skills found in this repository." })
  }

  yield* Console.error(`Found ${skills.length} skill(s):\n`)
  yield* Effect.forEach(
    skills,
    (skill) => installSkillDir(owner, repo, skill.skillDir, ref, sourceStr),
    { concurrency: 5 },
  )
})

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
    const frontmatter = yield* tryParseFrontmatter(rootContent.value)
    if (Option.isSome(frontmatter) && toKebab(frontmatter.value.name) === toKebab(skillFilter)) {
      yield* installSkillDir(owner, repo, "", undefined, sourceStr)
      return
    }
  }

  const skills = yield* discoverSkills(owner, repo)

  for (const skill of skills) {
    const content = yield* fetchRaw(owner, repo, skill.skillMdPath)
    const frontmatter = yield* tryParseFrontmatter(content)
    if (Option.isSome(frontmatter) && toKebab(frontmatter.value.name) === toKebab(skillFilter)) {
      yield* installSkillDir(owner, repo, skill.skillDir, undefined, sourceStr)
      return
    }
  }

  return yield* new SkillNotFoundError({ name: skillFilter })
})

const addFromSearch = Effect.fn("command.add.fromSearch")(function* (query: string) {
  yield* Console.error(`Searching for "${query}"...`)
  const result = yield* search(query)

  if (result.skills.length === 0) {
    return yield* new NoSkillsFoundError({ message: `No skills found for "${query}"` })
  }

  const exactMatch = result.skills.find(
    (s) => s.skillId === query || s.name.toLowerCase() === query.toLowerCase(),
  )
  const skill = exactMatch ?? result.skills[0]!

  if (!exactMatch && result.skills.length > 1) {
    yield* Console.error(`${result.skills.length} results found, installing best match:`)
    for (const s of result.skills.slice(0, 3)) {
      yield* Console.error(`  ${s.name} (${s.source})`)
    }
    yield* Console.error("")
  }
  yield* Console.error(`Installing: ${skill.name} (${skill.source})\n`)

  const [owner, repo] = skill.source.split("/") as [string, string]
  yield* addFromRepoWithSkill({
    _tag: "GitHubRepoWithSkill",
    owner,
    repo,
    skillFilter: skill.skillId,
  })
})

export const runAdd = Effect.fn("command.add")(function* (
  sourceInput: string | undefined,
  skillFilter?: string | undefined,
) {
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
})
