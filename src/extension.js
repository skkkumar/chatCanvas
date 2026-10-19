const path = require("path");
const crypto = require("crypto");
const vscode = require("vscode");
const { BoardStore } = require("./boardStore");
const { loadChats, loadCursorChats, loadPreview, clip, cursorDbStamp, listCursorComposerIds } = require("./providers");
const { buildModel, draftText } = require("./model");
const { openChat, startBlank, startDraft, sendToChat } = require("./host");
const { createSync, waitForNewClaudeSession, waitForNewCursorComposer, readClaudeSessions } = require("./sync");

let canvas;

function activate(context) {
  canvas = new ChatCanvas(context);
  context.subscriptions.push(
    vscode.commands.registerCommand("chatCanvas.open", () => canvas.openPanel()),
    vscode.commands.registerCommand("chatCanvas.refresh", () => canvas.refresh()),
    vscode.window.registerWebviewViewProvider("chatCanvas.board", canvas, { webviewOptions: { retainContextWhenHidden: true } })
  );
}

function deactivate() {}

class ChatCanvas {
  constructor(context) {
    this.context = context;
    this.store = new BoardStore(context.globalState);
    this.outputs = vscode.window.createOutputChannel("Chat Canvas");
    this.surfaces = new Set();
    this.panel = null;
    this.rev = 1;
    this.chats = [];
    this.warnings = [];
    this.timer = null;
    this.signature = "";
    this.cursorStamp = 0;
    this.discoveries = 0;
    this.ticking = false;
    this.tail = Promise.resolve();
    this.live = new Map();
    this.sync = createSync((pulse) => {
      try {
        this.onPulse(pulse);
      } catch (error) {
        this.outputs.appendLine(String(error));
      }
    });
    context.subscriptions.push(this.outputs, { dispose: () => this.sync.stop() });
  }

  resolveWebviewView(webviewView) {
    this.attach(webviewView.webview, false);
    webviewView.onDidDispose(() => this.surfaces.delete(webviewView.webview));
  }

  openPanel() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel("chatCanvas", "Chat Canvas", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "media"))],
    });
    panel.iconPath = vscode.Uri.file(path.join(this.context.extensionPath, "media", "icon.svg"));
    this.panel = panel;
    this.attach(panel.webview, true);
    panel.onDidDispose(() => {
      this.surfaces.delete(panel.webview);
      this.panel = null;
    });
  }

  attach(webview, expanded) {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "media"))],
    };
    webview.html = html(webview, this.context.extensionPath, expanded);
    this.surfaces.add(webview);
    webview.onDidReceiveMessage((message) => this.onMessage(webview, message));
    this.ensurePolling();
  }

  ensurePolling() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.outputs.appendLine(String(error)));
    }, 4000);
    this.context.subscriptions.push({ dispose: () => clearInterval(this.timer) });
  }

  workspacePath() {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    return folder ? folder.uri.fsPath : "";
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.syncCursor();
      this.discoveries += 1;
      if (this.discoveries % 8 === 0) await this.refresh(false);
    } finally {
      this.ticking = false;
    }
  }

  async syncCursor() {
    const stamp = cursorDbStamp();
    if (!stamp || stamp === this.cursorStamp) return;
    if (!this.cursorStamp) {
      this.cursorStamp = stamp;
      return;
    }
    this.cursorStamp = stamp;
    let chats = [];
    try {
      chats = loadCursorChats(this.workspacePath(), !!this.store.get().showSubagents);
    } catch (error) {
      this.outputs.appendLine(String(error));
      return;
    }
    const previous = new Map(this.chats.filter((chat) => chat.source === "cursor").map((chat) => [chat.id, cursorSig(chat)]));
    this.chats = this.chats.filter((chat) => chat.source !== "cursor").concat(chats);
    const adoptedId = await this.adoptOpenings();
    const added = chats.some((chat) => !previous.has(chat.id));
    if (adoptedId || added) {
      this.rev += 1;
      this.broadcast(adoptedId || false);
      return;
    }
    for (const chat of chats) {
      if (previous.get(chat.id) !== cursorSig(chat)) this.sendPulse(chat);
    }
  }

  sendPulse(chat) {
    const packet = {
      type: "pulse",
      id: chat.id,
      sessionId: chat.externalId,
      status: chat.status || "",
      updatedAt: chat.updatedAt || 0,
      trustTitle: true,
    };
    if (chat.title) packet.title = chat.title;
    this.live.set("cursor:" + chat.externalId, packet);
    this.postPulse(packet);
  }

  onPulse(msg) {
    if (!msg || !msg.sessionId) return;
    this.live.set(msg.host + ":" + msg.sessionId, msg);
    const node = this.findBySession(msg.host, msg.sessionId);
    if (!node) return;
    const packet = {
      type: "pulse",
      id: node.id,
      sessionId: msg.sessionId,
      status: msg.status || "",
      updatedAt: msg.updatedAt || 0,
    };
    if (msg.title && !node.titleOverride && (node.opening || placeholderTitle(node.title))) packet.title = msg.title;
    this.postPulse(packet);
  }

  postPulse(packet) {
    for (const webview of this.surfaces) webview.postMessage(packet).then(undefined, () => {});
  }

  findBySession(host, sessionId) {
    const built = buildModel(this.chats, this.store.get());
    return built.model.nodes.find((node) => node.source === host && (node.sessionId === sessionId || node.externalId === sessionId));
  }

  applyLive(nodes) {
    for (const node of nodes) {
      const live = this.live.get(node.source + ":" + (node.sessionId || node.externalId));
      if (!live) continue;
      if (live.status) node.status = live.status;
      if (live.updatedAt) node.updatedAt = Math.max(node.updatedAt || 0, live.updatedAt);
      if (live.title && !node.titleOverride && (live.trustTitle || node.opening || placeholderTitle(node.title))) {
        node.title = live.title;
        node.baseTitle = live.title;
      }
    }
  }

  async refresh(force) {
    const board = this.store.get();
    const { chats, warnings } = await loadChats(this.workspacePath(), {
      includeSubagents: board.showSubagents,
    });
    this.chats = chats;
    this.warnings = warnings;
    this.cursorStamp = cursorDbStamp();
    const adoptedId = await this.adoptOpenings();
    const signature = chats.map((chat) => [chat.id, chat.updatedAt, chat.status, chat.title, chat.subtitle].join(":")).join("|") + warnings.join("|");
    const built = buildModel(chats, this.store.get());
    if (built.dirtyPlacement) {
      await this.store.update((draft) => {
        draft.placement = built.dirtyPlacement;
      });
    }
    if (!force && !adoptedId && signature === this.signature && !built.dirtyPlacement) return;
    this.signature = signature;
    if (adoptedId) this.rev += 1;
    this.broadcast(adoptedId || false);
  }

  snapshot() {
    const built = buildModel(this.chats, this.store.get());
    this.applyLive(built.model.nodes);
    return {
      type: "state",
      rev: this.rev,
      warnings: this.warnings,
      workspace: path.basename(this.workspacePath() || "") || "No folder",
      ...built.model,
    };
  }

  broadcast(selectId) {
    const message = this.snapshot();
    if (selectId) message.select = selectId;
    for (const webview of this.surfaces) {
      webview.postMessage(message).then(undefined, () => {});
    }
  }

  findNode(id) {
    const built = buildModel(this.chats, this.store.get());
    return built.model.nodes.find((node) => node.id === id);
  }

  async onMessage(webview, message) {
    try {
      await this.handle(webview, message || {});
    } catch (error) {
      this.outputs.appendLine(String(error && error.stack || error));
      webview.postMessage({ type: "toast", text: error.message || "Chat Canvas hit an error." });
    }
  }

  async handle(webview, message) {
    if (typeof message.rev === "number") this.rev = Math.max(this.rev, message.rev);
    switch (message.type) {
      case "ready":
        await this.refresh(true);
        return;
      case "refresh":
        this.signature = "";
        await this.refresh(true);
        return;
      case "expand":
        this.openPanel();
        return;
      case "scope":
        await this.store.update((board) => {
          board.scope = message.scope === "all" ? "all" : "workspace";
        });
        this.rev += 1;
        this.broadcast();
        return;
      case "flags":
        await this.store.update((board) => {
          if (typeof message.showHidden === "boolean") board.showHidden = message.showHidden;
          if (typeof message.showSubagents === "boolean") board.showSubagents = message.showSubagents;
        });
        this.signature = "";
        await this.refresh(true);
        return;
      case "camera":
        await this.store.update((board) => {
          if (message.camera) board.camera = message.camera;
        });
        return;
      case "move":
        await this.store.update((board) => {
          for (const spot of message.spots || []) {
            if (!spot || typeof spot.id !== "string") continue;
            const current = board.placement[spot.id] || {};
            board.placement[spot.id] = {
              ...current,
              x: finite(spot.x, current.x || 80),
              y: finite(spot.y, current.y || 80),
            };
          }
          for (const incoming of message.groups || []) {
            const group = board.groups.find((item) => item.id === incoming.id);
            if (!group) continue;
            group.x = finite(incoming.x, group.x);
            group.y = finite(incoming.y, group.y);
            group.width = finite(incoming.width, group.width);
            group.height = finite(incoming.height, group.height);
          }
        });
        this.broadcast();
        return;
      case "meta":
        await this.saveMeta(message);
        this.rev += 1;
        this.broadcast();
        return;
      case "preview": {
        const turns = await loadPreview(message.id);
        webview.postMessage({ type: "preview", id: message.id, turns });
        return;
      }
      case "open": {
        const result = await openChat(this.findNode(message.id));
        this.outputs.appendLine((result.ok ? "opened " : "open failed ") + (message.id || "") + " — " + result.message);
        webview.postMessage({ type: "toast", text: result.message });
        return;
      }
      case "prompt": {
        const result = await sendToChat(this.findNode(message.id), message.text);
        this.outputs.appendLine((result.ok ? "prompt " : "prompt failed ") + (message.id || "") + " — " + result.message);
        webview.postMessage({ type: "toast", text: result.message });
        if (result.ok) setTimeout(() => this.refresh(true).catch(() => {}), 1200);
        return;
      }
      case "newChat":
        await this.beginNewChat(webview, message);
        return;
      case "draft": {
        const node = this.findNode(message.id);
        const text = node ? [node.body, node.note].filter(Boolean).join("\n\n") : message.text || "";
        if (!text.trim()) {
          webview.postMessage({ type: "toast", text: "Write a note on this bubble first." });
          return;
        }
        const result = await startDraft(message.host, text);
        webview.postMessage({ type: "toast", text: result.message });
        setTimeout(() => this.refresh(true).catch(() => {}), 1500);
        return;
      }
      case "spawn":
        await this.spawn(message);
        return;
      case "note":
        await this.addNote(message);
        return;
      case "link":
        await this.addLink(message);
        return;
      case "unlink":
        await this.store.update((board) => {
          board.links = board.links.filter((link) => link.id !== message.id);
        });
        this.rev += 1;
        this.broadcast();
        return;
      case "group":
        await this.addGroup(message);
        return;
      case "renameGroup":
        await this.store.update((board) => {
          const group = board.groups.find((item) => item.id === message.id);
          if (group) group.name = clip(message.name || "Group", 60);
        });
        this.rev += 1;
        this.broadcast();
        return;
      case "ungroup":
        await this.store.update((board) => {
          const group = board.groups.find((item) => item.id === message.id);
          board.groups = board.groups.filter((item) => item.id !== message.id);
          if (!group) return;
          for (const spot of Object.values(board.placement)) {
            if (spot.groupId === message.id) spot.groupId = "";
          }
        });
        this.rev += 1;
        this.broadcast();
        return;
      case "leaveGroup":
        await this.store.update((board) => {
          const spot = board.placement[message.id];
          if (!spot || !spot.groupId) return;
          const groupId = spot.groupId;
          spot.groupId = "";
          const members = Object.values(board.placement).filter((item) => item.groupId === groupId);
          if (members.length < 2) {
            board.groups = board.groups.filter((group) => group.id !== groupId);
            for (const item of Object.values(board.placement)) {
              if (item.groupId === groupId) item.groupId = "";
            }
          }
        });
        this.rev += 1;
        this.broadcast();
        return;
      case "deleteCustom":
        await this.store.update((board) => {
          board.customs = board.customs.filter((item) => item.id !== message.id);
          delete board.placement[message.id];
          board.links = board.links.filter((link) => link.from !== message.id && link.to !== message.id);
        });
        this.rev += 1;
        this.broadcast();
        return;
      case "hide":
        await this.store.update((board) => {
          const spot = board.placement[message.id] || (board.placement[message.id] = {});
          spot.hidden = true;
        });
        this.rev += 1;
        this.broadcast();
        return;
      case "unhide":
        await this.store.update((board) => {
          const spot = board.placement[message.id] || (board.placement[message.id] = {});
          spot.hidden = false;
          if (typeof message.x === "number") spot.x = message.x;
          if (typeof message.y === "number") spot.y = message.y;
        });
        this.rev += 1;
        this.broadcast();
        return;
      default:
        return;
    }
  }

  enqueue(task) {
    const run = this.tail.then(task, task);
    this.tail = run.then(() => {}, () => {});
    return run;
  }

  async beginNewChat(webview, message) {
    await this.enqueue(() => this.createLinkedChat(webview, message));
  }

  async createLinkedChat(webview, message) {
    const host = message.host === "claude" ? "claude" : "cursor";
    let known = null;
    try {
      known = host === "claude"
        ? new Set(readClaudeSessions().map((session) => session.sessionId))
        : new Set(listCursorComposerIds().map((row) => row.id));
    } catch (error) {
      this.outputs.appendLine(String(error));
    }
    const id = cryptoId();
    await this.store.update((board) => {
      board.customs.push({
        id,
        kind: "opening",
        host,
        title: host === "claude" ? "New Claude chat" : "New Cursor chat",
        body: "",
        createdAt: Date.now(),
      });
      board.placement[id] = { x: finite(message.x, 160), y: finite(message.y, 160) };
    });
    this.rev += 1;
    this.broadcast(id);
    const result = await startBlank(host);
    if (!result.ok || !known) {
      webview.postMessage({
        type: "toast",
        text: result.ok ? "Chat opened. Clicking this bubble focuses it and will not start another." : result.message,
      });
      return;
    }
    const bound = host === "claude"
      ? await waitForNewClaudeSession(known, 8000)
      : await waitForNewCursorComposer(known, 8000);
    if (!bound) {
      webview.postMessage({
        type: "toast",
        text: result.message + " Clicking this bubble focuses it and will not start another.",
      });
      return;
    }
    const adoptedId = await this.linkOpening(id, host, bound);
    this.rev += 1;
    this.broadcast(adoptedId || id);
    webview.postMessage({
      type: "toast",
      text: host === "claude" ? "This bubble is linked to that Claude chat." : "This bubble is linked to that Cursor chat.",
    });
  }

  async linkOpening(openingId, host, bound) {
    const sessionId = bound.sessionId || bound.id;
    if (!sessionId) return "";
    await this.store.update((board) => {
      const custom = board.customs.find((item) => item.id === openingId);
      if (custom) custom.sessionId = sessionId;
    });
    if (host === "claude") this.rememberClaude(bound);
    else {
      try {
        const chats = loadCursorChats(this.workspacePath(), !!this.store.get().showSubagents);
        this.chats = this.chats.filter((chat) => chat.source !== "cursor").concat(chats);
        this.cursorStamp = cursorDbStamp();
      } catch (error) {
        this.outputs.appendLine(String(error));
      }
    }
    const adoptedId = await this.adoptOpenings();
    this.outputs.appendLine("linked " + openingId + " -> " + (adoptedId || sessionId));
    return adoptedId;
  }

  rememberClaude(session) {
    const id = "claude:" + session.sessionId;
    if (this.chats.some((chat) => chat.id === id)) return;
    const cwd = session.cwd || "";
    const workspace = this.workspacePath();
    let inWorkspace = false;
    if (cwd && workspace) {
      try {
        inWorkspace = path.resolve(cwd).toLowerCase() === path.resolve(workspace).toLowerCase();
      } catch {
        inWorkspace = false;
      }
    }
    this.chats.push({
      id,
      externalId: session.sessionId,
      source: "claude",
      title: session.name || "New Claude chat",
      subtitle: "",
      project: cwd,
      projectLabel: cwd ? path.basename(cwd) : "Claude",
      mode: "claude",
      status: session.status || "idle",
      updatedAt: session.updatedAt || Date.now(),
      createdAt: session.startedAt || Date.now(),
      filesChanged: 0,
      inWorkspace,
      subagent: false,
      turnsCount: 0,
    });
  }

  async adoptOpenings() {
    const openings = (this.store.get().customs || []).filter((item) => item.kind === "opening" && item.sessionId);
    if (!openings.length) return "";
    const used = new Set();
    const claims = [];
    for (const opening of openings) {
      const match = this.chats.find((chat) => chat.source === opening.host && chat.externalId === opening.sessionId);
      if (!match || used.has(match.id)) continue;
      used.add(match.id);
      claims.push({ opening, match });
    }
    if (!claims.length) return "";
    await this.store.update((board) => {
      for (const { opening, match } of claims) {
        const from = board.placement[opening.id] || {};
        const spot = board.placement[match.id] || {};
        const renamed = from.title && from.title !== opening.title ? from.title : "";
        board.placement[match.id] = {
          ...spot,
          x: typeof from.x === "number" ? from.x : spot.x,
          y: typeof from.y === "number" ? from.y : spot.y,
          groupId: from.groupId || spot.groupId || "",
          note: from.note || spot.note || "",
          tags: Array.isArray(from.tags) ? from.tags : spot.tags || [],
          userStatus: from.userStatus || spot.userStatus || "",
          hidden: !!(from.hidden || spot.hidden),
        };
        if (renamed) board.placement[match.id].title = renamed;
        board.customs = board.customs.filter((item) => item.id !== opening.id);
        delete board.placement[opening.id];
        for (const link of board.links || []) {
          if (link.from === opening.id) link.from = match.id;
          if (link.to === opening.id) link.to = match.id;
        }
      }
    });
    return claims[claims.length - 1].match.id;
  }

  async saveMeta(message) {
    await this.store.update((board) => {
      const spot = board.placement[message.id] || {};
      board.placement[message.id] = {
        ...spot,
        title: clip(message.title || "", 140),
        note: clip(message.note || "", 4000),
        tags: sanitizeTags(message.tags),
        userStatus: ["", "active", "waiting", "parked", "done"].includes(message.userStatus) ? message.userStatus : "",
        groupId: typeof message.groupId === "string" ? message.groupId : spot.groupId || "",
        x: finite(spot.x, 80),
        y: finite(spot.y, 80),
      };
      if (!board.placement[message.id].title) delete board.placement[message.id].title;
      const custom = board.customs.find((item) => item.id === message.id);
      if (custom) {
        if (typeof message.body === "string") custom.body = clip(message.body, 8000);
        if (message.title) custom.title = clip(message.title, 140);
      }
    });
  }

  async spawn(message) {
    const node = this.findNode(message.id);
    if (!node) return;
    const turns = message.text ? [{ role: "you", text: clip(message.text, 4000) }] : await loadPreview(message.id);
    const mode = ["fork", "handover", "topic", "context"].includes(message.mode) ? message.mode : "handover";
    const body = message.text && mode === "context"
      ? draftText("context", node, [], node.note) + "\n\n" + clip(message.text, 4000)
      : draftText(mode, node, turns, node.note);
    const id = cryptoId();
    const titles = { fork: "Fork", handover: "Handoff", topic: "New topic", context: "Context" };
    const linkKind = mode === "fork" ? "fork" : mode === "topic" ? "topic" : mode === "context" ? "context" : "handover";
    await this.store.update((board) => {
      board.customs.push({
        id,
        kind: "packet",
        title: titles[mode] + " · " + node.title,
        body,
        originId: node.id,
        createdAt: Date.now(),
      });
      board.placement[id] = { x: node.x + 300, y: node.y + 28 };
      board.links.push({ id: cryptoId(), from: node.id, to: id, kind: linkKind });
    });
    this.rev += 1;
    this.broadcast(id);
  }

  async addNote(message) {
    const id = cryptoId();
    await this.store.update((board) => {
      board.customs.push({
        id,
        kind: "note",
        title: "Note",
        body: "",
        createdAt: Date.now(),
      });
      board.placement[id] = {
        x: finite(message.x, 160),
        y: finite(message.y, 160),
      };
    });
    this.rev += 1;
    this.broadcast(id);
  }

  async addLink(message) {
    const kind = ["related", "fork", "handover", "context", "topic"].includes(message.kind) ? message.kind : "related";
    if (!message.from || !message.to || message.from === message.to) return;
    await this.store.update((board) => {
      const exists = board.links.some((link) => link.from === message.from && link.to === message.to && link.kind === kind);
      if (exists) return;
      board.links.push({ id: cryptoId(), from: message.from, to: message.to, kind });
    });
    this.rev += 1;
    this.broadcast();
  }

  async addGroup(message) {
    const members = Array.isArray(message.members) ? message.members.filter((id) => typeof id === "string") : [];
    if (!members.length) return;
    const id = cryptoId();
    await this.store.update((board) => {
      board.groups.push({
        id,
        name: clip(message.name || "Group", 60),
        x: finite(message.x, 40),
        y: finite(message.y, 40),
        width: finite(message.width, 360),
        height: finite(message.height, 280),
      });
      for (const member of members) {
        const spot = board.placement[member] || {};
        board.placement[member] = { ...spot, groupId: id, x: finite(spot.x, 80), y: finite(spot.y, 80) };
      }
    });
    this.rev += 1;
    this.broadcast();
  }
}

function placeholderTitle(title) {
  return !title || title === "New Claude chat" || title === "New Cursor chat" || title === "New chat" || title === "Claude session" || title === "Untitled Cursor chat";
}

function cursorSig(chat) {
  return [chat.updatedAt, chat.status, chat.title, chat.subtitle, chat.filesChanged].join("\0");
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sanitizeTags(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  const tags = [];
  for (const tag of source) {
    const clean = clip(String(tag || ""), 24).replace(/^#+/, "");
    if (clean && !tags.includes(clean)) tags.push(clean);
    if (tags.length >= 8) break;
  }
  return tags;
}

function cryptoId() {
  return crypto.randomUUID();
}

function html(webview, extensionPath, expanded) {
  const nonce = String(Math.random()).slice(2);
  const script = webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, "media", "main.js")));
  const style = webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, "media", "main.css")));
  const csp = [
    "default-src 'none'",
    "style-src " + webview.cspSource + " 'unsafe-inline'",
    "script-src 'nonce-" + nonce + "'",
    "img-src " + webview.cspSource + " data:",
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="${style}" />
  <title>Chat Canvas</title>
</head>
<body class="${expanded ? "expanded" : "sidebar"}">
  <div id="app"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

module.exports = { activate, deactivate };
