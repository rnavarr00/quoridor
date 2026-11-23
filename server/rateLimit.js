import {
  HELLO_LIMIT_PER_IP,
  HELLO_LIMIT_WINDOW_MS,
  MAX_CONNECTIONS_PER_IP,
  RATE_LIMIT_CLOSE_THRESHOLD,
  RATE_LIMIT_MESSAGES,
  RATE_LIMIT_WINDOW_MS,
  RATE_REFILL_PER_SECOND,
  RATE_VIOLATION_LIMIT,
} from './protocol.js';

export class RateLimiter {
  constructor(options = {}) {
    this.capacity = options.capacity ?? RATE_LIMIT_MESSAGES;
    this.refillPerSecond = options.refillPerSecond ?? RATE_REFILL_PER_SECOND;
    this.violationLimit = options.violationLimit ?? RATE_VIOLATION_LIMIT;
    this.closeThreshold = options.closeThreshold ?? RATE_LIMIT_CLOSE_THRESHOLD;
    this.windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
    this.tokens = this.capacity;
    this.violations = 0;
    this.accepted = 0;
    this.lastRefill = null;
    this.timestamps = [];
  }

  refill(now) {
    if (this.lastRefill === null) {
      this.lastRefill = now;
      return;
    }
    const elapsed = Math.max(0, now - this.lastRefill);
    if (elapsed === 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSecond);
    this.lastRefill = now;
  }

  hit(now = Date.now()) {
    this.refill(now);
    const cutoff = now - this.windowMs;
    while (this.timestamps.length && this.timestamps[0] <= cutoff) this.timestamps.shift();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.accepted += 1;
      this.timestamps.push(now);
      return {
        allowed: true,
        severe: false,
        close: false,
        count: this.accepted,
        violations: this.violations,
        tokens: this.tokens,
      };
    }
    this.violations += 1;
    const close = this.violations >= this.violationLimit || this.timestamps.length > this.closeThreshold;
    return {
      allowed: false,
      severe: close,
      close,
      count: this.accepted,
      violations: this.violations,
      tokens: 0,
    };
  }

  reset() {
    this.tokens = this.capacity;
    this.violations = 0;
    this.accepted = 0;
    this.lastRefill = null;
    this.timestamps = [];
  }
}

export function createRateLimiter(options = {}) {
  return new RateLimiter(options);
}

export class IpLimiters {
  constructor(options = {}) {
    this.maxConnections = options.maxConnections ?? MAX_CONNECTIONS_PER_IP;
    this.helloCapacity = options.helloCapacity ?? HELLO_LIMIT_PER_IP;
    this.helloWindowMs = options.helloWindowMs ?? HELLO_LIMIT_WINDOW_MS;
    this.connections = new Map();
    this.hellos = new Map();
  }

  acquireConnection(ip) {
    const current = this.connections.get(ip) || 0;
    if (current >= this.maxConnections) return false;
    this.connections.set(ip, current + 1);
    return true;
  }

  releaseConnection(ip) {
    const current = this.connections.get(ip) || 0;
    if (current <= 1) this.connections.delete(ip);
    else this.connections.set(ip, current - 1);
  }

  allowHello(ip, now = Date.now()) {
    let bucket = this.hellos.get(ip);
    if (!bucket) {
      bucket = new RateLimiter({
        capacity: this.helloCapacity,
        refillPerSecond: (this.helloCapacity * 1000) / this.helloWindowMs,
        windowMs: this.helloWindowMs,
        violationLimit: 1,
        closeThreshold: Number.POSITIVE_INFINITY,
      });
      this.hellos.set(ip, bucket);
    }
    const result = bucket.hit(now);
    return { allowed: result.allowed, close: !result.allowed };
  }

  clear(ip) {
    this.connections.delete(ip);
    this.hellos.delete(ip);
  }
}

export function createIpLimiters(options = {}) {
  return new IpLimiters(options);
}
