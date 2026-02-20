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
    const client = yield* HttpClient.HttpClient
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
    const client = yield* HttpClient.HttpClient
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

export interface SkillEntry {
  readonly dirName: string
  readonly skillMdPath: string
}

/**
 * Discover all skills in a repo by listing `skills/` dir and filtering for subdirectories
 * that contain a SKILL.md.
 */
export const discoverSkills = (
  owner: string,
  repo: string,
  ref?: string,
): Effect.Effect<ReadonlyArray<SkillEntry>, FetchError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const entries = yield* listContents(owner, repo, "skills", ref)
    const dirs = entries.filter((e) => e.type === "dir")

    const skills: Array<SkillEntry> = []
    for (const dir of dirs) {
      const children = yield* listContents(owner, repo, dir.path, ref).pipe(
        Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<GitHubContentEntry>)),
      )
      if (children.some((c) => c.name === "SKILL.md")) {
        skills.push({
          dirName: dir.name,
          skillMdPath: `${dir.path}/SKILL.md`,
        })
      }
    }

    return skills
  }).pipe(Effect.withSpan("github.discoverSkills", { attributes: { owner, repo } }))
