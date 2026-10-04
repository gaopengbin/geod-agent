"""Tie packaged executables to a successful ordinary Tauri build."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

IDENTIFIER = "dev.geod-agent.desktop"
PRODUCT = "GeoD Agent"
STAMP = "geod-release-build.json"


def sha(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def source_config(native):
    config = json.loads((Path(native) / "tauri.conf.json").read_text(encoding="utf-8"))
    if config["identifier"] != IDENTIFIER or config["productName"] != PRODUCT:
        raise ValueError("An ordinary candidate requires the GeoD Agent application identifier and product name.")
    if any(window.get("url") not in (None, "index.html") for window in config["app"]["windows"]):
        raise ValueError("An ordinary candidate must use the embedded frontend.")
    return config


def release_environment(env):
    # These inputs are useful for dev/isolated QA but must not become the
    # compile-time fallback identity of the distributed hosted-model product.
    return {key: value for key, value in env.items() if key not in {
        "TAURI_CONFIG", "GEOD_AGENT_IDENTITY_ORIGIN", "GEOD_AGENT_GATEWAY_ORIGIN",
        "GEOD_AGENT_DEV_GATEWAY_ORIGIN", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    }}


def write_stamp(native, release):
    native, release = Path(native), Path(release)
    config = source_config(native)
    version = config["version"]
    executable = release / "geod-agent-desktop.exe"
    installer = release / "bundle/nsis" / f"{PRODUCT}_{version}_x64-setup.exe"
    record = {"at": datetime.now(timezone.utc).isoformat(), "identifier": IDENTIFIER,
              "productName": PRODUCT, "version": version,
              "configSha256": sha(native / "tauri.conf.json"),
              "mainExecutableSha256": sha(executable), "installerSha256": sha(installer),
              "installerName": installer.name, "embeddedFrontend": True}
    (release / STAMP).write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record


def verify_stamp(native, release):
    native, release = Path(native), Path(release)
    config = source_config(native)
    try:
        record = json.loads((release / STAMP).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError("Build an ordinary candidate before packaging; its build receipt is missing or invalid.") from error
    installer = f"{PRODUCT}_{config['version']}_x64-setup.exe"
    expected = {"identifier": IDENTIFIER, "productName": PRODUCT, "version": config["version"],
                "configSha256": sha(native / "tauri.conf.json"), "embeddedFrontend": True,
                "installerName": installer,
                "mainExecutableSha256": sha(release / "geod-agent-desktop.exe"),
                "installerSha256": sha(release / "bundle/nsis" / installer)}
    if any(record.get(key) != value for key, value in expected.items()):
        raise ValueError("Executable, installer or application config differs from the ordinary build receipt. Rebuild before packaging.")
    return record
