const { v4: uuid } = require('uuid');
const app = require('express')();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
let batchTimer = null;
const gameData = {
  objectsById: {},
};
let lastMsgTime = 0;
let isIdle = false;
let fps = 30;

http.listen(3001, function(){
  console.log('listening on 0.0.0.0:3001');
});

io.on('connection', function(socket) {
  console.log('New Player ID:', socket.id);
  socket.emit('connected', socket.id);

  socket.on('disconnect', function (msg) {
    // console.log('Player ID disconnected', socket.id, msg);
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
  let count = 100;
  if (!count) return;
  do {
    const newPlayerUuid = uuid();
    gameData.objectsById[newPlayerUuid] = {
      id: newPlayerUuid,
      isIdle: true,
      isRobot: true,
      pos: {
        x: -122.67399123828811,
        y: 45.53044800949424
      },
      velocity: {
        x: 0,
        y: 0,
      },
      icon: 'airfield-11',
      time: -1, // forever
    }
    count -= 1;
  } while (count > 0)
}

// function

function animateRobotPlayers() {
  Object.values(gameData.objectsById).map((robot) => {
    if (!robot.isRobot) return;
    if (!robot.prevPos) robot.prevPos = {};
    robot.prevPos.x = robot.pos.x;
    robot.prevPos.y = robot.pos.y;

    robot.pos.x += (Math.random() - 0.5) * 0.0001;
    robot.pos.y += (Math.random() - 0.5) * 0.0001;

    robot.bearing = robot.prevPos ? -bearing(robot.prevPos.x, robot.prevPos.y, robot.pos.x, robot.pos.y) + 90 : null;
  });
}

function animateProjectiles() {
  Object.values(gameData.objectsById).map((obj) => {
    if (!obj.isProjectile) return;
    if (obj.bearing === undefined) return;
    if (!obj.prevPos) obj.prevPos = {
      x: obj.pos.x,
      y: obj.pos.y,
    };
    obj.prevPos.x = obj.prevPos.x != obj.pos.x ? obj.pos.x : obj.prevPos.x;
    obj.prevPos.y = obj.prevPos.y != obj.pos.y ? obj.pos.y : obj.prevPos.y;

    const newPos = destination(obj.pos, 0.03, obj.bearing);
    obj.pos.x = newPos[0];
    obj.pos.y = newPos[1];
  });
}

function removeExpiredObjects() {
  gameData.objectsById = Object.values(gameData.objectsById).reduce((sum, item) => {
    if (!gameData.objectsById[item.id]) return sum;
    if (gameData.objectsById[item.id].isProjectile && Date.now() - gameData.objectsById[item.id].time < 1000) {
      sum[item.id] = item;
      return sum;
    };
    if (gameData.objectsById[item.id].time === -1) {
      sum[item.id] = item;
      return sum;
    }
    if (Date.now() - gameData.objectsById[item.id].time < 1000) {
      sum[item.id] = item;
    }
    return sum;
  }, {});
}

function updateObjects() {
  animateRobotPlayers();
  animateProjectiles();
  removeExpiredObjects();
}

function initTimer() {
  if (batchTimer) return;
  batchTimer = setInterval(() => {

    updateObjects();

    if (lastMsgTime - Date.now() > 1000) {
      isIdle = true;
      clearInterval(batchTimer);
    }
    if (Object.keys(gameData.objectsById).length) {
      io.emit('message-all', {
        ...gameData.objectsById,
      });
    }
  }, 1000 / fps);

  generateAIPlayers();
}

function toDeg(rad) {
  return rad * 180 / Math.PI;
}

function bearing(lat1,lng1,lat2,lng2) {
  const dLon = (lng2-lng1);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1)*Math.sin(lat2) - Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
  const brng = toDeg(Math.atan2(y, x));
  return 360 - ((brng + 360) % 360);
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

function destination(coords, distance, bearing) {
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