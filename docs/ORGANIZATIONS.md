# Organizations, teams, roles and account security (night phase 09)

OSCR's own layer over a lab, a group or a project, and a person's account security. It is the GitHub
side's phase 09 (see `docs/PLATFORM_PLAN.md` §15.6 and `docs/DECISIONS.md` D09-*). A lab's GitHub
organization is **linked, not replaced**: git rights on its repositories stay GitHub's, and OSCR never
asks GitHub for a write.

Everything here is new in `oscr_forge` (`migrations/d1-forge/0013_organizations.sql`), written by the
Worker, counted against the forge service's daily row share, logged in the action log, and never read
or written by the Mac. No email address is stored anywhere (every text column is checked for `@`); a
passkey keeps only a PUBLIC key.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /api/forge/orgs` | signed in | the reader's organizations and pending invitations |
| `GET /api/forge/org?handle=` or `?id=` | signed in | one organization's profile; `?export=members` gives the member list as CSV to a member |
| `POST /api/forge/org/create` | signed in | a new organization, the creator its owner |
| `POST /api/forge/org/update` | an owner | `settings`, `rename`, `archive`, `unarchive`, `delete`, `banner`, `domain` |
| `POST /api/forge/org/members` | signed in | `invite`, `revoke_invite`, `accept`, `decline`, `remove`, `reinstate`, `set_role`, `set_perms`, `set_visibility`, `leave` |
| `POST /api/forge/org/teams` | a manager | `create`, `member`, `remove_member`, `delete` |
| `GET /api/forge/org/audit` | an owner/moderator | the audit log, filters (`event`, `actor`, `since`), text search (`q`), export (`format=csv`) |
| `GET /api/forge/org/security` | an owner/moderator | phase 11's open alerts over the pinned repositories |
| `GET /api/forge/account/security` | signed in | sessions, identities, passkeys, the security log; `format=csv` exports the log |
| `POST /api/forge/account/sessions` | signed in | `revoke` (one), `revoke_others` |
| `POST /api/forge/account/identities` | signed in | `unlink` (never the last) |
| `POST /api/forge/account/passkey` | signed in | `register_options`, `register_verify`, `auth_options`, `auth_verify`, `rename`, `remove` |

Pages: `/organizations/` (the reader's organizations and invitations, and a create form) and
`/account/security/` (sessions, identities, passkeys and the security log), both science.css only.

## Who may write (the gate)

- The owner's and managers' writes (create, settings, rename, archive, delete, invite, remove,
  roles, research permissions, teams) are behind **FORGE_OPEN** (gate.ts: the registry's owner only
  until phase 16) and the member's role (`canManage` = owner; `canModerate` = owner or moderator).
- A person's own writes (accept or decline an invitation, set their own visibility, leave, revoke a
  session, unlink an identity, add, use, rename or remove a passkey) are **not** gated by FORGE_OPEN:
  you may always answer an invitation or secure your own account. They are held only by the account's
  caps (`orgs` 300 a day for organizations and teams, `security` 200 a day for account security) and
  the day's rows.

## Organizations

An organization has a handle (its address `/org/<handle>/`), a display name, a kind (lab, group,
department, institution, project, other), an optional ROR id, a public and a members-only README, a
picture, an announcement banner, pinned repositories, and a verified-domain claim. Rename changes the
handle (the old one is not reused); archive and a soft delete keep the row so the handle stays taken.

A **verified domain** is a CLAIM only: OSCR records the domain and a DNS TXT proof (`domain_proof`)
for the owner to publish; the DNS check runs on the Mac (it has the network), never from the Worker
(zero cost, no outside call), so the domain shows "pending" until the Mac confirms it.

## Membership, roles and research permissions

A membership has a role (owner, moderator, member), a visibility (a member may hide themselves from
non-members), and research permissions. An **invitation** names a person who already has an OSCR
account (by their OSCR user id, ORCID iD or GitHub id, each a key lookup), carries a role and research
permissions, and expires (30 days by default, 1 to 90 if asked). The invitee accepts or declines; the
owner may revoke a pending invitation, remove a member (the leaving checklist is returned), reinstate
a former member, change a role or research permissions. The **last owner** is protected: they cannot
be removed, demoted or leave.

**Research permissions** ride on a membership: `propose_map`, `flag_map`, `validate_map`,
`tie_release` decide who may propose, flag or validate a tracing map, or tie a release to a paper
version, for the organization's repositories. The store and the checks (`permsOf`) are in place;
binding them to each research route's repository is a small follow-up (D09-8).

## Teams

A team has an id (within the organization), a name, a description, a visibility (visible or secret)
and an optional parent (nesting). Its members are members of the organization, with a team role
(maintainer or member). A secret team is hidden from non-members.

## Privacy

Private membership and the members-only README are **private by construction**: a read of
`/api/forge/org` returns them only to a member, and no static org shard carries them (the signed-out
static profile page is deferred; a future shard applies the same filter, D09-3). A member marked
private is hidden from non-members, while members still see them.

## The audit log

`org_audit`, keyed `(org_id, at, nonce)`: one row per org-scoped write, in the same batch as its
action row. An owner or a moderator reads it newest first (a key range, the index walked backward on
`at`), with filters (event, actor, since), a text search over the target (within the key range, never
a scan), and an export as JSON or CSV. The organization **security overview** aggregates phase 11's
open alerts over the organization's pinned repositories, grouped by severity.

## Account security

- **Sessions**: listed from `oscr_community` (`account/session.ts`); revoke one or all the others is a
  true delete of the session row, so its cookie is then worth nothing. The current session is flagged.
- **Identities**: ORCID, GitHub and Google; unlink one (never the last). Unlinking clears the matching
  account handle; a later sign-in of another linked provider refreshes it.
- **Passkeys (WebAuthn)**: a step up for sensitive actions (sudo mode), not the first sign-in. The
  Worker verifies a registration and an assertion itself, with WebCrypto only (`webauthn-core.ts`): a
  minimal CBOR decoder, the COSE public key, the authenticator data, DER-to-raw ECDSA, the signature
  check. Only a PUBLIC key is kept (ES256 or RS256). The challenge lives in a server-signed,
  short-lived cookie bound to the session and the purpose, never in D1. Origin, challenge, rpId and
  the sign counter are checked; a counter that went backward is refused (clone detection). Sudo mode
  lasts 600 seconds, keyed by the session's hash.
- **The personal security log** records each event (a passkey added or removed, a session revoked, an
  identity unlinked, sudo entered) and exports as CSV.

## What it costs

Reads are a key or a key range (never a scan; the tests assert `scans` is empty). A create writes 5
rows (the organization and its index, the owner membership and its index, the audit row, the action
row); a membership change 3 to 5; a passkey 2 to 3; a session or identity change 1 to 2 in
`oscr_forge` plus the delete in `oscr_community`. Two new standalone caps keep org management and
account security out of the 100 authorized-action budget.

## Tests

`website/tests/forge-service/organizations.test.ts`, `members.test.ts`, `audit.test.ts`,
`account-security.test.ts`, `webauthn.test.ts` (with a test authenticator producing real ES256
signatures). End to end: `website/tests/forge-service/e2e-organizations.ts`, section 10 of
`e2e.sh` (create an organization, invite and remove a member, set a research permission, a
members-only README refused to a non-member then shown to a member, register and use a passkey, revoke
a session, export the audit log).
