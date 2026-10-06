"""The GitHub side's retention (night phase 16; oscr/retention.py): what the privacy statement keeps for
a time only is deleted each night, by key, within a budget; the rest stays."""
from oscr import retention

T = 1_790_596_800
DAY = 86_400


def _seed(d1) -> None:
    old, recent = T - 100 * DAY, T - 10 * DAY
    d1.run([
        f"INSERT INTO events (subject, at, nonce, kind, url) VALUES ('repo:github:1', {old}, 'n-old-0001', 'issue_opened', '/r/a/b/'), "
        f"('repo:github:1', {recent}, 'n-new-0001', 'issue_opened', '/r/a/b/')",
        f"INSERT INTO notice_state (user_id, thread, saved, at) VALUES ('u', 'repo:github:1#issue:1', 0, {old}), "
        f"('u', 'repo:github:1#issue:2', 1, {old}), ('u', 'repo:github:1#issue:3', 0, {recent})",
        f"INSERT INTO hooks (user_id, id, subject, url, salt, created_at, updated_at) VALUES ('u', 'hhhhhhhhhhhhhhhh', 'repo:github:1', 'https://h.example/x', 'ssssssssssssssss', {T}, {T})",
        f"INSERT INTO hook_deliveries (day, hook_id, at, guid, event, ok) VALUES ({(T - 9 * DAY) // DAY}, 'hhhhhhhhhhhhhhhh', {T - 9 * DAY}, '{'a' * 36}', 'ping', 1), "
        f"({(T - DAY) // DAY}, 'hhhhhhhhhhhhhhhh', {T - DAY}, '{'b' * 36}', 'ping', 1), ({(T - DAY) // DAY}, 'gone-gone-gone-g', {T - DAY}, '{'c' * 36}', 'ping', 1)",
        f"INSERT INTO api_tokens (digest, id, user_id, name, scopes, created_at, expires_at) VALUES ('{'1' * 64}', 'aaaaaaaaaaaaaaaa', 'u', 'old', 'research:read', {T - 400 * DAY}, {T - 40 * DAY}), "
        f"('{'2' * 64}', 'bbbbbbbbbbbbbbbb', 'u', 'fresh', 'research:read', {T - 10 * DAY}, {T + 10 * DAY})",
        f"INSERT INTO interaction_limits (scope, level, until, by_user, at) VALUES ('account:u', 'managers', {T - 1}, 'u', {T - DAY}), ('account:v', 'managers', {T + DAY}, 'v', {T})",
        f"INSERT INTO content_reports (day, at, kind, target, reason, state, decided_at) VALUES ({(T - 400 * DAY) // DAY}, {T - 400 * DAY}, 'repo', 'repo:github:1', 'spam', 'dismissed', {T - 390 * DAY}), "
        f"({(T - 400 * DAY) // DAY}, {T - 400 * DAY}, 'repo', 'repo:github:2', 'spam', 'open', NULL)",
        # Night phase 14: a sign-in decided three days ago goes; today's stays.
        "INSERT INTO device_grants (day, ref, user_id, scopes, days, name, state, decided_at, expires_at) VALUES "
        f"({T // DAY - 3}, '{'a' * 64}', 'u', 'repos:read', 30, 'Command line', 'collected', {T - 3 * DAY}, {T - 3 * DAY + 900}), "
        f"({T // DAY}, '{'b' * 64}', 'u', 'repos:read', 30, 'Command line', 'approved', {T}, {T + 900})",
    ])


def test_what_is_past_its_time_goes_and_the_rest_stays(forge_d1):
    _seed(forge_d1)
    said = retention.run(forge_d1, now=T)
    assert "1 events past 3 months" in said
    q = forge_d1.query
    assert [r["nonce"] for r in q("SELECT nonce FROM events")] == ["n-new-0001"]
    assert sorted(r["thread"] for r in q("SELECT thread FROM notice_state")) == ["repo:github:1#issue:2", "repo:github:1#issue:3"], "a saved thread stays"
    assert [r["guid"][0] for r in q("SELECT guid FROM hook_deliveries")] == ["b"], "past 7 days, and a deleted hook's, go"
    assert [r["name"] for r in q("SELECT name FROM api_tokens")] == ["fresh"]
    assert [r["scope"] for r in q("SELECT scope FROM interaction_limits")] == ["account:v"]
    assert [r["state"] for r in q("SELECT state FROM content_reports")] == ["open"], "an open report is never deleted"
    assert [r["ref"][0] for r in q("SELECT ref FROM device_grants")] == ["b"], "a sign-in past its day goes"
    assert retention.run(forge_d1, now=T) == "retention: nothing past its time"


def test_the_budget_bounds_a_night(forge_d1):
    forge_d1.run(["INSERT INTO events (subject, at, nonce, kind, url) VALUES " + ", ".join(
        f"('repo:github:1', {T - 100 * DAY + i}, 'n-{i:08d}', 'issue_opened', '/x')" for i in range(30))])
    said = retention.run(forge_d1, budget=12, now=T)
    assert "12 events" in said and "tomorrow" in said
    assert forge_d1.query("SELECT count(*) AS n FROM events")[0]["n"] == 18
