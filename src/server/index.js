const { v4: uuid } = require('uuid');
var app = require('express')();
var http = require('http').createServer(app);
var io = require('socket.io')(http);
let batchTimer = null;
let batchedMessagesById = {};
let robotsById = {};
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
    console.log('Player ID disconnected', socket.id, msg);
    io.emit('user disconnected', socket.id);
    delete batchedMessagesById[socket.id];
  });

  socket.on('message', (msg) => {
    lastMsgTime = Date.now();
    isIdle = false;
    Object.keys(msg).map((key) => {
      batchedMessagesById[key] = msg[key];
    });
  });

  initTimer();
});

function generateAIPlayers() {
  let count = 1;
  do {
    const newPlayerUuid = uuid();
    robotsById[newPlayerUuid] = {
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
    }
    count -= 1;
  } while (count > 0)
}

// function

function animateRobotPlayers() {
  Object.values(robotsById).map((robot) => {
    robot.pos.x += (Math.random() - 0.5) * 0.0001;
    robot.pos.y += (Math.random() - 0.5) * 0.0001;
  });
}

function removeExpiredObjects(byId) {
  return Object.values(byId).reduce((sum, item) => {
    if (Date.now() - byId[item.id].time < 5000) {
      sum[item.id] = item;
    }
    return sum;
  }, {});
}

function initTimer() {
  if (batchTimer) return;
  batchTimer = setInterval(() => {
    animateRobotPlayers();
    batchedMessagesById = removeExpiredObjects(batchedMessagesById);

    if (lastMsgTime - Date.now() > 1000) {
      isIdle = true;
      clearInterval(batchTimer);
    }
    if (Object.keys(batchedMessagesById).length || Object.keys(robotsById).length) {
      io.emit('message-all', {
        ...batchedMessagesById,
        ...robotsById,
      });
    }
  }, 1000 / fps);

  generateAIPlayers();
}
