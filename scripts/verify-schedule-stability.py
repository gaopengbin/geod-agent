"""Run bounded native schedule endurance in an isolated, existing QA identity.

The shipping executable, user profile, registry and production gateway are untouched.
Only an existing authorized DeepSeek credential is read into this process's memory.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[1]
QA_SHA256 = "4b5f8ca2b213090da27785d7fc17d01e67532742126273bb7c56b880c79bd885"
QA_IDENTIFIER = b"dev.geod-agent.credit-history-qa"


def audit_receipts(root):
    root = root.resolve()
    assert root.is_relative_to((REPO / "artifacts/schedule-stability-native-20261005").resolve())
    result = json.loads((root / "result.json").read_text(encoding="utf-8"))
    cleanup = json.loads((root / "cleanup.json").read_text(encoding="utf-8"))
    assert result["passed"] and cleanup["passed"]
    helper = REPO / "scripts/schedule-stability-support.py"

    def invoke(action, value):
        completed = subprocess.run([sys.executable, "-X", "utf8", str(helper), action], input=json.dumps(value),
                                   capture_output=True, encoding="utf-8", check=True)
        return json.loads(completed.stdout)

    ids = [item for run in result["completedRuns"] for item in run["generationIds"]]
    usage = invoke("usage-ledger", {"generationIds": ids})
    assert usage["inputTokens"] == result["totalInputTokens"]
    assert usage["outputTokens"] == result["totalOutputTokens"]
    (root / "usage-ledger.json").write_text(json.dumps(usage, indent=2), encoding="utf-8")
    observed = [child for sample in result["samples"] for child in sample["children"]]
    observed += [child for case in result["cases"] for child in case.get("descendantsAtCrash", [])]
    children = invoke("child-process-audit", {"observedChildren": observed})
    (root / "child-process-cleanup.json").write_text(json.dumps(children, indent=2), encoding="utf-8")
    assert children["passed"], "All observed QA model descendants must exit with their owner"
    return {"settledGenerations": usage["settledGenerationRows"], "childCleanupVerified": children["passed"]}


def provider_key(existing):
    key = os.environ.get("GEOD_QA_DEEPSEEK_KEY") or os.environ.get("DEEPSEEK_API_KEY")
    if key or not existing:
        return key
    skill = Path.home() / ".codex/skills/laogao-tencent-deploy"
    result = subprocess.run([
        "ssh.exe", "-i", str(Path.home() / ".ssh/laogao_tencent_ed25519"),
        "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no",
        "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={skill / 'references/known_hosts'}",
        "-o", "ConnectTimeout=15", "ubuntu@62.234.147.130",
        "sudo cat /srv/laogao/secrets/geod-agent.env",
    ], capture_output=True, encoding="utf-8", timeout=30)
    if result.returncode:
        raise SystemExit("Existing authorized test credential unavailable; no remote changes made")
    for line in result.stdout.splitlines():
        name, separator, value = line.partition("=")
        if separator and name.strip() == "DEEPSEEK_API_KEY":
            key = value.strip().strip('"').strip("'")
    del result
    return key


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--existing-geod-config", action="store_true")
    parser.add_argument("--cycles", type=int, default=8)
    parser.add_argument("--offline-seconds", type=int, default=195)
    parser.add_argument("--audit-only", type=Path)
    args = parser.parse_args()
    if args.audit_only:
        print(json.dumps(audit_receipts(args.audit_only)))
        return 0
    assert 8 <= args.cycles <= 30, "Endurance must cover at least eight real intervals"
    assert 185 <= args.offline_seconds <= 600, "Actual downtime must miss at least three periods"
    key = provider_key(args.existing_geod_config)
    if not key:
        raise SystemExit("An existing authorized process-only test credential is required")
    controller = shutil.which("node.exe")
    assert controller, "Use the controller matching the local gateway's native SQLite addon"
    preflight = subprocess.run([controller, "-e", "const db=require('better-sqlite3')(':memory:');db.close();process.stdout.write(JSON.stringify({version:process.version,abi:process.versions.modules}));"],
                               cwd=REPO / "services/geod-agent-model-gateway", capture_output=True, encoding="utf-8", check=True)
    controller_metadata = json.loads(preflight.stdout)

    saved = REPO / "artifacts/credit-history-native-20261004/geod-agent-credit-history-QA.exe"
    data = saved.read_bytes()
    assert hashlib.sha256(data).hexdigest() == QA_SHA256
    assert QA_IDENTIFIER in data, "Never launch an ordinary application identity for this test"
    output = REPO / "artifacts/schedule-stability-native-20261005"
    root = output / ("fixture-" + secrets.token_hex(8))
    release = root / "target/release"
    release.mkdir(parents=True, exist_ok=False)
    executable = release / "geod-agent-desktop.exe"
    executable.write_bytes(data)
    runtime_source = REPO / "artifacts/release-candidate-0.2.2-credits-20261004/GeoD-Agent-0.2.2-windows-x64/codex-runtime"
    runtime = release / "codex-runtime"
    shutil.copytree(runtime_source, runtime)
    manifest = json.loads((runtime / "manifest.json").read_text(encoding="utf-8"))
    verified = 0
    for relative, item in manifest["files"].items():
        file = runtime / relative
        assert file.resolve().is_relative_to(runtime.resolve())
        assert hashlib.sha256(file.read_bytes()).hexdigest() == item["sha256"]
        verified += 1
    (root / "payload.json").write_text(json.dumps({
        "qaExecutableSha256": QA_SHA256, "identifier": QA_IDENTIFIER.decode(),
        "runtimeFilesVerified": verified, "shippingCandidateModified": False,
        "profile": "dev.geod-agent.credit-history-qa", "cycles": args.cycles,
        "offlineSeconds": args.offline_seconds, "systemClockModified": False,
        "controller": controller_metadata, "nativeEngineNodeVersion": manifest["nodeVersion"],
    }, indent=2), encoding="utf-8")
    env = dict(os.environ, GEOD_QA_DEEPSEEK_KEY=key,
               GEOD_QA_STABILITY_ROOT=str(root), GEOD_QA_STABILITY_CYCLES=str(args.cycles),
               GEOD_QA_STABILITY_OFFLINE_SECONDS=str(args.offline_seconds))
    started = time.time()
    child = subprocess.Popen([controller, "scripts/verify-schedule-stability.mjs"], cwd=REPO, env=env,
                             creationflags=subprocess.CREATE_NO_WINDOW, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, encoding="utf-8")
    with (root / "controller.log").open("w", encoding="utf-8") as log:
        for line in child.stdout:
            safe = line.replace(key, "[redacted]")
            log.write(safe)
            log.flush()
            print(safe, end="", flush=True)
    exit_code = child.wait()
    patterns = [key.encode(), key.encode("utf-16-le")]
    checked, violations = 0, []
    for base in [root, Path(os.environ["APPDATA"]) / "dev.geod-agent.credit-history-qa"]:
        for directory, directories, files in os.walk(base):
            directories[:] = [name for name in directories if name not in ["node_modules", ".git", "vendor", "codex-runtime"]]
            for name in files:
                file = Path(directory) / name
                try:
                    info = file.stat()
                    if info.st_size > 64 * 1024 * 1024 or (base != root and info.st_mtime < started):
                        continue
                    contents = file.read_bytes()
                except (PermissionError, FileNotFoundError):
                    continue
                checked += 1
                if any(pattern in contents for pattern in patterns):
                    violations.append(str(file))
    audit = {"passed": not violations, "filesChecked": checked, "plaintextCredentialFiles": violations}
    (root / "credential-audit.json").write_text(json.dumps(audit, indent=2), encoding="utf-8")
    print(json.dumps({"exitCode": exit_code, "output": str(root), "credentialAudit": audit}))
    if exit_code == 0 and not violations:
        print(json.dumps({"postRunAudit": audit_receipts(root)}), flush=True)
    return 1 if violations else exit_code


if __name__ == "__main__":
    sys.exit(main())
