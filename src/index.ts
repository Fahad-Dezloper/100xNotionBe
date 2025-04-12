/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { config } from 'dotenv';
config();

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL is not defined in the environment variables');
}

console.log('Redis URL:', process.env.REDIS_URL);
const redis = new Redis(process.env.REDIS_URL);
const sub = new Redis(process.env.REDIS_URL);

const wss = new WebSocketServer({ port: 8080 });

const users: { [key: string]: import('ws').WebSocket } = {};
const rooms: { [key: string]: string[] } = {};

const ROOMS_KEY = 'ws:rooms';
const MESSAGES_KEY = 'ws:messages';
const USER_COUNT_KEY = 'ws:user_count';
const MESSAGE_EXPIRY = 60 * 60 * 12;

async function initServer() {
  sub.subscribe('ws:broadcast');
  sub.on('message', (channel, message) => {
    const data = JSON.parse(message);
    broadcastToClients(data, true);
  });
  
  console.log('WebSocket server initialized with Redis');
}

function broadcastToClients(data: any, fromRedis = false) {
  console.log("broadcastToClients", data);
  const roomKey = data.room;
  const roomUsers = rooms[roomKey] || [];
  
  if (roomUsers.length > 0) {
    wss.clients.forEach(client => {
      const clientUserId = Object.keys(users).find(id => users[id] === client);
      if (client.readyState === WebSocket.OPEN && 
          clientUserId && 
          roomUsers.includes(clientUserId)) {
        client.send(JSON.stringify(data));
      }
    });
  } else {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  }
  
  if (!fromRedis && data.type === 'message') {
    pub.publish('ws:broadcast', JSON.stringify(data));
  }
}


async function storeMessage(roomKey: string, messageData: any) {
  const messageId = uuidv4();
  const storedData = {
    ...messageData,
    id: messageId,
    timestamp: Date.now()
  };
  
  const messageListKey = `${MESSAGES_KEY}:${roomKey}`;
  
  await redis.lpush(messageListKey, JSON.stringify(storedData));
  
  await redis.ltrim(messageListKey, 0, 999);
  
  await redis.expire(messageListKey, MESSAGE_EXPIRY);
  
  return storedData;
}

async function getMessageHistory(roomKey: string, limit = 100) {
  const messageListKey = `${MESSAGES_KEY}:${roomKey}`;
  const messages = await redis.lrange(messageListKey, 0, limit - 1);
  
  await redis.expire(messageListKey, MESSAGE_EXPIRY);
  
  return messages.map(msg => JSON.parse(msg));
}

wss.on('connection', function connection(ws: import('ws').WebSocket) {
  let userId: string | null = null;
  const userRooms: string[] = [];
  
  ws.on('error', console.error);

  ws.on('message', async function message(rawMessage) {
    try {
      const data = JSON.parse(rawMessage.toString());
      // console.log('received:', data);

      switch (data.type) {
        case 'join': {
          userId = data.userId || uuidv4();
          if (userId) {
            users[userId] = ws;
          }
          // console.log(`User ${userId} joined ${data.roomId}`);
          
          ws.send(JSON.stringify({
            type: 'joined',
            userId: userId,
            roomId: data.roomId,
          }));

          if (!data.roomId) break;
          const roomKey = data.roomId;
          if (!rooms[roomKey]) {
            rooms[roomKey] = [];
            
            const roomData = await redis.hget(ROOMS_KEY, roomKey);
            if (roomData) {
              rooms[roomKey] = JSON.parse(roomData);
            }
          }
          
          if (userId) {
            rooms[roomKey].push(userId);
          }
          userRooms.push(roomKey);
          
          await redis.hset(ROOMS_KEY, roomKey, JSON.stringify(rooms[roomKey]));
          
          const history = await getMessageHistory(roomKey);
          // console.log(roomKey, 'history:', history);
          ws.send(JSON.stringify({
            type: 'message_history',
            room: roomKey,
            messages: history
          }));
          
          broadcastToClients({
            type: 'user_joined_room',
            room: roomKey,
            userId: userId,
            totalUsers: rooms[roomKey].length
          });
          
          break;
        }
        
        case 'message': {
          if (!userId) break;
          
          const roomKey = data.roomId;
          console.log("message roomKey", roomKey);
          
          // Store message in Redis with proper expiration
          const messageData = await storeMessage(roomKey, {
            sender: userId,
            content: data.content,
            room: roomKey
          });

          console.log("message data", messageData);
          
          
          broadcastToClients({
            type: 'message',
            ...messageData
          });
          
          break;
        }
        
        case 'get_history': {
          if (!userId) break;
          
          const roomKey = data.roomId;
          const history = await getMessageHistory(roomKey, data.limit || 100);
          
          ws.send(JSON.stringify({
            type: 'message_history',
            room: roomKey,
            messages: history
          }));
          
          break;
        }
      }
    } catch (error) {
      console.error('Error Processing Message', error);
    }
  });

  ws.on('close', async () => {
    if (!userId) return;
    
    delete users[userId];
    console.log(`User ${userId} disconnected`);

    for (const roomKey of userRooms) {
      if (rooms[roomKey]?.includes(userId)) {
        rooms[roomKey] = rooms[roomKey].filter(id => id !== userId);
        
        if (rooms[roomKey].length > 0) {
          await redis.hset(ROOMS_KEY, roomKey, JSON.stringify(rooms[roomKey]));
        } else {
          await redis.hdel(ROOMS_KEY, roomKey);
        }
        
        broadcastToClients({
          type: 'user_left_room',
          room: roomKey,
          userId,
          totalUsers: rooms[roomKey].length
        });
      }
    }
  });
});

initServer().then(() => {
  console.log('WebSocket server started on port 8080 with enhanced Redis persistence');
});

const pub = redis;