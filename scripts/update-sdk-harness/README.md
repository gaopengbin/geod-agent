# Actual updater SDK acceptance

This harness calls `tauri-plugin-updater` 2.13.1 through Tauri's `MockRuntime`.
It downloads the reviewed Windows installer over real loopback HTTPS and uses
the shipping SDK's signature and signed-version checks. It never calls
`install`, opens an application window, or changes a user profile.

## Run on Windows

From the GeoD Agent repository, compile with an absolute target directory and
bounded parallelism:

```powershell
rtk proxy cargo build --offline --locked --manifest-path scripts/update-sdk-harness/Cargo.toml --target-dir G:\code\geod-agent\artifacts\update-sdk-target-20261005 --release --jobs 2
```

After Cargo finishes successfully and the executable exists, choose a fresh
evidence directory:

```powershell
rtk proxy python -X utf8 scripts/verify-update-sdk.py --candidate artifacts/update-candidate-0.2.2-20261005 --target artifacts/update-sdk-target-20261005 --output artifacts/update-sdk-acceptance-new-run
```

The fixture CA is trusted only by the SDK client under test. It is not installed
in Windows. The fixture TLS private key is removed after loading the server
context. The permanent update signing key stays in the Windows vault.

## Acceptance cases

| Case | Required SDK behavior |
| --- | --- |
| Valid candidate | Download all bytes; verify signature, version, and installer SHA-256 |
| Tampered payload | Reject with a minisign verification error |
| Wrong public key | Reject with a minisign verification error |
| Manifest version differs from signed version | Reject with a signed-version mismatch |
| Signature has no application version | Reject because a signed version is required |
| Current version | Offer no update and request no payload |
| Older version | Offer no update and request no payload |
| Truncated payload | Reject the incomplete HTTP response |
| Untrusted TLS certificate | Reject TLS before downloading a payload |

`sdk-result.json` records the SDK cases. `result.json` adds request evidence,
candidate preservation checks, and fixture cleanup facts. A successful build
alone does not satisfy acceptance. Check the actual Cargo exit code as well as
the result files; a shell or proxy exit code is not sufficient.

## Verified Windows SDK run

`artifacts/update-sdk-acceptance-20261005-retry1/result.json` records all nine
passing cases on 2026-10-05, 03:58:32–03:58:46 UTC. The valid case downloaded
672,942,351 bytes in 5,443 chunks and matched the reviewed installer's SHA-256:

```text
39fbd81d6c962fb2ca42b15548d43d5c58682f17c537217fb118626c9bfe134b
```

The real SDK process returned zero. Both source and executable hashes were
checked against `sdk-provenance.json`. The original signed candidate remained
unchanged, no fixture CA was installed in Windows, and no fixture TLS private
key remained. Non-signing SDK subprocesses receive `public_environment()`.

This proves the updater SDK's download and verification behavior in
`MockRuntime`. It does not prove installation, a configured public update
channel, an installed client's upgrade flow, or clean-Windows acceptance.

## Earlier execution and fixture failures

The retry captured in
`artifacts/update-sdk-build-20261005-retry4.log` returned Cargo exit code 101.
Windows refused to create the `parking_lot_core` build-script process with
`os error 5`. A separate attempt to create the hashed build-script process also
returned `WinError 5` before execution. The containing directory's ACL allows
execution; a scoped Defender log query returned no matching entries. These
observations do not identify the cause of the refusal.

Later the identical hashed build script executed normally without changes to
security controls. The retry recorded in
`artifacts/update-sdk-build-20261005-retry5.log` returned Cargo exit code zero
and completed in 3 minutes 16 seconds. The cause of the earlier refusal remains
unproven.

The first fixture attempt also exposed this machine's injected Python
truststore adapter trying to verify a listening server socket before it had an
SSL object. The fixture now uses that adapter's underlying stdlib server
context. The SDK client's strict TLS verification remains enabled, as proved by
the trusted-CA and untrusted-CA cases. The unsuccessful fixture directory is
preserved, with its temporary TLS private key removed.

Preserve failure logs and inspect current process/file state before retrying.
Do not run a second build while a prior Cargo or rustc process is alive, weaken
Windows security controls, or install the candidate as a workaround. The
`sdk-progress.json` file is a per-case checkpoint; use the terminal process
result and `sdk-result.json` / `result.json` for the final outcome.
