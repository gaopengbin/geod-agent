"""Temporarily isolate the two exact app profiles, with recoverable directory moves."""
import argparse
import json
import os
from pathlib import Path
import uuid

ROOT = Path(__file__).resolve().parents[1]
IDENTIFIER = "dev.geod-agent.desktop"
parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=["isolate", "restore"])
parser.add_argument("output")
args = parser.parse_args()
output = Path(args.output).resolve()
if not output.is_relative_to(ROOT / "artifacts") or not output.name.startswith("release-candidate-"):
    raise SystemExit("Profile evidence must stay in the release candidate artifacts directory")
state_file = output / "profiles.json"


def save(state):
    temporary = state_file.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2), encoding="utf-8")
    temporary.replace(state_file)


def checked(entry):
    expected = Path(os.environ["USERPROFILE"]) / "AppData" / entry["kind"] / IDENTIFIER
    source = Path(entry["source"])
    backup = Path(entry["backup"])
    archived = Path(entry["archived"])
    if source.resolve() != expected.resolve() or backup.parent.resolve() != expected.parent.resolve():
        raise SystemExit("Profile source/backup is outside the exact application directory")
    if not backup.name.startswith(IDENTIFIER + ".qa-backup-") or archived.parent.resolve() != expected.parent.resolve() or not archived.name.startswith(IDENTIFIER + ".qa-result-"):
        raise SystemExit("Refusing an unrecognized profile move destination")
    if source.is_symlink() or backup.is_symlink():
        raise SystemExit("Profile directories must not be symlinks")
    return source, backup, archived


def restore(state):
    for entry in state["profiles"]:
        source, backup, archived = checked(entry)
        if entry.get("restored"):
            continue
        if not entry.get("qaArchived"):
            if source.exists():
                if archived.exists():
                    raise SystemExit("Preserve the existing archived QA profile before retrying")
                archived.parent.mkdir(parents=True, exist_ok=True)
                source.rename(archived)
            entry["qaArchived"] = True
            save(state)
        if entry.get("backedUp"):
            if source.exists() or not backup.exists():
                raise SystemExit("The original profile backup cannot be restored safely")
            backup.rename(source)
        entry["restored"] = True
        save(state)
    state["phase"] = "restored"
    save(state)
    print("Original application profiles restored; QA profiles retained separately")


if args.mode == "restore":
    state = json.loads(state_file.read_text(encoding="utf-8"))
    # Recover plans written by the earlier cross-volume archive implementation.
    for entry in state["profiles"]:
        old_archive = output / "profile-results" / state["run"] / entry["kind"]
        if Path(entry["archived"]).resolve() == old_archive.resolve() and not old_archive.exists():
            entry["archived"] = str(Path(entry["source"]).with_name(IDENTIFIER + ".qa-result-" + state["run"]))
    save(state)
    restore(state)
else:
    if state_file.exists() and json.loads(state_file.read_text())["phase"] != "restored":
        raise SystemExit("Restore the previous isolated profiles before starting another run")
    run = uuid.uuid4().hex
    profiles = []
    for kind in ["Roaming", "Local"]:
        source = Path(os.environ["USERPROFILE"]) / "AppData" / kind / IDENTIFIER
        profiles.append({"kind": kind, "source": str(source),
                         "backup": str(source.with_name(IDENTIFIER + ".qa-backup-" + run)),
                         "archived": str(source.with_name(IDENTIFIER + ".qa-result-" + run)),
                         "hadOriginal": source.exists(), "backedUp": False})
    state = {"phase": "preparing", "run": run, "profiles": profiles}
    save(state)
    try:
        for entry in profiles:
            source, backup, _ = checked(entry)
            if source.exists():
                if backup.exists():
                    raise SystemExit("Preserve the original backup directory")
                source.rename(backup)
                entry["backedUp"] = True
                save(state)
        state["phase"] = "isolated"
        save(state)
        print("Two exact application profiles isolated; original data preserved in recoverable backups")
    except BaseException:
        # No app has been launched yet. Restore only successfully moved originals.
        for entry in profiles:
            source, backup, _ = checked(entry)
            if entry["backedUp"] and not source.exists() and backup.exists():
                backup.rename(source)
                entry["restored"] = True
        state["phase"] = "restored"
        save(state)
        raise
