const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");

const HOST = process.env.HOST || "127.0.0.1";
const PORTS = {
  ary: Number(process.env.ARY_PORT || 4311),
  organizer: Number(process.env.ORGANIZER_PORT || 4312),
  racer: Number(process.env.RACER_PORT || 4313),
  visitor: Number(process.env.VISITOR_PORT || 4314)
};
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const ORGANIZER = path.join(ROOT, "organizer-storage");
const RACES = path.join(ORGANIZER, "races");
const ARY = path.join(ROOT, "ary-storage");
const ARCHIVE = path.join(ARY, "public-archive");
const CERTIFICATES = path.join(ARY, "certificates");
const MAX_FILE_SIZE = 16 * 1024 * 1024;
const MAX_ZIP_SIZE = 64 * 1024 * 1024;
const MAX_RANKING_FILE_SIZE = 1024 * 1024;
const MAX_RANKING_ROWS = 1000;
const DEFAULT_RACER_ID = "racer-001";
const ORGANIZER_ID = "organizer-001";
const SERVER_TIME_ZONE = "Asia/Shanghai";

for (const dir of [ORGANIZER, RACES, ARY, ARCHIVE, CERTIFICATES]) fs.mkdirSync(dir, { recursive: true });

const files = {
  races: path.join(ARY, "races.json"),
  participations: path.join(ARY, "participations.json"),
  metadata: path.join(ARY, "metadata.json"),
  audit: path.join(ARY, "audit.json"),
  archives: path.join(ARY, "archives.json"),
  certificates: path.join(ARY, "certificates.json"),
  challenges: path.join(ARY, "challenges.json"),
  liveRankingMeta: path.join(ARY, "live-ranking-meta.json")
};
const liveRankingCache = new Map();
const liveRankingClients = new Set();
const rankingDebounce = new Map();
const rankingFileStats = new Map();
let rankingWatcher;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}
function writeJsonAtomic(file, value) {
  const part = `${file}.part`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(part, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(part, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return fallback; }
}
function normalizeRacerId(value) {
  const racerId = String(value || DEFAULT_RACER_ID).trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(racerId)) {
    const error = new Error("invalid_racer_id"); error.statusCode = 400; throw error;
  }
  return racerId;
}
function racerIdFromRequest(req, url) {
  return normalizeRacerId(req.headers["x-racer-id"] || url.searchParams.get("racer") || url.searchParams.get("racerId"));
}
function clearDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
}
function init() {
  if (!fs.existsSync(files.races)) writeJson(files.races, []);
  if (!fs.existsSync(files.participations)) writeJson(files.participations, []);
  if (!fs.existsSync(files.metadata)) writeJson(files.metadata, {});
  if (!fs.existsSync(files.audit)) writeJson(files.audit, []);
  if (!fs.existsSync(files.archives)) writeJson(files.archives, []);
  if (!fs.existsSync(files.certificates)) writeJson(files.certificates, []);
  if (!fs.existsSync(files.challenges)) writeJson(files.challenges, {});
  if (!fs.existsSync(files.liveRankingMeta)) writeJson(files.liveRankingMeta, {});
  migrateRaceTimes();
  migratePublicRaceMetadata();
  removeLegacyDownloadData();
  scanLiveRankings();
  watchLiveRankings();
}

function localDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SERVER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}
function raceStatus(race, now = Date.now()) {
  if (race.forceFinishedAt) return "ended";
  if (now < new Date(race.startsAt).getTime()) return "scheduled";
  if (now >= new Date(race.endsAt).getTime()) return "ended";
  return "open";
}
function timelineText(race) {
  const format = new Intl.DateTimeFormat("zh-CN", {
    timeZone: SERVER_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  });
  return `${format.format(new Date(race.startsAt))} 至 ${format.format(new Date(race.endsAt))}`;
}
function validateRaceTimes(startsAt, endsAt) {
  const start = new Date(startsAt), end = new Date(endsAt), now = new Date();
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    const error = new Error("invalid_race_time"); error.statusCode = 400; throw error;
  }
  if (localDateKey(start) !== localDateKey(now)) {
    const error = new Error("start_must_be_today"); error.statusCode = 400; throw error;
  }
  if (start.getTime() < now.getTime()) {
    const error = new Error("start_time_in_past"); error.statusCode = 400; throw error;
  }
  if (end.getTime() <= start.getTime()) {
    const error = new Error("end_must_be_after_start"); error.statusCode = 400; throw error;
  }
  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
}
function assertRaceOpen(race) {
  const status = raceStatus(race);
  if (status === "scheduled") { const error = new Error("race_not_started"); error.statusCode = 409; throw error; }
  if (status === "ended") { const error = new Error("race_ended"); error.statusCode = 409; throw error; }
}
function migrateRaceTimes() {
  const races = readJson(files.races, []);
  const archives = readJson(files.archives, []);
  let changed = false;
  let archivesChanged = false;
  const now = new Date();
  for (const race of races) {
    if (!race.startsAt || !race.endsAt) {
      race.startsAt = now.toISOString();
      race.endsAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
      delete race.status;
      const paths = racePaths(race.raceId);
      const manifest = readJson(paths.manifest, null);
      changed = true;
    }
    const archive = archives.find(item => item.raceId === race.raceId);
    if (archive && !archive.versions && (!archive.startsAt || !archive.endsAt)) {
      archive.startsAt = race.startsAt;
      archive.endsAt = race.endsAt;
      archive.timeline = timelineText(race);
      archivesChanged = true;
    }
  }
  if (changed) writeJson(files.races, races);
  if (archivesChanged) writeJson(files.archives, archives);
}
function migratePublicRaceMetadata() {
  const races = readJson(files.races, []);
  let racesChanged = false;
  for (const race of races) {
    const paths = racePaths(race.raceId);
    const manifest = readJson(paths.manifest, null);
    if (!manifest?.disclosure) continue;
    if (typeof race.title !== "string") {
      race.title = String(manifest.disclosure.title || race.raceId);
      racesChanged = true;
    }
    if (typeof race.summary !== "string") {
      race.summary = String(manifest.disclosure.summary || "");
      racesChanged = true;
    }
    if ("title" in manifest.disclosure || "summary" in manifest.disclosure || "timeline" in manifest.disclosure) {
      delete manifest.disclosure.title;
      delete manifest.disclosure.summary;
      delete manifest.disclosure.timeline;
      writeJson(paths.manifest, manifest);
    }
  }
  if (racesChanged) writeJson(files.races, races);
}
init();

function racePaths(raceId) {
  const root = path.join(RACES, raceId);
  return {
    root,
    submissions: path.join(root, "submissions"),
    archive: path.join(root, "archive"),
    archivePoster: path.join(root, "archive", "poster.pdf"),
    liveRanking: path.join(root, "live-ranking.json"),
    manifest: path.join(root, "manifest.json")
  };
}
function writeLiveRankingTemplate(race) {
  writeJsonAtomic(racePaths(race.raceId).liveRanking, {
    raceId: race.raceId,
    version: 1,
    updatedAt: race.createdAt,
    scores: []
  });
}
function removeLegacyDownloadData() {
  if (!fs.existsSync(RACES)) return;
  for (const raceId of fs.readdirSync(RACES)) {
    const root = path.join(RACES, raceId);
    fs.rmSync(path.join(root, "datasets"), { recursive: true, force: true });
    fs.rmSync(path.join(root, "download-policy.json"), { force: true });
    fs.rmSync(path.join(root, "download-tickets.json"), { force: true });
  }
}
function getChallenge(raceId) { return readJson(files.challenges, {})[raceId] || null; }
function setChallenge(raceId, challenge) {
  const challenges = readJson(files.challenges, {});
  challenges[raceId] = challenge;
  writeJson(files.challenges, challenges);
}
function validateLiveRanking(input, raceId) {
  const allowedFields = new Set(["raceId", "version", "updatedAt", "scores"]);
  const allowedScoreFields = new Set(["racerId", "score"]);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowedFields.has(key))) throw new Error("invalid_live_ranking_fields");
  if (input.raceId !== raceId || !Number.isInteger(input.version) || input.version < 1 || !Array.isArray(input.scores)) throw new Error("invalid_live_ranking");
  if (input.scores.length > MAX_RANKING_ROWS) throw new Error("live_ranking_too_many_rows");
  if (!Number.isFinite(new Date(input.updatedAt).getTime())) throw new Error("invalid_live_ranking");
  const scores = input.scores.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !allowedScoreFields.has(key))) throw new Error("invalid_live_ranking_fields");
    if (typeof item.racerId !== "string" || !item.racerId.trim()) throw new Error("invalid_live_ranking");
    const racerId = normalizeRacerId(item.racerId), score = Number(item.score);
    if (!Number.isFinite(score)) throw new Error("invalid_live_ranking");
    return { racerId, score };
  });
  if (new Set(scores.map(item => item.racerId)).size !== scores.length) throw new Error("duplicate_live_ranking_racer");
  const rows = scores
    .slice()
    .sort((a, b) => b.score - a.score || a.racerId.localeCompare(b.racerId))
    .map((item, index) => ({ rank: index + 1, racerId: item.racerId, score: item.score }));
  return { raceId, version: input.version, updatedAt: new Date(input.updatedAt).toISOString(), scores, rows };
}
function writeLiveRankingMeta(raceId, value) {
  const all = readJson(files.liveRankingMeta, {});
  all[raceId] = value;
  writeJson(files.liveRankingMeta, all);
}
function publicLiveRankings() {
  return readJson(files.races, []).flatMap(race => {
    const manifest = readJson(racePaths(race.raceId).manifest, {});
    const cached = liveRankingCache.get(race.raceId);
    if (raceStatus(race) !== "open" || !manifest.disclosure?.liveRankingVisible || !cached) return [];
    return [{ raceId: race.raceId, title: race.title, version: cached.version, updatedAt: cached.updatedAt, sha256: cached.sha256, stale: Boolean(cached.stale), rows: cached.rows }];
  });
}
function liveRankingView(ranking) {
  return ranking ? { raceId: ranking.raceId, version: ranking.version, updatedAt: ranking.updatedAt, sha256: ranking.sha256, stale: Boolean(ranking.stale), frozen: Boolean(ranking.frozen), rows: ranking.rows } : null;
}
function isLiveRankingDisclosureEnabled(raceId) {
  const manifest = readJson(racePaths(raceId).manifest, {});
  return Boolean(manifest.disclosure?.liveRankingVisible);
}
function clearLiveRankingProjection(raceId) {
  clearTimeout(rankingDebounce.get(raceId));
  rankingDebounce.delete(raceId);
  rankingFileStats.set(raceId, rankingFileSignature(raceId));
  const hadRanking = liveRankingCache.delete(raceId);
  writeLiveRankingMeta(raceId, { raceId, available: false, stale: false, syncedAt: new Date().toISOString() });
  if (hadRanking) broadcastLiveRankings();
}
function sendSse(res, event, value) { res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); }
function broadcastLiveRankings() {
  const snapshot = publicLiveRankings();
  for (const client of liveRankingClients) {
    try { sendSse(client, "rankings", snapshot); } catch { liveRankingClients.delete(client); }
  }
}
function loadLiveRanking(raceId, action = "LIVE_RANKING_SYNCED", options = {}) {
  const race = getRace(raceId);
  if (!options.allowFinished && race && raceStatus(race) === "ended") {
    const cached = liveRankingCache.get(raceId);
    if (cached && !cached.frozen) {
      liveRankingCache.set(raceId, { ...cached, frozen: true });
      writeLiveRankingMeta(raceId, { raceId, available: true, version: cached.version, sha256: cached.sha256, updatedAt: cached.updatedAt, syncedAt: new Date().toISOString(), stale: Boolean(cached.stale), frozen: true, stoppedAt: new Date().toISOString() });
      broadcastLiveRankings();
    }
    return;
  }
  if (!options.allowHidden && !isLiveRankingDisclosureEnabled(raceId)) {
    clearLiveRankingProjection(raceId);
    return;
  }
  const file = racePaths(raceId).liveRanking;
  if (!fs.existsSync(file)) {
    rankingFileStats.set(raceId, "missing");
    if (liveRankingCache.delete(raceId)) {
      writeLiveRankingMeta(raceId, { raceId, available: false, stale: false, syncedAt: new Date().toISOString() });
      audit("ARY", "LIVE_RANKING_REMOVED", raceId);
      broadcastLiveRankings();
    }
    return;
  }
  try {
    rankingFileStats.set(raceId, rankingFileSignature(raceId));
    if (fs.statSync(file).size > MAX_RANKING_FILE_SIZE) throw new Error("live_ranking_file_too_large");
    const raw = fs.readFileSync(file, "utf8"), parsed = validateLiveRanking(JSON.parse(raw.replace(/^\uFEFF/, "")), raceId), previous = liveRankingCache.get(raceId), previousMeta = readJson(files.liveRankingMeta, {})[raceId];
    const currentVersion = options.resetVersionBaseline ? 0 : (previous?.version || previousMeta?.version || 0);
    const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
    if (parsed.version < currentVersion) {
      if (previous) liveRankingCache.set(raceId, { ...previous, stale: true });
      else liveRankingCache.delete(raceId);
      writeLiveRankingMeta(raceId, { raceId, available: Boolean(previous), version: currentVersion, sha256: previous?.sha256 || previousMeta?.sha256 || null, updatedAt: previous?.updatedAt || previousMeta?.updatedAt || null, syncedAt: new Date().toISOString(), stale: true, error: "old_version_ignored" });
      audit("ARY", "LIVE_RANKING_OLD_VERSION_IGNORED", raceId, { version: parsed.version, currentVersion });
      broadcastLiveRankings();
      return;
    }
    const currentSha256 = previous?.sha256 || previousMeta?.sha256 || null;
    if (parsed.version === currentVersion && currentSha256 && sha256 !== currentSha256) {
      if (previous) liveRankingCache.set(raceId, { ...previous, stale: true });
      writeLiveRankingMeta(raceId, { raceId, available: Boolean(previous), version: currentVersion, sha256: currentSha256, updatedAt: previous?.updatedAt || previousMeta?.updatedAt || null, syncedAt: new Date().toISOString(), stale: true, frozen: false, error: "same_version_content_changed" });
      audit("ARY", "LIVE_RANKING_SAME_VERSION_REJECTED", raceId, { version: parsed.version, sha256 });
      broadcastLiveRankings();
      return;
    }
    if (previous?.sha256 === sha256 && !previous.stale) return;
    const cached = { ...parsed, sha256, stale: false };
    liveRankingCache.set(raceId, cached);
    writeLiveRankingMeta(raceId, { raceId, available: true, version: cached.version, sha256, updatedAt: cached.updatedAt, syncedAt: new Date().toISOString(), stale: false, frozen: false });
    audit("ARY", action, raceId, { version: cached.version, sha256 }); broadcastLiveRankings();
  } catch (error) {
    const previous = liveRankingCache.get(raceId);
    if (previous && !previous.stale) liveRankingCache.set(raceId, { ...previous, stale: true });
    writeLiveRankingMeta(raceId, { raceId, available: Boolean(previous), version: previous?.version || null, sha256: previous?.sha256 || null, updatedAt: previous?.updatedAt || null, syncedAt: new Date().toISOString(), stale: true, error: error.message });
    audit("ARY", "LIVE_RANKING_SYNC_FAILED", raceId, { error: error.message }); broadcastLiveRankings();
  }
}
function freezeLiveRanking(raceId) {
  loadLiveRanking(raceId, "LIVE_RANKING_SYNCED_BEFORE_FORCE_FINISH", { allowFinished: true });
  const cached = liveRankingCache.get(raceId);
  const now = new Date().toISOString();
  if (cached) {
    const frozen = { ...cached, stale: false, frozen: true };
    liveRankingCache.set(raceId, frozen);
    writeLiveRankingMeta(raceId, { raceId, available: true, version: frozen.version, sha256: frozen.sha256, updatedAt: frozen.updatedAt, syncedAt: now, stale: false, frozen: true, stoppedAt: now });
  } else {
    const previousMeta = readJson(files.liveRankingMeta, {})[raceId] || {};
    writeLiveRankingMeta(raceId, { raceId, available: false, version: previousMeta.version || null, sha256: previousMeta.sha256 || null, updatedAt: previousMeta.updatedAt || null, syncedAt: now, stale: Boolean(previousMeta.stale), frozen: true, stoppedAt: now, error: previousMeta.error || "no_valid_live_ranking_to_freeze" });
  }
  return cached || null;
}
function scanLiveRankings() {
  if (!fs.existsSync(RACES)) return;
  for (const raceId of fs.readdirSync(RACES)) if (fs.statSync(path.join(RACES, raceId)).isDirectory()) loadLiveRanking(raceId, "LIVE_RANKING_LOADED");
}
function rankingFileSignature(raceId) {
  const file = racePaths(raceId).liveRanking;
  try {
    const stats = fs.statSync(file);
    return stats.isFile() ? `${stats.mtimeMs}:${stats.size}` : "missing";
  } catch {
    return "missing";
  }
}
function scanLiveRankingChanges() {
  if (!fs.existsSync(RACES)) return;
  const seen = new Set();
  for (const raceId of fs.readdirSync(RACES)) {
    const root = path.join(RACES, raceId);
    let isRaceDirectory = false;
    try {
      isRaceDirectory = fs.statSync(root).isDirectory();
    } catch {
      continue;
    }
    if (!isRaceDirectory) continue;
    seen.add(raceId);
    const signature = rankingFileSignature(raceId), previous = rankingFileStats.get(raceId);
    if (signature !== previous) {
      rankingFileStats.set(raceId, signature);
      scheduleRankingLoad(raceId);
    }
  }
  for (const raceId of [...rankingFileStats.keys()]) {
    if (!seen.has(raceId)) {
      rankingFileStats.delete(raceId);
      if (liveRankingCache.delete(raceId)) broadcastLiveRankings();
    }
  }
}
function scheduleRankingLoad(raceId) {
  const race = getRace(raceId);
  if (race && raceStatus(race) === "ended") return;
  clearTimeout(rankingDebounce.get(raceId));
  rankingDebounce.set(raceId, setTimeout(() => { rankingDebounce.delete(raceId); loadLiveRanking(raceId); }, 80));
}
function watchLiveRankings() {
  rankingWatcher?.close();
  rankingWatcher = fs.watch(RACES, { recursive: true }, (event, relative) => {
    if (!relative) return;
    const parts = String(relative).split(/[\\/]/);
    const fileName = path.basename(relative);
    if (fileName !== "live-ranking.json" && fileName !== "live-ranking.json.part" && parts.length < 2) return;
    scheduleRankingLoad(parts[0]);
  });
}
function sha256File(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function latestArchive(record) {
  return record?.versions?.find(version => version.version === record.currentVersion) || record?.versions?.at(-1) || null;
}
function archiveRecord(raceId) { return readJson(files.archives, []).find(item => item.raceId === raceId) || null; }
function validateArchiveInput(input) {
  const allowedInputFields = new Set(["results", "showcases"]);
  const allowedResultFields = new Set(["rank", "racerId", "score"]);
  const allowedShowcaseFields = new Set(["rank", "racerId", "title", "summary", "demoUrl"]);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowedInputFields.has(key))) { const e = new Error("invalid_archive_fields"); e.statusCode = 400; throw e; }
  if (!Array.isArray(input.results) || input.results.length === 0) { const e = new Error("final_ranking_required"); e.statusCode = 400; throw e; }
  if (input.results.length > 10) { const e = new Error("final_ranking_top_10_only"); e.statusCode = 400; throw e; }
  const results = input.results.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !allowedResultFields.has(key))) { const e = new Error("invalid_final_ranking_fields"); e.statusCode = 400; throw e; }
    const rank = Number(item.rank), score = Number(item.score), racerId = normalizeRacerId(item.racerId);
    if (!Number.isInteger(rank) || rank < 1 || rank > 10 || !Number.isFinite(score)) { const e = new Error("invalid_final_ranking"); e.statusCode = 400; throw e; }
    return { rank, racerId, score };
  }).sort((a, b) => a.rank - b.rank);
  if (new Set(results.map(item => item.rank)).size !== results.length) { const e = new Error("duplicate_final_ranking_rank"); e.statusCode = 400; throw e; }
  if (new Set(results.map(item => item.racerId)).size !== results.length) { const e = new Error("duplicate_final_ranking_racer"); e.statusCode = 400; throw e; }
  if (results.some((item, index) => item.rank !== index + 1)) { const e = new Error("final_ranking_must_be_contiguous"); e.statusCode = 400; throw e; }
  if (input.showcases !== undefined && !Array.isArray(input.showcases)) { const e = new Error("invalid_showcases"); e.statusCode = 400; throw e; }
  if ((input.showcases || []).length > 3) { const e = new Error("showcases_top_3_only"); e.statusCode = 400; throw e; }
  const rawShowcases = input.showcases || [];
  const showcases = results.slice(0, 3).map((row, index) => {
    const item = rawShowcases[index] || {};
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !allowedShowcaseFields.has(key))) { const e = new Error("invalid_showcase_fields"); e.statusCode = 400; throw e; }
    if (item.rank !== undefined && Number(item.rank) !== row.rank) { const e = new Error("showcase_ranking_mismatch"); e.statusCode = 400; throw e; }
    if (item.racerId !== undefined && normalizeRacerId(item.racerId) !== row.racerId) { const e = new Error("showcase_ranking_mismatch"); e.statusCode = 400; throw e; }
    const demoUrl = String(item.demoUrl || "").trim();
    if (demoUrl) { try { new URL(demoUrl); } catch { const e = new Error("invalid_showcase_url"); e.statusCode = 400; throw e; } }
    return {
      rank: row.rank,
      racerId: row.racerId,
      score: row.score,
      title: String(item.title || ""),
      summary: String(item.summary || ""),
      demoUrl
    };
  }).filter(item => item.title.trim() || item.summary.trim() || item.demoUrl);
  return { results, showcases };
}
function getRace(raceId) { return readJson(files.races, []).find(race => race.raceId === raceId); }
function requireRace(raceId) {
  const race = getRace(raceId);
  if (!race) { const error = new Error("race_not_found"); error.statusCode = 404; throw error; }
  return race;
}
function updateRace(raceId, updater) {
  const races = readJson(files.races, []);
  const index = races.findIndex(race => race.raceId === raceId);
  if (index < 0) return null;
  races[index] = updater(races[index]);
  writeJson(files.races, races);
  return races[index];
}
function metadataKey(raceId, racerId = DEFAULT_RACER_ID) { return `${raceId}:${racerId}`; }
function getMetadata(raceId, racerId = DEFAULT_RACER_ID) {
  return readJson(files.metadata, {})[metadataKey(raceId, racerId)] || {
    raceId, racerId, submissionStatus: "not_submitted", receiptId: null
  };
}
function setMetadata(raceId, value, racerId = DEFAULT_RACER_ID) {
  const all = readJson(files.metadata, {});
  all[metadataKey(raceId, racerId)] = value;
  writeJson(files.metadata, all);
}
function isJoined(raceId, racerId = DEFAULT_RACER_ID) {
  return readJson(files.participations, []).some(item => item.raceId === raceId && item.racerId === racerId);
}
function audit(actor, action, target, detail = {}) {
  const logs = readJson(files.audit, []);
  logs.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, target, detail });
  writeJson(files.audit, logs.slice(0, 300));
}
function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
function text(res, status, value, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(value);
}
function body(req, limit = MAX_FILE_SIZE) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) { const error = new Error("payload_too_large"); error.statusCode = 413; reject(error); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

class PdfGuard extends Transform {
  constructor(maxSize) { super(); this.maxSize = maxSize; this.size = 0; this.header = Buffer.alloc(0); this.validated = false; this.hash = crypto.createHash("sha256"); }
  _transform(chunk, encoding, callback) {
    this.size += chunk.length;
    if (this.size > this.maxSize) { const e = new Error("pdf_too_large"); e.statusCode = 413; return callback(e); }
    this.hash.update(chunk);
    if (!this.validated) {
      this.header = Buffer.concat([this.header, chunk]);
      if (this.header.length < 5) return callback();
      if (this.header.subarray(0, 5).toString("ascii") !== "%PDF-") { const e = new Error("invalid_pdf"); e.statusCode = 415; return callback(e); }
      this.validated = true; const buffered = this.header; this.header = Buffer.alloc(0); return callback(null, buffered);
    }
    callback(null, chunk);
  }
  _flush(callback) { if (!this.validated) { const e = new Error("invalid_pdf"); e.statusCode = 415; return callback(e); } callback(); }
  digest() { return this.hash.digest("hex"); }
}
async function receivePdf(req, partPath, finalPath) {
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const guard = new PdfGuard(MAX_FILE_SIZE);
  try {
    await pipeline(req, guard, fs.createWriteStream(partPath, { flags: "wx" }));
    const hash = guard.digest();
    fs.rmSync(finalPath, { force: true });
    fs.renameSync(partPath, finalPath);
    return { hash, size: guard.size };
  } catch (error) { fs.rmSync(partPath, { force: true }); throw error; }
}
function validatePdfRequest(req) {
  const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const fileName = path.basename(decodeURIComponent(String(req.headers["x-file-name"] || "file.pdf")));
  const declaredSize = Math.max(Number(req.headers["content-length"] || 0), Number(req.headers["x-file-size"] || 0));
  if (contentType !== "application/pdf" || !fileName.toLowerCase().endsWith(".pdf")) { const e = new Error("pdf_required"); e.statusCode = 415; throw e; }
  if (!Number.isFinite(declaredSize) || declaredSize < 0) { const e = new Error("invalid_file_size"); e.statusCode = 400; throw e; }
  if (declaredSize > MAX_FILE_SIZE) { const e = new Error("pdf_too_large"); e.statusCode = 413; throw e; }
  return { contentType, fileName, declaredSize };
}
function validateZipRequest(req) {
  const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const fileName = path.basename(decodeURIComponent(String(req.headers["x-file-name"] || "certificates.zip")));
  const declaredSize = Math.max(Number(req.headers["content-length"] || 0), Number(req.headers["x-file-size"] || 0));
  if (!["application/zip", "application/x-zip-compressed", "application/octet-stream"].includes(contentType) || !fileName.toLowerCase().endsWith(".zip")) { const e = new Error("zip_required"); e.statusCode = 415; throw e; }
  if (!Number.isFinite(declaredSize) || declaredSize < 0) { const e = new Error("invalid_file_size"); e.statusCode = 400; throw e; }
  if (declaredSize > MAX_ZIP_SIZE) { const e = new Error("zip_too_large"); e.statusCode = 413; throw e; }
  return { contentType, fileName, declaredSize };
}
function parseCertificateZip(buffer) {
  const eocdMin = 22, maxComment = 0xffff, start = Math.max(0, buffer.length - eocdMin - maxComment);
  let eocd = -1;
  for (let i = buffer.length - eocdMin; i >= start; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) { const e = new Error("invalid_zip"); e.statusCode = 400; throw e; }
  const entries = buffer.readUInt16LE(eocd + 10), centralOffset = buffer.readUInt32LE(eocd + 16);
  const certificates = [];
  const seen = new Set();
  let offset = centralOffset;
  for (let index = 0; index < entries; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) { const e = new Error("invalid_zip"); e.statusCode = 400; throw e; }
    const method = buffer.readUInt16LE(offset + 10), compressedSize = buffer.readUInt32LE(offset + 20), uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28), extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32), localOffset = buffer.readUInt32LE(offset + 42);
    const entryName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replaceAll("\\", "/");
    offset += 46 + nameLength + extraLength + commentLength;
    if (!entryName || entryName.endsWith("/") || entryName.startsWith("__MACOSX/")) continue;
    if (entryName.includes("/")) { const e = new Error("certificate_zip_must_use_root_files"); e.statusCode = 400; throw e; }
    if (!entryName.toLowerCase().endsWith(".pdf")) { const e = new Error("certificate_zip_only_pdf"); e.statusCode = 400; throw e; }
    const racerId = normalizeRacerId(path.basename(entryName, path.extname(entryName)));
    if (seen.has(racerId)) { const e = new Error("duplicate_certificate_racer"); e.statusCode = 400; throw e; }
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) { const e = new Error("invalid_zip"); e.statusCode = 400; throw e; }
    const localNameLength = buffer.readUInt16LE(localOffset + 26), localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength, dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length || uncompressedSize > MAX_FILE_SIZE) { const e = new Error("certificate_pdf_too_large"); e.statusCode = 413; throw e; }
    const compressed = buffer.subarray(dataStart, dataEnd);
    let pdf;
    if (method === 0) pdf = Buffer.from(compressed);
    else if (method === 8) pdf = zlib.inflateRawSync(compressed);
    else { const e = new Error("unsupported_zip_compression"); e.statusCode = 400; throw e; }
    if (pdf.length !== uncompressedSize || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") { const e = new Error("invalid_certificate_pdf"); e.statusCode = 415; throw e; }
    seen.add(racerId);
    certificates.push({ racerId, fileName: entryName, bytes: pdf });
  }
  if (!certificates.length) { const e = new Error("certificate_zip_empty"); e.statusCode = 400; throw e; }
  return certificates;
}
function storeCertificateBuffer(raceId, racerId, pdfBuffer) {
  if (!isJoined(raceId, racerId)) { const e = new Error(`race_participation_required:${racerId}`); e.statusCode = 409; throw e; }
  if (pdfBuffer.length > MAX_FILE_SIZE) { const e = new Error("pdf_too_large"); e.statusCode = 413; throw e; }
  if (pdfBuffer.subarray(0, 5).toString("ascii") !== "%PDF-") { const e = new Error("invalid_pdf"); e.statusCode = 415; throw e; }
  const certificates = readJson(files.certificates, []), previous = certificates.filter(item => item.raceId === raceId && item.racerId === racerId), version = previous.length + 1;
  const dir = path.join(CERTIFICATES, raceId, racerId), part = path.join(dir, `.v${version}.part`), final = path.join(dir, `v${version}.pdf`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(part, pdfBuffer);
  fs.rmSync(final, { force: true });
  fs.renameSync(part, final);
  const certificateId = `certificate-${crypto.randomUUID()}`, sha256 = crypto.createHash("sha256").update(pdfBuffer).digest("hex");
  const certificate = { certificateId, raceId, racerId, version, sha256, size: pdfBuffer.length, uploadedAt: new Date().toISOString(), downloadUrl: `/racer-certificates/${certificateId}/download` };
  certificates.push(certificate); writeJson(files.certificates, certificates);
  return certificate;
}
function listFiles(dir, prefix = "") {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(prefix, entry.name), absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(absolute, relative);
    const stat = fs.statSync(absolute);
    return [{ path: relative.replaceAll("\\", "/"), size: stat.size, sha256: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex").slice(0, 16) }];
  });
}
function invalidKeys(value, allowedFields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["not_an_object"];
  return Object.keys(value).filter(key => !allowedFields.has(key));
}
function collectForbiddenKeys(value, location, violations) {
  const forbiddenKeys = new Set([
    "dataset",
    "datasets",
    "rawdata",
    "sourcedata",
    "sourcecontent",
    "submissioncontent",
    "scorebreakdown",
    "fullranking",
    "scores",
    "rows"
  ]);
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key.toLowerCase())) violations.push(`${location}.${key}`);
    collectForbiddenKeys(child, `${location}.${key}`, violations);
  }
}
function validateAryJsonStorage() {
  const violations = [];
  const validateList = (name, values, allowedFields) => {
    if (!Array.isArray(values)) {
      violations.push(`${name}:not_an_array`);
      return;
    }
    values.forEach((value, index) => invalidKeys(value, allowedFields).forEach(key => violations.push(`${name}[${index}].${key}`)));
  };
  const validateMap = (name, values, allowedFields) => {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      violations.push(`${name}:not_an_object`);
      return;
    }
    Object.entries(values).forEach(([key, value]) => invalidKeys(value, allowedFields).forEach(field => violations.push(`${name}.${key}.${field}`)));
  };

  const races = readJson(files.races, null);
  const participations = readJson(files.participations, null);
  const metadata = readJson(files.metadata, null);
  const audits = readJson(files.audit, null);
  const archives = readJson(files.archives, null);
  const certificates = readJson(files.certificates, null);
  const challenges = readJson(files.challenges, null);
  const rankingMeta = readJson(files.liveRankingMeta, null);

  validateList("races", races, new Set(["raceId", "organizerId", "title", "summary", "createdAt", "startsAt", "endsAt", "forceFinishedAt", "forceFinishedBy"]));
  validateList("participations", participations, new Set(["raceId", "racerId", "joinedAt"]));
  validateMap("metadata", metadata, new Set(["raceId", "racerId", "submissionStatus", "receiptId", "submissionHash", "submissionFileName", "submissionSize", "submittedAt"]));
  validateList("audit", audits, new Set(["id", "at", "actor", "action", "target", "detail"]));
  validateList("certificates", certificates, new Set(["certificateId", "raceId", "racerId", "version", "sha256", "size", "uploadedAt", "downloadUrl"]));
  validateMap("challenges", challenges, new Set(["raceId", "title", "description", "submissionRequirements", "evaluationCriteria", "notes", "version", "updatedAt", "updatedBy"]));
  validateMap("live-ranking-meta", rankingMeta, new Set(["raceId", "available", "version", "sha256", "updatedAt", "syncedAt", "stale", "frozen", "stoppedAt", "error"]));

  if (!Array.isArray(archives)) {
    violations.push("archives:not_an_array");
  } else {
    archives.forEach((record, recordIndex) => {
      invalidKeys(record, new Set(["raceId", "currentVersion", "versions"])).forEach(key => violations.push(`archives[${recordIndex}].${key}`));
      if (!Array.isArray(record?.versions)) {
        violations.push(`archives[${recordIndex}].versions:not_an_array`);
        return;
      }
      record.versions.forEach((version, versionIndex) => {
        invalidKeys(version, new Set(["raceId", "version", "title", "summary", "startsAt", "endsAt", "timeline", "posterUrl", "posterSha256", "results", "showcases", "organizerId", "publishedAt", "consentHash"]))
          .forEach(key => violations.push(`archives[${recordIndex}].versions[${versionIndex}].${key}`));
        validateList(`archives[${recordIndex}].versions[${versionIndex}].results`, version?.results, new Set(["rank", "racerId", "score"]));
        validateList(`archives[${recordIndex}].versions[${versionIndex}].showcases`, version?.showcases, new Set(["rank", "racerId", "score", "title", "summary", "demoUrl"]));
      });
    });
  }

  for (const [name, value] of Object.entries({ races, participations, metadata, audits, archives, certificates, challenges, rankingMeta })) {
    collectForbiddenKeys(value, name, violations);
  }
  return [...new Set(violations)];
}
function proof() {
  const organizerFiles = listFiles(ORGANIZER);
  const aryFiles = listFiles(ARY);
  const metadata = Object.values(readJson(files.metadata, {}));
  const challenges = Object.values(readJson(files.challenges, {}));
  const rankingMeta = Object.values(readJson(files.liveRankingMeta, {}));
  const jsonStorageViolations = validateAryJsonStorage();
  const challengeFields = new Set(["raceId", "title", "description", "submissionRequirements", "evaluationCriteria", "notes", "version", "updatedAt", "updatedBy"]);
  const challengeStringFields = ["raceId", "title", "description", "submissionRequirements", "evaluationCriteria", "notes", "updatedAt", "updatedBy"];
  const invalidChallenges = challenges.filter(challenge =>
    !challenge || Object.keys(challenge).some(key => !challengeFields.has(key)) ||
    challengeStringFields.some(key => typeof challenge[key] !== "string") ||
    !challenge.raceId || !challenge.title.trim() || !challenge.description.trim() ||
    !Number.isInteger(challenge.version) || challenge.version < 1
  );
  const authorized = new Map();
  for (const archive of readJson(files.archives, [])) for (const version of archive.versions || []) authorized.set(`public-archive/${archive.raceId}/v${version.version}/poster.pdf`, version.posterSha256);
  for (const certificate of readJson(files.certificates, [])) authorized.set(`certificates/${certificate.raceId}/${certificate.racerId}/v${certificate.version}.pdf`, certificate.sha256);
  const forbidden = aryFiles.filter(file => /\.part$/i.test(file.path) || file.path.includes("datasets/") || file.path.includes("submissions/") || (/\.pdf$/i.test(file.path) && !authorized.has(file.path)));
  const legacyDownloadFiles = organizerFiles.filter(file => file.path.includes("/datasets/") || /\/download-(policy|tickets)\.json$/.test(file.path));
  const aryRankingContent = aryFiles.filter(file => file.path !== "live-ranking-meta.json" && /live-ranking/i.test(file.path));
  const rankingMismatches = rankingMeta.filter(item => item.available && !item.stale && !item.frozen).filter(item => {
    const file = racePaths(item.raceId).liveRanking;
    return !fs.existsSync(file) || sha256File(file) !== item.sha256;
  });
  const longTermMismatches = [...authorized].filter(([relative, hash]) => {
    const absolute = path.join(ARY, relative);
    return !fs.existsSync(absolute) || sha256File(absolute) !== hash;
  });
  const partials = organizerFiles.filter(file => file.path.toLowerCase().endsWith(".part"));
  const mismatches = metadata.filter(item => item.submissionHash).filter(item => {
    const expected = `races/${item.raceId}/submissions/${item.racerId}.pdf`;
    const file = organizerFiles.find(entry => entry.path === expected);
    return !file || file.sha256 !== item.submissionHash.slice(0, 16);
  });
  const receiptFiles = new Set(metadata.filter(item => item.submissionHash).map(item => `races/${item.raceId}/submissions/${item.racerId}.pdf`));
  const orphanSubmissions = organizerFiles.filter(file => /^races\/[^/]+\/submissions\/[^/]+\.pdf$/i.test(file.path) && !receiptFiles.has(file.path));
  return {
    passed: jsonStorageViolations.length === 0 && forbidden.length === 0 && longTermMismatches.length === 0 && legacyDownloadFiles.length === 0 && invalidChallenges.length === 0 && aryRankingContent.length === 0 && rankingMismatches.length === 0 && partials.length === 0 && mismatches.length === 0 && orphanSubmissions.length === 0,
    checkedAt: new Date().toISOString(),
    claims: [
      { name: "ARY JSON 存储字段符合白名单", passed: jsonStorageViolations.length === 0, evidence: jsonStorageViolations.length ? `发现越界字段：${jsonStorageViolations.join(", ")}` : "races、metadata、archives、certificates、challenges、ranking metadata 与审计索引均符合字段白名单" },
      { name: "ARY 仅保存授权长期 PDF", passed: forbidden.length === 0, evidence: forbidden.length ? `发现未授权文件：${forbidden.map(f => f.path).join(", ")}` : `已允许 ${authorized.size} 个公开归档或私人证书 PDF` },
      { name: "长期归档与证书哈希一致", passed: longTermMismatches.length === 0, evidence: longTermMismatches.length ? `不一致文件：${longTermMismatches.map(([file]) => file).join(", ")}` : `已验证 ${authorized.size} 个长期 PDF` },
      { name: "赛题仅以 ARY 结构化字段保存", passed: legacyDownloadFiles.length === 0 && invalidChallenges.length === 0, evidence: legacyDownloadFiles.length ? `Organizer 仍有遗留下载文件：${legacyDownloadFiles.map(file => file.path).join(", ")}` : invalidChallenges.length ? `发现 ${invalidChallenges.length} 条无效结构化赛题` : `已验证 ${challenges.length} 条结构化赛题，Organizer 无赛题文件或票据` },
      { name: "实时排名正文仅保存在 Organizer", passed: aryRankingContent.length === 0 && rankingMismatches.length === 0, evidence: aryRankingContent.length ? `ARY 发现排名正文：${aryRankingContent.map(file => file.path).join(", ")}` : rankingMismatches.length ? `排名哈希不一致：${rankingMismatches.map(item => item.raceId).join(", ")}` : `已验证 ${rankingMeta.filter(item => item.available && !item.stale && !item.frozen).length} 个活跃实时排名文件，${rankingMeta.filter(item => item.frozen).length} 个已停止投影` },
      { name: "Organizer 无失败提交残留", passed: partials.length === 0, evidence: partials.length ? `发现临时文件：${partials.map(f => f.path).join(", ")}` : "所有赛事目录均无 .part 临时文件" },
      { name: "全部提交回执与 Organizer 文件一致", passed: mismatches.length === 0, evidence: mismatches.length ? `不匹配赛事：${mismatches.map(m => m.raceId).join(", ")}` : `已验证 ${metadata.filter(m => m.submissionHash).length} 个当前提交` },
      { name: "Organizer 提交文件均有 ARY 回执", passed: orphanSubmissions.length === 0, evidence: orphanSubmissions.length ? `发现孤立提交：${orphanSubmissions.map(file => file.path).join(", ")}` : "Organizer submissions 中不存在无回执 PDF" }
    ],
    organizerFiles, aryFiles
  };
}
function posterSvg(title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#081426"/><circle cx="980" cy="110" r="220" fill="#10b981" opacity=".14"/><text x="80" y="105" fill="#55d6be" font-size="28" font-family="Arial">AGENT RACING YARD · PUBLIC ARCHIVE</text><text x="80" y="250" fill="white" font-size="64" font-weight="700" font-family="Arial">${title}</text><text x="80" y="330" fill="#b9c9dc" font-size="32" font-family="Arial">控制面与数据面分离 · 多赛事独立管理</text></svg>`;
}
function raceView(race, racerId = DEFAULT_RACER_ID) {
  const paths = racePaths(race.raceId);
  const participants = readJson(files.participations, []).filter(item => item.raceId === race.raceId);
  const raceMetadata = Object.values(readJson(files.metadata, {})).filter(item => item.raceId === race.raceId);
  const submissionCount = raceMetadata.filter(item => item.submissionStatus === "submitted").length;
  const metadata = getMetadata(race.raceId, racerId);
  const manifest = readJson(paths.manifest, {});
  manifest.disclosure = {
    ...(manifest.disclosure || {}),
    title: race.title,
    summary: race.summary,
    timeline: timelineText(race)
  };
  const archive = archiveRecord(race.raceId), certificates = readJson(files.certificates, []).filter(item => item.raceId === race.raceId), challenge = getChallenge(race.raceId), liveRanking = liveRankingView(liveRankingCache.get(race.raceId));
  return { ...race, status: raceStatus(race), manifest, challenge, challengeConfigured: Boolean(challenge), liveRanking, archivePosterUploaded: fs.existsSync(paths.archivePoster), participantCount: participants.length, submissionCount, metadata, archive, certificateCount: certificates.length, racerCertificate: certificates.filter(item => item.racerId === racerId).at(-1) || null };
}
function roleState(role, context = {}) {
  const racerId = normalizeRacerId(context.racerId);
  const races = readJson(files.races, []).map(race => raceView(race, racerId));
  if (role === "ary") return { races, liveRankings: publicLiveRankings(), liveRankingMeta: readJson(files.liveRankingMeta, {}), audits: readJson(files.audit, []).slice(0, 30), proof: proof() };
  if (role === "organizer") return { races };
  if (role === "racer") return {
    racerId,
    races: races.map(race => {
      const joined = isJoined(race.raceId, racerId);
      const liveRanking = race.manifest.disclosure?.liveRankingVisible ? race.liveRanking : null;
      const myRanking = liveRanking?.rows?.find(row => row.racerId === racerId) || null;
      return { raceId: race.raceId, createdAt: race.createdAt, startsAt: race.startsAt, endsAt: race.endsAt, status: race.status, manifest: race.manifest, challengeConfigured: race.challengeConfigured, challenge: joined ? race.challenge : undefined, joined, metadata: race.metadata, liveRanking, myRanking };
    }),
    certificates: readJson(files.certificates, [])
      .filter(item => item.racerId === racerId)
      .map(item => ({ ...item, downloadUrl: `${item.downloadUrl}?racer=${encodeURIComponent(racerId)}` }))
  };
  return { archives: readJson(files.archives, []).map(latestArchive).filter(Boolean), liveRankings: publicLiveRankings() };
}

const roleRules = {
  ary: ["GET /api/state", "GET /api/live-rankings/events", "POST /api/proof/run", "POST /api/demo/reset"],
  organizer: ["GET /api/state", "POST /api/organizer/races"],
  racer: ["GET /api/state", "GET /api/live-rankings/events"],
  visitor: ["GET /api/state", "GET /api/live-rankings/events"]
};
function dynamicAllowed(role, method, p) {
  if (role === "ary") return /^\/api\/ary\/races\/[^/]+\/force-finish$/.test(p) || /^\/archive-assets\/[^/]+\/v\d+\/poster\.pdf$/.test(p);
  if (role === "organizer") return /^\/api\/organizer\/races\/[^/]+\/(challenge|disclosure|archive|archive-poster|extend|certificates-bulk)$/.test(p) || /^\/api\/organizer\/races\/[^/]+\/certificates\/[^/]+$/.test(p) || /^\/organizer\/races\/[^/]+\/poster\.svg$/.test(p);
  if (role === "racer") return /^\/api\/racer\/races\/[^/]+\/(join|submissions)$/.test(p) || /^\/racer-certificates\/[^/]+\/download$/.test(p);
  if (role === "visitor") return /^\/archive-assets\/[^/]+\/v\d+\/poster\.pdf$/.test(p);
  return false;
}
function serveStatic(res, pathname, role) {
  const target = pathname === "/" ? `${role}/index.html` : pathname.slice(1);
  if (!new Set(["styles.css", "common.js"]).has(target) && !target.startsWith(`${role}/`)) return false;
  const absolute = path.resolve(PUBLIC, target);
  if (!absolute.startsWith(PUBLIC) || !fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) return false;
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8" };
  res.writeHead(200, { "Content-Type": types[path.extname(absolute)] || "application/octet-stream" });
  fs.createReadStream(absolute).pipe(res); return true;
}

function createRoleServer(role) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`), p = url.pathname, rule = `${req.method} ${p}`;
    const protectedPath = p.startsWith("/api/") || p.startsWith("/organizer/races/") || p.startsWith("/archive-assets/") || p.startsWith("/racer-certificates/");
    if (protectedPath && !roleRules[role].includes(rule) && !dynamicAllowed(role, req.method, p)) return json(res, 403, { error: "role_forbidden", role });
    try {
      const requestRacerId = role === "racer" ? racerIdFromRequest(req, url) : DEFAULT_RACER_ID;
      if (req.method === "GET" && p === "/api/live-rankings/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "Connection": "keep-alive" });
        liveRankingClients.add(res); sendSse(res, "rankings", publicLiveRankings());
        req.on("close", () => liveRankingClients.delete(res)); return;
      }
      if (req.method === "GET" && p === "/api/state") return json(res, 200, roleState(role, { racerId: requestRacerId }));

      if (req.method === "POST" && p === "/api/organizer/races") {
        const input = JSON.parse((await body(req)).toString("utf8") || "{}");
        if (!String(input.title || "").trim()) return json(res, 400, { error: "title_required" });
        const times = validateRaceTimes(input.startsAt, input.endsAt);
        const raceId = `race-${crypto.randomUUID()}`, createdAt = new Date().toISOString(), paths = racePaths(raceId);
        for (const dir of [paths.root, paths.submissions]) fs.mkdirSync(dir, { recursive: true });
        const race = { raceId, organizerId: ORGANIZER_ID, title: String(input.title).trim(), summary: String(input.summary || ""), createdAt, ...times };
        const manifest = { raceId, version: 1, disclosure: { posterVisible: true, liveRankingVisible: Boolean(input.liveRankingVisible) }, archiveAllowed: true, archiveFields: ["title", "summary", "timeline", "poster", "rankingSummary"] };
        writeJson(paths.manifest, manifest);
        writeLiveRankingTemplate(race);
        const races = readJson(files.races, []); races.push(race); writeJson(files.races, races);
        loadLiveRanking(raceId, "LIVE_RANKING_TEMPLATE_CREATED");
        audit("Organizer", "RACE_CREATED", raceId, { title: manifest.disclosure.title });
        return json(res, 201, { ok: true, race: raceView(race) });
      }

      let match = p.match(/^\/api\/organizer\/races\/([^/]+)\/challenge$/);
      if (req.method === "PUT" && match) {
        const raceId = match[1], race = requireRace(raceId), input = JSON.parse((await body(req)).toString("utf8") || "{}");
        const title = String(input.title || "").trim(), description = String(input.description || "").trim();
        if (!title || !description) return json(res, 400, { error: "challenge_title_and_description_required" });
        const previous = getChallenge(raceId), challenge = {
          raceId,
          title,
          description,
          submissionRequirements: String(input.submissionRequirements || ""),
          evaluationCriteria: String(input.evaluationCriteria || ""),
          notes: String(input.notes || ""),
          version: (previous?.version || 0) + 1,
          updatedAt: new Date().toISOString(),
          updatedBy: ORGANIZER_ID
        };
        setChallenge(raceId, challenge); audit("Organizer", "CHALLENGE_UPDATED", raceId, { version: challenge.version });
        return json(res, 200, { ok: true, challenge, race: raceView(race) });
      }
      match = p.match(/^\/api\/organizer\/races\/([^/]+)\/disclosure$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], paths = racePaths(raceId), input = JSON.parse((await body(req)).toString("utf8") || "{}");
        requireRace(raceId);
        updateRace(raceId, item => ({
          ...item,
          title: String(input.title || item.title).trim(),
          summary: String(input.summary ?? item.summary)
        }));
        const manifest = readJson(paths.manifest, {});
        const previousLiveRankingVisible = Boolean(manifest.disclosure?.liveRankingVisible);
        const nextLiveRankingVisible = Boolean(input.liveRankingVisible);
        manifest.version += 1;
        manifest.disclosure = { ...manifest.disclosure, posterVisible: Boolean(input.posterVisible), liveRankingVisible: nextLiveRankingVisible };
        writeJson(paths.manifest, manifest);
        audit("Organizer", "DISCLOSURE_UPDATED", raceId, { version: manifest.version, liveRankingVisible: manifest.disclosure.liveRankingVisible });
        if (!nextLiveRankingVisible) clearLiveRankingProjection(raceId);
        else loadLiveRanking(raceId, previousLiveRankingVisible ? "LIVE_RANKING_DISCLOSURE_REFRESHED" : "LIVE_RANKING_DISCLOSURE_ENABLED", { resetVersionBaseline: !previousLiveRankingVisible || Boolean(liveRankingCache.get(raceId)?.stale) });
        broadcastLiveRankings();
        return json(res, 200, { ok: true, manifest });
      }
      match = p.match(/^\/api\/organizer\/races\/([^/]+)\/extend$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], race = requireRace(raceId), input = JSON.parse((await body(req)).toString("utf8") || "{}"), next = new Date(input.endsAt);
        if (!Number.isFinite(next.getTime())) return json(res, 400, { error: "invalid_race_time" });
        if (next.getTime() <= new Date(race.endsAt).getTime() || next.getTime() <= Date.now()) return json(res, 400, { error: "end_time_must_be_extended" });
        const updated = updateRace(raceId, item => ({ ...item, endsAt: next.toISOString() }));
        audit("Organizer", "RACE_END_EXTENDED", raceId, { previousEndsAt: race.endsAt, endsAt: updated.endsAt });
        return json(res, 200, { ok: true, race: raceView(updated) });
      }
      match = p.match(/^\/organizer\/races\/([^/]+)\/poster\.svg$/);
      if (req.method === "GET" && match) {
        const race = requireRace(match[1]), manifest = readJson(racePaths(match[1]).manifest, null); if (!manifest || !manifest.disclosure.posterVisible) return text(res, 404, "poster unavailable");
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" }); return res.end(posterSvg(race.title));
      }
      match = p.match(/^\/api\/ary\/races\/([^/]+)\/force-finish$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], race = requireRace(raceId), previousStatus = raceStatus(race);
        if (previousStatus !== "open") return json(res, 409, { error: "race_not_running" });
        const operator = String(req.headers["x-operator"] || "Admin").trim() || "Admin";
        const timestamp = new Date().toISOString();
        const frozen = freezeLiveRanking(raceId);
        const updated = updateRace(raceId, item => ({ ...item, endsAt: timestamp, forceFinishedAt: timestamp, forceFinishedBy: operator }));
        audit(operator, "force_finish_race", raceId, { action: "force_finish_race", race_id: raceId, operator, timestamp, previousStatus, projectionStopped: true, frozenRankingVersion: frozen?.version || null, organizerNotified: false });
        broadcastLiveRankings();
        return json(res, 200, { ok: true, race: raceView(updated), liveRankings: publicLiveRankings(), audit: { action: "force_finish_race", race_id: raceId, operator, timestamp } });
      }
      match = p.match(/^\/api\/racer\/races\/([^/]+)\/join$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], race = requireRace(raceId); assertRaceOpen(race);
        const participations = readJson(files.participations, []);
        if (!isJoined(raceId, requestRacerId)) { participations.push({ raceId, racerId: requestRacerId, joinedAt: new Date().toISOString() }); writeJson(files.participations, participations); setMetadata(raceId, getMetadata(raceId, requestRacerId), requestRacerId); audit("Racer", "RACE_JOINED", raceId, { racerId: requestRacerId }); }
        return json(res, 200, { ok: true, racerId: requestRacerId });
      }
      match = p.match(/^\/api\/racer\/races\/([^/]+)\/submissions$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], paths = racePaths(raceId), race = requireRace(raceId); assertRaceOpen(race);
        if (!isJoined(raceId, requestRacerId)) return json(res, 403, { error: "race_participation_required" });
        const info = validatePdfRequest(req), final = path.join(paths.submissions, `${requestRacerId}.pdf`), result = await receivePdf(req, path.join(paths.submissions, `.${requestRacerId}.part`), final);
        const previous = getMetadata(raceId, requestRacerId), metadata = { raceId, racerId: requestRacerId, submissionStatus: "submitted", receiptId: `receipt-${crypto.randomUUID()}`, submissionHash: result.hash, submissionFileName: info.fileName, submissionSize: result.size, submittedAt: new Date().toISOString() };
        setMetadata(raceId, metadata, requestRacerId); audit("Racer", previous.submissionStatus === "submitted" ? "SUBMISSION_REPLACED" : "SUBMISSION_COMPLETED", raceId, { racerId: requestRacerId, receiptId: metadata.receiptId, aryPersistedBytes: 0 });
        return json(res, 200, { ok: true, racerId: requestRacerId, receiptId: metadata.receiptId, sha256: result.hash, owner: "Organizer", aryPersistedBytes: 0, fileName: info.fileName, size: result.size });
      }
      match = p.match(/^\/api\/organizer\/races\/([^/]+)\/archive$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], race = requireRace(raceId), paths = racePaths(raceId);
        if (raceStatus(race) !== "ended") return json(res, 409, { error: "race_not_ended" });
        if (!fs.existsSync(paths.archivePoster)) return json(res, 409, { error: "archive_poster_required" });
        const input = JSON.parse((await body(req)).toString("utf8") || "{}"), structured = validateArchiveInput(input);
        const archives = readJson(files.archives, []), index = archives.findIndex(item => item.raceId === raceId);
        const record = index < 0 ? { raceId, currentVersion: 0, versions: [] } : archives[index], version = record.currentVersion + 1;
        const archiveDir = path.join(ARCHIVE, raceId, `v${version}`), poster = path.join(archiveDir, "poster.pdf");
        fs.mkdirSync(archiveDir, { recursive: true }); fs.copyFileSync(paths.archivePoster, poster);
        const publishedAt = new Date().toISOString(), consentHash = crypto.createHash("sha256").update(JSON.stringify({ raceId, version, organizerId: race.organizerId, ...structured })).digest("hex");
        const snapshot = { raceId, version, title: race.title, summary: race.summary, startsAt: race.startsAt, endsAt: race.endsAt, timeline: timelineText(race), posterUrl: `/archive-assets/${raceId}/v${version}/poster.pdf`, posterSha256: sha256File(poster), results: structured.results, showcases: structured.showcases, organizerId: race.organizerId, publishedAt, consentHash };
        record.currentVersion = version; record.versions.push(snapshot); index < 0 ? archives.push(record) : archives[index] = record; writeJson(files.archives, archives);
        audit("Organizer", "PUBLIC_ARCHIVE_VERSION_PUBLISHED", raceId, { version, posterSha256: snapshot.posterSha256, consentHash }); return json(res, 200, { ok: true, archive: snapshot });
      }
      match = p.match(/^\/api\/organizer\/races\/([^/]+)\/archive-poster$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], race = requireRace(raceId), paths = racePaths(raceId); validatePdfRequest(req);
        if (raceStatus(race) !== "ended") return json(res, 409, { error: "race_not_ended" });
        const result = await receivePdf(req, path.join(paths.archive, ".poster.part"), paths.archivePoster);
        audit("Organizer", "ARCHIVE_POSTER_STAGED", raceId, { sha256: result.hash, size: result.size }); return json(res, 200, { ok: true, sha256: result.hash, size: result.size });
      }
      match = p.match(/^\/api\/organizer\/races\/([^/]+)\/certificates\/([^/]+)$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], racerId = match[2], race = requireRace(raceId); validatePdfRequest(req);
        if (raceStatus(race) !== "ended") return json(res, 409, { error: "race_not_ended" });
        const pdf = await body(req), certificate = storeCertificateBuffer(raceId, normalizeRacerId(racerId), pdf);
        audit("Organizer", "PRIVATE_CERTIFICATE_UPLOADED", raceId, { racerId: certificate.racerId, version: certificate.version, sha256: certificate.sha256 }); return json(res, 200, { ok: true, certificate });
      }
      match = p.match(/^\/api\/organizer\/races\/([^/]+)\/certificates-bulk$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], race = requireRace(raceId); validateZipRequest(req);
        if (raceStatus(race) !== "ended") return json(res, 409, { error: "race_not_ended" });
        const zipBuffer = await body(req, MAX_ZIP_SIZE), entries = parseCertificateZip(zipBuffer), certificates = [];
        for (const entry of entries) certificates.push(storeCertificateBuffer(raceId, entry.racerId, entry.bytes));
        audit("Organizer", "PRIVATE_CERTIFICATES_BULK_UPLOADED", raceId, { count: certificates.length, racerIds: certificates.map(item => item.racerId) });
        return json(res, 200, { ok: true, certificates });
      }
      match = p.match(/^\/archive-assets\/([^/]+)\/v(\d+)\/poster\.pdf$/);
      if (req.method === "GET" && match) {
        const record = archiveRecord(match[1]), version = Number(match[2]);
        if (!record?.versions?.some(item => item.version === version) || (role === "visitor" && record.currentVersion !== version)) return text(res, 404, "archive not published");
        const poster = path.join(ARCHIVE, match[1], `v${version}`, "poster.pdf");
        res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": fs.statSync(poster).size, "Cache-Control": "public, max-age=3600" }); return fs.createReadStream(poster).pipe(res);
      }
      match = p.match(/^\/racer-certificates\/([^/]+)\/download$/);
      if (req.method === "GET" && match) {
        const certificate = readJson(files.certificates, []).find(item => item.certificateId === match[1]);
        if (!certificate || certificate.racerId !== requestRacerId) return json(res, 404, { error: "certificate_not_found" });
        const file = path.join(CERTIFICATES, certificate.raceId, certificate.racerId, `v${certificate.version}.pdf`);
        res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": fs.statSync(file).size, "Content-Disposition": `attachment; filename="${certificate.raceId}-${certificate.racerId}-certificate-v${certificate.version}.pdf"` }); return fs.createReadStream(file).pipe(res);
      }
      if (req.method === "POST" && p === "/api/proof/run") { const result = proof(); audit("ARY", "SECURITY_PROOF_EXECUTED", "all-races", { passed: result.passed }); return json(res, 200, result); }
      if (req.method === "POST" && p === "/api/demo/reset") {
        clearDir(RACES); clearDir(ARCHIVE); clearDir(CERTIFICATES); liveRankingCache.clear(); rankingFileStats.clear(); writeJson(files.races, []); writeJson(files.participations, []); writeJson(files.metadata, {}); writeJson(files.audit, []); writeJson(files.archives, []); writeJson(files.certificates, []); writeJson(files.challenges, {}); writeJson(files.liveRankingMeta, {}); broadcastLiveRankings(); return json(res, 200, { ok: true });
      }
      if (serveStatic(res, p, role)) return;
      json(res, 404, { error: "not_found" });
    } catch (error) { json(res, error.statusCode || 400, { error: error.message }); }
  });
}

for (const [role, port] of Object.entries(PORTS)) createRoleServer(role).listen(port, HOST, () => console.log(`${role.toUpperCase()} UI running at http://${HOST}:${port}`));
setInterval(() => {
  for (const client of liveRankingClients) {
    try { client.write(": heartbeat\n\n"); } catch { liveRankingClients.delete(client); }
  }
  broadcastLiveRankings();
}, 3000);
setInterval(scanLiveRankingChanges, 1500);
