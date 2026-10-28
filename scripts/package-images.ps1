# Build the production images locally and export them for upload to the server (see docs/deploy-1panel.md).
# Usage: ./scripts/package-images.ps1 -Version 20261027-01 [-Platform linux/arm64] [-IncludePgvector]
[CmdletBinding()]
param(
    [string]$Version = (Get-Date -Format 'yyyyMMdd-HHmm'),
    [ValidateSet('linux/amd64', 'linux/arm64')]
    [string]$Platform = 'linux/amd64',
    # Also export pgvector/pgvector:pg18 for the shared PostgreSQL app in 1Panel (when the server cannot pull from Docker Hub).
    [switch]$IncludePgvector
)

$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$') { throw 'Invalid image version.' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$releasePath = Join-Path $repoRoot 'release'
New-Item -ItemType Directory -Force -Path $releasePath | Out-Null

$revision = (& git -C $repoRoot rev-parse --short HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot read the git revision.' }
if (& git -C $repoRoot status --porcelain) {
    Write-Warning 'The working tree has uncommitted changes; they will be included in the images.'
}

# api and worker share every layer except CMD; web and admin share the build stage.
$images = @()
foreach ($target in 'api', 'worker', 'web', 'admin') {
    $image = "nyz-rag-${target}:$Version"
    & docker build --platform $Platform --target $target `
        --label "org.opencontainers.image.revision=$revision" `
        --label "org.opencontainers.image.version=$Version" `
        -t $image $repoRoot
    if ($LASTEXITCODE -ne 0) { throw "Image build failed: $target" }
    $images += $image
}

$archive = Join-Path $releasePath "nyz-rag-$Version.tar"
& docker save --platform $Platform -o $archive @images
if ($LASTEXITCODE -ne 0) { throw 'Image export failed.' }
Write-Host "Images: $($images -join ', ') (revision $revision)"
Write-Host "Archive: $archive"

if ($IncludePgvector) {
    $pgImage = 'pgvector/pgvector:pg18'
    & docker pull --platform $Platform $pgImage
    if ($LASTEXITCODE -ne 0) {
        # Docker Hub is often unreachable; fall back to a local copy of the image.
        & docker image inspect --platform $Platform $pgImage *> $null
        if ($LASTEXITCODE -ne 0) { throw "Pull failed and no local copy: $pgImage" }
        Write-Warning "Pull failed: $pgImage. Exporting the local copy, which may not be the latest."
    }
    $pgArchive = Join-Path $releasePath 'pgvector-pg18.tar'
    & docker save --platform $Platform -o $pgArchive $pgImage
    if ($LASTEXITCODE -ne 0) { throw 'pgvector image export failed.' }
    Write-Host "pgvector archive: $pgArchive"
}
Write-Host "Set NYZ_VERSION=$Version in the server .env after loading the archive."
