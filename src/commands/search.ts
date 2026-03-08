import { Console, Effect } from "effect"
import { HttpClient } from "@effect/platform"
import { search } from "../lib/search-api.js"
import { NoSkillsFoundError, type SearchError } from "../lib/errors.js"

export const runSearch = (
  query: string,
): Effect.Effect<void, SearchError | NoSkillsFoundError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const result = yield* search(query)

    if (result.skills.length === 0) {
      return yield* new NoSkillsFoundError({ message: `No skills found for "${query}"` })
    }

    yield* Console.log(`Found ${result.count} skill(s) for "${query}":\n`)

    for (const skill of result.skills) {
      const installs = skill.installs.toLocaleString()
      yield* Console.log(`  ${skill.name}`)
      yield* Console.log(`    source: ${skill.source}`)
      yield* Console.log(`    installs: ${installs}`)
      yield* Console.log("")
    }

    yield* Console.log("Install with:")
    yield* Console.log(`  skills add <source>@<skill-name>`)
  }).pipe(Effect.withSpan("command.search", { attributes: { query } }))
