import { EventEmitter } from 'events';
import { Socket } from 'socket.io';

export interface ServerNode {
  id: string;
  host: string;
  port: number;
  isHealthy: boolean;
  lastHealthCheck: number;
  activeConnections: number;
  maxConnections: number;
  cpuUsage: number;
  memoryUsage: number;
  responseTime: number;
  weight: number;
}

export interface LoadBalancingStrategy {
  selectServer(nodes: ServerNode[]): ServerNode | null;
  name: string;
}

export class RoundRobinStrategy implements LoadBalancingStrategy {
  name = 'round-robin';
  private currentIndex = 0;

  selectServer(nodes: ServerNode[]): ServerNode | null {
    const healthyNodes = nodes.filter(node => node.isHealthy && node.activeConnections < node.maxConnections);
    
    if (healthyNodes.length === 0) {
      return null;
    }

    const server = healthyNodes[this.currentIndex % healthyNodes.length];
    this.currentIndex = (this.currentIndex + 1) % healthyNodes.length;
    
    return server;
  }
}

export class LeastConnectionsStrategy implements LoadBalancingStrategy {
  name = 'least-connections';

  selectServer(nodes: ServerNode[]): ServerNode | null {
    const availableNodes = nodes.filter(node => 
      node.isHealthy && node.activeConnections < node.maxConnections
    );

    if (availableNodes.length === 0) {
      return null;
    }

    return availableNodes.reduce((min, node) => 
      node.activeConnections < min.activeConnections ? node : min
    );
  }
}

export class WeightedRoundRobinStrategy implements LoadBalancingStrategy {
  name = 'weighted-round-robin';
  private weightedQueue: { server: ServerNode; remainingWeight: number }[] = [];

  selectServer(nodes: ServerNode[]): ServerNode | null {
    const healthyNodes = nodes.filter(node => 
      node.isHealthy && node.activeConnections < node.maxConnections
    );

    if (healthyNodes.length === 0) {
      return null;
    }

    // Initialize or update the weighted queue
    this.updateWeightedQueue(healthyNodes);

    if (this.weightedQueue.length === 0) {
      return null;
    }

    // Find the next server with remaining weight
    let selectedEntry = this.weightedQueue.find(entry => entry.remainingWeight > 0);

    if (!selectedEntry) {
      // Reset all weights and select the first
      this.weightedQueue.forEach(entry => {
        entry.remainingWeight = entry.server.weight;
      });
      selectedEntry = this.weightedQueue[0];
    }

    if (selectedEntry) {
      selectedEntry.remainingWeight--;
      return selectedEntry.server;
    }

    return null;
  }

  private updateWeightedQueue(nodes: ServerNode[]) {
    // Remove nodes that are no longer healthy or available
    this.weightedQueue = this.weightedQueue.filter(entry =>
      nodes.some(node => node.id === entry.server.id && node.isHealthy && node.activeConnections < node.maxConnections)
    );

    // Add new nodes
    for (const node of nodes) {
      if (!this.weightedQueue.some(entry => entry.server.id === node.id)) {
        this.weightedQueue.push({
          server: node,
          remainingWeight: node.weight
        });
      } else {
        // Update existing node data
        const entry = this.weightedQueue.find(entry => entry.server.id === node.id);
        if (entry) {
          entry.server = node;
        }
      }
    }
  }
}

export class PerformanceBasedStrategy implements LoadBalancingStrategy {
  name = 'performance-based';

  selectServer(nodes: ServerNode[]): ServerNode | null {
    const availableNodes = nodes.filter(node => 
      node.isHealthy && node.activeConnections < node.maxConnections
    );

    if (availableNodes.length === 0) {
      return null;
    }

    // Calculate performance score (lower is better)
    const scoredNodes = availableNodes.map(node => ({
      node,
      score: this.calculatePerformanceScore(node)
    }));

    // Sort by score and return the best performing node
    scoredNodes.sort((a, b) => a.score - b.score);
    
    return scoredNodes[0].node;
  }

  private calculatePerformanceScore(node: ServerNode): number {
    // Weighted performance score calculation
    const connectionRatio = node.activeConnections / node.maxConnections;
    const cpuWeight = 0.3;
    const memoryWeight = 0.3;
    const connectionWeight = 0.2;
    const responseTimeWeight = 0.2;

    const normalizedResponseTime = Math.min(node.responseTime / 1000, 1); // Normalize to 0-1 (1000ms max)

    return (
      node.cpuUsage * cpuWeight +
      node.memoryUsage * memoryWeight +
      connectionRatio * 100 * connectionWeight +
      normalizedResponseTime * 100 * responseTimeWeight
    );
  }
}

export class LoadBalancer extends EventEmitter {
  private nodes: Map<string, ServerNode> = new Map();
  private strategy: LoadBalancingStrategy;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private healthCheckIntervalMs = 30000; // 30 seconds

  constructor(strategy: LoadBalancingStrategy = new RoundRobinStrategy()) {
    super();
    this.strategy = strategy;
  }

  addServer(config: Omit<ServerNode, 'isHealthy' | 'lastHealthCheck' | 'activeConnections'>): void {
    const node: ServerNode = {
      ...config,
      isHealthy: false,
      lastHealthCheck: 0,
      activeConnections: 0
    };

    this.nodes.set(node.id, node);
    this.emit('server-added', node);
    
    // Immediately check health of new server
    this.checkServerHealth(node);
  }

  removeServer(serverId: string): boolean {
    const node = this.nodes.get(serverId);
    if (node) {
      this.nodes.delete(serverId);
      this.emit('server-removed', node);
      return true;
    }
    return false;
  }

  updateServerStats(serverId: string, stats: Partial<Pick<ServerNode, 'cpuUsage' | 'memoryUsage' | 'responseTime' | 'activeConnections'>>): void {
    const node = this.nodes.get(serverId);
    if (node) {
      Object.assign(node, stats);
      this.emit('server-stats-updated', node);
    }
  }

  selectServer(): ServerNode | null {
    const availableNodes = Array.from(this.nodes.values());
    const selected = this.strategy.selectServer(availableNodes);
    
    if (selected) {
      this.emit('server-selected', selected);
    } else {
      this.emit('no-server-available');
    }
    
    return selected;
  }

  incrementConnection(serverId: string): void {
    const node = this.nodes.get(serverId);
    if (node) {
      node.activeConnections++;
      this.emit('connection-incremented', node);
    }
  }

  decrementConnection(serverId: string): void {
    const node = this.nodes.get(serverId);
    if (node) {
      node.activeConnections = Math.max(0, node.activeConnections - 1);
      this.emit('connection-decremented', node);
    }
  }

  setStrategy(strategy: LoadBalancingStrategy): void {
    this.strategy = strategy;
    this.emit('strategy-changed', strategy);
  }

  startHealthChecks(): void {
    if (this.healthCheckInterval) {
      return; // Already running
    }

    this.healthCheckInterval = setInterval(() => {
      this.performHealthChecks();
    }, this.healthCheckIntervalMs);

    this.emit('health-checks-started');
  }

  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      this.emit('health-checks-stopped');
    }
  }

  private async performHealthChecks(): Promise<void> {
    const promises = Array.from(this.nodes.values()).map(node => 
      this.checkServerHealth(node)
    );

    await Promise.allSettled(promises);
  }

  private async checkServerHealth(node: ServerNode): Promise<void> {
    const startTime = Date.now();
    
    try {
      // Simple HTTP health check
      const response = await fetch(`http://${node.host}:${node.port}/health`, {
        method: 'GET'
      });

      const isHealthy = response.ok;
      const responseTime = Date.now() - startTime;

      const wasHealthy = node.isHealthy;
      node.isHealthy = isHealthy;
      node.lastHealthCheck = Date.now();
      node.responseTime = responseTime;

      if (wasHealthy !== isHealthy) {
        this.emit(isHealthy ? 'server-healthy' : 'server-unhealthy', node);
      }

      this.emit('health-check-completed', node);
    } catch (error) {
      const wasHealthy = node.isHealthy;
      node.isHealthy = false;
      node.lastHealthCheck = Date.now();
      node.responseTime = Date.now() - startTime;

      if (wasHealthy) {
        this.emit('server-unhealthy', node);
      }

      this.emit('health-check-failed', { node, error });
    }
  }

  getServerStatus(): { healthy: ServerNode[]; unhealthy: ServerNode[]; total: number } {
    const allNodes = Array.from(this.nodes.values());
    const healthy = allNodes.filter(node => node.isHealthy);
    const unhealthy = allNodes.filter(node => !node.isHealthy);

    return {
      healthy,
      unhealthy,
      total: allNodes.length
    };
  }

  getServerById(serverId: string): ServerNode | undefined {
    return this.nodes.get(serverId);
  }

  getAllServers(): ServerNode[] {
    return Array.from(this.nodes.values());
  }

  getLoadBalancingStats(): {
    strategy: string;
    totalServers: number;
    healthyServers: number;
    totalConnections: number;
    averageLoad: number;
  } {
    const allNodes = Array.from(this.nodes.values());
    const healthyNodes = allNodes.filter(node => node.isHealthy);
    const totalConnections = allNodes.reduce((sum, node) => sum + node.activeConnections, 0);
    const averageLoad = healthyNodes.length > 0 
      ? totalConnections / healthyNodes.length 
      : 0;

    return {
      strategy: this.strategy.name,
      totalServers: allNodes.length,
      healthyServers: healthyNodes.length,
      totalConnections,
      averageLoad
    };
  }

  // Sticky session support
  private stickySessionMap = new Map<string, string>(); // sessionId -> serverId

  assignStickySession(sessionId: string, serverId: string): void {
    this.stickySessionMap.set(sessionId, serverId);
  }

  getStickyServer(sessionId: string): ServerNode | null {
    const serverId = this.stickySessionMap.get(sessionId);
    if (serverId) {
      const server = this.nodes.get(serverId);
      if (server && server.isHealthy && server.activeConnections < server.maxConnections) {
        return server;
      } else {
        // Server is not available, remove sticky session
        this.stickySessionMap.delete(sessionId);
      }
    }
    return null;
  }

  removeStickySession(sessionId: string): void {
    this.stickySessionMap.delete(sessionId);
  }

  // Circuit breaker functionality
  private circuitBreakers = new Map<string, {
    failures: number;
    lastFailureTime: number;
    state: 'closed' | 'open' | 'half-open';
  }>();

  private isCircuitOpen(serverId: string): boolean {
    const breaker = this.circuitBreakers.get(serverId);
    if (!breaker) return false;

    if (breaker.state === 'open') {
      const timeSinceLastFailure = Date.now() - breaker.lastFailureTime;
      if (timeSinceLastFailure > 60000) { // 1 minute timeout
        breaker.state = 'half-open';
        breaker.failures = 0;
      } else {
        return true;
      }
    }

    return false;
  }

  private recordFailure(serverId: string): void {
    let breaker = this.circuitBreakers.get(serverId);
    if (!breaker) {
      breaker = { failures: 0, lastFailureTime: 0, state: 'closed' };
      this.circuitBreakers.set(serverId, breaker);
    }

    breaker.failures++;
    breaker.lastFailureTime = Date.now();

    if (breaker.failures >= 5) { // Threshold
      breaker.state = 'open';
      this.emit('circuit-breaker-opened', serverId);
    }
  }

  private recordSuccess(serverId: string): void {
    const breaker = this.circuitBreakers.get(serverId);
    if (breaker) {
      if (breaker.state === 'half-open') {
        breaker.state = 'closed';
        breaker.failures = 0;
        this.emit('circuit-breaker-closed', serverId);
      }
    }
  }
}