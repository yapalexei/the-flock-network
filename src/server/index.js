const { v4: uuid } = require('uuid');
const e = require('express');
const app = require('express')();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

const PRINT_STATS_TO_CONSOLE = process.env.PRINT_STATS_TO_CONSOLE || 0;
const PORT = process.env.PORT || 3001;
const FPS = process.env.FPS || 30;
const ROBOTS = process.env.ROBOTS || 500;
const HIDE_OBJS_PAST_RADIUS = process.env.HIDE_OBJS_PAST_RADIUS || 0.0001;
const ROBOT_SPAWN_PLACEMENT_OFFSET = process.env.ROBOT_SPAWN_PLACEMENT_OFFSET || 0.3;
const ENABLE_ENEMY_SHOOTING = process.env.ENABLE_ENEMY_SHOOTING || 1

const PROJECTILE_LIFETIME = 5000;
const PROJECTILE_DISTANCE_TRAVELLED_PER_FRAME = 0.05;
const PROJECTILE_HIT_DISTANCE = 0.00000005;

console.reset = function () {
  return process.stdout.write('\033c');
}

let batchTimer = null;
const gameData = {
  objectsById: {},
  robotProjectiles: {},
};
const socketConnections = {};

let lastMsgTime = 0;
let isIdle = false;

const HOST = process.env.HOST || '0.0.0.0';

http.listen(PORT, HOST, function(){
  console.log(`listening on ${HOST}:${PORT}`);
});

io.on('connection', function(socket) {
  socketConnections[socket.id] = socket;
  console.log('New Player ID:', socket.id);
  socket.emit('connected', socket.id);

  socket.on('disconnect', function (msg) {
    io.emit('object removed', socket.id);
    delete gameData.objectsById[socket.id];
    delete socketConnections[socket.id];
  });

  socket.on('reset game', (msg) => {
    console.log('game reset triggered by:', socket.id);
    gameData.objectsById = {};
    setTimeout(() => {
      console.log('initiating reset', msg);
      if (msg && msg.robots && typeof msg.robots === 'number' && msg.robots >= 0 && msg.robots < 5000) {
        generateAIPlayers(msg.robots);
      } else {
        generateAIPlayers();
      }
    }, 5000);
  });

  socket.on('message', (msg) => {
    if (msg && typeof msg === 'object') {
      lastMsgTime = Date.now();
      isIdle = false;
      Object.keys(msg).map((key) => {
        if (gameData.objectsById[key]) {
          const { statistics } = gameData.objectsById[key];
          gameData.objectsById[key] = {
            ...msg[key],
            statistics,
          };
        } else {
          gameData.objectsById[key] = msg[key];
        }
      });
    }
  });

  initTimer();
});

function generateAIPlayers(robots = ROBOTS) {
  let count = robots;
  const offset = ROBOT_SPAWN_PLACEMENT_OFFSET;
  const fighters = [
    'vultureDroid', 'tieFighter', 'tie1', 'tie2', 'tie3', 'tie4',
    // 'xWing', 'xWing1', 'xWing2', 'yWing',
  ];
  if (!count) return;
  do {
    const random = Math.random();
    const fighterIndex = random * fighters.length === fighters.length ? 0 : ~~(random * fighters.length);
    const newPlayerUuid = uuid();
    const xOffset = offset * (Math.random() - 0.5);
    const yOffset = offset * (Math.random() - 0.5);
    gameData.objectsById[newPlayerUuid] = {
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
      'icon-size': 0.5,
      time: -1,
      hitCapacity: 5,
      statistics: {
        hitCount: 0,
        kills: 0,
        fireCount: 0,
      }
    }
    count -= 1;
  } while (count > 0)
}

function findClosestPlayerWithinRadius(craftObjs, radius = 0.0001) {
  const robots = craftObjs.filter((obj) => obj.isRobot);
  const players = craftObjs.filter((obj) => !obj.isRobot && obj.isProjectile !== 'true');
  robots.forEach((craft) => {
    craft.closestPlayer = null;
    players.forEach((player) => {
      if (player && craft && player.id !== craft.id && player.pos) {
        const distance = calcDistance(player.pos, craft.pos);
        if (distance < radius) {
          craft.closestPlayer = player.id;
        }
      }
    });
  });
}
const TIME_BETWEEN_FIRE = 1000;
function animateRobotPlayers(allObj) {
  const now = Date.now();
  allObj.map((robot) => {
    if (!robot.isRobot) return;
    if (robot.expired) return;
    if (!robot.prevPos) robot.prevPos = {};
    robot.prevPos.x = robot.pos.x;
    robot.prevPos.y = robot.pos.y;

    if (robot.closestPlayer) {
      const closestPlayer = gameData.objectsById[robot.closestPlayer];
      if (closestPlayer) {
        const calculatedBearing = calcBearing(robot.pos.x, robot.pos.y, closestPlayer.pos.x, closestPlayer.pos.y);
        const bearingDiff = calculatedBearing - robot.bearing;
        const newBearing = bearingDiff > 5 ? robot.bearing + 5 : calculatedBearing;
        robot.bearing = newBearing;

        const newPos = calcDestination(robot.pos, robot.speed, robot.bearing);

        robot.pos.x = newPos[0];
        robot.pos.y = newPos[1];

        if (ENABLE_ENEMY_SHOOTING) {
          if (
            !robot.statistics.roundShotAt ||
            robot.statistics.roundShotAt &&
            (now - robot.statistics.roundShotAt) > TIME_BETWEEN_FIRE
          ) {
            robot.statistics.fireCount += 1;
            robot.statistics.roundShotAt = now;

            const projectile = {
              id: robot.id + robot.statistics.roundShotAt,
              pos: {...robot.pos},
              prevPos: {...robot.pos},
              icon: 'dot-11',
              isProjectile: 'true',
              bearing: robot.bearing + ((Math.random() - 0.5) * 0.005) || 0,
              hitValue: 1,
              robotProjectile: 'true',
              ownerId: robot.id,
              time: now,
            };
            gameData.robotProjectiles[projectile.id] = projectile;
          }
        }
      }
    } else {
      robot.bearing = robot.prevPos ? calcBearing(robot.prevPos.x, robot.prevPos.y, robot.pos.x, robot.pos.y) : 0;
    }
  });
}

function animateProjectiles(projectiles) {
  projectiles.map((obj) => {
    if (!obj.prevPos) obj.prevPos = {
      x: obj.pos.x,
      y: obj.pos.y,
    };
    obj.prevPos.x = obj.prevPos.x != obj.pos.x ? obj.pos.x : obj.prevPos.x;
    obj.prevPos.y = obj.prevPos.y != obj.pos.y ? obj.pos.y : obj.prevPos.y;

    const newPos = calcDestination(obj.pos, PROJECTILE_DISTANCE_TRAVELLED_PER_FRAME, obj.bearing);
    obj.pos.x = newPos[0];
    obj.pos.y = newPos[1];
  });
}

function removeExpiredObjects(allObj) {
  const now = Date.now();
  gameData.objectsById = allObj.reduce((sum, item) => {
    if (item.isProjectile && !item.expired && now - item.time > PROJECTILE_LIFETIME) {
      item.expired = now;
      sum[item.id] = item;
      return sum;
    };

    if (item.expired && (now - item.expired) > 500) {
      return sum;
    } else {
      sum[item.id] = item;
    }

    return sum;
  }, {});
}

function updateCraftHitPoints(craftObjs, projectiles) {
  const now = Date.now();
  craftObjs.forEach((craft) => {
    if (!craft.expired) {
      projectiles.forEach((projectile) => {
        if (projectile.expired) return;
        const playerObj = gameData.objectsById[projectile.ownerId];
        if (!playerObj) return;
        if (projectile.ownerId === craft.id) return;
        if (!playerObj.statistics) playerObj.statistics = {};
        if (!playerObj.statistics.kills) playerObj.statistics.kills = 0;
        const dist = calcDistance(craft.pos, projectile.pos);

        if (dist < PROJECTILE_HIT_DISTANCE) {
          projectile.expired = now
          craft.statistics.hitCount += projectile.hitValue || 1;
          if (craft.statistics.hitCount >= craft.hitCapacity) {
            if (!playerObj.statistics.kills) playerObj.statistics.kills = 0
            playerObj.statistics.kills += 1;
            craft.expired = now;
          }
        }
      });
    }
  });
}

function updateObjects() {
  const startOfLoop = process.hrtime();
  if (!gameData.printTime) {
    gameData.printTime = startOfLoop;
  }
  const allObj = Object.values(gameData.objectsById);
  const craftObjs = allObj.filter(obj => !obj.isProjectile);
  const playerObjs = allObj.filter(obj => obj.isPlayer);
  const robotObjs = allObj.filter(obj => obj.isRobot);
  const projectiles = allObj.filter(obj => obj.isProjectile);

  // const robotProjectiles = allObj.filter(obj => obj.robotProjectile);
  findClosestPlayerWithinRadius(craftObjs);
  animateRobotPlayers(craftObjs);
  animateProjectiles(projectiles);
  updateCraftHitPoints(craftObjs, projectiles);
  removeExpiredObjects(allObj); // must be last

  const res = process.hrtime(gameData.printTime)[1] / 1000000;
  if (PRINT_STATS_TO_CONSOLE && ~~res > 900) {
    gameData.printTime = null;
    console.reset();
    console.info({PORT, FPS, ROBOTS});
    // console.info('Loop time: %dms', res);
    console.info('Players: %d', playerObjs.length);
    console.info('Robots: %d', robotObjs.length);
    console.info('Projectiles: %d', projectiles.length);
  }

  gameData.objectsById = {
    ...gameData.objectsById,
    ...gameData.robotProjectiles,
  };
  gameData.robotProjectiles = {};
}

function filterOutTooFar(player, allObs) {
  return allObs.reduce((sum, obj) => {
    const dist = calcDistance(player.pos, obj.pos);
    if (dist < HIDE_OBJS_PAST_RADIUS) {
      sum[obj.id] = obj;
    };
    return sum;
  }, {});
}

function renderLoop() {
  updateObjects();

  if (lastMsgTime - Date.now() > 1000) {
    isIdle = true;
    clearInterval(batchTimer);
  }
  const allObs = Object.values(gameData.objectsById);
  if (Object.keys(gameData.objectsById).length) {
    Object.keys(socketConnections).forEach((id) => {
      if (gameData.objectsById[id]) {
        const res = filterOutTooFar(gameData.objectsById[id], allObs);
        socketConnections[id].emit('message-all', res);
      }
    });
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

function toDeg(rad) {
  return rad * 180 / Math.PI;
}

function calcDistance(p1, p2) {
  const x = p2.x - p1.x;
  const y = p2.y - p1.y;
  return Math.hypot(x*x, y*y);
}

function calcBearing(lat1,lng1,lat2,lng2) {
  const dLon = (lng2-lng1);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1)*Math.sin(lat2) - Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
  const brng = toDeg(Math.atan2(y, x));
  return -(360 - ((brng + 360) % 360)) + 90;
};

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