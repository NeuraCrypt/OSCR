// The GraphQL documents the adapter sends: the operations GitHub's REST API does not have
// (https://docs.github.com/en/graphql/reference/mutations, re-read on 2026-09-28):
// createCommitOnBranch, blame, review threads and their resolution, the draft toggle, auto-merge,
// reverting a pull request, transferring and pinning an issue.
//
// Every query asks for `name` and `user`, never for `email`.

const COMMIT_FIELDS = `oid committedDate authoredDate message parents(first: 2) { nodes { oid } } tree { oid }
  author { name user { login databaseId } } committer { name user { login databaseId } } signature { isValid }`;

export const CREATE_COMMIT = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid tree { oid } parents(first: 2) { nodes { oid } } }
    ref { name repository { databaseId nameWithOwner } }
  }
}`;

export const BLAME = `query($owner: String!, $name: String!, $rev: String!, $path: String!) {
  repository(owner: $owner, name: $name) { object(expression: $rev) { ... on Commit {
    blame(path: $path) { ranges { startingLine endingLine commit { ${COMMIT_FIELDS} } } } } } }
}`;

const THREAD_FIELDS = `id isResolved isOutdated path line
  comments(first: 100) { nodes { databaseId path line startLine diffSide body createdAt updatedAt
    author { login ... on User { databaseId } ... on Bot { databaseId } }
    commit { oid } originalCommit { oid } pullRequestReview { databaseId } replyTo { databaseId } } }`;

export const THREADS = `query($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: $first, after: $after) { nodes { ${THREAD_FIELDS} } pageInfo { hasNextPage endCursor } } } }
}`;

export const RESOLVE_THREAD = `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { ${THREAD_FIELDS} } } }`;
export const UNRESOLVE_THREAD = `mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { ${THREAD_FIELDS} } } }`;

export const READY_FOR_REVIEW = `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`;
export const CONVERT_TO_DRAFT = `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`;

export const ENABLE_AUTO_MERGE = `mutation($id: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $head }) {
    pullRequest { autoMergeRequest { mergeMethod } } }
}`;
export const DISABLE_AUTO_MERGE = `mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { autoMergeRequest { mergeMethod } } } }`;

export const REVERT_PULL = `mutation($input: RevertPullRequestInput!) {
  revertPullRequest(input: $input) { revertPullRequest { number } }
}`;

export const TRANSFER_ISSUE = `mutation($issue: ID!, $repo: ID!) { transferIssue(input: { issueId: $issue, repositoryId: $repo }) { issue { number } } }`;

export const PIN_ISSUE = `mutation($id: ID!) { pinIssue(input: { issueId: $id }) { issue { isPinned } } }`;
export const UNPIN_ISSUE = `mutation($id: ID!) { unpinIssue(input: { issueId: $id }) { issue { isPinned } } }`;

/** `data.a.b.c`, or undefined. */
export function dig(data: unknown, ...keys: string[]): unknown {
  let v = data;
  for (const k of keys) {
    if (!v || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}
