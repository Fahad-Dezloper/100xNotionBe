/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

// Create Redis clients
const redis = new Redis(); // For general operations
const sub = new Redis();   // For subscriptions

// WebSocket server setup
const wss = new WebSocketServer({ port: 8080 });

// Local storage for active connections
const users: { [key: string]: import('ws').WebSocket } = {};
const rooms: { [key: string]: string[] } = {};

// Redis keys and constants
const ROOMS_KEY = 'ws:rooms';
const MESSAGES_KEY = 'ws:messages';
const USER_COUNT_KEY = 'ws:user_count';
const MESSAGE_EXPIRY = 60 * 60 * 12; // 12 hours in seconds

// Initialize server
async function initServer() {
  // Set up Redis subscription for messages between server instances
  sub.subscribe('ws:broadcast');
  sub.on('message', (channel, message) => {
    const data = JSON.parse(message);
    broadcastToClients(data, true);
  });
  
  console.log('WebSocket server initialized with Redis');
}

// Handle broadcasting messages to clients
function broadcastToClients(data: any, fromRedis = false) {
  // If message has a room field, only send to users in that room
  console.log("broadcastToClients", data);
  const roomKey = data.room;
  const roomUsers = rooms[roomKey] || [];
  
  if (roomUsers.length > 0) {
    // Send only to users in the specified room
    wss.clients.forEach(client => {
      const clientUserId = Object.keys(users).find(id => users[id] === client);
      if (client.readyState === WebSocket.OPEN && 
          clientUserId && 
          roomUsers.includes(clientUserId)) {
        client.send(JSON.stringify(data));
      }
    });
  } else {
    // If no room specified or room doesn't exist, fallback to broadcast to all
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  }
  
  // If this is a local message, publish to Redis for other server instances
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
  
  // Store message in room's message list
  const messageListKey = `${MESSAGES_KEY}:${roomKey}`;
  
  // Add message to the list
  await redis.lpush(messageListKey, JSON.stringify(storedData));
  
  // Trim list to maintain reasonable size (optional)
  await redis.ltrim(messageListKey, 0, 999);
  
  // Set expiration for the entire message list - reset to 12 hours whenever new message arrives
  await redis.expire(messageListKey, MESSAGE_EXPIRY);
  
  return storedData;
}

// Fetch message history for a room
async function getMessageHistory(roomKey: string, limit = 100) {
  const messageListKey = `${MESSAGES_KEY}:${roomKey}`;
  const messages = await redis.lrange(messageListKey, 0, limit - 1);
  
  // Reset expiration whenever history is fetched
  await redis.expire(messageListKey, MESSAGE_EXPIRY);
  
  return messages.map(msg => JSON.parse(msg));
}

// Connect event handler
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
          
          // Send confirmation to the user
          ws.send(JSON.stringify({
            type: 'joined',
            userId: userId,
            roomId: data.roomId,
          }));

          // Handle room joining
          if (!data.roomId) break;
          const roomKey = data.roomId;
          if (!rooms[roomKey]) {
            rooms[roomKey] = [];
            
            // Check if room data exists in Redis
            const roomData = await redis.hget(ROOMS_KEY, roomKey);
            if (roomData) {
              rooms[roomKey] = JSON.parse(roomData);
            }
          }
          
          // Add user to room
          if (userId) {
            rooms[roomKey].push(userId);
          }
          userRooms.push(roomKey);
          
          // Update room data in Redis
          await redis.hset(ROOMS_KEY, roomKey, JSON.stringify(rooms[roomKey]));
          
          // Always send message history on join/refresh
          const history = await getMessageHistory(roomKey);
          // console.log(roomKey, 'history:', history);
          ws.send(JSON.stringify({
            type: 'message_history',
            room: roomKey,
            messages: history
          }));
          
          // Notify others about new user
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
          
          // Broadcast to connected clients
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
    
    // Clean up user data
    delete users[userId];
    console.log(`User ${userId} disconnected`);

    // Remove user from all rooms
    for (const roomKey of userRooms) {
      if (rooms[roomKey]?.includes(userId)) {
        rooms[roomKey] = rooms[roomKey].filter(id => id !== userId);
        
        // Update Redis
        if (rooms[roomKey].length > 0) {
          await redis.hset(ROOMS_KEY, roomKey, JSON.stringify(rooms[roomKey]));
        } else {
          // If room is empty, remove room data but keep messages
          await redis.hdel(ROOMS_KEY, roomKey);
          // Messages will automatically expire after 12 hours due to TTL
        }
        
        // Notify others
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

// Initialize and start the server
initServer().then(() => {
  console.log('WebSocket server started on port 8080 with enhanced Redis persistence');
});

// Simple function to republish from Redis to WebSocket
// This ensures new server instances can broadcast from Redis to WS clients
const pub = redis;