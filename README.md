# ARY 数据安全 Demo

该 Demo 根据 `ARY_POC_TECH_DESIGN.md` 和 `ARY_DATA_SECURITY_BUSINESS_FLOW.md` 实现以下完整流程：

1. Organizer 创建并管理多场赛事，为每场赛事填写结构化赛题和控制披露。
2. Racer 查看开放赛事并参加多个赛事；参加后才能查看完整赛题和提交结果。
3. 结构化赛题直接保存于 ARY，不提供文件下载。
4. Racer 结果经 ARY 流式转发至 Organizer；重提覆盖当前结果，ARY 不落盘。
5. Organizer 按赛事评审并发布公开回顾，Visitor 浏览全部已发布归档。
6. Organizer 可将本地实时排名公开给 ARY 与 Visitor，ARY 不持久化排名正文。
7. 安全证明中心扫描全部赛事，证明 ARY 未保存实时排名正文和提交结果。

赛事使用结构化开始和结束时间。创建赛事时开始时间必须位于服务器当天且不得早于当前时刻，结束时间必须晚于开始时间。服务端按当前时间实时派生状态：

- `scheduled`：未开始，可查看赛事摘要但不能参加或提交。
- `open`：进行中，可正常参加、查看结构化赛题和提交。
- `ended`：已终止，可查看已参加赛事及赛题，但不能参加或提交；Organizer 仍可评审、归档或延长结束时间。

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
    submissions/<racerId>.pdf    # Racer 当前提交，仅 Organizer 保存
    manifest.json                # 按赛事披露控制
    live-ranking.json            # Organizer 本地实时排名正文

ary-storage/
  races.json          # 赛事索引
  challenges.json     # 按赛事保存当前结构化赛题
  participations.json # Racer 参加关系
  metadata.json       # 按赛事与 Racer 保存最小流程元数据
  audit.json          # 全局审计日志
  archives.json       # 全部公开赛事回顾
  live-ranking-meta.json # 实时排名版本、哈希和同步状态，不含排名正文
  public-archive/     # 按赛事保存公开归档资产
```

## 演示顺序

1. 在 `4312` Organizer 控制台创建两场赛事，并为其中一场填写结构化赛题。
2. 在 `4313` Racer 工作台查看赛事列表并分别参加；操作组件仅在参加后出现。
3. 验证未配置赛题时仍可提交；参加赛事后可查看 ARY 保存的结构化赛题。
4. 在 Racer 工作台提交并重提 PDF，观察当前结果被覆盖且 ARY 持久化始终为 `0 B`。
5. 在 Organizer 控制台按赛事评审并发布回顾，在 `4314` 查看归档列表。
6. 在 `4311` ARY 管理端查看赛事总览并执行全部赛事存储扫描。
7. 在 Organizer 编辑并公开实时排名，观察 `4311` 与 `4314` 无需刷新自动更新。

赛事到达结束时间后无需重启或后台定时任务，下一次页面刷新或 API 请求会立即按 `ended` 状态处理。已结束赛事延长结束时间后可以恢复为 `open`。

## 角色端口权限

| 端口 | 角色 | 允许的主要能力 |
| --- | --- | --- |
| `4311` | ARY | 查看全部赛事、审计和安全证明，清空 Demo |
| `4312` | Organizer | 创建赛事，编辑结构化赛题，管理披露、评审与归档 |
| `4313` | Racer | 查看并参加多个赛事，参加后查看赛题并提交 |
| `4314` | Visitor | 查看全部公开赛事归档 |

## 实时排名披露

- 创建赛事或后续编辑披露时，可开启或撤回实时排名公开。
- Organizer 使用 `PUT /api/organizer/races/:raceId/live-ranking` 原子更新本地 `live-ranking.json`；外部程序也可以按相同结构通过临时文件和原子重命名替换该文件。
- 排名行字段固定为 `rank`、`racerId`、`score`、`status`，文件还包含 `raceId`、递增 `version` 和 `updatedAt`。
- ARY 监听 Organizer 文件变化，校验后仅在内存中缓存正文，通过 SSE `/api/live-rankings/events` 推送至 ARY 与 Visitor。
- 只有状态为 `open` 且披露开关开启的赛事会公开实时排名；赛事结束或撤回披露后自动停止展示。
- 文件无效时继续展示上一有效内存版本并标记为过期；较低版本会被忽略。ARY 仅持久化同步元数据、哈希和审计记录。

## PDF 验证规则

- 上传前必须声明 `.pdf` 文件名和 `application/pdf` 类型。
- Organizer 接收上传时会校验文件头是否以 `%PDF-` 开始。
- 非 PDF 文件或伪装成 PDF 的文本内容会被拒绝。
- 提交使用 `POST /api/racer/races/:raceId/submissions`，要求 Racer 已参加对应赛事。
- ARY 使用流式管道转发，Organizer 先写入 `.part`，校验成功后原子重命名；失败时立即清理。
- 安全证明中心会验证 Organizer 不存在赛题文件、下载策略或票据，并验证 ARY 只保存结构化赛题字段及授权长期 PDF。

## 结构化赛题

- Organizer 使用 `PUT /api/organizer/races/:raceId/challenge` 创建或更新赛题。
- 固定字段为标题、任务描述、提交要求、评审标准和补充说明；标题与任务描述必填。
- ARY 保存当前版本、更新时间和更新者，并记录更新审计。
- Racer 未参加时只能看到赛题是否已配置；参加后可查看完整赛题，结束后仍可回看。
# ARY 长期赛事档案、结果与私人证书

赛事结束后，Organizer 可以上传最终 PDF 海报、结构化排名和优秀作品摘要，并发布到 ARY 长期存储。每次发布产生独立版本，Visitor 只看到最新版本，ARY 管理端保留全部历史版本、授权哈希和审计记录。

Organizer 还可以为已参加赛事的 Racer 上传私人证书 PDF。证书由 ARY 私有保存，仅对应 Racer 端口可列出和下载，Visitor、ARY 公共资产路径及其他角色均不能访问证书下载接口。

```text
ary-storage/
  archives.json
  certificates.json
  public-archive/<raceId>/v<version>/poster.pdf
  certificates/<raceId>/<racerId>/v<version>.pdf

organizer-storage/races/<raceId>/
  archive/poster.pdf
```

主要接口：

- `POST /api/organizer/races/:raceId/archive-poster`
- `POST /api/organizer/races/:raceId/archive`
- `POST /api/organizer/races/:raceId/certificates/:racerId`
- `GET /racer-certificates/:certificateId/download`

归档和证书操作只允许在赛事结束后执行。安全证明允许并验证上述两类授权 PDF，同时继续拒绝 ARY Storage 中出现赛题、提交、临时分块或其他未授权 PDF。
