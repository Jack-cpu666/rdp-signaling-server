import { Socket } from 'socket.io';

interface RateLimitConfig {
  windowMs: number;
  max: number;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

interface ClientData {
  requests: number[];
  blocked: boolean;
  blockedUntil?: number;
  warnings: number;
  totalRequests: number;
  suspiciousActivity: boolean;
}

export class RateLimiter {
  private clients: Map<string, ClientData> = new Map();
  private config: RateLimitConfig;
  private cleanupInterval: NodeJS.Timeout;

  constructor(config: RateLimitConfig) {
    this.config = {
      windowMs: config.windowMs || 60000, // 1 minute
      max: config.max || 100,
      skipSuccessfulRequests: config.skipSuccessfulRequests,
      skipFailedRequests: config.skipFailedRequests
    };

    // Clean up old entries every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000);
  }

  checkLimit(clientId: string, isSuccess = true): { allowed: boolean; remaining: number; retryAfter?: number } {
    const now = Date.now();
    let client = this.clients.get(clientId);

    if (!client) {
      client = {
        requests: [],
        blocked: false,
        warnings: 0,
        totalRequests: 0,
        suspiciousActivity: false
      };
      this.clients.set(clientId, client);
    }

    // Check if client is currently blocked
    if (client.blocked && client.blockedUntil && now < client.blockedUntil) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.ceil((client.blockedUntil - now) / 1000)
      };
    } else if (client.blocked && client.blockedUntil && now >= client.blockedUntil) {
      // Unblock client
      client.blocked = false;
      client.blockedUntil = undefined;
      client.requests = [];
    }

    // Skip counting if configured
    if ((isSuccess && this.config.skipSuccessfulRequests) || 
        (!isSuccess && this.config.skipFailedRequests)) {
      return { allowed: true, remaining: this.config.max };
    }

    // Remove old requests outside the window
    const windowStart = now - this.config.windowMs;
    client.requests = client.requests.filter(time => time > windowStart);

    client.totalRequests++;

    // Check for suspicious patterns
    this.detectSuspiciousActivity(client, now);

    if (client.requests.length >= this.config.max) {
      client.blocked = true;
      client.blockedUntil = now + this.getBlockDuration(client);
      client.warnings++;
      
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.ceil(this.getBlockDuration(client) / 1000)
      };
    }

    client.requests.push(now);

    return {
      allowed: true,
      remaining: this.config.max - client.requests.length
    };
  }

  private detectSuspiciousActivity(client: ClientData, now: number) {
    // Check for burst patterns
    const recentRequests = client.requests.filter(time => time > now - 10000); // Last 10 seconds
    if (recentRequests.length > this.config.max * 0.8) {
      client.suspiciousActivity = true;
    }

    // Check for consistent high-rate requests
    if (client.requests.length > this.config.max * 0.9) {
      client.suspiciousActivity = true;
    }
  }

  private getBlockDuration(client: ClientData): number {
    // Progressive blocking: longer blocks for repeat offenders
    const baseBlock = 60000; // 1 minute
    const multiplier = Math.min(client.warnings, 10);
    
    if (client.suspiciousActivity) {
      return baseBlock * multiplier * 2; // Double for suspicious activity
    }
    
    return baseBlock * Math.pow(2, Math.min(multiplier, 5)); // Exponential backoff, max 32x
  }

  isBlocked(clientId: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    
    if (client.blocked && client.blockedUntil && Date.now() < client.blockedUntil) {
      return true;
    }
    
    return false;
  }

  getClientStats(clientId: string): ClientData | null {
    return this.clients.get(clientId) || null;
  }

  blacklistClient(clientId: string, duration = 24 * 60 * 60 * 1000) {
    const client = this.clients.get(clientId) || {
      requests: [],
      blocked: false,
      warnings: 0,
      totalRequests: 0,
      suspiciousActivity: false
    };

    client.blocked = true;
    client.blockedUntil = Date.now() + duration;
    client.suspiciousActivity = true;
    
    this.clients.set(clientId, client);
  }

  whitelistClient(clientId: string) {
    const client = this.clients.get(clientId);
    if (client) {
      client.blocked = false;
      client.blockedUntil = undefined;
      client.requests = [];
      client.warnings = 0;
      client.suspiciousActivity = false;
    }
  }

  private cleanup() {
    const now = Date.now();
    const cleanupThreshold = now - (this.config.windowMs * 3); // Keep data for 3 windows

    for (const [clientId, client] of this.clients.entries()) {
      // Remove clients that haven't made requests recently and aren't blocked
      const lastRequest = Math.max(...client.requests, 0);
      
      if (!client.blocked && lastRequest < cleanupThreshold) {
        this.clients.delete(clientId);
      } else if (client.blocked && client.blockedUntil && client.blockedUntil < now) {
        // Clean up expired blocks
        client.blocked = false;
        client.blockedUntil = undefined;
        client.requests = [];
      }
    }
  }

  getAllClients(): Map<string, ClientData> {
    return new Map(this.clients);
  }

  getStats(): {
    totalClients: number;
    blockedClients: number;
    suspiciousClients: number;
    totalRequests: number;
  } {
    let blockedClients = 0;
    let suspiciousClients = 0;
    let totalRequests = 0;

    for (const client of this.clients.values()) {
      if (client.blocked) blockedClients++;
      if (client.suspiciousActivity) suspiciousClients++;
      totalRequests += client.totalRequests;
    }

    return {
      totalClients: this.clients.size,
      blockedClients,
      suspiciousClients,
      totalRequests
    };
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.clients.clear();
  }
}

export class SocketRateLimiter {
  private rateLimiter: RateLimiter;
  private eventLimiters: Map<string, RateLimiter> = new Map();

  constructor(globalConfig: RateLimitConfig, eventConfigs?: Map<string, RateLimitConfig>) {
    this.rateLimiter = new RateLimiter(globalConfig);
    
    if (eventConfigs) {
      for (const [event, config] of eventConfigs) {
        this.eventLimiters.set(event, new RateLimiter(config));
      }
    }
  }

  middleware() {
    return (socket: Socket, next: (err?: Error) => void) => {
      const clientId = this.getClientId(socket);
      const result = this.rateLimiter.checkLimit(clientId);

      if (!result.allowed) {
        const error = new Error('Rate limit exceeded');
        (error as any).data = {
          type: 'RATE_LIMIT_ERROR',
          retryAfter: result.retryAfter
        };
        return next(error);
      }

      next();
    };
  }

  checkEventLimit(socket: Socket, event: string): { allowed: boolean; retryAfter?: number } {
    const clientId = this.getClientId(socket);
    const limiter = this.eventLimiters.get(event);
    
    if (!limiter) {
      // Use global limiter for events without specific limits
      const result = this.rateLimiter.checkLimit(clientId);
      return {
        allowed: result.allowed,
        retryAfter: result.retryAfter
      };
    }

    const result = limiter.checkLimit(clientId);
    return {
      allowed: result.allowed,
      retryAfter: result.retryAfter
    };
  }

  private getClientId(socket: Socket): string {
    // Use IP + User-Agent for better client identification
    const ip = socket.handshake.address;
    const userAgent = socket.handshake.headers['user-agent'] || '';
    return `${ip}:${Buffer.from(userAgent).toString('base64').slice(0, 10)}`;
  }

  blacklistSocket(socket: Socket, duration?: number) {
    const clientId = this.getClientId(socket);
    this.rateLimiter.blacklistClient(clientId, duration);
    
    // Also blacklist in event limiters
    for (const limiter of this.eventLimiters.values()) {
      limiter.blacklistClient(clientId, duration);
    }
  }

  getSocketStats(socket: Socket) {
    const clientId = this.getClientId(socket);
    return this.rateLimiter.getClientStats(clientId);
  }

  getAllStats() {
    const globalStats = this.rateLimiter.getStats();
    const eventStats = new Map();
    
    for (const [event, limiter] of this.eventLimiters) {
      eventStats.set(event, limiter.getStats());
    }

    return { global: globalStats, events: eventStats };
  }

  destroy() {
    this.rateLimiter.destroy();
    for (const limiter of this.eventLimiters.values()) {
      limiter.destroy();
    }
    this.eventLimiters.clear();
  }
}