# Run the desktop app from this checkout instead of the installed build.
#
# Usage:
#   powershell -NoProfile -File scripts\dev-desktop.ps1
#   powershell -NoProfile -File scripts\dev-desktop.ps1 -Watch     # rebuild client on save
#   powershell -NoProfile -File scripts\dev-desktop.ps1 -NoStop    # leave the installed app alone
#
# Two environment traps this script handles:
#   * NODE_ENV=production makes the embedded server demand a 64-char ENCRYPTION_KEY
#     and refuse to start, so the inherited value is dropped.
#   * The packaged app and this dev run share %APPDATA%\FreeLLMAPI (same DB, same
#     port 31415), so only one can run at a time.
param(
    [switch]$Watch,
    [switch]$NoStop
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if ($env:NODE_ENV -eq 'production') {
    Remove-Item Env:NODE_ENV
    Write-Host 'dropped inherited NODE_ENV=production (would require ENCRYPTION_KEY)' -ForegroundColor DarkYellow
}

if (-not $NoStop) {
    $packaged = Get-Process FreeLLMAPI -ErrorAction SilentlyContinue
    if ($packaged) {
        Write-Host "stopping installed app (pid $($packaged.Id -join ', ')) to free port 31415" -ForegroundColor Cyan
        $packaged | Stop-Process -Force
        Start-Sleep -Seconds 2
    }
    $held = Get-NetTCPConnection -State Listen -LocalPort 31415 -ErrorAction SilentlyContinue
    if ($held) {
        Write-Host "port 31415 still held by pid $($held.OwningProcess -join ', ') - stop it first" -ForegroundColor Red
        exit 1
    }
}

if ($Watch) {
    Write-Host 'watch: rebuilding client/src on save (window reload: Ctrl+R)' -ForegroundColor Cyan
    Start-Job -ArgumentList $repo -ScriptBlock {
        param($repo)
        $last = [datetime]::MinValue
        $log = Join-Path $repo '.scratch\client-rebuild.log'
        while ($true) {
            $newest = (Get-ChildItem (Join-Path $repo 'client\src') -Recurse -File |
                Measure-Object LastWriteTime -Maximum).Maximum
            if ($newest -gt $last) {
                if ($last -ne [datetime]::MinValue) {
                    $stamp = Get-Date -Format 'HH:mm:ss'
                    "=== $stamp rebuild ===" | Out-File -FilePath $log -Append -Encoding utf8
                    Push-Location $repo
                    npm run build -w client 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
                    Pop-Location
                }
                $last = $newest
            }
            Start-Sleep -Seconds 2
        }
    } | Out-Null
}

Write-Host 'starting electron (client build + server bundle + window)' -ForegroundColor Cyan
npm run desktop:dev
