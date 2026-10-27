# Build the production images locally and export them for upload to the server (see docs/deploy-1panel.md).
# Usage: ./scripts/package-images.ps1 -Version 20261027-01 [-Platform linux/arm64] [-IncludeInfra]
[CmdletBinding()]
param(
    [string]$Version = (Get-Date -Format 'yyyyMMdd-HHmm'),
    [ValidateSet('linux/amd64', 'linux/arm64')]
    [string]$Platform = 'linux/amd64',
    # Also export pgvector and Redis (first deployment, or when the server cannot pull from Docker Hub).
    [switch]$IncludeInfra
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

if ($IncludeInfra) {
    $infra = @('pgvector/pgvector:pg18', 'redis:8-alpine')
    foreach ($image in $infra) {
        & docker pull --platform $Platform $image
        if ($LASTEXITCODE -eq 0) { continue }
        # Docker Hub is often unreachable; fall back to a local copy of the image.
        & docker image inspect --platform $Platform $image *> $null
        if ($LASTEXITCODE -ne 0) { throw "Pull failed and no local copy: $image" }
        Write-Warning "Pull failed: $image. Exporting the local copy, which may not be the latest."
    }
    $infraArchive = Join-Path $releasePath 'nyz-rag-infra.tar'
    & docker save --platform $Platform -o $infraArchive @infra
    if ($LASTEXITCODE -ne 0) { throw 'Infrastructure image export failed.' }
    Write-Host "Infrastructure archive: $infraArchive"
}
Write-Host "Set NYZ_VERSION=$Version in the server .env after loading the archive."
