#Requires -Version 5.1
<#
.SYNOPSIS
  Đăng ký Native Messaging host "com.qidian.screenshot_host" cho Chrome.

.DESCRIPTION
  Sinh file manifest (com.qidian.screenshot_host.json) với đường dẫn tuyệt đối
  tới run_host.bat trong chính thư mục này, rồi đăng ký đường dẫn đó vào
  registry HKCU\Software\Google\Chrome\NativeMessagingHosts — Chrome chỉ đọc
  đúng key này để biết chạy host nào khi extension gọi connectNative().

.PARAMETER ExtensionId
  Extension ID lấy từ chrome://extensions (bật Developer mode để thấy ID),
  sau khi đã "Load unpacked" thư mục qidian-extension.

.EXAMPLE
  .\install.ps1 -ExtensionId "abcdefghijklmnopqrstuvwxyzabcdef"
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,

    [switch]$InstallDeps
)

$ErrorActionPreference = "Stop"
$hostDir = $PSScriptRoot
$batPath = Join-Path $hostDir "run_host.bat"
$manifestPath = Join-Path $hostDir "com.qidian.screenshot_host.json"

if ($InstallDeps) {
    Write-Host "Cài dependencies Python (mss, Pillow)..."
    python -m pip install -r (Join-Path $hostDir "requirements.txt")
}

$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCmd) {
    $pythonCmd = Get-Command py -ErrorAction SilentlyContinue
}
if (-not $pythonCmd) {
    Write-Warning "Không tìm thấy 'python' hoặc 'py' trong PATH. Cài Python 3 trước khi dùng native host."
}

$manifest = [ordered]@{
    name            = "com.qidian.screenshot_host"
    description     = "Qidian extension screen capture helper"
    path            = $batPath
    type            = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json | Set-Content -Encoding utf8 -Path $manifestPath
Write-Host "Đã ghi manifest: $manifestPath"

$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.qidian.screenshot_host"
New-Item -Path $regPath -Force | Out-Null
Set-Item -Path $regPath -Value $manifestPath
Write-Host "Đã đăng ký registry: $regPath -> $manifestPath"

Write-Host ""
Write-Host "Xong. Nếu popup extension báo lỗi kết nối native host, kiểm tra:"
Write-Host "  1. Extension ID đúng chưa (chrome://extensions, bật Developer mode)."
Write-Host "  2. python/py chạy được run_host.bat: $batPath"
Write-Host "  3. Đã cài mss+Pillow chưa (chạy lại với -InstallDeps nếu chưa chắc)."
