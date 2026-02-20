import { Data } from "effect"

export class SkillNotFoundError extends Data.TaggedError("SkillNotFoundError")<{
  readonly name: string
}> {
  override get message() {
    return `Skill not found: ${this.name}`
  }
}

export class FetchError extends Data.TaggedError("FetchError")<{
  readonly url: string
  readonly cause?: unknown
}> {
  override get message() {
    return `Failed to fetch: ${this.url}`
  }
}

export class SourceParseError extends Data.TaggedError("SourceParseError")<{
  readonly input: string
}> {
  override get message() {
    return `Could not parse source: ${this.input}`
  }
}

export class SearchError extends Data.TaggedError("SearchError")<{
  readonly query: string
  readonly cause?: unknown
}> {
  override get message() {
    return `Search failed for: ${this.query}`
  }
}

export class LockFileError extends Data.TaggedError("LockFileError")<{
  readonly cause?: unknown
}> {
  override get message() {
    return "Failed to read or write skill lock file"
  }
}
