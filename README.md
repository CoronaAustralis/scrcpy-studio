# Scrcpy Studio

独立的本地 Android Web 投屏客户端。Node.js 后端直接读取 **官方 scrcpy 4.1** 的 H.264 码流，浏览器使用 **WebCodecs + Worker + OffscreenCanvas** 解码和绘制。默认长边 1920、8 Mbps、最高 60 FPS，窗口缩放不改变编码分辨率。

运行时只有一个 npm 依赖：`ws@8.22.0`。不依赖旧的 ws-scrcpy、adbkit、FFmpeg、WASM 解码器或 MP4 转封装库；没有打包步骤。

## Docker / GitHub 镜像

**将本目录 `scrcpy-studio` 作为 GitHub 仓库根目录**（其中包含 `.github/workflows/docker.yml`），不要把它再嵌套到仓库的子目录。推送到 `main` / `master`、推送 `v*` 版本标签或手动运行 Actions，会先检查代码和测试，再构建并发布 `ghcr.io/<owner>/<repository>`。默认分支生成 `latest`，`v0.2.0` 生成 `0.2.0` / `0.2`，另外附带提交 SHA 标签。PR 只构建，不推送。

使用仓库自带的 `GITHUB_TOKEN`，无需创建 Docker Hub 密钥；仓库需允许 Actions 写入 Packages。首次发布后，如需免登录拉取，在 GitHub Package 设置中将包设为 Public；私有包则先登录 GHCR。

镜像包含 Node.js 24、ADB、官方 scrcpy 4.1 客户端及 `scrcpy-server`，无需宿主机安装 Node / pnpm / ADB / scrcpy。官方 Linux 包有固定 SHA-256 校验。目前构建 **linux/amd64**；ARM64 主机需要模拟运行，尚未提供原生 ARM64 镜像。网页投屏不需要容器显示服务器，也不需要给容器映射 GPU；硬解发生在访问网页的电脑浏览器中。

在本目录自行构建镜像：

```sh
docker build -t scrcpy-studio:local .
```

使用发布的镜像启动（替换小写 owner/repository；本地构建时将镜像名换成 `scrcpy-studio:local`）：

```sh
docker run -d --name scrcpy-studio --restart unless-stopped \
  -p 8787:8787 \
  -e TLS_HOSTS=localhost,127.0.0.1,192.168.1.20 \
  -v scrcpy-adb-keys:/home/node/.android \
  -v scrcpy-tls:/home/node/.tls \
  ghcr.io/owner/repository:latest
```

将示例中的 `192.168.1.20` 换成运行容器的服务器 IP。镜像默认启用 HTTPS，首次启动自动生成证书。按下文导入 CA 信任后，打开 https://localhost:8787 或 `https://服务器IP:8787`，点击 **ADB 管理 · 连接设备**，输入手机或 Redroid 的局域网 IP 和 ADB 端口即可连接。镜像启动时自动启动自身的 ADB server。命名卷保存 ADB 授权密钥和 HTTPS 证书；首次连接仍须在手机确认授权。容器无需暴露 ADB 的 5037 端口。

端口示例发布到宿主机所有网络接口，不限定回环地址。查看日志用 `docker logs -f scrcpy-studio`。更新时拉取新镜像并重新创建容器，继续使用同一个密钥卷，避免重新授权。

### Web UI 的 ADB 操作

- 连接 / 单独断开网络设备，显示在线、离线和未授权设备。
- Android 11+ 六位码无线配对。**配对端口与连接端口不同**：配对后，填写无线调试主页显示的连接端口再连接。配对码不会存储。
- 重连离线设备、断开所有网络设备、重启容器内的 ADB。重启会结束所有投屏，需要重新连接网络设备。

手机必须事先开启 USB 调试或无线调试。传统 `5555` 网络 ADB 需要设备已经启用 TCP 调试；网页不能凭空开启未授权手机的调试功能。容器中的 `127.0.0.1` 指容器自身；Redroid 在其他容器时使用容器网络服务名或宿主机可达地址。Docker Desktop 访问宿主机服务可用 `host.docker.internal`。无线配对建议手动输入地址，桥接网络不保证 mDNS 自动发现。

### 访问与登录

`STUDIO_PASSWORD` 未设置或为空字符串时，直接进入 Web UI，不需要登录，也不会弹出登录框。设置非空密码后启用 HTTP Basic 登录，用户名由 `STUDIO_USER` 指定，默认为 `admin`。例如，在启动命令中添加 `-e STUDIO_PASSWORD=你的密码`。

默认监听所有网络接口，镜像可通过 `https://服务器地址:8787` 打开 Web UI，无需配置域名白名单。网页和 WebSocket 保留同站请求校验，ADB 操作及投屏仍校验会话令牌。

WebCodecs 需要安全上下文。镜像已内置 HTTPS，无需额外服务；本地 Node 运行默认仍使用 HTTP，可通过 `http://localhost:8787` 投屏。

### 自动生成 HTTPS 证书

使用 Compose 时，在 `.env` 中填写实际访问的服务器 IP / 域名，然后启动：

```dotenv
TLS_HOSTS=localhost,127.0.0.1,192.168.1.20,scrcpy.example.com
```

```sh
docker compose up -d --build
docker compose cp studio:/home/node/.tls/ca.crt ./scrcpy-studio-ca.crt
```

使用上面的 `docker run` 启动时，导出命令为：

```sh
docker cp scrcpy-studio:/home/node/.tls/ca.crt ./scrcpy-studio-ca.crt
```

在**打开网页的电脑**上导入这个 CA：Windows 双击证书 → 安装证书 → 当前用户 → 将所有证书放入“受信任的根证书颁发机构”。macOS 导入钥匙串并设置信任；Linux 根据发行版或浏览器的证书管理器导入。重新打开浏览器，访问证书中包含的 IP 或域名。

**必须让浏览器信任证书，并使用 `TLS_HOSTS` 中的地址访问。仅点击忽略证书错误，不保证 WebCodecs 可用。** 证书配置不会绕过浏览器信任机制。只导出 `ca.crt` 公共证书，私钥 `ca.key` / `server.key` 留在证书卷内。

每个部署首次启动会生成独立 CA 和服务器证书。证书卷在更新镜像时保留；修改 `TLS_HOSTS` 后重新创建容器，会用原 CA 签发新证书，无需重新导入 CA。服务器证书有效期一年，启动时如果不足七天会重签；长期连续运行时请在到期前重启容器。CA 有效期十年。删除证书卷会生成新 CA，需要重新导入信任。

### 使用已有证书

将包含完整证书链的 PEM 文件和私钥只读挂载，再指定 `TLS_CERT` 和 `TLS_KEY`。例如在 `compose.yaml` 的 `studio` 服务中加入以下配置（合并到现有 environment / volumes）：

```yaml
environment:
  TLS_CERT: /certs/fullchain.pem
  TLS_KEY: /certs/privkey.pem
volumes:
  - ./certs:/certs:ro
```

证书私钥需允许容器的 `node` 用户（UID 1000）读取。提供这两个变量时直接使用已有证书，不生成本地 CA；证书更新后重启容器生效。若要使用 HTTP，设置 `HTTPS=false` 并取消这两个变量；同一端口只提供一种协议。

| 环境变量 | 默认值 / 用途 |
| --- | --- |
| `HOST` | 服务监听地址，本地运行和镜像默认均为 `0.0.0.0` |
| `PORT` | 容器内服务端口 `8787` |
| `STUDIO_USER` | 登录用户名，默认 `admin`；仅启用密码时使用 |
| `STUDIO_PASSWORD` | 默认空；直接进入 Web UI，非空时才要求登录 |
| `HTTPS` | 镜像默认 `true`；本地 Node 运行需显式设置 `true` 才自动生成证书 |
| `TLS_HOSTS` | 自动证书包含的地址，逗号分隔，无协议和端口；默认 `localhost,127.0.0.1,::1` |
| `TLS_DIR` | 自动证书目录；镜像 `/home/node/.tls`，本地 `.tls` |
| `TLS_CERT` / `TLS_KEY` | 自有 PEM 证书链和私钥路径，必须一起设置；优先于自动证书 |

本地启用自动 HTTPS 需要 PATH 中有 OpenSSL；Docker 镜像已内置。`.env` 供 Compose 读取，本地 `pnpm start` 使用系统环境变量。

### USB

Linux USB 透传需额外映射 USB 设备，并通过宿主机 udev 权限和 Compose `group_add` 让镜像的 `node` 用户（UID 1000）能访问设备；默认配置不自动授予 USB 权限。Docker Desktop 的 USB 透传依赖宿主机配置，因此推荐网络 ADB。不要同时让宿主机和容器 ADB 占用同一 USB 设备。

**验证范围：当前机器没有 Docker，尚未构建或运行镜像。** 已通过 Node 单元测试、HTTP 接口测试及语法检查；首次构建、网络连接、卷权限和真实无线配对请在目标 Docker 环境验证。

## 本地启动

需要 Node.js 20+、pnpm、ADB，以及官方 scrcpy **4.1** 的 `scrcpy-server`。设备需开启 USB 调试并授权电脑。

```powershell
cd D:\project\scrcpy_web\scrcpy-studio
pnpm install --frozen-lockfile
pnpm start
```

在新版 Chrome / Edge 打开 **http://localhost:8787**，选择设备，点击「开始投屏」。

当前电脑自动识别 `D:\tools\scrcpy\scrcpy.exe` 及旁边的 `scrcpy-server`，ADB 使用 PATH 中的版本。其他机器可这样指定：

```powershell
$env:ADB_PATH = 'C:\Android\platform-tools\adb.exe'
$env:SCRCPY_HOME = 'C:\tools\scrcpy-win64-v4.1'
pnpm start
```

也可设置 `SCRCPY_PATH` 为官方可执行文件的绝对路径，或设置 `SCRCPY_SERVER_PATH` 为 **4.1** 的服务端文件。手动指定服务端时由使用者保证版本；手机端版本不匹配会在界面报错。**不能使用旧 ws-scrcpy 的 1.19-ws8 JAR**，也不能把 3.x 的服务端当作 4.1 使用。

`PORT` 可覆盖默认的 8787，`HOST` 可指定监听地址；网页和 WebSocket 校验 Host、Origin 和会话令牌。

若 pnpm 的临时目录在受限的自动化环境中不可写，可以把 `TEMP` / `TMP` 设置为当前项目内一个可写目录；正常用户终端通常不需要。

## 使用

- 设备发现、选择、连接、取消连接、断开和应用设置后重连。
- 流畅 / 均衡 / 清晰预设，原始分辨率，码率和 30 / 60 / 90 / 120 FPS 上限。
- GPU 硬件优先、浏览器自动、软件优先三种解码偏好。
- 鼠标或触屏点击 / 拖动，多指 Pointer Events，滚轮，右键返回。
- 主页、返回、最近应用、音量、电源键、旋转设备。
- 屏幕获得焦点后输入 ASCII、方向键、回车和退格；Ctrl+V 或文字框可粘贴 Unicode 文本。中文输入法组合输入建议使用右侧文字框。
- 原始像素 / 适应窗口、全屏、按视频实际分辨率保存 PNG 截图。
- 实时显示帧率、接收码率、解码队列、丢弃帧数、传输待确认包数与帧率趋势。

设置保存在浏览器的 `scrcpy-studio.v1` localStorage 项中；不继承旧项目的低画质默认值。

## 视频路径与低延迟策略

```text
Android 屏幕 → MediaCodec H.264 编码
  → ADB 转发 → Node TCP 解析（保留官方帧元数据）
  → WebSocket → Worker 内 VideoDecoder → OffscreenCanvas → 页面合成
```

只有手机端编码和浏览器解码各一次。Node 不解码、不重新编码，也不引入 MP4 / MSE 播放缓冲。仅支持现代 WebCodecs 浏览器，没有 MSE 或 WASM 回退。

1. 解析 scrcpy 4.1 的 session metadata、codec config、真实微秒 PTS 和 key-frame 标志，正确生成 `key` / `delta` EncodedVideoChunk。
2. 从 SPS 解析 H.264 profile/level；配置 `optimizeForLatency: true`，通过 `isConfigSupported()` 探测解码偏好，硬件初始化失败时回退到自动选择。
3. 区分未完成解码与未绘制的画面：解码完成时立即移出解码追踪。正常 TCP 突发不会立即重置；最早未解码帧超过 250ms 且积压至少 12 帧，或达到 48 帧硬上限时，才从关键帧恢复。异步初始化期间保留有界的完整帧序列，而不是收到普通帧就丢掉关键帧。
4. 已解码画面只保留最新一张，及时 `VideoFrame.close()` 释放被替换的 GPU/内存资源。RAF 绘制配合 32ms 定时器兜底，防止前后台切换时绘制调度停滞；取消和恢复都会清理旧调度。
5. 后端有 ACK 窗口：64 个待确认包、最旧包 250ms、WebSocket 待发送 2MiB 任一条件触发丢弃过期输入。允许正常的 TCP 批量到达，保留时间与字节上限。恢复时重新发送配置并从 IDR 开始。已进入 TCP 的字节无法撤回，所以仍不保证在严重丢包网络中维持低延迟。
6. 手机端请求一秒关键帧间隔；网络拥堵恢复等待自然 IDR，不反复重启 MediaCodec。静态画面不一定持续编码，恢复速度也取决于后续画面更新与编码器实现。
7. 页面隐藏时停止提交视频解码，回到前台后从关键帧同步；窗口变化只缩放显示，不重新降低手机端分辨率。

## GPU 与指标的含义

「硬件优先（已请求）」表示浏览器接受了 `hardwareAcceleration: 'prefer-hardware'`，**不能证明实际始终使用 GPU**。WebCodecs 没有可移植的实际硬解状态查询接口。可以在 Windows 任务管理器的 GPU → Video Decode 图表，或 Chrome/Edge 的 media-internals 中结合正在播放的视频进一步检查。静态桌面没有持续解码负载，建议在设备上播放持续运动内容再观察。

「接收到绘制」从 Worker 收到视频包计时，到 `drawImage()` 调用完成为止。**不包含**手机采集、编码、ADB / 网络传输，也不代表显示器真正发光的时刻。它不是端到端延迟；端到端对比应在相同设备、连接、编码参数下，使用拍摄两块屏幕的高速相机或时间码方法。

60 FPS 是上限。静止屏幕可以显示 0 FPS，更新频率由 Android 和内容决定；低接收码率也不等于设置失效。

## 验证

```powershell
pnpm check
pnpm test
```

测试覆盖 TCP 分片/粘包、旋转 session 帧、PTS / key / delta、控制协议、畸形输入、传输背压、GPU 帧释放、解码积压后关键帧恢复、后台恢复以及 HTTP / WebSocket 访问限制。

真实设备测试（需先启动服务并断开网页投屏）：

```powershell
pnpm smoke
```

此测试会切换设备「主页 / 最近应用」以产生动态画面，模拟 1.8 秒浏览器不确认视频包，然后验证丢弃积压、重新收到配置和关键帧；结束回到主页。可用 `DEVICE_SERIAL` 指定设备，`STUDIO_URL` 指定本地服务地址。

本机已验证 Redroid 13、网络 ADB、1080×1920 接收与浏览器解码，以及真实 ACK 堵塞后的关键帧恢复。该结果不等同于所有物理手机、驱动及浏览器的性能保证。

## 范围与排错

- 本版本为视频 + 控制，不包含音频、录像、文件上传、远程公开访问或多人共享同一个设备会话。
- 同一设备只允许一个网页会话，避免多个配置互相覆盖。退出后清理本项目创建的 ADB forward、会话进程和设备临时 JAR。
- 不出设备：运行 `adb devices -l`；`unauthorized` 需在设备上授权。无线连接先在终端执行 `adb connect 地址:端口`。
- 黑屏 / 无解码：使用新版 Chrome / Edge 和 localhost 安全上下文；改选浏览器自动解码或减小分辨率。
- 画面停止：先操作设备看是否只是静态画面；点击预览底栏的恢复画面按钮，从下一张关键帧同步。仍未恢复时断开再连接。
- 旋转行为取决于设备、系统旋转锁定及当前应用；Redroid 等虚拟设备可能与物理手机不同。
- 触控失败：部分品牌需额外启用「USB 调试（安全设置）」。
- 手机编码器能力不足时官方 scrcpy 可能自动降分辨率，实际尺寸以预览顶部为准。

官方 scrcpy 由 Genymobile 及贡献者维护，采用 Apache-2.0 许可证。本地运行使用已安装的官方服务端；Docker 镜像包含官方发布包及其许可证，不修改其二进制。
