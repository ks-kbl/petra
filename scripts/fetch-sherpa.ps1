# 拉取 sherpa-onnx 官方预编译库（Windows x64 shared），供唤醒词（KWS）使用。
# 用法：powershell -ExecutionPolicy Bypass -File scripts/fetch-sherpa.ps1
# 产物：src-tauri/dlls/*.dll（随安装包一起分发）+ ~/petra-sherpa/prebuilt（构建时链接用）
$ErrorActionPreference = "Stop"
$ver = "1.12.9"
$root = Join-Path $env:USERPROFILE "petra-sherpa"
New-Item -ItemType Directory -Force -Path $root | Out-Null

$archive = "sherpa-onnx-v$ver-win-x64-shared.tar.bz2"
$local = Join-Path $root $archive
if (-not (Test-Path $local)) {
    Write-Host "查询 release 资产…"
    $h = @{ "User-Agent" = "petra-build"; "Accept" = "application/vnd.github+json" }
    if ($env:GITHUB_TOKEN) { $h["Authorization"] = "Bearer $env:GITHUB_TOKEN" }
    $rel = Invoke-RestMethod -Headers $h "https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/v$ver"
    $asset = $rel.assets | Where-Object { $_.name -eq $archive } | Select-Object -First 1
    if (-not $asset) { throw "没找到资产 $archive" }
    Write-Host "下载 $archive ($([math]::Round($asset.size/1MB,1)) MB)…"
    # api.github.com 的 asset 接口支持断点续传，比直连 github.com 稳
    Invoke-WebRequest -Headers @{ "User-Agent" = "petra-build"; "Accept" = "application/octet-stream" } `
        -Uri "https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/assets/$($asset.id)" -OutFile $local
}

$prebuilt = Join-Path $root "prebuilt"
New-Item -ItemType Directory -Force -Path $prebuilt | Out-Null
Write-Host "解压…"
tar -xjf $local -C $prebuilt

$libDir = Join-Path $prebuilt "sherpa-onnx-v$ver-win-x64-shared"
$dllDir = Join-Path (Split-Path $PSScriptRoot -Parent) "src-tauri\dlls"
New-Item -ItemType Directory -Force -Path $dllDir | Out-Null
Copy-Item (Join-Path $libDir "lib\*.dll") $dllDir -Force
Write-Host "DLL 已复制到 $dllDir"

$cfg = Join-Path (Split-Path $PSScriptRoot -Parent) ".cargo\config.toml"
Write-Host ""
Write-Host "构建前确保 .cargo/config.toml 里有：" -ForegroundColor Yellow
Write-Host "  [env]"
Write-Host "  SHERPA_LIB_PATH = `"$libDir`""
Write-Host "  LIBCLANG_PATH = `"<你的 libclang 目录>`"   # pip install libclang 后位于 site-packages\clang\native"
Write-Host ""
Write-Host "（当前配置文件：$cfg）"
