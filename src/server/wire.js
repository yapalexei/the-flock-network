'use strict';

/**
 * What goes over the wire to players, and how to build it cheaply.
 *
 * Each player gets a `world` event: { s?: 1, u: [objects], d: [ids] }
 *   u  objects that are new to this player or changed since they were last sent
 *   d  ids that left the player's view (or were removed) since the last event
 *   s  set on the first event after connecting or a `resync`: a full snapshot, the client starts clean
 * Objects nothing happened to (stationary enemies, drops) are not sent again.
 *
 * Objects use short keys and only the fields the client draws (decoded in the-flock's world-wire.js, keep in sync):
 *   n id (a small integer; players keep their socket id)   t type (TYPE below)   x, y position
 *   b bearing   i icon   z icon size   h hitCount   c hitCapacity   k kills   e 1 when exploding
 *   p, q previous position (shots are drawn as a line from there)
 *
 * The expensive parts are shared between players: every object is compared and (if it changed)
 * JSON-encoded at most once per frame, however many players see it, and the packet is assembled from
 * those strings and handed straight to the engine (no per-player socket.io encoding).
 */

const TYPE = { ROBOT: 0, PLAYER: 1, SHOT: 2, TORPEDO: 3, ENEMY_SHOT: 4, DROP: 5, BLAST: 6 };

// Cell coordinates stay within about +-20k at 0.01 degrees; packed into one unique safe integer.
const cellKey = (cx, cy) => (cx + 10000000) * 20000003 + (cy + 10000000);

// Per object id: its wire id, a signature of what the client sees, and a version that bumps when it changes.
const entries = new Map();
let nextWireId = 1;
let frameNumber = 0;

function typeOf(obj) {
  if (obj.isProjectile) return obj.isTorpedo ? TYPE.TORPEDO : obj.robotProjectile ? TYPE.ENEMY_SHOT : TYPE.SHOT;
  if (obj.isRobot) return TYPE.ROBOT;
  if (obj.isPlayer) return TYPE.PLAYER;
  if (obj.isDrop) return TYPE.DROP;
  if (obj.isBlast) return TYPE.BLAST;
  return null;
}

const signature = [];

/** Writes the values the client can see changing into `signature`; returns how many. */
function readSignature(obj, type) {
  signature[0] = obj.pos.x;
  signature[1] = obj.pos.y;
  switch (type) {
    case TYPE.ROBOT:
    case TYPE.PLAYER:
      signature[2] = obj.bearing || 0;
      signature[3] = obj.statistics.hitCount;
      signature[4] = obj.expired ? 1 : 0;
      signature[5] = obj.statistics.kills || 0;
      signature[6] = obj.icon;
      return 7;
    case TYPE.DROP:
    case TYPE.BLAST:
      return 2;
    default:
      signature[2] = obj.prevPos.x;
      signature[3] = obj.prevPos.y;
      signature[4] = obj.expired ? 1 : 0;
      return 5;
  }
}

function refresh(obj, type) {
  let entry = entries.get(obj.id);
  if (!entry || entry.type !== type) {
    entry = {
      obj, type, wid: type === TYPE.PLAYER ? obj.id : nextWireId++,
      signature: [], length: 0, version: 0, json: null, frame: 0,
    };
    entries.set(obj.id, entry);
  }
  const length = readSignature(obj, type);
  let changed = entry.length !== length;
  for (let i = 0; i < length && !changed; i++) changed = entry.signature[i] !== signature[i];
  if (changed) {
    for (let i = 0; i < length; i++) entry.signature[i] = signature[i];
    entry.length = length;
    entry.version += 1;
    entry.json = null;
  }
  entry.obj = obj;
  entry.frame = frameNumber;
  return entry;
}

const round = (value, factor) => Math.round(value * factor) / factor;

function encode(entry) {
  const { obj, type } = entry;
  // Positions to 1e-7 degrees (about a centimetre) is far finer than anything drawn.
  const wire = { n: entry.wid, t: type, x: round(obj.pos.x, 1e7), y: round(obj.pos.y, 1e7) };
  switch (type) {
    case TYPE.ROBOT:
    case TYPE.PLAYER:
      wire.b = round(obj.bearing || 0, 10);
      wire.i = obj.icon;
      wire.z = obj['icon-size'];
      wire.h = round(obj.statistics.hitCount, 100);
      wire.c = obj.hitCapacity;
      if (type === TYPE.PLAYER) wire.k = obj.statistics.kills || 0;
      if (obj.expired) wire.e = 1;
      break;
    case TYPE.DROP:
    case TYPE.BLAST:
      wire.i = obj.icon;
      wire.z = obj['icon-size'];
      break;
    default:
      wire.p = round(obj.prevPos.x, 1e7);
      wire.q = round(obj.prevPos.y, 1e7);
      if (obj.expired) wire.e = 1;
  }
  return JSON.stringify(wire);
}

/**
 * Call once at the start of a frame's broadcast with the objects that move every frame or are
 * short lived (projectiles, drops, blasts); they are filed into a grid for visibility lookups.
 * Craft are not passed in: they are looked up near each player instead (see `visibleEntries`).
 * `cellDeg` must be at least the visibility reach along one axis.
 */
function beginFrame(dynamicObjects, cellDeg) {
  frameNumber += 1;
  const cells = new Map();
  for (let i = 0; i < dynamicObjects.length; i++) {
    const obj = dynamicObjects[i];
    const type = typeOf(obj);
    if (type === null) continue;
    const entry = refresh(obj, type);
    const key = cellKey(Math.floor(obj.pos.x / cellDeg), Math.floor(obj.pos.y / cellDeg));
    const cell = cells.get(key);
    if (cell) cell.push(entry);
    else cells.set(key, [entry]);
  }
  return { cells, cellDeg };
}

/** Call after every player's packet has been built: forgets objects nobody could see this frame. */
function endFrame() {
  entries.forEach((entry, id) => {
    if (entry.frame !== frameNumber) entries.delete(id);
  });
}

const visible = [];

/**
 * Entries within `hideDistance` of `pos`, where distance is hypot(dx*dx, dy*dy) (the server's
 * calcDistance), which allows at most |dx|, |dy| < sqrt(hideDistance) = cellDeg.
 * `forEachCraftNear(pos, boxDeg, fn)` is the world's craft lookup. A craft's entry is brought up
 * to date the first time any player sees it in a frame, so each is compared and encoded once.
 * Only valid until the next call.
 */
function visibleEntries(frame, pos, hideDistance, forEachCraftNear) {
  visible.length = 0;
  const cx = Math.floor(pos.x / frame.cellDeg);
  const cy = Math.floor(pos.y / frame.cellDeg);
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const cell = frame.cells.get(cellKey(gx, gy));
      if (!cell) continue;
      for (let i = 0; i < cell.length; i++) {
        const dx = cell[i].obj.pos.x - pos.x;
        const dy = cell[i].obj.pos.y - pos.y;
        if (Math.hypot(dx * dx, dy * dy) < hideDistance) visible.push(cell[i]);
      }
    }
  }
  forEachCraftNear(pos, frame.cellDeg, (craft) => {
    const dx = craft.pos.x - pos.x;
    const dy = craft.pos.y - pos.y;
    if (Math.hypot(dx * dx, dy * dy) >= hideDistance) return;
    const type = typeOf(craft);
    if (type === null) return;
    const known = entries.get(craft.id);
    visible.push(known && known.frame === frameNumber && known.obj === craft ? known : refresh(craft, type));
  });
  return visible;
}

/**
 * Builds the socket.io packet for one player, or null when there is nothing to tell them.
 * `known` is that player's Map of wire id -> version last sent, updated here.
 * `snapshot` marks the packet as a full state (the caller must have emptied `known`).
 *
 * The result is a ready-made socket.io EVENT packet for the default namespace (`2["world",{...}]`),
 * so send it with `socket.conn.send(packet)` rather than `socket.emit`.
 */
function buildPacket(known, entriesInView, snapshot) {
  const updates = [];
  for (let i = 0; i < entriesInView.length; i++) {
    const entry = entriesInView[i];
    if (known.get(entry.wid) === entry.version) continue;
    known.set(entry.wid, entry.version);
    if (entry.json === null) entry.json = encode(entry);
    updates.push(entry.json);
  }

  const gone = [];
  if (known.size > entriesInView.length) {
    const inView = new Set();
    for (let i = 0; i < entriesInView.length; i++) inView.add(entriesInView[i].wid);
    known.forEach((version, wid) => {
      if (!inView.has(wid)) gone.push(wid);
    });
    gone.forEach((wid) => known.delete(wid));
  }

  if (!snapshot && !updates.length && !gone.length) return null;
  return `2["world",{${snapshot ? '"s":1,' : ''}"u":[${updates.join(',')}],"d":${JSON.stringify(gone)}}]`;
}

module.exports = { beginFrame, endFrame, visibleEntries, buildPacket, TYPE };
