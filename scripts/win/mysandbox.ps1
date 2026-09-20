<#
  mysandbox 的 Windows 常驻管理脚本（WSL2 引擎）。

  为什么不是「Windows 服务」：
    WSL2 发行版绑定「登录用户的会话」——从 Session 0 的服务上下文（LocalSystem
    或任何服务账户）调 wsl.exe 会直接失败（microsoft/WSL#4803、#9451，实测现象
    「Access is denied」/「系统无法访问该文件」）。所以 NSSM / WinSW / sc.exe
    这条路对本项目不成立，systemd 的对应物在 Windows 上是**计划任务**：
    以当前登录用户 + 交互式会话身份常驻，才能正常驱动 wsl.exe。

  依赖：仅 Windows 自带组件（ScheduledTasks 模块），无需管理员、无需第三方工具。

  用法（在仓库根目录或任意位置）：
    powershell -ExecutionPolicy Bypass -File scripts\win\mysandbox.ps1 install
    powershell -ExecutionPolicy Bypass -File scripts\win\mysandbox.ps1 status

  动作：
    install     注册计划任务（登录时启动 + 崩溃自愈看门狗）
    uninstall   注销计划任务并停掉残留监听
    start/stop/restart
    status      任务状态 + 监听进程 + /api/health + 容器清单
    update      git pull -> npm install -> build -> 重启（改完代码用这个）
    logs        看 wrapper.log 与 mysandbox 自身日志尾部
    run         任务本体：前台跑 node dist/server/cli.js（由计划任务调用，一般不用手敲）
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('install', 'uninstall', 'start', 'stop', 'restart', 'status', 'update', 'logs', 'run')]
  [string]$Action,

  # 仓库根目录；默认取本脚本所在目录的上两级（scripts\win -> 仓库根）。
  [string]$RepoDir,

  [string]$TaskName = 'mysandbox',

  # 监听端口；不传则从 ~/.mysandbox/config.yaml 的 listen.port 读，再退回 7321。
  [int]$Port,

  [int]$Tail = 40
)

$ErrorActionPreference = 'Stop'

$ConfigFile = Join-Path $env:USERPROFILE '.mysandbox\config.yaml'
$LogDir = Join-Path $env:USERPROFILE '.mysandbox\logs'
$WrapperLog = Join-Path $LogDir 'wrapper.log'

if (-not $RepoDir) {
  $RepoDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
$RepoDir = (Resolve-Path $RepoDir).Path

if (-not $PSBoundParameters.ContainsKey('Port')) {
  $Port = 7321
  if (Test-Path $ConfigFile) {
    $m = Select-String -Path $ConfigFile -Pattern '^\s*port:\s*(\d+)' | Select-Object -First 1
    if ($m) { $Port = [int]$m.Matches[0].Groups[1].Value }
  }
}

$UserId = "$env:USERDOMAIN\$env:USERNAME"

function Get-ConfigToken {
  if (-not (Test-Path $ConfigFile)) { return $null }
  $m = Select-String -Path $ConfigFile -Pattern '^\s*token:\s*(\S+)' | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value }
  return $null
}

function Get-ListenerPids {
  param([int]$P)
  @(Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
}

function Stop-Listener {
  param([int]$P)
  $pids = Get-ListenerPids -P $P
  if ($pids.Count -eq 0) { return $false }
  foreach ($procId in $pids) {
    Write-Host "  stopping pid $procId (listening on $P)"
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 400
  return $true
}

function Get-Health {
  param([int]$P)
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$P/api/health" -TimeoutSec 5 }
  catch { return $null }
}

function Wait-Health {
  param([int]$P, [int]$Seconds = 15)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $h = Get-Health -P $P
    if ($h) { return $h }
    Start-Sleep -Milliseconds 500
  }
  return $null
}

function Get-Task {
  return Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Start-Mysandbox {
  $t = Get-Task
  if (-not $t) {
    throw "计划任务 '$TaskName' 未注册——先跑：mysandbox.ps1 install"
  }
  if ((Get-ListenerPids -P $Port).Count -gt 0) {
    Write-Host "端口 $Port 已被占用，先停掉当前实例（幂等）"
    Stop-Listener -P $Port | Out-Null
  }
  Start-ScheduledTask -TaskName $TaskName
  $h = Wait-Health -P $Port
  if ($h) {
    Write-Host "已就绪：engine=$($h.engine)  $($h.engineStatus.version)  http://127.0.0.1:$Port"
  } else {
    Write-Warning "任务已启动，但 /api/health 15 秒内无应答——看 mysandbox.ps1 logs"
  }
}

function Stop-Mysandbox {
  $t = Get-Task
  if ($t) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  if (Stop-Listener -P $Port) {
    Write-Host "已停止（任务 + 监听进程）"
  } else {
    Write-Host "已停止（本来就没有监听 $Port）"
  }
}

switch ($Action) {

  'run' {
    # 计划任务调用的本体：前台跑 node，stdout/stderr 追加进 wrapper.log。
    # 走 in-process（& $node）而不是 cmd 包装，是为了让 node 复用 powershell 的控制台
    # ——任务用 -WindowStyle Hidden 拉起时，控制台窗口不会弹出来。
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    $node = if ($env:MYSANDBOX_NODE) { $env:MYSANDBOX_NODE } else { 'node' }
    Set-Location $RepoDir
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] run start  cwd=$RepoDir" | Add-Content -Path $WrapperLog -Encoding UTF8
    $rc = 1
    try {
      & $node 'dist\server\cli.js' *>> $WrapperLog
      $rc = $LASTEXITCODE
    } catch {
      "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] run failed: $_" | Add-Content -Path $WrapperLog -Encoding UTF8
      $rc = 1
    }
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] run exit   rc=$rc" | Add-Content -Path $WrapperLog -Encoding UTF8
    exit $rc
  }

  'install' {
    if (-not (Test-Path (Join-Path $RepoDir 'dist\server\cli.js'))) {
      throw "找不到 dist\server\cli.js——先在仓库根跑 npm run build"
    }

    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $self = $PSCommandPath
    # -WindowStyle Hidden：任务拉起时不闪控制台窗口（node 复用它这个隐藏控制台）。
    # 注意：变量名不能叫 $action / $args——前者会覆盖本脚本的 $Action 参数（PowerShell
    # 变量名大小写不敏感，且该参数带 ValidateSet，赋值直接抛 ValidationMetadataException），
    # 后者是自动变量。
    $taskArgs = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$self`" run -RepoDir `"$RepoDir`" -Port $Port"
    $taskAction = New-ScheduledTaskAction -Execute $ps -Argument $taskArgs -WorkingDirectory $RepoDir

    $taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
    # 看门狗：每 5 分钟重复触发一次；已在跑时被 IgnoreNew 挡住，死了则被拉起。
    # 这一条是对「任务计划程序自身不自带健康检查」的补齐（RestartCount 只在任务被判定
    # 为「失败」时生效，而进程被外部杀掉、exit 0 等情形未必判失败）。
    #
    # ⚠️ Duration 的取值区间是实测出来的，别想当然（本机 Windows 10.0.26100 实测）：
    #    [TimeSpan]::MaxValue → P99999999DT23H59M59S  拒（超上限）
    #    PT0S（=「无限」的直觉写法）                   拒
    #    PT1M / PT1H 以下                             拒（有效下限 ≥ PT1H）
    #    P100Y                                        拒
    #    P3650D（10 年）                               通过 ← 用它
    #    拒的表现是 Register 报「任务 XML 包含格式不正确或超出范围的值(8,26):Duration:…」。
    try {
      $rep = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
          -RepetitionInterval (New-TimeSpan -Minutes 5) `
          -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition
      $rep.Duration = 'P3650D'
      $taskTrigger.Repetition = $rep
    } catch {
      Write-Warning "看门狗重复触发未应用（不影响其他功能）：$_"
    }

    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Hidden
    $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited

    # Register-ScheduledTask 的失败是**非终止错误**：不加 -ErrorAction Stop 的话，
    # 脚本会带着一句错误继续往下打印「已注册」——骗自己。这里两道保险：显式 Stop + 事后复核。
    try {
      Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $taskTrigger `
        -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
    } catch {
      if ($taskTrigger.Repetition) {
        Write-Warning "带看门狗注册失败（$_）——退回无看门狗重试"
        $taskTrigger.Repetition = $null
        Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $taskTrigger `
          -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
      } else {
        throw
      }
    }
    if (-not (Get-Task)) { throw "注册失败：任务 '$TaskName' 没有出现在计划任务库里" }

    $watchdog = if ($taskTrigger.Repetition) { "登录时 + 每 5 分钟看门狗" } else { "登录时（看门狗未应用）" }
    Write-Host "已注册计划任务 '$TaskName'"
    Write-Host "  身份    : $UserId（交互式会话——WSL2 要求，别改成 SYSTEM/服务账户）"
    Write-Host "  触发    : $watchdog；任务判失败后 1 分钟重试（最多 3 次）"
    Write-Host "  监听    : 127.0.0.1:$Port"
    Write-Host "  日志    : $WrapperLog"
    Write-Host "  卸载    : mysandbox.ps1 uninstall"
  }

  'uninstall' {
    $t = Get-Task
    if ($t) {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
      Write-Host "已注销计划任务 '$TaskName'"
    } else {
      Write-Host "计划任务 '$TaskName' 本来就没注册"
    }
    Stop-Listener -P $Port | Out-Null
  }

  'start'   { Start-Mysandbox }
  'stop'    { Stop-Mysandbox }
  'restart' { Stop-Mysandbox; Start-Mysandbox }

  'status' {
    $t = Get-Task
    if ($t) {
      $info = Get-ScheduledTaskInfo -TaskName $TaskName
      Write-Host "任务      : $TaskName"
      Write-Host "  状态    : $($t.State)"
      Write-Host "  上次运行: $($info.LastRunTime)   结果=$($info.LastTaskResult)"
      Write-Host "  下次运行: $($info.NextRunTime)"
    } else {
      Write-Host "任务      : 未注册（mysandbox.ps1 install）"
    }

    $pids = Get-ListenerPids -P $Port
    if ($pids.Count -gt 0) { Write-Host "监听      : pid $($pids -join ', ') 在 $Port" }
    else { Write-Host "监听      : 无（$Port 空闲）" }

    $h = Get-Health -P $Port
    if (-not $h) {
      Write-Host "健康      : 无应答"
      break
    }
    Write-Host "健康      : ok  版本 $($h.version)  engine=$($h.engine)"
    Write-Host "引擎      : reachable=$($h.engineStatus.reachable)  $($h.engineStatus.version)"
    Write-Host "caps      : ipAuthority=$($h.caps.ipAuthority)  baseKind=$($h.caps.baseKind)"
    Write-Host "docker 服务: available=$($h.services.available)"

    $token = Get-ConfigToken
    if ($token) {
      try {
        $c = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/containers" -TimeoutSec 10 `
               -Headers @{ 'x-sandbox-token' = $token }
        if ($c.items.Count -eq 0) { Write-Host "容器      : 0 个" }
        else {
          Write-Host "容器      : $($c.items.Count) 个"
          foreach ($i in $c.items) { Write-Host "  - $($i.name)  $($i.state)  $($i.ip)" }
        }
      } catch { Write-Host "容器      : 查询失败（$_）" }
    }
  }

  'update' {
    Push-Location $RepoDir
    try {
      if (Test-Path (Join-Path $RepoDir '.git')) {
        Write-Host "== git pull --ff-only =="
        & git pull --ff-only
        if ($LASTEXITCODE -ne 0) { throw "git pull 失败（有本地改动或分叉？手动处理后重试）" }
      }
      Write-Host "== npm install =="
      & npm install
      if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
      Write-Host "== npm -C web install =="
      & npm -C web install
      if ($LASTEXITCODE -ne 0) { throw "npm -C web install 失败" }
      Write-Host "== npm run build =="
      & npm run build
      if ($LASTEXITCODE -ne 0) { throw "npm run build 失败" }
    } finally {
      Pop-Location
    }
    Write-Host "== 重启 =="
    if (Get-Task) { Stop-Mysandbox; Start-Mysandbox }
    else { Write-Warning "任务未注册；构建已完成，用 mysandbox.ps1 install 装守护" }
  }

  'logs' {
    if (Test-Path $WrapperLog) {
      Write-Host "--- wrapper.log（最后 $Tail 行）---"
      Get-Content $WrapperLog -Tail $Tail
    } else {
      Write-Host "--- wrapper.log 还不存在 ---"
    }
    Write-Host "--- mysandbox 自身日志（最后 $Tail 行）---"
    Push-Location $RepoDir
    try { & node 'dist\server\cli.js' logs $Tail } finally { Pop-Location }
  }
}
