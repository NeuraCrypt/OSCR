"""Compare local models with the classification rules, on the owner's hand labels (D6).

Usage (at night: a model may use the GPU only from 01:00 to 07:00, local time):
    .venv/bin/python tools/compare_models.py [--dir data/annotation]
        [--models gemma4:12b,gpt-oss:20b,qwen3.6:27b] [--think MODEL=VALUE ...]
        [--limit N] [--min-labelled 0.8] [--ollama http://127.0.0.1:11434]
    .venv/bin/python tools/compare_models.py --report-only      # any time: no model runs
    .venv/bin/python tools/compare_models.py --now              # outside the window: warns

It reads, in `--dir` (default data/annotation/):
- `sample.csv`, once the owner has filled it: it refuses to run while fewer than
  `--min-labelled` of the rows have an `on_topic` label;
- `rules_predictions.csv`, what the rules answered for the same papers;
- `inputs.jsonl`, the full inputs given to the models (falls back to sample.csv's columns).

For each model it asks Ollama for the five facets, through a strict JSON schema (Ollama's
structured output, temperature 0), and keeps every answer in
`model_runs/<model>/<prompt version>/<paper>.json`: a stopped run resumes where it
stopped, and a changed prompt starts afresh. Outside `--now`, it refuses to start outside
01:00-07:00 and stops cleanly at 07:00 (the request under way is abandoned, the model is
unloaded).

The report (printed, and written to `comparison.md` and `comparison.json`) gives, per
facet: accuracy for the single-valued facets (on_topic, subfield), micro-averaged
precision, recall and F1 for the multi-valued ones, on_topic precision and recall; for
the rules alone, each model alone, and the rules with the model on the facets they left
ambiguous (decision D6's setup); and each model's time per paper and tokens per second.
Nothing in it quotes a paper.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import statistics
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oscr import classify as C  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIR = ROOT / "data" / "annotation"
DEFAULT_MODELS = ("gemma4:12b", "gpt-oss:20b", "qwen3.6:27b")
OLLAMA = "http://127.0.0.1:11434"
#: The share of rows that must carry an on_topic label before anything runs.
MIN_LABELLED = 0.8
#: A request is not started with less than this many seconds left in the GPU window.
MIN_SECONDS = 30.0
REQUEST_TIMEOUT = 600.0
ABSTRACT_CHARS = 4000
#: The reasoning effort of thinking models, by name prefix (`--think` overrides).
DEFAULT_THINK: dict[str, object] = {"gpt-oss": "low", "qwen3": False, "deepseek-r1": False, "qwq": False}


# --------------------------------------------------------------------------------------
# The owner's labels
# --------------------------------------------------------------------------------------

@dataclass
class Label:
    """One cell of the owner: "value" (with `values`), "unsure" ("?"), "empty", or
    "invalid" (a value outside the vocabulary: reported, not scored)."""

    status: str
    values: list[str] = field(default_factory=list)
    raw: str = ""


def parse_cell(facet: str, cell: str | None) -> Label:
    """A cell as the owner wrote it: values separated by "; ", "?" when unsure, "-" for
    "not applicable" (an empty list), names or aliases accepted ("Alzheimer's", "AD")."""
    raw = (cell or "").strip()
    if not raw:
        return Label("empty", raw=raw)
    if C.UNSURE in raw:
        return Label("unsure", raw=raw)
    if raw == C.NOT_APPLICABLE:
        return Label("invalid", raw=raw) if facet == "on_topic" else Label("value", [], raw)
    values: list[str] = []
    for part in (p.strip() for p in raw.split(";")):
        if not part:
            continue
        value = C.normalize_value(facet, part)
        pieces = [value] if value else [C.normalize_value(facet, q.strip()) for q in part.split(",")]
        if not pieces or any(v is None for v in pieces):
            return Label("invalid", raw=raw)
        values += [v for v in pieces if v not in values]
    if not C.MULTI[facet] and len(values) > 1:
        return Label("invalid", raw=raw)
    return Label("value", values, raw)


def load_labels(rows: list[dict[str, str]]) -> dict[str, dict[str, Label]]:
    return {row["id"]: {facet: parse_cell(facet, row.get(facet)) for facet in C.FACETS}
            for row in rows}


def labelled_share(labels: dict[str, dict[str, Label]]) -> float:
    """The share of papers whose on_topic cell is filled (a value or "?")."""
    if not labels:
        return 0.0
    return sum(1 for f in labels.values() if f["on_topic"].status in ("value", "unsure")) / len(labels)


# --------------------------------------------------------------------------------------
# The metrics
# --------------------------------------------------------------------------------------

def accuracy(pairs: list[tuple[str, str | None]]) -> float | None:
    """Single-valued facets: the share of papers where the prediction equals the label (no
    prediction counts as wrong). None when nothing is labelled."""
    if not pairs:
        return None
    return sum(1 for gold, pred in pairs if pred == gold) / len(pairs)


def micro_prf(pairs: list[tuple[set[str], set[str]]]) -> tuple[float | None, float | None, float | None]:
    """Multi-valued facets: micro-averaged precision, recall and F1 over all (paper, value)
    decisions. None where undefined (no prediction, or no label)."""
    tp = sum(len(gold & pred) for gold, pred in pairs)
    fp = sum(len(pred - gold) for gold, pred in pairs)
    fn = sum(len(gold - pred) for gold, pred in pairs)
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    f1 = (2 * precision * recall / (precision + recall)
          if precision is not None and recall is not None and precision + recall else
          (0.0 if precision is not None and recall is not None else None))
    return precision, recall, f1


def binary_pr(pairs: list[tuple[str, str | None]], positive: str) -> tuple[float | None, float | None]:
    """Precision and recall of one class (on_topic "no": finding the off-topic papers)."""
    predicted = [gold for gold, pred in pairs if pred == positive]
    actual = [pred for gold, pred in pairs if gold == positive]
    precision = sum(1 for g in predicted if g == positive) / len(predicted) if predicted else None
    recall = sum(1 for p in actual if p == positive) / len(actual) if actual else None
    return precision, recall


def combine(rules: dict[str, list[str] | None], ambiguous: dict[str, bool],
            model: dict[str, list[str] | None] | None) -> dict[str, list[str] | None]:
    """Decision D6: the rules' answer, and the model's on the facets the rules left
    ambiguous. As `classify.needs_model` does, a paper the rules settle as off-topic is not
    sent to the model."""
    out = dict(rules)
    if model is None or not asks_model(rules, ambiguous):
        return out
    for facet, amb in ambiguous.items():
        if amb:
            out[facet] = model.get(facet)
    return out


def asks_model(rules: dict[str, list[str] | None], ambiguous: dict[str, bool]) -> bool:
    """Whether D6's setup asks the model about a paper (as `classify.needs_model` decides)."""
    if rules.get("on_topic") == ["no"] and not ambiguous.get("on_topic"):
        return False
    return any(ambiguous.values())


def evaluate(labels: dict[str, dict[str, Label]],
             predictions: dict[str, dict[str, list[str] | None]]) -> dict[str, dict]:
    """Per facet, the scores of one predictor ({paper id: {facet: values or None}}) on the
    papers the owner labelled with a value; a paper the predictor did not answer counts as
    a miss."""
    out: dict[str, dict] = {}
    for facet in C.FACETS:
        gold_pred = []
        for pid, facets in labels.items():
            label = facets[facet]
            if label.status != "value" or (not C.MULTI[facet] and not label.values):
                continue
            pred = (predictions.get(pid) or {}).get(facet)
            gold_pred.append((label.values, pred))
        scores: dict = {"n": len(gold_pred)}
        if C.MULTI[facet]:
            p, r, f1 = micro_prf([(set(g), set(p or [])) for g, p in gold_pred])
            scores.update(precision=p, recall=r, f1=f1)
        else:
            pairs = [(g[0] if g else "", (p or [None])[0]) for g, p in gold_pred]
            scores["accuracy"] = accuracy(pairs)
            scores["answered"] = (sum(1 for _, p in pairs if p is not None) / len(pairs)) if pairs else None
            if facet == "on_topic":
                scores["no_precision"], scores["no_recall"] = binary_pr(pairs, "no")
                scores["yes_precision"], scores["yes_recall"] = binary_pr(pairs, "yes")
        out[facet] = scores
    return out


# --------------------------------------------------------------------------------------
# The rules' predictions
# --------------------------------------------------------------------------------------

def load_rules(path: Path) -> tuple[dict[str, dict[str, list[str] | None]], dict[str, dict[str, bool]]]:
    """From rules_predictions.csv: {id: {facet: values}} (None: no answer) and
    {id: {facet: ambiguous}}."""
    predictions, ambiguous = {}, {}
    with path.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            pid = row["id"]
            predictions[pid], ambiguous[pid] = {}, {}
            for facet in C.FACETS:
                cell = (row.get(facet) or "").strip()
                if cell == C.NOT_APPLICABLE:
                    values: list[str] | None = []
                else:
                    values = [v.strip() for v in cell.split(";") if v.strip()] or None
                predictions[pid][facet] = values
                ambiguous[pid][facet] = (row.get(f"{facet}_ambiguous") or "").strip() == "yes"
    return predictions, ambiguous


# --------------------------------------------------------------------------------------
# The prompt
# --------------------------------------------------------------------------------------

def schema() -> dict:
    """The JSON schema Ollama constrains the answer to: the vocabulary's values only."""
    def one(facet: str) -> dict:
        return {"type": "string", "enum": list(C.FACETS[facet])}

    def many(facet: str) -> dict:
        return {"type": "array", "items": {"type": "string", "enum": list(C.FACETS[facet])}}

    properties = {f: (many(f) if C.MULTI[f] else one(f)) for f in C.FACETS}
    return {"type": "object", "properties": properties, "required": list(C.FACETS),
            "additionalProperties": False}


def system_prompt() -> str:
    lines = [
        "You classify research papers for OSCR, an open registry of neuroscience research code.",
        "Read the paper's title, journal, article type, keywords and abstract, then answer with "
        "JSON only, following the schema given at the end. Use only the value identifiers "
        "listed below (the word before the colon).",
        "",
    ]
    hints = {
        "on_topic": "exactly one value",
        "modality": "a list: every modality that is a real part of the work, not those only "
                    "mentioned as background",
        "organism": "a list",
        "population": "a list; an empty list when there are no subjects at all "
                      "(pure theory, a simulation)",
        "subfield": "exactly one value: the paper's main angle",
    }
    for facet, spec in C.VOCABULARY["facets"].items():
        lines.append(f"{facet} ({hints[facet]}). {spec['definition']}")
        for v in spec["values"]:
            name = "" if v["name"] == v["value"] else f"{v['name']}. "
            lines.append(f"- {v['value']}: {name}{v['definition']}")
        lines.append("")
    lines.append("When the text does not say, choose the most likely value from what it does say.")
    lines.append("JSON schema: " + json.dumps(schema(), ensure_ascii=False))
    return "\n".join(lines)


def user_prompt(paper: dict) -> str:
    keywords = paper.get("keywords") or []
    if isinstance(keywords, str):
        keywords = [k.strip() for k in keywords.split(";") if k.strip()]
    abstract = (paper.get("abstract") or "")[:ABSTRACT_CHARS]
    return "\n".join([
        f"Title: {paper.get('title') or ''}",
        f"Journal: {paper.get('journal') or ''}",
        f"Article type: {paper.get('type') or 'unknown'}",
        f"Keywords: {'; '.join(keywords) if keywords else 'none'}",
        f"Abstract: {abstract or 'none'}",
    ])


def prompt_version() -> str:
    """Changes whenever the prompt or the schema changes: cached answers are then not reused."""
    return hashlib.sha256((system_prompt() + json.dumps(schema())).encode()).hexdigest()[:10]


# --------------------------------------------------------------------------------------
# The model runs
# --------------------------------------------------------------------------------------

def slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", text)


def run_path(runs: Path, model: str, version: str, paper_id: str) -> Path:
    key = hashlib.sha256(paper_id.encode()).hexdigest()[:20]
    return runs / slug(model) / version / f"{key}.json"


def parse_answer(content: str) -> tuple[dict[str, list[str] | None], bool]:
    """The model's JSON, normalized to the vocabulary; False when it is not valid."""
    data = None
    try:
        data = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        m = re.search(r"\{.*\}", content or "", re.S)
        if m:
            try:
                data = json.loads(m.group(0))
            except json.JSONDecodeError:
                data = None
    if not isinstance(data, dict):
        return {facet: None for facet in C.FACETS}, False
    answer, valid = {}, True
    for facet in C.FACETS:
        values = C.normalize_values(facet, data.get(facet)) if facet in data else None
        if values is None or (not C.MULTI[facet] and not values):
            valid = False
            values = None
        answer[facet] = values
    return answer, valid


def think_setting(model: str, overrides: dict[str, object]) -> object | None:
    if model in overrides:
        return overrides[model]
    for prefix, value in DEFAULT_THINK.items():
        if model.startswith(prefix):
            return value
    return None


class Ollama:
    def __init__(self, url: str) -> None:
        self.url = url.rstrip("/")
        self.http = httpx.Client(timeout=30.0)
        self.no_think: set[str] = set()

    def version(self) -> str:
        return self.http.get(f"{self.url}/api/version").json().get("version", "?")

    def installed(self) -> set[str]:
        models = self.http.get(f"{self.url}/api/tags").json().get("models", [])
        return {m.get("name", "") for m in models} | {m.get("model", "") for m in models}

    def chat(self, model: str, paper: dict, think: object | None, timeout: float) -> dict:
        body: dict = {
            "model": model, "stream": False, "format": schema(), "keep_alive": "10m",
            "options": {"temperature": 0, "seed": 0, "num_ctx": 8192},
            "messages": [{"role": "system", "content": system_prompt()},
                         {"role": "user", "content": user_prompt(paper)}],
        }
        if think is not None and model not in self.no_think:
            body["think"] = think
        r = self.http.post(f"{self.url}/api/chat", json=body, timeout=timeout)
        if r.status_code == 400 and "think" in r.text.lower() and "think" in body:
            self.no_think.add(model)          # this model takes no reasoning setting
            del body["think"]
            r = self.http.post(f"{self.url}/api/chat", json=body, timeout=timeout)
        r.raise_for_status()
        return r.json()

    def unload(self, model: str) -> None:
        """Frees the GPU memory at once rather than after the keep-alive delay."""
        try:
            self.http.post(f"{self.url}/api/chat", json={"model": model, "messages": [], "keep_alive": 0})
        except httpx.HTTPError:
            pass


def record(model: str, version: str, paper_id: str, reply: dict) -> dict:
    message = reply.get("message") or {}
    answer, valid = parse_answer(message.get("content", ""))
    return {
        "model": model, "prompt_version": version, "paper_id": paper_id,
        "answer": answer, "valid": valid, "content": message.get("content", ""),
        "thinking_chars": len(message.get("thinking") or ""),
        **{k: reply.get(k) for k in ("total_duration", "load_duration", "prompt_eval_count",
                                     "prompt_eval_duration", "eval_count", "eval_duration",
                                     "done_reason")},
        "at": datetime.now().isoformat(timespec="seconds"),
    }


def save(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def run_model(client: Ollama, model: str, papers: list[dict], runs: Path, version: str,
              think: object | None, anytime: bool) -> str:
    """Asks the model about every paper it has not answered yet. Returns "done", or
    "window" when 07:00 came first (what is done is kept: the next night resumes)."""
    todo = [p for p in papers if not run_path(runs, model, version, p["id"]).exists()]
    print(f"{model}: {len(papers) - len(todo)} already answered, {len(todo)} to go", flush=True)
    status = "done"
    try:
        for i, paper in enumerate(todo, 1):
            timeout = REQUEST_TIMEOUT
            if not anytime:
                left = C.gpu_window_seconds_left()
                if left < MIN_SECONDS:
                    status = "window"
                    break
                timeout = min(timeout, left)
            started = time.monotonic()
            try:
                reply = client.chat(model, paper, think, timeout)
            except httpx.TimeoutException:
                if not anytime and C.gpu_window_seconds_left() < MIN_SECONDS:
                    status = "window"
                    break
                print(f"  {paper['id']}: no answer within {timeout:.0f} s, skipped", flush=True)
                continue
            except httpx.HTTPError as e:
                print(f"  {paper['id']}: {e}", flush=True)
                continue
            data = record(model, version, paper["id"], reply)
            save(run_path(runs, model, version, paper["id"]), data)
            print(f"  [{i}/{len(todo)}] {time.monotonic() - started:5.1f} s"
                  f"{'' if data['valid'] else '  (invalid answer)'}", flush=True)
    finally:
        client.unload(model)
    if status == "window":
        print(f"{model}: stopped at the end of the GPU window; rerun next night to resume.", flush=True)
    return status


def load_runs(runs: Path, model: str, version: str, ids: list[str]) -> dict[str, dict]:
    out = {}
    for pid in ids:
        path = run_path(runs, model, version, pid)
        if path.exists():
            out[pid] = json.loads(path.read_text(encoding="utf-8"))
    return out


def speed(runs: dict[str, dict]) -> dict:
    """Time per paper (seconds, without the model's loading) and speeds (tokens per second)."""
    seconds = [(r["total_duration"] - (r.get("load_duration") or 0)) / 1e9 for r in runs.values()
               if r.get("total_duration")]
    rates = [r["eval_count"] / (r["eval_duration"] / 1e9) for r in runs.values()
             if r.get("eval_count") and r.get("eval_duration")]
    prompt_rates = [r["prompt_eval_count"] / (r["prompt_eval_duration"] / 1e9) for r in runs.values()
                    if r.get("prompt_eval_count") and r.get("prompt_eval_duration")]
    return {
        "papers": len(runs), "invalid": sum(1 for r in runs.values() if not r.get("valid")),
        "seconds_mean": statistics.fmean(seconds) if seconds else None,
        "seconds_median": statistics.median(seconds) if seconds else None,
        "tokens_per_second": statistics.fmean(rates) if rates else None,
        "prompt_tokens_per_second": statistics.fmean(prompt_rates) if prompt_rates else None,
    }


# --------------------------------------------------------------------------------------
# The report
# --------------------------------------------------------------------------------------

def _pct(x: float | None) -> str:
    return "–" if x is None else f"{100 * x:.0f}%"


def report(scores: dict[str, dict[str, dict]], speeds: dict[str, dict], model_share: float,
           labels: dict[str, dict[str, Label]], version: str) -> str:
    n = len(labels)
    unsure = {f: sum(1 for x in labels.values() if x[f].status == "unsure") for f in C.FACETS}
    invalid = {f: sum(1 for x in labels.values() if x[f].status == "invalid") for f in C.FACETS}
    lines = ["# Classification: rules and local models on the owner's labels",
             "",
             f"{n} papers in the sample; prompt version {version}. "
             f"Unsure ('?') cells: " + ", ".join(f"{f} {unsure[f]}" for f in C.FACETS) +
             ". Cells outside the vocabulary (not scored): " +
             ", ".join(f"{f} {invalid[f]}" for f in C.FACETS) + ".",
             f"D6's setup asks the model about {_pct(model_share)} of these papers (the rules left "
             "at least one facet ambiguous, and did not settle the paper as off-topic).",
             "",
             "| predictor | on_topic acc. | off-topic P / R | on-topic P / R | subfield acc. "
             "| modality P / R / F1 | organism P / R / F1 | population P / R / F1 |",
             "|---|---|---|---|---|---|---|---|"]
    for name, s in scores.items():
        o, sf = s["on_topic"], s["subfield"]
        lines.append(
            f"| {name} | {_pct(o['accuracy'])} | {_pct(o['no_precision'])} / {_pct(o['no_recall'])} "
            f"| {_pct(o['yes_precision'])} / {_pct(o['yes_recall'])} | {_pct(sf['accuracy'])} "
            f"| {_prf(s['modality'])} | {_prf(s['organism'])} | {_prf(s['population'])} |")
    counts = next(iter(scores.values())) if scores else {}
    lines += ["", "Labelled papers per facet: " +
              ", ".join(f"{f} {counts[f]['n']}" for f in C.FACETS if f in counts) + ".", ""]
    if speeds:
        lines += ["| model | papers answered | invalid answers | s / paper (mean, median) "
                  "| tokens / s | prompt tokens / s | papers per 6-hour night |",
                  "|---|---|---|---|---|---|---|"]
        for model, sp in speeds.items():
            mean = sp["seconds_mean"]
            night = f"{6 * 3600 / mean:,.0f}" if mean else "–"
            lines.append(
                f"| {model} | {sp['papers']} | {sp['invalid']} "
                f"| {_f(mean)}, {_f(sp['seconds_median'])} | {_f(sp['tokens_per_second'])} "
                f"| {_f(sp['prompt_tokens_per_second'])} | {night} |")
    lines += ["", "acc.: accuracy (a paper without an answer counts as a miss); P / R: precision / "
              "recall; micro-averaged over (paper, value) pairs for the multi-valued facets. "
              "'rules + model': the model answers only the facets the rules left ambiguous."]
    return "\n".join(lines) + "\n"


def _prf(x: dict) -> str:
    return f"{_pct(x['precision'])} / {_pct(x['recall'])} / {_pct(x['f1'])}"


def _f(x: float | None) -> str:
    return "–" if x is None else f"{x:.1f}"


# --------------------------------------------------------------------------------------

def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def load_inputs(folder: Path, rows: list[dict[str, str]]) -> list[dict]:
    """The models' inputs: inputs.jsonl (full abstracts), else the sample's own columns."""
    full = {}
    path = folder / "inputs.jsonl"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                d = json.loads(line)
                full[d["id"]] = d
    return [full.get(r["id"]) or {"id": r["id"], "title": r.get("title", ""),
                                  "journal": r.get("journal", ""), "type": r.get("type", ""),
                                  "keywords": r.get("keywords", ""), "abstract": r.get("abstract", "")}
            for r in rows]


def parse_think(items: list[str]) -> dict[str, object]:
    out: dict[str, object] = {}
    for item in items:
        model, _, value = item.partition("=")
        low = value.strip().lower()
        out[model.strip()] = {"true": True, "false": False, "none": None}.get(low, low)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dir", type=Path, default=DEFAULT_DIR, help="the annotation folder")
    ap.add_argument("--models", default=",".join(DEFAULT_MODELS), help="comma-separated Ollama models")
    ap.add_argument("--ollama", default=OLLAMA)
    ap.add_argument("--now", action="store_true", help="run outside 01:00-07:00 (prints a warning)")
    ap.add_argument("--report-only", action="store_true", help="no model runs: report on the cached answers")
    ap.add_argument("--limit", type=int, default=0, help="only the first N papers (a trial run)")
    ap.add_argument("--min-labelled", type=float, default=MIN_LABELLED)
    ap.add_argument("--think", action="append", default=[], metavar="MODEL=VALUE",
                    help="reasoning setting for a model: true, false, low, medium or high")
    a = ap.parse_args(argv)

    rows = read_rows(a.dir / "sample.csv")
    labels = load_labels(rows)
    share = labelled_share(labels)
    if share < a.min_labelled:
        print(f"The owner's columns are mostly empty: {share:.0%} of the {len(rows)} papers have an "
              f"on_topic label, {a.min_labelled:.0%} are needed. Nothing was run.")
        return 2
    papers = load_inputs(a.dir, rows)
    if a.limit:
        papers = papers[:a.limit]
    ids = [p["id"] for p in papers]
    labels = {pid: labels[pid] for pid in ids}
    models = [m.strip() for m in a.models.split(",") if m.strip()]
    version = prompt_version()
    runs = a.dir / "model_runs"

    if not a.report_only:
        if not a.now and not C.within_gpu_window():
            print("Outside the GPU window (01:00-07:00, decision D6): nothing was run. "
                  "Use --report-only for the report, or --now to force a run.")
            return 2
        if a.now:
            print("WARNING: --now runs the models outside the 01:00-07:00 GPU window (decision D6).",
                  file=sys.stderr)
        client = Ollama(a.ollama)
        try:
            print(f"Ollama {client.version()}; prompt version {version}")
            installed = client.installed()
        except httpx.HTTPError as e:
            print(f"Ollama does not answer at {a.ollama}: {e}")
            return 1
        overrides = parse_think(a.think)
        try:
            for model in models:
                if model not in installed:
                    print(f"{model}: not installed in Ollama, skipped")
                    continue
                if run_model(client, model, papers, runs, version, think_setting(model, overrides),
                             a.now) == "window":
                    break
        except KeyboardInterrupt:
            print("Interrupted: the answers so far are kept; a new run resumes from them.")
            return 130

    rules, ambiguous = load_rules(a.dir / "rules_predictions.csv")
    scores: dict[str, dict[str, dict]] = {"rules": evaluate(labels, rules)}
    speeds: dict[str, dict] = {}
    for model in models:
        answered = load_runs(runs, model, version, ids)
        if not answered:
            continue
        answers = {pid: r["answer"] for pid, r in answered.items()}
        # A run the GPU window cut short is scored all the same (a missing answer is a miss),
        # and says so.
        mark = "" if len(answered) == len(ids) else f" (incomplete: {len(answered)}/{len(ids)})"
        scores[f"{model} alone{mark}"] = evaluate(labels, answers)
        scores[f"rules + {model}{mark}"] = evaluate(labels, {
            pid: combine(rules.get(pid, {}), ambiguous.get(pid, {}), answers.get(pid))
            for pid in ids})
        speeds[model] = speed(answered)
    model_share = sum(1 for pid in ids if asks_model(rules.get(pid, {}), ambiguous.get(pid, {}))) \
        / max(1, len(ids))
    text = report(scores, speeds, model_share, labels, version)
    print(text)
    (a.dir / "comparison.md").write_text(text, encoding="utf-8")
    (a.dir / "comparison.json").write_text(json.dumps(
        {"prompt_version": version, "scores": scores, "speeds": speeds, "model_share": model_share},
        indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
