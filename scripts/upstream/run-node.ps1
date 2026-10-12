param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('node', 'npm')]
  [string] $Tool,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $NodeArgs
)

$minimumMajor = 22
$node = Get-Command node -ErrorAction SilentlyContinue
$toolCommand = Get-Command $Tool -ErrorAction SilentlyContinue
if ($null -ne $node) {
  $versionText = (& $node.Source --version 2>$null | Out-String).Trim()
  $match = [regex]::Match($versionText, '^v?(\d+)\.')
  if ($LASTEXITCODE -eq 0 -and $match.Success -and [int]$match.Groups[1].Value -ge $minimumMajor) {
    if ($null -ne $toolCommand) {
      & $toolCommand.Source @NodeArgs
      exit $LASTEXITCODE
    }
    Write-Warning "$($node.Source) is compatible, but $Tool is unavailable; using a task-scoped mise LTS runtime"
  } elseif ($match.Success) {
    Write-Warning "$($node.Source) is $versionText; requires Node.js >= $minimumMajor, using a task-scoped mise LTS runtime"
  } else {
    Write-Warning "$($node.Source) did not report a Node.js version; using a task-scoped mise LTS runtime"
  }
} else {
  Write-Warning "Node.js is not on PATH; using a task-scoped mise LTS runtime"
}

$mise = Get-Command mise -ErrorAction SilentlyContinue
if ($null -eq $mise) {
  Write-Error "Install Node.js >= $minimumMajor or add mise to PATH for a scoped LTS fallback"
  exit 127
}
if ($Tool -eq 'npm' -and $null -ne $toolCommand -and $toolCommand.Source -match '(?i)[\\/]\.socket[\\/]') {
  # Keep Socket Firewall entrypoints ahead of mise while still scoping Node selection.
  & $mise.Source exec node@lts -- $toolCommand.Source @NodeArgs
} else {
  & $mise.Source exec node@lts -- $Tool @NodeArgs
}
exit $LASTEXITCODE
