'use strict';

/**
 * The live objects of the game, kept between frames instead of being rebuilt every frame.
 *
 * - `byId` plus one Set per kind (players, robots, projectiles, drops, blasts) are updated in place
 *   as objects are added and removed, so a frame never has to filter or copy "everything".
 * - Craft (players and robots) also live in a grid. Craft only move when they are simulated or when
 *   their player sends an update, and only then does the grid get touched (`add` / `moved`), so
 *   asking "which craft are near here?" costs a few cell lookups however many craft exist.
 * - Objects created during a frame are `stage`d and appear at the end of it (`flushPending`), so
 *   they are not simulated until the next frame.
 * - Craft that were destroyed are tracked in `expiring` so only they are checked for removal.
 */

const cellKey = (cx, cy) => (cx + 1000000) * 2000003 + (cy + 1000000);

class World {
  constructor(cellDeg) {
    this.cellDeg = cellDeg;
    this.byId = new Map();
    this.players = new Set();
    this.robots = new Set();
    this.projectiles = new Set();
    this.drops = new Set();
    this.blasts = new Set();
    this.pending = [];
    this.expiring = new Set();
    this.craftGrid = new Map();
  }

  get size() {
    return this.byId.size;
  }

  get(id) {
    return this.byId.get(id);
  }

  setFor(obj) {
    if (obj.isProjectile) return this.projectiles;
    if (obj.isRobot) return this.robots;
    if (obj.isPlayer) return this.players;
    if (obj.isDrop) return this.drops;
    if (obj.isBlast) return this.blasts;
    return null;
  }

  /** Adds an object, replacing any object with the same id (players are replaced by each update). */
  add(obj) {
    const old = this.byId.get(obj.id);
    if (old && old !== obj) this.remove(old);
    const set = this.setFor(obj);
    if (!set) return;
    this.byId.set(obj.id, obj);
    set.add(obj);
    if (obj.isRobot || obj.isPlayer) this.gridInsert(obj);
  }

  remove(obj) {
    if (this.byId.get(obj.id) === obj) this.byId.delete(obj.id);
    const set = this.setFor(obj);
    if (set) set.delete(obj);
    this.expiring.delete(obj);
    if (obj.cell !== undefined) this.gridDelete(obj);
  }

  removeById(id) {
    const obj = this.byId.get(id);
    if (obj) this.remove(obj);
  }

  clear() {
    this.byId.clear();
    [this.players, this.robots, this.projectiles, this.drops, this.blasts, this.expiring].forEach((set) => set.clear());
    this.craftGrid.clear();
    this.pending.length = 0;
  }

  /** Queue an object to appear at the end of the frame. */
  stage(obj) {
    this.pending.push(obj);
  }

  flushPending() {
    for (let i = 0; i < this.pending.length; i++) this.add(this.pending[i]);
    this.pending.length = 0;
  }

  /** Call when a craft has been destroyed, so it is removed once its explosion has been shown. */
  markExpired(obj) {
    this.expiring.add(obj);
  }

  /**
   * Removes what has run its course. Projectiles are expired when old and removed `wreckMs` after
   * they expired; destroyed craft are removed `wreckMs` after they were; drops after collection
   * or `dropLifetimeMs`; blasts after `blastDisplayMs`.
   */
  sweep(now, { projectileLifetimeMs, dropLifetimeMs, blastDisplayMs, wreckMs }) {
    this.projectiles.forEach((projectile) => {
      if (!projectile.expired && now - projectile.time > projectileLifetimeMs) projectile.expired = now;
      if (projectile.expired && now - projectile.expired > wreckMs) this.remove(projectile);
    });
    this.drops.forEach((drop) => {
      if (drop.collected || now - drop.time > dropLifetimeMs) this.remove(drop);
    });
    this.blasts.forEach((blast) => {
      if (now - blast.time > blastDisplayMs) this.remove(blast);
    });
    this.expiring.forEach((craft) => {
      if (now - craft.expired > wreckMs) this.remove(craft);
    });
  }

  /** Objects that move every frame or are short lived, for the per-frame visibility grid. */
  dynamicObjects() {
    const out = [];
    this.projectiles.forEach((obj) => out.push(obj));
    this.drops.forEach((obj) => out.push(obj));
    this.blasts.forEach((obj) => out.push(obj));
    return out;
  }

  keyFor(pos) {
    return cellKey(Math.floor(pos.x / this.cellDeg), Math.floor(pos.y / this.cellDeg));
  }

  gridInsert(obj) {
    obj.cell = this.keyFor(obj.pos);
    const set = this.craftGrid.get(obj.cell);
    if (set) set.add(obj);
    else this.craftGrid.set(obj.cell, new Set([obj]));
  }

  gridDelete(obj) {
    const set = this.craftGrid.get(obj.cell);
    if (set) {
      set.delete(obj);
      if (!set.size) this.craftGrid.delete(obj.cell);
    }
    obj.cell = undefined;
  }

  /** Call after changing a craft's position. */
  moved(obj) {
    if (obj.cell === undefined) return;
    const key = this.keyFor(obj.pos);
    if (key === obj.cell) return;
    this.gridDelete(obj);
    this.gridInsert(obj);
  }

  /**
   * Calls `fn` for every craft in the cells overlapping the square `pos` +- `boxDeg` (degrees).
   * That is a superset of the craft inside the square; test distances yourself.
   * `fn` must not add, remove or move craft.
   */
  forEachCraftNear(pos, boxDeg, fn) {
    const x0 = Math.floor((pos.x - boxDeg) / this.cellDeg);
    const x1 = Math.floor((pos.x + boxDeg) / this.cellDeg);
    const y0 = Math.floor((pos.y - boxDeg) / this.cellDeg);
    const y1 = Math.floor((pos.y + boxDeg) / this.cellDeg);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const set = this.craftGrid.get(cellKey(gx, gy));
        if (set) set.forEach(fn);
      }
    }
  }
}

module.exports = { World };
