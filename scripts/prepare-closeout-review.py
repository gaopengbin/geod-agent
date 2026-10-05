"""Verify fixed local 0.2.2 files and write a review manifest; never publish."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
WINDOWS = ROOT / "artifacts/release-candidate-0.2.2-bilingual-installer-20261005"
GATEWAY = ROOT / "artifacts/gateway-release-0.2.2-payment-history-20261005"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def receipt(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    assert value["passed"], "Receipt failed: " + str(path)
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schedule-run", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/release-review-0.2.2-20261005")
    args = parser.parse_args()
    output = args.output.resolve()
    assert output.is_relative_to((ROOT / "artifacts").resolve())
    assert not output.exists(), "Use a fresh review directory; preserve earlier evidence"
    run = args.schedule_run.resolve()
    payload = json.loads((run / "payload.json").read_text(encoding="utf-8"))
    assert run.name.startswith("fixture-") and payload["qaExecutableSha256"]
    schedule = receipt(run / "result.json")
    assert schedule["runtimeChecksPassed"] and schedule["cleanupPassed"]
    assert schedule["qaExecutableSha256"] == payload["qaExecutableSha256"]
    assert digest(run / "target/release/geod-agent-desktop.exe") == payload["qaExecutableSha256"]
    assert schedule["repeatSeconds"] == 1800 and len(schedule["completedRuns"]) == 11
    assert schedule["elapsedSeconds"] >= 12600
    receipt(run / "cleanup.json")
    receipt(run / "child-process-cleanup.json")
    receipt(run / "credential-audit.json")
    usage = receipt(run / "usage-ledger.json")
    assert usage["integrityCheck"] == "ok"
    for key in ["inputTokens", "outputTokens"]:
        assert usage[key] == schedule["total" + key[0].upper() + key[1:]]

    candidate = json.loads((WINDOWS / "candidate.json").read_text(encoding="utf-8"))
    assert candidate["version"] == "0.2.2" and not candidate["installed"] and not candidate["published"]
    entries = []
    for name, expected in candidate["artifacts"].items():
        file = (WINDOWS / name).resolve()
        assert file.parent == WINDOWS.resolve()
        actual = {"bytes": file.stat().st_size, "sha256": digest(file)}
        assert actual == expected, "Distribution artifact changed: " + name
        entries.append({"name": name, "path": str(file), **actual})
    gateway_file = GATEWAY / "geod-agent-gateway-0.2.2-linux-x64.tar.gz"
    gateway_hash = digest(gateway_file)
    migration_path = ROOT / "artifacts/gateway-payment-history-migration-20261005-retry1/archive-roundtrip-retry2/result.json"
    migration = receipt(migration_path)
    assert gateway_hash == migration["newArchiveSha256"]
    assert migration["balancePreserved"] and migration["legacyRowsPreserved"] and migration["testContainerRemoved"]
    assert not migration["productionModified"] and not migration["realFundsUsed"]
    entries.append({"name": gateway_file.name, "path": str(gateway_file), "bytes": gateway_file.stat().st_size, "sha256": gateway_hash})
    signature = WINDOWS / "GeoD Agent_0.2.2_x64-setup.exe.sig"
    entries.append({"name": signature.name, "path": str(signature), "bytes": signature.stat().st_size, "sha256": digest(signature)})
    installer_hash = candidate["buildIdentity"]["installerSha256"]
    proof_paths = [
        ROOT / "artifacts/signed-bilingual-installer-build-20261005/result.json",
        ROOT / "artifacts/bilingual-installer-post-build-review-20261005/result.json",
        ROOT / "artifacts/bilingual-installer-sdk-acceptance-20261005/result.json",
        ROOT / "artifacts/bilingual-installer-ui-20261005/result.json",
        WINDOWS / "integrated-payload.json",
        GATEWAY / "archive-acceptance-58d7b29e22e445c4/result.json",
        migration_path,
    ]
    for file in proof_paths:
        value = receipt(file)
        if "installerSha256" in value:
            assert value["installerSha256"] == installer_hash
    latest = json.loads((WINDOWS / "latest.json").read_text(encoding="utf-8"))
    assert latest["version"] == "0.2.2"
    assert latest["platforms"]["windows-x86_64"]["signature"] == signature.read_text(encoding="utf-8").strip()
    frozen = json.loads((ROOT / "artifacts/signed-bilingual-installer-build-20261005/source-freeze.json").read_text(encoding="utf-8"))
    product_inputs = {name: sha for name, sha in frozen["files"].items()
                      if name.startswith(("apps/geod-agent-desktop/", "crates/", "packages/", "vendor/"))}
    for name, expected in product_inputs.items():
        file = (ROOT / name).resolve()
        assert file.is_relative_to(ROOT) and digest(file) == expected, "Frozen product source changed: " + name
    output.mkdir(parents=True)
    record = {"passed": True, "version": "0.2.2", "reviewedAt": datetime.now(timezone.utc).isoformat(),
              "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "artifacts": entries, "frozenProductInputsVerified": len(product_inputs),
              "evidence": [{"path": str(p), "sha256": digest(p)} for p in proof_paths + [run / "result.json", run / "cleanup.json", run / "usage-ledger.json"]],
              "readOnlyGatewayRoutes": ["GET /v1/payments/history/" + kind + suffix
                                        for kind in ["usage", "reservations", "orders", "refunds"]
                                        for suffix in ["", "/export.csv"]],
              "cashCheckoutEnabled": False, "pricesChanged": False, "sponsorUiVisible": False,
              "published": False, "installed": False, "productionModified": False, "updateChannelActivated": False,
              "ordinaryBinaryUsedForScheduleTest": False,
              "remainingAcceptance": ["installer upgrade and rollback", "overnight background operation",
                                      "real system restart", "fresh Windows (deferred)", "production HTTPS switchover",
                                      "real cash callbacks and policy approval", "Windows Authenticode signing"]}
    (output / "release-review.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    (output / "SHA256SUMS.txt").write_text("".join(item["sha256"] + "  " + item["name"] + "\n" for item in entries), encoding="utf-8")
    print(json.dumps({"passed": True, "output": str(output), "artifacts": len(entries), "frozenProductInputsVerified": len(product_inputs), "published": False}))


if __name__ == "__main__":
    main()
