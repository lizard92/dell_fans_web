# 构建并推送镜像到 Docker Hub (mixi92/dell_fans_web)
# 用法: 先在终端执行 docker login，再运行 .\push-dockerhub.ps1

$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot
$Image = "mixi92/dell_fans_web:latest"

Set-Location $ProjectDir

Write-Host "检查 Docker..." -ForegroundColor Cyan
docker ps | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker 未就绪，请先启动 Docker Desktop 并等待引擎运行。" -ForegroundColor Red
    exit 1
}

Write-Host "构建镜像 $Image ..." -ForegroundColor Cyan
docker build -t $Image .
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "推送到 Docker Hub..." -ForegroundColor Cyan
docker push $Image
if ($LASTEXITCODE -ne 0) {
    Write-Host "推送失败，请先执行: docker login" -ForegroundColor Red
    exit 1
}

Write-Host "完成! 镜像地址: https://hub.docker.com/r/mixi92/dell_fans_web" -ForegroundColor Green
