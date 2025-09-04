import { EventEmitter } from 'events';
import * as os from 'os';
import * as fs from 'fs';

export interface HealthMetrics {
  timestamp: number;
  server: {
    uptime: number;
    cpu: {
      usage: number;
      load: number[];
    };
    memory: {
      used: number;
      total: number;
      percentage: number;
    };
    disk: {
      used: number;
      total: number;
      percentage: number;
    };
  };
  application: {
    activeSessions: number;
    totalConnections: number;
    errorRate: number;
    avgResponseTime: number;
    dataTransferred: number;
  };
  network: {
    connectionsPerSecond: number;
    bandwidthUsage: number;
    errorCount: number;
  };
}

export interface AlertRule {
  id: string;
  name: string;
  metric: string;
  operator: '>' | '<' | '>=' | '<=' | '==' | '!=';
  threshold: number;
  severity: 'critical' | 'warning' | 'info';
  enabled: boolean;
  cooldown: number; // seconds
  lastTriggered?: number;
}

export interface Alert {
  id: string;
  ruleId: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  timestamp: number;
  value: number;
  threshold: number;
  acknowledged: boolean;
}

export class HealthMonitor extends EventEmitter {
  private metrics: HealthMetrics[] = [];
  private alerts: Alert[] = [];
  private alertRules: AlertRule[] = [];
  private monitoringInterval: NodeJS.Timeout | null = null;
  private statsCollector: StatsCollector;
  private maxMetricsHistory = 1440; // 24 hours at 1-minute intervals

  constructor() {
    super();
    this.statsCollector = new StatsCollector();
    this.initializeDefaultAlertRules();
  }

  private initializeDefaultAlertRules() {
    this.alertRules = [
      {
        id: 'cpu-high',
        name: 'High CPU Usage',
        metric: 'server.cpu.usage',
        operator: '>',
        threshold: 80,
        severity: 'warning',
        enabled: true,
        cooldown: 300
      },
      {
        id: 'cpu-critical',
        name: 'Critical CPU Usage',
        metric: 'server.cpu.usage',
        operator: '>',
        threshold: 95,
        severity: 'critical',
        enabled: true,
        cooldown: 180
      },
      {
        id: 'memory-high',
        name: 'High Memory Usage',
        metric: 'server.memory.percentage',
        operator: '>',
        threshold: 85,
        severity: 'warning',
        enabled: true,
        cooldown: 300
      },
      {
        id: 'memory-critical',
        name: 'Critical Memory Usage',
        metric: 'server.memory.percentage',
        operator: '>',
        threshold: 95,
        severity: 'critical',
        enabled: true,
        cooldown: 180
      },
      {
        id: 'disk-high',
        name: 'High Disk Usage',
        metric: 'server.disk.percentage',
        operator: '>',
        threshold: 85,
        severity: 'warning',
        enabled: true,
        cooldown: 600
      },
      {
        id: 'disk-critical',
        name: 'Critical Disk Usage',
        metric: 'server.disk.percentage',
        operator: '>',
        threshold: 95,
        severity: 'critical',
        enabled: true,
        cooldown: 300
      },
      {
        id: 'error-rate-high',
        name: 'High Error Rate',
        metric: 'application.errorRate',
        operator: '>',
        threshold: 10,
        severity: 'warning',
        enabled: true,
        cooldown: 300
      },
      {
        id: 'response-time-high',
        name: 'High Response Time',
        metric: 'application.avgResponseTime',
        operator: '>',
        threshold: 1000,
        severity: 'warning',
        enabled: true,
        cooldown: 300
      }
    ];
  }

  startMonitoring(intervalMs = 60000) {
    this.monitoringInterval = setInterval(() => {
      this.collectMetrics();
    }, intervalMs);

    this.emit('monitoring-started');
  }

  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.emit('monitoring-stopped');
  }

  private async collectMetrics() {
    const timestamp = Date.now();
    
    const metrics: HealthMetrics = {
      timestamp,
      server: await this.collectServerMetrics(),
      application: this.statsCollector.getApplicationMetrics(),
      network: this.statsCollector.getNetworkMetrics()
    };

    this.metrics.push(metrics);
    
    // Keep only recent metrics
    if (this.metrics.length > this.maxMetricsHistory) {
      this.metrics.shift();
    }

    // Check alert rules
    this.checkAlertRules(metrics);

    this.emit('metrics-collected', metrics);
  }

  private async collectServerMetrics() {
    const cpuUsage = await this.getCPUUsage();
    const memInfo = this.getMemoryInfo();
    const diskInfo = await this.getDiskInfo();

    return {
      uptime: os.uptime(),
      cpu: {
        usage: cpuUsage,
        load: os.loadavg()
      },
      memory: memInfo,
      disk: diskInfo
    };
  }

  private getCPUUsage(): Promise<number> {
    return new Promise((resolve) => {
      const startMeasure = this.cpuAverage();
      setTimeout(() => {
        const endMeasure = this.cpuAverage();
        const idleDifference = endMeasure.idle - startMeasure.idle;
        const totalDifference = endMeasure.total - startMeasure.total;
        const percentageCPU = 100 - ~~(100 * idleDifference / totalDifference);
        resolve(percentageCPU);
      }, 1000);
    });
  }

  private cpuAverage() {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;

    for (let cpu of cpus) {
      for (let type in cpu.times) {
        total += (cpu.times as any)[type];
      }
      idle += cpu.times.idle;
    }

    return { idle, total };
  }

  private getMemoryInfo() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    
    return {
      used,
      total,
      percentage: (used / total) * 100
    };
  }

  private async getDiskInfo() {
    try {
      const stats = fs.statSync('.');
      // This is a simplified disk usage calculation
      // In production, you'd want to use a more accurate method
      return {
        used: 0,
        total: 0,
        percentage: 0
      };
    } catch (error) {
      return {
        used: 0,
        total: 0,
        percentage: 0
      };
    }
  }

  private checkAlertRules(metrics: HealthMetrics) {
    const now = Date.now();

    for (const rule of this.alertRules) {
      if (!rule.enabled) continue;
      
      // Check cooldown
      if (rule.lastTriggered && (now - rule.lastTriggered) / 1000 < rule.cooldown) {
        continue;
      }

      const value = this.getMetricValue(metrics, rule.metric);
      if (value === undefined) continue;

      let shouldTrigger = false;
      switch (rule.operator) {
        case '>': shouldTrigger = value > rule.threshold; break;
        case '<': shouldTrigger = value < rule.threshold; break;
        case '>=': shouldTrigger = value >= rule.threshold; break;
        case '<=': shouldTrigger = value <= rule.threshold; break;
        case '==': shouldTrigger = value === rule.threshold; break;
        case '!=': shouldTrigger = value !== rule.threshold; break;
      }

      if (shouldTrigger) {
        this.triggerAlert(rule, value);
      }
    }
  }

  private getMetricValue(metrics: HealthMetrics, metricPath: string): number | undefined {
    const parts = metricPath.split('.');
    let current: any = metrics;
    
    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return undefined;
      }
    }
    
    return typeof current === 'number' ? current : undefined;
  }

  private triggerAlert(rule: AlertRule, value: number) {
    const alert: Alert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      ruleId: rule.id,
      severity: rule.severity,
      message: `${rule.name}: ${value.toFixed(2)} ${rule.operator} ${rule.threshold}`,
      timestamp: Date.now(),
      value,
      threshold: rule.threshold,
      acknowledged: false
    };

    this.alerts.unshift(alert);
    rule.lastTriggered = Date.now();

    // Keep only recent alerts (last 1000)
    if (this.alerts.length > 1000) {
      this.alerts = this.alerts.slice(0, 1000);
    }

    this.emit('alert-triggered', alert);
  }

  // Public API methods
  getLatestMetrics(): HealthMetrics | null {
    return this.metrics.length > 0 ? this.metrics[this.metrics.length - 1] : null;
  }

  getMetricsHistory(hours = 1): HealthMetrics[] {
    const cutoff = Date.now() - (hours * 60 * 60 * 1000);
    return this.metrics.filter(m => m.timestamp > cutoff);
  }

  getActiveAlerts(): Alert[] {
    return this.alerts.filter(a => !a.acknowledged);
  }

  getAllAlerts(limit = 100): Alert[] {
    return this.alerts.slice(0, limit);
  }

  acknowledgeAlert(alertId: string): boolean {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      this.emit('alert-acknowledged', alert);
      return true;
    }
    return false;
  }

  addAlertRule(rule: Omit<AlertRule, 'id'>): AlertRule {
    const newRule: AlertRule = {
      ...rule,
      id: `rule-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };
    
    this.alertRules.push(newRule);
    this.emit('alert-rule-added', newRule);
    return newRule;
  }

  updateAlertRule(ruleId: string, updates: Partial<AlertRule>): boolean {
    const rule = this.alertRules.find(r => r.id === ruleId);
    if (rule) {
      Object.assign(rule, updates);
      this.emit('alert-rule-updated', rule);
      return true;
    }
    return false;
  }

  removeAlertRule(ruleId: string): boolean {
    const index = this.alertRules.findIndex(r => r.id === ruleId);
    if (index !== -1) {
      const rule = this.alertRules.splice(index, 1)[0];
      this.emit('alert-rule-removed', rule);
      return true;
    }
    return false;
  }

  getAlertRules(): AlertRule[] {
    return [...this.alertRules];
  }

  getHealthStatus(): 'healthy' | 'warning' | 'critical' {
    const activeAlerts = this.getActiveAlerts();
    
    if (activeAlerts.some(a => a.severity === 'critical')) {
      return 'critical';
    } else if (activeAlerts.some(a => a.severity === 'warning')) {
      return 'warning';
    }
    
    return 'healthy';
  }
}

class StatsCollector {
  private appMetrics = {
    activeSessions: 0,
    totalConnections: 0,
    errorCount: 0,
    responseTimeSum: 0,
    responseTimeCount: 0,
    dataTransferred: 0
  };

  private networkMetrics = {
    connectionsPerSecond: 0,
    bandwidthUsage: 0,
    errorCount: 0
  };

  recordConnection() {
    this.appMetrics.totalConnections++;
  }

  recordError() {
    this.appMetrics.errorCount++;
    this.networkMetrics.errorCount++;
  }

  recordResponseTime(timeMs: number) {
    this.appMetrics.responseTimeSum += timeMs;
    this.appMetrics.responseTimeCount++;
  }

  recordDataTransfer(bytes: number) {
    this.appMetrics.dataTransferred += bytes;
    this.networkMetrics.bandwidthUsage += bytes;
  }

  setActiveSessions(count: number) {
    this.appMetrics.activeSessions = count;
  }

  getApplicationMetrics() {
    const avgResponseTime = this.appMetrics.responseTimeCount > 0 
      ? this.appMetrics.responseTimeSum / this.appMetrics.responseTimeCount 
      : 0;
    
    const errorRate = this.appMetrics.totalConnections > 0 
      ? (this.appMetrics.errorCount / this.appMetrics.totalConnections) * 100 
      : 0;

    return {
      activeSessions: this.appMetrics.activeSessions,
      totalConnections: this.appMetrics.totalConnections,
      errorRate,
      avgResponseTime,
      dataTransferred: this.appMetrics.dataTransferred
    };
  }

  getNetworkMetrics() {
    return { ...this.networkMetrics };
  }

  reset() {
    // Reset counters but keep cumulative metrics
    this.appMetrics.responseTimeSum = 0;
    this.appMetrics.responseTimeCount = 0;
    this.networkMetrics.connectionsPerSecond = 0;
    this.networkMetrics.bandwidthUsage = 0;
  }
}

export { StatsCollector };