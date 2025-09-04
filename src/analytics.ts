import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

export interface AnalyticsEvent {
  id: string;
  timestamp: number;
  type: string;
  userId?: string;
  sessionId?: string;
  data: Record<string, any>;
  metadata: {
    userAgent?: string;
    ip?: string;
    country?: string;
    platform?: string;
  };
}

export interface UsageMetrics {
  period: 'hour' | 'day' | 'week' | 'month';
  startTime: number;
  endTime: number;
  metrics: {
    totalSessions: number;
    uniqueUsers: number;
    averageSessionDuration: number;
    totalDataTransferred: number;
    errorRate: number;
    peakConcurrentSessions: number;
    popularFeatures: Array<{
      feature: string;
      usage: number;
      percentage: number;
    }>;
    performanceMetrics: {
      averageLatency: number;
      averageBandwidth: number;
      connectionSuccessRate: number;
    };
    geographicDistribution: Array<{
      country: string;
      sessions: number;
      percentage: number;
    }>;
    deviceStats: Array<{
      platform: string;
      sessions: number;
      percentage: number;
    }>;
  };
}

export interface Alert {
  id: string;
  type: 'anomaly' | 'threshold' | 'error';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  timestamp: number;
  data: Record<string, any>;
  resolved: boolean;
}

export class AdvancedAnalytics extends EventEmitter {
  private events: AnalyticsEvent[] = [];
  private alerts: Alert[] = [];
  private aggregatedData: Map<string, any> = new Map();
  private processingInterval: NodeJS.Timeout | null = null;
  private maxEventsInMemory = 10000;
  private dataDirectory: string;

  constructor(dataDirectory = './analytics-data') {
    super();
    this.dataDirectory = dataDirectory;
    this.ensureDataDirectory();
    this.startProcessing();
  }

  private ensureDataDirectory(): void {
    if (!fs.existsSync(this.dataDirectory)) {
      fs.mkdirSync(this.dataDirectory, { recursive: true });
    }
  }

  private startProcessing(): void {
    // Process analytics data every minute
    this.processingInterval = setInterval(() => {
      this.processEvents();
      this.detectAnomalies();
      this.cleanupOldData();
    }, 60000);
  }

  trackEvent(type: string, data: Record<string, any>, metadata: any = {}): string {
    const event: AnalyticsEvent = {
      id: `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      type,
      data,
      metadata
    };

    this.events.push(event);

    // Limit memory usage
    if (this.events.length > this.maxEventsInMemory) {
      const excess = this.events.splice(0, this.events.length - this.maxEventsInMemory);
      this.persistEvents(excess);
    }

    this.emit('event-tracked', event);
    return event.id;
  }

  trackSessionStart(sessionId: string, userId?: string, metadata: any = {}): void {
    this.trackEvent('session_start', {
      sessionId,
      userId
    }, metadata);
  }

  trackSessionEnd(sessionId: string, duration: number, dataTransferred: number): void {
    this.trackEvent('session_end', {
      sessionId,
      duration,
      dataTransferred
    });
  }

  trackConnection(success: boolean, latency?: number, error?: string): void {
    this.trackEvent('connection_attempt', {
      success,
      latency,
      error
    });
  }

  trackFeatureUsage(feature: string, sessionId: string, usage: any = {}): void {
    this.trackEvent('feature_usage', {
      feature,
      sessionId,
      ...usage
    });
  }

  trackError(error: string, severity: 'low' | 'medium' | 'high', context: any = {}): void {
    this.trackEvent('error', {
      error,
      severity,
      context
    });

    // Generate alert for high severity errors
    if (severity === 'high') {
      this.generateAlert('error', severity, `High severity error: ${error}`, {
        error,
        context
      });
    }
  }

  trackPerformanceMetric(metric: string, value: number, unit: string, context: any = {}): void {
    this.trackEvent('performance_metric', {
      metric,
      value,
      unit,
      context
    });
  }

  private processEvents(): void {
    if (this.events.length === 0) return;

    const now = Date.now();
    const hourlyKey = `hour-${Math.floor(now / (60 * 60 * 1000))}`;
    const dailyKey = `day-${Math.floor(now / (24 * 60 * 60 * 1000))}`;

    // Process events for different time periods
    this.aggregateEvents(this.events, hourlyKey, 'hour');
    this.aggregateEvents(this.events, dailyKey, 'day');

    // Clear processed events
    this.events = [];
  }

  private aggregateEvents(events: AnalyticsEvent[], key: string, period: string): void {
    const aggregation = this.aggregatedData.get(key) || {
      period,
      startTime: Date.now(),
      totalSessions: 0,
      uniqueUsers: new Set(),
      sessionDurations: [],
      dataTransferred: 0,
      errors: [],
      connections: { success: 0, failure: 0, latencies: [] },
      features: new Map(),
      countries: new Map(),
      platforms: new Map(),
      performanceMetrics: new Map()
    };

    for (const event of events) {
      switch (event.type) {
        case 'session_start':
          aggregation.totalSessions++;
          if (event.userId) {
            aggregation.uniqueUsers.add(event.userId);
          }
          break;

        case 'session_end':
          aggregation.sessionDurations.push(event.data.duration);
          aggregation.dataTransferred += event.data.dataTransferred || 0;
          break;

        case 'connection_attempt':
          if (event.data.success) {
            aggregation.connections.success++;
            if (event.data.latency) {
              aggregation.connections.latencies.push(event.data.latency);
            }
          } else {
            aggregation.connections.failure++;
          }
          break;

        case 'error':
          aggregation.errors.push({
            error: event.data.error,
            severity: event.data.severity,
            timestamp: event.timestamp
          });
          break;

        case 'feature_usage':
          const feature = event.data.feature;
          aggregation.features.set(feature, (aggregation.features.get(feature) || 0) + 1);
          break;

        case 'performance_metric':
          const metric = event.data.metric;
          if (!aggregation.performanceMetrics.has(metric)) {
            aggregation.performanceMetrics.set(metric, []);
          }
          aggregation.performanceMetrics.get(metric).push(event.data.value);
          break;
      }

      // Geographic and platform tracking
      if (event.metadata.country) {
        aggregation.countries.set(
          event.metadata.country,
          (aggregation.countries.get(event.metadata.country) || 0) + 1
        );
      }

      if (event.metadata.platform) {
        aggregation.platforms.set(
          event.metadata.platform,
          (aggregation.platforms.get(event.metadata.platform) || 0) + 1
        );
      }
    }

    this.aggregatedData.set(key, aggregation);
  }

  getUsageMetrics(period: 'hour' | 'day' | 'week' | 'month', offset = 0): UsageMetrics | null {
    const now = Date.now();
    let periodMs: number;
    let key: string;

    switch (period) {
      case 'hour':
        periodMs = 60 * 60 * 1000;
        key = `hour-${Math.floor((now - offset * periodMs) / periodMs)}`;
        break;
      case 'day':
        periodMs = 24 * 60 * 60 * 1000;
        key = `day-${Math.floor((now - offset * periodMs) / periodMs)}`;
        break;
      case 'week':
        periodMs = 7 * 24 * 60 * 60 * 1000;
        key = `week-${Math.floor((now - offset * periodMs) / periodMs)}`;
        break;
      case 'month':
        periodMs = 30 * 24 * 60 * 60 * 1000;
        key = `month-${Math.floor((now - offset * periodMs) / periodMs)}`;
        break;
      default:
        return null;
    }

    const aggregation = this.aggregatedData.get(key);
    if (!aggregation) return null;

    const startTime = now - (offset + 1) * periodMs;
    const endTime = now - offset * periodMs;

    // Calculate metrics
    const averageSessionDuration = aggregation.sessionDurations.length > 0
      ? aggregation.sessionDurations.reduce((a: number, b: number) => a + b, 0) / aggregation.sessionDurations.length
      : 0;

    const errorRate = aggregation.totalSessions > 0
      ? (aggregation.errors.length / aggregation.totalSessions) * 100
      : 0;

    const connectionSuccessRate = (aggregation.connections.success + aggregation.connections.failure) > 0
      ? (aggregation.connections.success / (aggregation.connections.success + aggregation.connections.failure)) * 100
      : 0;

    const averageLatency = aggregation.connections.latencies.length > 0
      ? aggregation.connections.latencies.reduce((a: number, b: number) => a + b, 0) / aggregation.connections.latencies.length
      : 0;

    // Feature usage statistics
    const totalFeatureUsage: number = Array.from(aggregation.features.values()).reduce((a: number, b: number) => a + b, 0);
    const popularFeatures = Array.from(aggregation.features.entries())
      .map(([feature, usage]: [string, number]) => ({
        feature,
        usage,
        percentage: totalFeatureUsage > 0 ? (usage / totalFeatureUsage) * 100 : 0
      }))
      .sort((a, b) => b.usage - a.usage);

    // Geographic distribution
    const totalSessions = aggregation.totalSessions;
    const geographicDistribution = Array.from(aggregation.countries.entries())
      .map(([country, sessions]: [string, number]) => ({
        country,
        sessions,
        percentage: totalSessions > 0 ? (sessions / totalSessions) * 100 : 0
      }))
      .sort((a, b) => b.sessions - a.sessions);

    // Device statistics
    const deviceStats = Array.from(aggregation.platforms.entries())
      .map(([platform, sessions]: [string, number]) => ({
        platform,
        sessions,
        percentage: totalSessions > 0 ? (sessions / totalSessions) * 100 : 0
      }))
      .sort((a, b) => b.sessions - a.sessions);

    return {
      period,
      startTime,
      endTime,
      metrics: {
        totalSessions: aggregation.totalSessions,
        uniqueUsers: aggregation.uniqueUsers.size,
        averageSessionDuration,
        totalDataTransferred: aggregation.dataTransferred,
        errorRate,
        peakConcurrentSessions: 0, // Would need real-time tracking
        popularFeatures: popularFeatures as Array<{feature: string; usage: number; percentage: number}>,
        performanceMetrics: {
          averageLatency,
          averageBandwidth: 0, // Would need bandwidth tracking
          connectionSuccessRate
        },
        geographicDistribution: geographicDistribution as Array<{country: string; sessions: number; percentage: number}>,
        deviceStats: deviceStats as Array<{platform: string; sessions: number; percentage: number}>
      }
    };
  }

  private detectAnomalies(): void {
    const currentHour = this.getUsageMetrics('hour', 0);
    const previousHour = this.getUsageMetrics('hour', 1);

    if (!currentHour || !previousHour) return;

    // Check for significant changes
    const sessionGrowth = ((currentHour.metrics.totalSessions - previousHour.metrics.totalSessions) / previousHour.metrics.totalSessions) * 100;
    
    if (Math.abs(sessionGrowth) > 200) {
      this.generateAlert('anomaly', 'medium', `Unusual session activity: ${sessionGrowth.toFixed(1)}% change`, {
        current: currentHour.metrics.totalSessions,
        previous: previousHour.metrics.totalSessions,
        growth: sessionGrowth
      });
    }

    // Check error rate
    if (currentHour.metrics.errorRate > 10) {
      this.generateAlert('threshold', 'high', `High error rate: ${currentHour.metrics.errorRate.toFixed(1)}%`, {
        errorRate: currentHour.metrics.errorRate
      });
    }

    // Check connection success rate
    if (currentHour.metrics.performanceMetrics.connectionSuccessRate < 90) {
      this.generateAlert('threshold', 'high', `Low connection success rate: ${currentHour.metrics.performanceMetrics.connectionSuccessRate.toFixed(1)}%`, {
        successRate: currentHour.metrics.performanceMetrics.connectionSuccessRate
      });
    }
  }

  private generateAlert(type: Alert['type'], severity: Alert['severity'], message: string, data: Record<string, any>): void {
    const alert: Alert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      severity,
      message,
      timestamp: Date.now(),
      data,
      resolved: false
    };

    this.alerts.unshift(alert);

    // Keep only recent alerts
    if (this.alerts.length > 1000) {
      this.alerts = this.alerts.slice(0, 1000);
    }

    this.emit('alert-generated', alert);
  }

  getAlerts(limit = 50, includeResolved = false): Alert[] {
    let alerts = includeResolved ? this.alerts : this.alerts.filter(a => !a.resolved);
    return alerts.slice(0, limit);
  }

  resolveAlert(alertId: string): boolean {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.resolved = true;
      this.emit('alert-resolved', alert);
      return true;
    }
    return false;
  }

  getTrends(metric: string, period: 'hour' | 'day', count = 24): Array<{ timestamp: number; value: number }> {
    const trends: Array<{ timestamp: number; value: number }> = [];
    
    for (let i = count - 1; i >= 0; i--) {
      const metrics = this.getUsageMetrics(period, i);
      if (metrics) {
        let value: number;
        
        switch (metric) {
          case 'sessions':
            value = metrics.metrics.totalSessions;
            break;
          case 'users':
            value = metrics.metrics.uniqueUsers;
            break;
          case 'errors':
            value = metrics.metrics.errorRate;
            break;
          case 'latency':
            value = metrics.metrics.performanceMetrics.averageLatency;
            break;
          default:
            value = 0;
        }
        
        trends.push({
          timestamp: metrics.startTime,
          value
        });
      }
    }
    
    return trends;
  }

  private persistEvents(events: AnalyticsEvent[]): void {
    const date = new Date().toISOString().split('T')[0];
    const filename = path.join(this.dataDirectory, `events-${date}.json`);
    
    try {
      const existingData = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : [];
      const updatedData = [...existingData, ...events];
      fs.writeFileSync(filename, JSON.stringify(updatedData, null, 2));
    } catch (error) {
      console.error('Error persisting events:', error);
    }
  }

  private cleanupOldData(): void {
    const cutoffTime = Date.now() - (30 * 24 * 60 * 60 * 1000); // 30 days
    
    // Clean up aggregated data
    for (const [key, data] of this.aggregatedData) {
      if ((data as any).startTime < cutoffTime) {
        this.aggregatedData.delete(key);
      }
    }

    // Clean up old event files
    try {
      const files = fs.readdirSync(this.dataDirectory);
      const cutoffDate = new Date(cutoffTime).toISOString().split('T')[0];
      
      for (const file of files) {
        if (file.startsWith('events-') && file < `events-${cutoffDate}.json`) {
          fs.unlinkSync(path.join(this.dataDirectory, file));
        }
      }
    } catch (error) {
      console.error('Error cleaning up old data:', error);
    }
  }

  exportData(format: 'json' | 'csv', period: 'day' | 'week' | 'month' = 'week'): string {
    const endDate = new Date();
    const startDate = new Date();
    
    switch (period) {
      case 'day':
        startDate.setDate(endDate.getDate() - 1);
        break;
      case 'week':
        startDate.setDate(endDate.getDate() - 7);
        break;
      case 'month':
        startDate.setDate(endDate.getDate() - 30);
        break;
    }

    const data = {
      exportDate: new Date().toISOString(),
      period: {
        start: startDate.toISOString(),
        end: endDate.toISOString()
      },
      metrics: this.getUsageMetrics(period === 'day' ? 'day' : 'hour'),
      trends: {
        sessions: this.getTrends('sessions', 'hour', 24),
        users: this.getTrends('users', 'hour', 24),
        errors: this.getTrends('errors', 'hour', 24)
      },
      alerts: this.getAlerts(100, true)
    };

    if (format === 'json') {
      return JSON.stringify(data, null, 2);
    } else {
      // Convert to CSV format (simplified)
      let csv = 'Metric,Value\n';
      if (data.metrics) {
        csv += `Total Sessions,${data.metrics.metrics.totalSessions}\n`;
        csv += `Unique Users,${data.metrics.metrics.uniqueUsers}\n`;
        csv += `Error Rate,${data.metrics.metrics.errorRate.toFixed(2)}%\n`;
        csv += `Avg Session Duration,${(data.metrics.metrics.averageSessionDuration / 1000 / 60).toFixed(2)} minutes\n`;
      }
      return csv;
    }
  }

  getSystemHealth(): {
    status: 'healthy' | 'warning' | 'critical';
    score: number;
    issues: string[];
  } {
    const metrics = this.getUsageMetrics('hour', 0);
    const issues: string[] = [];
    let score = 100;

    if (!metrics) {
      return { status: 'warning', score: 50, issues: ['No recent metrics available'] };
    }

    // Check error rate
    if (metrics.metrics.errorRate > 5) {
      issues.push(`High error rate: ${metrics.metrics.errorRate.toFixed(1)}%`);
      score -= 20;
    }

    // Check connection success rate
    if (metrics.metrics.performanceMetrics.connectionSuccessRate < 95) {
      issues.push(`Low connection success rate: ${metrics.metrics.performanceMetrics.connectionSuccessRate.toFixed(1)}%`);
      score -= 15;
    }

    // Check for recent alerts
    const recentAlerts = this.getAlerts(10).filter(a => 
      Date.now() - a.timestamp < 60 * 60 * 1000 && // Last hour
      !a.resolved
    );

    if (recentAlerts.length > 0) {
      issues.push(`${recentAlerts.length} unresolved alerts`);
      score -= recentAlerts.length * 5;
    }

    let status: 'healthy' | 'warning' | 'critical';
    if (score >= 80) status = 'healthy';
    else if (score >= 60) status = 'warning';
    else status = 'critical';

    return { status, score: Math.max(0, score), issues };
  }

  destroy(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    
    // Persist remaining events
    if (this.events.length > 0) {
      this.persistEvents(this.events);
    }
  }
}

export const analytics = new AdvancedAnalytics();
export default analytics;