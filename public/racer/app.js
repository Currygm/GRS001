let state, selectedRaceId;

const DEFAULT_RACER_ID = "racer-001";
const RACER_STORAGE_KEY = "ary.demo.racerId";

function normalizeRacerId(value) {
  const racerId = String(value || DEFAULT_RACER_ID).trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(racerId)) throw new Error("Racer ID 只能包含字母、数字、下划线和短横线");
  return racerId;
}

function initialRacerId() {
  const params = new URLSearchParams(location.search);
  return normalizeRacerId(params.get("racer") || params.get("racerId") || localStorage.getItem(RACER_STORAGE_KEY) || DEFAULT_RACER_ID);
}

let racerId = initialRacerId();
const selected = () => state.races.find(r => r.raceId === selectedRaceId);

function persistRacerId(nextRacerId) {
  racerId = normalizeRacerId(nextRacerId);
  localStorage.setItem(RACER_STORAGE_KEY, racerId);
  const url = new URL(location.href);
  url.searchParams.set("racer", racerId);
  history.replaceState(null, "", url);
  $("racerIdInput").value = racerId;
  $("racerBadge").innerHTML = `<i></i> ${escapeHtml(racerId)}`;
}

async function apiAsRacer(url, options = {}) {
  return api(url, {
    ...options,
    headers: { "X-Racer-Id": racerId, ...(options.headers || {}) }
  });
}

function challengeHtml(challenge) {
  if (!challenge) return `<div class="empty">Organizer 尚未配置赛题，你仍可以提交比赛结果。</div>`;
  return `<span class="eyebrow">VERSION ${challenge.version}</span><h3>${escapeHtml(challenge.title)}</h3><p>${escapeHtml(challenge.description)}</p><h3>提交要求</h3><p>${escapeHtml(challenge.submissionRequirements || "无补充要求")}</p><h3>评审标准</h3><p>${escapeHtml(challenge.evaluationCriteria || "未说明")}</p><h3>补充说明</h3><p>${escapeHtml(challenge.notes || "无")}</p>`;
}

function rankingRowsHtml(ranking, myRanking) {
  if (!ranking?.rows?.length) return `<div class="empty compact">暂无公开排名</div>`;
  return ranking.rows.map(row => `<div class="rank-row ${myRanking?.racerId === row.racerId ? "mine" : ""}"><span>第 ${row.rank} 名</span><strong>${escapeHtml(row.racerId)}</strong><b>${escapeHtml(String(row.score))}</b></div>`).join("");
}

function rankingTeaser(r) {
  if (!r.liveRanking?.rows?.length) return "";
  return r.myRanking
    ? `<p>我的排名：第 ${r.myRanking.rank} 名 · ${escapeHtml(String(r.myRanking.score))}</p>`
    : `<p>公开排名已发布 · 你尚未进入投影榜单</p>`;
}

function render() {
  $("racerIdInput").value = racerId;
  $("racerBadge").innerHTML = `<i></i> ${escapeHtml(state.racerId || racerId)}`;
  $("raceList").innerHTML = state.races.length ? state.races.map(r => `<article class="panel race-card"><span class="eyebrow">${statusLabel(r.status)} · ${r.joined ? "已参加" : "未参加"}</span><h2>${escapeHtml(r.manifest.disclosure.title)}</h2><p>${escapeHtml(r.manifest.disclosure.summary)}</p><p>${formatDateTime(r.startsAt)} 至 ${formatDateTime(r.endsAt)}</p><p>${remainingText(r)} · ${r.challengeConfigured ? "赛题已配置" : "赛题待配置"}</p>${rankingTeaser(r)}${r.joined ? `<button data-open="${r.raceId}">查看赛事</button>` : `<button data-join="${r.raceId}" ${r.status !== "open" ? "disabled" : ""}>${r.status === "scheduled" ? "尚未开始" : r.status === "ended" ? "赛事已终止" : "参加赛事"}</button>`}</article>`).join("") : `<div class="empty">暂无开放赛事</div>`;
  $("certificateList").innerHTML = state.certificates.length ? state.certificates.map(c => `<article class="panel race-card"><span class="eyebrow">${escapeHtml(c.raceId)} · v${c.version}</span><h2>私人比赛证书</h2><p>签发时间：${formatDateTime(c.uploadedAt)}</p><p>SHA256：<code>${escapeHtml(c.sha256)}</code></p><a class="download-link" href="${escapeHtml(c.downloadUrl)}" download>下载证书 PDF</a></article>`).join("") : `<div class="empty">暂无长期证书</div>`;
  const r = selected();
  $("workspace").classList.toggle("hidden", !r || !r.joined);
  if (!r || !r.joined) return;
  $("raceTitle").textContent = r.manifest.disclosure.title;
  $("raceInfo").innerHTML = `<p>${escapeHtml(r.manifest.disclosure.summary)}</p><p>Racer：<strong>${escapeHtml(racerId)}</strong></p><p>状态：<strong>${statusLabel(r.status)}</strong> · ${remainingText(r)}</p><p>${formatDateTime(r.startsAt)} 至 ${formatDateTime(r.endsAt)}</p><p>提交状态：<strong>${r.metadata.submissionStatus}</strong></p>`;
  $("racerRanking").classList.toggle("hidden", !r.liveRanking);
  $("racerRanking").innerHTML = r.liveRanking ? `<span class="eyebrow">PUBLIC PROJECTION</span><h2>公开投影排名</h2>${r.myRanking ? `<p>我的排名：<strong>第 ${r.myRanking.rank} 名</strong> · 分数 ${escapeHtml(String(r.myRanking.score))}</p>` : `<p>当前 Racer 尚未进入投影榜单。</p>`}<div class="ranking-mini">${rankingRowsHtml(r.liveRanking, r.myRanking)}</div>` : "";
  $("challengeDetail").innerHTML = challengeHtml(r.challenge);
  $("uploadSubmission").disabled = r.status !== "open";
}

async function refresh(id = selectedRaceId) {
  state = await apiAsRacer("/api/state");
  selectedRaceId = state.races.some(r => r.raceId === id) ? id : null;
  render();
}

$("raceList").onclick = async e => {
  const joinButton = e.target.closest("[data-join]");
  const openButton = e.target.closest("[data-open]");
  if (joinButton && !joinButton.disabled) {
    await apiAsRacer(`/api/racer/races/${joinButton.dataset.join}/join`, { method: "POST" });
    toast(`${racerId} 已参加赛事`);
    await refresh(joinButton.dataset.join);
  } else if (openButton) {
    selectedRaceId = openButton.dataset.open;
    render();
  }
};

$("uploadSubmission").onclick = async () => {
  const file = $("submissionFile").files[0];
  if (!file) throw new Error("请选择 PDF");
  const response = await fetch(`/api/racer/races/${selectedRaceId}/submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "X-Racer-Id": racerId, "X-File-Name": encodeURIComponent(file.name), "X-File-Size": String(file.size) },
    body: file
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  $("uploadResult").textContent = `Racer：${result.racerId}\nOwner：${result.owner}\nARY 持久化：${result.aryPersistedBytes} B\nReceipt：${result.receiptId}\nSHA256：${result.sha256}`;
  toast("提交成功");
  await refresh();
};

$("saveRacerId").onclick = async () => {
  persistRacerId($("racerIdInput").value);
  selectedRaceId = null;
  toast(`已切换至 ${racerId}`);
  await refresh();
};

document.querySelectorAll("[data-racer-preset]").forEach(button => {
  button.onclick = async () => {
    persistRacerId(button.dataset.racerPreset);
    selectedRaceId = null;
    toast(`已切换至 ${racerId}`);
    await refresh();
  };
});

persistRacerId(racerId);
refresh();
setInterval(() => { if (!["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) refresh(); }, 5000);
