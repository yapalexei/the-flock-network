'use strict';

/**
 * Enemy flight: strafing runs instead of orbiting the player.
 *
 *   pursue  -> fly straight at the player
 *   flip    -> within BREAK_DISTANCE_M: pivot on the spot to face directly away
 *   retreat -> fly straight away for a random 0.8-1.6s
 *   realign -> pivot on the spot back to face the player, then pursue again
 *
 * The turns happen (almost) in place, so the path is a line out and a line back, never a circle.
 *
 * Flight is split in two so steering rules can be layered in later:
 *   planFlight  decides what the robot wants (heading, how fast a turn it can make, throttle, may fire)
 *   applyFlight turns toward the planned heading and says how far to travel
 * Collision avoidance can adjust the plan (`heading`, `speedFactor`: <1 slows down, >1 speeds up)
 * between the two calls without touching the state machine.
 */

const BREAK_DISTANCE_M = 40;
const RETREAT_MIN_MS = 800;
const RETREAT_MAX_MS = 1600;
// Degrees per second. Pursuit turns are gentle corrections, pivots are quick.
const PURSUIT_TURN_RATE = 180;
const PIVOT_TURN_RATE = 540;
// Fraction of cruise speed kept while pivoting; 0 turns on the spot.
const PIVOT_SPEED_FACTOR = 0;
const ALIGNED_DEG = 3;
const METERS_PER_DEGREE = 111195;

// Flight state lives here, not on the robot, because robots are serialized to every client each frame.
const flightStates = new WeakMap();

function groundDistanceM(a, b) {
  const dx = (b.x - a.x) * Math.cos((a.y + b.y) / 2 * Math.PI / 180) * METERS_PER_DEGREE;
  const dy = (b.y - a.y) * METERS_PER_DEGREE;
  return Math.hypot(dx, dy);
}

/** Compass bearing in degrees clockwise from north; the angle an icon is drawn at. */
function compassBearing(from, to) {
  const dx = (to.x - from.x) * Math.cos((from.y + to.y) / 2 * Math.PI / 180);
  const dy = to.y - from.y;
  return Math.atan2(dx, dy) * 180 / Math.PI;
}

/** Signed shortest rotation from `current` to `target`, in (-180, 180]. */
function angleDiff(target, current) {
  let d = (target - current) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

function heading(robot) {
  return Number.isFinite(robot.bearing) ? robot.bearing : 0;
}

function resetFlight(robot) {
  flightStates.delete(robot);
}

function planFlight(robot, target, now) {
  let state = flightStates.get(robot);
  if (!state) {
    state = { mode: 'pursue', away: 0, until: 0 };
    flightStates.set(robot, state);
  }
  const toTarget = compassBearing(robot.pos, target.pos);
  const isAligned = (bearing) => Math.abs(angleDiff(bearing, heading(robot))) <= ALIGNED_DEG;

  if (state.mode === 'pursue' && groundDistanceM(robot.pos, target.pos) < BREAK_DISTANCE_M) {
    state.mode = 'flip';
    state.away = toTarget + 180;
  }
  if (state.mode === 'flip' && isAligned(state.away)) {
    state.mode = 'retreat';
    state.until = now + RETREAT_MIN_MS + Math.random() * (RETREAT_MAX_MS - RETREAT_MIN_MS);
  }
  if (state.mode === 'retreat' && now >= state.until) state.mode = 'realign';
  if (state.mode === 'realign' && isAligned(toTarget)) state.mode = 'pursue';

  switch (state.mode) {
    case 'flip':
      return { mode: state.mode, heading: state.away, turnRate: PIVOT_TURN_RATE, speedFactor: PIVOT_SPEED_FACTOR, canFire: false };
    case 'retreat':
      return { mode: state.mode, heading: state.away, turnRate: PURSUIT_TURN_RATE, speedFactor: 1, canFire: false };
    case 'realign':
      return { mode: state.mode, heading: toTarget, turnRate: PIVOT_TURN_RATE, speedFactor: PIVOT_SPEED_FACTOR, canFire: false };
    default:
      return { mode: state.mode, heading: toTarget, turnRate: PURSUIT_TURN_RATE, speedFactor: 1, canFire: true };
  }
}

/** Turns the robot toward the plan (updating `robot.bearing`) and returns the distance to fly this frame, in km. */
function applyFlight(robot, plan, fps) {
  const current = heading(robot);
  const maxTurn = plan.turnRate / fps;
  const turn = Math.max(-maxTurn, Math.min(maxTurn, angleDiff(plan.heading, current)));
  robot.bearing = (current + turn + 360) % 360;
  return robot.speed * plan.speedFactor;
}

module.exports = { planFlight, applyFlight, resetFlight, groundDistanceM, compassBearing };
