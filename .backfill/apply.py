import copy, json, sys
from pathlib import Path
root = Path(sys.argv[1])
seeds = [s for path in sorted(Path(sys.argv[2]).glob("equipment-*.json")) for s in json.loads(path.read_text(encoding="utf-8"))]
seeds = {s["listing_key"]: s for s in seeds}
for filename in ["data/database.json", "web/inventory.json"]:
    path = root / filename
    original = json.loads(path.read_text(encoding="utf-8"))
    updated = copy.deepcopy(original)
    rows = updated["listings"]
    rows = rows.values() if isinstance(rows, dict) else rows
    changed = 0
    for row in rows:
        seed = seeds.get(row["listing_key"])
        if not seed or any(row.get(k, "") != seed.get(k, "") for k in ["listing_url", "year", "model", "vin"]):
            continue
        evidence = list(row.get("equipment_evidence") or [])
        for claim in seed["equipment_evidence"]:
            if claim not in evidence:
                evidence.append(claim)
        if evidence != row.get("equipment_evidence"):
            row["equipment_evidence"] = evidence
            changed += 1
    stripped = copy.deepcopy(updated)
    oldrows = original["listings"]
    lookup = oldrows if isinstance(oldrows, dict) else {r["listing_key"]: r for r in oldrows}
    rows = stripped["listings"]
    for row in (rows.values() if isinstance(rows, dict) else rows):
        old = lookup[row["listing_key"]]
        if "equipment_evidence" in old:
            row["equipment_evidence"] = old["equipment_evidence"]
        else:
            row.pop("equipment_evidence", None)
    assert stripped == original, "Unexpected non-equipment change"
    path.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(filename, changed, "equipment records updated; all other fields unchanged")
