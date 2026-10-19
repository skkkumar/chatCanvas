const COL_W = 296;
const ROW_H = 216;
const ORIGIN = 36;

function placeMissing(chats, placement) {
  const quantized = quantize(placement);
  const next = quantized.placement;
  const missing = chats.filter((chat) => !next[chat.id]);
  if (!missing.length) return quantized;
  const taken = new Set();
  for (const spot of Object.values(next)) {
    if (typeof spot.x !== "number" || typeof spot.y !== "number") continue;
    taken.add(cellKey(cellOf(spot.x, spot.y)));
  }
  let dirty = quantized.dirty;
  const ordered = missing.filter((chat) => chat.inWorkspace).concat(missing.filter((chat) => !chat.inWorkspace));
  for (const chat of ordered) {
    const cell = cellAfterLast(taken);
    taken.add(cellKey(cell));
    const origin = cellOrigin(cell);
    next[chat.id] = { x: origin.x, y: origin.y };
    dirty = true;
  }
  return { placement: next, dirty };
}

function quantize(placement) {
  const next = { ...placement };
  let dirty = false;
  for (const id of Object.keys(placement)) {
    const spot = placement[id];
    if (!spot || typeof spot.x !== "number" || typeof spot.y !== "number") continue;
    const origin = cellOrigin(cellOf(spot.x, spot.y));
    if (spot.x !== origin.x || spot.y !== origin.y) {
      next[id] = { ...spot, x: origin.x, y: origin.y };
      dirty = true;
    }
  }
  return { placement: next, dirty };
}

function cellOf(x, y) {
  return {
    col: Math.max(0, Math.round((x - ORIGIN) / COL_W)),
    row: Math.max(0, Math.round((y - ORIGIN) / ROW_H)),
  };
}

function cellOrigin(cell) {
  return { x: ORIGIN + cell.col * COL_W, y: ORIGIN + cell.row * ROW_H };
}

function cellKey(cell) {
  return cell.col + "," + cell.row;
}

function cellAfterLast(taken) {
  let col = -1;
  let row = 0;
  for (const key of taken) {
    const parts = key.split(",");
    const c = Number(parts[0]);
    const r = Number(parts[1]);
    if (r > row || (r === row && c > col)) {
      row = r;
      col = c;
    }
  }
  if (col < 0) return { col: 0, row: 0 };
  return { col: 0, row: row + 1 };
}

function buildModel(chats, board) {
  const placed = placeMissing(chats, board.placement);
  const held = new Set();
  for (const custom of board.customs || []) {
    if (custom.kind === "opening" && custom.sessionId) held.add(custom.host + ":" + custom.sessionId);
  }
  const visibleChats = chats.filter((chat) => !held.has(chat.id));
  const byId = new Map(visibleChats.map((chat) => [chat.id, chat]));
  const nodes = [];

  for (const chat of visibleChats) {
    const spot = placed.placement[chat.id] || {};
    nodes.push({
      ...chat,
      sessionId: chat.externalId,
      x: num(spot.x, 80),
      y: num(spot.y, 80),
      groupId: spot.groupId || "",
      hidden: !!spot.hidden,
      baseTitle: chat.title,
      titleOverride: spot.title || "",
      title: spot.title || chat.title,
      note: spot.note || "",
      tags: Array.isArray(spot.tags) ? spot.tags : [],
      userStatus: spot.userStatus || "",
      color: spot.color || "",
      custom: false,
    });
  }

  for (const custom of board.customs) {
    const spot = placed.placement[custom.id] || {};
    nodes.push({
      id: custom.id,
      externalId: custom.sessionId || custom.id,
      sessionId: custom.sessionId || "",
      source: custom.kind === "note" ? "note" : custom.kind === "opening" ? (custom.host === "claude" ? "claude" : "cursor") : "packet",
      title: spot.title || custom.title || (custom.kind === "note" ? "Note" : custom.kind === "opening" ? "New chat" : "Context"),
      subtitle: custom.kind === "opening" ? (custom.sessionId ? "Linked to this chat" : "Linking to this chat") : "",
      project: "",
      projectLabel: custom.kind === "note" ? "Note" : custom.kind === "opening" ? "New chat" : "Handoff",
      mode: custom.kind === "opening" ? "new" : custom.kind || "packet",
      status: "idle",
      updatedAt: custom.createdAt || 0,
      createdAt: custom.createdAt || 0,
      filesChanged: 0,
      inWorkspace: true,
      subagent: false,
      x: num(spot.x, num(custom.x, 120)),
      y: num(spot.y, num(custom.y, 120)),
      groupId: spot.groupId || "",
      hidden: !!spot.hidden,
      baseTitle: custom.title || (custom.kind === "note" ? "Note" : "Context"),
      titleOverride: spot.title || "",
      note: spot.note || "",
      tags: Array.isArray(spot.tags) ? spot.tags : [],
      userStatus: spot.userStatus || "",
      color: spot.color || "",
      body: custom.body || "",
      originId: custom.originId || "",
      opening: custom.kind === "opening",
      custom: true,
    });
    byId.set(custom.id, true);
  }

  const links = (board.links || []).filter((link) => byId.has(link.from) && byId.has(link.to));
  return {
    dirtyPlacement: placed.dirty ? placed.placement : null,
    model: {
      nodes,
      groups: board.groups || [],
      links,
      camera: board.camera,
      scope: board.scope || "workspace",
      showSubagents: !!board.showSubagents,
      showHidden: !!board.showHidden,
    },
  };
}

function num(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function draftText(mode, node, turns, note) {
  const latestYou = [...(turns || [])].reverse().find((turn) => turn.role === "you");
  const latestAgent = [...(turns || [])].reverse().find((turn) => turn.role !== "you");
  const lines = [];
  if (mode === "fork") {
    lines.push('Fork of "' + node.title + '" (' + node.source + ").");
    lines.push("The original chat stays as it is. Continue the work in this new chat.");
  } else if (mode === "topic") {
    lines.push('New topic spun out of "' + node.title + '".');
    lines.push("Leave the original thread on its current subject. Use only the context below.");
  } else if (mode === "context") {
    lines.push('Context carried from "' + node.title + '".');
  } else {
    lines.push('Handoff from "' + node.title + '" (' + node.source + ", " + (node.projectLabel || "no folder") + ").");
    lines.push("You are picking this up in a new chat. The original conversation stays open.");
  }
  if (note) {
    lines.push("", "Note:", note);
  }
  if (mode !== "context" && latestYou) {
    lines.push("", "Last request:", latestYou.text);
  }
  if (mode !== "context" && latestAgent) {
    lines.push("", "Last reply:", latestAgent.text);
  }
  if (mode === "topic") {
    lines.push("", "New topic:", "");
  }
  return lines.join("\n").slice(0, 8000);
}

module.exports = { buildModel, draftText };
