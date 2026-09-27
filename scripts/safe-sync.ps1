param([string]$Message = 'chore: verified project checkpoint')
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$taskSyncLock = $null
Push-Location -LiteralPath $taskRoot
try {
  $taskGitRoot = git rev-parse --show-toplevel
  if ($LASTEXITCODE -ne 0 -or ([IO.Path]::GetFullPath($taskGitRoot.Trim())) -ne $taskRoot) { throw 'Repository root mismatch' }
  $taskGitDir = git rev-parse --absolute-git-dir
  if ($LASTEXITCODE -ne 0) { throw 'Cannot locate repository lock directory' }
  # OS releases exclusive handle after crash. Never break a competing lock.
  try { $taskSyncLock = [IO.File]::Open((Join-Path $taskGitDir.Trim() 'agent-call-bridge-sync.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
  catch { throw 'Another project sync is running; preserving all local work' }
  function Assert-ProjectRemote {
    $taskFetchUrls = @(git remote get-url --all origin)
    if ($LASTEXITCODE -ne 0 -or $taskFetchUrls.Count -ne 1) { throw 'Unexpected fetch remote; sync refused' }
    $taskPushUrls = @(git remote get-url --push --all origin)
    if ($LASTEXITCODE -ne 0 -or $taskPushUrls.Count -ne 1) { throw 'Unexpected push remote; sync refused' }
    foreach ($taskUrl in @($taskFetchUrls[0], $taskPushUrls[0])) {
      if ($taskUrl -cnotmatch '^https://github\.com/dujiahang-du/agent-call-bridge(?:\.git)?$') { throw 'Unexpected remote; sync refused' }
    }
  }
  Assert-ProjectRemote
  # Only explicitly pre-staged files are eligible. This script never stages.
  node scripts/check-safe.mjs --history
  if ($LASTEXITCODE -ne 0) { throw 'Index/history safety check failed; sync paused' }
  git diff --cached --quiet
  $taskDiffExit = $LASTEXITCODE
  if ($taskDiffExit -gt 1) { throw 'Cannot inspect staged changes' }
  if ($taskDiffExit -eq 1) {
    git commit -m $Message
    if ($LASTEXITCODE -ne 0) { throw 'Commit failed; preserving local work' }
  }
  git fetch --no-tags origin
  if ($LASTEXITCODE -ne 0) { throw 'Fetch failed; preserving local work' }
  git show-ref --verify --quiet refs/remotes/origin/main
  $taskRemoteRefExit = $LASTEXITCODE
  if ($taskRemoteRefExit -gt 1) { throw 'Cannot inspect remote branch' }
  if ($taskRemoteRefExit -eq 0) {
    git merge-base --is-ancestor origin/main HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Remote is not an ancestor; no force push' }
  }
  # Inspect new commit + fetched history and recheck resolved URL before transfer.
  $taskPushCommit = git rev-parse --verify HEAD
  if ($LASTEXITCODE -ne 0 -or $taskPushCommit -cnotmatch '^[a-f0-9]{40,64}$') { throw 'Cannot pin the commit for safety inspection' }
  $taskPushCommit = $taskPushCommit.Trim()
  node scripts/check-safe.mjs --history
  if ($LASTEXITCODE -ne 0) { throw 'Final history safety check failed; sync paused' }
  $taskCurrentCommit = git rev-parse --verify HEAD
  if ($LASTEXITCODE -ne 0 -or $taskCurrentCommit.Trim() -ne $taskPushCommit) { throw 'HEAD changed during safety inspection; sync paused' }
  Assert-ProjectRemote
  # Other Git processes do not share this script's lock. Push the inspected OID,
  # so a commit made after this check cannot silently enter the transfer.
  git -c push.followTags=false push -u origin "${taskPushCommit}:refs/heads/main"
  if ($LASTEXITCODE -ne 0) { throw 'Push failed; preserving local work' }
} finally {
  if ($null -ne $taskSyncLock) { $taskSyncLock.Dispose() }
  Pop-Location
}
