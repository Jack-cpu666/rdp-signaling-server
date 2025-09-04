"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoadBalancer = exports.PerformanceBasedStrategy = exports.WeightedRoundRobinStrategy = exports.LeastConnectionsStrategy = exports.RoundRobinStrategy = void 0;
const events_1 = require("events");
class RoundRobinStrategy {
    constructor() {
        this.name = 'round-robin';
        this.currentIndex = 0;
    }
    selectServer(nodes) {
        const healthyNodes = nodes.filter(node => node.isHealthy && node.activeConnections < node.maxConnections);
        if (healthyNodes.length === 0) {
            return null;
        }
        const server = healthyNodes[this.currentIndex % healthyNodes.length];
        this.currentIndex = (this.currentIndex + 1) % healthyNodes.length;
        return server;
    }
}
exports.RoundRobinStrategy = RoundRobinStrategy;
class LeastConnectionsStrategy {
    constructor() {
        this.name = 'least-connections';
    }
    selectServer(nodes) {
        const availableNodes = nodes.filter(node => node.isHealthy && node.activeConnections < node.maxConnections);
        if (availableNodes.length === 0) {
            return null;
        }
        return availableNodes.reduce((min, node) => node.activeConnections < min.activeConnections ? node : min);
    }
}
exports.LeastConnectionsStrategy = LeastConnectionsStrategy;
class WeightedRoundRobinStrategy {
    constructor() {
        this.name = 'weighted-round-robin';
        this.weightedQueue = [];
    }
    selectServer(nodes) {
        const healthyNodes = nodes.filter(node => node.isHealthy && node.activeConnections < node.maxConnections);
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
    updateWeightedQueue(nodes) {
        // Remove nodes that are no longer healthy or available
        this.weightedQueue = this.weightedQueue.filter(entry => nodes.some(node => node.id === entry.server.id && node.isHealthy && node.activeConnections < node.maxConnections));
        // Add new nodes
        for (const node of nodes) {
            if (!this.weightedQueue.some(entry => entry.server.id === node.id)) {
                this.weightedQueue.push({
                    server: node,
                    remainingWeight: node.weight
                });
            }
            else {
                // Update existing node data
                const entry = this.weightedQueue.find(entry => entry.server.id === node.id);
                if (entry) {
                    entry.server = node;
                }
            }
        }
    }
}
exports.WeightedRoundRobinStrategy = WeightedRoundRobinStrategy;
class PerformanceBasedStrategy {
    constructor() {
        this.name = 'performance-based';
    }
    selectServer(nodes) {
        const availableNodes = nodes.filter(node => node.isHealthy && node.activeConnections < node.maxConnections);
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
    calculatePerformanceScore(node) {
        // Weighted performance score calculation
        const connectionRatio = node.activeConnections / node.maxConnections;
        const cpuWeight = 0.3;
        const memoryWeight = 0.3;
        const connectionWeight = 0.2;
        const responseTimeWeight = 0.2;
        const normalizedResponseTime = Math.min(node.responseTime / 1000, 1); // Normalize to 0-1 (1000ms max)
        return (node.cpuUsage * cpuWeight +
            node.memoryUsage * memoryWeight +
            connectionRatio * 100 * connectionWeight +
            normalizedResponseTime * 100 * responseTimeWeight);
    }
}
exports.PerformanceBasedStrategy = PerformanceBasedStrategy;
class LoadBalancer extends events_1.EventEmitter {
    constructor(strategy = new RoundRobinStrategy()) {
        super();
        this.nodes = new Map();
        this.healthCheckInterval = null;
        this.healthCheckIntervalMs = 30000; // 30 seconds
        // Sticky session support
        this.stickySessionMap = new Map(); // sessionId -> serverId
        // Circuit breaker functionality
        this.circuitBreakers = new Map();
        this.strategy = strategy;
    }
    addServer(config) {
        const node = {
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
    removeServer(serverId) {
        const node = this.nodes.get(serverId);
        if (node) {
            this.nodes.delete(serverId);
            this.emit('server-removed', node);
            return true;
        }
        return false;
    }
    updateServerStats(serverId, stats) {
        const node = this.nodes.get(serverId);
        if (node) {
            Object.assign(node, stats);
            this.emit('server-stats-updated', node);
        }
    }
    selectServer() {
        const availableNodes = Array.from(this.nodes.values());
        const selected = this.strategy.selectServer(availableNodes);
        if (selected) {
            this.emit('server-selected', selected);
        }
        else {
            this.emit('no-server-available');
        }
        return selected;
    }
    incrementConnection(serverId) {
        const node = this.nodes.get(serverId);
        if (node) {
            node.activeConnections++;
            this.emit('connection-incremented', node);
        }
    }
    decrementConnection(serverId) {
        const node = this.nodes.get(serverId);
        if (node) {
            node.activeConnections = Math.max(0, node.activeConnections - 1);
            this.emit('connection-decremented', node);
        }
    }
    setStrategy(strategy) {
        this.strategy = strategy;
        this.emit('strategy-changed', strategy);
    }
    startHealthChecks() {
        if (this.healthCheckInterval) {
            return; // Already running
        }
        this.healthCheckInterval = setInterval(() => {
            this.performHealthChecks();
        }, this.healthCheckIntervalMs);
        this.emit('health-checks-started');
    }
    stopHealthChecks() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
            this.emit('health-checks-stopped');
        }
    }
    async performHealthChecks() {
        const promises = Array.from(this.nodes.values()).map(node => this.checkServerHealth(node));
        await Promise.allSettled(promises);
    }
    async checkServerHealth(node) {
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
        }
        catch (error) {
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
    getServerStatus() {
        const allNodes = Array.from(this.nodes.values());
        const healthy = allNodes.filter(node => node.isHealthy);
        const unhealthy = allNodes.filter(node => !node.isHealthy);
        return {
            healthy,
            unhealthy,
            total: allNodes.length
        };
    }
    getServerById(serverId) {
        return this.nodes.get(serverId);
    }
    getAllServers() {
        return Array.from(this.nodes.values());
    }
    getLoadBalancingStats() {
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
    assignStickySession(sessionId, serverId) {
        this.stickySessionMap.set(sessionId, serverId);
    }
    getStickyServer(sessionId) {
        const serverId = this.stickySessionMap.get(sessionId);
        if (serverId) {
            const server = this.nodes.get(serverId);
            if (server && server.isHealthy && server.activeConnections < server.maxConnections) {
                return server;
            }
            else {
                // Server is not available, remove sticky session
                this.stickySessionMap.delete(sessionId);
            }
        }
        return null;
    }
    removeStickySession(sessionId) {
        this.stickySessionMap.delete(sessionId);
    }
    isCircuitOpen(serverId) {
        const breaker = this.circuitBreakers.get(serverId);
        if (!breaker)
            return false;
        if (breaker.state === 'open') {
            const timeSinceLastFailure = Date.now() - breaker.lastFailureTime;
            if (timeSinceLastFailure > 60000) { // 1 minute timeout
                breaker.state = 'half-open';
                breaker.failures = 0;
            }
            else {
                return true;
            }
        }
        return false;
    }
    recordFailure(serverId) {
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
    recordSuccess(serverId) {
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
exports.LoadBalancer = LoadBalancer;
