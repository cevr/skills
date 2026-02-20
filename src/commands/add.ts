import { Console, Effect } from "effect"
import { HttpClient } from "@effect/platform"
import { parseSource, type GitHubRepo, type GitHubRepoWithSkill } from "../lib/source.js"
import { discoverSkills, fetchRaw } from "../lib/github.js"
import { parseFrontmatter } from "../lib/frontmatter.js"
import { search } from "../lib/search-api.js"
import { toKebab } from "../lib/util.js"
import { SkillStore } from "../services/SkillStore.js"
import { SkillLock } from "../services/SkillLock.js"
import { FetchError, SearchError, SkillNotFoundError } from "../lib/errors.js"

const installFromSkillMd = (
  owner: string,
  repo: string,
  skillMdPath: string,
  ref: string | undefined,
  sourceStr: string,
): Effect.Effect<string, FetchError, SkillStore | SkillLock | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const store = yield* SkillStore
    const lock = yield* SkillLock
    const content = yield* fetchRaw(owner, repo, skillMdPath, ref ?? "main")
    const frontmatter = yield* parseFrontmatter(content).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    )

    const name = frontmatter
      ? toKebab(frontmatter.name)
      : (skillMdPath.split("/").at(-2) ?? "unknown")

    yield* store.install(name, content)
    yield* lock.add(name, sourceStr, skillMdPath).pipe(Effect.catchAll(() => Effect.void))
    yield* Console.log(`  Installed: ${name}`)

    return name
  })

const addFromRepo = (
  source: GitHubRepo,
): Effect.Effect<void, FetchError, SkillStore | SkillLock | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const { owner, repo, ref, subpath } = source
    const sourceStr = `${owner}/${repo}${ref ? `#${ref}` : ""}`

    if (subpath) {
      const skillMdPath = subpath.endsWith("SKILL.md") ? subpath : `${subpath}/SKILL.md`
      yield* installFromSkillMd(owner, repo, skillMdPath, ref, sourceStr)
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
      yield* installFromSkillMd(owner, repo, skill.skillMdPath, ref, sourceStr)
    }
  }).pipe(Effect.withSpan("command.add.fromRepo"))

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

    const skills = yield* discoverSkills(owner, repo)

    // Match by directory name
    const byDir = skills.find((s) => s.dirName === skillFilter)
    if (byDir) {
      yield* installFromSkillMd(owner, repo, byDir.skillMdPath, undefined, sourceStr)
      return
    }

    // Match by frontmatter name
    for (const skill of skills) {
      const content = yield* fetchRaw(owner, repo, skill.skillMdPath)
      const fm = yield* parseFrontmatter(content).pipe(Effect.catchAll(() => Effect.succeed(null)))
      if (fm && toKebab(fm.name) === toKebab(skillFilter)) {
        const store = yield* SkillStore
        const lock = yield* SkillLock
        const name = toKebab(fm.name)
        yield* store.install(name, content)
        yield* lock.add(name, sourceStr, skill.skillMdPath).pipe(Effect.catchAll(() => Effect.void))
        yield* Console.log(`  Installed: ${name}`)
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
): Effect.Effect<
  void,
  FetchError | SearchError | SkillNotFoundError,
  SkillStore | SkillLock | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const parsed = parseSource(sourceInput)

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
