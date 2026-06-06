const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { afterEach, test } = require("node:test");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const activeDemos = new Set();

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/state`);
      if (response.ok) return;
    } catch {
      // The child process is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`server_start_timeout:${port}`);
}

async function startDemo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ary-demo-test-"));
  fs.copyFileSync(path.join(PROJECT_ROOT, "server.js"), path.join(root, "server.js"));
  fs.cpSync(path.join(PROJECT_ROOT, "public"), path.join(root, "public"), { recursive: true });
  const ports = {
    ary: await getFreePort(),
    organizer: await getFreePort(),
    racer: await getFreePort(),
    visitor: await getFreePort()
  };
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      ARY_PORT: String(ports.ary),
      ORGANIZER_PORT: String(ports.organizer),
      RACER_PORT: String(ports.racer),
      VISITOR_PORT: String(ports.visitor)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const demo = {
    root,
    ports,
    child,
    stderr: () => stderr,
    async stop() {
      if (child.exitCode === null) {
        child.kill();
        await new Promise(resolve => child.once("exit", resolve));
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  activeDemos.add(demo);
  try {
    await waitForServer(ports.ary);
  } catch (error) {
    await demo.stop();
    activeDemos.delete(demo);
    throw new Error(`${error.message}\n${stderr}`);
  }
  return demo;
}

afterEach(async () => {
  await Promise.all([...activeDemos].map(demo => demo.stop()));
  activeDemos.clear();
});

async function request(port, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  const contentType = response.headers.get("content-type") || "";
  const value = contentType.includes("application/json")
    ? await response.json()
    : Buffer.from(await response.arrayBuffer());
  return { response, value };
}

async function createOpenRace(demo, overrides = {}) {
  const now = Date.now();
  const payload = {
    title: "Security Race",
    summary: "Public summary",
    startsAt: new Date(now + 100).toISOString(),
    endsAt: new Date(now + 60_000).toISOString(),
    liveRankingVisible: true,
    ...overrides
  };
  const { response, value } = await request(demo.ports.organizer, "/api/organizer/races", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  assert.equal(response.status, 201);
  await new Promise(resolve => setTimeout(resolve, 150));
  return value.race;
}

async function forceFinish(demo, raceId) {
  const result = await request(demo.ports.ary, `/api/ary/races/${raceId}/force-finish`, {
    method: "POST",
    headers: { "X-Operator": "Test Admin" }
  });
  assert.equal(result.response.status, 200);
}

async function stagePoster(demo, raceId, marker) {
  const pdf = Buffer.from(`%PDF-1.4\n${marker}\n%%EOF`);
  const result = await request(demo.ports.organizer, `/api/organizer/races/${raceId}/archive-poster`, {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
      "X-File-Name": "poster.pdf",
      "X-File-Size": String(pdf.length)
    },
    body: pdf
  });
  assert.equal(result.response.status, 200);
}

async function publishArchive(demo, raceId, body) {
  return request(demo.ports.organizer, `/api/organizer/races/${raceId}/archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("condition_timeout");
}

test("stores public race metadata in ARY and keeps manifest disclosure-only", async () => {
  const demo = await startDemo();
  const race = await createOpenRace(demo);
  const update = await request(demo.ports.organizer, `/api/organizer/races/${race.raceId}/disclosure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Updated Security Race",
      summary: "Updated public summary",
      posterVisible: false,
      liveRankingVisible: true
    })
  });
  assert.equal(update.response.status, 200);
  const races = JSON.parse(fs.readFileSync(path.join(demo.root, "ary-storage", "races.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(demo.root, "organizer-storage", "races", race.raceId, "manifest.json"), "utf8"));

  assert.equal(races[0].title, "Updated Security Race");
  assert.equal(races[0].summary, "Updated public summary");
  assert.equal("title" in manifest.disclosure, false);
  assert.equal("summary" in manifest.disclosure, false);
  assert.equal(manifest.disclosure.posterVisible, false);
});

test("security proof passes for a clean initialized race", async () => {
  const demo = await startDemo();
  await createOpenRace(demo);

  const { value } = await request(demo.ports.ary, "/api/state");
  assert.equal(value.proof.passed, true);
  assert.equal(value.proof.claims.every(claim => claim.passed), true);
});

test("security proof rejects unknown or sensitive ARY JSON fields", async () => {
  const demo = await startDemo();
  await createOpenRace(demo);
  const racesFile = path.join(demo.root, "ary-storage", "races.json");
  const races = JSON.parse(fs.readFileSync(racesFile, "utf8"));
  races[0].sourceData = "must not enter ARY";
  fs.writeFileSync(racesFile, JSON.stringify(races, null, 2));

  const { value } = await request(demo.ports.ary, "/api/state");
  assert.equal(value.proof.passed, false);
  assert.match(value.proof.claims.find(claim => claim.name === "ARY JSON 存储字段符合白名单").evidence, /sourceData/);
});

test("security proof rejects organizer submission files without ARY receipts", async () => {
  const demo = await startDemo();
  const race = await createOpenRace(demo);
  const submissions = path.join(demo.root, "organizer-storage", "races", race.raceId, "submissions");
  fs.writeFileSync(path.join(submissions, "orphan-racer.pdf"), "%PDF-1.4\norphan\n%%EOF");

  const { value } = await request(demo.ports.ary, "/api/state");
  assert.equal(value.proof.passed, false);
  assert.match(value.proof.claims.find(claim => claim.name === "Organizer 提交文件均有 ARY 回执").evidence, /orphan-racer/);
});

test("visitor can only download the current archive poster version", async () => {
  const demo = await startDemo();
  const race = await createOpenRace(demo);
  await forceFinish(demo, race.raceId);
  await stagePoster(demo, race.raceId, "version-one");
  assert.equal((await publishArchive(demo, race.raceId, { results: [{ rank: 1, racerId: "racer-001", score: 98 }], showcases: [] })).response.status, 200);
  await stagePoster(demo, race.raceId, "version-two");
  assert.equal((await publishArchive(demo, race.raceId, { results: [{ rank: 1, racerId: "racer-001", score: 99 }], showcases: [] })).response.status, 200);

  assert.equal((await request(demo.ports.visitor, `/archive-assets/${race.raceId}/v1/poster.pdf`)).response.status, 404);
  assert.equal((await request(demo.ports.visitor, `/archive-assets/${race.raceId}/v2/poster.pdf`)).response.status, 200);
  assert.equal((await request(demo.ports.ary, `/archive-assets/${race.raceId}/v1/poster.pdf`)).response.status, 200);
});

test("archive API rejects unknown ranking fields and excessive showcases", async () => {
  const demo = await startDemo();
  const race = await createOpenRace(demo);
  await forceFinish(demo, race.raceId);
  await stagePoster(demo, race.raceId, "contract-test");

  const unknownField = await publishArchive(demo, race.raceId, {
    results: [{ rank: 1, racerId: "racer-001", score: 98, award: "gold" }],
    showcases: []
  });
  assert.equal(unknownField.response.status, 400);
  assert.equal(unknownField.value.error, "invalid_final_ranking_fields");

  const excessiveShowcases = await publishArchive(demo, race.raceId, {
    results: [
      { rank: 1, racerId: "racer-001", score: 98 },
      { rank: 2, racerId: "racer-002", score: 97 },
      { rank: 3, racerId: "racer-003", score: 96 },
      { rank: 4, racerId: "racer-004", score: 95 }
    ],
    showcases: [
      { title: "one" },
      { title: "two" },
      { title: "three" },
      { title: "four" }
    ]
  });
  assert.equal(excessiveShowcases.response.status, 400);
  assert.equal(excessiveShowcases.value.error, "showcases_top_3_only");

  const rankingGap = await publishArchive(demo, race.raceId, {
    results: [
      { rank: 1, racerId: "racer-001", score: 98 },
      { rank: 3, racerId: "racer-003", score: 96 }
    ],
    showcases: []
  });
  assert.equal(rankingGap.response.status, 400);
  assert.equal(rankingGap.value.error, "final_ranking_must_be_contiguous");
});

test("same live-ranking version with different content is rejected as stale", async () => {
  const demo = await startDemo();
  const race = await createOpenRace(demo);
  const rankingFile = path.join(demo.root, "organizer-storage", "races", race.raceId, "live-ranking.json");
  fs.writeFileSync(rankingFile, JSON.stringify({
    raceId: race.raceId,
    version: 2,
    updatedAt: new Date().toISOString(),
    scores: [{ racerId: "racer-001", score: 98 }]
  }));
  await waitFor(async () => {
    const { value } = await request(demo.ports.ary, "/api/state");
    return value.liveRankingMeta[race.raceId]?.version === 2 && !value.liveRankingMeta[race.raceId]?.stale;
  });

  fs.writeFileSync(rankingFile, JSON.stringify({
    raceId: race.raceId,
    version: 2,
    updatedAt: new Date().toISOString(),
    scores: [{ racerId: "racer-001", score: 50 }]
  }));
  const meta = await waitFor(async () => {
    const { value } = await request(demo.ports.ary, "/api/state");
    return value.liveRankingMeta[race.raceId]?.error === "same_version_content_changed"
      ? value.liveRankingMeta[race.raceId]
      : null;
  });
  assert.equal(meta.stale, true);
});

test("live-ranking rejects rows without an explicit racerId", async () => {
  const demo = await startDemo();
  const race = await createOpenRace(demo);
  const rankingFile = path.join(demo.root, "organizer-storage", "races", race.raceId, "live-ranking.json");
  fs.writeFileSync(rankingFile, JSON.stringify({
    raceId: race.raceId,
    version: 2,
    updatedAt: new Date().toISOString(),
    scores: [{ score: 98 }]
  }));

  const meta = await waitFor(async () => {
    const { value } = await request(demo.ports.ary, "/api/state");
    return value.liveRankingMeta[race.raceId]?.error ? value.liveRankingMeta[race.raceId] : null;
  });
  assert.equal(meta.error, "invalid_live_ranking");
  assert.equal(meta.stale, true);
});

test("racer role can subscribe to live ranking SSE", async () => {
  const demo = await startDemo();
  const result = await new Promise((resolve, reject) => {
    const req = http.get({
      host: "127.0.0.1",
      port: demo.ports.racer,
      path: "/api/live-rankings/events?racer=racer-001"
    }, res => {
      resolve({
        statusCode: res.statusCode,
        contentType: res.headers["content-type"]
      });
      res.destroy();
    });
    req.on("error", reject);
  });

  assert.equal(result.statusCode, 200);
  assert.match(result.contentType, /text\/event-stream/);
});
