const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const claudeFiles = new Map();
const claudeTurns = new Map();
const claudeCache = new Map();

function cursorUserDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || "", "Cursor", "User");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Cursor", "User");
}

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function claudeProjectsDir() {
  return path.join(claudeConfigDir(), "projects");
}

function claudeSessionsDir() {
  return path.join(claudeConfigDir(), "sessions");
}

function encodeProject(fsPath) {
  return path.resolve(fsPath).replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
}

function samePath(a, b) {
  if (!a || !b) return false;
  try {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  } catch {
    return false;
  }
}

function cleanText(value) {
  if (!value) return "";
  return String(value)
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, " ")
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, " ")
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, " ")
    .replace(/<command-args>[\s\S]*?<\/command-args>/gi, " ")
    .replace(/<pasted_content[\s\S]*?<\/pasted_content>/gi, " ")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function blocksToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function clip(text, max) {
  const clean = cleanText(text);
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).trimEnd() + "…";
}

function statusFrom(row) {
  const now = Date.now();
  const updated = Number(row.lastUpdatedAt) || 0;
  const runningAt = Number(row.runningAt) || 0;
  if (runningAt && now - updated < 20 * 60 * 1000) return "running";
  if (truthy(row.needsYou)) return "needs-you";
  if (truthy(row.pendingPlan)) return "plan";
  if (truthy(row.unread)) return "unread";
  if (truthy(row.isArchived)) return "archived";
  if (truthy(row.isDraft)) return "draft";
  return "idle";
}

function truthy(value) {
  return value === true || value === 1 || value === "1";
}

let sqliteBackend;

function canUseNodeSqlite() {
  if (sqliteBackend) return sqliteBackend === "node";
  try {
    const { DatabaseSync } = require("node:sqlite");
    const probe = new DatabaseSync(":memory:");
    probe.close();
    sqliteBackend = "node";
    return true;
  } catch {
    sqliteBackend = "cli";
    return false;
  }
}

function findSqlite3() {
  const { execFileSync } = require("child_process");
  try {
    const finder = process.platform === "win32" ? "where.exe" : "which";
    const out = execFileSync(finder, ["sqlite3"], { encoding: "utf8" });
    return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || "";
  } catch {
    return "";
  }
}

function cliAdapter(bin, dbPath) {
  const { execFileSync } = require("child_process");
  const uri = "file:" + dbPath.replace(/\\/g, "/") + "?mode=ro";
  return {
    prepare(sql) {
      return {
        all(...params) {
          let index = 0;
          const bound = sql.replace(/\?/g, () => "'" + String(params[index++] ?? "").replace(/'/g, "''") + "'");
          const out = execFileSync(bin, ["-json", uri, bound], {
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
          });
          if (!out.trim()) return [];
          const parsed = JSON.parse(out);
          return Array.isArray(parsed) ? parsed : [parsed];
        },
      };
    },
    close() {},
  };
}

function withCursorDb(fn) {
  const dbPath = path.join(cursorUserDir(), "globalStorage", "state.vscdb");
  if (!fs.existsSync(dbPath)) {
    throw new Error("Cursor chat database was not found.");
  }
  if (canUseNodeSqlite()) {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }
  const bin = findSqlite3();
  if (!bin) {
    throw new Error("Cursor chats could not be read. This editor has no SQLite API, and the sqlite3 command is not on PATH.");
  }
  return fn(cliAdapter(bin, dbPath));
}

function loadCursorChats(workspacePath, includeSubagents) {
  return withCursorDb((db) => {
    const rows = db
      .prepare(
        `SELECT composerId, isArchived, isSubagent, createdAt, lastUpdatedAt,
                json_extract(value, '$.name') AS name,
                json_extract(value, '$.subtitle') AS subtitle,
                json_extract(value, '$.unifiedMode') AS mode,
                json_extract(value, '$.hasUnreadMessages') AS unread,
                json_extract(value, '$.hasBlockingPendingActions') AS needsYou,
                json_extract(value, '$.hasPendingPlan') AS pendingPlan,
                json_extract(value, '$.unfinishedRunAt') AS runningAt,
                json_extract(value, '$.isDraft') AS isDraft,
                json_extract(value, '$.filesChangedCount') AS filesChanged,
                json_extract(value, '$.workspaceIdentifier.uri.fsPath') AS project
         FROM composerHeaders
         WHERE composerId != 'empty-state-draft'`
      )
      .all();
    const chats = [];
    for (const row of rows) {
      if (!includeSubagents && truthy(row.isSubagent)) continue;
      const name = (row.name || "").trim();
      const subtitle = (row.subtitle || "").trim();
      const filesChanged = Number(row.filesChanged) || 0;
      const status = statusFrom(row);
      const active = status === "running" || status === "needs-you" || status === "unread" || status === "plan";
      // Cursor keeps a header for every tab it ever opened, including blanks that were never used.
      if (!name && !subtitle && !filesChanged && !active) continue;
      const project = row.project || "";
      chats.push({
        id: "cursor:" + row.composerId,
        externalId: row.composerId,
        source: "cursor",
        title: name || clip(subtitle, 80) || "Untitled Cursor chat",
        subtitle: clip(row.subtitle || "", 90),
        project,
        projectLabel: project ? path.basename(project) : "No folder",
        mode: row.mode || "agent",
        status,
        updatedAt: Number(row.lastUpdatedAt) || Number(row.createdAt) || 0,
        createdAt: Number(row.createdAt) || 0,
        filesChanged,
        inWorkspace: samePath(project, workspacePath),
        subagent: truthy(row.isSubagent),
      });
    }
    return chats;
  });
}

function previewCursor(composerId) {
  return withCursorDb((db) => {
    const start = "bubbleId:" + composerId + ":";
    const end = "bubbleId:" + composerId + ";";
    const rows = db.prepare("SELECT value FROM cursorDiskKV WHERE key >= ? AND key < ?").all(start, end);
    const turns = [];
    for (const row of rows) {
      let bubble;
      try {
        bubble = JSON.parse(row.value);
      } catch {
        continue;
      }
      const type = bubble.type;
      if (type !== 1 && type !== 2) continue;
      const text = clip(bubble.text || "", 700);
      if (!text) continue;
      turns.push({
        role: type === 1 ? "you" : "agent",
        text,
        at: Number(bubble.createdAt) || 0,
      });
    }
    turns.sort((a, b) => a.at - b.at);
    return turns.slice(-24);
  });
}

async function readClaudeSession(file, folderName, workspacePath) {
  const sessionId = path.basename(file, ".jsonl");
  let title = "";
  let updatedAt = 0;
  const turns = [];
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.timestamp) {
      const at = Date.parse(obj.timestamp);
      if (!Number.isNaN(at)) updatedAt = Math.max(updatedAt, at);
    }
    if (obj.type === "custom-title" && obj.customTitle) title = String(obj.customTitle);
    if (obj.type === "ai-title" && obj.aiTitle) title = String(obj.aiTitle);
    if (!title && obj.type === "last-prompt" && obj.lastPrompt) title = String(obj.lastPrompt);
    if (obj.type === "agent-name" && obj.agentName && !title) title = String(obj.agentName);
    if (obj.isSidechain) continue;
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    const raw = blocksToText(obj.message && obj.message.content);
    const text = clip(raw, 700);
    if (!text) continue;
    if (obj.type === "user" && /^(caveat:|<local-command)/i.test(raw.trim())) continue;
    turns.push({ role: obj.type === "user" ? "you" : "claude", text, at: Date.parse(obj.timestamp) || 0 });
  }
  const kept = turns.slice(-24);
  claudeFiles.set(sessionId, file);
  claudeTurns.set(sessionId, kept);
  const stat = fs.statSync(file);
  if (!updatedAt) updatedAt = stat.mtimeMs;
  const parts = folderName.split("-").filter(Boolean);
  const projectLabel = parts.slice(-2).join("-") || folderName;
  const firstYou = turns.find((turn) => turn.role === "you");
  return {
    id: "claude:" + sessionId,
    externalId: sessionId,
    source: "claude",
    title: title || clip(firstYou ? firstYou.text : "", 80) || "",
    subtitle: clip(kept.length ? kept[kept.length - 1].text : "", 90),
    turnsCount: turns.length,
    project: folderName,
    projectLabel,
    mode: "claude",
    status: "idle",
    updatedAt,
    createdAt: turns.length ? turns[0].at || updatedAt : updatedAt,
    filesChanged: 0,
    inWorkspace: !!workspacePath && folderName.toLowerCase() === encodeProject(workspacePath),
    subagent: false,
  };
}

function claudeLiveStatus(status) {
  const value = String(status || "").toLowerCase();
  if (value === "running" || value === "working" || value === "responding") return "running";
  if (value.includes("wait") || value.includes("permission") || value.includes("block") || value.includes("input")) return "needs-you";
  return "idle";
}

function loadClaudeLive() {
  const dir = claudeSessionsDir();
  if (!fs.existsSync(dir)) return [];
  const sessions = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  for (const name of names) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (!raw || typeof raw.sessionId !== "string" || !raw.sessionId) continue;
      sessions.push({
        sessionId: raw.sessionId,
        cwd: typeof raw.cwd === "string" ? raw.cwd : "",
        startedAt: Number(raw.startedAt) || 0,
        updatedAt: Number(raw.updatedAt) || Number(raw.startedAt) || 0,
        name: typeof raw.name === "string" ? raw.name : "",
        status: claudeLiveStatus(raw.status),
      });
    } catch {
      // A session file can be rewritten while it is read.
    }
  }
  return sessions;
}

function applyLiveSession(chat, live, workspacePath) {
  if (!live) return chat;
  if (!chat.title) chat.title = live.name || "Claude session";
  if (live.updatedAt) chat.updatedAt = Math.max(chat.updatedAt || 0, live.updatedAt);
  if (!chat.createdAt) chat.createdAt = live.startedAt || chat.updatedAt;
  chat.status = live.status || chat.status;
  if (live.cwd) chat.inWorkspace = chat.inWorkspace || samePath(live.cwd, workspacePath);
  return chat;
}

function chatFromLive(live, workspacePath) {
  return {
    id: "claude:" + live.sessionId,
    externalId: live.sessionId,
    source: "claude",
    title: live.name || "Claude session",
    subtitle: "",
    project: "",
    projectLabel: live.cwd ? path.basename(live.cwd) : "Claude",
    mode: "claude",
    status: live.status || "idle",
    updatedAt: live.updatedAt || live.startedAt || 0,
    createdAt: live.startedAt || live.updatedAt || 0,
    filesChanged: 0,
    inWorkspace: samePath(live.cwd, workspacePath),
    subagent: false,
    turnsCount: 0,
  };
}

async function loadClaudeChats(workspacePath) {
  const root = claudeProjectsDir();
  const chats = [];
  if (!fs.existsSync(root)) {
    return mergeLiveSessions(chats, workspacePath);
  }
  const folders = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const folder of folders) {
    const dir = path.join(root, folder.name);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of files) {
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        const cached = claudeCache.get(file);
        if (cached && cached.mtime === stat.mtimeMs) {
          chats.push({ ...cached.chat, inWorkspace: !!workspacePath && folder.name.toLowerCase() === encodeProject(workspacePath) });
          continue;
        }
        const chat = await readClaudeSession(file, folder.name, workspacePath);
        claudeCache.set(file, { mtime: stat.mtimeMs, chat });
        chats.push(chat);
      } catch {
        // A half-written transcript should not blank the map.
      }
    }
  }
  return mergeLiveSessions(chats, workspacePath);
}

function mergeLiveSessions(chats, workspacePath) {
  const byId = new Map(chats.map((chat) => [chat.externalId, chat]));
  for (const live of loadClaudeLive()) {
    const existing = byId.get(live.sessionId);
    if (existing) {
      applyLiveSession(existing, live, workspacePath);
      if (!existing.title) existing.title = "Claude session";
      continue;
    }
    const chat = chatFromLive(live, workspacePath);
    chats.push(chat);
    byId.set(live.sessionId, chat);
  }
  for (const chat of chats) {
    if (!chat.title) chat.title = "Claude session";
  }
  return chats;
}

async function loadChats(workspacePath, options = {}) {
  const warnings = [];
  let cursor = [];
  try {
    cursor = loadCursorChats(workspacePath, !!options.includeSubagents);
  } catch (error) {
    warnings.push(error.message);
  }
  let claude = [];
  try {
    claude = await loadClaudeChats(workspacePath);
  } catch (error) {
    warnings.push("Claude sessions could not be read (" + error.message + ").");
  }
  const chats = cursor.concat(claude).sort((a, b) => b.updatedAt - a.updatedAt);
  return { chats, warnings };
}

async function loadPreview(nodeId) {
  if (nodeId.startsWith("cursor:")) {
    try {
      return previewCursor(nodeId.slice("cursor:".length));
    } catch {
      return [];
    }
  }
  if (nodeId.startsWith("claude:")) {
    const sessionId = nodeId.slice("claude:".length);
    if (claudeTurns.has(sessionId)) return claudeTurns.get(sessionId);
    const file = claudeFiles.get(sessionId);
    if (!file) return [];
    try {
      await readClaudeSession(file, path.basename(path.dirname(file)), "");
    } catch {
      return [];
    }
    return claudeTurns.get(sessionId) || [];
  }
  return [];
}

function listCursorComposerIds() {
  return withCursorDb((db) =>
    db
      .prepare(
        `SELECT composerId AS id, createdAt
         FROM composerHeaders
         WHERE composerId != 'empty-state-draft'`
      )
      .all()
  ).map((row) => ({ id: String(row.id), createdAt: Number(row.createdAt) || 0 }));
}

function cursorDbStamp() {
  const dbPath = path.join(cursorUserDir(), "globalStorage", "state.vscdb");
  if (!fs.existsSync(dbPath)) return 0;
  try {
    return fs.statSync(dbPath).mtimeMs;
  } catch {
    return 0;
  }
}

module.exports = { loadChats, loadCursorChats, loadPreview, cleanText, clip, listCursorComposerIds, cursorDbStamp, claudeSessionsDir };
