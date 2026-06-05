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
const SECRET = "ary-poc-local-secret";
const MAX_FILE_SIZE = 16 * 1024 * 1024;
const RACER_ID = "racer-001";
const ORGANIZER_ID = "organizer-001";
const SERVER_TIME_ZONE = "Asia/Shanghai";

for (const dir of [ORGANIZER, RACES, ARY, ARCHIVE]) fs.mkdirSync(dir, { recursive: true });

const files = {
  races: path.join(ARY, "races.json"),
  participations: path.join(ARY, "participations.json"),
  metadata: path.join(ARY, "metadata.json"),
  audit: path.join(ARY, "audit.json"),
  archives: path.join(ARY, "archives.json")
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
  migrateRaceTimes();
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
  if (start.getTime() < now.getTime() - 30000) {
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
    if (archive && (!archive.startsAt || !archive.endsAt)) {
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
    datasets: path.join(root, "datasets"),
    dataset: path.join(root, "datasets", "challenge.pdf"),
    submissions: path.join(root, "submissions"),
    manifest: path.join(root, "manifest.json"),
    policy: path.join(root, "download-policy.json"),
    tickets: path.join(root, "download-tickets.json")
  };
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
function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}
function token(payload, ttlSeconds = 300) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyToken(value, action) {
  if (!value || !value.includes(".")) throw new Error("invalid_token");
  const [body, sig] = value.split(".");
  const expected = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new Error("invalid_signature");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (payload.action !== action) throw new Error("invalid_action");
  return payload;
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
  const forbidden = aryFiles.filter(file => /\.(pdf|part)$/i.test(file.path) || file.path.includes("datasets/") || file.path.includes("submissions/"));
  const partials = organizerFiles.filter(file => file.path.toLowerCase().endsWith(".part"));
  const mismatches = metadata.filter(item => item.submissionHash).filter(item => {
    const expected = `races/${item.raceId}/submissions/${item.racerId}.pdf`;
    const file = organizerFiles.find(entry => entry.path === expected);
    return !file || file.sha256 !== item.submissionHash.slice(0, 16);
  });
  return {
    passed: forbidden.length === 0 && partials.length === 0 && mismatches.length === 0,
    checkedAt: new Date().toISOString(),
    claims: [
      { name: "ARY 不持久化 PDF 或临时分块", passed: forbidden.length === 0, evidence: forbidden.length ? `发现异常文件：${forbidden.map(f => f.path).join(", ")}` : "ARY Storage 未发现 PDF、提交目录或 .part 文件" },
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
  return { ...race, status: raceStatus(race), manifest, datasetUploaded: fs.existsSync(paths.dataset), participantCount: participants.length, metadata, downloadPolicy: readJson(paths.policy, { enabled: true }), tickets: readJson(paths.tickets, []).slice(-10).reverse(), archive: readJson(files.archives, []).find(a => a.raceId === race.raceId) || null };
}
function roleState(role) {
  const races = readJson(files.races, []).map(raceView);
  if (role === "ary") return { races, audits: readJson(files.audit, []).slice(0, 30), proof: proof() };
  if (role === "organizer") return { races };
  if (role === "racer") return { races: races.map(race => ({ raceId: race.raceId, createdAt: race.createdAt, startsAt: race.startsAt, endsAt: race.endsAt, status: race.status, manifest: race.manifest, datasetUploaded: race.datasetUploaded, joined: isJoined(race.raceId), metadata: race.metadata })) };
  return { archives: readJson(files.archives, []) };
}

const roleRules = {
  ary: ["GET /api/state", "POST /api/proof/run", "POST /api/demo/reset"],
  organizer: ["GET /api/state", "POST /api/organizer/races"],
  racer: ["GET /api/state"],
  visitor: ["GET /api/state"]
};
function dynamicAllowed(role, method, p) {
  if (role === "organizer") return /^\/api\/organizer\/races\/[^/]+\/(dataset|disclosure|download-permission|review|archive|extend)$/.test(p) || /^\/organizer\/races\/[^/]+\/(poster\.svg|download)$/.test(p);
  if (role === "racer") return /^\/api\/racer\/races\/[^/]+\/(join|download-url|submissions)$/.test(p);
  if (role === "visitor") return /^\/archive-assets\/[^/]+\/poster\.svg$/.test(p);
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
    const protectedPath = p.startsWith("/api/") || p.startsWith("/organizer/races/") || p.startsWith("/archive-assets/");
    if (protectedPath && !roleRules[role].includes(rule) && !dynamicAllowed(role, req.method, p)) return json(res, 403, { error: "role_forbidden", role });
    try {
      if (req.method === "GET" && p === "/api/state") return json(res, 200, roleState(role));

      if (req.method === "POST" && p === "/api/organizer/races") {
        const input = JSON.parse((await body(req)).toString("utf8") || "{}");
        if (!String(input.title || "").trim()) return json(res, 400, { error: "title_required" });
        const times = validateRaceTimes(input.startsAt, input.endsAt);
        const raceId = `race-${crypto.randomUUID()}`, createdAt = new Date().toISOString(), paths = racePaths(raceId);
        for (const dir of [paths.root, paths.datasets, paths.submissions]) fs.mkdirSync(dir, { recursive: true });
        const race = { raceId, organizerId: ORGANIZER_ID, createdAt, ...times };
        const manifest = { raceId, version: 1, disclosure: { title: String(input.title).trim(), summary: String(input.summary || ""), timeline: timelineText(race), posterVisible: true }, archiveAllowed: true, archiveFields: ["title", "summary", "timeline", "poster", "rankingSummary"] };
        writeJson(paths.manifest, manifest); writeJson(paths.policy, { enabled: true, updatedAt: createdAt, updatedBy: "Organizer" }); writeJson(paths.tickets, []);
        const races = readJson(files.races, []); races.push(race); writeJson(files.races, races);
        audit("Organizer", "RACE_CREATED", raceId, { title: manifest.disclosure.title });
        return json(res, 201, { ok: true, race: raceView(race) });
      }

      let match = p.match(/^\/api\/organizer\/races\/([^/]+)\/dataset$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], race = requireRace(raceId), paths = racePaths(raceId), info = validatePdfRequest(req);
        const result = await receivePdf(req, path.join(paths.datasets, ".challenge.part"), paths.dataset);
        audit("Organizer", "DATASET_UPLOADED", raceId, { fileName: info.fileName, size: result.size, sha256: result.hash });
        return json(res, 200, { ok: true, race: raceView(race), sha256: result.hash, size: result.size });
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
        if (raceStatus(race) === "ended") {
          const paths = racePaths(raceId);
          writeJson(paths.tickets, readJson(paths.tickets, []).map(ticket => ticket.status === "issued" ? { ...ticket, status: "ended", result: "race_ended" } : ticket));
        }
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
      match = p.match(/^\/api\/organizer\/races\/([^/]+)\/download-permission$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], paths = racePaths(raceId), input = JSON.parse((await body(req)).toString("utf8") || "{}"); requireRace(raceId);
        const policy = { enabled: Boolean(input.enabled), updatedAt: new Date().toISOString(), updatedBy: "Organizer" }; writeJson(paths.policy, policy);
        if (!policy.enabled) writeJson(paths.tickets, readJson(paths.tickets, []).map(t => t.status === "issued" ? { ...t, status: "revoked", result: "revoked_by_organizer" } : t));
        audit("Organizer", policy.enabled ? "DOWNLOAD_PERMISSION_ENABLED" : "DOWNLOAD_PERMISSION_REVOKED", raceId); return json(res, 200, { ok: true, policy });
      }
      match = p.match(/^\/api\/racer\/races\/([^/]+)\/join$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], race = requireRace(raceId); assertRaceOpen(race);
        const participations = readJson(files.participations, []);
        if (!isJoined(raceId)) { participations.push({ raceId, racerId: RACER_ID, joinedAt: new Date().toISOString() }); writeJson(files.participations, participations); setMetadata(raceId, getMetadata(raceId)); audit("Racer", "RACE_JOINED", raceId, { racerId: RACER_ID }); }
        return json(res, 200, { ok: true });
      }
      match = p.match(/^\/api\/racer\/races\/([^/]+)\/download-url$/);
      if (req.method === "POST" && match) {
        const raceId = match[1], paths = racePaths(raceId), race = requireRace(raceId); assertRaceOpen(race);
        if (!isJoined(raceId)) return json(res, 403, { error: "race_participation_required" });
        if (!fs.existsSync(paths.dataset)) return json(res, 409, { error: "dataset_not_uploaded" });
        if (!readJson(paths.policy, { enabled: true }).enabled) return json(res, 403, { error: "download_permission_revoked" });
        const jti = crypto.randomUUID(), issuedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 90000).toISOString();
        const tickets = readJson(paths.tickets, []); tickets.push({ jti, raceId, racerId: RACER_ID, status: "issued", issuedAt, expiresAt, result: "pending" }); writeJson(paths.tickets, tickets.slice(-100));
        const signed = token({ action: "download", raceId, racerId: RACER_ID, jti }, 90); audit("Racer", "DOWNLOAD_URL_ISSUED", raceId, { jti });
        return json(res, 200, { url: `http://${HOST}:${PORTS.organizer}/organizer/races/${raceId}/download?token=${signed}`, expiresInSeconds: 90, ticketId: jti, fileName: `${raceId}-challenge.pdf`, size: fs.statSync(paths.dataset).size });
      }
      match = p.match(/^\/organizer\/races\/([^/]+)\/download$/);
      if (req.method === "GET" && match) {
        const raceId = match[1], paths = racePaths(raceId), payload = verifyToken(url.searchParams.get("token"), "download"), race = requireRace(raceId);
        if (payload.raceId !== raceId) return json(res, 403, { error: "invalid_race_ticket" });
        const tickets = readJson(paths.tickets, []), index = tickets.findIndex(t => t.jti === payload.jti), ticket = tickets[index];
        const currentStatus = raceStatus(race);
        if (currentStatus !== "open" && ticket?.status === "issued") {
          tickets[index] = { ...ticket, status: currentStatus, result: currentStatus === "ended" ? "race_ended" : "race_not_started" }; writeJson(paths.tickets, tickets);
          return json(res, 409, { error: currentStatus === "ended" ? "race_ended" : "race_not_started" });
        }
        if (!ticket || ticket.status !== "issued" || payload.exp < Date.now() || new Date(ticket.expiresAt).getTime() < Date.now() || !readJson(paths.policy, {}).enabled) return json(res, 403, { error: "ticket_unavailable" });
        tickets[index] = { ...ticket, status: "used", downloadedAt: new Date().toISOString(), result: "success" }; writeJson(paths.tickets, tickets); audit("Racer", "DATASET_DOWNLOADED", raceId, { jti: ticket.jti });
        const stat = fs.statSync(paths.dataset); res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": stat.size, "Content-Disposition": `attachment; filename="${raceId}-challenge.pdf"`, "X-Data-Owner": "Organizer" }); return fs.createReadStream(paths.dataset).pipe(res);
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
        const raceId = match[1], race = requireRace(raceId), manifest = readJson(racePaths(raceId).manifest, {}), metadata = getMetadata(raceId), archiveDir = path.join(ARCHIVE, raceId);
        fs.mkdirSync(archiveDir, { recursive: true }); fs.writeFileSync(path.join(archiveDir, "poster.svg"), posterSvg(manifest.disclosure.title), "utf8");
        const archive = { raceId, id: `archive-${raceId}`, title: manifest.disclosure.title, summary: manifest.disclosure.summary, startsAt: race.startsAt, endsAt: race.endsAt, timeline: timelineText(race), posterUrl: `/archive-assets/${raceId}/poster.svg`, rankingSummary: metadata.review ? `Organizer 评分：${metadata.review.score}` : "待评审", consent: { organizerId: race.organizerId, archiveVersion: manifest.version, consentHash: crypto.createHash("sha256").update(JSON.stringify(manifest.archiveFields)).digest("hex").slice(0, 20) }, publishedAt: new Date().toISOString() };
        const archives = readJson(files.archives, []), index = archives.findIndex(a => a.raceId === raceId); index < 0 ? archives.push(archive) : archives[index] = archive; writeJson(files.archives, archives); audit("Organizer", "PUBLIC_ARCHIVE_PUBLISHED", raceId); return json(res, 200, { ok: true, archive });
      }
      match = p.match(/^\/archive-assets\/([^/]+)\/poster\.svg$/);
      if (req.method === "GET" && match) {
        const poster = path.join(ARCHIVE, match[1], "poster.svg"); if (!fs.existsSync(poster)) return text(res, 404, "archive not published");
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" }); return fs.createReadStream(poster).pipe(res);
      }
      if (req.method === "POST" && p === "/api/proof/run") { const result = proof(); audit("ARY", "SECURITY_PROOF_EXECUTED", "all-races", { passed: result.passed }); return json(res, 200, result); }
      if (req.method === "POST" && p === "/api/demo/reset") {
        clearDir(RACES); clearDir(ARCHIVE); writeJson(files.races, []); writeJson(files.participations, []); writeJson(files.metadata, {}); writeJson(files.audit, []); writeJson(files.archives, []); return json(res, 200, { ok: true });
      }
      if (serveStatic(res, p, role)) return;
      json(res, 404, { error: "not_found" });
    } catch (error) { json(res, error.statusCode || 400, { error: error.message }); }
  });
}

for (const [role, port] of Object.entries(PORTS)) createRoleServer(role).listen(port, HOST, () => console.log(`${role.toUpperCase()} UI running at http://${HOST}:${port}`));
