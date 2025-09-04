# RDP Signaling Server

Enterprise-grade signaling server for RDP Remote Access with advanced features:

## Features
- 🔐 Token-based authentication
- 🛡️ Rate limiting & DDoS protection  
- 📊 Real-time monitoring & analytics
- ⚡ Load balancing support
- 📈 Admin dashboard
- 🔒 End-to-end encryption support

## Deployment

### Render.com
1. Push this repository to GitHub
2. Connect to Render.com
3. Select "Web Service"
4. Use these settings:
   - Build Command: `npm install && npm run build`
   - Start Command: `node dist/server.js`
   - Environment: Node

### Environment Variables
- `NODE_ENV=production`
- `PORT=10000`
- `MAX_SESSIONS=50`
- `SESSION_TIMEOUT=1800000`
- `RATE_LIMIT_WINDOW=60000`
- `RATE_LIMIT_MAX=100`
- `CORS_ORIGIN=*`

## API Endpoints
- `GET /health` - Health check
- `GET /admin` - Admin dashboard  
- WebSocket connection for signaling

## Usage
After deployment, use the server URL in your RDP client applications to establish peer-to-peer connections.

Server URL format: `https://your-service-name.onrender.com`