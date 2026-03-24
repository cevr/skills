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

const GitHubTreeEntrySchema = Schema.Struct({
  path: Schema.String,
  type: Schema.Literals(["blob", "tree"]),
  sha: Schema.String,
})

const GitHubTreeResponseSchema = Schema.Struct({
  tree: Schema.Array(GitHubTreeEntrySchema),
  truncated: Schema.Boolean,
})

const decodeContents = HttpClientResponse.schemaBodyJson(GitHubContentsArraySchema)
const decodeContentsJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GitHubContentsArraySchema),
)
const decodeTreeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubTreeResponseSchema))
const githubToken = Config.option(Config.string("GITHUB_TOKEN"))

export interface SkillFile {
  readonly path: string
  readonly content: string
}

export interface SkillEntry {
  readonly dirName: string
  readonly skillMdPath: string
  readonly skillDir: string
}

// E3: All effectful GitHub operations live in the service
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
  readonly listTree: (
    owner: string,
    repo: string,
    ref: string,
  ) => Effect.Effect<
    {
      tree: ReadonlyArray<{ path: string; type: "blob" | "tree"; sha: string }>
      truncated: boolean
    },
    FetchError
  >
  readonly discoverSkills: (
    owner: string,
    repo: string,
    ref?: string,
  ) => Effect.Effect<ReadonlyArray<SkillEntry>, FetchError>
  readonly fetchSkillDir: (
    owner: string,
    repo: string,
    dirPath: string,
    ref?: string,
  ) => Effect.Effect<ReadonlyArray<SkillFile>, FetchError>
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

const treeEndpoint = (owner: string, repo: string, ref: string) =>
  `repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`

// P3: Tree-based discovery — filter for SKILL.md paths matching known prefixes
const discoverFromTree = (
  tree: ReadonlyArray<{ path: string; type: "blob" | "tree" }>,
): ReadonlyArray<SkillEntry> => {
  const skills: Array<SkillEntry> = []

  for (const prefix of SKILL_DIR_PREFIXES) {
    const pattern = new RegExp(`^${prefix}/([^/]+)/SKILL\\.md$`)
    for (const entry of tree) {
      if (entry.type !== "blob") continue
      const match = entry.path.match(pattern)
      const dirName = match?.[1]
      if (dirName) {
        skills.push({
          dirName,
          skillMdPath: entry.path,
          skillDir: `${prefix}/${dirName}`,
        })
      }
    }
    if (skills.length > 0) return skills
  }

  // Check root-level children (e.g. grill-me/SKILL.md at repo root)
  const rootPattern = /^([^/]+)\/SKILL\.md$/
  for (const entry of tree) {
    if (entry.type !== "blob") continue
    const match = entry.path.match(rootPattern)
    const dirName = match?.[1]
    if (dirName) {
      skills.push({
        dirName,
        skillMdPath: entry.path,
        skillDir: dirName,
      })
    }
  }
  if (skills.length > 0) return skills

  // Check root SKILL.md (repo itself is a single skill)
  if (tree.some((e) => e.type === "blob" && e.path === "SKILL.md")) {
    return [{ dirName: "", skillMdPath: "SKILL.md", skillDir: "" }]
  }

  return skills
}

// B6: Build discovery from N+1 listing (fallback when tree is truncated)
const discoverFromListing = Effect.fn("GitHub.discoverFromListing")(function* (
  listContents: GitHubShape["listContents"],
  owner: string,
  repo: string,
  ref?: string,
) {
  for (const skillsDir of SKILL_DIR_PREFIXES) {
    const entries = yield* listContents(owner, repo, skillsDir, ref).pipe(
      Effect.catchTag("FetchError", () => Effect.succeed([] as ReadonlyArray<GitHubContentEntry>)),
    )
    const dirs = entries.filter((entry) => entry.type === "dir")

    // B6: Collect results from forEach instead of mutating shared array
    const results = yield* Effect.forEach(
      dirs,
      (dir) =>
        listContents(owner, repo, dir.path, ref).pipe(
          Effect.catchTag("FetchError", () =>
            Effect.succeed([] as ReadonlyArray<GitHubContentEntry>),
          ),
          Effect.map((children): ReadonlyArray<SkillEntry> => {
            if (children.some((child) => child.name === "SKILL.md")) {
              return [
                {
                  dirName: dir.name,
                  skillMdPath: `${dir.path}/SKILL.md`,
                  skillDir: dir.path,
                },
              ]
            }
            return []
          }),
        ),
      { concurrency: "unbounded" },
    )

    const skills = results.flat()
    if (skills.length > 0) return skills
  }

  // Check root-level children (e.g. grill-me/SKILL.md at repo root)
  const rootEntries = yield* listContents(owner, repo, "", ref).pipe(
    Effect.catchTag("FetchError", () => Effect.succeed([] as ReadonlyArray<GitHubContentEntry>)),
  )

  const rootDirs = rootEntries.filter((entry) => entry.type === "dir")
  if (rootDirs.length > 0) {
    const rootResults = yield* Effect.forEach(
      rootDirs,
      (dir) =>
        listContents(owner, repo, dir.path, ref).pipe(
          Effect.catchTag("FetchError", () =>
            Effect.succeed([] as ReadonlyArray<GitHubContentEntry>),
          ),
          Effect.map((children): ReadonlyArray<SkillEntry> => {
            if (children.some((child) => child.name === "SKILL.md")) {
              return [
                {
                  dirName: dir.name,
                  skillMdPath: `${dir.path}/SKILL.md`,
                  skillDir: dir.path,
                },
              ]
            }
            return []
          }),
        ),
      { concurrency: "unbounded" },
    )
    const rootSkills = rootResults.flat()
    if (rootSkills.length > 0) return rootSkills
  }

  // Check root SKILL.md (repo itself is a single skill)
  if (rootEntries.some((entry) => entry.name === "SKILL.md")) {
    return [{ dirName: repo, skillMdPath: "SKILL.md", skillDir: "" }]
  }

  return [] as ReadonlyArray<SkillEntry>
})

// Shared implementation for discoverSkills using tree API with listing fallback
const makeDiscoverSkills = (
  listContents: GitHubShape["listContents"],
  listTree: GitHubShape["listTree"],
): GitHubShape["discoverSkills"] =>
  Effect.fn("GitHub.discoverSkills")(function* (owner: string, repo: string, ref?: string) {
    const resolvedRef = ref ?? DEFAULT_REF

    // P3: Try tree API first (single call)
    const treeResult = yield* listTree(owner, repo, resolvedRef).pipe(Effect.option)

    if (treeResult._tag === "Some" && !treeResult.value.truncated) {
      return discoverFromTree(treeResult.value.tree)
    }

    // Fallback to N+1 listing
    return yield* discoverFromListing(listContents, owner, repo, ref)
  })

// Shared implementation for fetchSkillDir
const makeFetchSkillDir = (
  listContents: GitHubShape["listContents"],
  fetchRaw: GitHubShape["fetchRaw"],
): GitHubShape["fetchSkillDir"] =>
  Effect.fn("GitHub.fetchSkillDir")(function* (
    owner: string,
    repo: string,
    dirPath: string,
    ref = DEFAULT_REF,
  ) {
    const fileEntries: Array<{ path: string; relativePath: string }> = []

    const walk = (path: string): Effect.Effect<void, FetchError> =>
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

    // P3: Tree API via gh CLI
    const listTree = Effect.fn("GitHubCli.listTree")(function* (
      owner: string,
      repo: string,
      ref: string,
    ) {
      const endpoint = treeEndpoint(owner, repo, ref)
      const output = yield* run(["api", "-H", "Accept: application/vnd.github.v3+json", endpoint])
      return yield* decodeTreeJson(output).pipe(
        Effect.mapError(
          (cause) => new FetchError({ url: `github:${owner}/${repo}/tree/${ref}`, cause }),
        ),
        Effect.withSpan("GitHubCli.listTree", { attributes: { owner, repo, ref } }),
      )
    })

    const discoverSkills = makeDiscoverSkills(listContents, listTree)
    const fetchSkillDirImpl = makeFetchSkillDir(listContents, fetchRaw)

    return GitHubCli.of({
      run,
      isAvailable,
      listContents,
      fetchRaw,
      listTree,
      discoverSkills,
      fetchSkillDir: fetchSkillDirImpl,
    })
  })
}

export class GitHubHttp extends ServiceMap.Service<GitHubHttp, GitHubHttpShape>()(
  "@skills/GitHubHttp",
) {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)

      // E5: Resolve token eagerly in layer setup, not per-request
      const token = yield* githubToken

      const withAuth = (request: HttpClientRequest.HttpClientRequest) =>
        Option.match(token, {
          onNone: () => request,
          onSome: (value) =>
            HttpClientRequest.setHeader("Authorization", `token ${value}`)(request),
        })

      const listContents = Effect.fn("GitHubHttp.listContents")(function* (
        owner: string,
        repo: string,
        path: string,
        ref?: string,
      ) {
        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeRepoPath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`
        const request = withAuth(
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
      })

      const fetchRaw = Effect.fn("GitHubHttp.fetchRaw")(function* (
        owner: string,
        repo: string,
        path: string,
        ref = DEFAULT_REF,
      ) {
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`
        const request = withAuth(
          HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("User-Agent", "@cvr/skills")),
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
      })

      // P3: Tree API via HTTP
      const decodeTreeHttp = HttpClientResponse.schemaBodyJson(GitHubTreeResponseSchema)

      const listTree = Effect.fn("GitHubHttp.listTree")(function* (
        owner: string,
        repo: string,
        ref: string,
      ) {
        const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`
        const request = withAuth(
          HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeader("Accept", "application/vnd.github.v3+json"),
            HttpClientRequest.setHeader("User-Agent", "@cvr/skills"),
          ),
        )
        return yield* client.execute(request).pipe(
          Effect.flatMap(decodeTreeHttp),
          Effect.mapError(
            (cause) => new FetchError({ url: `github:${owner}/${repo}/tree/${ref}`, cause }),
          ),
          Effect.withSpan("GitHubHttp.listTree", { attributes: { owner, repo, ref } }),
        )
      })

      // E5: Token already resolved eagerly
      const hasExplicitToken = () => Effect.succeed(Option.isSome(token))

      const discoverSkills = makeDiscoverSkills(listContents, listTree)
      const fetchSkillDirImpl = makeFetchSkillDir(listContents, fetchRaw)

      return GitHubHttp.of({
        hasExplicitToken,
        listContents,
        fetchRaw,
        listTree,
        discoverSkills,
        fetchSkillDir: fetchSkillDirImpl,
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

      const delegate = <A>(
        op: (t: GitHubShape) => Effect.Effect<A, FetchError>,
        spanName: string,
        attrs: Record<string, unknown>,
      ): Effect.Effect<A, FetchError> =>
        resolveTransport.pipe(
          Effect.flatMap(({ transport, label }) =>
            op(transport).pipe(
              Effect.withSpan(spanName, { attributes: { ...attrs, transport: label } }),
            ),
          ),
        )

      return GitHub.of({
        listContents: (owner, repo, path, ref) =>
          delegate((t) => t.listContents(owner, repo, path, ref), "GitHub.listContents", {
            owner,
            repo,
            path,
            ref,
          }),
        fetchRaw: (owner, repo, path, ref) =>
          delegate((t) => t.fetchRaw(owner, repo, path, ref), "GitHub.fetchRaw", {
            owner,
            repo,
            path,
            ref,
          }),
        listTree: (owner, repo, ref) =>
          delegate((t) => t.listTree(owner, repo, ref), "GitHub.listTree", { owner, repo, ref }),
        discoverSkills: (owner, repo, ref) =>
          delegate((t) => t.discoverSkills(owner, repo, ref), "GitHub.discoverSkills", {
            owner,
            repo,
            ref,
          }),
        fetchSkillDir: (owner, repo, dirPath, ref) =>
          delegate((t) => t.fetchSkillDir(owner, repo, dirPath, ref), "GitHub.fetchSkillDir", {
            owner,
            repo,
            dirPath,
            ref,
          }),
      })
    }),
  ).pipe(Layer.provideMerge(GitHubCli.layer), Layer.provideMerge(GitHubHttp.layer))

  static readonly layerTest = (implementation: GitHubShape) => Layer.succeed(this, implementation)
}
