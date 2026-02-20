export interface GitHubRepo {
  readonly _tag: "GitHubRepo"
  readonly owner: string
  readonly repo: string
  readonly ref?: string
  readonly subpath?: string
}

export interface GitHubRepoWithSkill {
  readonly _tag: "GitHubRepoWithSkill"
  readonly owner: string
  readonly repo: string
  readonly skillFilter: string
}

export interface SearchQuery {
  readonly _tag: "SearchQuery"
  readonly query: string
}

export type ParsedSource = GitHubRepo | GitHubRepoWithSkill | SearchQuery

// owner/repo@skill-name
const repoWithSkillRe = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)@(.+)$/

// owner/repo or owner/repo#ref or owner/repo/subpath
const repoRe = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(?:#([a-zA-Z0-9_./+-]+))?(?:\/(.+))?$/

// https://github.com/owner/repo/...
const githubUrlRe = /^https?:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/?(.*)$/

export const parseSource = (input: string): ParsedSource => {
  // owner/repo@skill-name
  const skillMatch = input.match(repoWithSkillRe)
  if (skillMatch) {
    return {
      _tag: "GitHubRepoWithSkill",
      owner: skillMatch[1]!,
      repo: skillMatch[2]!,
      skillFilter: skillMatch[3]!,
    }
  }

  // GitHub URL
  const urlMatch = input.match(githubUrlRe)
  if (urlMatch) {
    const rest = urlMatch[3] ?? ""
    // Extract ref and subpath from tree/ref/path or blob/ref/path
    const treeBlobMatch = rest.match(/^(?:tree|blob)\/([^/]+)(?:\/(.+))?$/)
    if (treeBlobMatch) {
      return {
        _tag: "GitHubRepo",
        owner: urlMatch[1]!,
        repo: urlMatch[2]!,
        ref: treeBlobMatch[1],
        subpath: treeBlobMatch[2],
      }
    }
    return {
      _tag: "GitHubRepo",
      owner: urlMatch[1]!,
      repo: urlMatch[2]!,
    }
  }

  // owner/repo with optional #ref and /subpath
  const repoMatch = input.match(repoRe)
  if (repoMatch) {
    return {
      _tag: "GitHubRepo",
      owner: repoMatch[1]!,
      repo: repoMatch[2]!,
      ref: repoMatch[3],
      subpath: repoMatch[4],
    }
  }

  // Fallback: treat as search query
  return { _tag: "SearchQuery", query: input }
}
