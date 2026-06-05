const $ = id => document.getElementById(id);
const roleStyles = document.createElement("style");
roleStyles.textContent = ".hidden{display:none!important}.race-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:30px}.race-card{margin-bottom:0}.race-select{display:block;width:100%;margin-bottom:8px;text-align:left}button:disabled{opacity:.45;cursor:not-allowed}@media(max-width:800px){.race-grid{grid-template-columns:1fr}}";
document.head.appendChild(roleStyles);
const formatDateTime = value => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const toLocalInput = date => {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 16);
};
const statusLabel = status => ({ scheduled: "未开始", open: "进行中", ended: "已终止" }[status] || status);
const remainingText = race => {
  const target = race.status === "scheduled" ? new Date(race.startsAt).getTime() : new Date(race.endsAt).getTime();
  if (race.status === "ended") return "已结束";
  const seconds = Math.max(0, Math.floor((target - Date.now()) / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), secs = seconds % 60;
  return `${race.status === "scheduled" ? "距开始" : "剩余"} ${hours}小时 ${minutes}分 ${secs}秒`;
};
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "request_failed");
  return data;
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  setTimeout(() => $("toast").classList.remove("show"), 2200);
}

function filesHtml(files) {
  return files.length
    ? files.map(file => `<div class="file"><code>${escapeHtml(file.path)}</code><span>${file.size} B · ${file.sha256}</span></div>`).join("")
    : `<div class="empty">目录为空</div>`;
}

window.addEventListener("unhandledrejection", event => toast(`操作失败：${event.reason.message}`));
