const { randomUUID: uuid } = require('crypto');
const { planFlight, applyFlight, resetFlight, groundDistanceM } = require('./flight');
const { findNeighbors, adjustPlan, robotsToDamage, applyShove } = require('./avoidance');
const { World } = require('./world');
const { beginFrame, endFrame, visibleEntries, buildPacket } = require('./wire');
const express = require('express');
const app = express();
const http = require('http').createServer(app);

/**
 * Parse numeric env vars. The old `process.env.X || default` pattern treated the
 * string "0" as truthy, so PRINT_STATS_TO_CONSOLE=0 / ENABLE_ENEMY_SHOOTING=0 did not disable anything.
 */
function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const PRINT_STATS_TO_CONSOLE = envNumber('PRINT_STATS_TO_CONSOLE', 0);
const PORT = envNumber('PORT', 3001);
const FPS = envNumber('FPS', 40);
const ROBOTS = envNumber('ROBOTS', 1000);
const HIDE_OBJS_PAST_RADIUS = envNumber('HIDE_OBJS_PAST_RADIUS', 0.0001); // need to figure out what this value represents in the game world.
// Visibility grid cell: at least sqrt(HIDE_OBJS_PAST_RADIUS), since calcDistance is hypot(dx*dx, dy*dy).
const HIDE_CELL_DEG = Math.max(Math.sqrt(HIDE_OBJS_PAST_RADIUS), 0.0001);
const ROBOT_SPAWN_PLACEMENT_OFFSET = envNumber('ROBOT_SPAWN_PLACEMENT_OFFSET', 0.06);
const ENABLE_ENEMY_SHOOTING = envNumber('ENABLE_ENEMY_SHOOTING', 0);

// Hosting / abuse limits
const MAX_ROBOTS = 5000;
const MAX_CONNECTIONS = envNumber('MAX_CONNECTIONS', 100);
const MAX_MSGS_PER_SEC = envNumber('MAX_MSGS_PER_SEC', 120);
const MAX_KEYS_PER_MSG = 5;
const MIN_MS_BETWEEN_PROJECTILES = 100;
const MAX_ID_LENGTH = 64;
const ALLOW_RESET = envNumber('ALLOW_RESET', 1);
const RESET_COOLDOWN_MS = envNumber('RESET_COOLDOWN_MS', 30000);
// Comma separated list of browser origins allowed to connect. "*" allows any.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:9000,http://127.0.0.1:9000')
  .split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);

const PROJECTILE_LIFETIME = 5000;
const PROJECTILE_DISTANCE_TRAVELLED_PER_FRAME = 0.03;
const PROJECTILE_HIT_DISTANCE = envNumber('PROJECTILE_HIT_DISTANCE', 5e-8);
// Projectiles are expired once they have flown this far (km). Nothing that far from the shooter is
// visible to it, and they would otherwise keep being simulated and tested for the whole lifetime above.
const PROJECTILE_MAX_RANGE_KM = envNumber('PROJECTILE_MAX_RANGE_KM', 1.5);
const ENEMY_TIME_BETWEEN_FIRE = 700;
// Recharge boxes: dropped by destroyed robots, collected by flying a player craft over them.
const DROP_CHANCE = envNumber('DROP_CHANCE', 0.05);
const DROP_LIFETIME = 60000;
// Same units as PROJECTILE_HIT_DISTANCE (see calcDistance); roughly 40px at zoom 16.
const DROP_PICKUP_DISTANCE = 0.0000002;
// Fraction of the craft's shield capacity restored per box.
const DROP_RECHARGE_FRACTION = 0.25;
// Torpedoes (client arms them with "s"): slower to fire, 10x the damage, and they explode.
// The fuse is wider than a laser's hit distance so a torpedo flying past a craft still detonates.
const MIN_MS_BETWEEN_TORPEDOES = 160;
const TORPEDO_HIT_VALUE = 10;
const TORPEDO_FUSE_DISTANCE = 0.0000001;
// Blast damage is full inside `core` metres and fades linearly to nothing at `radius`.
const TORPEDO_BLAST = { radius: 100, core: 40 };
// A destroyed craft explodes too, hurting whatever is close (which can set off a chain reaction).
const CRAFT_EXPLOSION = { radius: 50, core: 20, damage: 5 };
// How long a torpedo explosion stays visible to clients.
const BLAST_DISPLAY_MS = 600;
// Hit reach along one axis (degrees): calcDistance is hypot(dx*dx, dy*dy), so a reach R allows at most |dx| < sqrt(R).
const HIT_REACH_DEG = Math.sqrt(Math.max(PROJECTILE_HIT_DISTANCE, TORPEDO_FUSE_DISTANCE));
// World grid cell (degrees, roughly 560m). Craft are looked up by cell: hits, blasts, who is near a player.
const WORLD_CELL_DEG = 0.005;
// A robot chases a player closer than CHASE_RADIUS (calcDistance units). Only robots within ACTIVE_BOX_DEG of a
// player (the chase range plus a margin, so the robots that matter next are already simulated) are simulated.
const CHASE_RADIUS = 0.00005;
const ACTIVE_BOX_DEG = Math.sqrt(CHASE_RADIUS) + 0.001;
// How long destroyed craft and expired shots linger (to show the explosion) before being removed.
const WRECK_MS = 500;
// Robot cannon positions in source-image pixels from the image centre (x: right, y: toward the nose),
// scaled by the robot icon-size. Shots alternate through the list. Sizes: assets in the-flock.
const ROBOT_ICON_SIZE = 0.4;
const ROBOT_CANNONS = {
  tieFighter: [{ x: -43, y: 0 }, { x: 43, y: 0 }],
  tie1: [{ x: -37, y: 0 }, { x: 37, y: 0 }],
  tie2: [{ x: -40, y: 7 }, { x: 40, y: 7 }],
  tie3: [{ x: -42, y: 0 }, { x: 42, y: 0 }],
  tie4: [{ x: -18, y: 70 }, { x: 18, y: 70 }],
};
// The server doesn't know the client zoom, so offsets use the default one (16).
const ROBOT_REFERENCE_DEG_PER_PX = 360 / (512 * 2 ** 16);
// Cannons are toed in to cross the centreline this many ground pixels ahead (see CONVERGENCE_PX in the-flock).
const ROBOT_CONVERGENCE_PX = 600;
// Shield strength per craft icon. Clients pick an icon, never the capacity.
// Keep in sync with `crafts` in the-flock (src/layer/addFlockLayer/crafts.js).
const CRAFT_HIT_CAPACITY = {
  xWing: 100,
  xWing1: 100,
  xWing2: 100,
  yWing: 150,
  aWing: 60,
  jWing: 80,
};
const PLAYER_ICONS = new Set(Object.keys(CRAFT_HIT_CAPACITY));

function isOriginAllowed(origin) {
  // Non-browser clients send no Origin header; CORS only constrains browsers.
  if (!origin) return true;
  return ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
}

const io = require('socket.io')(http, {
  maxHttpBufferSize: 16 * 1024,
  cors: { origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS },
  // CORS headers don't cover the websocket upgrade, so check Origin here too.
  allowRequest: (req, callback) => callback(null, isOriginAllowed(req.headers.origin)),
});

app.disable('x-powered-by');
app.get('/health', (req, res) => res.sendStatus(200));

console.reset = function () {
  return process.stdout.write('\x1bc');
}

let batchTimer = null;
let resetTimeout = null;
let lastResetAt = 0;
const gameData = {
  frames: 0,
  startOfPeriod: null,
  totalSm: 0,
};
const world = new World(WORLD_CELL_DEG);
const socketConnections = {};

let lastMsgTime = 0;
let isIdle = false;

const HOST = process.env.HOST || '0.0.0.0';

http.listen(PORT, HOST, function(){
  console.log(`listening on ${HOST}:${PORT}`);
});

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const clamp = (n, min, max, fallback) => (isNum(n) ? Math.min(max, Math.max(min, n)) : fallback);

function cleanPoint(p) {
  if (!p || typeof p !== 'object' || !isNum(p.x) || !isNum(p.y)) return null;
  if (Math.abs(p.x) > 180 || Math.abs(p.y) > 90) return null;
  return { x: p.x, y: p.y };
}

/**
 * Clients are untrusted: build server-side objects from a whitelist instead of
 * storing whatever was sent (malformed data crashed the render loop and every other client).
 * Returns null for anything that should be ignored.
 */
function sanitizeClientObject(socketId, key, raw, existing, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pos = cleanPoint(raw.pos);
  if (!pos) return null;
  const prevPos = cleanPoint(raw.prevPos) || { ...pos };
  const bearing = clamp(raw.bearing, -3600, 3600, 0);

  if (raw.isProjectile) {
    // A client may only create projectiles it owns, and cannot edit them afterwards.
    if (existing || raw.ownerId !== socketId || !key.startsWith(socketId)) return null;
    // Clients only choose the type of shot; the damage is the server's call.
    const isTorpedo = raw.isTorpedo === true;
    const projectile = {
      id: key,
      pos,
      prevPos,
      icon: 'dot-11',
      isProjectile: 'true',
      bearing,
      hitValue: isTorpedo ? TORPEDO_HIT_VALUE : 1,
      ownerId: socketId,
      time: now,
    };
    if (isTorpedo) projectile.isTorpedo = true;
    return projectile;
  }

  // Everything else must be the sender's own craft.
  if (key !== socketId) return null;
  const velocity = raw.velocity || {};
  const icon = PLAYER_ICONS.has(raw.icon) ? raw.icon : 'xWing';
  return {
    id: key,
    isPlayer: true,
    pos,
    prevPos,
    velocity: { x: clamp(velocity.x, -1, 1, 0), y: clamp(velocity.y, -1, 1, 0) },
    bearing,
    icon,
    'icon-size': clamp(raw['icon-size'], 0.1, 1, 0.4),
    hitCapacity: CRAFT_HIT_CAPACITY[icon],
    isIdle: raw.isIdle === true,
    time: now,
    statistics: existing && existing.statistics
      ? existing.statistics
      : { hitCount: 0, kills: 0, fireCount: 0 },
  };
}

function stopGame() {
  clearInterval(batchTimer);
  batchTimer = null;
  clearTimeout(resetTimeout);
  resetTimeout = null;
  world.clear();
  console.log('no players connected, game paused');
}

io.on('connection', function(socket) {
  if (Object.keys(socketConnections).length >= MAX_CONNECTIONS) {
    socket.disconnect(true);
    return;
  }
  socketConnections[socket.id] = socket;
  // What this player's client has been told about: wire id -> version. See wire.js.
  socket.data.known = new Map();
  socket.data.fresh = true;
  console.log('New Player ID:', socket.id);
  socket.emit('connected', { id: socket.id, fps: FPS });

  let windowStart = Date.now();
  let windowCount = 0;
  let lastProjectileAt = 0;
  let lastTorpedoAt = 0;

  socket.on('disconnect', function () {
    world.removeById(socket.id);
    delete socketConnections[socket.id];
    if (!Object.keys(socketConnections).length) stopGame();
  });

  // The client starts a round with an empty world: send everything again.
  socket.on('resync', () => {
    socket.data.known.clear();
    socket.data.fresh = true;
  });

  socket.on('reset game', (msg) => {
    const now = Date.now();
    if (!ALLOW_RESET || resetTimeout || now - lastResetAt < RESET_COOLDOWN_MS) return;
    lastResetAt = now;
    console.log('game reset triggered by:', socket.id);
    world.clear();
    const robots = msg && Number.isInteger(msg.robots) && msg.robots >= 0 && msg.robots < MAX_ROBOTS
      ? msg.robots
      : ROBOTS;
    resetTimeout = setTimeout(() => {
      resetTimeout = null;
      console.log('initiating reset');
      generateAIPlayers(robots);
    }, 5000);
  });

  socket.on('message', (msg) => {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      windowCount = 0;
    }
    if (++windowCount > MAX_MSGS_PER_SEC) return;

    const keys = Object.keys(msg);
    if (keys.length > MAX_KEYS_PER_MSG) return;

    // A destroyed craft is frozen until the server removes it; late updates must not resurrect it.
    const ownCraft = world.get(socket.id);
    if (ownCraft && ownCraft.expired) return;

    keys.forEach((key) => {
      if (key.length > MAX_ID_LENGTH) return;
      const existing = world.get(key) || null;
      const clean = sanitizeClientObject(socket.id, key, msg[key], existing, now);
      if (!clean) return;
      if (clean.isProjectile) {
        if (now - lastProjectileAt < MIN_MS_BETWEEN_PROJECTILES) return;
        if (clean.isTorpedo && now - lastTorpedoAt < MIN_MS_BETWEEN_TORPEDOES) return;
        lastProjectileAt = now;
        if (clean.isTorpedo) lastTorpedoAt = now;
      }
      lastMsgTime = now;
      isIdle = false;
      world.add(clean);
    });
  });

  initTimer();
});

function generateAIPlayers(robots = ROBOTS) {
  let count = robots;
  const offset = ROBOT_SPAWN_PLACEMENT_OFFSET;
  const fighters = [
    'tieFighter', 'tie1', 'tie2', 'tie3', 'tie4',
  ];
  if (!count) return;
  do {
    const random = Math.random();
    const fighterIndex = random * fighters.length === fighters.length ? 0 : ~~(random * fighters.length);
    const newPlayerUuid = uuid();
    const xOffset = offset * (Math.random() - 0.5);
    const yOffset = offset * (Math.random() - 0.5);
    world.add({
      id: newPlayerUuid,
      isIdle: true,
      isRobot: true,
      pos: {
        x: -122.67399123828811 + xOffset,
        y: 45.53044800949424 + yOffset
      },
      speed: 0.002 + ((Math.random() - 0.5) * 0.002),
      velocity: {
        x: 0,
        y: 0,
      },
      icon: fighters[fighterIndex],
      'icon-size': 0.4,
      time: -1,
      hitCapacity: 5,
      statistics: {
        hitCount: 0,
        kills: 0,
        fireCount: 0,
      }
    });
    count -= 1;
  } while (count > 0)
}

// Robots simulated last frame, so the ones that fell out of range can be stopped.
let activeRobots = [];
let activationStamp = 0;

/**
 * The robots worth simulating this frame: those within ACTIVE_BOX_DEG of a living player. Each gets
 * its target, the nearest player within CHASE_RADIUS, if any. Every other robot sits where it is
 * and costs nothing; hits, blasts and the broadcast still find it through the world grid.
 */
function findActiveRobots() {
  const stamp = ++activationStamp;
  const active = [];
  world.players.forEach((player) => {
    if (player.expired) return;
    world.forEachCraftNear(player.pos, ACTIVE_BOX_DEG, (craft) => {
      if (!craft.isRobot || craft.expired) return;
      // The grid hands back whole cells; only robots inside the box count.
      if (Math.abs(craft.pos.x - player.pos.x) >= ACTIVE_BOX_DEG || Math.abs(craft.pos.y - player.pos.y) >= ACTIVE_BOX_DEG) return;
      if (craft.activeStamp !== stamp) {
        craft.activeStamp = stamp;
        craft.closestPlayer = null;
        craft.closestDistance = CHASE_RADIUS;
        active.push(craft);
      }
      const distance = calcDistance(player.pos, craft.pos);
      if (distance < craft.closestDistance) {
        craft.closestDistance = distance;
        craft.closestPlayer = player.id;
      }
    });
  });
  activeRobots.forEach((robot) => {
    if (robot.activeStamp !== stamp) {
      robot.closestPlayer = null;
      resetFlight(robot);
    }
  });
  activeRobots = active;
  return active;
}

/**
 * Lng/lat and heading of the cannon firing the robot's shot number `shotIndex`.
 * Same geometry as `muzzlePosition` in the-flock (src/layer/addFlockLayer/crafts.js).
 */
function robotMuzzle(robot, shotIndex) {
  const bearing = robot.bearing || 0;
  const cannons = ROBOT_CANNONS[robot.icon];
  if (!cannons) return { x: robot.pos.x, y: robot.pos.y, bearing };
  const cannon = cannons[shotIndex % cannons.length];
  const right = cannon.x * ROBOT_ICON_SIZE * ROBOT_REFERENCE_DEG_PER_PX;
  const forward = cannon.y * ROBOT_ICON_SIZE * ROBOT_REFERENCE_DEG_PER_PX;
  const b = bearing * Math.PI / 180;
  const cosLat = Math.cos(robot.pos.y * Math.PI / 180);
  const toeIn = Math.atan2(cannon.x * ROBOT_ICON_SIZE, ROBOT_CONVERGENCE_PX) * 180 / Math.PI;
  return {
    x: robot.pos.x + right * Math.cos(b) + forward * Math.sin(b),
    y: robot.pos.y + cosLat * (forward * Math.cos(b) - right * Math.sin(b)),
    bearing: bearing - toeIn,
  };
}

function stepRobot(robot, neighbors, now) {
  if (robot.expired) return;
  if (!robot.prevPos) robot.prevPos = {};
  robot.prevPos.x = robot.pos.x;
  robot.prevPos.y = robot.pos.y;
  // In a collision with another fighter: pushed apart, whatever else the robot is doing.
  applyShove(robot, neighbors.get(robot));

  const target = robot.closestPlayer && world.get(robot.closestPlayer);
  if (!target || target.expired) {
    // Nobody to chase: hold position and heading, and start the next chase fresh.
    resetFlight(robot);
    return;
  }

  // Steer away from, and slow for, nearby fighters so they don't fly through each other.
  const plan = adjustPlan(planFlight(robot, target, now), neighbors.get(robot));
  const distanceKm = applyFlight(robot, plan, FPS);
  if (distanceKm > 0) {
    const newPos = calcDestination(robot.pos, distanceKm, robot.bearing);
    robot.pos.x = newPos[0];
    robot.pos.y = newPos[1];
  }

  // Only shoot while flying at the player, not while turning away or retreating.
  if (ENABLE_ENEMY_SHOOTING && plan.canFire) {
    const ran = Math.random();
    if (
      (!robot.statistics.roundShotAt ||
      robot.statistics.roundShotAt &&
      (now - robot.statistics.roundShotAt) > (ENEMY_TIME_BETWEEN_FIRE + ((ran - 0.5) * 1000)))
    ) {
      robot.statistics.fireCount += 1;
      robot.statistics.roundShotAt = now;

      const muzzle = robotMuzzle(robot, robot.statistics.fireCount);
      const projectile = {
        id: robot.id + robot.statistics.roundShotAt,
        pos: { x: muzzle.x, y: muzzle.y },
        prevPos: { x: muzzle.x, y: muzzle.y },
        icon: 'dot-11',
        isProjectile: 'true',
        bearing: muzzle.bearing + ((Math.random() - 0.5) * 0.01) || 0,
        hitValue: 1,
        robotProjectile: 'true',
        ownerId: robot.id,
        time: now,
      };
      world.stage(projectile);
    }
  }
}

/** Moves and shoots the robots near players (see findActiveRobots). */
function animateRobotPlayers(robots, neighbors) {
  const now = Date.now();
  robots.forEach((robot) => {
    stepRobot(robot, neighbors, now);
    world.moved(robot);
  });
}

// Distance flown per projectile, kept off the object because projectiles are serialized to clients.
const projectileTravel = new WeakMap();

function animateProjectiles(projectiles) {
  const now = Date.now();
  projectiles.forEach((obj) => {
    if (obj.expired) return;
    if (!obj.prevPos) obj.prevPos = {
      x: obj.pos.x,
      y: obj.pos.y,
    };
    obj.prevPos.x = obj.prevPos.x != obj.pos.x ? obj.pos.x : obj.prevPos.x;
    obj.prevPos.y = obj.prevPos.y != obj.pos.y ? obj.pos.y : obj.prevPos.y;

    const newPos = calcDestination(obj.pos, PROJECTILE_DISTANCE_TRAVELLED_PER_FRAME, obj.bearing);
    obj.pos.x = newPos[0];
    obj.pos.y = newPos[1];

    const travelled = (projectileTravel.get(obj) || 0) + PROJECTILE_DISTANCE_TRAVELLED_PER_FRAME;
    if (travelled > PROJECTILE_MAX_RANGE_KM) obj.expired = now;
    else projectileTravel.set(obj, travelled);
  });
}


/**
 * Adds damage to a craft and destroys it when its shield is gone: credits the kill,
 * may drop a recharge box, and queues the wreck's explosion in `explosions`.
 */
function damageCraft(craft, amount, killer, now, explosions) {
  craft.statistics.hitCount += amount;
  if (craft.statistics.hitCount < craft.hitCapacity) return;
  craft.expired = now;
  world.markExpired(craft);
  if (killer.id !== craft.id) {
    if (!killer.statistics) killer.statistics = {};
    killer.statistics.kills = (killer.statistics.kills || 0) + 1;
  }
  if (craft.isRobot) spawnDrop(craft, now);
  explosions.push({ pos: { ...craft.pos }, killer });
}

/** Hurts every live craft within `radius` metres of `center`; `skipId` is never affected. */
function applyBlast(center, { radius, core, damage, killer, skipId }, now, explosions) {
  // A degree of longitude is the shorter one here, so its box covers the radius in both directions.
  const boxDeg = radius / (111195 * Math.cos(center.y * Math.PI / 180)) * 1.1;
  world.forEachCraftNear(center, boxDeg, (craft) => {
    if (craft.expired || craft.id === skipId) return;
    const distance = groundDistanceM(center, craft.pos);
    if (distance >= radius) return;
    const falloff = distance <= core ? 1 : 1 - (distance - core) / (radius - core);
    damageCraft(craft, damage * falloff, killer, now, explosions);
  });
}

/** Each live shot hits the nearest craft within its reach (never its owner). */
function updateCraftHitPoints(projectiles, explosions) {
  const now = Date.now();
  projectiles.forEach((projectile) => {
    if (projectile.expired) return;
    const owner = world.get(projectile.ownerId);
    if (!owner) return;
    const reach = projectile.isTorpedo ? TORPEDO_FUSE_DISTANCE : PROJECTILE_HIT_DISTANCE;
    let target = null;
    let nearest = reach;
    world.forEachCraftNear(projectile.pos, HIT_REACH_DEG, (craft) => {
      if (craft.expired || craft.id === projectile.ownerId) return;
      const distance = calcDistance(craft.pos, projectile.pos);
      if (distance < nearest) {
        nearest = distance;
        target = craft;
      }
    });
    if (!target) return;

    projectile.expired = now;
    if (projectile.isTorpedo) {
      spawnBlast(projectile.pos, now);
      // The shooter is safe from its own torpedo, like it is from its lasers.
      applyBlast(projectile.pos, { ...TORPEDO_BLAST, damage: projectile.hitValue, killer: owner, skipId: owner.id }, now, explosions);
    } else {
      damageCraft(target, projectile.hitValue || 1, owner, now, explosions);
    }
  });
}

/** Wrecks explode and hurt what is near them. That can destroy more craft, so work through a queue. */
function detonateWrecks(explosions) {
  const now = Date.now();
  while (explosions.length) {
    const { pos, killer } = explosions.pop();
    applyBlast(pos, { ...CRAFT_EXPLOSION, killer }, now, explosions);
  }
}

function spawnBlast(pos, now) {
  const id = uuid();
  world.stage({
    id,
    isBlast: true,
    pos: { ...pos },
    prevPos: { ...pos },
    icon: 'explosion-point',
    // Roughly the blast radius at zoom 16.
    'icon-size': 0.6,
    time: now,
  });
}

function spawnDrop(craft, now) {
  if (Math.random() >= DROP_CHANCE) return;
  const id = uuid();
  world.stage({
    id,
    isDrop: true,
    dropType: 'recharge',
    pos: { ...craft.pos },
    prevPos: { ...craft.pos },
    icon: 'rechargeBox',
    'icon-size': 0.5,
    time: now,
  });
}

function collectDrops() {
  world.drops.forEach((drop) => {
    if (drop.collected) return;
    for (const player of world.players) {
      if (player.expired || calcDistance(player.pos, drop.pos) >= DROP_PICKUP_DISTANCE) continue;
      drop.collected = true;
      player.statistics.hitCount = Math.max(0, player.statistics.hitCount - player.hitCapacity * DROP_RECHARGE_FRACTION);
      break;
    }
  });
}

const SWEEP = {
  projectileLifetimeMs: PROJECTILE_LIFETIME,
  dropLifetimeMs: DROP_LIFETIME,
  blastDisplayMs: BLAST_DISPLAY_MS,
  wreckMs: WRECK_MS,
};

function updateObjects() {
  const now = Date.now();
  const robots = findActiveRobots();
  const neighbors = findNeighbors(robots);
  animateRobotPlayers(robots, neighbors);
  const projectiles = Array.from(world.projectiles);
  animateProjectiles(projectiles);
  const explosions = [];
  updateCraftHitPoints(projectiles, explosions);
  // Fighters flying through each other hurt both; nobody gets a kill for it (the "killer" is the craft itself).
  robotsToDamage(neighbors, now).forEach(({ robot, amount }) => {
    if (!robot.expired) damageCraft(robot, amount, robot, now, explosions);
  });
  detonateWrecks(explosions);
  collectDrops();
  world.sweep(now, SWEEP);
  world.flushPending();
}

function renderLoop() {
  const frameTime = process.hrtime();
  if (PRINT_STATS_TO_CONSOLE && !gameData.startOfPeriod) {
    gameData.startOfPeriod = process.hrtime();
  }

  updateObjects();

  if (lastMsgTime - Date.now() > 1000) {
    isIdle = true;
    clearInterval(batchTimer);
  }
  if (world.size) {
    // Compare/encode each object once, then build every player's packet from the shared strings.
    const frame = beginFrame(world.dynamicObjects(), HIDE_CELL_DEG);
    const craftNear = (pos, box, fn) => world.forEachCraftNear(pos, box, fn);
    Object.keys(socketConnections).forEach((id) => {
      const player = world.get(id);
      if (!player) return;
      const socket = socketConnections[id];
      const packet = buildPacket(socket.data.known, visibleEntries(frame, player.pos, HIDE_OBJS_PAST_RADIUS, craftNear), socket.data.fresh);
      socket.data.fresh = false;
      if (packet) socket.conn.send(packet);
    });
    endFrame();
  }

  const ms = process.hrtime(frameTime)[1] / 1000000;
  gameData.totalSm += ms;
  if (PRINT_STATS_TO_CONSOLE) {
    const duration = process.hrtime(gameData.startOfPeriod);
    if (duration[0] > 0) {
      console.reset();
      console.info('Configuration', {PORT, FPS, ROBOTS});
      console.info('Players: %d', world.players.size);
      console.info('Robots: %d', world.robots.size);
      console.info('Projectiles: %d', world.projectiles.size);
      console.info('Frame Avg Duration (ms)', gameData.totalSm / gameData.frames);
      console.info('Frames/Second', gameData.frames);
      gameData.startOfPeriod = null;
      gameData.frames = 0;
      gameData.totalSm = 0;
    }
    gameData.frames += 1;
  }
}

function initTimer() {
  if (batchTimer) return;
  batchTimer = setInterval(renderLoop, 1000 / FPS);
  console.log('PORT', PORT);
  console.log('FPS', FPS);
  console.log('ROBOTS', ROBOTS);
  console.log('HIDE_OBJS_PAST_RADIUS', HIDE_OBJS_PAST_RADIUS);
  console.log('ROBOT_SPAWN_PLACEMENT_OFFSET', ROBOT_SPAWN_PLACEMENT_OFFSET);
  console.log('ENABLE_ENEMY_SHOOTING', ENABLE_ENEMY_SHOOTING);
  console.log('PROJECTILE_LIFETIME', PROJECTILE_LIFETIME);
  console.log('PROJECTILE_DISTANCE_TRAVELLED_PER_FRAME', PROJECTILE_DISTANCE_TRAVELLED_PER_FRAME);
  console.log('PROJECTILE_HIT_DISTANCE', PROJECTILE_HIT_DISTANCE);
  console.log('PRINT_STATS_TO_CONSOLE', PRINT_STATS_TO_CONSOLE);

  generateAIPlayers();
}

function calcDistance(p1, p2) {
  const x = p2.x - p1.x;
  const y = p2.y - p1.y;
  return Math.hypot(x*x, y*y);
}

function degreesToRadians(degrees) {
  var radians = degrees % 360;
  return radians * Math.PI / 180;
}

function radiansToDegrees(radians) {
  var degrees = radians % (2 * Math.PI);
  return degrees * 180 / Math.PI;
}
function lengthToRadians(distance) {
  const earthRadiusKm = 6371008.8 / 1000;
  return distance / earthRadiusKm;
}

function calcDestination(coords, distance, bearing) {
  var longitude1 = degreesToRadians(coords.x);
  var latitude1 = degreesToRadians(coords.y);
  var bearingRad = degreesToRadians(bearing);
  var radians = lengthToRadians(distance);

  var latitude2 = Math.asin(Math.sin(latitude1) * Math.cos(radians) +
      Math.cos(latitude1) * Math.sin(radians) * Math.cos(bearingRad));
  var longitude2 = longitude1 + Math.atan2(Math.sin(bearingRad) * Math.sin(radians) * Math.cos(latitude1), Math.cos(radians) - Math.sin(latitude1) * Math.sin(latitude2));
  var lng = radiansToDegrees(longitude2);
  var lat = radiansToDegrees(latitude2);
  return [lng, lat];
}