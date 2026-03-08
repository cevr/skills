import { Argument, Command, Flag } from "effect/unstable/cli"
import { Console, Effect, Option } from "effect"
import { SkillStore } from "./services/SkillStore.js"
import { runSearch } from "./commands/search.js"
import { runAdd } from "./commands/add.js"
import { runRemove } from "./commands/remove.js"
import { runUpdate } from "./commands/update.js"

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

const handleError = (e: { readonly _tag: string; readonly message: string }) => {
  const lines: Array<string> = [`Error: ${e.message}`, ""]

  switch (e._tag) {
    case "SkillNotFoundError":
      lines.push("Run 'skills' to see installed skills.")
      break
    case "NoSkillsFoundError":
      break
    case "FetchError":
      lines.push("Check the source and your network connection.")
      lines.push("For private repos, set GITHUB_TOKEN.")
      break
    case "SearchError":
      lines.push("Check your network connection and try again.")
      break
    case "LockFileError":
      lines.push("The lock file may be corrupted. Delete it and re-add skills:")
      lines.push("  rm <skills-dir>/.skill-lock.json")
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

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s)
const bold = (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s)

const truncate = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s)

const skillsCommand = Command.make("skills", {}, () =>
  Effect.gen(function* () {
    const store = yield* SkillStore
    const skills = yield* store.list

    if (skills.length === 0) {
      yield* Console.log("No skills installed.")
      yield* Console.log("")
      yield* Console.log("Install skills:")
      yield* Console.log("  skills add <owner/repo>")
      yield* Console.log("  skills add <owner/repo@skill-name>")
      yield* Console.log("  skills search <query>")
      return
    }

    yield* Console.log(`${bold(`${skills.length} skill(s) installed`)}\n`)
    for (const skill of skills) {
      yield* Console.log(`  ${bold(skill.name)}`)
      if (skill.description) {
        yield* Console.log(`  ${dim(truncate(skill.description, 80))}`)
      }
      yield* Console.log("")
    }
  }).pipe(Effect.withSpan("command.list")),
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
    runAdd(Option.getOrUndefined(source), Option.getOrUndefined(skill)).pipe(
      Effect.catch(handleError),
    ),
).pipe(Command.withDescription(ADD_DESCRIPTION))

const searchCommand = Command.make("search", { query: queryArg }, ({ query }) =>
  runSearch(query).pipe(Effect.catch(handleError)),
).pipe(Command.withDescription("Search skills.sh for skills"))

const removeCommand = Command.make("remove", { name: nameArg }, ({ name }) =>
  runRemove(name).pipe(Effect.catch(handleError)),
).pipe(Command.withDescription("Remove an installed skill"))

const updateCommand = Command.make("update", {}, () =>
  runUpdate().pipe(Effect.catch(handleError)),
).pipe(Command.withDescription("Re-fetch all installed skills from their sources"))

const command = skillsCommand.pipe(
  Command.withSubcommands([addCommand, searchCommand, removeCommand, updateCommand]),
)

export const runCli = Command.run(command, {
  version: "0.1.0",
})
