const fs = require("fs");
const path = require("path");
const { claudeSessionsDir, listCursorComposerIds } = require("./providers");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function liveStatus(status) {
  const value = String(status || "").toLowerCase();
  if (value === "running" || value === "working" || value === "responding") return "running";
  if (value.includes("wait") || value.includes("permission") || value.includes("block") || value.includes("input")) return "needs-you";
  return "idle";
}

function readSessionFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw.sessionId !== "string" || !raw.sessionId) return null;
    return {
      sessionId: raw.sessionId,
      cwd: typeof raw.cwd === "string" ? raw.cwd : "",
      startedAt: Number(raw.startedAt) || 0,
      updatedAt: Number(raw.updatedAt) || Number(raw.startedAt) || 0,
      name: typeof raw.name === "string" ? raw.name : "",
      status: liveStatus(raw.status),
    };
  } catch {
    return null;
  }
}

function readClaudeSessions() {
  const dir = claudeSessionsDir();
  if (!fs.existsSync(dir)) return [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const sessions = [];
  for (const name of names) {
    const session = readSessionFile(path.join(dir, name));
    if (session) sessions.push(session);
  }
  return sessions;
}

function sessionSig(session) {
  return [session.status, session.updatedAt, session.name].join("\0");
}

function createSync(onPulse) {
  const seen = new Map();
  const dirty = new Set();
  let seeded = false;
  let watcher = null;
  let pulseTimer = null;
  let retryTimer = null;

  function emit(session) {
    const sig = sessionSig(session);
    if (seen.get(session.sessionId) === sig) return;
    seen.set(session.sessionId, sig);
    if (!seeded) return;
    onPulse({
      host: "claude",
      sessionId: session.sessionId,
      status: session.status,
      title: session.name || "",
      updatedAt: session.updatedAt || session.startedAt || 0,
      cwd: session.cwd || "",
      startedAt: session.startedAt || 0,
      name: session.name || "",
    });
  }

  function seed() {
    const live = new Set();
    for (const session of readClaudeSessions()) {
      live.add(session.sessionId);
      emit(session);
    }
    for (const id of seen.keys()) {
      if (!live.has(id)) seen.delete(id);
    }
    seeded = true;
  }

  function flush() {
    const dir = claudeSessionsDir();
    if (dirty.size === 0) {
      seed();
      return;
    }
    const names = [...dirty];
    dirty.clear();
    let missed = false;
    for (const name of names) {
      const session = readSessionFile(path.join(dir, name));
      if (session) emit(session);
      else missed = true;
    }
    if (missed) {
      setTimeout(() => {
        dirty.clear();
        seed();
      }, 250);
    }
  }

  function schedule(filename) {
    const name = Buffer.isBuffer(filename) ? filename.toString() : filename;
    if (!name || !String(name).endsWith(".json")) dirty.clear();
    else dirty.add(String(name));
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(flush, 180);
  }

  function ensure() {
    if (watcher) return;
    const dir = claudeSessionsDir();
    if (!fs.existsSync(dir)) return;
    try {
      seed();
      watcher = fs.watch(dir, { persistent: true }, (_event, filename) => schedule(filename));
      watcher.on("error", () => {
        if (watcher) watcher.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
  }

  ensure();
  retryTimer = setInterval(ensure, 5000);

  return {
    stop() {
      clearInterval(retryTimer);
      clearTimeout(pulseTimer);
      if (watcher) watcher.close();
      watcher = null;
    },
  };
}

async function waitForNewClaudeSession(known, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = readClaudeSessions()
      .filter((session) => !known.has(session.sessionId))
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    if (fresh.length) return fresh[0];
    await sleep(200);
  }
  return null;
}

async function waitForNewCursorComposer(known, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let rows = [];
    try {
      rows = listCursorComposerIds();
    } catch {
      rows = [];
    }
    const fresh = rows.filter((row) => row.id && !known.has(row.id)).sort((a, b) => a.createdAt - b.createdAt);
    if (fresh.length) return fresh[0];
    await sleep(200);
  }
  return null;
}

module.exports = { createSync, waitForNewClaudeSession, waitForNewCursorComposer, readClaudeSessions };
