#!/usr/bin/env python3
"""Derive an Artificial Analysis -> Pi model-identity mapping from live sources.

WHY A SCRIPT: the mapping must never be guessed from a name or slug
(SPEC R15), but it also must not be hand-typed, because both sides drift
(AA adds models and variants; Pi's catalog gains and loses ids). This tool
reads the two live sources and only emits an entry when a Pi model id maps
to an AA entry by EXACT slug equality, so a rename on either side shows up as
a missing entry that a human reviews rather than as a wrong record.

Sources (both live, both required):
  1. `pi --list-models`  -> the exact provider/model ids this machine serves
  2. GET https://artificialanalysis.ai/api/v2/language/models/free
     with ARTIFICIAL_ANALYSIS_API_KEY from the environment (Free tier only)

Output: the `parseSourceModelMap` shape consumed by
`/delegateau setup retrieve artificial-analysis <mapping-file>`.

Unmatched Pi models are reported on stderr and simply omitted: an omitted
model stays visibly unmeasured, which is the correct failure mode. Nothing is
ever inferred from a name.

Usage:
  ARTIFICIAL_ANALYSIS_API_KEY=... python3 build-aa-mapping.py <output.json>
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

AA_ENDPOINT = "https://artificialanalysis.ai/api/v2/language/models/free"
AA_HOST = "artificialanalysis.ai"
PI_BIN = os.environ.get("PI_BIN", "/home/nazar/.local/bin/pi")
MAX_PAGES = 10
TIMEOUT_S = 30
SOURCE = "artificial-analysis"


def normalize(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (value or "").lower())


def live_pi_models() -> list[tuple[str, str]]:
    """Exact provider/model ids from the installed Pi, with configured auth."""
    out = subprocess.run([PI_BIN, "--list-models"], capture_output=True, text=True, timeout=180, check=True).stdout
    models: list[tuple[str, str]] = []
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and "/" not in parts[0]:
            models.append((parts[0], parts[1]))
    if not models:
        raise SystemExit("pi --list-models returned no models; refusing to write an empty mapping")
    return models


def fetch_aa_catalog(key: str) -> list[dict]:
    catalog: list[dict] = []
    for page in range(1, MAX_PAGES + 1):
        url = AA_ENDPOINT if page == 1 else f"{AA_ENDPOINT}?page={page}"
        request = urllib.request.Request(url, headers={"x-api-key": key, "accept": "application/json"})
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            if response.status != 200:
                raise SystemExit(f"artificial analysis returned HTTP {response.status}")
            body = json.loads(response.read().decode("utf-8"))
        if not isinstance(body, dict) or not isinstance(body.get("data"), list):
            raise SystemExit("artificial analysis returned an unexpected body shape")
        catalog.extend(body["data"])
        pagination = body.get("pagination") or {}
        if pagination.get("has_more") is not True:
            break
    if not catalog:
        raise SystemExit("artificial analysis returned an empty catalog")
    return catalog


def build(pi_models: list[tuple[str, str]], catalog: list[dict]) -> tuple[list[dict], list[str]]:
    by_slug: dict[str, list[dict]] = {}
    for entry in catalog:
        by_slug.setdefault(normalize(entry.get("slug")), []).append(entry)

    mappings: list[dict] = []
    unmatched: list[str] = []
    for provider, model_id in pi_models:
        candidates = by_slug.get(normalize(model_id), [])
        # The model id here is Ollama's tag form (`glm-5.3-flash`), which equals
        # AA's slug minus punctuation. Exact normalized equality only: a
        # substring match would attach `glm-5-3-flash` to `glm-5-3`.
        if len(candidates) != 1:
            reason = "no AA entry with this slug" if not candidates else f"{len(candidates)} AA entries share this slug"
            unmatched.append(f"{provider}/{model_id}: {reason}")
            continue
        entry = candidates[0]
        mappings.append({
            "sourceId": entry["id"],
            "provider": provider,
            "id": model_id,
            # Provenance is carried for the human reviewer; the extension ignores it.
            "_matchedName": entry.get("name"),
            "_matchedCreator": (entry.get("model_creator") or {}).get("name"),
        })
    return mappings, unmatched


def strip_provenance(mappings: list[dict]) -> list[dict]:
    return [{k: v for k, v in entry.items() if not k.startswith("_")} for entry in mappings]


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    key = os.environ.get("ARTIFICIAL_ANALYSIS_API_KEY")
    if not key:
        print("ARTIFICIAL_ANALYSIS_API_KEY is absent; no request was made", file=sys.stderr)
        return 2

    pi_models = live_pi_models()
    catalog = fetch_aa_catalog(key)
    mappings, unmatched = build(pi_models, catalog)
    if not mappings:
        raise SystemExit("no Pi model matched an Artificial Analysis entry; refusing to write an empty mapping")

    target = Path(sys.argv[1])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"source": SOURCE, "mappings": strip_provenance(mappings)}, indent=2) + "\n", encoding="utf-8")
    target.chmod(0o600)

    print(f"pi models: {len(pi_models)}  AA entries: {len(catalog)}  mapped: {len(mappings)}  unmatched: {len(unmatched)}")
    for line in unmatched:
        print(f"  unmatched  {line}", file=sys.stderr)
    print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
