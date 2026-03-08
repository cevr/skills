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
    return `Failed to fetch: ${this.url}${this.cause ? ` (${String(this.cause)})` : ""}`
  }
}

export class NoSkillsFoundError extends Data.TaggedError("NoSkillsFoundError")<{
  readonly message: string
}> {}

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
