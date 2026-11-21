'use strict';

/**
 * Spatial grid over the live projectiles, so hit detection can ask "which projectiles are near this craft?"
 * instead of testing every craft against every projectile.
 *
 * The cell size must be at least the largest hit reach along one axis (in degrees). Then anything
 * that can hit a craft is in the craft's cell or one of its 8 neighbours, so this finds exactly the
 * same hits as the brute-force loop, just without looking at the far-away projectiles.
 */

// Cell coordinates stay within about +-600k, so this packs a cell into one unique safe integer.
const cellKey = (cx, cy) => (cx + 1000000) * 2000003 + (cy + 1000000);

function buildProjectileGrid(projectiles, cellDeg) {
  const cells = new Map();
  for (let i = 0; i < projectiles.length; i++) {
    const projectile = projectiles[i];
    if (projectile.expired) continue;
    const key = cellKey(Math.floor(projectile.pos.x / cellDeg), Math.floor(projectile.pos.y / cellDeg));
    const cell = cells.get(key);
    if (cell) cell.push(i);
    else cells.set(key, [i]);
  }
  return { cells, cellDeg };
}

// Reused between calls so a lookup allocates nothing; the result is only valid until the next call.
const found = [];

/**
 * Indexes (into the array the grid was built from) of the projectiles in the 3x3 cells around `pos`,
 * in ascending order, so callers see them in the same order as a plain loop would.
 */
function nearbyProjectileIndexes(grid, pos) {
  found.length = 0;
  const cx = Math.floor(pos.x / grid.cellDeg);
  const cy = Math.floor(pos.y / grid.cellDeg);
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const cell = grid.cells.get(cellKey(gx, gy));
      if (cell) for (let i = 0; i < cell.length; i++) found.push(cell[i]);
    }
  }
  if (found.length > 1) found.sort((a, b) => a - b);
  return found;
}

module.exports = { buildProjectileGrid, nearbyProjectileIndexes };
