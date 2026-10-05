"""Post-build review of an existing local candidate; never install or publish."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import update_signing_vault as vault
import importlib.util

spec = importlib.util.spec_from_file_location("signed_builder", Path(__file__).with_name("build-signed-update-candidate.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def sha(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def source_provenance(reference, logs):
    frozen = json.loads((reference / "source-freeze.json").read_text(encoding="utf-8"))
    names = subprocess.check_output(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=vault.ROOT, env=vault.public_environment()).decode().split("\0")
    prefixes = ("apps/geod-agent-desktop/", "crates/", "packages/", "vendor/")
    relevant = lambda name: name.startswith(prefixes) or name in ("Cargo.toml", "Cargo.lock", "LICENSE")
    names = sorted(set(name for name in names if name and relevant(name)) | {name for name in frozen["files"] if relevant(name)})
    files = {}
    for name in names:
        file = vault.ROOT / name
        current = sha(file) if file.is_file() else None
        previous = frozen["files"].get(name)
        files[name] = {"sha256": current, "referenceSha256": previous, "matchesReference": current == previous}
    from release_inventory import inventory, runtime_directories
    verified = inventory(vault.ROOT)
    reference_candidate = json.loads((reference / "candidate.json").read_text(encoding="utf-8"))
    runtimes = {}
    for source, name in runtime_directories(vault.ROOT):
        manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
        runtime_files = {str((source / key).relative_to(vault.ROOT)).replace("\\", "/"): entry["sha256"] if isinstance(entry, dict) else entry for key, entry in manifest["files"].items()}
        runtimes[name] = {"verified": verified["runtimes"][name], "reference": reference_candidate["runtimeVerification"][name],
                          "matchesReference": verified["runtimes"][name] == reference_candidate["runtimeVerification"][name], "actualVerifiedInputSha256": runtime_files}
    names = ("build-signed-update-candidate.py", "build-release-candidate.py", "update_signing_vault.py",
             "sign-update-candidate.py", "sign_update_candidate_for_tests.py")
    scripts = {file.relative_to(vault.ROOT).as_posix(): sha(file) for file in
               [Path(__file__).resolve(), *(Path(__file__).with_name(name).resolve() for name in names)]}
    run_freeze = logs / "source-freeze.json"
    frozen_run = json.loads(run_freeze.read_text(encoding="utf-8")) if run_freeze.exists() else None
    script_comparison = {name: {"sha256": digest, "preBuildSha256": frozen_run["files"].get(name) if frozen_run else None,
                               "matchesPreBuildSnapshot": frozen_run["files"].get(name) == digest if frozen_run else None,
                               "usedForCandidateBuild": builder.build_input(name)} for name, digest in scripts.items()}
    return {"recordedAt": datetime.now(timezone.utc).isoformat(), "recordKind": "post-build current-input comparison",
            "reference": str(reference), "referenceGitHead": frozen["gitHead"], "productInputs": files, "runtimeInputs": runtimes,
            "productInputsMatchReference": all(item["matchesReference"] for item in files.values()),
            "runtimeInputsMatchReference": all(item["matchesReference"] for item in runtimes.values()),
            "reviewScriptSha256": scripts, "reviewScriptsArePostBuildVersion": True,
            "loadedLauncherSourceSnapshotAvailable": frozen_run is not None,
            "repositorySourceSnapshotTakenBeforeBuild": frozen_run is not None,
            "allSourcesIncludingExternalDependencyCachesFrozenBeforeBuild": False,
            "preBuildSourceFreeze": str(run_freeze) if frozen_run else None,
            "preBuildSourceFreezeSha256": sha(run_freeze) if frozen_run else None,
            "reviewScriptsMatchPreBuildSnapshot": all(frozen_run["files"].get(name) == digest for name, digest in scripts.items()) if frozen_run else None,
            "reviewScriptComparison": script_comparison,
            "buildExecutionScriptsMatchPreBuildSnapshot": all(item["matchesPreBuildSnapshot"] for item in script_comparison.values() if item["usedForCandidateBuild"]) if frozen_run else None,
            "loadedLauncherBoundary": "Repository and build script hashes were recorded before this build; this audit is a separate post-build phase." if frozen_run else "This build loaded the implementation before wrapped-key normalization, final log scanning and structured-failure fixes; no pre-build source snapshot was available."}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--logs", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    candidate, logs, output = args.candidate.resolve(), args.logs.resolve(), args.output.resolve()
    if any(not path.is_relative_to(vault.ROOT / "artifacts") for path in (candidate, logs, output)) or output.exists():
        raise ValueError("Use existing local evidence and a fresh review output directory")
    config = json.loads((vault.ROOT / "artifacts/update-candidate-0.2.2-20261005/build-public-config.json").read_text(encoding="utf-8"))
    record, public = vault.candidate_key()
    values = builder.private_values(record)
    verification = builder.verify_built_candidate(candidate, public, config, builder.frozen_assets(), values)
    builder.verify_logs(logs, values)
    manifest = json.loads((candidate / "candidate.json").read_text(encoding="utf-8"))
    installer = candidate / f"GeoD Agent_{manifest['version']}_x64-setup.exe"
    receipt = {"passed": True, "installer": installer.name, "version": manifest["version"], "bytes": installer.stat().st_size,
               "sha256": sha(installer), "publicKeyFingerprint": public["publicKeyFingerprint"],
               "privateKeyPersistedAsPlaintext": False, "installerAlreadyEmbedsChannel": True, "requiresSignedChannelBuild": False,
               "installed": False, "published": False, "channelActivated": False, "reviewVerification": verification}
    for name, data in [("build-public-config.json", config), ("signing-public.json", public), ("signing-receipt.json", receipt)]:
        file = candidate / name
        if file.exists():
            if json.loads(file.read_text(encoding="utf-8")) != data:
                raise ValueError("Existing public candidate metadata differs; it was preserved")
        else:
            with file.open("x", encoding="utf-8") as stream:
                json.dump(data, stream, indent=2)
    builder.verify_logs(candidate, values)
    provenance = source_provenance(vault.ROOT / "artifacts/release-candidate-0.2.2-credits-20261004", logs)
    output.mkdir(parents=True, exist_ok=False)
    (output / "source-provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    (output / "result.json").write_text(json.dumps({"passed": True, "postBuildOnly": True, "reviewedAt": datetime.now(timezone.utc).isoformat(),
                                                    "candidate": str(candidate), "logs": str(logs), "correctedScannerVerifiedCandidateAndLogs": True,
                                                    "verification": verification, "productInputsMatchReference": provenance["productInputsMatchReference"],
                                                    "runtimeInputsMatchReference": provenance["runtimeInputsMatchReference"],
                                                    "installed": False, "published": False, "channelActivated": False}, indent=2), encoding="utf-8")
    print(json.dumps({"passed": True, "postBuildOnly": True, "reviewReceipt": str(output / "result.json"),
                      "productInputsMatchReference": provenance["productInputsMatchReference"], "runtimeInputsMatchReference": provenance["runtimeInputsMatchReference"]}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        raise SystemExit(str(error))
