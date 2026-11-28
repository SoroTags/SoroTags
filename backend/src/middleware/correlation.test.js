const request = require('supertest');
const express = require('express');
const { correlationMiddleware } = require('./correlation');

describe('correlation middleware', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(correlationMiddleware);
    app.get('/ping', (req, res) => {
      res.json({ correlationId: req.correlationId, requestId: req.requestId });
    });
  });

  it('generates a correlationId when none is provided', async () => {
    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBeDefined();
    expect(res.body.correlationId).toBe(res.headers['x-correlation-id']);
  });

  it('echoes an incoming X-Request-ID in the response headers', async () => {
    const requestId = '11111111-1111-4111-8111-111111111111';
    const res = await request(app)
      .get('/ping')
      .set('X-Request-ID', requestId);

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe(requestId);
    expect(res.body.requestId).toBe(requestId);
  });

  it('round-trips X-Request-ID alongside correlationId', async () => {
    const requestId = '22222222-2222-4222-8222-222222222222';
    const correlationId = 'corr-abc-123';
    const res = await request(app)
      .get('/ping')
      .set('X-Request-ID', requestId)
      .set('X-Correlation-ID', correlationId);

    expect(res.headers['x-request-id']).toBe(requestId);
    expect(res.headers['x-correlation-id']).toBe(correlationId);
    expect(res.body.requestId).toBe(requestId);
    expect(res.body.correlationId).toBe(correlationId);
  });
});
