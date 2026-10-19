const KEY = "chatCanvas.board.v1";

function emptyBoard() {
  return {
    version: 1,
    camera: { x: 48, y: 28, z: 1 },
    scope: "workspace",
    showSubagents: false,
    showHidden: false,
    placement: {},
    groups: [],
    links: [],
    customs: [],
  };
}

class BoardStore {
  constructor(memento) {
    this.memento = memento;
    this.board = this.read();
    this.writing = Promise.resolve();
  }

  read() {
    const stored = this.memento.get(KEY);
    if (!stored || typeof stored !== "object") return emptyBoard();
    return {
      ...emptyBoard(),
      ...stored,
      placement: stored.placement || {},
      groups: Array.isArray(stored.groups) ? stored.groups : [],
      links: Array.isArray(stored.links) ? stored.links : [],
      customs: Array.isArray(stored.customs) ? stored.customs : [],
      camera: stored.camera || emptyBoard().camera,
    };
  }

  get() {
    return this.board;
  }

  update(mutator) {
    mutator(this.board);
    const snapshot = structuredClone(this.board);
    this.writing = this.writing.then(() => this.memento.update(KEY, snapshot));
    return this.writing;
  }
}

module.exports = { BoardStore, emptyBoard };
