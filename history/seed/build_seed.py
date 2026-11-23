#!/usr/bin/env python3
"""Build the first stratified seed list (history/seed.txt, history/seed-v1.json).

Reproduce:  python3 -I history/seed/build_seed.py --registry <snapshot.jsonl.gz> [--offline]
Only stdlib. GitHub data comes from `gh api repos/{owner}/{repo}`, cached in
history/seed/github-cache.json; with --offline only the cache is used.
"""
import argparse, collections, gzip, json, math, os, random, re, subprocess, sys, time
from datetime import date

SEED = 20261123            # sampling seed (recorded in seed-v1.json)
SNAPSHOT_DATE = "2026-11-21"
BUILD_DATE = "2026-11-23"
TARGET = 1000              # subjects in the final list
RANDOM_POOL = 1170         # random candidates fetched from GitHub (plus the fixed ones)
POOL_ALLOC = {"cargo": 10**9, "oci": 330, "mcpb": 100, "nuget": 30, "pypi": 270, "npm": None}  # npm gets the remainder
CLASS_PRIORITY = ["cargo", "oci", "mcpb", "nuget", "pypi", "npm"]
BUCKETS = [(0, 9, "0-9"), (10, 99, "10-99"), (100, 999, "100-999"), (1000, 10**12, "1000+")]

OURS = ["isokron-ai/kronicle-lite", "isokron-ai/sea-lite", "isokron-ai/strapi-plugin-writesafe",
        "isokron-ai/mcp-check", "isokron-ai/mcp-catalog-snap"]
OURS_PKGS = {"isokron-ai/kronicle-lite": [("npm", "kronicle-lite")], "isokron-ai/sea-lite": [("npm", "sea-lite")],
             "isokron-ai/mcp-check": [("npm", "@isokron/mcp-check")], "isokron-ai/mcp-catalog-snap": [("npm", "mcp-catalog-snap")]}
GOLD14 = ["github/github-mcp-server", "grafana/mcp-grafana", "containers/kubernetes-mcp-server",
          "hashicorp/terraform-mcp-server", "mark3labs/mcp-filesystem-server", "zerodha/kite-mcp-server",
          "isaacphi/mcp-language-server", "googleapis/genai-toolbox", "strowk/mcp-k8s-go",
          "nguyenvanduocit/all-in-one-model-context-protocol", "elastic/mcp-server-elasticsearch",
          "apollographql/apollo-mcp-server", "Roblox/studio-rust-mcp-server", "tuananh/hyper-mcp"]
REF = "modelcontextprotocol/servers"
REF_PKGS = [("npm", n) for n in ["@modelcontextprotocol/server-filesystem", "@modelcontextprotocol/server-memory",
            "@modelcontextprotocol/server-everything", "@modelcontextprotocol/server-sequential-thinking"]] + \
           [("pypi", n) for n in ["mcp-server-git", "mcp-server-fetch", "mcp-server-time"]]
SEED_ECO = {"npm": "npm", "pypi": "pypi", "cargo": "crates"}

def gh_id(url):
    m = re.match(r"^https?://(?:www\.)?github\.com/([\w.-]+)/([\w.-]+?)(?:\.git)?/?$", url or "")
    return f"{m.group(1)}/{m.group(2)}" if m else None

def bucket(stars):
    return next(l for lo, hi, l in BUCKETS if lo <= stars <= hi)

def lang_class(l):
    return {"Go": "Go", "Rust": "Rust", "TypeScript": "TS/JS", "JavaScript": "TS/JS", "Python": "Python",
            "C#": "C#", "Java": "Java/Kotlin", "Kotlin": "Java/Kotlin"}.get(l, "Other")

def transport_class(types):
    s, h = "stdio" in types, bool(types & {"streamable-http", "sse"})
    return "both" if s and h else "http" if h else "stdio"

def frame(path):
    """Latest version per server (the snapshot holds one per name), drop remote-only, collapse to repo."""
    stats = collections.Counter(); repos = {}
    seen = {}
    for line in gzip.open(path, "rt"):
        o = json.loads(line); s = o["server"]
        meta = o["_meta"]["io.modelcontextprotocol.registry/official"]
        n = s["name"]
        if n in seen and seen[n][0] >= meta.get("publishedAt", ""): continue
        seen[n] = (meta.get("publishedAt", ""), s)
    stats["server_names"] = len(seen)
    for _, s in seen.values():
        if not s.get("packages"):
            stats["remote_only" if s.get("remotes") else "no_packages_no_remotes"] += 1; continue
        stats["with_packages"] += 1
        rid = gh_id((s.get("repository") or {}).get("url"))
        if not rid: stats["with_packages_no_github_repo"] += 1; continue
        stats["with_packages_github"] += 1
        r = repos.setdefault(rid.lower(), {"id": rid, "entries": 0, "pk": {}, "tr": set(), "updated": ""})
        r["entries"] += 1
        r["updated"] = max(r["updated"], seen[s["name"]][0])
        for p in s["packages"]:
            r["pk"].setdefault((p["registryType"], p["identifier"]), None)
            r["tr"].add((p.get("transport") or {}).get("type", "stdio"))
    stats["repos"] = len(repos)
    return repos, stats

def pkg_class(r):
    t = {k[0] for k in r["pk"]}
    return next(x for x in CLASS_PRIORITY if x in t)

def pkg_list(r, cap):
    order = {k: i for i, k in enumerate(["npm", "pypi", "cargo", "oci", "mcpb", "nuget"])}
    ps = sorted(r["pk"], key=lambda k: (order.get(k[0], 9), k[1]))
    return ps if cap is None else ps[:cap]

def gh_fetch(rid, cache, offline):
    key = rid.lower()
    if key in cache or offline: return cache.get(key)
    def call(path):
        p = subprocess.run(["gh", "api", path], capture_output=True, text=True)
        try: return json.loads(p.stdout)
        except Exception: return {"message": p.stderr.strip() or "no output", "status": "error"}
    d = call(f"repos/{rid}")
    if d.get("message") == "Moved Permanently" and d.get("url"):
        d = call(d["url"].split("api.github.com/")[-1])
    if "stargazers_count" in d:
        cache[key] = {"full_name": d["full_name"], "language": d.get("language"), "stars": d["stargazers_count"],
                      "forks": d.get("forks_count"), "archived": d.get("archived"), "fork": d.get("fork"),
                      "size_kb": d.get("size"), "pushed_at": d.get("pushed_at")}
    else:
        cache[key] = {"error": d.get("message", "unknown")}
    time.sleep(0.1)
    return cache[key]

def alloc_sqrt(sizes, k):
    """Split k picks over strata proportionally to sqrt(size), capped at size (rare strata get a larger share)."""
    got = {s: 0 for s in sizes}; left = k
    while left > 0:
        open_ = [s for s in sizes if got[s] < sizes[s]]
        if not open_: break
        w = {s: math.sqrt(sizes[s]) for s in open_}; tot = sum(w.values())
        ideal = {s: min(sizes[s] - got[s], left * w[s] / tot) for s in open_}
        step = {s: int(ideal[s]) for s in open_}
        if sum(step.values()) == 0:   # hand out the remainder by largest fractional part
            for s in sorted(open_, key=lambda s: (-(ideal[s] - int(ideal[s])), str(s)))[:left]: step[s] = 1
        for s in open_: got[s] += step[s]
        left -= sum(step.values())
    return got

def stratified_pick(cands, k, rng, keyf):
    groups = collections.defaultdict(list)
    for c in sorted(cands, key=lambda c: c["id"].lower()): groups[keyf(c)].append(c)
    n = alloc_sqrt({g: len(v) for g, v in groups.items()}, min(k, len(cands)))
    out = []
    for g in sorted(groups, key=str):
        out += rng.sample(groups[g], n[g])
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry", required=True)
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--outdir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    a = ap.parse_args()
    here = os.path.dirname(os.path.abspath(__file__))
    cache_path = os.path.join(here, "github-cache.json")
    cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    rng = random.Random(SEED)
    repos, fstats = frame(a.registry)

    # fixed subjects (always in)
    fixed = {}   # lower id -> (tier, population)
    for i in OURS: fixed[i.lower()] = "T0"
    for i in GOLD14: fixed[i.lower()] = "gold14"
    fixed[REF.lower()] = "reference"
    # random pool, per package class, over repos not fixed
    byclass = collections.defaultdict(list)
    for k in sorted(repos):
        if k not in fixed: byclass[pkg_class(repos[k])].append(k)
    alloc = dict(POOL_ALLOC)
    alloc["npm"] = RANDOM_POOL - sum(min(v, len(byclass[c])) for c, v in alloc.items() if v is not None)
    pool, incl = [], {}
    for c in CLASS_PRIORITY:
        n = min(alloc[c], len(byclass[c]))
        pool += rng.sample(byclass[c], n); incl[c] = n / len(byclass[c])
    pool_info = {c: {"frame_repos": len(byclass[c]), "drawn": round(incl[c] * len(byclass[c])), "inclusion_prob": round(incl[c], 5)} for c in CLASS_PRIORITY}

    def mk(key, tier):
        r = repos.get(key)
        g = gh_fetch(r["id"] if r else key, cache, a.offline)
        if not g or "error" in g: return None, g
        pk = []
        if tier in ("T0", "reference", "gold14"):
            pk = pkg_list(r, None) if r else []
            pk = sorted(set(pk) | set(OURS_PKGS.get(next((o for o in OURS if o.lower() == key), ""), [])) | (set(REF_PKGS) if key == REF.lower() else set()))
        else: pk = pkg_list(r, 3)
        return {"id": g["full_name"], "tier": tier, "population": "calibration" if tier != "sample" else "history",
                "language": lang_class(g["language"]), "github_language": g["language"],
                "transport": transport_class(r["tr"]) if r else "unknown",
                "stars": g["stars"], "star_bucket": bucket(g["stars"]), "forks": g["forks"],
                "archived": g["archived"], "fork": g["fork"], "size_kb": g["size_kb"], "pushed_at": g["pushed_at"],
                "registry_entries": r["entries"] if r else 0,
                "registry_package_class": pkg_class(r) if r else None,
                "packages_total": len(r["pk"]) if r else len(pk),
                "packages": [{"registry": t, "identifier": i} for t, i in pk],
                "weight": 1 / incl[pkg_class(r)] if tier == "sample" else 1}, g
    fixed_rows, missing, fail = [], [], []
    for k, tier in fixed.items():
        row, g = mk(k, tier)
        if row: fixed_rows.append(row); json.dump(cache, open(cache_path, "w"), indent=0, sort_keys=True)
        else: missing.append((k, g))
    cand = []
    for n, k in enumerate(pool):
        row, g = mk(k, "sample")
        if row: cand.append(row)
        else: fail.append((k, g))
        if n % 100 == 0: json.dump(cache, open(cache_path, "w"), indent=0, sort_keys=True); print(n, file=sys.stderr)
    json.dump(cache, open(cache_path, "w"), indent=0, sort_keys=True)

    # renamed repositories can resolve to the same GitHub name: keep one row per canonical name
    taken = {r["id"].lower() for r in fixed_rows}; uniq = []
    for c in cand:
        if c["id"].lower() not in taken: taken.add(c["id"].lower()); uniq.append(c)
    dup_dropped = len(cand) - len(uniq); cand = uniq

    # natural language shares in the frame (inverse-probability weights over the random draws)
    wsum = sum(c["weight"] for c in cand)
    share = {l: sum(c["weight"] for c in cand if c["language"] == l) / wsum for l in {c["language"] for c in cand}}
    fx = {l: sum(1 for r in fixed_rows if r["language"] == l) for l in ("Go", "Rust")}
    picked = list(fixed_rows)
    room = TARGET - len(picked)
    for l in ("Go", "Rust"):
        want = max(0, round(2 * share.get(l, 0) * TARGET) - fx[l])
        pc = [c for c in cand if c["language"] == l]
        picked += stratified_pick(pc, min(want, len(pc)), rng, lambda c: (c["transport"], c["star_bucket"]))
    rest = [c for c in cand if c["language"] not in ("Go", "Rust")]
    picked += stratified_pick(rest, TARGET - len(picked), rng, lambda c: (c["language"], c["transport"], c["star_bucket"]))
    picked.sort(key=lambda r: (r["population"] != "calibration", r["id"].lower()))

    # outputs
    ids = set()
    lines = ["# Seed list for popularity capture (H3). One `ecosystem:name` per line.",
             "# Ecosystems: npm, pypi, crates, github (github names are owner/repo).",
             "# Blank lines and lines starting with # are ignored. Ships empty on purpose.",
             "#",
             f"# Seed v1, built {BUILD_DATE} from the official MCP registry snapshot of {SNAPSHOT_DATE}.",
             f"# {len(picked)} repositories: IsoKron's own servers, 14 Go and Rust servers we test, the official",
             "# reference servers, and a stratified random sample (language x transport x star bucket,",
             f"# Go and Rust oversampled about 2x; sampling seed {SEED}). Remote-only servers are left out.",
             "# Each github line is followed by up to 3 of its npm, pypi and crates packages (all of them for",
             "# our servers, the 14 and the reference servers). Full table: history/seed-v1.json.",
             "# Rebuild: python3 -I history/seed/build_seed.py (see history/seed/README.md)."]
    # the header above replaces the "ships empty" sentence on purpose; keep the first two lines unchanged
    lines[2] = "# Blank lines and lines starting with # are ignored."
    for r in picked:
        lines.append(f"github:{r['id']}")
        for p in r["packages"]:
            e = SEED_ECO.get(p["registry"])
            if e: lines.append(f"{e}:{p['identifier']}")
    open(os.path.join(a.outdir, "seed.txt"), "w").write("\n".join(lines) + "\n")

    C = collections.Counter
    summary = {"language": C(r["language"] for r in picked), "transport": C(r["transport"] for r in picked),
               "star_bucket": C(r["star_bucket"] for r in picked), "population": C(r["population"] for r in picked),
               "tier": C(r["tier"] for r in picked),
               "language_x_transport": C(f"{r['language']}|{r['transport']}" for r in picked),
               "language_x_star_bucket": C(f"{r['language']}|{r['star_bucket']}" for r in picked)}
    out = {"version": 1, "built": BUILD_DATE, "registry_snapshot": SNAPSHOT_DATE, "sampling_seed": SEED,
           "target_size": TARGET, "size": len(picked), "frame": fstats,
           "pool": {"drawn": len(pool), "fetched_ok": len(cand) + dup_dropped, "duplicate_canonical_dropped": dup_dropped, "failed": [{"id": k, "error": (g or {}).get("error")} for k, g in fail],
                    "by_package_class": pool_info},
           "fixed_not_found": [{"id": k, "error": (g or {}).get("error")} for k, g in missing],
           "estimated_frame_language_share": {k: round(v, 4) for k, v in sorted(share.items())},
           "go_rust_target_share_multiplier": 2, "summary": {k: dict(sorted(v.items())) for k, v in summary.items()},
           "notes": ["Language and stars come from one GitHub repos call per candidate.",
                     "SDK, registration idiom, size, release cadence and tool count are not in the registry; later phases add them.",
                     "weight = 1 / inclusion probability of the random draw (1 for fixed subjects); used for frame-level estimates.",
                     "Fixed subjects without a registry package entry have github lines only."],
           "subjects": picked}
    json.dump(out, open(os.path.join(a.outdir, "seed-v1.json"), "w"), indent=1)
    print(json.dumps({k: out[k] for k in ("frame", "pool", "estimated_frame_language_share", "summary", "size", "fixed_not_found")}, indent=1))

if __name__ == "__main__":
    main()
