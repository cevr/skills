import { Config, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { FetchError } from "./errors.js"

const GitHubContentEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  type: Schema.Literal("file", "dir", "symlink", "submodule"),
})

const GitHubContentsArray = Schema.Array(GitHubContentEntry)

type GitHubContentEntry = typeof GitHubContentEntry.Type

const decodeContents = HttpClientResponse.schemaBodyJson(GitHubContentsArray)

const githubToken = Config.string("GITHUB_TOKEN").pipe(Config.withDefault(""))

const withAuth = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<HttpClientRequest.HttpClientRequest> =>
  githubToken.pipe(
    Effect.orDie,
    Effect.map((token) =>
      token ? HttpClientRequest.setHeader("Authorization", `token ${token}`)(request) : request,
    ),
  )

/**
 * List directory contents via GitHub Contents API.
 */
export const listContents = (
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Effect.Effect<ReadonlyArray<GitHubContentEntry>, FetchError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}${ref ? `?ref=${ref}` : ""}`
    const request = yield* withAuth(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeader("Accept", "application/vnd.github.v3+json"),
        HttpClientRequest.setHeader("User-Agent", "@cvr/skills"),
      ),
    )
    return yield* client.execute(request).pipe(Effect.flatMap(decodeContents))
  }).pipe(
    Effect.mapError((cause) => new FetchError({ url: `github:${owner}/${repo}/${path}`, cause })),
    Effect.withSpan("github.listContents", { attributes: { owner, repo, path } }),
  )

/**
 * Fetch raw file content from GitHub via raw.githubusercontent.com.
 */
export const fetchRaw = (
  owner: string,
  repo: string,
  path: string,
  ref = "main",
): Effect.Effect<string, FetchError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`
    const request = yield* withAuth(
      HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("User-Agent", "@cvr/skills")),
    )
    const response = yield* client.execute(request)
    return yield* response.text
  }).pipe(
    Effect.mapError((cause) => new FetchError({ url: `github:${owner}/${repo}/${path}`, cause })),
    Effect.withSpan("github.fetchRaw", { attributes: { owner, repo, path, ref } }),
  )

export interface SkillFile {
  readonly path: string
  readonly content: string
}

export interface SkillEntry {
  readonly dirName: string
  readonly skillMdPath: string
  /** The base directory containing SKILL.md (e.g. "skills/react" or "skill/opentui") */
  readonly skillDir: string
}

/** Conventional directory names for skills in a repo */
const SKILL_DIRS = ["skills", "skill"] as const

/**
 * Discover all skills in a repo by listing conventional skill directories
 * (`skills/` or `skill/`) and filtering for subdirectories that contain a SKILL.md.
 * Falls back to checking for SKILL.md at the repo root for single-skill repos.
 */
export const discoverSkills = (
  owner: string,
  repo: string,
  ref?: string,
): Effect.Effect<ReadonlyArray<SkillEntry>, FetchError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const skills: Array<SkillEntry> = []

    for (const skillsDir of SKILL_DIRS) {
      const entries = yield* listContents(owner, repo, skillsDir, ref).pipe(
        Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<GitHubContentEntry>)),
      )
      const dirs = entries.filter((e) => e.type === "dir")

      for (const dir of dirs) {
        const children = yield* listContents(owner, repo, dir.path, ref).pipe(
          Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<GitHubContentEntry>)),
        )
        if (children.some((c) => c.name === "SKILL.md")) {
          skills.push({
            dirName: dir.name,
            skillMdPath: `${dir.path}/SKILL.md`,
            skillDir: dir.path,
          })
        }
      }

      if (skills.length > 0) break
    }

    // Fallback: check for SKILL.md at repo root (single-skill repos)
    if (skills.length === 0) {
      const rootEntries = yield* listContents(owner, repo, "", ref).pipe(
        Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<GitHubContentEntry>)),
      )
      if (rootEntries.some((e) => e.name === "SKILL.md")) {
        skills.push({
          dirName: repo,
          skillMdPath: "SKILL.md",
          skillDir: "",
        })
      }
    }

    return skills
  }).pipe(Effect.withSpan("github.discoverSkills", { attributes: { owner, repo } }))

/**
 * Recursively fetch all files in a skill directory.
 * Returns paths relative to the skill dir root.
 */
export const fetchSkillDir = (
  owner: string,
  repo: string,
  dirPath: string,
  ref = "main",
): Effect.Effect<ReadonlyArray<SkillFile>, FetchError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const files: Array<SkillFile> = []

    const walk = (path: string): Effect.Effect<void, FetchError, HttpClient.HttpClient> =>
      Effect.gen(function* () {
        const entries = yield* listContents(owner, repo, path, ref)
        for (const entry of entries) {
          if (entry.type === "file") {
            const content = yield* fetchRaw(owner, repo, entry.path, ref)
            const relativePath = dirPath ? entry.path.slice(dirPath.length + 1) : entry.path
            files.push({ path: relativePath, content })
          } else if (entry.type === "dir") {
            yield* walk(entry.path)
          }
        }
      })

    yield* walk(dirPath)

    return files
  }).pipe(Effect.withSpan("github.fetchSkillDir", { attributes: { owner, repo, dirPath } }))
