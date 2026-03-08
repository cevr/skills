import { Schema } from "effect"

export class SkillNotFoundError extends Schema.TaggedErrorClass<SkillNotFoundError>()(
  "SkillNotFoundError",
  { name: Schema.String },
) {
  override get message() {
    return `Skill not found: ${this.name}`
  }
}

export class FetchError extends Schema.TaggedErrorClass<FetchError>()("FetchError", {
  url: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {
  override get message() {
    return `Failed to fetch: ${this.url}${this.cause ? ` (${String(this.cause)})` : ""}`
  }
}

export class NoSkillsFoundError extends Schema.TaggedErrorClass<NoSkillsFoundError>()(
  "NoSkillsFoundError",
  { message: Schema.String },
) {}

export class SearchError extends Schema.TaggedErrorClass<SearchError>()("SearchError", {
  query: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {
  override get message() {
    return `Search failed for: ${this.query}`
  }
}

export class LockFileError extends Schema.TaggedErrorClass<LockFileError>()("LockFileError", {
  cause: Schema.optional(Schema.Unknown),
}) {
  override get message() {
    return "Failed to read or write skill lock file"
  }
}
