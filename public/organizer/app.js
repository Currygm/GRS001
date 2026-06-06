let state, selectedRaceId;
const selected = () => state.races.find(r => r.raceId === selectedRaceId);

async function uploadPdf(url, inputId) {
  const f = $(inputId).files[0];
  if (!f) throw new Error("请选择 PDF");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(f.name), "X-File-Size": String(f.size) },
    body: f
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
async function uploadZip(url, inputId) {
  const f = $(inputId).files[0];
  if (!f) throw new Error("请选择 ZIP");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/zip", "X-File-Name": encodeURIComponent(f.name), "X-File-Size": String(f.size) },
    body: f
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function rankingRowsHtml(ranking) {
  if (!ranking?.rows?.length) return `<div class="empty">暂无有效分数投影</div>`;
  return ranking.rows.map(row => `<div class="audit"><span>第 ${row.rank} 名</span><strong>${escapeHtml(row.racerId)}</strong><div>${escapeHtml(String(row.score))}</div></div>`).join("");
}

function collectArchiveResults() {
  const results = [];
  for (let rank = 1; rank <= 10; rank++) {
    const racerId = $(`archiveRacer${rank}`).value.trim();
    const scoreText = $(`archiveScore${rank}`).value.trim();
    if (!racerId && !scoreText) continue;
    if (!racerId || !scoreText) throw new Error(`请补全第 ${rank} 名的 Racer ID 和分数`);
    results.push({ rank, racerId, score: Number(scoreText) });
  }
  if (!results.length) throw new Error("请至少填写一条最终排名");
  return results;
}

function updateShowcaseFields(results = collectArchiveResultsSafe()) {
  for (let index = 1; index <= 3; index++) {
    const row = results[index - 1];
    const label = $(`showcaseRacer${index}`);
    if (label) label.textContent = row ? `第 ${row.rank} 名 · ${row.racerId} · ${row.score}` : `第 ${index} 名 · 请先填写最终排名`;
  }
}

function collectArchiveResultsSafe() {
  try { return collectArchiveResults(); } catch { return []; }
}

function collectTopShowcases(results) {
  return results.slice(0, 3).map((row, index) => {
    const n = index + 1;
    return {
      rank: row.rank,
      racerId: row.racerId,
      title: $(`showcaseTitle${n}`).value,
      summary: $(`showcaseSummary${n}`).value,
      demoUrl: $(`showcaseUrl${n}`).value
    };
  });
}

function render() {
  $("raceList").innerHTML = state.races.length
    ? state.races.map(r => `<button class="race-select ${r.raceId === selectedRaceId ? "secondary" : ""}" data-race-id="${r.raceId}">${escapeHtml(r.manifest.disclosure.title)} · ${statusLabel(r.status)} · ${r.challengeConfigured ? `赛题 v${r.challenge.version}` : "待配置赛题"}</button>`).join("")
    : `<div class="empty">尚未创建赛事</div>`;
  const r = selected();
  $("detail").classList.toggle("hidden", !r);
  if (!r) return;
  const m = r.manifest.disclosure;
  $("detailTitle").textContent = m.title;
  $("titleInput").value = m.title;
  $("summaryInput").value = m.summary;
  $("posterVisible").checked = m.posterVisible;
  $("liveRankingVisible").checked = Boolean(m.liveRankingVisible);
  $("extendEndsAt").min = toLocalInput(new Date(Math.max(Date.now(), new Date(r.endsAt).getTime()) + 60000));
  $("raceTimeStatus").textContent = `状态：${statusLabel(r.status)} · 开始：${formatDateTime(r.startsAt)} · 结束：${formatDateTime(r.endsAt)} · ${remainingText(r)}`;
  $("challengeStatus").textContent = r.challengeConfigured ? `ARY 已保存结构化赛题 v${r.challenge.version}，更新于 ${formatDateTime(r.challenge.updatedAt)}` : "尚未配置赛题；Racer 仍可以参加和提交。";
  $("challengeTitle").value = r.challenge?.title || "";
  $("challengeDescription").value = r.challenge?.description || "";
  $("challengeSubmissionRequirements").value = r.challenge?.submissionRequirements || "";
  $("challengeEvaluationCriteria").value = r.challenge?.evaluationCriteria || "";
  $("challengeNotes").value = r.challenge?.notes || "";
  $("liveRankingStatus").textContent = r.liveRanking
    ? `本地分数文件 v${r.liveRanking.version} · ${r.liveRanking.stale ? "同步异常，展示上一有效排名" : "ARY 已同步并完成排序"} · ${formatDateTime(r.liveRanking.updatedAt)} · SHA256 ${r.liveRanking.sha256}`
    : `请将分数投影原子写入 organizer-storage/races/${r.raceId}/live-ranking.json`;
  $("liveRankingPreview").innerHTML = rankingRowsHtml(r.liveRanking);
  $("livePreview").innerHTML = `<div class="preview-card">${m.posterVisible ? `<img src="/organizer/races/${r.raceId}/poster.svg?v=${r.manifest.version}">` : `<div class="empty">海报已撤回</div>`}<div><span class="eyebrow">${statusLabel(r.status)} · V${r.manifest.version}</span><h2>${escapeHtml(m.title)}</h2><p>${escapeHtml(m.summary)}</p><p>${escapeHtml(m.timeline)}</p><p>实时排名：${m.liveRankingVisible && r.status === "open" ? "公开" : "不公开"}</p>${m.liveRankingVisible && r.status === "open" ? rankingRowsHtml(r.liveRanking) : ""}</div></div>`;
  $("longTermArchive").classList.toggle("hidden", r.status !== "ended");
  const current = r.archive?.versions?.find(v => v.version === r.archive.currentVersion);
  $("archiveStatus").textContent = `最终海报：${r.archivePosterUploaded ? "已暂存" : "未上传"} · 当前公开版本：${current ? `v${current.version}` : "未发布"} · 私人证书：${r.certificateCount}`;
  updateShowcaseFields();
}

async function refresh(id = selectedRaceId) {
  state = await api("/api/state");
  selectedRaceId = state.races.some(r => r.raceId === id) ? id : state.races[0]?.raceId;
  render();
}

$("createRace").onclick = async () => {
  const x = await api("/api/organizer/races", { method: "POST", body: JSON.stringify({ title: $("createTitle").value, summary: $("createSummary").value, startsAt: new Date($("createStartsAt").value).toISOString(), endsAt: new Date($("createEndsAt").value).toISOString(), liveRankingVisible: $("createLiveRankingVisible").checked }) });
  toast("赛事已创建");
  await refresh(x.race.raceId);
};
$("raceList").onclick = e => { const b = e.target.closest("[data-race-id]"); if (b) { selectedRaceId = b.dataset.raceId; render(); } };
$("saveDisclosure").onclick = async () => { await api(`/api/organizer/races/${selectedRaceId}/disclosure`, { method: "POST", body: JSON.stringify({ title: $("titleInput").value, summary: $("summaryInput").value, posterVisible: $("posterVisible").checked, liveRankingVisible: $("liveRankingVisible").checked }) }); toast("披露已更新"); await refresh(); };
$("extendRace").onclick = async () => { await api(`/api/organizer/races/${selectedRaceId}/extend`, { method: "POST", body: JSON.stringify({ endsAt: new Date($("extendEndsAt").value).toISOString() }) }); toast("赛事结束时间已延长"); await refresh(); };
$("saveChallenge").onclick = async () => { const x = await api(`/api/organizer/races/${selectedRaceId}/challenge`, { method: "PUT", body: JSON.stringify({ title: $("challengeTitle").value, description: $("challengeDescription").value, submissionRequirements: $("challengeSubmissionRequirements").value, evaluationCriteria: $("challengeEvaluationCriteria").value, notes: $("challengeNotes").value }) }); toast(`结构化赛题 v${x.challenge.version} 已保存至 ARY`); await refresh(); };
$("uploadArchivePoster").onclick = async () => { const x = await uploadPdf(`/api/organizer/races/${selectedRaceId}/archive-poster`, "archivePosterFile"); $("archivePosterResult").textContent = `大小：${x.size} B\nSHA256：${x.sha256}`; toast("最终海报已暂存"); await refresh(); };
$("uploadCertificatesZip").onclick = async () => {
  const x = await uploadZip(`/api/organizer/races/${selectedRaceId}/certificates-bulk`, "certificatesZipFile");
  $("certificateResult").textContent = x.certificates.map(c => `${c.racerId} · v${c.version} · ${c.sha256}`).join("\n");
  toast(`已上传 ${x.certificates.length} 份私人证书`);
  await refresh();
};
$("publishArchive").onclick = async () => {
  const results = collectArchiveResults();
  const x = await api(`/api/organizer/races/${selectedRaceId}/archive`, { method: "POST", body: JSON.stringify({ results, showcases: collectTopShowcases(results) }) });
  toast(`长期归档 v${x.archive.version} 已发布`);
  await refresh();
};
for (let rank = 1; rank <= 10; rank++) {
  $(`archiveRacer${rank}`).addEventListener("input", () => updateShowcaseFields());
  $(`archiveScore${rank}`).addEventListener("input", () => updateShowcaseFields());
}
const now = new Date(), endToday = new Date(now);
endToday.setHours(23, 59, 0, 0);
$("createStartsAt").min = toLocalInput(now);
$("createStartsAt").max = toLocalInput(endToday);
$("createStartsAt").value = toLocalInput(new Date(now.getTime() + 60000));
$("createEndsAt").min = toLocalInput(new Date(now.getTime() + 120000));
$("createEndsAt").value = toLocalInput(new Date(now.getTime() + 3600000));
$("createStartsAt").onchange = () => { $("createEndsAt").min = toLocalInput(new Date(new Date($("createStartsAt").value).getTime() + 60000)); };
refresh();
setInterval(() => { if (!["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) refresh(); }, 5000);
