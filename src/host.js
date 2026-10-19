const vscode = require("vscode");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runFirst(attempts) {
  const errors = [];
  for (const attempt of attempts) {
    try {
      await vscode.commands.executeCommand(attempt.command, ...(attempt.args || []));
      return { ok: true, command: attempt.command };
    } catch (error) {
      errors.push(attempt.command + ": " + (error && error.message ? error.message : error));
    }
  }
  return { ok: false, message: errors.join(" ") || "Cursor did not provide a chat command." };
}

async function revealChat() {
  const reveals = ["composer.focusComposer", "workbench.action.focusAuxiliaryBar"];
  for (const command of reveals) {
    try {
      await vscode.commands.executeCommand(command);
      return;
    } catch {
      // The chat may already be visible in the agent panel.
    }
  }
}

async function openCursorComposer(composerId) {
  if (!composerId) return { ok: false, message: "This bubble has no Cursor chat id." };
  await runFirst([
    { command: "composer.openComposer", args: [composerId, { view: "pane", focusMainInputBox: true }] },
  ]);
  const shown = await runFirst([
    { command: "canvas.openAgentByConversationId", args: [composerId] },
    { command: "composer.openComposerFromNotification", args: [{ composerId }] },
    { command: "glass.openAgentById", args: [composerId] },
  ]);
  if (!shown.ok) {
    const loaded = await runFirst([
      { command: "composer.openComposer", args: [composerId] },
    ]);
    if (!loaded.ok) return { ok: false, message: shown.message || loaded.message };
  }
  await revealChat();
  return { ok: true, message: "Focused the linked Cursor chat." };
}

function linkedSessionId(node) {
  if (node.sessionId && node.sessionId !== node.id) return node.sessionId;
  if (node.externalId && node.externalId !== node.id) return node.externalId;
  return "";
}

async function openChat(node) {
  if (!node) return { ok: false, message: "That bubble is no longer on the map." };
  if (node.opening) {
    const sessionId = linkedSessionId(node);
    if (sessionId && node.source === "claude") return openClaudeSession(sessionId);
    if (sessionId && node.source === "cursor") return openCursorComposer(sessionId);
    if (node.source === "claude") {
      const opened = await focusClaude();
      return opened.ok
        ? { ok: true, message: "Focused the open Claude chat. This bubble will not start another one." }
        : opened;
    }
    await revealChat();
    return { ok: true, message: "Focused the open Cursor chat. This bubble will not start another one." };
  }
  if (node.source === "cursor") return openCursorComposer(node.externalId);
  if (node.source === "claude") return openClaudeSession(node.externalId);
  return {
    ok: false,
    message: "This bubble lives on the canvas. Use Start in Cursor or Start in Claude to open it as a new chat.",
  };
}

async function openClaudeSession(sessionId) {
  if (!sessionId) return { ok: false, message: "This bubble has no Claude session id." };
  try {
    await vscode.commands.executeCommand("claude-vscode.editor.open", sessionId);
    return { ok: true, message: "Focused the linked Claude chat." };
  } catch (error) {
    try {
      await vscode.commands.executeCommand("claude-vscode.primaryEditor.open", sessionId);
      return { ok: true, message: "Focused the linked Claude chat." };
    } catch (fallback) {
      const focused = await focusClaude();
      const detail = (fallback && fallback.message) || (error && error.message) || "Could not open this Claude session.";
      if (!focused.ok) return { ok: false, message: detail };
      return { ok: false, message: detail };
    }
  }
}

async function focusClaude() {
  const attempts = ["claude-vscode.focus", "claude-vscode.sidebar.open", "claudeVSCodeSidebarSecondary.focus", "claudeVSCodeSidebar.focus"];
  let last = "The Claude extension is not installed in this window.";
  for (const command of attempts) {
    try {
      await vscode.commands.executeCommand(command);
      return { ok: true };
    } catch (error) {
      last = error.message || last;
    }
  }
  return { ok: false, message: last };
}

async function startCursorChat() {
  const created = await runFirst([
    { command: "composer.createNewWithPrevContext" },
    { command: "composer.createNew", args: [{ unifiedMode: "agent", openInNewTab: true }] },
    { command: "composer.createNewComposerTab" },
    { command: "composer.newAgentChat" },
  ]);
  if (!created.ok) return created;
  await revealChat();
  return { ok: true, message: "New Cursor chat opened." };
}

async function startBlank(host) {
  if (host === "claude") {
    try {
      await vscode.commands.executeCommand("claude-vscode.newConversation");
      await focusClaude();
      return { ok: true, message: "New Claude chat opened." };
    } catch (error) {
      const focused = await focusClaude();
      if (!focused.ok) return { ok: false, message: error.message || "Could not start a Claude chat." };
      return { ok: false, message: error.message || "Could not start a Claude chat." };
    }
  }
  return startCursorChat();
}

async function startDraft(host, text) {
  const previous = await vscode.env.clipboard.readText();
  await vscode.env.clipboard.writeText(text || "");
  let result;
  try {
    if (host === "claude") {
      await vscode.commands.executeCommand("claude-vscode.newConversation");
      await focusClaude();
    } else {
      const created = await startCursorChat();
      if (!created.ok) {
        result = created;
        return result;
      }
    }
    await sleep(450);
    try {
      await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
      result = {
        ok: true,
        message:
          host === "claude"
            ? "New Claude chat opened. If the draft is not in the box, press Ctrl+V."
            : "Draft placed in a new Cursor chat.",
      };
    } catch {
      result = {
        ok: true,
        message: "New chat opened. The draft is on the clipboard — press Ctrl+V if it did not land in the box.",
      };
    }
  } catch (error) {
    result = { ok: false, message: error.message || "Could not start the new chat." };
  } finally {
    setTimeout(() => {
      vscode.env.clipboard.writeText(previous).then(
        () => {},
        () => {}
      );
    }, 2500);
  }
  return result;
}

async function pasteIntoFocused(text) {
  const previous = await vscode.env.clipboard.readText();
  await vscode.env.clipboard.writeText(text || "");
  try {
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
  } catch {
    return false;
  }
  setTimeout(() => {
    vscode.env.clipboard.writeText(previous).then(
      () => {},
      () => {}
    );
  }, 2500);
  return true;
}

async function submitFocusedInput() {
  const attempts = ["workbench.action.chat.submit", "workbench.action.chat.acceptInput", "composer.submit", "aichat.submit"];
  for (const command of attempts) {
    try {
      await vscode.commands.executeCommand(command);
      return true;
    } catch {
      // This editor build may not expose that submit command.
    }
  }
  return false;
}

async function sendToChat(node, text) {
  const body = String(text || "").trim().slice(0, 8000);
  if (!body) return { ok: false, message: "Write a message first." };
  if (!node) return { ok: false, message: "That chat is no longer on the map." };
  if (node.source === "claude") {
    const sessionId = linkedSessionId(node) || node.externalId;
    if (!sessionId || sessionId === node.id) return { ok: false, message: "This Claude chat is not linked yet." };
    try {
      await vscode.commands.executeCommand("claude-vscode.editor.open", sessionId, body);
    } catch (error) {
      return { ok: false, message: error.message || "Could not open this Claude chat." };
    }
    await sleep(500);
    const sent = await submitFocusedInput();
    return {
      ok: true,
      message: sent ? "Sent to the Claude chat." : "Placed in the Claude chat. Press Enter there if it is still in the box.",
    };
  }
  if (node.source === "cursor") {
    const composerId = linkedSessionId(node) || node.externalId;
    const opened = await openCursorComposer(composerId);
    if (!opened.ok) return opened;
    await sleep(400);
    const pasted = await pasteIntoFocused(body);
    if (!pasted) return { ok: false, message: "Opened the Cursor chat, but the message could not be pasted. It is on the clipboard." };
    await sleep(180);
    const sent = await submitFocusedInput();
    return {
      ok: true,
      message: sent ? "Sent to the Cursor chat." : "Placed in the Cursor chat. Press Enter there if it is still in the box.",
    };
  }
  return { ok: false, message: "Only Cursor and Claude chats can take a message from the canvas." };
}

module.exports = { openChat, startBlank, startDraft, sendToChat };
