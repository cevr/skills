import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { Config, Context, Effect, Layer, Option, Schema } from "effect"
import { FetchError } from "../lib/errors.js"

const GitHubContentEntrySchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  type: Schema.Literal("file", "dir", "symlink", "submodule"),
})

const GitHubContentsArraySchema = Schema.Array(GitHubContentEntrySchema)

type GitHubContentEntry = typeof GitHubContentEntrySchema.Type

const decodeContents = HttpClientResponse.schemaBodyJson(GitHubContentsArraySchema)
const decodeContentsJson = Schema.decodeUnknown(Schema.parseJson(GitHubContentsArraySchema))
const githubToken = Config.option(Config.string("GITHUB_TOKEN"))

export interface GitHubShape {
  readonly listContents: (
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ) => Effect.Effect<ReadonlyArray<GitHubContentEntry>, FetchError>
  readonly fetchRaw: (
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ) => Effect.Effect<string, FetchError>
}

interface GitHubCliShape extends GitHubShape {
  readonly run: (args: ReadonlyArray<string>) => Effect.Effect<string, FetchError>
  readonly isAvailable: () => Effect.Effect<boolean, never>
}

interface GitHubHttpShape extends GitHubShape {
  readonly hasExplicitToken: () => Effect.Effect<boolean, never>
}

const encodeRepoPath = (path: string) => path.split("/").map(encodeURIComponent).join("/")

const contentsEndpoint = (owner: string, repo: string, path: string, ref?: string) =>
  `repos/${owner}/${repo}/contents${path ? `/${encodeRepoPath(path)}` : ""}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`

export class GitHubCli extends Context.Tag("@skills/GitHubCli")<GitHubCli, GitHubCliShape>() {
  static readonly Live = Layer.sync(this, () => {
    const run = Effect.fn("GitHubCli.run")(function* (args: ReadonlyArray<string>) {
      const process = yield* Effect.try({
        try: () => Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" }),
        catch: (cause) => new FetchError({ url: `gh:${args.join(" ")}`, cause }),
      })

      const [stdout, stderr, exitCode] = yield* Effect.tryPromise({
        try: () =>
          Promise.all([
            new Response(process.stdout).text(),
            new Response(process.stderr).text(),
            process.exited,
          ]),
        catch: (cause) => new FetchError({ url: `gh:${args.join(" ")}`, cause }),
      })

      if (exitCode !== 0) {
        return yield* new FetchError({
          url: `gh:${args.join(" ")}`,
          cause: stderr.trim() || `gh exited with code ${exitCode}`,
        })
      }

      return stdout
    })

    const isAvailable = Effect.fn("GitHubCli.isAvailable")(function* () {
      if (!Bun.which("gh")) return false

      return yield* run(["auth", "status"]).pipe(
        Effect.as(true),
        Effect.catchTag("FetchError", () => Effect.succeed(false)),
      )
    })

    const listContents = Effect.fn("GitHubCli.listContents")(function* (
      owner: string,
      repo: string,
      path: string,
      ref?: string,
    ) {
      const endpoint = contentsEndpoint(owner, repo, path, ref)
      const output = yield* run(["api", "-H", "Accept: application/vnd.github.v3+json", endpoint])
      return yield* decodeContentsJson(output).pipe(
        Effect.mapError(
          (cause) => new FetchError({ url: `github:${owner}/${repo}/${path}`, cause }),
        ),
        Effect.withSpan("GitHubCli.listContents", { attributes: { owner, repo, path, ref } }),
      )
    })

    const fetchRaw = Effect.fn("GitHubCli.fetchRaw")(function* (
      owner: string,
      repo: string,
      path: string,
      ref = "main",
    ) {
      const endpoint = contentsEndpoint(owner, repo, path, ref)
      return yield* run(["api", "-H", "Accept: application/vnd.github.raw", endpoint]).pipe(
        Effect.mapError(
          (cause) => new FetchError({ url: `github:${owner}/${repo}/${path}`, cause }),
        ),
        Effect.withSpan("GitHubCli.fetchRaw", { attributes: { owner, repo, path, ref } }),
      )
    })

    return GitHubCli.of({ run, isAvailable, listContents, fetchRaw })
  })
}

export class GitHubHttp extends Context.Tag("@skills/GitHubHttp")<GitHubHttp, GitHubHttpShape>() {
  static readonly Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)

      const withAuth = Effect.fn("GitHubHttp.withAuth")(function* (
        request: HttpClientRequest.HttpClientRequest,
      ) {
        const token = yield* githubToken.pipe(Effect.orDie)
        return Option.match(token, {
          onNone: () => request,
          onSome: (value) =>
            HttpClientRequest.setHeader("Authorization", `token ${value}`)(request),
        })
      })

      return GitHubHttp.of({
        hasExplicitToken: () => githubToken.pipe(Effect.orDie, Effect.map(Option.isSome)),
        listContents: Effect.fn("GitHubHttp.listContents")(function* (
          owner: string,
          repo: string,
          path: string,
          ref?: string,
        ) {
          const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}${ref ? `?ref=${ref}` : ""}`
          const request = yield* withAuth(
            HttpClientRequest.get(url).pipe(
              HttpClientRequest.setHeader("Accept", "application/vnd.github.v3+json"),
              HttpClientRequest.setHeader("User-Agent", "@cvr/skills"),
            ),
          )
          return yield* client.execute(request).pipe(
            Effect.flatMap(decodeContents),
            Effect.mapError(
              (cause) => new FetchError({ url: `github:${owner}/${repo}/${path}`, cause }),
            ),
            Effect.withSpan("GitHubHttp.listContents", { attributes: { owner, repo, path, ref } }),
          )
        }),
        fetchRaw: Effect.fn("GitHubHttp.fetchRaw")(function* (
          owner: string,
          repo: string,
          path: string,
          ref = "main",
        ) {
          const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`
          const request = yield* withAuth(
            HttpClientRequest.get(url).pipe(
              HttpClientRequest.setHeader("User-Agent", "@cvr/skills"),
            ),
          )
          const response = yield* client
            .execute(request)
            .pipe(
              Effect.mapError(
                (cause) => new FetchError({ url: `github:${owner}/${repo}/${path}`, cause }),
              ),
            )
          return yield* response.text.pipe(
            Effect.mapError(
              (cause) => new FetchError({ url: `github:${owner}/${repo}/${path}`, cause }),
            ),
            Effect.withSpan("GitHubHttp.fetchRaw", { attributes: { owner, repo, path, ref } }),
          )
        }),
      })
    }),
  )
}

export class GitHub extends Context.Tag("@skills/GitHub")<GitHub, GitHubShape>() {
  static readonly Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const cli = yield* GitHubCli
      const http = yield* GitHubHttp
      const hasExplicitToken = yield* http.hasExplicitToken()
      const ghAvailable = yield* cli.isAvailable()

      const transport = !hasExplicitToken && ghAvailable ? cli : http

      return GitHub.of({
        listContents: (owner, repo, path, ref) =>
          transport.listContents(owner, repo, path, ref).pipe(
            Effect.withSpan("GitHub.listContents", {
              attributes: {
                owner,
                repo,
                path,
                ref,
                transport: !hasExplicitToken && ghAvailable ? "gh" : "http",
              },
            }),
          ),
        fetchRaw: (owner, repo, path, ref) =>
          transport.fetchRaw(owner, repo, path, ref).pipe(
            Effect.withSpan("GitHub.fetchRaw", {
              attributes: {
                owner,
                repo,
                path,
                ref,
                transport: !hasExplicitToken && ghAvailable ? "gh" : "http",
              },
            }),
          ),
      })
    }),
  ).pipe(Layer.provideMerge(GitHubCli.Live), Layer.provideMerge(GitHubHttp.Live))

  static readonly Test = (implementation: GitHubShape) => Layer.succeed(this, implementation)
}

export interface SkillFile {
  readonly path: string
  readonly content: string
}

export interface SkillEntry {
  readonly dirName: string
  readonly skillMdPath: string
  readonly skillDir: string
}

export const listContents = (
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Effect.Effect<ReadonlyArray<GitHubContentEntry>, FetchError, GitHub> =>
  Effect.flatMap(GitHub, (github) => github.listContents(owner, repo, path, ref))

export const fetchRaw = (
  owner: string,
  repo: string,
  path: string,
  ref = "main",
): Effect.Effect<string, FetchError, GitHub> =>
  Effect.flatMap(GitHub, (github) => github.fetchRaw(owner, repo, path, ref))

const SKILL_DIRS = ["skills", "skill"] as const

export const discoverSkills = Effect.fn("GitHub.discoverSkills")(
  function* (owner: string, repo: string, ref?: string) {
    const skills: Array<SkillEntry> = []

    for (const skillsDir of SKILL_DIRS) {
      const entries = yield* listContents(owner, repo, skillsDir, ref).pipe(
        Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<GitHubContentEntry>)),
      )
      const dirs = entries.filter((entry) => entry.type === "dir")

      for (const dir of dirs) {
        const children = yield* listContents(owner, repo, dir.path, ref).pipe(
          Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<GitHubContentEntry>)),
        )
        if (children.some((child) => child.name === "SKILL.md")) {
          skills.push({
            dirName: dir.name,
            skillMdPath: `${dir.path}/SKILL.md`,
            skillDir: dir.path,
          })
        }
      }

      if (skills.length > 0) break
    }

    if (skills.length === 0) {
      const rootEntries = yield* listContents(owner, repo, "", ref).pipe(
        Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<GitHubContentEntry>)),
      )
      if (rootEntries.some((entry) => entry.name === "SKILL.md")) {
        skills.push({
          dirName: repo,
          skillMdPath: "SKILL.md",
          skillDir: "",
        })
      }
    }

    return skills
  },
  (effect, owner, repo, ref) =>
    Effect.withSpan(effect, "GitHub.discoverSkills", { attributes: { owner, repo, ref } }),
)

export const fetchSkillDir = Effect.fn("GitHub.fetchSkillDir")(
  function* (owner: string, repo: string, dirPath: string, ref = "main") {
    const files: Array<SkillFile> = []

    const walk = (path: string): Effect.Effect<void, FetchError, GitHub> =>
      Effect.gen(function* () {
        const entries = yield* listContents(owner, repo, path, ref)
        for (const entry of entries) {
          if (entry.type === "file") {
            const content = yield* fetchRaw(owner, repo, entry.path, ref)
            const relativePath = dirPath ? entry.path.slice(dirPath.length + 1) : entry.path
            files.push({ path: relativePath, content })
            continue
          }

          if (entry.type === "dir") {
            yield* walk(entry.path)
          }
        }
      })

    yield* walk(dirPath)

    return files
  },
  (effect, owner, repo, dirPath, ref) =>
    Effect.withSpan(effect, "GitHub.fetchSkillDir", { attributes: { owner, repo, dirPath, ref } }),
)
