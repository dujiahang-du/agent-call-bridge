param([string]$Message = 'chore: verified project checkpoint')
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $taskRoot
try {
  $taskGitRoot = (git rev-parse --show-toplevel).Trim()
  if (([IO.Path]::GetFullPath($taskGitRoot)) -ne $taskRoot) { throw 'Repository root mismatch' }
  $taskRemote = (git remote get-url origin).Trim()
  if ($taskRemote -notmatch '^https://github\.com/dujiahang-du/agent-call-bridge(?:\.git)?$') { throw 'Unexpected remote; sync refused' }
  # 总控先精确暂存经检查的文件，本脚本从不使用 git add .。
  node scripts/check-safe.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Staged safety check failed' }
  git diff --cached --quiet
  if ($LASTEXITCODE -eq 1) {
    git commit -m $Message
    if ($LASTEXITCODE -ne 0) { throw 'Commit failed' }
  }
  node scripts/check-safe.mjs --history
  if ($LASTEXITCODE -ne 0) { throw 'History safety check failed' }
  git fetch origin
  if ($LASTEXITCODE -ne 0) { throw 'Fetch failed; preserving local work' }
  git show-ref --verify --quiet refs/remotes/origin/main
  if ($LASTEXITCODE -eq 0) {
    git merge-base --is-ancestor origin/main HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Remote is not an ancestor; no force push' }
  }
  git push -u origin HEAD:main
  if ($LASTEXITCODE -ne 0) { throw 'Push failed; preserving local work' }
} finally { Pop-Location }
