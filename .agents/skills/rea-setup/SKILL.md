---
name: rea-setup
description: Set up REA 6.9.0 on Windows (win32) to dissect Java bytecode — install Temurin JDK 21, the audited jadx-headless-mcp bridge, register JAVA_HOME/REA_JADX_MCP_JAR with the opencode MCP client, and install standalone JADX CLI for plain JARs. Use when REA reports only the artifact-graph provider, JADX shows `provider_missing`, or you need to decompile Java/JAR/APK bytecode on Windows.
---

# REA setup for Java bytecode on Windows

Use this when REA is connected but `binary_session` shows only
`rea-artifact-graph` (plus `rea-dotnet-static`) and every decompiler candidate
is `not_configured` / `unsupported_host`.

## Provider reality on win32 (verified with REA 6.9.0)

| Provider | Windows x64 | Decompiles JVM bytecode? | How |
| --- | --- | --- | --- |
| `rea-artifact-graph` | Yes | No — inventory/extract only | `inspect_artifact`, `extract_artifact` |
| `jadx` (REA provider) | Yes | **Yes, but standalone APK only** | `REA_JADX_MCP_JAR` + `JAVA_HOME` |
| JADX CLI (standalone) | Yes | **Yes — JAR / DEX / APK** | `jadx -d out file.jar`, outside REA |
| Ghidra | Yes, with JDK + `GHIDRA_INSTALL_DIR` | No (native code) | Optional, for native binaries |
| IDA | Needs licence + `REA_IDA_MCP_CONFIG` | No (native code) | Proprietary |
| Kuna | **No** | No (native/SLEIGH) | REA refuses win32: "Windows process-tree ownership for Kuna is not verified" |
| Hopper | **No** | No | macOS only |

Do not install Kuna to try to decompile Java bytecode on Windows: REA rejects
it on win32 (`unsupported_host`) and it is a native-code decompiler.

REA never downloads or installs engines itself. All steps below are
operator-supplied.

## 1. Install a full JDK

REA requires `jdk.compiler` (a JRE is not enough).

```powershell
winget install --id EclipseAdoptium.Temurin.21.JDK --exact `
  --accept-package-agreements --accept-source-agreements --silent --disable-interactivity
```

`--scope user` fails for this package with "No applicable installer found";
use the default (machine) scope. Verify:

```powershell
java --version
java --list-modules | Select-String '^jdk.compiler@'
```

Record the install root, e.g.
`C:\Program Files\Eclipse Adoptium\jdk-21.0.13.9-hotspot`.

## 2. Install the audited JADX MCP bridge JAR

REA 6.9.0 audits jadx-headless-mcp **0.7.1**:

- URL: `https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar`
- SHA-256: `6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75`

```powershell
$dir = 'C:\Users\azureuser\AppData\Local\Programs\jadx-headless-mcp'
$jar = Join-Path $dir 'jadx-headless-mcp-0.7.1-all.jar'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
curl.exe -L --fail --retry 3 -o $jar '<URL above>'
(Get-FileHash -LiteralPath $jar -Algorithm SHA256).Hash.ToLowerInvariant()
```

Expect the digest above. REA also checks these entries exist in the JAR:
`com/atxx/jhmcp/JadxSession.class`, `com/atxx/jhmcp/SessionHolder.class`,
`jadx/api/JadxDecompiler.class`, `com/google/gson/Gson.class`,
`io/modelcontextprotocol/kotlin/sdk/server/Server.class`.

## 3. Set persistent environment variables

Use `[Environment]::SetEnvironmentVariable(..., 'User')` rather than `setx`
(`setx` truncates values over 1024 characters).

```powershell
$jdkHome = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.13.9-hotspot'
$jar     = 'C:\Users\azureuser\AppData\Local\Programs\jadx-headless-mcp\jadx-headless-mcp-0.7.1-all.jar'
[Environment]::SetEnvironmentVariable('JAVA_HOME', $jdkHome, 'User')
[Environment]::SetEnvironmentVariable('REA_JADX_MCP_JAR', $jar, 'User')
$p = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($p -notlike "*$jdkHome\bin*") {
  [Environment]::SetEnvironmentVariable('Path', "$p;$jdkHome\bin", 'User')
}
```

## 4. Verify in a fresh process

```powershell
$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.13.9-hotspot'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
$env:REA_JADX_MCP_JAR = 'C:\Users\azureuser\AppData\Local\Programs\jadx-headless-mcp\jadx-headless-mcp-0.7.1-all.jar'
rea doctor --json
```

The `jadx` check must be `ok: true` / `available: true`. The shell needs these
variables set for this call because the current terminal predates step 3.

## 5. Record the settings in the MCP client registration

Environment variables changed after REA started do not reach the running
server. Persist them into the client's MCP registration:

```powershell
# preview first — read-only
rea setup --client opencode --skill=false --dry-run
# apply
rea setup --client opencode --skill=false --yes
```

This writes `JAVA_HOME` and `REA_JADX_MCP_JAR` into the `rea` server's
`environment` block in `~\.config\opencode\opencode.jsonc`, preserves unrelated
config, and creates a `.rea.backup.<digest>.recovery` file. `--yes` is required;
without it the plan stops at `needs_confirmation`.

Confirm registration-scoped health:

```powershell
rea doctor --client opencode --skill=false --json
```

Expect `healthy: true`, `jadx.available: true`, and both variables under
`providerInspections[id=jadx].registrationEnvironment` (no `unrecorded`).

## 6. Restart and verify in the running client

Quit and restart opencode. Then call REA `binary_session` and check
`result.tool_availability`: the group containing `inspect_android_package`,
`inspect_android_class`, `inspect_android_method`, `search_android_classes`
and `trace_android_references` must change from `provider_missing` to
`available`. Until the restart it will still report `provider_missing`.

## 7. Install standalone JADX CLI for plain JARs

REA's Android tools reject a JAR before it reaches JADX:

```
capability_unavailable ... reason: Target ... is zip; provide one standalone APK
```

For `.jar` / `.class` bytecode use the upstream CLI (verified with v1.5.6):

```powershell
$dir = 'C:\Users\azureuser\AppData\Local\Programs\jadx'
$zip = Join-Path $dir 'jadx-1.5.6.zip'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
curl.exe -L --fail -o $zip 'https://github.com/skylot/jadx/releases/download/v1.5.6/jadx-1.5.6.zip'
Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
# the archive places bin\ and lib\ directly in $dir
[Environment]::SetEnvironmentVariable('Path',
  "$([Environment]::GetEnvironmentVariable('Path','User'));$dir\bin", 'User')
```

Check the GitHub release API (`https://api.github.com/repos/skylot/jadx/releases/latest`)
for a newer version; `jadx-gui-*-with-jre-win.zip` is unnecessary once a JDK
is installed. Smoke test:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.13.9-hotspot'
$env:PATH = "$env:JAVA_HOME\bin;C:\Users\azureuser\AppData\Local\Programs\jadx\bin;$env:PATH"
jadx --version
jadx -d C:\out\decompiled C:\path\to\target.jar
```

Source lands under `<out>\sources\...` (default-package classes go in
`defpackage\`), resources under `<out>\resources\`. `--no-banner` is not a
valid option in 1.5.6.

## Usage after setup

- **APK / DEX:** REA tools — `inspect_android_package`, `search_android_classes`,
  `inspect_android_class`, `inspect_android_method`, `trace_android_references`.
- **Plain JAR / loose .class:** standalone `jadx -d <out> <file.jar>`; use
  `inspect_artifact` / `extract_artifact` in REA only for member inventory.
- **Native binary** (if needed): set `GHIDRA_INSTALL_DIR` to an extracted
  Ghidra 12.x (>=12.1) release and reopen with `provider_id: "ghidra"`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| JADX tools still `provider_missing` in a live session | Restart opencode; env and registration changes are startup-only. |
| `rea doctor` jadx `not_configured` in a new shell | Set JAVA_HOME/REA_JADX_MCP_JAR in that shell, or use `rea doctor --client opencode --skill=false`. |
| `unrecorded: JAVA_HOME, REA_JADX_MCP_JAR` | Re-run `rea setup --client opencode --skill=false --yes`. |
| `No applicable installer found` from winget | Drop `--scope user`. |
| Kuna unusable on Windows | Expected; use JADX for bytecode, or Linux/macOS for Kuna. |
| Generic `capability_unavailable` on a JAR | REA JADX is APK-only; use standalone JADX CLI. |

## Skill activation

Workspace skills under `<worktree>/.agents/skills` are not auto-scanned by
every opencode setup. If `/skill` does not list this skill, add to
`opencode.json`:

```json
{ "skills": { "paths": [".agents/skills"] } }
```

and restart opencode.
