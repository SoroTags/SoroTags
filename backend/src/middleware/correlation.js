const { randomUUID } = require('crypto');

/**
 * Correlation middleware.
 *
 * Ensures every request has a correlation id and a request id, exposes them on
 * `req`, echoes them back on the response, and logs them together so a
 * frontend action can be correlated with a backend log entry.
 */
function correlationMiddleware(req, res, next) {
  const correlationId = req.headers['x-correlation-id'] || randomUUID();
  const requestId = req.headers['x-request-id'] || randomUUID();

  req.correlationId = correlationId;
  req.requestId = requestId;

  res.setHeader('X-Correlation-ID', correlationId);
  res.setHeader('X-Request-ID', requestId);

  const startedAt = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    console.log(
      JSON.stringify({
        level: 'info',
        message: 'request completed',
        method: req.method,
        path: req.originalUrl || req.url,
        status: res.statusCode,
        durationMs,
        correlationId,
        requestId,
      })
    );
  });

  next();
}

module.exports = correlationMiddleware;
module.exports.correlationMiddleware = correlationMiddleware;
