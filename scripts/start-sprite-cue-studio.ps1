$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:5188"
$workDir = Join-Path $projectRoot "work"
$serverScript = Join-Path $projectRoot "server.cjs"
$distIndex = Join-Path $projectRoot "dist\index.html"

function Test-FrameActionServer {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$url/api/status" -TimeoutSec 1
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

if (-not (Test-Path $distIndex)) {
    $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source
    if (-not $npm) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show("Node.js/npm was not found. SpriteCue Studio cannot be built.", "SpriteCue Studio") | Out-Null
        exit 1
    }
    Push-Location $projectRoot
    try {
        & $npm run build
        if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-FrameActionServer)) {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show("Node.js was not found. SpriteCue Studio cannot start.", "SpriteCue Studio") | Out-Null
        exit 1
    }
    New-Item -ItemType Directory -Path $workDir -Force | Out-Null
    $serverArgument = '"' + $serverScript + '"'
    Start-Process -FilePath $node `
        -ArgumentList @($serverArgument) `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $workDir "server-output.log") `
        -RedirectStandardError (Join-Path $workDir "server-error.log") | Out-Null

    for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
        Start-Sleep -Milliseconds 200
        if (Test-FrameActionServer) { break }
    }
}

if (Test-FrameActionServer) {
    Start-Process $url
}
else {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("SpriteCue Studio failed to start. See work\server-error.log.", "SpriteCue Studio") | Out-Null
    exit 1
}
