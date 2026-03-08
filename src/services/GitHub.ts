import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Config, Effect, Layer, Option, Schema, ServiceMap } from "effect"
import { FetchError } from "../lib/errors.js"
import { DEFAULT_REF, SKILL_DIR_PREFIXES } from "../lib/constants.js"

const GitHubContentEntrySchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  type: Schema.Literals(["file", "dir", "symlink", "submodule"]),
})

const GitHubContentsArraySchema = Schema.Array(GitHubContentEntrySchema)

type GitHubContentEntry = typeof GitHubContentEntrySchema.Type

const decodeContents = HttpClientResponse.schemaBodyJson(GitHubContentsArraySchema)
const decodeContentsJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GitHubContentsArraySchema),
)
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

export class GitHubCli extends ServiceMap.Service<GitHubCli, GitHubCliShape>()(
  "@skills/GitHubCli",
) {
  static readonly layer = Layer.sync(this, () => {
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
      ref = DEFAULT_REF,
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

export class GitHubHttp extends ServiceMap.Service<GitHubHttp, GitHubHttpShape>()(
  "@skills/GitHubHttp",
) {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)

      const withAuth = Effect.fn("GitHubHttp.withAuth")(function* (
        request: HttpClientRequest.HttpClientRequest,
      ) {
        const token = yield* Effect.orDie(
          Effect.gen(function* () {
            return yield* githubToken
          }),
        )
        return Option.match(token, {
          onNone: () => request,
          onSome: (value) =>
            HttpClientRequest.setHeader("Authorization", `token ${value}`)(request),
        })
      })

      return GitHubHttp.of({
        hasExplicitToken: () =>
          Effect.gen(function* () {
            return Option.isSome(yield* githubToken)
          }).pipe(Effect.orDie),
        listContents: Effect.fn("GitHubHttp.listContents")(function* (
          owner: string,
          repo: string,
          path: string,
          ref?: string,
        ) {
          const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeRepoPath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`
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
          ref = DEFAULT_REF,
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

export class GitHub extends ServiceMap.Service<GitHub, GitHubShape>()("@skills/GitHub") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const cli = yield* GitHubCli
      const http = yield* GitHubHttp

      const resolveTransport = yield* Effect.cached(
        Effect.gen(function* () {
          const hasExplicitToken = yield* http.hasExplicitToken()
          const ghAvailable = yield* cli.isAvailable()
          return {
            transport: (!hasExplicitToken && ghAvailable ? cli : http) as GitHubShape,
            label: !hasExplicitToken && ghAvailable ? "gh" : "http",
          }
        }),
      )

      return GitHub.of({
        listContents: (owner, repo, path, ref) =>
          resolveTransport.pipe(
            Effect.flatMap(({ transport, label }) =>
              transport.listContents(owner, repo, path, ref).pipe(
                Effect.withSpan("GitHub.listContents", {
                  attributes: { owner, repo, path, ref, transport: label },
                }),
              ),
            ),
          ),
        fetchRaw: (owner, repo, path, ref) =>
          resolveTransport.pipe(
            Effect.flatMap(({ transport, label }) =>
              transport.fetchRaw(owner, repo, path, ref).pipe(
                Effect.withSpan("GitHub.fetchRaw", {
                  attributes: { owner, repo, path, ref, transport: label },
                }),
              ),
            ),
          ),
      })
    }),
  ).pipe(Layer.provideMerge(GitHubCli.layer), Layer.provideMerge(GitHubHttp.layer))

  static readonly layerTest = (implementation: GitHubShape) => Layer.succeed(this, implementation)
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
  Effect.gen(function* () {
    const github = yield* GitHub
    return yield* github.listContents(owner, repo, path, ref)
  })

export const fetchRaw = (
  owner: string,
  repo: string,
  path: string,
  ref = DEFAULT_REF,
): Effect.Effect<string, FetchError, GitHub> =>
  Effect.gen(function* () {
    const github = yield* GitHub
    return yield* github.fetchRaw(owner, repo, path, ref)
  })

export const discoverSkills = Effect.fn("GitHub.discoverSkills")(function* (
  owner: string,
  repo: string,
  ref?: string,
) {
  const skills: Array<SkillEntry> = []

  for (const skillsDir of SKILL_DIR_PREFIXES) {
    const entries = yield* listContents(owner, repo, skillsDir, ref).pipe(
      Effect.catchTag("FetchError", () => Effect.succeed([] as ReadonlyArray<GitHubContentEntry>)),
    )
    const dirs = entries.filter((entry) => entry.type === "dir")

    yield* Effect.forEach(
      dirs,
      (dir) =>
        listContents(owner, repo, dir.path, ref).pipe(
          Effect.catchTag("FetchError", () =>
            Effect.succeed([] as ReadonlyArray<GitHubContentEntry>),
          ),
          Effect.tap((children) => {
            if (children.some((child) => child.name === "SKILL.md")) {
              skills.push({
                dirName: dir.name,
                skillMdPath: `${dir.path}/SKILL.md`,
                skillDir: dir.path,
              })
            }
            return Effect.void
          }),
        ),
      { concurrency: "unbounded" },
    )

    if (skills.length > 0) break
  }

  if (skills.length === 0) {
    const rootEntries = yield* listContents(owner, repo, "", ref).pipe(
      Effect.catchTag("FetchError", () => Effect.succeed([] as ReadonlyArray<GitHubContentEntry>)),
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
})

export const fetchSkillDir = Effect.fn("GitHub.fetchSkillDir")(function* (
  owner: string,
  repo: string,
  dirPath: string,
  ref = DEFAULT_REF,
) {
  const fileEntries: Array<{ path: string; relativePath: string }> = []

  const walk = (path: string): Effect.Effect<void, FetchError, GitHub> =>
    Effect.gen(function* () {
      const entries = yield* listContents(owner, repo, path, ref)
      for (const entry of entries) {
        if (entry.type === "file") {
          const relativePath = dirPath ? entry.path.slice(dirPath.length + 1) : entry.path
          fileEntries.push({ path: entry.path, relativePath })
        } else if (entry.type === "dir") {
          yield* walk(entry.path)
        }
      }
    })

  yield* walk(dirPath)

  return yield* Effect.forEach(
    fileEntries,
    (entry) =>
      fetchRaw(owner, repo, entry.path, ref).pipe(
        Effect.map((content) => ({ path: entry.relativePath, content })),
      ),
    { concurrency: 5 },
  )
})
