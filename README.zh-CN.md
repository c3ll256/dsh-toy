# dsh-toy

[![CI](https://github.com/c3ll256/dsh-toy/actions/workflows/ci.yml/badge.svg)](https://github.com/c3ll256/dsh-toy/actions/workflows/ci.yml)

[English](README.md) | 简体中文

`dsh-toy` 是一个 DeepSeek Harness 插件，用于将小玩具接入 DSH。

连接时，agent 会先询问玩具的品牌和准确型号，再自动选择连接方式：

- 普通蓝牙、串口或 USB 型号通过 **Buttplug / Intiface** 连接；插件会在需要时自动启动本机 Intiface Engine。
- 安可尼、谜姬、醉清风等已知分享链接型号通过 **MonsterParty** 连接；已知双通道设备会分别暴露各个输出通道。

用户不需要理解或选择底层连接方式，也不需要手动启动 Intiface。

本实现参考了 [Chemtrails](https://github.com/Kristenkristen/Chemtrails) 发布的协议记录，以及 [Buttplug](https://github.com/buttplugio/buttplug) 和 [Buttplug Protocol Specification](https://buttplug.io/docs/spec/) 的设备抽象与消息格式。仓库中的 TypeScript 代码为独立实现，归属说明见 [NOTICE](NOTICE)。

## 安全限制

- 分享 token 只保存在插件配置中，不会出现在模型可见的工具参数或结果里。
- 默认在 30 秒后自动停止输出。
- 默认禁止零时长保持；只有显式配置 `allowHold: true` 才会启用。
- 连接后端收到命令前会执行 `maxIntensityPercent` 和 `maxDurationSeconds` 限制。
- 同一设备的新命令会替换旧的自动停止计时器。
- `toy_stop` 省略设备 id 时停止全部设备。
- 插件卸载、HMR 或 `toy_disconnect` 会停止输出并等待 WebSocket 关闭。

只控制你本人拥有或已获得明确授权的设备。分享 token 属于临时控制凭据，不要提交到 Git，也不要暴露在日志或对话中。

## 安装

运行要求：Node.js 22.19 或更高版本，并确保 `pnpm` 在 `PATH` 中。如尚未安装 pnpm，先运行一次 `npm install --global pnpm@10`，然后直接从 GitHub 安装插件：

```sh
npx -y @deepseek-ai/dsh plugin --profile web add github:c3ll256/dsh-toy
```

使用同一个 profile 启动 DSH：

```sh
npx -y @deepseek-ai/dsh web
```

第一条命令会把 bundle 持久安装并启用到 `web` profile，之后启动 DSH 时无需重复安装。查看组合配置或移除 bundle：

```sh
npx -y @deepseek-ai/dsh --profile web --dump-config
npx -y @deepseek-ai/dsh plugin --profile web remove dsh-toy
```

需要其他 profile 时，将 `web` 替换为对应名称。

## 自动识别与连接

调用 `toy_connect` 前，agent 必须先询问用户的准确型号，并把型号（以及已知时的品牌）传给工具。工具不会让用户选择底层协议。

对于本地蓝牙、串口或 USB 设备，系统先尝试连接已有 Intiface 服务；如果 `127.0.0.1:12345` 拒绝连接，插件会自行运行：

```sh
intiface-engine --websocket-port 12345 --use-bluetooth-le --use-serial --use-hid
```

因此 Intiface Engine 需要已经安装，并且 `intiface-engine` 位于 `PATH`。若可执行文件位于其他位置，可设置 `intifaceExecutable`。插件只会在断开或卸载时终止由自己启动的进程，不会关闭用户原本已运行的 Intiface。

bundle 默认配置为：

```yaml
- id: dsh-toy
  config:
    buttplugProtocolVersion: 4
    intifaceExecutable: intiface-engine
    defaultDurationSeconds: 30
    maxDurationSeconds: 300
    maxIntensityPercent: 100
    allowHold: false
```

旧版 Intiface server 可设置 `buttplugProtocolVersion: 3`。系统会暴露连接设备声明的、可映射为百分比的标量 feature。

## MonsterParty

把受支持分享链接中的 token 保存到环境变量：

```dotenv
MONSTERPARTY_TOKEN=<TOKEN>
```

然后在 profile 的 `cordis.patch.yml` 中覆盖插件配置：

```yaml
- id: dsh-toy
  config:
    monsterPartySessionToken: !!js process.env.MONSTERPARTY_TOKEN
    defaultDurationSeconds: 30
    maxDurationSeconds: 300
    maxIntensityPercent: 100
    allowHold: false
```

分享 token 通常只能使用一次，并在断开后失效。重新连接前应生成新链接。

## 模型工具

| 工具 | 作用 |
|---|---|
| `toy_connect` | 根据用户提供的品牌和型号自动选择连接方式并连接 |
| `toy_scan` | 发现可用设备 |
| `toy_list` | 列出设备 id 和可控 feature |
| `toy_control` | 发送有界标量命令 |
| `toy_stop` | 停止一个或全部设备 |
| `toy_disconnect` | 停止输出并关闭连接 |

典型顺序：`toy_connect` → `toy_scan` → `toy_list` → `toy_control` → `toy_stop` → `toy_disconnect`。

## 已知限制

- MonsterParty 连接只实现 Chemtrails 记录的 relay 行为和 `AKN_DS_SUCKEGG` 映射；厂商协议变化可能需要更新实现。
- Buttplug 连接当前只暴露标量 feature；位置、方向、传感器、原始访问和订阅不在当前范围内。
- 测试使用本地协议 fixture，不连接物理硬件。
- 设备重连后应重新调用 `toy_list` 刷新设备 id。

## 开发

```sh
pnpm install
pnpm run check
```

## 许可证

BSD-3-Clause。详见 [LICENSE](LICENSE)。
