# Dell Fans Web

这是一个把 `cw1997/dell_fans_controller` 的核心风扇控制逻辑改造成网页服务的版本，针对手机端访问做了优化：

- 后端：`ASP.NET Core Minimal API`
- 前端：静态 HTML + JavaScript
- 部署：Docker
- 控制方式：容器内调用 Linux 版 `ipmitool`

## 已实现功能

- 手机优先的控制台界面
- 账号密码登录，登录后保持会话
- 服务端固定 IPMI 配置，前端无需再填写连接信息
- 设置手动风扇转速
- 恢复自动风扇控制
- 查看并分类展示 `ipmitool sensor` 传感器输出

## 目录结构

```text
dell_fans_controller_web/
├─ src/
│  ├─ DellFansWeb.csproj
│  ├─ Program.cs
│  ├─ appsettings.json
│  └─ wwwroot/
│     ├─ index.html
│     ├─ app.js
│     └─ styles.css
├─ Dockerfile
├─ docker-compose.yml
└─ README.md
```

## 本地运行

如果你的机器装有完整 .NET SDK，可以进入 `src` 目录后运行：

在运行前，先通过环境变量或 `appsettings.json` 配好登录账号和 IPMI 参数，再执行：

```powershell
dotnet run
```

默认访问地址：

- `http://localhost:5000`
- 或 `https://localhost:5001`

## Docker 运行

### 方式 1：直接构建

```powershell
docker build -t dell-fans-web .
docker run -d `
  --name dell-fans-web `
  -p 6060:6060 `
  -e APP__ADMINUSERNAME=admin `
  -e APP__ADMINPASSWORD=你的登录密码 `
  -e APP__IPMIHOST=192.168.1.100 `
  -e APP__IPMIUSERNAME=root `
  -e APP__IPMIPASSWORD=你的iDRAC密码 `
  dell-fans-web
```

### 方式 2：使用 compose

先把 `docker-compose.yml` 里的账号密码和 IPMI 参数改成你自己的，再执行：

```powershell
docker compose up -d --build
```

然后访问：

- `http://你的主机IP:6060`

## 页面使用方式

1. 打开页面。
2. 输入网页登录账号和密码。
3. 登录成功后直接进入控制台。
4. 设置风扇转速，或恢复自动模式。
5. 点击“刷新传感器”查看分类后的温度、风扇、供电和状态信息。

## 配置说明

- `APP__ADMINUSERNAME`
  - 登录账号
  - 默认值：`admin`

- `APP__ADMINPASSWORD`
  - 登录密码
  - 建议设置强密码

- `APP__IPMIHOST`
  - iDRAC / IPMI 地址

- `APP__IPMIUSERNAME`
  - IPMI 用户名

- `APP__IPMIPASSWORD`
  - IPMI 密码

- `APP__IPMITOOLPATH`
  - `ipmitool` 命令路径
  - 默认值：`ipmitool`

## 安全建议

- 不要把这个服务直接裸露到公网。
- 至少修改默认登录账号或密码中的一个，最好两个都改。
- 最好再通过反向代理加一层 HTTPS 和额外访问限制。
- IPMI 账号建议使用权限受控账号，不要直接暴露默认密码。

## 后续建议

这个版本已经能用，但后面还可以继续增强：

- 支持多台服务器
- 增加温度阈值自动调速策略
- 增加操作日志
- 增加风扇曲线和定时任务
