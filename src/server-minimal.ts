import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'RDP Signaling Server',
    status: 'running',
    endpoints: {
      health: '/health',
      admin: '/admin'
    }
  });
});

// Admin dashboard endpoint
app.get('/admin', (req, res) => {
  res.json({ 
    message: 'Admin Dashboard', 
    sessions: sessions.size,
    activeSessions: Array.from(sessions.entries()).map(([token, session]) => ({
      token,
      hasClient: !!session.clientSocketId,
      createdAt: session.createdAt
    }))
  });
});

interface Session {
  id: string;
  hostSocketId: string;
  token: string;
  createdAt: Date;
  clientSocketId?: string;
}

const sessions = new Map<string, Session>();
const socketToSession = new Map<string, string>();

function generateToken(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function cleanupOldSessions() {
  const now = new Date();
  const timeout = 30 * 60 * 1000; // 30 minutes
  
  for (const [token, session] of sessions) {
    if (now.getTime() - session.createdAt.getTime() > timeout) {
      sessions.delete(token);
      socketToSession.delete(session.hostSocketId);
      if (session.clientSocketId) {
        socketToSession.delete(session.clientSocketId);
      }
    }
  }
}

setInterval(cleanupOldSessions, 60000);

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('host-session', (callback) => {
    const token = generateToken();
    const session: Session = {
      id: uuidv4(),
      hostSocketId: socket.id,
      token,
      createdAt: new Date()
    };
    
    sessions.set(token, session);
    socketToSession.set(socket.id, token);
    
    console.log(`Session created with token: ${token}`);
    callback({ success: true, token });
  });

  socket.on('join-session', (data, callback) => {
    const { token } = data;
    const session = sessions.get(token);
    
    if (!session) {
      callback({ success: false, error: 'Invalid token' });
      return;
    }
    
    if (session.clientSocketId && session.clientSocketId !== socket.id) {
      callback({ success: false, error: 'Session already has a client' });
      return;
    }
    
    session.clientSocketId = socket.id;
    socketToSession.set(socket.id, token);
    
    io.to(session.hostSocketId).emit('client-connected', { clientId: socket.id });
    
    console.log(`Client joined session with token: ${token}`);
    callback({ success: true, hostId: session.hostSocketId });
  });

  socket.on('offer', (data) => {
    const token = socketToSession.get(socket.id);
    if (!token) return;
    
    const session = sessions.get(token);
    if (!session) return;
    
    const targetId = socket.id === session.hostSocketId 
      ? session.clientSocketId 
      : session.hostSocketId;
    
    if (targetId) {
      io.to(targetId).emit('offer', { offer: data.offer, from: socket.id });
    }
  });

  socket.on('answer', (data) => {
    const token = socketToSession.get(socket.id);
    if (!token) return;
    
    const session = sessions.get(token);
    if (!session) return;
    
    const targetId = socket.id === session.hostSocketId 
      ? session.clientSocketId 
      : session.hostSocketId;
    
    if (targetId) {
      io.to(targetId).emit('answer', { answer: data.answer, from: socket.id });
    }
  });

  socket.on('ice-candidate', (data) => {
    const token = socketToSession.get(socket.id);
    if (!token) return;
    
    const session = sessions.get(token);
    if (!session) return;
    
    const targetId = socket.id === session.hostSocketId 
      ? session.clientSocketId 
      : session.hostSocketId;
    
    if (targetId) {
      io.to(targetId).emit('ice-candidate', { candidate: data.candidate, from: socket.id });
    }
  });

  socket.on('control-event', (data) => {
    const token = socketToSession.get(socket.id);
    if (!token) return;
    
    const session = sessions.get(token);
    if (!session || socket.id !== session.clientSocketId) return;
    
    io.to(session.hostSocketId).emit('control-event', data);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    const token = socketToSession.get(socket.id);
    if (!token) return;
    
    const session = sessions.get(token);
    if (!session) return;
    
    if (socket.id === session.hostSocketId) {
      if (session.clientSocketId) {
        io.to(session.clientSocketId).emit('host-disconnected');
        socketToSession.delete(session.clientSocketId);
      }
      sessions.delete(token);
    } else if (socket.id === session.clientSocketId) {
      io.to(session.hostSocketId).emit('client-disconnected');
      session.clientSocketId = undefined;
    }
    
    socketToSession.delete(socket.id);
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', sessions: sessions.size });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});