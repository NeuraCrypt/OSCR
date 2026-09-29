"""The GitHub side's retention (night phase 16; docs/POLICIES.md "How long"; DECISIONS.md D08-17,
D10-14, D16-14).

The Worker writes; the Mac deletes what the privacy statement says is kept for a time only, each night,
within a budget of rows (every deletion is a row written for D1, and a table's index entries count too):

- the events of the inbox and the feed past 3 months (``events``), and the notification states of
  threads past 3 months that were not saved (``notice_state``): a saved thread keeps its words;
- the deliveries of outgoing webhooks past 7 days (``hook_deliveries``), and those of a deleted
  webhook at once;
- personal tokens expired for 30 days (``api_tokens``: the settings page says "expired" meanwhile);
- interaction limits past their end (``interaction_limits``);
- reports decided more than a year ago (``content_reports``), and data-rights requests answered more
  than three years ago (``rights_requests``: the proof that a request was answered).

The moderation decisions themselves (``moderation``) are kept, restored or not: their notices are
public, and a decision can be appealed. Nothing here runs anything, reads GitHub, or writes
elsewhere. Every deletion names rows by their key, a bounded number at a time (``LIMIT``).
"""
from __future__ import annotations

import time
from dataclasses import dataclass

from . import community

DAY = 86_400
PAGE = 500


@dataclass(frozen=True)
class Rule:
    table: str
    key: str            # the key's columns, for the row-value deletion
    where: str          # with {now}, {day} (UTC day), as SQL
    why: str
    rows_each: int = 1  # rows written per deletion (the row, and its index entries)


RULES: tuple[Rule, ...] = (
    Rule("events", "subject, at, nonce", "at < {now} - 90 * 86400", "events past 3 months"),
    Rule("notice_state", "user_id, thread", "saved = 0 AND at < {now} - 90 * 86400", "notification states past 3 months, not saved"),
    Rule("hook_deliveries", "day, hook_id, at, guid", "day < {day} - 7", "webhook deliveries past 7 days"),
    Rule("hook_deliveries", "day, hook_id, at, guid", "day >= {day} - 7 AND hook_id NOT IN (SELECT id FROM hooks)", "deliveries of deleted webhooks"),
    Rule("api_tokens", "digest", "expires_at < {now} - 30 * 86400", "tokens expired for 30 days", rows_each=2),
    Rule("interaction_limits", "scope", "until < {now}", "interaction limits past their end"),
    Rule("content_reports", "id", "state != 'open' AND decided_at < {now} - 365 * 86400", "reports decided more than a year ago"),
    Rule("rights_requests", "user_id, id", "state != 'open' AND answered_at < {now} - 3 * 365 * 86400", "data-rights requests answered more than 3 years ago"),
)


def run(d1: community.D1, *, budget: int = 2_000, now: float | None = None) -> str:
    """Delete what is past its time, within ``budget`` rows written; returns what it did, in words."""
    t = int(time.time() if now is None else now)
    fill = {"now": t, "day": t // DAY}
    left = budget
    said: list[str] = []
    deferred = False
    for rule in RULES:
        where = rule.where.format(**fill)
        done = 0
        while left >= rule.rows_each:
            n = min(PAGE, left // rule.rows_each)
            try:
                keys = d1.query(f"SELECT {rule.key} FROM {rule.table} WHERE {where} LIMIT {n}")
            except community.D1Error as e:
                if "no such table" in str(e) or "no such column" in str(e):
                    break  # an older oscr_forge: nothing of it to keep or delete
                raise
            if not keys:
                break
            cols = [c.strip() for c in rule.key.split(",")]
            values = ", ".join("(" + ", ".join(community.literal(k[c]) for c in cols) + ")" for k in keys)
            d1.run([f"DELETE FROM {rule.table} WHERE ({rule.key}) IN (VALUES {values})"])
            done += len(keys)
            left -= len(keys) * rule.rows_each
            if len(keys) < n:
                break
        else:
            deferred = True
        if done:
            said.append(f"{done} {rule.why}")
    summary = "; ".join(said) if said else "nothing past its time"
    return f"retention: {summary}" + ("; the rest waits for tomorrow's budget" if deferred else "")
