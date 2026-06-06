let state;
let liveRankings = [];

function rankingHtml(ranking) {
  return `<article class="panel race-card">
    <span class="eyebrow">${escapeHtml(ranking.raceId)} · 本地文件 v${ranking.version}${ranking.stale ? " · 同步异常" : ""}</span>
    <h2>${escapeHtml(ranking.title)}</h2>
    <p>更新时间：${formatDateTime(ranking.updatedAt)} · SHA256 ${escapeHtml(ranking.sha256)}</p>
    ${ranking.rows.map(row => `<div class="audit"><span>第 ${row.rank} 名</span><strong>${escapeHtml(row.racerId)}</strong><div>${escapeHtml(String(row.score))}</div></div>`).join("")}
  </article>`;
}

function render() {
  $("liveRankingList").innerHTML = liveRankings.length ? liveRankings.map(rankingHtml).join("") : `<div class="empty">暂无进行中且已公开的实时排名</div>`;
  $("raceList").innerHTML = state.races.length ? state.races.map(r => {
    const versions = r.archive?.versions || [];
    const current = versions.find(v => v.version === r.archive?.currentVersion);
    const challenge = r.challenge;
    const ranking = r.liveRanking;
    return `<article class="panel race-card">
      <span class="eyebrow">${statusLabel(r.status)} · ${r.raceId}</span>
      <h2>${escapeHtml(r.manifest.disclosure.title)}</h2>
      <p>${formatDateTime(r.startsAt)} 至 ${formatDateTime(r.endsAt)} · ${remainingText(r)}</p>
      <p>结构化赛题：${challenge ? `v${challenge.version} · ${escapeHtml(challenge.title)}` : "待配置"} · 参加：${r.participantCount} · 提交：${r.metadata.submissionStatus}</p>
      <p>实时排名：${ranking ? `分数文件 v${ranking.version}${ranking.stale ? " · 同步异常" : ""}` : "未配置"} · 披露：${r.manifest.disclosure.liveRankingVisible ? "开启" : "关闭"}</p>
      ${challenge ? `<div class="audit"><span>任务描述</span><strong>${escapeHtml(challenge.description)}</strong><div>提交要求：${escapeHtml(challenge.submissionRequirements || "无")} · 评审标准：${escapeHtml(challenge.evaluationCriteria || "未说明")} · 补充说明：${escapeHtml(challenge.notes || "无")}</div></div>` : ""}
      <p>当前长期归档：${current ? `v${current.version}` : "未发布"} · 历史版本：${versions.length} · 私人证书：${r.certificateCount}</p>
      ${versions.map(v => `<div class="audit"><span>v${v.version}</span><strong>${formatDateTime(v.publishedAt)}</strong><div>海报 SHA256 ${v.posterSha256}</div></div>`).join("")}
    </article>`;
  }).join("") : `<div class="empty">暂无赛事</div>`;
  $("proofClaims").innerHTML = state.proof.claims.map(i => `<div class="claim ${i.passed ? "pass" : "fail"}"><strong>${i.passed ? "PASS" : "FAIL"} · ${escapeHtml(i.name)}</strong><p>${escapeHtml(i.evidence)}</p></div>`).join("");
  $("organizerFiles").innerHTML = filesHtml(state.proof.organizerFiles);
  $("aryFiles").innerHTML = filesHtml(state.proof.aryFiles);
  $("auditLog").innerHTML = state.audits.length ? state.audits.map(l => `<div class="audit"><span>${new Date(l.at).toLocaleTimeString()}</span><strong>${escapeHtml(l.actor)}</strong><div>${escapeHtml(l.action)} · ${escapeHtml(l.target)}</div></div>`).join("") : `<div class="empty">暂无审计</div>`;
}

async function refresh() {
  state = await api("/api/state");
  if (!liveRankings.length) liveRankings = state.liveRankings || [];
  render();
}

function connectLiveRankings() {
  const events = new EventSource("/api/live-rankings/events");
  events.onopen = () => { $("liveConnection").textContent = "实时连接正常"; };
  events.onerror = () => { $("liveConnection").textContent = "正在重新连接"; };
  events.addEventListener("rankings", event => {
    liveRankings = JSON.parse(event.data);
    if (state) render();
  });
}

$("runProof").onclick = async () => { await api("/api/proof/run", { method: "POST" }); toast("扫描完成"); await refresh(); };
$("reset").onclick = async () => { await api("/api/demo/reset", { method: "POST" }); toast("Demo 已清空"); liveRankings = []; await refresh(); };
refresh();
connectLiveRankings();
setInterval(refresh, 5000);
