const { v4: uuid } = require('uuid');
const app = require('express')();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

console.reset = function () {
  return process.stdout.write('\033c');
}

const PROJECTILE_DISTANCE_TRAVELLED_PER_FRAME = 0.02;
const HIT_DISTANCE = 0.00000001;
const FPS = 30;
const ROBOTS = 100;

let batchTimer = null;
const gameData = {
  objectsById: {},
};
let lastMsgTime = 0;
let isIdle = false;

http.listen(3001, function(){
  console.log('listening on 0.0.0.0:3001');
});

io.on('connection', function(socket) {
  console.log('New Player ID:', socket.id);
  socket.emit('connected', socket.id);

  socket.on('disconnect', function (msg) {
    io.emit('object removed', socket.id);
    delete gameData.objectsById[socket.id];
  });

  socket.on('message', (msg) => {
    lastMsgTime = Date.now();
    isIdle = false;
    Object.keys(msg).map((key) => {
      gameData.objectsById[key] = msg[key];
    });
  });

  initTimer();
});

function generateAIPlayers() {
  let count = ROBOTS;
  const offset = 0.02;
  const fighters = ['vultureDroid', 'tieFighter', 'tie1', 'tie2', 'tie3', 'tie4'];
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
      speed: 0.001 + ((Math.random() - 0.5) * 0.001),
      velocity: {
        x: 0,
        y: 0,
      },
      icon: fighters[fighterIndex],
      'icon-size': 0.6,
      time: -1, // forever
    }
    count -= 1;
  } while (count > 0)
}

function findClosestPlayerWithinRadius(craftObjs, radius = 0.00001) {
  const robots = craftObjs.filter((obj) => obj.isRobot);
  const players = craftObjs.filter((obj) => !obj.isRobot && obj.isProjectile !== 'true');
  robots.forEach((craft) => {
    if (craft.closestProjectile) {
      if (!gameData.objectsById[craft.closestProjectile.obj.id]) {
        craft.closestProjectile = null;
      }
    }

    players.forEach((obj) => {
      if (obj.id !== craft.id && !obj.isRobot) {
        const distance = calcDistance(obj.pos, craft.pos);
        if (distance < radius) {
          craft.closestPlayer = obj.id;
        } else {
          craft.closestPlayer = null; // when too far
        }
      }
    });
  });
}

function calcDistance(p1, p2) {
  const x = p2.x - p1.x;
  const y = p2.y - p1.y;
  return Math.hypot(x*x, y*y);
}

function animateRobotPlayers(allObj) {
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
      }
    } else {
      // robot.pos.x += (Math.random() - 0.5) * 0.0001;
      // robot.pos.y += (Math.random() - 0.5) * 0.0001;
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
    if (!gameData.objectsById[item.id]) return sum;

    // if (gameData.objectsById[item.id].isRobot && gameData.objectsById[item.id].time === -1) {

    if (item.closestProjectile && item.closestProjectile.distance < HIT_DISTANCE && !item.expired) {
      item.closestProjectile.obj.expired = now;
      item.expired = now;
      sum[item.closestProjectile.obj.id] = item.closestProjectile.obj;
      sum[item.id] = item;
      return sum;
    }
    // }

    if ((now - item.expired) > 50) {
      return sum;
    }

    if (gameData.objectsById[item.id].isProjectile && now - gameData.objectsById[item.id].time < 1000) {
      sum[item.id] = item;
      return sum;
    };
    if (gameData.objectsById[item.id].time === -1) {
      sum[item.id] = item;
      return sum;
    }
    if (now - gameData.objectsById[item.id].time < 1000) {
      sum[item.id] = item;
      return sum;
    }

    return sum;
  }, {});
}

function updateCraftHitPoints(craftObjs, projectiles) {
  craftObjs.forEach((craft) => {
    if (craft.isRobot) {
      projectiles.forEach((projectile) => {
        const dist = calcDistance(craft.pos, projectile.pos);
        if (craft.closestProjectile && craft.closestProjectile.distance > dist) {
          craft.closestProjectile = {
            distance: dist,
            obj: projectile,
          };
        } else {
          craft.closestProjectile = {
            distance: dist,
            obj: projectile,
          };
        }
      });
    }
  });
}

function updateObjects() {
  const startOfLoop = process.hrtime();
  const allObj = Object.values(gameData.objectsById);
  const craftObjs = allObj.filter(obj => !obj.isProjectile);
  const playerObjs = allObj.filter(obj => obj.isPlayer);
  const robotObjs = allObj.filter(obj => obj.isRobot);
  const projectiles = allObj.filter(obj => obj.isProjectile);
  findClosestPlayerWithinRadius(craftObjs);
  animateRobotPlayers(craftObjs);
  animateProjectiles(projectiles);
  updateCraftHitPoints(craftObjs, projectiles);
  removeExpiredObjects(allObj); // must be last
  const res = process.hrtime(startOfLoop);
  console.reset();
  console.info('Loop time: %dms', res[1] / 1000000);
  console.info('Players: %d', playerObjs.length);
  console.info('Robots: %d', robotObjs.length);
  console.info('Projectiles: %d', projectiles.length);
}

function renderLoop() {
  updateObjects();

  if (lastMsgTime - Date.now() > 1000) {
    isIdle = true;
    clearInterval(batchTimer);
  }
  if (Object.keys(gameData.objectsById).length) {
    io.emit('message-all', { ...gameData.objectsById });
  }
}

function initTimer() {
  if (batchTimer) return;
  batchTimer = setInterval(renderLoop, 1000 / FPS);

  generateAIPlayers();
}

function toDeg(rad) {
  return rad * 180 / Math.PI;
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