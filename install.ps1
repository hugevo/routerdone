# RouterDone one-line installer for Windows (PowerShell).
# Usage:
#   irm https://raw.githubusercontent.com/thoa100m/routerdone/main/install.ps1 | iex
#
# Optional env before running:
#   $env:PORT="20128"; $env:DIR="routerdone"; $env:INITIAL_PASSWORD="..."

$ErrorActionPreference = "Stop"
$Repo = "https://github.com/thoa100m/routerdone.git"
$Dir  = if ($env:DIR) { $env:DIR } else { "routerdone" }
$Port = if ($env:PORT) { $env:PORT } else { "20128" }

function Say($m) { Write-Host "[routerdone] $m" -ForegroundColor Cyan }
function Die($m) { Write-Host "[routerdone] $m" -ForegroundColor Red; exit 1 }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die "git is required." }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Die "Docker Desktop is required." }
docker compose version *> $null; if ($LASTEXITCODE -ne 0) { Die "docker compose v2 is required." }

function Rand32 { -join ((1..32) | ForEach-Object { "{0:x2}" -f (Get-Random -Max 256) }) }

if (Test-Path "$Dir\.git") {
  Say "Updating existing clone in $Dir"
  git -C $Dir pull --ff-only
} else {
  Say "Cloning into $Dir"
  git clone --depth 1 $Repo $Dir
}
Set-Location $Dir

$printPw = $false
if (-not (Test-Path ".env")) {
  Say "Generating .env with fresh secrets"
  $adminPw = if ($env:INITIAL_PASSWORD) { $env:INITIAL_PASSWORD } else { (Rand32).Substring(0,24) }
  @"
JWT_SECRET=$(Rand32)
INITIAL_PASSWORD=$adminPw
API_KEY_SECRET=$(Rand32)
MACHINE_ID_SALT=$(Rand32)
PORT=$Port
NODE_ENV=production
TZ=UTC
DATA_DIR=/app/data
BASE_URL=http://localhost:$Port
NEXT_PUBLIC_BASE_URL=http://localhost:$Port
AUTH_COOKIE_SECURE=false
REQUIRE_API_KEY=false
ENABLE_REQUEST_LOGS=false
OBSERVABILITY_ENABLED=true
"@ | Set-Content -Path ".env" -Encoding ascii
  $printPw = $true
} else {
  Say ".env already exists, keeping it"
}

Say "Building and starting (first run may take a few minutes)"
$env:PORT = $Port
docker compose up --build -d
if ($LASTEXITCODE -ne 0) { Die "docker compose failed. Inspect: docker compose logs -f" }

Say "Waiting for health..."
for ($i = 0; $i -lt 60; $i++) {
  try {
    Invoke-WebRequest -UseBasicParsing "http://localhost:$Port/api/health" *> $null
    Say "RouterDone is up at http://localhost:$Port"
    if ($printPw) { Say "Admin password: $((Get-Content .env | Select-String '^INITIAL_PASSWORD=').Line.Split('=',2)[1])" }
    exit 0
  } catch { Start-Sleep -Seconds 3 }
}
Die "Health check timed out. Inspect logs: docker compose logs -f"
