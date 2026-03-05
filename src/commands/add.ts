import { Console, Effect } from "effect"
import { SkillNotFoundError } from "../lib/errors.js"
import { parseFrontmatter } from "../lib/frontmatter.js"
import { search } from "../lib/search-api.js"
import { parseSource, type GitHubRepo, type GitHubRepoWithSkill } from "../lib/source.js"
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
  function* (sourceInput: string, skillFilter?: string | undefined) {
    const parsed = parseSource(sourceInput)

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
      case "SearchQuery":
        yield* addFromSearch(parsed.query)
        break
    }
  },
  (effect, sourceInput) => Effect.withSpan(effect, "command.add", { attributes: { sourceInput } }),
)
