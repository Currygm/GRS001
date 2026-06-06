let archives = [];
let liveRankings = [];

function show(a) {
  $("archiveDetail").classList.remove("hidden");
  $("archiveDetail").innerHTML = `<span class="eyebrow">${a.raceId} · v${a.version}</span><h2>${escapeHtml(a.title)}</h2><p>${escapeHtml(a.summary)}</p><object class="pdf-view" data="${a.posterUrl}" type="application/pdf"><a class="download-link" href="${a.posterUrl}" target="_blank">打开最终 PDF 海报</a></object><h3>最终排名</h3>${a.results.map(r => `<div class="audit"><span>第 ${r.rank} 名</span><strong>${escapeHtml(r.racerId)}</strong><div>${escapeHtml(String(r.score))} · ${escapeHtml(r.award)} · ${escapeHtml(r.comment)}</div></div>`).join("")}<h3>优秀作品</h3>${a.showcases.length ? a.showcases.map(s => `<div class="panel"><strong>${escapeHtml(s.title)}</strong><p>${escapeHtml(s.summary)}</p>${s.demoUrl ? `<a class="download-link" href="${escapeHtml(s.demoUrl)}" target="_blank">访问公开 Demo</a>` : ""}</div>`).join("") : `<div class="empty">暂无优秀作品摘要</div>`}<p>${formatDateTime(a.startsAt)} 至 ${formatDateTime(a.endsAt)} · 发布于 ${formatDateTime(a.publishedAt)}</p>`;
}

function renderLiveRankings() {
  $("liveRankingList").innerHTML = liveRankings.length ? liveRankings.map(ranking => `<article class="panel race-card"><span class="eyebrow">实时排名 · v${ranking.version}${ranking.stale ? " · 数据可能过期" : ""}</span><h2>${escapeHtml(ranking.title)}</h2><p>更新于 ${formatDateTime(ranking.updatedAt)}</p>${ranking.rows.map(row => `<div class="audit"><span>第 ${row.rank} 名</span><strong>${escapeHtml(row.racerId)}</strong><div>${escapeHtml(String(row.score))} · ${escapeHtml(row.status)}</div></div>`).join("")}</article>`).join("") : `<div class="empty">暂无进行中且已公开的实时排名</div>`;
}

async function refresh() {
  const state = await api("/api/state");
  archives = state.archives;
  liveRankings = state.liveRankings || liveRankings;
  renderLiveRankings();
  $("archiveList").innerHTML = archives.length ? archives.map(a => `<article class="panel race-card"><span class="eyebrow">最新版本 v${a.version}</span><h2>${escapeHtml(a.title)}</h2><p>${escapeHtml(a.summary)}</p><p>${formatDateTime(a.startsAt)} 至 ${formatDateTime(a.endsAt)}</p><button data-race-id="${a.raceId}">查看长期档案</button></article>`).join("") : `<div class="empty">暂无公开归档</div>`;
  if (archives[0]) show(archives[0]);
}

function connectLiveRankings() {
  const events = new EventSource("/api/live-rankings/events");
  events.addEventListener("rankings", event => {
    liveRankings = JSON.parse(event.data);
    renderLiveRankings();
  });
}

$("archiveList").onclick = e => { const b = e.target.closest("[data-race-id]"); if (b) show(archives.find(a => a.raceId === b.dataset.raceId)); };
refresh();
connectLiveRankings();
