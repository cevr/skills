import { Argument, Command, Flag } from "effect/unstable/cli"
import { Console, Effect, Option, Path } from "effect"
import { SkillStore } from "./services/SkillStore.js"
import { SkillLock } from "./services/SkillLock.js"
import { runSearch } from "./commands/search.js"
import { runAdd } from "./commands/add.js"
import { runRemove } from "./commands/remove.js"
import { runUpdate } from "./commands/update.js"
import type {
  FetchError,
  LockFileError,
  NoSkillsFoundError,
  SearchError,
  SkillNotFoundError,
} from "./lib/errors.js"

const exitCodeForTag = (tag: string): number => {
  switch (tag) {
    case "SkillNotFoundError":
    case "NoSkillsFoundError":
      return 2
    case "LockFileError":
      return 3
    case "FetchError":
    case "SearchError":
      return 4
    default:
      return 1
  }
}

type AppError = SkillNotFoundError | NoSkillsFoundError | FetchError | SearchError | LockFileError

// S3: Per-stream TTY checks
const stdoutColor = process.stdout.isTTY && !process.env["NO_COLOR"]
const stderrColor = process.stderr.isTTY && !process.env["NO_COLOR"]
const dim = (s: string) => (stdoutColor ? `\x1b[2m${s}\x1b[0m` : s)
const bold = (s: string) => (stdoutColor ? `\x1b[1m${s}\x1b[0m` : s)

const truncate = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s)

// S2: Typed error formatting (uses stderrColor since errors go to stderr)
const formatError = (e: AppError) => {
  const errorDim = (s: string) => (stderrColor ? `\x1b[2m${s}\x1b[0m` : s)
  const lines: Array<string> = [`Error: ${e.message}`, ""]

  switch (e._tag) {
    case "SkillNotFoundError":
      lines.push(errorDim("Run 'skills' to see installed skills."))
      break
    case "NoSkillsFoundError":
      break
    case "FetchError":
      lines.push(errorDim("Check the source and your network connection."))
      lines.push(errorDim("For private repos, set GITHUB_TOKEN."))
      break
    case "SearchError":
      lines.push(errorDim("Check your network connection and try again."))
      break
    case "LockFileError":
      lines.push(errorDim("The lock file may be corrupted. Delete it and re-add skills:"))
      lines.push(errorDim("  rm <skills-dir>/.skill-lock.json"))
      break
  }

  return Effect.forEach(lines, (line) => Console.error(line)).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = exitCodeForTag(e._tag)
      }),
    ),
  )
}

// S2: Typed catchTags instead of untyped Effect.catch
const handleErrors = <A, R>(effect: Effect.Effect<A, AppError, R>) =>
  effect.pipe(
    Effect.catchTags({
      SkillNotFoundError: formatError,
      NoSkillsFoundError: formatError,
      FetchError: formatError,
      SearchError: formatError,
      LockFileError: formatError,
    }),
  )

const skillsCommand = Command.make("skills", {}, () =>
  Effect.gen(function* () {
    const store = yield* SkillStore
    const lock = yield* SkillLock
    const pathService = yield* Path.Path
    const [skills, lockFile] = yield* Effect.all([store.list, lock.read])

    const managed = skills.filter((s) => pathService.basename(s.dirPath) in lockFile.skills)
    const unmanagedCount = skills.length - managed.length

    if (managed.length === 0 && unmanagedCount === 0) {
      yield* Console.log("No skills installed.")
      yield* Console.log("")
      yield* Console.log("Install skills:")
      yield* Console.log("  skills add <owner/repo>")
      yield* Console.log("  skills add <owner/repo@skill-name>")
      yield* Console.log("  skills search <query>")
      return
    }

    if (managed.length === 0) {
      yield* Console.log("No managed skills.")
    } else {
      yield* Console.log(`${bold(`${managed.length} skill(s) managed`)}\n`)
      for (const skill of managed) {
        yield* Console.log(`  ${bold(skill.name)}`)
        if (skill.description) {
          yield* Console.log(`  ${dim(truncate(skill.description, 80))}`)
        }
        yield* Console.log("")
      }
    }

    if (unmanagedCount > 0) {
      yield* Console.log(dim(`(${unmanagedCount} unmanaged)`))
    }
  }).pipe(handleErrors, Effect.withSpan("command.list")),
)

const sourceArg = Argument.string("source").pipe(Argument.optional)
const queryArg = Argument.string("query")
const nameArg = Argument.string("name")

const skillOption = Flag.string("skill").pipe(
  Flag.withAlias("s"),
  Flag.withDescription("Install a specific skill from a multi-skill repo"),
  Flag.optional,
)

const ADD_DESCRIPTION = `Install a skill from GitHub, search query, or local path

Examples:
  skills add owner/repo          # all skills from repo
  skills add owner/repo@name     # specific skill
  skills add .                   # from current directory
  skills add ~/path/to/skill     # from local path`

const addCommand = Command.make(
  "add",
  { source: sourceArg, skill: skillOption },
  ({ source, skill }) =>
    handleErrors(runAdd(Option.getOrUndefined(source), Option.getOrUndefined(skill))),
).pipe(Command.withDescription(ADD_DESCRIPTION))

const searchCommand = Command.make("search", { query: queryArg }, ({ query }) =>
  handleErrors(runSearch(query)),
).pipe(Command.withDescription("Search skills.sh for skills"))

const removeCommand = Command.make("remove", { name: nameArg }, ({ name }) =>
  handleErrors(runRemove(name)),
).pipe(Command.withDescription("Remove an installed skill"))

const updateCommand = Command.make("update", {}, () => handleErrors(runUpdate())).pipe(
  Command.withDescription("Re-fetch all installed skills from their sources"),
)

const command = skillsCommand.pipe(
  Command.withSubcommands([addCommand, searchCommand, removeCommand, updateCommand]),
)

export const runCli = Command.run(command, {
  version: "0.1.0",
})
