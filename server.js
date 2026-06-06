const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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
const RACER_ID = "racer-001";
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
  challenges: path.join(ARY, "challenges.json")
};

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return fallback; }
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
  migrateRaceTimes();
  removeLegacyDownloadData();
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
      if (manifest?.disclosure) {
        manifest.disclosure.timeline = timelineText(race);
        writeJson(paths.manifest, manifest);
      }
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
init();

function racePaths(raceId) {
  const root = path.join(RACES, raceId);
  return {
    root,
    submissions: path.join(root, "submissions"),
    archive: path.join(root, "archive"),
    archivePoster: path.join(root, "archive", "poster.pdf"),
    manifest: path.join(root, "manifest.json")
  };
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
function sha256File(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function latestArchive(record) {
  return record?.versions?.find(version => version.version === record.currentVersion) || record?.versions?.at(-1) || null;
}
function archiveRecord(raceId) { return readJson(files.archives, []).find(item => item.raceId === raceId) || null; }
function validateArchiveInput(input) {
  if (!Array.isArray(input.results) || input.results.length === 0) { const e = new Error("final_ranking_required"); e.statusCode = 400; throw e; }
  const results = input.results.map(item => {
    const rank = Number(item.rank), score = Number(item.score), racerId = String(item.racerId || "").trim();
    if (!Number.isInteger(rank) || rank < 1 || !racerId || !Number.isFinite(score)) { const e = new Error("invalid_final_ranking"); e.statusCode = 400; throw e; }
    return { rank, racerId, score, award: String(item.award || ""), comment: String(item.comment || "") };
  });
  const showcases = Array.isArray(input.showcases) ? input.showcases.map(item => {
    const demoUrl = String(item.demoUrl || "").trim();
    if (demoUrl) { try { new URL(demoUrl); } catch { const e = new Error("invalid_showcase_url"); e.statusCode = 400; throw e; } }
    return { title: String(item.title || ""), summary: String(item.summary || ""), demoUrl };
  }) : [];
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
function metadataKey(raceId, racerId = RACER_ID) { return `${raceId}:${racerId}`; }
function getMetadata(raceId, racerId = RACER_ID) {
  return readJson(files.metadata, {})[metadataKey(raceId, racerId)] || {
    raceId, racerId, submissionStatus: "not_submitted", receiptId: null, review: null
  };
}
function setMetadata(raceId, value, racerId = RACER_ID) {
  const all = readJson(files.metadata, {});
  all[metadataKey(raceId, racerId)] = value;
  writeJson(files.metadata, all);
}
function isJoined(raceId, racerId = RACER_ID) {
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
function listFiles(dir, prefix = "") {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(prefix, entry.name), absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(absolute, relative);
    const stat = fs.statSync(absolute);
    return [{ path: relative.replaceAll("\\", "/"), size: stat.size, sha256: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex").slice(0, 16) }];
  });
}
function proof() {
  const organizerFiles = listFiles(ORGANIZER);
  const aryFiles = listFiles(ARY);
  const metadata = Object.values(readJson(files.metadata, {}));
  const challenges = Object.values(readJson(files.challenges, {}));
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
  return {
    passed: forbidden.length === 0 && longTermMismatches.length === 0 && legacyDownloadFiles.length === 0 && invalidChallenges.length === 0 && partials.length === 0 && mismatches.length === 0,
    checkedAt: new Date().toISOString(),
    claims: [
      { name: "ARY 仅保存授权长期 PDF", passed: forbidden.length === 0, evidence: forbidden.length ? `发现未授权文件：${forbidden.map(f => f.path).join(", ")}` : `已允许 ${authorized.size} 个公开归档或私人证书 PDF` },
      { name: "长期归档与证书哈希一致", passed: longTermMismatches.length === 0, evidence: longTermMismatches.length ? `不一致文件：${longTermMismatches.map(([file]) => file).join(", ")}` : `已验证 ${authorized.size} 个长期 PDF` },
      { name: "赛题仅以 ARY 结构化字段保存", passed: legacyDownloadFiles.length === 0 && invalidChallenges.length === 0, evidence: legacyDownloadFiles.length ? `Organizer 仍有遗留下载文件：${legacyDownloadFiles.map(file => file.path).join(", ")}` : invalidChallenges.length ? `发现 ${invalidChallenges.length} 条无效结构化赛题` : `已验证 ${challenges.length} 条结构化赛题，Organizer 无赛题文件或票据` },
      { name: "Organizer 无失败提交残留", passed: partials.length === 0, evidence: partials.length ? `发现临时文件：${partials.map(f => f.path).join(", ")}` : "所有赛事目录均无 .part 临时文件" },
      { name: "全部提交回执与 Organizer 文件一致", passed: mismatches.length === 0, evidence: mismatches.length ? `不匹配赛事：${mismatches.map(m => m.raceId).join(", ")}` : `已验证 ${metadata.filter(m => m.submissionHash).length} 个当前提交` }
    ],
    organizerFiles, aryFiles
  };
}
function posterSvg(title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#081426"/><circle cx="980" cy="110" r="220" fill="#10b981" opacity=".14"/><text x="80" y="105" fill="#55d6be" font-size="28" font-family="Arial">AGENT RACING YARD · PUBLIC ARCHIVE</text><text x="80" y="250" fill="white" font-size="64" font-weight="700" font-family="Arial">${title}</text><text x="80" y="330" fill="#b9c9dc" font-size="32" font-family="Arial">控制面与数据面分离 · 多赛事独立管理</text></svg>`;
}
function raceView(race) {
  const paths = racePaths(race.raceId);
  const participants = readJson(files.participations, []).filter(item => item.raceId === race.raceId);
  const metadata = getMetadata(race.raceId);
  const manifest = readJson(paths.manifest, {});
  if (manifest.disclosure) manifest.disclosure.timeline = timelineText(race);
  const archive = archiveRecord(race.raceId), certificates = readJson(files.certificates, []).filter(item => item.raceId === race.raceId), challenge = getChallenge(race.raceId);
  return { ...race, status: raceStatus(race), manifest, challenge, challengeConfigured: Boolean(challenge), archivePosterUploaded: fs.existsSync(paths.archivePoster), participantCount: participants.length, metadata, archive, certificateCount: certificates.length, racerCertificate: certificates.filter(item => item.racerId === RACER_ID).at(-1) || null };
}
function roleState(role) {
  const races = readJson(files.races, []).map(raceView);
  if (role === "ary") return { races, audits: readJson(files.audit, []).slice(0, 30), proof: proof() };
  if (role === "organizer") return { races };
  if (role === "racer") return { races: races.map(race => { const joined = isJoined(race.raceId); return { raceId: race.raceId, createdAt: race.createdAt, startsAt: race.startsAt, endsAt: race.endsAt, status: race.status, manifest: race.manifest, challengeConfigured: race.challengeConfigured, challenge: joined ? race.challenge : undefined, joined, metadata: race.metadata }; }), certificates: readJson(files.certificates, []).filter(item => item.racerId === RACER_ID) };
  return { archives: readJson(files.archives, []).map(latestArchive).filter(Boolean) };
}

const roleRules = {
  ary: ["GET /api/state", "POST /api/proof/run", "POST /api/demo/reset"],
  organizer: ["GET /api/state", "POST /api/organizer/races"],
  racer: ["GET /api/state"],
  visitor: ["GET /api/state"]
};
function dynamicAllowed(role, method, p) {
  if (role === "organizer") return /^\/api\/organizer\/races\/[^/]+\/(challenge|disclosure|review|archive|archive-poster|extend)$/.test(p) || /^\/api\/organizer\/races\/[^/]+\/certificates\/[^/]+$/.test(p) || /^\/organizer\/races\/[^/]+\/poster\.svg$/.test(p);
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
      if (req.method === "GET" && p === "/api/state") return json(res, 200, roleState(role));

      if (req.method === "POST" && p === "/api/organizer/races") {
        const input = JSON.parse((await body(req)).toString("utf8") || "{}");
        if (!String(input.title || "").trim()) return json(res, 400, { error: "title_required" });
        const times = validateRaceTimes(input.startsAt, input.endsAt);
        const raceId = `race-${crypto.randomUUID()}`, createdAt = new Date().toISOString(), paths = racePaths(raceId);
        for (const dir of [paths.root, paths.submissions]) fs.mkdirSync(dir, { recursive: true });
        const race = { raceId, organizerId: ORGANIZER_ID, createdAt, ...times };
        const manifest = { raceId, version: 1, disclosure: { title: String(input.title).trim(), summary: String(input.summary || ""), timeline: timelineText(race), posterVisible: true }, archiveAllowed: true, archiveFields: ["title", "summary", "timeline", "poster", "rankingSummary"] };
        writeJson(paths.manifest, manifest);
        const races = readJson(files.races, []); races.push(race); writeJson(files.races, races);
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
        const raceId = match[1], paths = racePaths(raceId), input = JSON.parse((await body(req)).toString("utf8") || "{}"); requireRace(raceId);
        const manifest = readJson(paths.manifest, {}); manifest.version += 1; manifest.disclosure = { ...manifest.disclosure, title: String(input.title || manifest.disclosure.title), summary: String(input.summary ?? manifest.disclosure.summary), timeline: timelineText(requireRace(raceId)), posterVisible: Boolean(input.posterVisible) };
        writeJson(paths.manifest, manifest); audit("Organizer", "DISCLOSURE_UPDATED", raceId, { version: manifest.version }); return json(res, 200, { ok: true, manifest });
      }
      match = p.match(/^\/api\/organizer\/races\/([^/]+)\/extend$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], race = requireRace(raceId), input = JSON.parse((await body(req)).toString("utf8") || "{}"), next = new Date(input.endsAt);
        if (!Number.isFinite(next.getTime())) return json(res, 400, { error: "invalid_race_time" });
        if (next.getTime() <= new Date(race.endsAt).getTime() || next.getTime() <= Date.now()) return json(res, 400, { error: "end_time_must_be_extended" });
        const updated = updateRace(raceId, item => ({ ...item, endsAt: next.toISOString() }));
        const paths = racePaths(raceId), manifest = readJson(paths.manifest, {}); manifest.disclosure.timeline = timelineText(updated); writeJson(paths.manifest, manifest);
        audit("Organizer", "RACE_END_EXTENDED", raceId, { previousEndsAt: race.endsAt, endsAt: updated.endsAt });
        return json(res, 200, { ok: true, race: raceView(updated) });
      }
      match = p.match(/^\/organizer\/races\/([^/]+)\/poster\.svg$/);
      if (req.method === "GET" && match) {
        const manifest = readJson(racePaths(match[1]).manifest, null); if (!manifest || !manifest.disclosure.posterVisible) return text(res, 404, "poster unavailable");
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" }); return res.end(posterSvg(manifest.disclosure.title));
      }
      match = p.match(/^\/api\/racer\/races\/([^/]+)\/join$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], race = requireRace(raceId); assertRaceOpen(race);
        const participations = readJson(files.participations, []);
        if (!isJoined(raceId)) { participations.push({ raceId, racerId: RACER_ID, joinedAt: new Date().toISOString() }); writeJson(files.participations, participations); setMetadata(raceId, getMetadata(raceId)); audit("Racer", "RACE_JOINED", raceId, { racerId: RACER_ID }); }
        return json(res, 200, { ok: true });
      }
      match = p.match(/^\/api\/racer\/races\/([^/]+)\/submissions$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], paths = racePaths(raceId), race = requireRace(raceId); assertRaceOpen(race);
        if (String(req.headers["x-racer-id"] || "") !== RACER_ID) return json(res, 403, { error: "racer_not_allowed" });
        if (!isJoined(raceId)) return json(res, 403, { error: "race_participation_required" });
        const info = validatePdfRequest(req), final = path.join(paths.submissions, `${RACER_ID}.pdf`), result = await receivePdf(req, path.join(paths.submissions, `.${RACER_ID}.part`), final);
        const previous = getMetadata(raceId), metadata = { raceId, racerId: RACER_ID, submissionStatus: "submitted", receiptId: `receipt-${crypto.randomUUID()}`, review: null, submissionHash: result.hash, submissionFileName: info.fileName, submissionSize: result.size, submittedAt: new Date().toISOString() };
        setMetadata(raceId, metadata); audit("Racer", previous.submissionStatus === "submitted" ? "SUBMISSION_REPLACED" : "SUBMISSION_COMPLETED", raceId, { receiptId: metadata.receiptId, aryPersistedBytes: 0 });
        return json(res, 200, { ok: true, receiptId: metadata.receiptId, sha256: result.hash, owner: "Organizer", aryPersistedBytes: 0, fileName: info.fileName, size: result.size });
      }
      match = p.match(/^\/api\/organizer\/races\/([^/]+)\/review$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], input = JSON.parse((await body(req)).toString("utf8") || "{}"), metadata = getMetadata(raceId); requireRace(raceId);
        if (metadata.submissionStatus !== "submitted") return json(res, 409, { error: "no_submission" });
        metadata.review = { score: Number(input.score || 0), comment: String(input.comment || ""), reviewedAt: new Date().toISOString(), reviewedBy: "Organizer" }; setMetadata(raceId, metadata); audit("Organizer", "SUBMISSION_REVIEWED", raceId, { score: metadata.review.score }); return json(res, 200, { ok: true, review: metadata.review });
      }
      match = p.match(/^\/api\/organizer\/races\/([^/]+)\/archive$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], race = requireRace(raceId), paths = racePaths(raceId), manifest = readJson(paths.manifest, {});
        if (raceStatus(race) !== "ended") return json(res, 409, { error: "race_not_ended" });
        if (!fs.existsSync(paths.archivePoster)) return json(res, 409, { error: "archive_poster_required" });
        const input = JSON.parse((await body(req)).toString("utf8") || "{}"), structured = validateArchiveInput(input);
        const archives = readJson(files.archives, []), index = archives.findIndex(item => item.raceId === raceId);
        const record = index < 0 ? { raceId, currentVersion: 0, versions: [] } : archives[index], version = record.currentVersion + 1;
        const archiveDir = path.join(ARCHIVE, raceId, `v${version}`), poster = path.join(archiveDir, "poster.pdf");
        fs.mkdirSync(archiveDir, { recursive: true }); fs.copyFileSync(paths.archivePoster, poster);
        const publishedAt = new Date().toISOString(), consentHash = crypto.createHash("sha256").update(JSON.stringify({ raceId, version, organizerId: race.organizerId, ...structured })).digest("hex");
        const snapshot = { raceId, version, title: manifest.disclosure.title, summary: manifest.disclosure.summary, startsAt: race.startsAt, endsAt: race.endsAt, timeline: timelineText(race), posterUrl: `/archive-assets/${raceId}/v${version}/poster.pdf`, posterSha256: sha256File(poster), results: structured.results, showcases: structured.showcases, organizerId: race.organizerId, publishedAt, consentHash };
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
        if (!isJoined(raceId, racerId)) return json(res, 409, { error: "race_participation_required" });
        const certificates = readJson(files.certificates, []), previous = certificates.filter(item => item.raceId === raceId && item.racerId === racerId), version = previous.length + 1;
        const dir = path.join(CERTIFICATES, raceId, racerId), final = path.join(dir, `v${version}.pdf`), result = await receivePdf(req, path.join(dir, `.v${version}.part`), final);
        const certificateId = `certificate-${crypto.randomUUID()}`;
        const certificate = { certificateId, raceId, racerId, version, sha256: result.hash, size: result.size, uploadedAt: new Date().toISOString(), downloadUrl: `/racer-certificates/${certificateId}/download` };
        certificates.push(certificate); writeJson(files.certificates, certificates);
        audit("Organizer", "PRIVATE_CERTIFICATE_UPLOADED", raceId, { racerId, version, sha256: result.hash }); return json(res, 200, { ok: true, certificate });
      }
      match = p.match(/^\/archive-assets\/([^/]+)\/v(\d+)\/poster\.pdf$/);
      if (req.method === "GET" && match) {
        const record = archiveRecord(match[1]), version = Number(match[2]);
        if (!record?.versions?.some(item => item.version === version)) return text(res, 404, "archive not published");
        const poster = path.join(ARCHIVE, match[1], `v${version}`, "poster.pdf");
        res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": fs.statSync(poster).size, "Cache-Control": "public, max-age=3600" }); return fs.createReadStream(poster).pipe(res);
      }
      match = p.match(/^\/racer-certificates\/([^/]+)\/download$/);
      if (req.method === "GET" && match) {
        const certificate = readJson(files.certificates, []).find(item => item.certificateId === match[1]);
        if (!certificate || certificate.racerId !== RACER_ID) return json(res, 404, { error: "certificate_not_found" });
        const file = path.join(CERTIFICATES, certificate.raceId, certificate.racerId, `v${certificate.version}.pdf`);
        res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": fs.statSync(file).size, "Content-Disposition": `attachment; filename="${certificate.raceId}-${certificate.racerId}-certificate-v${certificate.version}.pdf"` }); return fs.createReadStream(file).pipe(res);
      }
      if (req.method === "POST" && p === "/api/proof/run") { const result = proof(); audit("ARY", "SECURITY_PROOF_EXECUTED", "all-races", { passed: result.passed }); return json(res, 200, result); }
      if (req.method === "POST" && p === "/api/demo/reset") {
        clearDir(RACES); clearDir(ARCHIVE); clearDir(CERTIFICATES); writeJson(files.races, []); writeJson(files.participations, []); writeJson(files.metadata, {}); writeJson(files.audit, []); writeJson(files.archives, []); writeJson(files.certificates, []); writeJson(files.challenges, {}); return json(res, 200, { ok: true });
      }
      if (serveStatic(res, p, role)) return;
      json(res, 404, { error: "not_found" });
    } catch (error) { json(res, error.statusCode || 400, { error: error.message }); }
  });
}

for (const [role, port] of Object.entries(PORTS)) createRoleServer(role).listen(port, HOST, () => console.log(`${role.toUpperCase()} UI running at http://${HOST}:${port}`));
