<#
  mysandbox 的 Windows 常驻管理脚本（WSL2 引擎）。

  为什么不是「Windows 服务」：
    WSL2 发行版绑定「登录用户的会话」——从 Session 0 的服务上下文（LocalSystem
    或任何服务账户）调 wsl.exe 会直接失败（microsoft/WSL#4803、#9451，实测现象
    「Access is denied」/「系统无法访问该文件」）。所以 NSSM / WinSW / sc.exe
    这条路对本项目不成立，systemd 的对应物在 Windows 上是**计划任务**：
    以当前登录用户 + 交互式会话身份常驻，才能正常驱动 wsl.exe。

  分层（这是「稳定重启」的实际来源，别把重启指望在调度器上）：
    ① runner 自愈循环（run 动作）——node 一退出就重启，秒级，不依赖任何调度器语义；
    ② 登录时启动——解决开机/重登后自动拉起；
    ③ 任务级 5 分钟看门狗——兜「runner 自己也没了」的极端情况；
    ④ 停止哨兵文件——保证 stop 不会被上面任何一层复活。

  依赖：Windows 自带组件（ScheduledTasks 模块）+ 仓库自带的 WireGuard 安装包（见下）。
        没有第三方运行时依赖。

  WireGuard（Windows 侧集群隧道）：
    Linux 上靠内核模块 + wireguard-tools；Windows 没有对应的「零安装」路径——官方客户端的
    内核驱动必须由 Microsoft 签名才能被系统加载。所以做法是把官方 MSI 随仓库带上，由
    install（或 wireguard 动作）静默装一次，用户无感。
    包与说明见 vendor\wireguard\README.md。
    注意 uninstall 刻意**不**卸它：别的软件可能用同一份驱动，且卸内核驱动风险大于收益。

  权限：install 与 wireguard 需要**管理员**——前者是「RunLevel Highest 任务注册」的系统要求，
        后者要装内核驱动。status / start / stop / restart / logs / update / run 不需要。

  用法（在仓库根目录或任意位置）：
    powershell -ExecutionPolicy Bypass -File scripts\win\mysandbox.ps1 install
    powershell -ExecutionPolicy Bypass -File scripts\win\mysandbox.ps1 status

  动作：
    install     注册计划任务（登录时启动 + 5 分钟看门狗）+ 顺带把 WireGuard 依赖装上
    uninstall   注销计划任务并停掉残留监听（不动 WireGuard）
    wireguard   确保 vendor\wireguard 里的官方 MSI 已静默装上（幂等；-Force 强制覆盖）
    start/stop/restart
    status      任务状态 + 监听进程 + /api/health + WireGuard + 容器清单
    update      git pull -> npm install -> build -> 重启（改完代码用这个）
    logs        看 wrapper 日志与 mysandbox 自身日志尾部
    run         任务本体：自愈循环跑 node dist/server/cli.js（由计划任务调用，一般不用手敲）
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('install', 'uninstall', 'wireguard', 'start', 'stop', 'restart', 'status', 'update', 'logs', 'run')]
  [string]$Action,

  # 仓库根目录；默认取本脚本所在目录的上两级（scripts\win -> 仓库根）。
  [string]$RepoDir,

  [string]$TaskName = 'mysandbox',

  # 监听端口；不传则从 ~/.mysandbox/config.yaml 的 listen.port 读，再退回 7321。
  [int]$Port,

  [int]$Tail = 40,

  # wireguard / install：即使已装也重装一遍（修损坏的安装用）。
  [switch]$Force,

  # install：跳过 WireGuard 依赖那一步（不需要集群隧道，或想自己管依赖时用）。
  [switch]$SkipWireGuard
)

$ErrorActionPreference = 'Stop'

$ConfigFile = Join-Path $env:USERPROFILE '.mysandbox\config.yaml'
$LogDir = Join-Path $env:USERPROFILE '.mysandbox\logs'
# 按天命名：既避免「重启时旧文件仍被运行中的进程持有、删不掉/写不进」的句柄冲突
# （实测 wrapper.log 固定名时 Remove-Item 会被静默跳过），也顺带留了个自然的轮转边界。
$WrapperLog = Join-Path $LogDir ("wrapper-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
# 停止哨兵：stop / uninstall 落它，run 见到就退出循环。没有它的话，「停」会被 runner 的
# 自愈循环或任务计划程序残留的重启逻辑当场复活——停机必须是一个写得进磁盘的意图。
$StopFlag = Join-Path $env:USERPROFILE '.mysandbox\stopped.flag'

if (-not $RepoDir) {
  $RepoDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
$RepoDir = (Resolve-Path $RepoDir).Path

# WireGuard 依赖：包随仓库分发，装到系统的官方目录（server/wireguard.ts 里硬编码了这个路径）。
# ProgramW6432 优先——32 位 PS 下 $env:ProgramFiles 会指到 (x86)，会误判成「没装」。
$WgDir = Join-Path $RepoDir 'vendor\wireguard'
$WgRoot = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$WgExe = Join-Path $WgRoot 'WireGuard\wireguard.exe'

if (-not $PSBoundParameters.ContainsKey('Port')) {
  $Port = 7321
  if (Test-Path $ConfigFile) {
    $m = Select-String -Path $ConfigFile -Pattern '^\s*port:\s*(\d+)' | Select-Object -First 1
    if ($m) { $Port = [int]$m.Matches[0].Groups[1].Value }
  }
}

$UserId = "$env:USERDOMAIN\$env:USERNAME"

function Write-Wrap {
  param([string]$Message)
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" | Add-Content -Path $WrapperLog -Encoding UTF8
}

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

# ——— WireGuard 依赖安装（Windows 侧集群隧道）———
# 为什么要有这一坨：Windows 上集群隧道绕不过官方内核驱动（必须 Microsoft 签名），
# 「零安装」不可得，只能让用户看不见——包随仓库带、这里静默装一次。

function Get-WgArch {
  # 32 位 PS 在 64 位系统上是 x86 + PROCESSOR_ARCHITEW6432=AMD64。优先取后者，
  # 否则会去挑 x86 的包（能装，但不是本机最合适的那个）。
  $raw = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($raw) {
    'AMD64' { 'amd64' }
    'ARM64' { 'arm64' }
    'x86'   { 'x86' }
    default { 'amd64' }
  }
}

function Get-WgMsiVersion {
  param([string]$Path)
  # wireguard-amd64-1.1.1.msi -> 1.1.1
  # 注意别用 Split-Path -LeafBase：那是 PS 6+ 的参数，PS 5.1 上直接报参数不存在。
  try { return [version]([IO.Path]::GetFileNameWithoutExtension($Path) -replace '^wireguard-[^-]+-') }
  catch { return $null }
}

function Get-WgMsi {
  # 挑本架构的包，多版本取最高；本架构没有就退到 amd64（Windows on ARM 能跑 x64）。
  if (-not (Test-Path $WgDir)) { return $null }
  $arch = Get-WgArch
  foreach ($a in (@($arch, 'amd64') | Select-Object -Unique)) {
    $cand = @(Get-ChildItem -Path $WgDir -Filter "wireguard-$a-*.msi" -File -ErrorAction SilentlyContinue |
              Sort-Object { $v = Get-WgMsiVersion $_.FullName; if ($v) { $v } else { [version]'0.0.0' } } -Descending)
    if ($cand.Count -gt 0) {
      if ($a -ne $arch) { Write-Warning "本机是 ${arch}，但 vendor\wireguard 里只有 ${a} 的包——将用它" }
      return $cand[0]
    }
  }
  return $null
}

function Get-WgInstalledVersion {
  $roots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($r in $roots) {
    $k = Get-ItemProperty -Path $r -ErrorAction SilentlyContinue |
         Where-Object { $_.DisplayName -like 'WireGuard*' -and $_.DisplayVersion } |
         Select-Object -First 1
    if ($k) { return [string]$k.DisplayVersion }
  }
  return $null
}

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-WgDependency {
  param([switch]$Force)
  $msi = Get-WgMsi
  if (-not $msi) {
    Write-Warning "vendor\wireguard 里没有匹配的 MSI——用 vendor\wireguard\fetch.sh 拉包（国内需代理）"
    return $false
  }
  $want = Get-WgMsiVersion $msi.FullName
  $have = Get-WgInstalledVersion

  if (-not $Force) {
    if ((Test-Path $WgExe) -and -not $have) {
      Write-Host "  WireGuard 已装（版本读不到，视为满足）；要强制覆盖加 -Force"
      return $true
    }
    if ((Test-Path $WgExe) -and $have -and $want) {
      if ([version]$have -ge $want) {
        Write-Host "  WireGuard 已装 ${have}（不低于包内 ${want}），跳过"
        return $true
      }
      Write-Host "  WireGuard 已装 ${have}，包内 ${want} 更新——升级"
    } elseif (-not (Test-Path $WgExe) -and $have) {
      Write-Warning "  注册表说装了 ${have}，但 $WgExe 不在——按「装坏了」处理，重装"
    } else {
      Write-Host '  未检测到 WireGuard——安装'
    }
  }

  if (-not (Test-IsAdmin)) {
    Write-Warning "  静默安装需要管理员权限。请用管理员终端重跑：mysandbox.ps1 wireguard"
    return $false
  }

  Write-Host "  静默安装 $($msi.Name)（/qn /norestart，约 10-15 秒、无需重启）"
  # 用 Start-Process -Wait -PassThru 拿退出码：msiexec 的码比 $LASTEXITCODE 可靠。
  # 整段包 try：脚本顶部是 $ErrorActionPreference='Stop'，一次拉不起来的安装不能把
  # install 整个动作带崩——那一步是尽力而为的。
  try {
    $p = Start-Process -FilePath 'msiexec.exe' -Wait -PassThru -ArgumentList @(
      '/i', "`"$($msi.FullName)`"", '/qn', '/norestart'
    )
  } catch {
    Write-Warning "  拉起 msiexec 失败：$_"
    return $false
  }
  switch ($p.ExitCode) {
    0       { Write-Host '  ok：已装'; return $true }
    3010    { Write-Host '  ok：已装，系统要求重启后完全生效'; return $true }
    1618    { Write-Warning '  1618：另一个安装正在进行，稍后重跑'; return $false }
    1603    { Write-Warning '  1603：安装失败——权限不足，或被组策略/AppLocker 拦了安装'; return $false }
    1625    { Write-Warning '  1625：被本机软件限制策略拒绝'; return $false }
    default { Write-Warning "  msiexec 退出码 $($p.ExitCode)：没装上"; return $false }
  }
}

function Start-Mysandbox {
  $t = Get-Task
  if (-not $t) {
    throw "计划任务 '$TaskName' 未注册——先跑：mysandbox.ps1 install"
  }
  # 先撤掉停止哨兵，否则 run 起来会立刻退出（见 run 分支）。
  Remove-Item $StopFlag -Force -ErrorAction SilentlyContinue
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
  # 先落停止哨兵再停进程：runner 的自愈循环会检查它，避免「停了又被自己拉起来」。
  try { New-Item -ItemType File -Path $StopFlag -Force | Out-Null } catch { }
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
    # 计划任务调用的本体：前台跑 node，stdout/stderr 追加进按天命名的 wrapper 日志。
    # 走 in-process（& $node）而不是 cmd 包装，是为了让 node 复用 powershell 的控制台
    # ——任务用 -WindowStyle Hidden 拉起时，控制台窗口不会弹出来。
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    $node = if ($env:MYSANDBOX_NODE) { $env:MYSANDBOX_NODE } else { 'node' }
    Set-Location $RepoDir
    # PS 5.1 按控制台 OEM 代码页（本机 GBK/936）解码原生进程的 stdout，而 node 吐的是
    # UTF-8 字节——中文会先被误读成 GBK、再按 UTF-8 落盘，变成「鐗堟湰」这种双层乱码（实测）。
    # 把控制台输出编码对齐成 UTF-8 即可；若上下文没有控制台，赋值可能抛，忽略。
    try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

    if (Test-Path $StopFlag) {
      Write-Wrap 'run 直接退出：存在停止哨兵（先 start 清掉它）'
      exit 0
    }

    # 自愈循环——这是「稳定重启」的真正落点。
    # 为什么不用任务计划程序自带的失败重试：XML 里 <RestartOnFailure><Count>3</Count>
    # <Interval>PT1M</Interval> 确实写进去了，但实测强杀进程后 85 秒内**并没有**被拉起
    # （任务停在 Ready、LastTaskResult=0xFFFFFFFF）；而任务级看门狗只有 PT5M 粒度。
    # 把重启做进 runner：恢复延迟从分钟级降到秒级，且完全不依赖调度器的失败判定语义。
    $failStreak = 0
    while ($true) {
      if (Test-Path $StopFlag) { Write-Wrap 'run 退出循环：停止哨兵出现'; exit 0 }
      $t0 = Get-Date
      Write-Wrap 'run start'
      $rc = 1
      try {
        # 刻意用 Out-File -Encoding UTF8，而不是 `*>> $WrapperLog`：PS 5.1 的重定向默认按
        # UTF-16LE 落盘，日志在 grep/tail 下会变二进制乱码（实测）。走管道则编码可控。
        & $node 'dist\server\cli.js' *>&1 | Out-File -FilePath $WrapperLog -Append -Encoding UTF8
        $rc = $LASTEXITCODE
      } catch {
        Write-Wrap "run failed: $_"
        $rc = 1
      }
      Write-Wrap "run exit rc=$rc"

      if (Test-Path $StopFlag) { Write-Wrap 'run 退出循环：停止哨兵出现'; exit $rc }

      if (((Get-Date) - $t0).TotalSeconds -lt 10) {
        # 跑不到 10 秒就挂，通常是引擎不可达（WSL 还没起来）——退避，别热循环刷日志。
        $failStreak++
        $delay = [int][Math]::Min(5 * [Math]::Pow(2, $failStreak - 1), 60)
        Write-Wrap "run 快速失败第 $failStreak 次，$delay 秒后重试"
        Start-Sleep -Seconds $delay
      } else {
        $failStreak = 0
        Write-Wrap 'run 意外退出，2 秒后重启'
        Start-Sleep -Seconds 2
      }
    }
  }

  'install' {
    if (-not (Test-Path (Join-Path $RepoDir 'dist\server\cli.js'))) {
      throw "找不到 dist\server\cli.js——先在仓库根跑 npm run build"
    }
    Remove-Item $StopFlag -Force -ErrorAction SilentlyContinue

    # WireGuard 依赖：**尽力而为**，失败不算 install 失败——没有集群隧道时其余功能照常。
    if ($SkipWireGuard) {
      Write-Host '== WireGuard 依赖：已按 -SkipWireGuard 跳过 =='
    } else {
      Write-Host '== WireGuard 依赖（Windows 侧集群隧道要用）=='
      if (-not (Install-WgDependency -Force:$Force)) {
        Write-Warning '  WireGuard 未就绪——集群隧道在 Windows 上不可用，其余功能不受影响。'
        Write-Warning '  装好后重跑：mysandbox.ps1 wireguard（然后 restart 让后端重新探测）'
      }
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
    # RunLevel Highest：集群隧道线（WireGuard Windows）没有免提权的配置更新通道——
    # wg set / 隧道服务重装 / Data\Configurations 写入全要管理员。任务以最高权限运行后
    # 这些操作不再需要每次 UAC。token 本就等价宿主任意命令能力，提权增量可控。
    $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Highest

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
    Write-Host "  触发    : $watchdog"
    Write-Host "  自愈    : runner 内部循环——node 一退出即重启（秒级）；看门狗是最后一道兜底"
    Write-Host "  监听    : 127.0.0.1:$Port"
    Write-Host "  日志    : $WrapperLog"
    Write-Host "  停止    : mysandbox.ps1 stop（落停止哨兵，不会被自愈循环复活）"
    Write-Host "  卸载    : mysandbox.ps1 uninstall"
  }

  'uninstall' {
    try { New-Item -ItemType File -Path $StopFlag -Force | Out-Null } catch { }
    $t = Get-Task
    if ($t) {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
      Write-Host "已注销计划任务 '$TaskName'"
    } else {
      Write-Host "计划任务 '$TaskName' 本来就没注册"
    }
    Stop-Listener -P $Port | Out-Null
    # 刻意不卸 WireGuard：别的软件可能共用同一份驱动，且卸内核驱动风险大于收益。
    Write-Host "（WireGuard 驱动保持原样未动）"
  }

  'wireguard' {
    # 显式装依赖：幂等——已装且不低于包内版本就直接跳过。
    if (-not (Install-WgDependency -Force:$Force)) {
      throw 'WireGuard 依赖未就绪（原因见上面的警告）'
    }
    if ((Get-ListenerPids -P $Port).Count -gt 0) {
      # 后端把 wgSupported() 探测结果缓存了（server/wireguard.ts），装完必须重启才认。
      Write-Host '  提示：mysandbox 正在运行，需要重启才会识别到 WireGuard —— mysandbox.ps1 restart'
    }
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

    # WireGuard 放在健康检查之前——它是本地事实，不该因为服务没起来就不显示。
    $wgHave = Get-WgInstalledVersion
    if (Test-Path $WgExe) {
      $wgLabel = if ($wgHave) { $wgHave } else { '已装(版本未知)' }
      $wgMsi = Get-WgMsi
      $wgPkg = if ($wgMsi) { [string](Get-WgMsiVersion $wgMsi.FullName) } else { '无包' }
      Write-Host "隧道依赖  : WireGuard ${wgLabel}  包内 ${wgPkg}"
    } else {
      Write-Host "隧道依赖  : 未装——Windows 集群隧道不可用；跑 mysandbox.ps1 wireguard"
    }

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
      Write-Host "--- $(Split-Path $WrapperLog -Leaf)（最后 $Tail 行）---"
      Get-Content $WrapperLog -Tail $Tail
    } else {
      Write-Host "--- $(Split-Path $WrapperLog -Leaf) 还不存在 ---"
    }
    Write-Host "--- mysandbox 自身日志（最后 $Tail 行）---"
    Push-Location $RepoDir
    try { & node 'dist\server\cli.js' logs $Tail } finally { Pop-Location }
  }
}
