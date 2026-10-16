# Compila o sidecar de rede cubicase-link (Go) e coloca no caminho que o Tauri espera
# (src-tauri/binaries/cubicase-link-x86_64-pc-windows-msvc.exe). O binário fica fora do git
# (ver .gitignore), então precisa ser gerado localmente antes de cada `tauri dev`/`tauri build` —
# chamado automaticamente por beforeDevCommand/beforeBuildCommand em src-tauri/tauri.conf.json.

$ErrorActionPreference = "Stop"

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    Write-Error "Go não encontrado no PATH. Instale em https://go.dev/dl/ antes de rodar o Cubicase."
    exit 1
}

$root = Split-Path -Parent $PSScriptRoot
$binariesDir = Join-Path $root "src-tauri\binaries"
$linkDir = Join-Path $root "src-tauri\sidecars\cubicase-link"
$linkTarget = Join-Path $binariesDir "cubicase-link-x86_64-pc-windows-msvc.exe"

New-Item -ItemType Directory -Force -Path $binariesDir | Out-Null

Push-Location $linkDir
try {
    go build -o $linkTarget .
} finally {
    Pop-Location
}
Write-Host "Sidecar cubicase-link compilado: $linkTarget"
