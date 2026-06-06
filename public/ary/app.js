let state;
let liveRankings = [];

function rankingRowsHtml(ranking, limit = Infinity) {
  const rows = ranking?.rows?.slice(0, limit) || [];
  if (!rows.length) return `<div class="empty compact">暂无有效分数行</div>`;
  return rows.map(row => `<div class="rank-row"><span>第 ${row.rank} 名</span><strong>${escapeHtml(row.racerId)}</strong><b>${escapeHtml(String(row.score))}</b></div>`).join("");
}

function rankingHtml(ranking) {
  return `<article class="panel race-card ops-card">
    <div class="ops-top">
      <span class="eyebrow">${escapeHtml(ranking.raceId)} · v${ranking.version}${ranking.stale ? " · 同步异常" : ""}${ranking.frozen ? " · 已冻结" : ""}</span>
    </div>
    <h2>${escapeHtml(ranking.title)}</h2>
    <p>更新时间：${formatDateTime(ranking.updatedAt)} · SHA256 ${escapeHtml(ranking.sha256)}</p>
    <div class="ranking-mini">${rankingRowsHtml(ranking)}</div>
  </article>`;
}

function projectionBlock(r, ranking) {
  const meta = state.liveRankingMeta?.[r.raceId];
  if (ranking) {
    return `<div class="ops-ranking">
      <div class="ops-block-title"><span>投影排名</span><strong>v${ranking.version}${ranking.frozen ? " · 已冻结" : ""}</strong></div>
      ${rankingRowsHtml(ranking, 5)}
    </div>`;
  }
  if (meta?.error) {
    return `<div class="ops-ranking warning">
      <div class="ops-block-title"><span>投影同步失败</span><strong>${escapeHtml(meta.error)}</strong></div>
      <p>最近同步：${formatDateTime(meta.syncedAt)}</p>
      <p>文件：organizer-storage/races/${escapeHtml(r.raceId)}/live-ranking.json</p>
    </div>`;
  }
  return `<div class="ops-ranking"><div class="empty compact">暂无投影排名</div></div>`;
}

function raceCardHtml(r) {
  const versions = r.archive?.versions || [];
  const current = versions.find(v => v.version === r.archive?.currentVersion);
  const challenge = r.challenge;
  const ranking = r.liveRanking;
  const canForceFinish = r.status === "open";
  return `<article class="panel race-card ops-card">
    <div class="ops-top">
      <span class="status-pill ${r.status}">${statusLabel(r.status)}</span>
      <code>${escapeHtml(r.raceId)}</code>
    </div>
    <h2>${escapeHtml(r.manifest.disclosure.title)}</h2>
    <p class="ops-time">${formatDateTime(r.startsAt)} 至 ${formatDateTime(r.endsAt)} · ${remainingText(r)}</p>
    <div class="ops-metrics">
      <div><span>参加</span><strong>${r.participantCount}</strong></div>
      <div><span>提交</span><strong>${r.submissionCount || 0}</strong></div>
      <div><span>证书</span><strong>${r.certificateCount}</strong></div>
      <div><span>归档</span><strong>${current ? `v${current.version}` : "未发布"}</strong></div>
    </div>
    <div class="ops-gridline">
      <div class="ops-info">
        <div class="ops-block-title"><span>结构化赛题</span><strong>${challenge ? `v${challenge.version}` : "待配置"}</strong></div>
        ${challenge ? `<p>${escapeHtml(challenge.title)} · ${escapeHtml(challenge.description)}</p>` : `<p>Organizer 尚未配置赛题。</p>`}
        <div class="ops-block-title"><span>披露</span><strong>${r.manifest.disclosure.liveRankingVisible ? "排名公开" : "排名关闭"}</strong></div>
        <p>长期归档历史：${versions.length} · 私人证书：${r.certificateCount}</p>
      </div>
      ${projectionBlock(r, ranking)}
    </div>
    ${versions.length ? `<div class="ops-history">${versions.slice(0, 3).map(v => `<span>归档 v${v.version} · ${formatDateTime(v.publishedAt)}</span>`).join("")}</div>` : ""}
    <div class="admin-actions">
      <button class="danger" data-force-finish="${r.raceId}" ${canForceFinish ? "" : "disabled"}>强制结束比赛</button>
    </div>
  </article>`;
}

function render() {
  $("liveRankingList").innerHTML = liveRankings.length ? liveRankings.map(rankingHtml).join("") : `<div class="empty">暂无进行中且已公开的实时排名</div>`;
  $("raceList").innerHTML = state.races.length ? state.races.map(raceCardHtml).join("") : `<div class="empty">暂无赛事</div>`;
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
$("raceList").onclick = async event => {
  const button = event.target.closest("[data-force-finish]");
  if (!button || button.disabled) return;
  const raceId = button.dataset.forceFinish;
  const race = state.races.find(item => item.raceId === raceId);
  if (!confirm(`确认强制结束赛事「${race?.manifest?.disclosure?.title || raceId}」？`)) return;
  button.disabled = true;
  const result = await api(`/api/ary/races/${raceId}/force-finish`, { method: "POST", headers: { "X-Operator": "Admin" }, body: "{}" });
  liveRankings = result.liveRankings || [];
  toast("比赛已强制结束，投影已停止");
  await refresh();
};
refresh();
connectLiveRankings();
setInterval(refresh, 5000);
