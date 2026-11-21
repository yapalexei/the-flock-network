'use strict';

/**
 * Keeps enemy fighters from flying through each other. Two distances, in metres between craft centres:
 *
 *   AVOID_OUTER_M      safe: nothing bad happens, but a fighter steers away from, and slows for,
 *                      anything this close.
 *   COLLISION_INNER_M  crossing it is a collision: both fighters take damage (at most once per
 *                      COLLISION_DAMAGE_INTERVAL_MS each) and are shoved apart so they can't stay stuck together.
 *
 * Like flight.js this only produces data: `findNeighbors` once per frame, `adjustPlan` to bend a
 * flight plan, `robotsToDamage` and `applyShove` for the collision side effects.
 */

const AVOID_OUTER_M = 70;
const COLLISION_INNER_M = 35;
const COLLISION_DAMAGE = 1;
const COLLISION_DAMAGE_INTERVAL_MS = 400;
// Metres per frame each fighter is pushed apart while in collision.
const COLLISION_SHOVE_M = 2.5;

// How hard a neighbour pushes the heading away from it, relative to the desired heading (weight 1).
const SEPARATION_WEIGHT = 1.5;
// A neighbour within this angle of the heading is "ahead" (slow down), within this of the tail is "behind" (speed up).
const AHEAD_HALF_ANGLE_DEG = 70;
const BEHIND_HALF_ANGLE_DEG = 70;
const MIN_SLOW_FACTOR = 0.15;
const SPEED_UP_FACTOR = 1.3;

const METERS_PER_DEGREE = 111195;
const AHEAD_COS = Math.cos(AHEAD_HALF_ANGLE_DEG * Math.PI / 180);
const BEHIND_COS = Math.cos(BEHIND_HALF_ANGLE_DEG * Math.PI / 180);

// Per-robot cooldown, kept off the robot because robots are serialized to every client.
const lastCollisionDamage = new WeakMap();

/**
 * Finds, for every robot, the robots within AVOID_OUTER_M using a grid so it stays cheap with
 * a thousand of them. Returns Map<robot, { list, shove }> only for robots that have a neighbour.
 *   list:  [{ dx, dy, distance }] metres from this robot to the neighbour (x east, y north)
 *   shove: metres to move this frame to get out of a collision, or null
 */
function findNeighbors(robots) {
  const records = new Map();
  if (robots.length < 2) return records;

  // A flat metre grid around the first robot; the small distortion far away is harmless for a neighbour search.
  const ref = robots[0].pos;
  const cosRef = Math.cos(ref.y * Math.PI / 180);
  const cellOf = (v) => Math.floor(v / AVOID_OUTER_M);
  const keyOf = (cx, cy) => (cx + 100000) * 200003 + (cy + 100000);

  const entries = robots.map((robot) => ({
    robot,
    mx: (robot.pos.x - ref.x) * cosRef * METERS_PER_DEGREE,
    my: (robot.pos.y - ref.y) * METERS_PER_DEGREE,
  }));
  const grid = new Map();
  entries.forEach((entry) => {
    const key = keyOf(cellOf(entry.mx), cellOf(entry.my));
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(entry);
  });

  entries.forEach((a) => {
    const cx = cellOf(a.mx);
    const cy = cellOf(a.my);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const cell = grid.get(keyOf(gx, gy));
        if (!cell) continue;
        cell.forEach((b) => {
          if (a === b) return;
          let dx = b.mx - a.mx;
          let dy = b.my - a.my;
          let distance = Math.hypot(dx, dy);
          if (distance >= AVOID_OUTER_M) return;
          if (distance < 0.01) {
            // Exactly stacked: any direction will do, as long as the two get opposite ones (b sees the mirror image).
            const angle = (a.robot.id < b.robot.id ? 0 : Math.PI);
            dx = Math.cos(angle) * 0.01;
            dy = Math.sin(angle) * 0.01;
            distance = 0.01;
          }
          let record = records.get(a.robot);
          if (!record) {
            record = { list: [], shove: null };
            records.set(a.robot, record);
          }
          record.list.push({ dx, dy, distance });
          if (distance < COLLISION_INNER_M) {
            const shove = record.shove || (record.shove = { x: 0, y: 0 });
            shove.x -= dx / distance;
            shove.y -= dy / distance;
          }
        });
      }
    }
  });

  records.forEach((record) => {
    if (!record.shove) return;
    const length = Math.hypot(record.shove.x, record.shove.y);
    // Neighbours on opposite sides cancel out; then there is nowhere in particular to go, so don't.
    record.shove = length > 1e-6
      ? { x: record.shove.x / length * COLLISION_SHOVE_M, y: record.shove.y / length * COLLISION_SHOVE_M }
      : null;
  });
  return records;
}

/**
 * Bends a flight plan around the neighbours: the heading is pushed away from close ones, the robot
 * slows down for one ahead of it and speeds up when pressed from behind. Pivots (speedFactor 0)
 * are left alone, collisions are sorted out by the shove instead.
 */
function adjustPlan(plan, record) {
  if (!record || plan.speedFactor === 0) return plan;
  const headingRad = plan.heading * Math.PI / 180;
  const desiredX = Math.sin(headingRad);
  const desiredY = Math.cos(headingRad);

  let pushX = 0;
  let pushY = 0;
  let slow = 1;
  let pressedFromBehind = false;
  record.list.forEach(({ dx, dy, distance }) => {
    // 1 at the collision distance (2 once inside it), fading to 0 at the outer distance.
    const strength = distance <= COLLISION_INNER_M ? 2 : (AVOID_OUTER_M - distance) / (AVOID_OUTER_M - COLLISION_INNER_M);
    pushX -= dx / distance * strength;
    pushY -= dy / distance * strength;

    const along = (dx * desiredX + dy * desiredY) / distance;
    if (along > AHEAD_COS) {
      const room = (distance - COLLISION_INNER_M) / (AVOID_OUTER_M - COLLISION_INNER_M);
      slow = Math.min(slow, Math.max(MIN_SLOW_FACTOR, Math.min(1, room)));
    } else if (along < -BEHIND_COS) {
      pressedFromBehind = true;
    }
  });

  const steerX = desiredX + SEPARATION_WEIGHT * pushX;
  const steerY = desiredY + SEPARATION_WEIGHT * pushY;
  const heading = Math.hypot(steerX, steerY) > 1e-6
    ? Math.atan2(steerX, steerY) * 180 / Math.PI
    : plan.heading;
  const speedFactor = plan.speedFactor * slow * (slow === 1 && pressedFromBehind ? SPEED_UP_FACTOR : 1);
  return { ...plan, heading, speedFactor };
}

/** Robots in collision this frame that are due damage; each is limited to one hit per interval. */
function robotsToDamage(records, now) {
  const hits = [];
  records.forEach((record, robot) => {
    if (!record.list.some((n) => n.distance < COLLISION_INNER_M)) return;
    if (now - (lastCollisionDamage.get(robot) || 0) < COLLISION_DAMAGE_INTERVAL_MS) return;
    lastCollisionDamage.set(robot, now);
    hits.push({ robot, amount: COLLISION_DAMAGE });
  });
  return hits;
}

/** Pushes a robot out of a collision (see `shove` in findNeighbors). */
function applyShove(robot, record) {
  if (!record || !record.shove) return;
  const cosLat = Math.cos(robot.pos.y * Math.PI / 180);
  robot.pos.x += record.shove.x / (METERS_PER_DEGREE * cosLat);
  robot.pos.y += record.shove.y / METERS_PER_DEGREE;
}

module.exports = { findNeighbors, adjustPlan, robotsToDamage, applyShove };
