"""Read-only relay preflight. Require a GeoD-specific key before paid testing.

The key is process-only; no key, prompts, responses or token-bearing HTTP
headers are saved. The owned pinned SSH tunnel is always closed.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.request import build_opener, ProxyHandler, Request

ROOT = Path(__file__).resolve().parents[1]
MODELS = {
    "claude-sonnet-5": "anthropic",
    "gpt-5.6-terra": "responses",
    "gemini-3.7-flash": "chatCompletions",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-key-name", default="geod-agent-qa")
    parser.add_argument("--port", type=int, default=19094)
    parser.add_argument("--native-tool-loop", action="store_true",
                        help="After explicit authorization, run paid native tool/recall checks")
    args = parser.parse_args()
    key = os.environ.get("GEOD_QA_RELAY_KEY")
    if not key:
        raise SystemExit("GEOD_QA_RELAY_KEY is required; no global key fallback is permitted")
    if not args.expected_key_name.startswith("geod-agent-"):
        raise SystemExit("The expected downstream key must identify this project")
    if not 1024 <= args.port <= 65535:
        raise SystemExit("Choose an unprivileged local tunnel port")
    root = ROOT / "artifacts/relay-provider-acceptance-20261005" / ("preflight-" + secrets.token_hex(8))
    root.mkdir(parents=True, exist_ok=False)
    home = Path.home()
    skill = home / ".codex/skills/laogao-tencent-deploy"
    argv = ["ssh.exe", "-N", "-i", str(home / ".ssh/laogao_tencent_ed25519"),
            "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no",
            "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + str(skill / "references/known_hosts"),
            "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=15",
            "-L", f"127.0.0.1:{args.port}:127.0.0.1:9094", "ubuntu@62.234.147.130"]
    # ExitOnForwardFailure rejects occupied ports; never reuse another tunnel.
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    base = f"http://127.0.0.1:{args.port}"
    opener = build_opener(ProxyHandler({}))
    report = {"passed": False, "startedAt": datetime.now(timezone.utc).isoformat(),
              "encryptedTunnel": True, "paidGeneration": False, "serverModified": False,
              "serverConfigurationModified": False, "nativeRequested": args.native_tool_loop,
              "requestedKeyName": args.expected_key_name, "tunnelPid": child.pid}

    def read(path, authenticated=False):
        headers = {"Authorization": "Bearer " + key} if authenticated else {}
        with opener.open(Request(base + path, headers=headers), timeout=20) as response:
            raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise ValueError("RELAY_RESPONSE_LIMIT")
            return json.loads(raw)

    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise ValueError("PINNED_TUNNEL_EXITED")
            try:
                status = read("/api/status").get("data", {})
                break
            except (URLError, TimeoutError):
                time.sleep(.5)
        else:
            raise ValueError("PINNED_TUNNEL_NOT_READY")
        metadata = read("/api/usage/token", authenticated=True).get("data", {})
        report["actualKeyName"] = metadata.get("name")
        if metadata.get("name") != args.expected_key_name:
            raise ValueError("PROJECT_KEY_SCOPE_MISMATCH")
        report["quotaIsUnlimited"] = metadata.get("unlimited_quota")
        if metadata.get("unlimited_quota") is not False:
            raise ValueError("QA_KEY_REQUIRES_FINITE_QUOTA")
        expires = metadata.get("expires_at", 0)
        if not isinstance(expires, (int, float)) or not time.time() < expires <= time.time() + 86400:
            raise ValueError("QA_KEY_REQUIRES_EXPIRY_WITHIN_24_HOURS")
        remaining = metadata.get("total_available")
        quota_per_unit = status.get("quota_per_unit")
        if not isinstance(quota_per_unit, (int, float)) or quota_per_unit <= 0:
            raise ValueError("RELAY_QUOTA_CONVERSION_UNAVAILABLE")
        if not isinstance(remaining, (int, float)) or not 0 < remaining <= quota_per_unit:
            raise ValueError("QA_KEY_QUOTA_OUTSIDE_APPROVED_ONE_USD_CEILING")
        used = metadata.get("total_used")
        if not isinstance(used, (int, float)) or used < 0 or used + remaining > quota_per_unit:
            raise ValueError("QA_KEY_TOTAL_QUOTA_OUTSIDE_APPROVED_ONE_USD_CEILING")
        report.update(quotaRemaining=remaining, quotaUsedBefore=used, quotaPerUsd=quota_per_unit, expiresAt=expires)
        actual = {model["id"] for model in read("/v1/models", authenticated=True).get("data", [])}
        pricing = {row["model_name"]: row for row in read("/api/pricing").get("data", [])}
        rows = []
        for model, protocol in MODELS.items():
            if model not in actual or model not in pricing:
                raise ValueError("QA_MODEL_OR_CURRENT_PRICE_UNAVAILABLE")
            row = pricing[model]
            if row.get("quota_type") != 0:
                raise ValueError("QA_MODEL_REQUIRES_TOKEN_PRICING")
            rows.append({"model": model, "protocolToVerify": protocol,
                         "currentPrice": {name: row.get(name) for name in
                                          ("model_ratio", "completion_ratio", "cache_ratio", "create_cache_ratio")},
                         "advertisedEndpointTypes": row.get("supported_endpoint_types", [])})
        report.update(passed=True, models=rows, modelCount=len(actual),
                      protocolCallsVerified=False, providerIdentityVerified=False,
                      ordinaryCandidateInstalled=False)
        if args.native_tool_loop:
            # Expose only the reviewed scoped key to the verification process.
            # No global key fallback or provider-protocol fallback is allowed.
            (root / "result.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            environment = dict(os.environ, GEOD_QA_RELAY_BASE=base, GEOD_QA_RELAY_KEY=key)
            for name in ("LAOGAO_API_KEY", "DEEPSEEK_API_KEY", "GEOD_QA_DEEPSEEK_KEY",
                         "METAPI_ADMIN_TOKEN", "LITELLM_MASTER_KEY", "DEBUG", "NODE_DEBUG", "PWDEBUG"):
                environment.pop(name, None)
            report.update(passed=False, paidGeneration=None, serverModified=None, nativeStarted=True)
            with (root / "native-controller.log").open("w", encoding="utf-8") as log:
                native = subprocess.run(["node", str(ROOT / "scripts/verify-relay-native.mjs"), str(root)],
                                        cwd=ROOT, env=environment, stdin=subprocess.DEVNULL,
                                        stdout=log, stderr=subprocess.STDOUT,
                                        creationflags=subprocess.CREATE_NO_WINDOW)
            report["nativeExitCode"] = native.returncode
            after = read("/api/usage/token", authenticated=True).get("data", {})
            if after.get("name") != args.expected_key_name or after.get("unlimited_quota") is not False:
                raise ValueError("QA_KEY_CHANGED_DURING_NATIVE_VERIFICATION")
            after_used = after.get("total_used")
            if not isinstance(after_used, (int, float)) or not used <= after_used <= quota_per_unit:
                raise ValueError("QA_KEY_USAGE_OUTSIDE_APPROVED_CEILING")
            report.update(quotaUsedAfter=after_used, paidGeneration=after_used > used,
                          serverModified=after_used > used, serverModificationScope="relay usage ledger only")
            violations, checked = [], 0
            scan_roots = [root, Path(os.environ["APPDATA"]) / "dev.geod-agent.desktop/ai-channels"]
            ownership_path = root / "native-ownership.json"
            if ownership_path.exists():
                ownership = json.loads(ownership_path.read_text(encoding="utf-8"))
                native_root = Path(os.environ["APPDATA"]) / "dev.geod-agent.desktop/codex-runtime"
                account = native_root / ("account-" + hashlib.sha256(ownership["owner"].encode()).hexdigest())
                scan_roots.extend(account / ("conversation-" + hashlib.sha256(f["id"].encode()).hexdigest()[:16])
                                  for f in ownership["fixtures"])
            needle = key.encode()
            for scan_root in scan_roots:
                if not scan_root.exists():
                    continue
                for directory, directories, files in os.walk(scan_root):
                    directories[:] = [name for name in directories if name not in ("node_modules", ".git", "cache")]
                    for name in files:
                        file = Path(directory) / name
                        if file.is_symlink():
                            continue
                        with file.open("rb") as stream:
                            checked += 1
                            tail = b""
                            while block := stream.read(65536):
                                joined = tail + block
                                if needle in joined:
                                    violations.append(str(file))
                                    break
                                tail = joined[-len(needle):]
            audit = {"passed": not violations, "filesChecked": checked, "plaintextCredentialFiles": violations}
            (root / "credential-audit.json").write_text(json.dumps(audit, indent=2), encoding="utf-8")
            if violations:
                raise ValueError("PLAINTEXT_TEST_CREDENTIAL_FOUND")
            native_result_path = root / "native-result.json"
            native_result = json.loads(native_result_path.read_text(encoding="utf-8")) if native_result_path.exists() else {}
            if native.returncode != 0 or native_result.get("passed") is not True:
                raise ValueError("NATIVE_RELAY_VERIFICATION_FAILED")
            report.update(passed=True, protocolCallsVerified=True, nativePassed=True,
                          officialProvidersVerified=False, credentialAuditPassed=True)
    except (ValueError, HTTPError, URLError, TimeoutError, json.JSONDecodeError, OSError,
            subprocess.SubprocessError) as error:
        # Exception text from an HTTP client may contain a response; retain only
        # fixed local codes or the HTTP status, never response bodies/headers.
        report["passed"] = False
        report["errorCode"] = str(error) if type(error) is ValueError else type(error).__name__
        if isinstance(error, HTTPError):
            report["httpStatus"] = error.code
    finally:
        if child.poll() is None:
            child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
        report.update(ownedTunnelClosed=True, finishedAt=datetime.now(timezone.utc).isoformat())
        (root / "result.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps({"passed": report["passed"], "errorCode": report.get("errorCode"),
                          "paidGeneration": report["paidGeneration"], "serverModified": report["serverModified"],
                          "ownedTunnelClosed": True, "output": str(root)}), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
