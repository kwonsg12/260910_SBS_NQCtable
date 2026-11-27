<#
  통합관제실 근무표 서버 — Windows 트레이 실행기

  사무실 공용 PC(24시간 켜 둠)에서 `node server.js` 를 명령창 없이 띄우고 지킨다.
  - 트레이 아이콘 색으로 서버 상태를 보여 준다 (초록 실행 중 · 노랑 켜는 중 · 빨강 멈춤).
  - 서버가 죽으면 저절로 다시 켠다 (5초 → 최대 60초 간격).
  - 이 PC가 잠들지 않게 한다 (실행기가 떠 있는 동안만. Windows 설정은 바꾸지 않는다).
  - 상태 창: 접속 주소 복사, 근무표 열기, 다시 시작, 업데이트(GitHub 새 버전), 로그 보기, 자동 실행 켜기/끄기.
  - 자동 실행은 "시작프로그램" 폴더의 바로가기로 한다 (관리자 권한 필요 없음).

  사용:
    windows\설치.cmd 를 더블클릭 (처음 한 번)        → 바로가기를 만들고 실행기를 띄운다
    powershell -File windows\tray.ps1 -Check         → 창 없이 켜지는지만 확인하고 끈다 (점검용)
    powershell -File windows\tray.ps1 -Uninstall     → 자동 실행·바탕화면 바로가기를 지운다

  서버 출력은 logs\server-YYYY-MM-DD.log 에 쌓인다 (logs\ 는 git 에 올리지 않는다).
  이 파일은 UTF-8(BOM) 이어야 한다 — Windows PowerShell 5.1 은 BOM 없는 파일의 한글을 깨뜨린다.
#>
param(
  [switch]$Check,
  [int]$CheckSeconds = 40,
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Show          # 상태 창을 바로 연다 (바탕화면 바로가기). 이미 떠 있으면 그 창을 앞으로.
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSScriptRoot
$AppName = '통합관제실 근무표 서버'
$LogDir = Join-Path $Root 'logs'
$StartVbs = Join-Path $PSScriptRoot 'start.vbs'
$StartupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) ($AppName + '.lnk')
$DesktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) ($AppName + '.lnk')

# ---------------------------------------------------------------- 설정 읽기
function Get-Port {
  $port = 8000
  $envFile = Join-Path $Root '.env'
  if (Test-Path $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
      if ($line -match '^\s*PORT\s*=\s*"?(\d+)"?\s*$') { $port = [int]$Matches[1] }
    }
  }
  if ($env:PORT -match '^\d+$') { $port = [int]$env:PORT }
  return $port
}

$Port = Get-Port
$LocalUrl = "http://localhost:$Port"

function Find-Node {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($candidate in @(
      (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  return $null
}

# ---------------------------------------------------------------- 바로가기
function New-Shortcut([string]$Path, [string]$Extra = '') {
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($Path)
  $link.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $link.Arguments = ('"' + $StartVbs + '" ' + $Extra).Trim()
  $link.WorkingDirectory = $Root
  $link.Description = $AppName
  $link.IconLocation = (Join-Path $env:WINDIR 'System32\shell32.dll') + ',15'
  $link.Save()
}

function Test-AutoStart { return (Test-Path -LiteralPath $StartupLnk) }

function Set-AutoStart([bool]$On) {
  if ($On) { New-Shortcut $StartupLnk }
  elseif (Test-Path -LiteralPath $StartupLnk) { Remove-Item -LiteralPath $StartupLnk -Force }
}

if ($Uninstall) {
  foreach ($path in @($StartupLnk, $DesktopLnk)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force; Write-Output "지웠습니다: $path" }
  }
  exit 0
}

if ($Install) {
  New-Shortcut $StartupLnk                 # 로그인하면 조용히 트레이로
  New-Shortcut $DesktopLnk '-Show'         # 바탕화면 아이콘은 상태 창을 연다
  Write-Output "자동 실행 바로가기: $StartupLnk"
  Write-Output "바탕화면 바로가기: $DesktopLnk"
  Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $StartVbs + '" -Show')
  exit 0
}

# ---------------------------------------------------------------- 서버 다루기
$script:Proc = $null
$script:LogFile = $null
$script:StartedAt = $null

function Test-Server {
  try {
    # localhost 는 IPv6(::1) 로 먼저 가는데 서버는 IPv4(0.0.0.0) 로만 듣는다 → 2초 기다리다 실패한다.
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/lock" -UseBasicParsing -TimeoutSec 2
    return ($response.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Write-LauncherLog([string]$Text) {
  # 서버 출력 파일(server-*.log)은 cmd 가 쥐고 있어 같이 쓰면 "다른 프로세스에서 사용 중" 이 난다.
  # 실행기 기록은 launcher-*.log 에 따로 남긴다. 기록이 실패해도 실행기는 멈추지 않는다.
  try {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $file = Join-Path $LogDir ('launcher-{0}.log' -f (Get-Date -Format 'yyyy-MM-dd'))
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text
    [System.IO.File]::AppendAllText($file, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

function Start-Server {
  $node = Find-Node
  if (-not $node) { throw 'Node.js 를 찾을 수 없습니다. https://nodejs.org 에서 LTS(22.5 이상)를 설치해 주세요.' }
  if (-not (Test-Path (Join-Path $Root 'node_modules'))) { throw '구성요소가 없습니다. windows\설치.cmd 를 먼저 실행해 주세요.' }
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $script:LogFile = Join-Path $LogDir ('server-{0}.log' -f (Get-Date -Format 'yyyy-MM-dd'))
  Write-LauncherLog ('서버를 켭니다: {0} server.js (포트 {1})' -f $node, $Port)
  # 출력 넘기기는 cmd 에 맡긴다. PowerShell 이벤트로 받으면 창이 도는 동안 처리되지 않는다.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = '/d /c ""{0}" server.js >> "{1}" 2>&1"' -f $node, $script:LogFile
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $script:Proc = [System.Diagnostics.Process]::Start($psi)
  $script:StartedAt = Get-Date
}

function Stop-Server {
  if ($script:Proc -and -not $script:Proc.HasExited) {
    Write-LauncherLog '서버를 끕니다.'
    # cmd 와 그 아래 node 를 함께 끈다.
    & taskkill.exe /PID $script:Proc.Id /T /F 2>$null | Out-Null
    try { $script:Proc.WaitForExit(5000) | Out-Null } catch { }
  }
  $script:Proc = $null
  $script:StartedAt = $null
}

function Test-OwnRunning { return ($script:Proc -and -not $script:Proc.HasExited) }

function Get-LanUrl {
  # 서버가 켜질 때 "사내망 접속 주소: http://…" 를 남긴다. 서버와 같은 계산을 쓰려고 그 줄을 읽는다.
  if ($script:LogFile -and (Test-Path -LiteralPath $script:LogFile)) {
    $lines = Get-Content -LiteralPath $script:LogFile -Encoding UTF8 -Tail 400
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
      if ($lines[$i] -match '사내망 접속 주소:\s*(http\S+)') { return $Matches[1] }
    }
  }
  return $null
}

function Get-LogTail([int]$Count = 14) {
  if ($script:LogFile -and (Test-Path -LiteralPath $script:LogFile)) {
    return ((Get-Content -LiteralPath $script:LogFile -Encoding UTF8 -Tail $Count) -join [Environment]::NewLine)
  }
  return '아직 기록이 없습니다.'
}

# ---------------------------------------------------------------- 점검 모드 (창 없음)
if ($Check) {
  $external = Test-Server
  if ($external) {
    Write-Output "이미 실행 중인 서버가 있습니다: $LocalUrl"
    exit 0
  }
  try { Start-Server } catch { Write-Output ('실패: ' + $_.Exception.Message); exit 1 }
  $deadline = (Get-Date).AddSeconds($CheckSeconds)
  $ok = $false
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-OwnRunning)) { break }
    if (Test-Server) { $ok = $true; break }
    Start-Sleep -Milliseconds 500
  }
  $lan = Get-LanUrl
  Stop-Server
  if ($ok) {
    Write-Output "정상: $LocalUrl"
    if ($lan) { Write-Output "사내망: $lan" }
    exit 0
  }
  Write-Output '실패: 서버가 응답하지 않았습니다. 기록:'
  Write-Output (Get-LogTail 20)
  exit 1
}

# ---------------------------------------------------------------- 트레이 + 상태 창
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# 같은 PC 에서 두 번 띄우지 않는다. 두 번째로 켜면(바탕화면 아이콘 등) 이미 떠 있는 실행기의
# 상태 창을 앞으로 불러내고 끝난다.
$showEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, 'Local\SBS_NQCtable_Show')
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\SBS_NQCtable_Tray', [ref]$createdNew)
if (-not $createdNew) {
  [void]$showEvent.Set()
  exit 0
}

# 이 실행기가 떠 있는 동안 PC 가 잠들지 않게 한다 (끄면 원래대로). Windows 전원 설정은 그대로다.
Add-Type -Namespace Nqc -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
[Nqc.Power]::SetThreadExecutionState([uint32]'0x80000001') | Out-Null   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED

$Colors = @{
  running  = [System.Drawing.Color]::FromArgb(46, 125, 94)
  starting = [System.Drawing.Color]::FromArgb(183, 121, 31)
  stopped  = [System.Drawing.Color]::FromArgb(190, 67, 88)
}

function New-StatusIcon([System.Drawing.Color]$Color) {
  # 트레이가 실제로 쓰는 크기(16·20·24px…)에 맞춰 그린다. 32px 하나만 주면 Windows 가 거칠게
  # 줄여서 "근" 글자가 깨져 보인다. 8배 크게 그려 부드럽게 줄인다 (NQC 루틴 아이콘과 같은 방법).
  $size = [System.Windows.Forms.SystemInformation]::SmallIconSize.Width
  if ($size -lt 16) { $size = 16 }
  $big = $size * 8
  $canvas = New-Object System.Drawing.Bitmap $big, $big
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  # 바탕: NQC 파란 둥근 타일 (NQC 루틴과 같은 그림). 16px 에서 "근" 같은 한글은 획이 뭉개져서
  # 영문 NQC 로 쓰고, 상태는 오른쪽 아래 색 점으로 말한다 (사용자 지적 2026-11-10).
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [int]($big * 0.44)
  $m = $big - 1 - $d
  $path.AddArc(0, 0, $d, $d, 180, 90); $path.AddArc($m, 0, $d, $d, 270, 90)
  $path.AddArc($m, $m, $d, $d, 0, 90); $path.AddArc(0, $m, $d, $d, 90, 90)
  $path.CloseFigure()
  $rect = New-Object System.Drawing.Rectangle(0, 0, $big, $big)
  $tile = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect,
    [System.Drawing.Color]::FromArgb(40, 128, 255), [System.Drawing.Color]::FromArgb(6, 66, 196), 90.0)
  $g.FillPath($tile, $path)
  $family = 'Arial Narrow'
  if (-not ((New-Object System.Drawing.Text.InstalledFontCollection).Families | Where-Object Name -eq $family)) { $family = 'Arial' }
  $font = New-Object System.Drawing.Font($family, ($big * 0.42), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  $fmt.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
  $g.DrawString('NQC', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(0, (-$big * 0.13), $big, $big)), $fmt)
  # 상태 점: 흰 테두리를 둘러 파란 바탕에서도 떨어져 보이게.
  $dot = [int]($big * 0.42)
  $at = $big - $dot
  $g.FillEllipse([System.Drawing.Brushes]::White, $at, $at, $dot, $dot)
  $ring = [int]($big * 0.07)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $Color), ($at + $ring), ($at + $ring), ($dot - 2 * $ring), ($dot - 2 * $ring))
  $g.Dispose()
  $small = New-Object System.Drawing.Bitmap $size, $size
  $s = [System.Drawing.Graphics]::FromImage($small)
  $s.InterpolationMode = 'HighQualityBicubic'
  $s.PixelOffsetMode = 'HighQuality'
  $s.SmoothingMode = 'AntiAlias'
  $s.DrawImage($canvas, 0, 0, $size, $size)
  $s.Dispose()
  $canvas.Dispose()
  return [System.Drawing.Icon]::FromHandle($small.GetHicon())
}
$Icons = @{}
foreach ($key in $Colors.Keys) { $Icons[$key] = New-StatusIcon $Colors[$key] }

$script:Wanted = $true          # 사용자가 [멈춤] 을 누르면 $false
$script:State = 'starting'
$script:External = $false
$script:Restarts = 0
$script:NextTry = Get-Date
$script:Backoff = 5
$script:HealthyAt = $null

# ---- 상태 창
$font = New-Object System.Drawing.Font('Malgun Gothic', 10)
$form = New-Object System.Windows.Forms.Form
$form.Text = $AppName
$form.Font = $font
$form.AutoScaleMode = 'Dpi'
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.ClientSize = New-Object System.Drawing.Size(560, 470)
$form.BackColor = [System.Drawing.Color]::White
$form.Icon = $Icons['running']

$title = New-Object System.Windows.Forms.Label
$title.Text = $AppName
$title.Font = New-Object System.Drawing.Font('Malgun Gothic', 14, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(24, 20)
$form.Controls.Add($title)

$dot = New-Object System.Windows.Forms.Label
$dot.Size = New-Object System.Drawing.Size(14, 14)
$dot.Location = New-Object System.Drawing.Point(26, 66)
$form.Controls.Add($dot)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Font = New-Object System.Drawing.Font('Malgun Gothic', 11, [System.Drawing.FontStyle]::Bold)
$statusLabel.AutoSize = $true
$statusLabel.Location = New-Object System.Drawing.Point(46, 61)
$form.Controls.Add($statusLabel)

$detailLabel = New-Object System.Windows.Forms.Label
$detailLabel.ForeColor = [System.Drawing.Color]::FromArgb(94, 78, 68)
$detailLabel.AutoSize = $true
$detailLabel.MaximumSize = New-Object System.Drawing.Size(500, 0)   # 길면 다음 줄로
$detailLabel.Location = New-Object System.Drawing.Point(46, 88)
$form.Controls.Add($detailLabel)

function Add-AddressRow([string]$Caption, [int]$Top) {
  $key = New-Object System.Windows.Forms.Label
  $key.Text = $Caption
  $key.ForeColor = [System.Drawing.Color]::FromArgb(118, 101, 90)
  $key.AutoSize = $true
  $key.Location = New-Object System.Drawing.Point(24, ($Top + 6))
  $form.Controls.Add($key)
  $box = New-Object System.Windows.Forms.TextBox
  $box.ReadOnly = $true
  $box.BorderStyle = 'FixedSingle'
  $box.BackColor = [System.Drawing.Color]::FromArgb(250, 247, 243)
  $box.Font = New-Object System.Drawing.Font('Consolas', 10)
  $box.Location = New-Object System.Drawing.Point(110, $Top)
  $box.Size = New-Object System.Drawing.Size(330, 28)
  $form.Controls.Add($box)
  $copy = New-Object System.Windows.Forms.Button
  $copy.Text = '복사'
  $copy.Location = New-Object System.Drawing.Point(450, ($Top - 1))
  $copy.Size = New-Object System.Drawing.Size(86, 30)
  $copy.Add_Click({ if ($box.Text) { [System.Windows.Forms.Clipboard]::SetText($box.Text) } }.GetNewClosure())
  $form.Controls.Add($copy)
  return $box
}
$localBox = Add-AddressRow '이 PC' 126
$lanBox = Add-AddressRow '사내망' 164

function New-Button([string]$Text, [int]$Left, [scriptblock]$OnClick) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $Text
  $b.Location = New-Object System.Drawing.Point($Left, 212)
  $b.Size = New-Object System.Drawing.Size(98, 38)
  $b.Add_Click($OnClick)
  $form.Controls.Add($b)
  return $b
}
$openBtn = New-Button '근무표 열기' 24 { Start-Process $LocalUrl }
$openBtn.BackColor = [System.Drawing.Color]::FromArgb(165, 96, 61)
$openBtn.ForeColor = [System.Drawing.Color]::White
$openBtn.FlatStyle = 'Flat'
$openBtn.FlatAppearance.BorderSize = 0
$restartBtn = New-Button '다시 시작' 128 { Restart-FromUser }
$stopBtn = New-Button '멈춤' 232 { Toggle-FromUser }
$updateBtn = New-Button '업데이트' 336 { Start-UpdateFromUser }
$logBtn = New-Button '로그 폴더' 440 { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null; Start-Process explorer.exe $LogDir }
$logBtn.Size = New-Object System.Drawing.Size(96, 38)

$autoBox = New-Object System.Windows.Forms.CheckBox
$autoBox.Text = 'Windows 에 로그인하면 저절로 켜기'
$autoBox.AutoSize = $true
$autoBox.Location = New-Object System.Drawing.Point(24, 266)
$autoBox.Checked = Test-AutoStart
$autoBox.Add_CheckedChanged({ Set-AutoStart $autoBox.Checked; $autoItem.Checked = $autoBox.Checked })
$form.Controls.Add($autoBox)

$logLabel = New-Object System.Windows.Forms.Label
$logLabel.Text = '최근 기록'
$logLabel.ForeColor = [System.Drawing.Color]::FromArgb(118, 101, 90)
$logLabel.AutoSize = $true
$logLabel.Location = New-Object System.Drawing.Point(24, 300)
$form.Controls.Add($logLabel)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true
$logBox.ReadOnly = $true
$logBox.ScrollBars = 'Vertical'
$logBox.WordWrap = $false
$logBox.BorderStyle = 'FixedSingle'
$logBox.BackColor = [System.Drawing.Color]::FromArgb(250, 247, 243)
$logBox.Font = New-Object System.Drawing.Font('Consolas', 9)
$logBox.Location = New-Object System.Drawing.Point(24, 322)
$logBox.Size = New-Object System.Drawing.Size(512, 128)
$form.Controls.Add($logBox)

# 창의 X 는 숨기기. 실행기를 끄는 건 트레이 메뉴의 [종료] 뿐이다.
$script:Quitting = $false
$form.Add_FormClosing({
  param($sender, $e)
  if (-not $script:Quitting) { $e.Cancel = $true; $form.Hide() }
})

# ---- 트레이 아이콘
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $Icons['starting']
$tray.Text = $AppName
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Font = $font
$openItem = $menu.Items.Add('근무표 열기')
$openItem.Font = New-Object System.Drawing.Font('Malgun Gothic', 10, [System.Drawing.FontStyle]::Bold)
$openItem.Add_Click({ Start-Process $LocalUrl })
$statusItem = $menu.Items.Add('상태 창 열기')
$statusItem.Add_Click({ Show-StatusForm })
$copyItem = $menu.Items.Add('사내망 주소 복사')
$copyItem.Add_Click({ $url = Get-LanUrl; if (-not $url) { $url = $LocalUrl }; [System.Windows.Forms.Clipboard]::SetText($url); $tray.ShowBalloonTip(2000, $AppName, "복사했습니다: $url", 'Info') })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$restartItem = $menu.Items.Add('서버 다시 시작')
$restartItem.Add_Click({ Restart-FromUser })
$updateItem = $menu.Items.Add('GitHub 에서 업데이트')
$updateItem.Add_Click({ Start-UpdateFromUser })
$autoItem = New-Object System.Windows.Forms.ToolStripMenuItem('Windows 로그인 시 자동 실행')
$autoItem.CheckOnClick = $true
$autoItem.Checked = Test-AutoStart
$autoItem.Add_Click({ Set-AutoStart $autoItem.Checked; $autoBox.Checked = $autoItem.Checked })
[void]$menu.Items.Add($autoItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quitItem = $menu.Items.Add('종료 (서버도 끔)')
$quitItem.Add_Click({ Quit-App })
$tray.ContextMenuStrip = $menu
$tray.Add_MouseDoubleClick({ Show-StatusForm })

function Show-StatusForm {
  Update-View
  $form.Show()
  $form.WindowState = 'Normal'
  $form.Activate()
  # 주소 칸이 파랗게 선택된 채 열리지 않게 [근무표 열기] 에 포커스를 준다.
  [void]$openBtn.Focus()
}

function Restart-FromUser {
  $script:Wanted = $true
  $script:Backoff = 5
  if (Test-OwnRunning) { Stop-Server }
  # 사람이 끈 것이라 "서버가 멈췄습니다" 알림을 띄우지 않는다.
  $script:State = 'starting'
  $script:NextTry = Get-Date
  Invoke-Watchdog
}

function Toggle-FromUser {
  if ($script:Wanted) {
    $answer = [System.Windows.Forms.MessageBox]::Show('서버를 멈추면 다른 PC 에서 근무표를 열 수 없습니다. 멈출까요?', $AppName, 'YesNo', 'Warning')
    if ($answer -ne 'Yes') { return }
    $script:Wanted = $false
    Stop-Server
  } else {
    $script:Wanted = $true
    $script:State = 'starting'
    $script:NextTry = Get-Date
  }
  Invoke-Watchdog
}

# [업데이트]: windows\업데이트.cmd 를 실행한다 (새 버전 확인 → 서버 끄기 → DB 백업 → git pull → 다시 켜기).
# update.ps1 은 이 실행기를 자식 프로세스까지 통째로 끄므로(taskkill /T), 업데이트 창을 이 실행기의
# 자식으로 띄우면 업데이트 도중에 같이 꺼진다. 그래서 탐색기를 거쳐 따로 띄운다.
function Start-UpdateFromUser {
  $updateCmd = Join-Path $PSScriptRoot '업데이트.cmd'
  if (-not (Test-Path -LiteralPath $updateCmd)) {
    [void][System.Windows.Forms.MessageBox]::Show("업데이트 파일이 없습니다:`n$updateCmd", $AppName, 'OK', 'Error')
    return
  }
  $editing = ''
  try {
    $lock = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/lock" -TimeoutSec 2
    if ($lock.locked) { $editing = [string]$lock.holderName }
  } catch { }
  $message = "GitHub 에서 새 버전을 받아 반영합니다.`n`n" +
    "· 새 버전이 없으면 아무것도 바꾸지 않습니다.`n" +
    "· 새 버전이 있으면 서버가 잠깐(1분 안팎) 꺼졌다 켜지고, 로그인한 사람은 모두 다시 로그인해야 합니다.`n" +
    "· 근무표 데이터(geunmupyo.db)는 먼저 backups 폴더에 백업합니다.`n" +
    "· 끝나면 접속해 있던 브라우저 탭을 모두 새로 열어 주세요.`n`n업데이트할까요?"
  $iconType = 'Question'
  if ($editing) {
    $message = "지금 $editing 님이 근무표를 편집 중입니다. 업데이트하면 저장하지 않은 편집 내용이 사라질 수 있습니다.`n`n" + $message
    $iconType = 'Warning'
  }
  $answer = [System.Windows.Forms.MessageBox]::Show($message, $AppName, 'YesNo', $iconType)
  if ($answer -ne 'Yes') { return }
  try {
    Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList ('"' + $updateCmd + '"')
  } catch {
    [void][System.Windows.Forms.MessageBox]::Show("업데이트를 시작하지 못했습니다: $($_.Exception.Message)`n`nwindows\업데이트.cmd 를 직접 더블클릭해 주세요.", $AppName, 'OK', 'Error')
  }
}

function Quit-App {
  $answer = [System.Windows.Forms.MessageBox]::Show('실행기를 끄면 서버도 꺼져서 다른 PC 에서 근무표를 열 수 없습니다. 끌까요?', $AppName, 'YesNo', 'Warning')
  if ($answer -ne 'Yes') { return }
  $script:Quitting = $true
  $timer.Stop()
  Stop-Server
  $tray.Visible = $false
  $tray.Dispose()
  [Nqc.Power]::SetThreadExecutionState([uint32]'0x80000000') | Out-Null
  $form.Close()
  [System.Windows.Forms.Application]::Exit()
}

function Format-Uptime {
  if (-not $script:HealthyAt) { return '' }
  $span = (Get-Date) - $script:StartedAt
  if ($span.TotalDays -ge 1) { return ('{0}일 {1}시간째' -f [int][math]::Floor($span.TotalDays), $span.Hours) }
  if ($span.TotalHours -ge 1) { return ('{0}시간 {1}분째' -f [int][math]::Floor($span.TotalHours), $span.Minutes) }
  if ($span.TotalMinutes -lt 1) { return '방금 켜짐' }
  return ('{0}분째' -f [int][math]::Floor($span.TotalMinutes))
}

function Update-View {
  switch ($script:State) {
    'running'  { $caption = '실행 중'; $icon = 'running'
                 $detail = if ($script:External) { '이 실행기 밖에서 켠 서버가 응답하고 있습니다.' } else { (Format-Uptime) + ' · 다른 PC 에서 사내망 주소로 접속할 수 있습니다.' } }
    'starting' { $caption = '켜는 중'; $icon = 'starting'; $detail = '서버가 응답하기를 기다리는 중입니다.' }
    'retrying' { $caption = '다시 켜는 중'; $icon = 'starting'; $detail = ('서버가 멈춰서 다시 켭니다 ({0}번째).' -f $script:Restarts) }
    'stopped'  { $caption = '멈춤'; $icon = 'stopped'; $detail = '[다시 시작] 을 누르면 켭니다.' }
    default    { $caption = '문제 있음'; $icon = 'stopped'; $detail = $script:State }
  }
  $statusLabel.Text = $caption
  $statusLabel.ForeColor = $Colors[$icon]
  $dot.BackColor = $Colors[$icon]
  $detailLabel.Text = $detail
  $tray.Icon = $Icons[$icon]
  $tip = "$AppName · $caption"
  if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
  $tray.Text = $tip
  $stopBtn.Text = if ($script:Wanted) { '멈춤' } else { '켜기' }
  $localBox.Text = $LocalUrl
  $lan = Get-LanUrl
  $lanBox.Text = if ($lan) { $lan } else { '(서버가 켜지면 보입니다)' }
  if ($form.Visible) { $logBox.Text = Get-LogTail 14; $logBox.SelectionStart = $logBox.Text.Length; $logBox.ScrollToCaret() }
}

function Invoke-Watchdog {
  $now = Get-Date
  if (-not $script:Wanted) {
    $script:State = 'stopped'
    Update-View
    return
  }
  if (Test-OwnRunning) {
    $script:External = $false
    if (Test-Server) {
      if ($script:State -ne 'running') { $script:HealthyAt = $now }
      $script:State = 'running'
      # 1분 넘게 멀쩡하면 재시작 간격을 처음으로 되돌린다.
      if ($script:HealthyAt -and ($now - $script:HealthyAt).TotalSeconds -gt 60) { $script:Backoff = 5 }
    } elseif ($script:StartedAt -and ($now - $script:StartedAt).TotalSeconds -gt 30) {
      $script:State = '서버가 30초 넘게 응답하지 않습니다. 기록을 확인해 주세요.'
    } else {
      $script:State = 'starting'
    }
    Update-View
    return
  }
  # 우리가 켠 서버가 없다. 누가 이미 켜 두었으면 그걸 쓴다 (같은 포트에 두 번 켜지 않는다).
  if (Test-Server) {
    $script:External = $true
    $script:State = 'running'
    Update-View
    return
  }
  $script:External = $false
  if ($null -ne $script:Proc -or $script:State -eq 'running') {
    # 켜져 있던 서버가 죽었다.
    $script:Restarts++
    Write-LauncherLog ('서버가 멈췄습니다. {0}초 뒤 다시 켭니다.' -f $script:Backoff)
    $tray.ShowBalloonTip(4000, $AppName, '서버가 멈춰서 다시 켭니다.', 'Warning')
    $script:Proc = $null
    $script:NextTry = $now.AddSeconds($script:Backoff)
    $script:Backoff = [math]::Min(60, $script:Backoff * 2)
    $script:State = 'retrying'
    Update-View
    return
  }
  if ($now -ge $script:NextTry) {
    try {
      Start-Server
      $script:State = 'starting'
    } catch {
      $script:State = $_.Exception.Message
      $script:NextTry = $now.AddSeconds(30)
    }
  }
  Update-View
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.Add_Tick({ try { Invoke-Watchdog } catch { $script:State = $_.Exception.Message } })

# 두 번째 실행이 보낸 "창 보여 줘" 신호를 0.5초마다 본다.
$showTimer = New-Object System.Windows.Forms.Timer
$showTimer.Interval = 500
$showTimer.Add_Tick({ if ($showEvent.WaitOne(0)) { Show-StatusForm } })

Invoke-Watchdog
$timer.Start()
$showTimer.Start()
if ($Show) { Show-StatusForm }
else { $tray.ShowBalloonTip(3000, $AppName, '트레이에서 서버를 지키고 있습니다. 아이콘을 두 번 누르면 상태 창이 열립니다.', 'Info') }
[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
