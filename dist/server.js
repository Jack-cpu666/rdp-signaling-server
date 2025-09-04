"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const cors_1 = __importDefault(require("cors"));
const uuid_1 = require("uuid");
const dotenv_1 = __importDefault(require("dotenv"));
const path = __importStar(require("path"));
const rateLimiter_1 = require("./rateLimiter");
dotenv_1.default.config();
const app = (0, express_1.default)();
const httpServer = (0, http_1.createServer)(app);
const io = new socket_io_1.Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
app.use((0, cors_1.default)());
app.use(express_1.default.json());
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
// Serve admin dashboard
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});
// Rate limiter setup
const rateLimiter = new rateLimiter_1.SocketRateLimiter({ windowMs: 60000, max: 100 }, // Global: 100 requests per minute
new Map([
    ['host-session', { windowMs: 300000, max: 5 }], // 5 sessions per 5 minutes
    ['join-session', { windowMs: 60000, max: 20 }], // 20 join attempts per minute
    ['control-event', { windowMs: 1000, max: 50 }] // 50 control events per second
]));
const sessions = new Map();
const socketToSession = new Map();
function generateToken() {
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
        const session = {
            id: (0, uuid_1.v4)(),
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
        if (!token)
            return;
        const session = sessions.get(token);
        if (!session)
            return;
        const targetId = socket.id === session.hostSocketId
            ? session.clientSocketId
            : session.hostSocketId;
        if (targetId) {
            io.to(targetId).emit('offer', { offer: data.offer, from: socket.id });
        }
    });
    socket.on('answer', (data) => {
        const token = socketToSession.get(socket.id);
        if (!token)
            return;
        const session = sessions.get(token);
        if (!session)
            return;
        const targetId = socket.id === session.hostSocketId
            ? session.clientSocketId
            : session.hostSocketId;
        if (targetId) {
            io.to(targetId).emit('answer', { answer: data.answer, from: socket.id });
        }
    });
    socket.on('ice-candidate', (data) => {
        const token = socketToSession.get(socket.id);
        if (!token)
            return;
        const session = sessions.get(token);
        if (!session)
            return;
        const targetId = socket.id === session.hostSocketId
            ? session.clientSocketId
            : session.hostSocketId;
        if (targetId) {
            io.to(targetId).emit('ice-candidate', { candidate: data.candidate, from: socket.id });
        }
    });
    socket.on('screen-data', (data) => {
        const token = socketToSession.get(socket.id);
        if (!token)
            return;
        const session = sessions.get(token);
        if (!session || socket.id !== session.hostSocketId)
            return;
        if (session.clientSocketId) {
            io.to(session.clientSocketId).emit('screen-data', data);
        }
    });
    socket.on('control-event', (data) => {
        const token = socketToSession.get(socket.id);
        if (!token)
            return;
        const session = sessions.get(token);
        if (!session || socket.id !== session.clientSocketId)
            return;
        io.to(session.hostSocketId).emit('control-event', data);
    });
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        const token = socketToSession.get(socket.id);
        if (!token)
            return;
        const session = sessions.get(token);
        if (!session)
            return;
        if (socket.id === session.hostSocketId) {
            if (session.clientSocketId) {
                io.to(session.clientSocketId).emit('host-disconnected');
                socketToSession.delete(session.clientSocketId);
            }
            sessions.delete(token);
        }
        else if (socket.id === session.clientSocketId) {
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
