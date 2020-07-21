const { v4: uuid } = require('uuid');
var app = require('express')();
var http = require('http').createServer(app);
var io = require('socket.io')(http);
// var CWD = process.cwd();
const usersById = {};
let batchTimer = null;
let batchedMessagesById = {};
// const userIsConnectedTimersById = {};
let lastMsgTime = 0;
let isIdle = false;
let fps = 30;

http.listen(3001, function(){
  console.log('listening on 0.0.0.0:3001');
});

io.on('connection', function(socket) {
  console.log('newPlayerUuid', socket.id, socket.connected);
  usersById[socket.id] = true;
  socket.emit('connected', socket.id);

  socket.on('disconnect', function (msg) {
    console.log('disconnected', socket.id, msg);
    io.emit('user disconnected', socket.id);
    delete usersById[socket.id];
  });

  socket.on('message', (msg) => {
    lastMsgTime = Date.now();
    isIdle = false;
    Object.keys(msg).map((key) => {
      batchedMessagesById[key] = msg[key];
    });
    if (!batchTimer) initTimer();
  });

  initTimer();
});

function removeExpiredObjects(byId) {
  return Object.values(byId).reduce((sum, item) => {
    if (Date.now() - byId[item.id].time < 5000) {
      sum[item.id] = item;
    }
    return sum;
  }, {});
}

function initTimer() {
  batchTimer = setInterval(() => {
    batchedMessagesById = removeExpiredObjects(batchedMessagesById);

    if (lastMsgTime - Date.now() > 1000) {
      isIdle = true;
      clearInterval(batchTimer);
    }
    if (Object.keys(batchedMessagesById).length) {
      // console.log(batchedMessagesById);
      io.emit('message-all', batchedMessagesById);
    }
  }, 1000 / fps);
}
