# Builds StreamChat and (optionally) publishes a GitHub release.
#   .\release.ps1                                  build with the current version
#   .\release.ps1 0.3.0                            set the version, then build
#   .\release.ps1 0.3.0 -Publish -Notes "What's new"   ...and commit, tag, push and publish the release
# Outputs in dist\: StreamChat-<ver>-setup.exe (Windows installer, used by the app's self-update),
# streamchat-server-<ver>.tar.gz (used by install.sh / "streamchat update" on servers), plus .sha256 files.
param([string]$Version = "", [switch]$Publish, [string]$Notes = "")
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

function Set-Version($v) {
    $c = "$root\desktop\Cargo.toml"
    (Get-Content $c -Raw) -replace '(?m)^version\s*=\s*"[^"]+"', "version = `"$v`"" | Set-Content $c -NoNewline
    foreach ($f in "$root\desktop\tauri.conf.json", "$root\server\package.json") {
        $t = Get-Content $f -Raw
        $t = [regex]::new('"version":\s*"[^"]+"').Replace($t, "`"version`": `"$v`"", 1)
        Set-Content $f $t -NoNewline
    }
    $lock = "$root\server\package-lock.json"
    $t = Get-Content $lock -Raw
    $t = [regex]::new('"version":\s*"[^"]+"').Replace($t, "`"version`": `"$v`"", 2)
    Set-Content $lock $t -NoNewline
}

if ($Version) { Set-Version $Version }
$version = (Select-String -Path "$root\desktop\Cargo.toml" -Pattern '^version\s*=\s*"([^"]+)"').Matches[0].Groups[1].Value
$confVersion = (Get-Content "$root\desktop\tauri.conf.json" -Raw | ConvertFrom-Json).version
$serverVersion = (Get-Content "$root\server\package.json" -Raw | ConvertFrom-Json).version
if ($confVersion -ne $version -or $serverVersion -ne $version) { throw "Version mismatch: Cargo.toml $version, tauri.conf.json $confVersion, package.json $serverVersion" }
Write-Host "Version $version"

Push-Location "$root\server"
npm ci
if ($LASTEXITCODE) { throw "npm ci failed" }
npx tsc --noEmit -p .
if ($LASTEXITCODE) { throw "type check failed" }
node --test "test/*.test.ts"
if ($LASTEXITCODE) { throw "server tests failed" }
# Syntax-check every browser script, including inline <script> blocks (a broken launcher page hangs on "Starting…").
$tmpJs = Join-Path ([IO.Path]::GetTempPath()) "streamchat-check"
New-Item -ItemType Directory -Force $tmpJs | Out-Null
$n = 0
foreach ($f in Get-ChildItem "$root\desktop\ui", "$root\web" -Recurse -Include *.html) {
    foreach ($m in [regex]::Matches((Get-Content $f.FullName -Raw), '(?s)<script(?![^>]*\bsrc=)([^>]*)>(.*?)</script>')) {
        $ext = if ($m.Groups[1].Value -match 'module') { 'mjs' } else { 'js' }
        $p = Join-Path $tmpJs "inline$($n++).$ext"
        Set-Content $p $m.Groups[2].Value
        node --check $p
        if ($LASTEXITCODE) { throw "syntax error in a <script> block of $($f.FullName)" }
    }
}
foreach ($f in Get-ChildItem "$root\web" -Recurse -Include *.js) {
    $p = Join-Path $tmpJs "file.mjs"; Copy-Item $f.FullName $p -Force
    node --check $p
    if ($LASTEXITCODE) { throw "syntax error in $($f.FullName)" }
}
Remove-Item $tmpJs -Recurse -Force
node scripts/bundle.mjs
node --build-sea sea-config.json
if ($LASTEXITCODE) { throw "server exe build failed" }
Pop-Location

Push-Location "$root\desktop"
cargo build --release
if ($LASTEXITCODE) { throw "cargo build failed" }
Pop-Location

$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 not found (winget install JRSoftware.InnoSetup)" }
& $iscc /Q "/DAppVersion=$version" "$root\installer\setup.iss"
if ($LASTEXITCODE) { throw "installer build failed" }
$setup = "$root\dist\StreamChat-$version-setup.exe"

# Server bundle for Linux: Node runs the TypeScript directly inside Docker.
$stage = "$root\dist\stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force "$stage\server", "$stage\deploy" | Out-Null
Copy-Item "$root\server\package.json", "$root\server\package-lock.json" "$stage\server"
Copy-Item "$root\server\src" "$stage\server\src" -Recurse
Copy-Item "$root\web" "$stage\web" -Recurse
Copy-Item "$root\Dockerfile", "$root\.dockerignore" $stage
Copy-Item "$root\deploy\streamchat" "$stage\deploy"
$tarball = "$root\dist\streamchat-server-$version.tar.gz"
tar.exe -czf $tarball -C $stage .
if ($LASTEXITCODE) { throw "tar failed" }
Remove-Item $stage -Recurse -Force

foreach ($f in $setup, $tarball) {
    $h = (Get-FileHash $f -Algorithm SHA256).Hash.ToLower()
    Set-Content "$f.sha256" "$h  $(Split-Path $f -Leaf)" -NoNewline
}
Write-Host "Built $setup"
Write-Host "Built $tarball"

if ($Publish) {
    Push-Location $root
    git add -A
    git commit -m "Release v$version"
    if ($LASTEXITCODE) { Write-Host "(nothing new to commit)" }
    git tag "v$version"
    git push origin HEAD --tags
    if ($LASTEXITCODE) { throw "git push failed" }
    if (-not $Notes) { $Notes = "StreamChat $version" }
    gh release create "v$version" $setup "$setup.sha256" $tarball "$tarball.sha256" --title "StreamChat $version" --notes $Notes
    if ($LASTEXITCODE) { throw "gh release failed" }
    Pop-Location
    Write-Host "Published v$version"
}
