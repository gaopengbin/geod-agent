"""Package only verified release outputs; never install or publish the app."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
from release_inventory import runtime_directories, verify_runtime

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / "apps/geod-agent-desktop/src-tauri/target/release"
VERSION = json.loads((ROOT / "apps/geod-agent-desktop/src-tauri/tauri.conf.json").read_text())["version"]


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


parser = argparse.ArgumentParser()
parser.add_argument("output")
args = parser.parse_args()
output = Path(args.output).resolve()
if not output.is_relative_to(ROOT / "artifacts") or not output.name.startswith("release-candidate-"):
    raise SystemExit("Candidate output must be a named release-candidate directory under artifacts")
installer = RELEASE / "bundle/nsis" / f"GeoD Agent_{VERSION}_x64-setup.exe"
if not installer.is_file():
    raise SystemExit("Build the candidate installer before packaging")
output.mkdir(parents=True, exist_ok=True)
bundle = output / f"GeoD-Agent-{VERSION}-windows-x64"
if bundle.exists():
    if (output / "candidate.json").exists() or not (bundle / "geod-agent-desktop.exe").is_file() or digest(bundle / "geod-agent-desktop.exe") != digest(RELEASE / "geod-agent-desktop.exe"):
        raise SystemExit("Preserve the existing candidate; use a fresh output directory")
    print("Resuming the incomplete candidate for this exact executable", flush=True)
else:
    bundle.mkdir()
shutil.copy2(RELEASE / "geod-agent-desktop.exe", bundle / "geod-agent-desktop.exe")
shutil.copy2(ROOT / "apps/geod-agent-desktop/THIRD_PARTY_NOTICES.md", bundle / "THIRD_PARTY_NOTICES.md")
shutil.copy2(ROOT / "LICENSE", bundle / "LICENSE.txt")
checks = {}
for source, name in runtime_directories(ROOT):
    print(f"Copying and verifying {name}", flush=True)
    if digest(RELEASE / name / "manifest.json") != digest(source / "manifest.json"):
        raise SystemExit(f"Release runtime is stale: {name}. Rebuild this candidate before packaging.")
    shutil.copytree(RELEASE / name, bundle / name, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"))
    checks[name] = verify_runtime(bundle / name)

(bundle / "README.txt").write_text(
    f"GeoD Agent {VERSION} Windows x64 测试版\n\n"
    "双击 geod-agent-desktop.exe 启动。请保留整个目录。\n"
    "内置 Codex、Node、pgEdge / DBHub MCP、Python/GDAL、文档解析器和本机音频转写引擎，无须安装系统 Node/Python/uv 或 Codex 桌面。音频模型首次使用时单独下载。\n"
    "桌面显示需要 Microsoft Edge WebView2 Runtime；安装候选会检查并引导安装。\n"
    "使用 GeoD 账号和托管模型。联网、图源 Key/Token 与数据库凭据仍按具体服务配置。\n"
    "关闭窗口后后台任务继续；停止后台请在应用设置中操作。\n"
    "账号记录保存在当前 Windows 用户的应用目录，密钥保存在系统凭据库。\n"
    "当前测试版的托管模型需配套网关同步；可在“模型与渠道”配置自己的模型服务。\n"
    "正式收费入口尚未开放；使用方式以当前账号和所选模型渠道为准。\n"
    "这是 0.2.0 首发测试版。具体已验证范围、已知问题和发行状态见随版本提供的说明。\n",
    encoding="utf-8")
files = {file.relative_to(bundle).as_posix(): {"bytes": file.stat().st_size, "sha256": digest(file)}
         for file in sorted(bundle.rglob("*")) if file.is_file()}
(bundle / "FILES.sha256").write_text("".join(f"{entry['sha256']}  {name}\n" for name, entry in files.items()), encoding="utf-8")
installer_copy = output / installer.name
shutil.copy2(installer, installer_copy)
archive = output / f"GeoD-Agent-{VERSION}-windows-x64.zip"
sevenzip = shutil.which("7z") or r"C:\Program Files\7-Zip\7z.exe"
print("Creating portable candidate ZIP", flush=True)
subprocess.run([sevenzip, "a", "-tzip", "-mx=5", "-bso0", "-bsp0", str(archive), bundle.name],
               cwd=output, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
subprocess.run([sevenzip, "t", "-bso0", "-bsp0", str(archive)], check=True, creationflags=subprocess.CREATE_NO_WINDOW)
manifest = {"version": VERSION, "platform": "windows-x64", "published": False, "installed": False,
            "bundleBytes": sum(file["bytes"] for file in files.values()), "bundleFiles": len(files),
            "runtimeVerification": checks,
            "artifacts": {file.name: {"bytes": file.stat().st_size, "sha256": digest(file)}
                          for file in [installer_copy, archive]},
            "mainExecutableSha256": files["geod-agent-desktop.exe"]["sha256"]}
(output / "candidate.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(manifest, ensure_ascii=False), flush=True)
