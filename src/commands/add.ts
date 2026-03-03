import { Console, Effect } from "effect"
import { HttpClient } from "@effect/platform"
import { parseSource, type GitHubRepo, type GitHubRepoWithSkill } from "../lib/source.js"
import { discoverSkills, fetchRaw, fetchSkillDir } from "../lib/github.js"
import { parseFrontmatter } from "../lib/frontmatter.js"
import { search } from "../lib/search-api.js"
import { toKebab } from "../lib/util.js"
import { SkillStore } from "../services/SkillStore.js"
import { SkillLock } from "../services/SkillLock.js"
import { FetchError, SearchError, SkillNotFoundError } from "../lib/errors.js"

/**
 * Install a full skill directory (SKILL.md + references/ etc.) from a repo.
 */
const installSkillDir = (
  owner: string,
  repo: string,
  skillDir: string,
  ref: string | undefined,
  sourceStr: string,
): Effect.Effect<string, FetchError, SkillStore | SkillLock | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const store = yield* SkillStore
    const lock = yield* SkillLock
    const resolvedRef = ref ?? "main"

    const files = yield* fetchSkillDir(owner, repo, skillDir, resolvedRef)

    const skillMd = files.find((f) => f.path === "SKILL.md")
    const frontmatter = skillMd
      ? yield* parseFrontmatter(skillMd.content).pipe(Effect.catchAll(() => Effect.succeed(null)))
      : null

    const fallbackName = skillDir
      ? (skillDir.split("/").at(-1) ?? "unknown")
      : repo
    const name = frontmatter ? toKebab(frontmatter.name) : fallbackName

    const skillMdPath = skillDir ? `${skillDir}/SKILL.md` : "SKILL.md"

    yield* store.installDir(name, files)
    yield* lock.add(name, sourceStr, skillMdPath).pipe(Effect.catchAll(() => Effect.void))
    yield* Console.log(`  Installed: ${name} (${files.length} file${files.length === 1 ? "" : "s"})`)

    return name
  })

const addFromRepo = (
  source: GitHubRepo,
): Effect.Effect<void, FetchError, SkillStore | SkillLock | HttpClient.HttpClient> =>
  Effect.gen(function* () {
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
  }).pipe(Effect.withSpan("command.add.fromRepo"))

/** Candidate directories to try for direct path resolution */
const SKILL_DIR_PREFIXES = ["skills", "skill"] as const

const addFromRepoWithSkill = (
  source: GitHubRepoWithSkill,
): Effect.Effect<
  void,
  FetchError | SkillNotFoundError,
  SkillStore | SkillLock | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const { owner, repo, skillFilter } = source
    const sourceStr = `${owner}/${repo}@${skillFilter}`

    // Try direct paths first — avoids full discovery scan on large repos
    for (const prefix of SKILL_DIR_PREFIXES) {
      const directPath = `${prefix}/${skillFilter}/SKILL.md`
      const direct = yield* fetchRaw(owner, repo, directPath).pipe(Effect.option)

      if (direct._tag === "Some") {
        yield* installSkillDir(owner, repo, `${prefix}/${skillFilter}`, undefined, sourceStr)
        return
      }
    }

    // Try root SKILL.md (single-skill repos)
    const rootContent = yield* fetchRaw(owner, repo, "SKILL.md").pipe(Effect.option)

    if (rootContent._tag === "Some") {
      yield* installSkillDir(owner, repo, "", undefined, sourceStr)
      return
    }

    // Fallback: full discovery for frontmatter name matching
    const skills = yield* discoverSkills(owner, repo)

    for (const skill of skills) {
      const content = yield* fetchRaw(owner, repo, skill.skillMdPath)
      const fm = yield* parseFrontmatter(content).pipe(Effect.catchAll(() => Effect.succeed(null)))
      if (fm && toKebab(fm.name) === toKebab(skillFilter)) {
        yield* installSkillDir(owner, repo, skill.skillDir, undefined, sourceStr)
        return
      }
    }

    return yield* new SkillNotFoundError({ name: skillFilter })
  }).pipe(Effect.withSpan("command.add.fromRepoWithSkill"))

const addFromSearch = (
  query: string,
): Effect.Effect<
  void,
  FetchError | SearchError | SkillNotFoundError,
  SkillStore | SkillLock | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
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
  }).pipe(Effect.withSpan("command.add.fromSearch"))

export const runAdd = (
  sourceInput: string,
  skillFilter?: string | undefined,
): Effect.Effect<
  void,
  FetchError | SearchError | SkillNotFoundError,
  SkillStore | SkillLock | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const parsed = parseSource(sourceInput)

    // --skill flag overrides: convert GitHubRepo to GitHubRepoWithSkill
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
  }).pipe(Effect.withSpan("command.add", { attributes: { sourceInput } }))
