"""Read public upstream manifests; never install or execute plugin contents."""
import json
from pathlib import Path
from urllib.request import Request, urlopen

root = Path("artifacts/product-gaps-20261004/plugin-marketplaces/research")
root.mkdir(parents=True, exist_ok=True)

def read(url):
    request = Request(url, headers={"User-Agent": "GeoD-Agent-Research", "Accept": "application/vnd.github+json"})
    with urlopen(request, timeout=35) as response:
        return json.loads(response.read(3 * 1024 * 1024).decode("utf-8"))

for repository in ("openai/plugins", "openai/community-plugins"):
    sha = read(f"https://api.github.com/repos/{repository}/commits/HEAD")["sha"]
    tree = read(f"https://api.github.com/repos/{repository}/git/trees/{sha}?recursive=1")
    paths = {entry["path"] for entry in tree["tree"]}
    catalog = read(f"https://raw.githubusercontent.com/{repository}/{sha}/.agents/plugins/marketplace.json")
    selected = []
    for item in catalog["plugins"]:
        plugin_root = item["source"].get("path", "").removeprefix("./")
        manifests = [f"{plugin_root}/{name}" for name in ("plugin.json", ".codex-plugin/plugin.json", ".mcp.json", "mcp.json", ".app.json") if f"{plugin_root}/{name}" in paths]
        skills = [p for p in paths if p.startswith(plugin_root + "/") and p.endswith("/SKILL.md")]
        summary = {"name": item["name"], "path": plugin_root, "files": len([p for p in paths if p.startswith(plugin_root + "/")]), "skills": skills, "manifestPaths": manifests}
        if repository.endswith("community-plugins") or item["name"] in ("openai-developers", "skill-creator", "frontend-design", "linear", "figma"):
            summary["manifests"] = {p: read(f"https://raw.githubusercontent.com/{repository}/{sha}/{p}") for p in manifests}
        selected.append(summary)
    receipt = {"repository": repository, "commit": sha, "catalog": catalog, "entries": selected}
    (root / (repository.split("/")[1] + ".json")).write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"repository": repository, "commit": sha, "entryCount": len(selected), "selected": [p for p in selected if "manifests" in p]}, ensure_ascii=False))
