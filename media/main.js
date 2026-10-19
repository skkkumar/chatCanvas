(() => {
  const vscodeApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  const NODE_W = 280;
  const NODE_H = 200;
  const GAP = 16;
  const ORIGIN = 36;
  const COL_W = NODE_W + GAP;
  const ROW_H = NODE_H + GAP;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const MUTATE = new Set([
    "move", "meta", "scope", "flags", "spawn", "note", "link", "unlink",
    "group", "renameGroup", "ungroup", "leaveGroup", "deleteCustom", "hide", "unhide",
  ]);
  const STATUS = {
    running: "Running",
    "needs-you": "Needs you",
    plan: "Plan waiting",
    unread: "Unread",
    archived: "Archived",
    draft: "Draft",
    idle: "Idle",
  };
  const CURSOR_LOGO = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.2 13.6 4.4 8 7.6 2.4 4.4 8 1.2z"/><path fill="currentColor" opacity=".45" d="M2.4 4.4 8 7.6v6.8L2.4 11.2V4.4z"/><path fill="currentColor" opacity=".75" d="M13.6 4.4 8 7.6v6.8l5.6-3.2V4.4z"/></svg>';
  const CLAUDE_LOGO = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="#D97757" d="M8 .8 9.15 5.7 14.2 4.2 10.6 8l3.6 3.8-5.05-1.5L8 15.2l-1.15-4.9L1.8 11.8 5.4 8 1.8 4.2l5.05 1.5z"/></svg>';
  const KIND_LABEL = {
    related: "Related",
    fork: "Fork",
    handover: "Handoff",
    context: "Context",
    topic: "New topic",
  };

  const app = document.getElementById("app");
  let model = { nodes: [], groups: [], links: [], scope: "workspace", showHidden: false, showSubagents: false, warnings: [], workspace: "" };
  let cam = { x: 48, y: 28, z: 1 };
  let localRev = 0;
  let booted = false;
  let selected = new Set();
  let selectedLink = null;
  let inspectorFor = "";
  let pointersDown = 0;
  let pending = null;
  let search = "";
  let linking = null;
  let metaTimer = null;
  let clickOpenTimer = null;
  let promptOpen = false;

  const shell = el("div", "shell");
  const banner = el("div", "banner");
  banner.hidden = true;
  const top = el("header", "top topbar");
  const brand = el("b", "wordmark");
  brand.append(document.createTextNode("canvas"), el("span", "caret"));
  const waitingBadge = el("span", "wbadge");
  waitingBadge.hidden = true;
  waitingBadge.append(el("span", "wdot"), el("span", "wcount"));
  const workingBadge = el("span", "gbadge");
  workingBadge.hidden = true;
  workingBadge.append(el("span", "gdot"), el("span", "gcount"));
  const searchBox = el("input");
  searchBox.id = "search";
  searchBox.placeholder = "Find";
  const plusBtn = el("button", "top-btn");
  plusBtn.id = "topPlus";
  plusBtn.append(document.createTextNode("+ agent"));
  const gearBtn = el("button", "top-btn ghost icon-btn", "⚙");
  gearBtn.title = "Board tools";
  const ver = el("span", "ver", "v0.1.0");
  top.append(brand, waitingBadge, workingBadge, el("span", "sp"), searchBox, plusBtn, gearBtn, ver);

  let mapFor = "";
  const stage = el("div", "stage");
  const viewport = el("div");
  viewport.id = "viewport";
  const world = el("div");
  world.id = "world";
  const grid = el("div");
  grid.id = "grid";
  const linksSvg = document.createElementNS(SVG_NS, "svg");
  linksSvg.id = "links";
  world.append(grid, linksSvg);
  viewport.append(world);
  const empty = el("div", "empty");
  const emptyHint = el("p");
  const emptyPlus = el("button", "empty-plus", "+ agent");
  emptyPlus.addEventListener("click", () => openAgentMenu(plusBtn));
  emptyHint.append(document.createTextNode("Hit "), emptyPlus, document.createTextNode(" — pick Cursor or Claude. The chat appears as a tile and blinks when it needs you."));
  empty.append(el("p", "", "The board is empty."), emptyHint);
  viewport.append(empty);
  const inspector = el("aside");
  inspector.id = "inspector";
  const panelBar = el("div", "panel-bar");
  const panelToggle = el("button", "panel-toggle", "›");
  panelToggle.title = "Hide the list";
  const groupBtn = el("button", "panel-group", "Group");
  groupBtn.title = "Group the selected tiles. Shift-click to select more than one.";
  groupBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    groupSelection();
  });
  panelBar.append(el("span", "", "Chats"), groupBtn, panelToggle);
  const chatList = el("div", "chat-list");
  inspector.append(panelBar, chatList);
  let panelOpen = true;
  function setPanel(open) {
    panelOpen = open;
    inspector.classList.toggle("collapsed", !open);
    panelToggle.textContent = open ? "›" : "‹";
    panelToggle.title = open ? "Hide the list" : "Show the list";
  }
  panelToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setPanel(!panelOpen);
  });
  inspector.addEventListener("click", () => {
    if (!panelOpen) setPanel(true);
  });
  const mapLayer = el("div", "mindmap");
  mapLayer.hidden = true;
  stage.append(viewport, inspector, mapLayer);
  const toastEl = el("div");
  toastEl.id = "toast";
  const menu = el("div", "menu hidden");
  const promptLayer = el("form", "prompt-layer hidden");
  const promptCard = el("div", "prompt-card");
  const promptHead = el("div", "prompt-head");
  const promptLogo = el("span", "logo");
  const promptTitle = el("strong");
  const promptClose = el("button", "close-bubble", "×");
  promptClose.type = "button";
  promptClose.title = "Close";
  promptHead.append(promptLogo, promptTitle, promptClose);
  const promptInput = document.createElement("textarea");
  promptInput.placeholder = "Message this chat";
  promptInput.rows = 4;
  const promptActions = el("div", "prompt-actions");
  const promptHint = el("span", "", "Ctrl+Enter to send");
  const promptSend = el("button", "primary", "Send");
  promptSend.type = "submit";
  promptActions.append(promptHint, promptSend);
  promptCard.append(promptHead, promptInput, promptActions);
  promptLayer.append(promptCard);
  shell.append(banner, top, stage, toastEl, menu, promptLayer);
  app.append(shell);

  const nodeEls = new Map();
  const groupEls = new Map();

  searchBox.addEventListener("input", () => {
    search = searchBox.value.trim().toLowerCase();
    render();
  });
  plusBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openAgentMenu(plusBtn);
  });
  gearBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const rect = gearBtn.getBoundingClientRect();
    openMenu(rect.right - 200, rect.bottom + 8, [
      { label: "Note", run: () => post("note", { x: viewport.scrollLeft + ORIGIN, y: viewport.scrollTop + ORIGIN }) },
      { label: "Group selection", run: groupSelection },
      { label: "Refresh", run: () => post("refresh") },
      { label: model.showHidden ? "Hide removed tiles" : "Show removed tiles", run: () => post("flags", { showHidden: !model.showHidden }) },
      { label: model.showSubagents ? "Hide subagents" : "Show subagents", run: () => post("flags", { showSubagents: !model.showSubagents }) },
      { label: "Open large", run: () => post("expand") },
    ]);
  });

  function openAgentMenu(anchor) {
    const rect = anchor.getBoundingClientRect();
    openMenu(rect.left, rect.bottom + 8, [
      { label: "Cursor chat", run: () => post("newChat", Object.assign({ host: "cursor" }, viewCenter())) },
      { label: "Claude chat", run: () => post("newChat", Object.assign({ host: "claude" }, viewCenter())) },
    ]);
  }

  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target !== viewport) return;
    hideMenu();
    selected.clear();
    selectedLink = null;
    inspectorFor = "";
    markSelection();
    renderInspector();
  });

  viewport.addEventListener("dblclick", (event) => {
    if (event.button !== 0 || event.target !== viewport) return;
    const point = worldPoint(event);
    openMenu(event.clientX, event.clientY, [
      { label: "Cursor chat", run: () => post("newChat", { host: "cursor", x: point.x - 124, y: point.y - 36 }) },
      { label: "Claude chat", run: () => post("newChat", { host: "claude", x: point.x - 124, y: point.y - 36 }) },
    ]);
  });

  window.addEventListener("pointermove", (event) => {
    if (!linking) return;
    drawLinks(worldPoint(event));
  });
  window.addEventListener("pointerup", (event) => {
    if (!linking) return;
    const from = linking.from;
    const point = { x: event.clientX, y: event.clientY };
    linking = null;
    drawLinks();
    const hit = document.elementFromPoint(point.x, point.y);
    const bubble = hit && hit.closest ? hit.closest(".bubble") : null;
    if (!bubble || bubble.dataset.id === from) return;
    openMenu(point.x, point.y, Object.entries(KIND_LABEL).map(([kind, label]) => ({
      label,
      run: () => post("link", { from, to: bubble.dataset.id, kind }),
    })));
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (promptOpen) {
        closePrompt();
        return;
      }
      if (mapFor) {
        closeMindMap();
        return;
      }
      hideMenu();
      selected.clear();
      selectedLink = null;
      linking = null;
      render();
      renderInspector();
    }
    if (event.key === "Delete" && document.activeElement && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
      if (selectedLink) post("unlink", { id: selectedLink });
      else if (selected.size === 1) {
        const node = nodeById([...selected][0]);
        if (node && node.custom) post("deleteCustom", { id: node.id });
      }
    }
  });
  window.addEventListener("pointerdown", (event) => {
    if (!menu.contains(event.target)) hideMenu();
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "toast") toast(msg.text);
    else if (msg.type === "preview") showPreview(msg);
    else if (msg.type === "pulse") applyPulse(msg);
    else if (msg.type === "state") applyState(msg);
  });

  function post(type, extra) {
    const msg = Object.assign({ type }, extra || {});
    if (MUTATE.has(type)) {
      localRev += 1;
      msg.rev = localRev;
    }
    if (vscodeApi) vscodeApi.postMessage(msg);
  }

  function applyState(msg) {
    if (typeof msg.rev === "number" && msg.rev < localRev) {
      mergeHost(msg.nodes || []);
      render();
      return;
    }
    if (typeof msg.rev === "number") localRev = msg.rev;
    if (!booted) {
      if (msg.camera) cam = { x: num(msg.camera.x, 48), y: num(msg.camera.y, 28), z: num(msg.camera.z, 1) };
      booted = true;
    }
    if (pointersDown) {
      pending = msg;
      return;
    }
    model = {
      nodes: msg.nodes || [],
      groups: msg.groups || [],
      links: msg.links || [],
      scope: msg.scope || "workspace",
      showHidden: !!msg.showHidden,
      showSubagents: !!msg.showSubagents,
      warnings: msg.warnings || [],
      workspace: msg.workspace || "",
    };
    if (msg.select) {
      selected = new Set([msg.select]);
      selectedLink = null;
      inspectorFor = "";
    }
    render();
    renderInspector();
  }

  function placeholderTitle(title) {
    return !title || title === "New Claude chat" || title === "New Cursor chat" || title === "New chat" || title === "Claude session" || title === "Untitled Cursor chat";
  }

  function applyPulse(msg) {
    const node = model.nodes.find((item) => item.id === msg.id || (msg.sessionId && (item.sessionId === msg.sessionId || item.externalId === msg.sessionId)));
    if (!node) return;
    if (msg.status) node.status = msg.status;
    if (typeof msg.updatedAt === "number" && msg.updatedAt) node.updatedAt = msg.updatedAt;
    if (msg.title && !node.titleOverride && (msg.trustTitle || node.opening || placeholderTitle(node.title))) {
      node.title = msg.title;
      node.baseTitle = msg.title;
    }
    const bubble = nodeEls.get(node.id);
    if (bubble) fillBubble(bubble, node);
    renderChatList();
  }

  function mergeHost(nodes) {
    for (const incoming of nodes) {
      if (!incoming || incoming.custom) continue;
      const current = nodeById(incoming.id);
      if (!current) {
        model.nodes.push(incoming);
        continue;
      }
      current.status = incoming.status;
      current.subtitle = incoming.subtitle;
      current.updatedAt = incoming.updatedAt;
      current.inWorkspace = incoming.inWorkspace;
      current.filesChanged = incoming.filesChanged;
      current.baseTitle = incoming.baseTitle || incoming.title;
      if (!current.titleOverride) current.title = incoming.title;
    }
  }

  function flushPending() {
    if (pending && pointersDown === 0) {
      const next = pending;
      pending = null;
      applyState(next);
    }
  }

  function render() {
    banner.hidden = !(model.warnings && model.warnings.length);
    banner.textContent = (model.warnings || []).join(" ");
    const visible = model.nodes.filter(isShown);
    const waiting = visible.filter((node) => node.status === "needs-you" || node.status === "unread" || node.status === "plan").length;
    const running = visible.filter((node) => node.status === "running").length;
    waitingBadge.hidden = waiting === 0;
    waitingBadge.querySelector(".wcount").textContent = waiting + " waiting";
    workingBadge.hidden = running === 0;
    workingBadge.querySelector(".gcount").textContent = running + " working";
    top.classList.toggle("busy", running > 0);
    top.classList.toggle("st-work", running > 0 && waiting === 0);
    top.classList.toggle("st-mix", running > 0 && waiting > 0);
    empty.hidden = visible.length > 0;
    layoutGrid();
    renderChatList();
    renderGroups();
    renderNodes();
    drawLinks();
    markSelection();
  }

  function isShown(node) {
    if (!node) return false;
    if (node.hidden && !model.showHidden) return false;
    if (!node.inWorkspace && !node.custom) return false;
    return true;
  }

  function matchesSearch(node) {
    if (!search) return true;
    const hay = [node.title, node.baseTitle, node.subtitle, node.projectLabel, node.project, node.note, node.body, ...(node.tags || [])].join(" ").toLowerCase();
    return hay.includes(search);
  }

  function columns() {
    return Math.max(1, Math.floor((viewport.clientWidth - ORIGIN) / COL_W));
  }

  function cellOf(x, y) {
    return {
      col: Math.max(0, Math.round((x - ORIGIN) / COL_W)),
      row: Math.max(0, Math.round((y - ORIGIN) / ROW_H)),
    };
  }

  function cellOrigin(col, row) {
    return { x: ORIGIN + col * COL_W, y: ORIGIN + row * ROW_H };
  }

  function clampCell(cell, cols) {
    let col = Math.max(0, cell.col);
    let row = Math.max(0, cell.row);
    if (col >= cols) {
      row += Math.floor(col / cols);
      col = col % cols;
    }
    return { col, row };
  }

  function byReading(a, b) {
    const ca = cellOf(a.x, a.y);
    const cb = cellOf(b.x, b.y);
    return ca.row - cb.row || ca.col - cb.col || String(a.id).localeCompare(String(b.id));
  }

  function readingOrder() {
    return model.nodes.filter(isShown).slice().sort(byReading);
  }

  function slotOrigin(index, cols) {
    return cellOrigin(index % cols, Math.floor(index / cols));
  }

  function withInsertion(order, moverIds, x, y, cols) {
    const moving = order.filter((node) => moverIds.has(node.id));
    const rest = order.filter((node) => !moverIds.has(node.id));
    const cell = clampCell(cellOf(x, y), cols);
    let to = cell.row * cols + cell.col;
    if (to < 0) to = 0;
    if (to >= order.length) to = rest.length;
    else if (to > rest.length) to = rest.length;
    const placed = rest.slice();
    placed.splice(to, 0, ...moving);
    return placed;
  }

  function writeSlots(placed, cols, skipIds) {
    let changed = false;
    placed.forEach((node, index) => {
      if (skipIds && skipIds.has(node.id)) return;
      const origin = slotOrigin(index, cols);
      if (node.x !== origin.x || node.y !== origin.y) {
        node.x = origin.x;
        node.y = origin.y;
        changed = true;
      }
      const bubble = nodeEls.get(node.id);
      if (bubble) {
        bubble.style.left = node.x + "px";
        bubble.style.top = node.y + "px";
      }
    });
    return changed;
  }

  function syncGroups(placed, cols) {
    const slot = new Map(placed.map((node, index) => [node.id, slotOrigin(index, cols)]));
    for (const group of model.groups) {
      const members = placed.filter((node) => node.groupId === group.id);
      if (members.length < 2) continue;
      const cells = members.map((node) => cellOf(slot.get(node.id).x, slot.get(node.id).y));
      const minCol = Math.min(...cells.map((cell) => cell.col));
      const maxCol = Math.max(...cells.map((cell) => cell.col));
      const minRow = Math.min(...cells.map((cell) => cell.row));
      const maxRowGroup = Math.max(...cells.map((cell) => cell.row));
      const origin = cellOrigin(minCol, minRow);
      group.x = origin.x - 10;
      group.y = origin.y - 28;
      group.width = (maxCol - minCol + 1) * COL_W - GAP + 20;
      group.height = (maxRowGroup - minRow + 1) * ROW_H - GAP + 40;
      const box = groupEls.get(group.id);
      if (!box) continue;
      box.style.left = group.x + "px";
      box.style.top = group.y + "px";
      box.style.width = group.width + "px";
      box.style.height = group.height + "px";
    }
  }

  function layoutGrid() {
    if (pointersDown) return;
    if (viewport.clientWidth < COL_W) return;
    const cols = columns();
    const shown = readingOrder();
    const changed = writeSlots(shown, cols);
    const rows = shown.length ? Math.ceil(shown.length / cols) : 1;
    world.style.width = Math.max(viewport.clientWidth, ORIGIN + cols * COL_W) + "px";
    world.style.height = Math.max(viewport.clientHeight, ORIGIN + rows * ROW_H + 24) + "px";
    grid.style.left = "0";
    grid.style.top = "0";
    grid.style.width = "100%";
    grid.style.height = "100%";
    syncGroups(shown, cols);
    if (changed && !document.body.classList.contains("sidebar")) {
      post("move", { spots: shown.map((node) => ({ id: node.id, x: node.x, y: node.y })) });
    }
  }

  function renderGroups() {
    const keep = new Set();
    for (const group of model.groups) {
      const members = model.nodes.filter((node) => node.groupId === group.id && isShown(node));
      if (members.length < 2) continue;
      keep.add(group.id);
      let box = groupEls.get(group.id);
      if (!box) {
        box = el("section", "group");
        const name = el("input", "group-name");
        name.addEventListener("pointerdown", (event) => event.stopPropagation());
        name.addEventListener("change", () => post("renameGroup", { id: group.id, name: name.value }));
        box.append(name);
        world.append(box);
        groupEls.set(group.id, box);
      }
      box.style.left = group.x + "px";
      box.style.top = group.y + "px";
      box.style.width = group.width + "px";
      box.style.height = group.height + "px";
      const name = box.querySelector(".group-name");
      if (document.activeElement !== name) name.value = group.name || "Group";
    }
    for (const [id, box] of groupEls) {
      if (!keep.has(id)) {
        box.remove();
        groupEls.delete(id);
      }
    }
  }

  function renderNodes() {
    const keep = new Set();
    for (const node of model.nodes) {
      if (!isShown(node)) continue;
      keep.add(node.id);
      let bubble = nodeEls.get(node.id);
      if (!bubble) {
        bubble = buildBubble(node.id);
        world.append(bubble);
        nodeEls.set(node.id, bubble);
      }
      fillBubble(bubble, node);
    }
    for (const [id, bubble] of nodeEls) {
      if (!keep.has(id)) {
        bubble.remove();
        nodeEls.delete(id);
      }
    }
  }

  function buildBubble(id) {
    const bubble = el("article", "bubble acard");
    bubble.dataset.id = id;
    bubble.tabIndex = 0;
    const head = el("header", "acard-head");
    const logo = el("span", "logo");
    const name = el("div", "name");
    name.append(el("span", "ntext"));
    const status = el("span", "statusline");
    status.append(el("span", "st idle"), el("span", "slabel", "Idle"));
    const handle = el("button", "link-handle", "↗");
    handle.title = "Drag onto another tile to link them";
    handle.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      event.preventDefault();
      linking = { from: id };
    });
    const closeBtn = el("button", "close-bubble", "×");
    closeBtn.title = "Close this tile";
    closeBtn.addEventListener("pointerdown", (event) => event.stopPropagation());
    closeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      closeBubble(id);
    });
    head.append(logo, name, status, handle, closeBtn);
    const body = el("div", "acard-body");
    const tags = el("div", "tags");
    const actions = el("div", "acard-actions");
    const mapBtn = el("button", "map-btn", "Mind map");
    mapBtn.addEventListener("pointerdown", (event) => event.stopPropagation());
    mapBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openMindMap(id);
    });
    const openBtn = el("button", "primary", "Open");
    openBtn.addEventListener("pointerdown", (event) => event.stopPropagation());
    openBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openNode(id);
    });
    actions.append(mapBtn, openBtn);
    bubble.append(head, body, tags, actions);
    bubble.addEventListener("pointerdown", (event) => beginNodeDrag(event, id));
    bubble.addEventListener("dblclick", (event) => {
      if (event.target.closest(".acard-actions, .close-bubble, .link-handle")) return;
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(clickOpenTimer);
      openPrompt(id);
    });
    bubble.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (!selected.has(id)) {
        selected = new Set([id]);
        selectedLink = null;
        markSelection();
        renderInspector();
      }
      const items = [
        { label: "Open", run: () => post("open", { id }) },
        { label: "Mind map", run: () => openMindMap(id) },
        { label: "Fork", run: () => post("spawn", { id, mode: "fork" }) },
        { label: "Hand over", run: () => post("spawn", { id, mode: "handover" }) },
        { label: "New topic", run: () => post("spawn", { id, mode: "topic" }) },
      ];
      const node = nodeById(id);
      if (node && node.custom) items.push({ label: "Delete", run: () => post("deleteCustom", { id }) });
      else items.push({ label: "Hide from map", run: () => post("hide", { id }) });
      items.push({ label: "Group selection", run: groupSelection });
      if (node && node.groupId) {
        items.push({ label: "Remove from group", run: () => post("leaveGroup", { id }) });
        items.push({ label: "Ungroup", run: () => post("ungroup", { id: node.groupId }) });
      }
      openMenu(event.clientX, event.clientY, items);
    });
    return bubble;
  }

  function fillBubble(bubble, node) {
    const kind = statusKind(node);
    bubble.className = "bubble acard source-" + node.source + " status-" + (node.status || "idle") + (kind === "working" ? " working" : "") + (kind === "waiting" ? " waiting" : "") + (kind === "parked" ? " parked" : "") + (node.hidden ? " hidden-node" : "") + (matchesSearch(node) ? "" : " dim") + (selected.has(node.id) ? " selected" : "");
    const logo = bubble.querySelector(".logo");
    logo.className = "logo logo-" + (node.source === "claude" ? "claude" : "cursor");
    logo.title = sourceLabel(node);
    logo.innerHTML = node.source === "claude" ? CLAUDE_LOGO : CURSOR_LOGO;
    bubble.querySelector(".ntext").textContent = node.title || "Untitled";
    const st = bubble.querySelector(".statusline .st");
    st.className = "st " + kind;
    bubble.querySelector(".slabel").textContent = (STATUS[node.status] || "Idle") + " · " + ago(node.updatedAt);
    const body = bubble.querySelector(".acard-body");
    body.textContent = node.subtitle || node.note || (STATUS[node.status] || "Idle");
    const tags = bubble.querySelector(".tags");
    tags.replaceChildren();
    if (node.userStatus) tags.append(el("span", "tag", node.userStatus));
    if (node.filesChanged) tags.append(el("span", "tag", node.filesChanged + " files"));
    for (const tag of node.tags || []) tags.append(el("span", "tag", tag));
    const mapBtn = bubble.querySelector(".map-btn");
    if (mapBtn) mapBtn.hidden = node.source !== "cursor" && node.source !== "claude";
    const openBtn = bubble.querySelector(".primary");
    if (openBtn) openBtn.hidden = node.source !== "cursor" && node.source !== "claude";
    bubble.style.left = node.x + "px";
    bubble.style.top = node.y + "px";
  }

  function beginNodeDrag(event, id) {
    if (event.button !== 0 || event.target.closest(".link-handle, .close-bubble, .acard-actions")) return;
    clearTimeout(clickOpenTimer);
    event.stopPropagation();
    hideMenu();
    const node = nodeById(id);
    if (!node) return;
    if (event.shiftKey) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
    } else if (!selected.has(id)) {
      selected = new Set([id]);
    }
    selectedLink = null;
    markSelection();
    renderInspector();
    const movers = [...selected].map(nodeById).filter((item) => item && isShown(item));
    if (!movers.length) return;
    const dragOrder = readingOrder();
    const homeSpots = new Map(dragOrder.map((entry) => [entry.id, { x: entry.x, y: entry.y, groupId: entry.groupId || "" }]));
    const origins = new Map(movers.map((item) => [item.id, homeSpots.get(item.id)]));
    const moverIds = new Set(movers.map((item) => item.id));
    const start = { x: event.clientX, y: event.clientY, moved: false, shift: event.shiftKey };
    pointersDown += 1;
    const move = (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (Math.hypot(dx, dy) > 4) start.moved = true;
      if (!start.moved) return;
      for (const item of movers) {
        const origin = origins.get(item.id);
        item.x = origin.x + dx;
        item.y = origin.y + dy;
        const bubble = nodeEls.get(item.id);
        if (bubble) {
          bubble.classList.add("dragging");
          bubble.style.left = item.x + "px";
          bubble.style.top = item.y + "px";
        }
      }
      const cols = columns();
      const placed = withInsertion(dragOrder, moverIds, node.x, node.y, cols);
      writeSlots(placed, cols, moverIds);
      syncGroups(placed, cols);
      drawLinks();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      pointersDown -= 1;
      for (const item of movers) {
        const bubble = nodeEls.get(item.id);
        if (bubble) bubble.classList.remove("dragging");
      }
      if (start.moved) commitInsertion(dragOrder, node, homeSpots, moverIds);
      else if (!start.shift && selected.size === 1 && selected.has(id) && (node.source === "cursor" || node.source === "claude")) {
        clearTimeout(clickOpenTimer);
        clickOpenTimer = setTimeout(() => openNode(id), 280);
      }
      flushPending();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function commitInsertion(dragOrder, anchor, homeSpots, moverIds) {
    const cols = columns();
    const placed = withInsertion(dragOrder, moverIds, anchor.x, anchor.y, cols);
    writeSlots(placed, cols);
    const movers = dragOrder.filter((entry) => moverIds.has(entry.id));
    for (const item of movers) {
      const previous = homeSpots.get(item.id);
      if (!previous || !previous.groupId) continue;
      const members = dragOrder.filter((entry) => homeSpots.get(entry.id).groupId === previous.groupId);
      const home = members.map((entry) => cellOf(homeSpots.get(entry.id).x, homeSpots.get(entry.id).y));
      if (home.length > 1 && !insideCells(cellOf(item.x, item.y), home)) {
        item.groupId = "";
        post("leaveGroup", { id: item.id });
      }
    }
    post("move", { spots: placed.map((entry) => ({ id: entry.id, x: entry.x, y: entry.y })) });
    render();
  }

  function insideCells(cell, cells) {
    const minCol = Math.min(...cells.map((item) => item.col));
    const maxCol = Math.max(...cells.map((item) => item.col));
    const minRow = Math.min(...cells.map((item) => item.row));
    const maxRow = Math.max(...cells.map((item) => item.row));
    return cell.col >= minCol && cell.col <= maxCol && cell.row >= minRow && cell.row <= maxRow;
  }

  function drawLinks(cursor) {
    linksSvg.replaceChildren();
    const visible = new Set(model.nodes.filter(isShown).map((node) => node.id));
    for (const link of model.links) {
      if (!visible.has(link.from) || !visible.has(link.to)) continue;
      const from = nodeById(link.from);
      const to = nodeById(link.to);
      if (!from || !to) continue;
      linksSvg.append(linkPath(center(from), center(to), "link kind-" + link.kind + (selectedLink === link.id ? " selected" : ""), () => {
        selectedLink = link.id;
        selected.clear();
        inspectorFor = "";
        markSelection();
        renderInspector();
        drawLinks();
      }));
    }
    if (linking) {
      const from = nodeById(linking.from);
      if (from && cursor) linksSvg.append(linkPath(center(from), cursor, "link kind-related"));
    }
  }

  function linkPath(from, to, className, onClick) {
    const path = document.createElementNS(SVG_NS, "path");
    const mid = (from.x + to.x) / 2;
    path.setAttribute("d", "M " + from.x + " " + from.y + " C " + mid + " " + from.y + ", " + mid + " " + to.y + ", " + to.x + " " + to.y);
    path.setAttribute("class", className);
    if (onClick) path.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
    return path;
  }

  function statusKind(node) {
    if (!node) return "idle";
    if (node.status === "running") return "working";
    if (node.status === "needs-you" || node.status === "unread" || node.status === "plan") return "waiting";
    if (node.status === "archived") return "parked";
    return "idle";
  }

  function inScope(node) {
    if (!node) return false;
    if (!node.inWorkspace && !node.custom) return false;
    return true;
  }

  function listChats() {
    return model.nodes
      .filter((node) => (node.source === "cursor" || node.source === "claude") && !node.opening && (model.showSubagents || !node.subagent))
      .filter(inScope)
      .filter(matchesSearch)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function closeBubble(id) {
    const node = nodeById(id);
    if (node) node.hidden = true;
    if (selected.has(id)) selected.delete(id);
    selectedLink = null;
    inspectorFor = "";
    post("hide", { id });
    render();
    renderInspector();
  }

  function restoreChat(id, x, y) {
    const node = nodeById(id);
    if (node) {
      node.hidden = false;
      if (typeof x === "number") node.x = x;
      if (typeof y === "number") node.y = y;
    }
    post("unhide", { id, x, y });
    render();
    focusChat(id);
  }

  function renderChatList() {
    chatList.replaceChildren();
    const rows = listChats();
    if (!rows.length) {
      chatList.append(el("p", "chat-none", "No chats in this project yet."));
      return;
    }
    const byGroup = new Map();
    const loose = [];
    for (const node of rows) {
      const group = node.groupId && model.groups.find((item) => item.id === node.groupId);
      if (!group) loose.push(node);
      else {
        if (!byGroup.has(group.id)) byGroup.set(group.id, []);
        byGroup.get(group.id).push(node);
      }
    }
    for (const node of loose) chatList.append(chatRow(node));
    for (const group of model.groups) {
      const members = byGroup.get(group.id);
      if (!members || !members.length) continue;
      const head = el("div", "group-head");
      head.append(el("span", "", group.name || "Group"));
      const remove = el("button", "ungroup", "Ungroup");
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        post("ungroup", { id: group.id });
      });
      head.append(remove);
      chatList.append(head);
      for (const node of members) chatList.append(chatRow(node));
    }
  }

  function chatRow(node) {
    const kind = statusKind(node);
    const row = el("div", "chat-row" + (selected.has(node.id) ? " selected" : "") + (node.hidden ? " off-board" : ""));
    const logo = el("span", "logo logo-" + (node.source === "claude" ? "claude" : "cursor"));
    logo.title = sourceLabel(node);
    logo.innerHTML = node.source === "claude" ? CLAUDE_LOGO : CURSOR_LOGO;
    const st = el("span", "st " + kind);
    const text = el("span", "chat-copy");
    const meta = node.hidden ? "Off the board" : (STATUS[node.status] || "Idle");
    text.append(el("span", "t", node.title || "Untitled"), el("span", "m", meta));
    row.append(logo, st, text);
    if (node.hidden) {
      const pull = el("button", "pull", "Show");
      pull.title = "Put this tile back on the board";
      pull.addEventListener("click", (event) => {
        event.stopPropagation();
        restoreChat(node.id);
      });
      row.append(pull);
    } else if (node.groupId) {
      const leave = el("button", "leave", "Remove");
      leave.title = "Remove from group";
      leave.addEventListener("click", (event) => {
        event.stopPropagation();
        node.groupId = "";
        post("leaveGroup", { id: node.id });
        render();
      });
      row.append(leave);
    }
    row.addEventListener("pointerdown", (event) => beginPull(event, node));
    row.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(clickOpenTimer);
      if (node.hidden) restoreChat(node.id);
      openPrompt(node.id);
    });
    return row;
  }

  function beginPull(event, node) {
    if (event.button !== 0 || event.target.closest(".pull, .leave")) return;
    if (event.shiftKey) {
      if (selected.has(node.id)) selected.delete(node.id);
      else selected.add(node.id);
      selectedLink = null;
      markSelection();
      renderChatList();
      return;
    }
    const start = { x: event.clientX, y: event.clientY };
    let dragging = false;
    let ghost = null;
    const move = (ev) => {
      if (!node.hidden) return;
      if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      dragging = true;
      if (!ghost) {
        ghost = el("div", "pull-ghost", node.title || "Chat");
        document.body.append(ghost);
      }
      ghost.style.left = ev.clientX + 10 + "px";
      ghost.style.top = ev.clientY + 10 + "px";
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (ghost) ghost.remove();
      if (!dragging) {
        if (node.hidden) restoreChat(node.id);
        else {
          clearTimeout(clickOpenTimer);
          clickOpenTimer = setTimeout(() => focusChat(node.id), 280);
        }
        return;
      }
      const rect = viewport.getBoundingClientRect();
      const inside = ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
      if (!inside) return;
      const x = ev.clientX - rect.left + viewport.scrollLeft - NODE_W / 2;
      const y = ev.clientY - rect.top + viewport.scrollTop - 36;
      restoreChat(node.id, x, y);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function focusChat(id) {
    selected = new Set([id]);
    selectedLink = null;
    inspectorFor = "";
    markSelection();
    renderInspector();
    const bubble = nodeEls.get(id);
    if (bubble) bubble.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function renderInspector() {
    renderChatList();
  }

  function openMindMap(id) {
    const node = nodeById(id);
    if (!node || (node.source !== "cursor" && node.source !== "claude")) return;
    mapFor = id;
    renderMindMap(node, null);
    post("preview", { id });
  }

  function topicsFrom(turns) {
    const topics = [];
    let current = null;
    for (const turn of turns) {
      const text = String(turn.text || "").trim();
      if (!text) continue;
      if (turn.role === "you") {
        current = { you: text, agent: "", files: [] };
        topics.push(current);
      } else if (current) {
        current.agent = text;
        current.files = filesIn(text);
      } else {
        current = { you: "", agent: text, files: filesIn(text) };
        topics.push(current);
      }
    }
    return topics.slice(-12);
  }

  function filesIn(text) {
    const found = new Set();
    const re = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8}/g;
    let match;
    while ((match = re.exec(text))) found.add(match[0]);
    return [...found].slice(0, 4);
  }

  function closeMindMap() {
    mapFor = "";
    mapLayer.hidden = true;
    mapLayer.replaceChildren();
  }

  function pointsFrom(text) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return [];
    const parts = clean.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter((part) => part.length > 12);
    return (parts.length ? parts : [clean]).slice(0, 3).map((part) => (part.length > 160 ? part.slice(0, 157).trimEnd() + "…" : part));
  }

  function layoutMind(title, topics) {
    const bands = topics.map((topic) => {
      const rights = [
        ...pointsFrom(topic.agent).map((text) => ({ kind: "agent", text })),
        ...topic.files.map((text) => ({ kind: "file", text })),
      ];
      if (!rights.length) rights.push({ kind: "empty", text: "No reply yet" });
      const height = rights.reduce((sum, item) => sum + (item.kind === "file" || item.kind === "empty" ? 36 : 68), 0) + (rights.length - 1) * 8;
      return { topic, rights, height: Math.max(76, height) };
    });
    const nodes = [];
    let y = 28;
    for (const band of bands) {
      nodes.push({ kind: "you", text: band.topic.you || "Agent started", x: 24, y: y + Math.max(0, (band.height - 76) / 2), w: 250, h: 76 });
      let rightY = y;
      for (const right of band.rights) {
        const h = right.kind === "agent" ? 68 : 32;
        const w = right.kind === "file" ? 230 : 280;
        nodes.push({ ...right, x: 760, y: rightY, w, h });
        rightY += h + 8;
      }
      y += band.height + 26;
    }
    const height = Math.max(420, y + 16);
    nodes.unshift({ kind: "root", text: title || "Untitled", x: 390, y: Math.max(24, height / 2 - 42), w: 240, h: 84 });
    return { nodes, width: 1080, height };
  }

  function mindCurve(x1, y1, x2, y2) {
    const bend = (x1 + x2) / 2;
    return "M " + x1 + " " + y1 + " C " + bend + " " + y1 + ", " + bend + " " + y2 + ", " + x2 + " " + y2;
  }

  function renderMindMap(node, turns) {
    mapLayer.hidden = false;
    mapLayer.replaceChildren();
    const bar = el("div", "mind-bar");
    const back = el("button", "", "Board");
    back.addEventListener("click", closeMindMap);
    const open = el("button", "", "Open chat");
    open.addEventListener("click", () => openNode(node.id));
    bar.append(back, el("strong", "", node.title || "Untitled"), el("span", "", sourceLabel(node) + " · topics on the left, agent points and files on the right"), open);
    mapLayer.append(bar);

    const canvas = el("div", "mind-canvas");
    if (!turns) {
      canvas.append(el("p", "lede", "Reading this chat…"));
      mapLayer.append(canvas);
      return;
    }
    const topics = topicsFrom(turns);
    if (!topics.length) {
      canvas.append(el("p", "lede", "This chat has no transcript text yet. Open it to start the conversation."));
      mapLayer.append(canvas);
      return;
    }
    const laid = layoutMind(node.title, topics);
    const world = el("div", "mind-world");
    world.style.width = laid.width + "px";
    world.style.height = laid.height + "px";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "mind-links");
    const root = laid.nodes[0];
    for (const item of laid.nodes.slice(1)) {
      if (item.kind === "empty") continue;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const fromLeft = item.x < root.x;
      const x1 = fromLeft ? item.x + item.w : root.x + root.w;
      const y1 = fromLeft ? item.y + item.h / 2 : root.y + root.h / 2;
      const x2 = fromLeft ? root.x : item.x;
      const y2 = fromLeft ? root.y + root.h / 2 : item.y + item.h / 2;
      path.setAttribute("d", mindCurve(x1, y1, x2, y2));
      path.setAttribute("class", "mind-link kind-" + item.kind);
      svg.append(path);
    }
    world.append(svg);
    for (const item of laid.nodes) {
      const piece = item.kind === "empty" ? el("span", "mind-empty", item.text) : el("button", "mind-node " + item.kind);
      piece.style.left = item.x + "px";
      piece.style.top = item.y + "px";
      piece.style.width = item.w + "px";
      if (item.kind !== "empty") {
        piece.textContent = item.text;
        piece.addEventListener("click", () => openNode(node.id));
      }
      world.append(piece);
    }
    canvas.append(world);
    mapLayer.append(canvas);
  }

  function showPreview(msg) {
    if (mapFor === msg.id) {
      const node = nodeById(msg.id);
      if (node) renderMindMap(node, msg.turns || []);
    }
    if (inspectorFor !== msg.id) return;
    const box = document.getElementById("turns");
    if (!box) return;
    box.replaceChildren();
    const turns = msg.turns || [];
    if (!turns.length) {
      box.append(el("p", "lede", "No message text yet."));
      return;
    }
    for (const turn of turns) {
      const block = el("div", "turn");
      const who = el("div", "who", turn.role === "you" ? "You" : "Agent");
      const text = el("p", "", turn.text);
      const pass = el("button", "tiny", "Pass this");
      pass.addEventListener("click", () => post("spawn", { id: msg.id, mode: "context", text: turn.text }));
      block.append(who, text, pass);
      box.append(block);
    }
  }

  function scheduleMeta(node) {
    clearTimeout(metaTimer);
    metaTimer = setTimeout(() => {
      post("meta", {
        id: node.id,
        title: node.titleOverride || "",
        note: node.note || "",
        tags: node.tags || [],
        userStatus: node.userStatus || "",
        body: node.body || "",
      });
    }, 280);
  }

  function groupSelection() {
    const ids = [...selected].filter((id) => isShown(nodeById(id)));
    if (!ids.length) {
      toast("Select one or more bubbles first. Shift-click to add more.");
      return;
    }
    const nodes = ids.map(nodeById);
    const minX = Math.min(...nodes.map((node) => node.x)) - 28;
    const minY = Math.min(...nodes.map((node) => node.y)) - 40;
    const maxX = Math.max(...nodes.map((node) => node.x + NODE_W)) + 28;
    const maxY = Math.max(...nodes.map((node) => node.y + 168)) + 28;
    post("group", { members: ids, name: "Group", x: minX, y: minY, width: maxX - minX, height: maxY - minY });
  }

  function fit() {
    const nodes = model.nodes.filter((node) => isShown(node) && matchesSearch(node));
    if (!nodes.length) return;
    const minX = Math.min(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxX = Math.max(...nodes.map((node) => node.x + NODE_W));
    const maxY = Math.max(...nodes.map((node) => node.y + 160));
    const rect = viewport.getBoundingClientRect();
    const z = clamp(Math.min((rect.width - 80) / Math.max(1, maxX - minX), (rect.height - 80) / Math.max(1, maxY - minY)), 0.28, 1.4);
    cam.z = z;
    cam.x = 36 - minX * z;
    cam.y = 36 - minY * z;
    applyCamera();
    saveCamera();
  }

  function saveCamera() {
    post("camera", { camera: { x: cam.x, y: cam.y, z: cam.z } });
  }

  function applyCamera() {}

  function markSelection() {
    for (const [id, bubble] of nodeEls) bubble.classList.toggle("selected", selected.has(id));
  }

  function openMenu(x, y, items) {
    menu.replaceChildren();
    for (const item of items) {
      const button = el("button", "", item.label);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        hideMenu();
        item.run();
      });
      menu.append(button);
    }
    menu.classList.remove("hidden");
    menu.style.left = Math.min(x, window.innerWidth - 200) + "px";
    menu.style.top = Math.min(y, window.innerHeight - 220) + "px";
  }

  function hideMenu() {
    menu.classList.add("hidden");
  }

  let toastTimer = null;
  function toast(text) {
    if (!text) return;
    toastEl.textContent = text;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 4200);
  }

  function nodeById(id) {
    return model.nodes.find((node) => node.id === id);
  }

  function center(node) {
    return { x: node.x + NODE_W / 2, y: node.y + 62 };
  }

  function worldPoint(event) {
    const rect = viewport.getBoundingClientRect();
    return {
      x: event.clientX - rect.left + viewport.scrollLeft,
      y: event.clientY - rect.top + viewport.scrollTop,
    };
  }

  let lastOpen = { id: "", at: 0 };
  function openNode(id) {
    const now = Date.now();
    if (lastOpen.id === id && now - lastOpen.at < 500) return;
    lastOpen = { id, at: now };
    post("open", { id });
  }

  function viewCenter() {
    return { x: viewport.scrollLeft + ORIGIN, y: viewport.scrollTop + ORIGIN };
  }

  let promptTarget = "";

  function closePrompt() {
    promptOpen = false;
    promptTarget = "";
    promptLayer.classList.add("hidden");
    promptInput.value = "";
  }

  function openPrompt(id) {
    const node = nodeById(id);
    if (!node || (node.source !== "cursor" && node.source !== "claude")) {
      toast("Double-click a Cursor or Claude tile to message that chat.");
      return;
    }
    promptOpen = true;
    promptTarget = id;
    promptLogo.className = "logo logo-" + (node.source === "claude" ? "claude" : "cursor");
    promptLogo.innerHTML = node.source === "claude" ? CLAUDE_LOGO : CURSOR_LOGO;
    promptTitle.textContent = node.title || (node.source === "claude" ? "Claude" : "Cursor");
    promptInput.value = "";
    promptLayer.classList.remove("hidden");
    promptInput.focus();
  }

  promptClose.addEventListener("click", (event) => {
    event.preventDefault();
    closePrompt();
  });
  promptLayer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = promptInput.value.trim();
    if (!text || !promptTarget) return;
    post("prompt", { id: promptTarget, text });
    closePrompt();
  });
  promptLayer.addEventListener("click", (event) => {
    if (event.target === promptLayer) closePrompt();
  });
  promptInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      promptLayer.requestSubmit();
    }
  });

  function sourceLabel(node) {
    if (node.source === "cursor") return "Cursor";
    if (node.source === "claude") return "Claude";
    if (node.source === "note") return "Note";
    return "Handoff";
  }

  function action(label, run) {
    const button = el("button", "", label);
    button.addEventListener("click", run);
    return button;
  }

  function labeled(label, control) {
    const field = el("label", "field", label);
    field.append(control);
    return field;
  }

  function input(value, placeholder, onInput) {
    const box = el("input");
    box.value = value;
    box.placeholder = placeholder;
    box.addEventListener("input", () => onInput(box.value));
    return box;
  }

  function area(value, placeholder, onInput) {
    const box = document.createElement("textarea");
    box.value = value;
    box.placeholder = placeholder;
    box.addEventListener("input", () => onInput(box.value));
    return box;
  }

  function ago(ts) {
    if (!ts) return "undated";
    const seconds = Math.max(0, Date.now() - ts) / 1000;
    if (seconds < 60) return "just now";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m";
    if (seconds < 86400) return Math.floor(seconds / 3600) + "h";
    if (seconds < 86400 * 14) return Math.floor(seconds / 86400) + "d";
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function num(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  window.addEventListener("resize", () => render());
  renderInspector();
  post("ready");
})();
