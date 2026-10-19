(() => {
  const state = {
    rev: 1,
    scope: "workspace",
    showHidden: false,
    showSubagents: false,
    warnings: [],
    workspace: "ClaudeCanvas",
    camera: { x: 36, y: 24, z: 1 },
    groups: [],
    links: [],
    nodes: [
      { id: "cursor:1", externalId: "1", source: "cursor", title: "Visual chat canvas", baseTitle: "Visual chat canvas", titleOverride: "", subtitle: "Edited extension.js", project: "C:\\ClaudeCanvas", projectLabel: "ClaudeCanvas", mode: "agent", status: "running", updatedAt: Date.now() - 60000, createdAt: Date.now() - 86400000, filesChanged: 4, inWorkspace: true, tags: ["map"], note: "", userStatus: "active", x: 80, y: 90, hidden: false, custom: false },
      { id: "cursor:5", externalId: "5", source: "cursor", title: "(1) Visual chat canvas", baseTitle: "(1) Visual chat canvas", titleOverride: "", subtitle: "Forked branch", project: "C:\\ClaudeCanvas", projectLabel: "ClaudeCanvas", mode: "agent", status: "idle", updatedAt: Date.now() - 30000, createdAt: Date.now() - 3600000, filesChanged: 1, inWorkspace: true, tags: [], note: "", userStatus: "", x: 400, y: 90, hidden: false, custom: false },
      { id: "cursor:2", externalId: "2", source: "cursor", title: "GLM architecture", baseTitle: "GLM architecture", titleOverride: "", subtitle: "Layer order", projectLabel: "github", mode: "agent", status: "idle", updatedAt: Date.now() - 86400000, filesChanged: 0, inWorkspace: false, tags: [], note: "", userStatus: "", x: 1500, y: 90, hidden: false, custom: false },
      { id: "claude:3", externalId: "3", source: "claude", title: "ROCm reviewers", baseTitle: "ROCm reviewers", titleOverride: "", subtitle: "Find the reviewer list", projectLabel: "pr-reviewer", mode: "claude", status: "unread", updatedAt: Date.now() - 3600000, filesChanged: 0, inWorkspace: true, tags: [], note: "", userStatus: "", x: 390, y: 90, hidden: false, custom: false },
      { id: "cursor:4", externalId: "4", source: "cursor", title: "Audio diagnosis", baseTitle: "Audio diagnosis", titleOverride: "", subtitle: "No output device", projectLabel: "github", mode: "agent", status: "needs-you", updatedAt: Date.now() - 7200000, filesChanged: 1, inWorkspace: true, tags: [], note: "", userStatus: "waiting", x: 80, y: 320, hidden: false, custom: false },
    ],
  };

  function emit(select) {
    const msg = { type: "state", rev: state.rev, scope: state.scope, showHidden: state.showHidden, showSubagents: state.showSubagents, warnings: state.warnings, workspace: state.workspace, camera: state.camera, groups: state.groups, links: state.links, nodes: state.nodes.map((node) => ({ ...node })) };
    if (select) msg.select = select;
    window.postMessage(msg, "*");
  }

  function node(id) {
    return state.nodes.find((item) => item.id === id);
  }

  window.acquireVsCodeApi = () => ({
    postMessage(msg) {
      if (typeof msg.rev === "number") state.rev = Math.max(state.rev, msg.rev);
      if (msg.type === "ready" || msg.type === "refresh") {
        emit();
        return;
      }
      if (msg.type === "toast") return;
      if (msg.type === "preview") {
        window.postMessage({
          type: "preview",
          id: msg.id,
          turns: [
            { role: "you", text: "Can you map every chat as a bubble and open the original when I click?" },
            { role: "agent", text: "The board reads Cursor and Claude transcripts. Click still focuses the original chat in media/main.js." },
            { role: "you", text: "Add a mind map on each card, with the files the agent touched." },
            { role: "agent", text: "Each card opens its own map: your topics on the left, agent points and files such as src/providers.js on the right." },
          ],
        }, "*");
        return;
      }
      if (msg.type === "open" || msg.type === "draft") {
        window.postMessage({ type: "toast", text: msg.type === "open" ? "Opened in the original chat." : "New chat drafted. Original left in place." }, "*");
        return;
      }
      if (msg.type === "newChat") {
        const id = "new-" + state.nodes.length;
        const host = msg.host === "claude" ? "claude" : "cursor";
        state.nodes.push({
          id,
          externalId: id,
          source: host,
          title: host === "claude" ? "New Claude chat" : "New Cursor chat",
          baseTitle: host === "claude" ? "New Claude chat" : "New Cursor chat",
          titleOverride: "",
          subtitle: "Opens in the chat panel",
          projectLabel: "New chat",
          mode: "new",
          status: "idle",
          updatedAt: Date.now(),
          filesChanged: 0,
          inWorkspace: true,
          tags: [],
          note: "",
          userStatus: "",
          x: typeof msg.x === "number" ? msg.x : 200,
          y: typeof msg.y === "number" ? msg.y : 160,
          hidden: false,
          custom: false,
        });
        window.postMessage({ type: "toast", text: "New " + host + " chat opened." }, "*");
        state.rev += 1;
        emit(id);
        return;
      }
      if (msg.type === "scope") state.scope = msg.scope;
      if (msg.type === "flags") {
        if (typeof msg.showHidden === "boolean") state.showHidden = msg.showHidden;
        if (typeof msg.showSubagents === "boolean") state.showSubagents = msg.showSubagents;
      }
      if (msg.type === "camera" && msg.camera) state.camera = msg.camera;
      if (msg.type === "move") {
        for (const spot of msg.spots || []) {
          const item = node(spot.id);
          if (item) { item.x = spot.x; item.y = spot.y; }
        }
        for (const incoming of msg.groups || []) {
          const group = state.groups.find((item) => item.id === incoming.id);
          if (group) Object.assign(group, incoming);
        }
      }
      if (msg.type === "meta") {
        const item = node(msg.id);
        if (item) {
          item.titleOverride = msg.title || "";
          item.title = msg.title || item.baseTitle;
          item.note = msg.note || "";
          item.tags = msg.tags || [];
          item.userStatus = msg.userStatus || "";
          if (typeof msg.body === "string") item.body = msg.body;
        }
      }
      if (msg.type === "link") {
        state.links.push({ id: "link-" + state.links.length, from: msg.from, to: msg.to, kind: msg.kind });
      }
      if (msg.type === "unlink") state.links = state.links.filter((link) => link.id !== msg.id);
      if (msg.type === "group") {
        const id = "group-" + state.groups.length;
        state.groups.push({ id, name: msg.name, x: msg.x, y: msg.y, width: msg.width, height: msg.height });
        for (const member of msg.members || []) {
          const item = node(member);
          if (item) item.groupId = id;
        }
      }
      if (msg.type === "renameGroup") {
        const group = state.groups.find((item) => item.id === msg.id);
        if (group) group.name = msg.name;
      }
      if (msg.type === "ungroup") {
        state.groups = state.groups.filter((item) => item.id !== msg.id);
        for (const item of state.nodes) if (item.groupId === msg.id) item.groupId = "";
      }
      if (msg.type === "leaveGroup") {
        const item = node(msg.id);
        if (item && item.groupId) {
          const groupId = item.groupId;
          item.groupId = "";
          const members = state.nodes.filter((entry) => entry.groupId === groupId);
          if (members.length < 2) {
            state.groups = state.groups.filter((group) => group.id !== groupId);
            for (const entry of state.nodes) if (entry.groupId === groupId) entry.groupId = "";
          }
        }
      }
      if (msg.type === "note" || msg.type === "spawn") {
        const id = msg.type + "-" + state.nodes.length;
        const origin = node(msg.id);
        state.nodes.push({
          id,
          source: msg.type === "note" ? "note" : "packet",
          title: msg.type === "note" ? "Note" : "Handoff · " + (origin ? origin.title : "chat"),
          baseTitle: msg.type === "note" ? "Note" : "Handoff",
          titleOverride: "",
          subtitle: "",
          projectLabel: msg.type === "note" ? "Note" : "Handoff",
          mode: msg.type === "note" ? "note" : "packet",
          status: "idle",
          updatedAt: Date.now(),
          inWorkspace: true,
          custom: true,
          body: msg.type === "spawn" ? "Carried context from the original chat." : "",
          note: "",
          tags: [],
          userStatus: "",
          x: msg.x || (origin ? origin.x + 300 : 200),
          y: msg.y || (origin ? origin.y + 20 : 200),
          hidden: false,
        });
        if (origin) state.links.push({ id: "link-" + id, from: origin.id, to: id, kind: msg.mode || "related" });
        state.rev += 1;
        emit(id);
        return;
      }
      if (msg.type === "deleteCustom") {
        state.nodes = state.nodes.filter((item) => item.id !== msg.id);
        state.links = state.links.filter((link) => link.from !== msg.id && link.to !== msg.id);
      }
      if (msg.type === "hide") {
        const item = node(msg.id);
        if (item) item.hidden = true;
      }
      if (msg.type === "unhide") {
        const item = node(msg.id);
        if (item) {
          item.hidden = false;
          if (typeof msg.x === "number") item.x = msg.x;
          if (typeof msg.y === "number") item.y = msg.y;
        }
      }
      if (msg.type === "prompt") {
        const item = node(msg.id);
        window.postMessage({ type: "toast", text: "Sent to " + (item ? item.title : "the chat") + "." }, "*");
        return;
      }
      if (msg.type !== "camera" && msg.type !== "preview") emit();
    },
  });
})();
