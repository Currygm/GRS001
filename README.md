# ARY 数据安全 Demo

该 Demo 根据 `ARY_POC_TECH_DESIGN.md` 和 `ARY_DATA_SECURITY_BUSINESS_FLOW.md` 实现以下完整流程：

1. Organizer 创建并管理多场赛事，为每场赛事单独上传赛题和控制披露。
2. Racer 查看开放赛事并参加多个赛事；参加后才能下载赛题和提交结果。
3. Racer 通过 ARY 获取短期链接，从 Organizer 下载赛事专属 PDF。
4. Racer 结果经 ARY 流式转发至 Organizer；重提覆盖当前结果，ARY 不落盘。
5. Organizer 按赛事评审并发布公开回顾，Visitor 浏览全部已发布归档。
6. 安全证明中心扫描全部赛事，证明 ARY 未保存赛题和提交结果。

赛事使用结构化开始和结束时间。创建赛事时开始时间必须位于服务器当天且不得早于当前时刻，结束时间必须晚于开始时间。服务端按当前时间实时派生状态：

- `scheduled`：未开始，可查看但不能参加、下载或提交。
- `open`：进行中，可正常参加、下载和提交。
- `ended`：已终止，可查看，但不能参加、下载或提交；Organizer 仍可评审、归档或延长结束时间。

## 启动

```powershell
.\start-demo.ps1
```

默认角色地址：

```text
ARY 管理端：       http://127.0.0.1:4311
Organizer 控制台： http://127.0.0.1:4312
Racer 工作台：     http://127.0.0.1:4313
Visitor 公开归档： http://127.0.0.1:4314
```

一个 Node 进程同时监听四个端口并共享业务状态。端口用于隔离角色 UI 和允许访问的接口；跨角色 API 请求返回 `403 role_forbidden`。

可通过 `HOST`、`ARY_PORT`、`ORGANIZER_PORT`、`RACER_PORT`、`VISITOR_PORT` 环境变量覆盖默认配置。

## 存储边界

```text
organizer-storage/
  races/<raceId>/
    datasets/challenge.pdf       # 赛事专属赛题，仅 Organizer 保存
    submissions/<racerId>.pdf    # Racer 当前提交，仅 Organizer 保存
    manifest.json                # 按赛事披露控制
    download-policy.json         # 按赛事下载权限
    download-tickets.json        # 按赛事单次下载票据

ary-storage/
  races.json          # 赛事索引
  participations.json # Racer 参加关系
  metadata.json       # 按赛事与 Racer 保存最小流程元数据
  audit.json          # 全局审计日志
  archives.json       # 全部公开赛事回顾
  public-archive/     # 按赛事保存公开归档资产
```

## 演示顺序

1. 在 `4312` Organizer 控制台创建两场赛事，并为其中一场上传专属 PDF。
2. 在 `4313` Racer 工作台查看赛事列表并分别参加；操作组件仅在参加后出现。
3. 验证未上传赛题的赛事不能下载但仍可提交；已上传赛题的赛事从 `4312` 下载真实 PDF。
4. 在 Racer 工作台提交并重提 PDF，观察当前结果被覆盖且 ARY 持久化始终为 `0 B`。
5. 在 Organizer 控制台按赛事评审并发布回顾，在 `4314` 查看归档列表。
6. 在 `4311` ARY 管理端查看赛事总览并执行全部赛事存储扫描。

赛事到达结束时间后无需重启或后台定时任务，下一次页面刷新或 API 请求会立即按 `ended` 状态处理。已结束赛事延长结束时间后可以恢复为 `open`，但结束前签发的旧下载票据不会恢复使用。

## 角色端口权限

| 端口 | 角色 | 允许的主要能力 |
| --- | --- | --- |
| `4311` | ARY | 查看全部赛事、审计和安全证明，清空 Demo |
| `4312` | Organizer | 创建赛事，上传赛题，管理披露、权限、评审与归档 |
| `4313` | Racer | 查看并参加多个赛事，按赛事下载与提交 |
| `4314` | Visitor | 查看全部公开赛事归档 |

## PDF 验证规则

- 下载接口返回真实 `application/pdf` 二进制文件。
- 上传前必须声明 `.pdf` 文件名和 `application/pdf` 类型。
- Organizer 接收上传时会校验文件头是否以 `%PDF-` 开始。
- 非 PDF 文件或伪装成 PDF 的文本内容会被拒绝。
- 提交使用 `POST /api/racer/races/:raceId/submissions`，要求 Racer 已参加对应赛事。
- ARY 使用流式管道转发，Organizer 先写入 `.part`，校验成功后原子重命名；失败时立即清理。
- 安全证明中心会列出两侧存储文件和 SHA-256 摘要，证明 PDF 只存在于 Organizer Storage。

## 下载票据限制

- 下载票据仅可使用一次，成功下载后立即标记为 `used`。
- 票据有效期为 90 秒。
- Organizer 可以随时关闭下载权限，并立即撤销所有未使用票据。
- Organizer Storage 保存票据状态；ARY 审计日志记录申请者、下载者、IP、申请时间、下载时间和结果。
