'use strict';

const express = require('express');
const { prisma } = require('../../../prismaClient');
const { logger } = require('../../logger');
const { HORIZON_BASE } = require('../../services/stellarService');
const poolMonitor = require('../../db-pool-monitor');

const DEFAULT_HORIZON_TIMEOUT_MS = 3000;
const DEFAULT_POOL_WARN_THRESHOLD = 5;

function getHorizonTimeoutMs() {
  const parsed = parseInt(process.env.HEALTH_HORIZON_TIMEOUT_MS, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_HORIZON_TIMEOUT_MS;
}

function getPoolWarnThreshold() {
  const raw = process.env.POOL_WARN_THRESHOLD;
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_POOL_WARN_THRESHOLD;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_POOL_WARN_THRESHOLD;
}

async function pingHorizon() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getHorizonTimeoutMs());
  try {
    const res = await fetch(HORIZON_BASE, { signal: controller.signal });
    if (!res.ok) throw new Error(`Horizon responded with ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readPoolStatus(req) {
  const threshold = getPoolWarnThreshold();
  let waitingQueries = 0;
  let busyConnections = 0;

  try {
    if (typeof poolMonitor.getPoolHealthMetrics === 'function') {
      const metrics = await poolMonitor.getPoolHealthMetrics(prisma);
      if (metrics) {
        waitingQueries =
          typeof metrics.db_pool_queries_waiting === 'number'
            ? metrics.db_pool_queries_waiting
            : 0;
        busyConnections =
          typeof metrics.db_pool_connections_busy === 'number'
            ? metrics.db_pool_connections_busy
            : 0;
      }
    } else if (typeof poolMonitor.getPoolMetrics === 'function') {
      const snapshot = await poolMonitor.getPoolMetrics(prisma);
      if (snapshot) {
        waitingQueries =
          typeof snapshot.waiters === 'number' ? snapshot.waiters : 0;
        busyConnections =
          typeof snapshot.active === 'number' ? snapshot.active : 0;
      }
    }
  } catch (err) {
    logger.warn(
      err,
      `[Correlation ID: ${req.correlationId}] Database pool metrics read failed`,
    );
  }

  const saturated = waitingQueries > threshold;
  return {
    saturated,
    pool: {
      status: saturated ? 'saturated' : 'healthy',
      waitingQueries,
      busyConnections,
    },
  };
}

module.exports = (redisClient) => {
  const router = express.Router();

  router.get('/health', async (req, res) => {
    const checks = { database: null, redis: null, horizon: null };
    const failures = [];

    const check = async (key, label, probe) => {
      try {
        await probe();
        checks[key] = 'up';
      } catch (err) {
        checks[key] = 'down';
        failures.push(`${label} unavailable`);
        logger.error(err, `[Correlation ID: ${req.correlationId}] ${label} health check failed`);
      }
    };

    if (!redisClient) checks.redis = 'not configured';

    const [, poolResult] = await Promise.all([
      Promise.all([
        check('database', 'Database', () => prisma.$queryRaw`SELECT 1`),
        ...(redisClient ? [check('redis', 'Redis', () => redisClient.ping())] : []),
        check('horizon', 'Horizon', pingHorizon),
      ]),
      readPoolStatus(req),
    ]);

    if (poolResult.saturated) {
      failures.push('Database connection pool saturated');
      logger.warn(
        `[Correlation ID: ${req.correlationId}] Database connection pool saturated ` +
          `(waitingQueries=${poolResult.pool.waitingQueries}, busyConnections=${poolResult.pool.busyConnections})`,
      );
    }

    const response = {
      status: failures.length ? 'DOWN' : 'UP',
      timestamp: new Date().toISOString(),
      ...checks,
      pool: poolResult.pool,
    };

    if (failures.length) {
      response.message = failures.join(', ');
      return res.status(503).json(response);
    }

    return res.status(200).json(response);
  });

  return router;
};
