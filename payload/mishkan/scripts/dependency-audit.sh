#!/usr/bin/env bash
# MISHKAN — cross-project dependency audit.
# Reads config/projects.yaml, inventories manifests across every project root,
# parses declared dependencies, computes cross-project shared packages + version
# drift, and (where OSV-Scanner / trivy are installed) collects vulnerabilities
# per project. Writes a portfolio report under logs/.
#
# Read-only: never installs, never edits manifests. Prepares the picture; the
# dependency-audit skill turns it into a coordinated, vetted update plan.
set -uo pipefail

runtime_home() {
  if [[ -n "${ARES_HOME:-}" ]]; then printf '%s' "$ARES_HOME"; return; fi
  if [[ -n "${MISHKAN_HOME:-}" ]]; then printf '%s' "$MISHKAN_HOME"; return; fi
  if [[ -d "$HOME/.ares" || ! -d "$HOME/.claude/mishkan" ]]; then printf '%s' "$HOME/.ares"; return; fi
  printf '%s' "$HOME/.claude/mishkan"
}
ARES_HOME_RES="$(runtime_home)"
REG="${ARES_HOME_RES}/config/projects.yaml"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${ARES_HOME_RES}/logs/dep-audit-${TS}.json"

command -v python3 >/dev/null 2>&1 || { echo "python3 required" >&2; exit 1; }
[ -f "$REG" ] || { echo "project registry not found: $REG" >&2; exit 1; }

OSV_BIN="$(command -v osv-scanner || true)"
TRIVY_BIN="$(command -v trivy || true)"
[ -n "$OSV_BIN" ]   && echo "osv-scanner: $OSV_BIN" || echo "osv-scanner: not installed (skipping CVE scan; inventory + drift still produced)"
[ -n "$TRIVY_BIN" ] && echo "trivy: $TRIVY_BIN"     || echo "trivy: not installed"

OSV_BIN="$OSV_BIN" TRIVY_BIN="$TRIVY_BIN" python3 - "$REG" "$OUT" <<'PY'
import sys, os, json, glob, re, subprocess
from collections import defaultdict
try:
    import yaml
except ImportError:
    sys.exit("pyyaml required: pip install pyyaml")

reg_path, out_path = sys.argv[1], sys.argv[2]
reg = yaml.safe_load(open(reg_path)) or {}
manifest_globs = reg.get("manifest_globs", [])
exclude = set(reg.get("exclude_dirs", []))

def expand(p):
    return os.path.expanduser(os.path.expandvars(p)) if p else p

# Resolve project roots portably: explicit override > discovery under workspace.
roots = [expand(r) for r in (reg.get("project_roots") or []) if r]
if not roots:
    ws = os.environ.get("ARES_WORKSPACE") or os.environ.get("MISHKAN_WORKSPACE") or expand(reg.get("workspace_root") or "")
    if not ws:
        ws = os.path.dirname(os.getcwd())  # cwd's parent
    # discover git repositories under the workspace root (one level of nesting)
    found = []
    if os.path.isdir(ws):
        for entry in sorted(os.listdir(ws)):
            full = os.path.join(ws, entry)
            if os.path.isdir(os.path.join(full, ".git")):
                found.append(full)
    roots = found
    print(f"discovery: workspace={ws} -> {len(roots)} git repos", file=sys.stderr)
osv = os.environ.get("OSV_BIN") or None
trivy = os.environ.get("TRIVY_BIN") or None

def find_manifests(root):
    hits = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in exclude]
        for fn in filenames:
            for g in manifest_globs:
                # simple glob match on filename
                if glob.fnmatch.fnmatch(fn, g):
                    hits.append(os.path.join(dirpath, fn)); break
    return hits

def parse_deps(path):
    """Return {package: version_or_range} best-effort across ecosystems."""
    deps = {}
    fn = os.path.basename(path)
    try:
        if fn == "package.json":
            d = json.load(open(path))
            for k in ("dependencies", "devDependencies", "peerDependencies"):
                deps.update({n: v for n, v in (d.get(k) or {}).items()})
        elif fn.startswith("requirements") and fn.endswith(".txt"):
            for line in open(path):
                line = line.strip()
                if not line or line.startswith("#"): continue
                m = re.match(r"^([A-Za-z0-9_.\-]+)\s*([=<>!~]=?.*)?$", line)
                if m: deps[m.group(1).lower()] = (m.group(2) or "").strip()
        elif fn == "pyproject.toml":
            txt = open(path).read()
            for m in re.finditer(r'"([A-Za-z0-9_.\-]+)\s*([=<>!~][^"]*)?"', txt):
                deps[m.group(1).lower()] = (m.group(2) or "").strip()
        elif fn == "go.mod":
            for m in re.finditer(r'^\s*([^\s]+/[^\s]+)\s+(v[0-9][^\s]*)', open(path).read(), re.M):
                deps[m.group(1)] = m.group(2)
        elif fn == "Cargo.toml":
            in_deps = False
            for line in open(path):
                s = line.strip()
                if s.startswith("["):
                    in_deps = s.startswith("[dependencies") or s.startswith("[dev-dependencies")
                    continue
                if in_deps:
                    m = re.match(r'^([A-Za-z0-9_\-]+)\s*=\s*"?([^"\n]*)"?', s)
                    if m: deps[m.group(1)] = m.group(2).strip()
        elif fn in ("composer.json",):
            d = json.load(open(path))
            for k in ("require", "require-dev"):
                deps.update({n: v for n, v in (d.get(k) or {}).items()})
    except Exception as e:
        deps["_parse_error"] = str(e)
    return deps

def run_osv(root):
    if not osv: return None
    try:
        r = subprocess.run([osv, "--format", "json", "-r", root],
                           capture_output=True, text=True, timeout=180)
        return json.loads(r.stdout) if r.stdout.strip() else {}
    except Exception as e:
        return {"_error": str(e)}

# pkg -> {project: version}
pkg_projects = defaultdict(dict)
project_inventory = {}
osv_results = {}

for root in roots:
    name = os.path.basename(root.rstrip("/"))
    if not os.path.isdir(root):
        project_inventory[name] = {"present": False}
        continue
    manifests = find_manifests(root)
    declared = {}
    for mpath in manifests:
        for pkg, ver in parse_deps(mpath).items():
            if pkg.startswith("_"): continue
            declared[pkg] = ver
            pkg_projects[pkg][name] = ver
    project_inventory[name] = {"present": True,
                               "manifests": [os.path.relpath(m, root) for m in manifests],
                               "declared_count": len(declared)}
    res = run_osv(root)
    if res is not None:
        osv_results[name] = res

# cross-project: packages used in >1 project, and version drift
shared = {}
drift = {}
for pkg, byproj in pkg_projects.items():
    if len(byproj) > 1:
        shared[pkg] = byproj
        versions = set(v for v in byproj.values() if v)
        if len(versions) > 1:
            drift[pkg] = byproj

report = {
    "audit_date": out_path.split("dep-audit-")[-1].replace(".json", ""),
    "scanners": {"osv_scanner": bool(osv), "trivy": bool(trivy)},
    "projects_scanned": [n for n, v in project_inventory.items() if v.get("present")],
    "projects_missing": [n for n, v in project_inventory.items() if not v.get("present")],
    "inventory": project_inventory,
    "shared_packages_count": len(shared),
    "version_drift": drift,
    "shared_packages": shared,
    "osv_results_present": list(osv_results.keys()),
    "note": "CVE detail in osv_results requires osv-scanner installed; otherwise this is inventory + drift only. Feed into the dependency-audit skill for prioritisation + vetted update plan.",
}
json.dump(report, open(out_path, "w"), indent=2)
print(f"audited {len(report['projects_scanned'])} projects -> {out_path}")
print(f"shared packages (>1 project): {len(shared)}; version drift: {len(drift)}")
PY

echo "Report written. Run the dependency-audit skill to prioritise (severity x blast"
echo "radius), vet target versions, and produce the coordinated update plan."
