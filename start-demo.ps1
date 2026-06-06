$ErrorActionPreference = "Stop"
$nodeCandidates = @()

if ($env:NODE_EXE) {
    $nodeCandidates += $env:NODE_EXE
}

if ($env:USERPROFILE) {
    $nodeCandidates += Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
    $nodeCandidates += $nodeCommand.Source
}

$node = $nodeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $node) {
    throw "Node runtime not found. Set NODE_EXE, install Node, or use the Codex bundled runtime under your user profile."
}

$env:HOST = if ($env:HOST) { $env:HOST } else { "127.0.0.1" }
$env:ARY_PORT = if ($env:ARY_PORT) { $env:ARY_PORT } else { "4311" }
$env:ORGANIZER_PORT = if ($env:ORGANIZER_PORT) { $env:ORGANIZER_PORT } else { "4312" }
$env:RACER_PORT = if ($env:RACER_PORT) { $env:RACER_PORT } else { "4313" }
$env:VISITOR_PORT = if ($env:VISITOR_PORT) { $env:VISITOR_PORT } else { "4314" }

Write-Host "Starting ARY Security Demo role UIs:"
Write-Host "  ARY:       http://$($env:HOST):$($env:ARY_PORT)"
Write-Host "  Organizer: http://$($env:HOST):$($env:ORGANIZER_PORT)"
Write-Host "  Racer:     http://$($env:HOST):$($env:RACER_PORT)"
Write-Host "  Visitor:   http://$($env:HOST):$($env:VISITOR_PORT)"
& $node "$PSScriptRoot\server.js"
