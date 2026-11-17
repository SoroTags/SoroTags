'use strict';

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.mock('../src/logger', () => ({ logger: mockLogger }));

const { buildErrorHandler, notFoundHandler } = require('../src/middleware/errorHandler');
const { requireAuth } = require('../src/middleware/requireAuth');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const PRIVATE_PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' });

const { privateKey: wrongPrivateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const WRONG_PRIVATE_PEM = wrongPrivateKey.export({ type: 'pkcs1', format: 'pem' });

const ORIGINAL_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY;
const ORIGINAL_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY;
const ORIGINAL_SECRET = process.env.JWT_SECRET;

function buildApp() {
  const app = express();
  app.use((req, res, next) => {
    req.correlationId = 'auth-test-correlation-id';
    next();
  });
  app.get('/protected', requireAuth, (req, res) => {
    res.status(200).json({ ok: true, user: req.user });
  });
  app.use(notFoundHandler);
  app.use(buildErrorHandler(() => false));
  return app;
}

function signTestToken(payload, options = {}, signingKey = PRIVATE_PEM) {
  return jwt.sign(payload, signingKey, {
    algorithm: 'RS256',
    expiresIn: '1h',
    issuer: 'stellar-payment-platform',
    audience: 'api',
    ...options,
  });
}

describe('requireAuth middleware (TOKEN_EXPIRED vs TOKEN_INVALID)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_PRIVATE_KEY = PRIVATE_PEM;
    process.env.JWT_PUBLIC_KEY = PUBLIC_PEM;
    delete process.env.JWT_SECRET;
  });

  afterAll(() => {
    if (ORIGINAL_PRIVATE_KEY === undefined) delete process.env.JWT_PRIVATE_KEY;
    else process.env.JWT_PRIVATE_KEY = ORIGINAL_PRIVATE_KEY;

    if (ORIGINAL_PUBLIC_KEY === undefined) delete process.env.JWT_PUBLIC_KEY;
    else process.env.JWT_PUBLIC_KEY = ORIGINAL_PUBLIC_KEY;

    if (ORIGINAL_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_SECRET;
  });

  it('allows a valid RS256 Bearer token and attaches req.user', async () => {
    const token = signTestToken({ sub: 'user-1', username: 'alice' });
    const app = buildApp();

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user).toMatchObject({ sub: 'user-1', username: 'alice' });
  });

  it('returns 401 UNAUTHENTICATED when Authorization header is missing', async () => {
    const app = buildApp();

    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Authentication required',
      },
    });
  });

  it('returns 401 TOKEN_EXPIRED with re-login prompt when token is expired', async () => {
    const expiredToken = signTestToken({ sub: 'user-1', username: 'alice' }, { expiresIn: '-30s' });
    const app = buildApp();

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'TOKEN_EXPIRED',
        message: 'Your session has expired. Please log in again.',
      },
    });
    expect(res.body.error.message).toMatch(/log in again/i);
  });

  it('returns 401 TOKEN_INVALID when token signature is tampered', async () => {
    const validToken = signTestToken({ sub: 'user-1', username: 'alice' });
    const [header, payload, signature] = validToken.split('.');
    const flippedChar = signature.endsWith('a') ? 'b' : 'a';
    const tamperedToken = `${header}.${payload}.${signature.slice(0, -1)}${flippedChar}`;
    const app = buildApp();

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${tamperedToken}`);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'TOKEN_INVALID',
      },
    });
  });

  it('returns 401 TOKEN_INVALID when token is signed by an unknown key', async () => {
    const wrongKeyToken = signTestToken({ sub: 'user-1' }, {}, WRONG_PRIVATE_PEM);
    const app = buildApp();

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${wrongKeyToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('returns 401 TOKEN_INVALID when token is malformed', async () => {
    const app = buildApp();

    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer not.a.valid.jwt.string');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('returns 401 TOKEN_INVALID when Authorization scheme is not Bearer', async () => {
    const token = signTestToken({ sub: 'user-1' });
    const app = buildApp();

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Basic ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('returns 401 TOKEN_INVALID when issuer or audience claims do not match', async () => {
    const wrongIssuerToken = signTestToken({ sub: 'user-1' }, { issuer: 'untrusted-issuer' });
    const app = buildApp();

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${wrongIssuerToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('supports HS256 fallback when JWT_SECRET is configured instead of RSA keys', async () => {
    delete process.env.JWT_PUBLIC_KEY;
    delete process.env.JWT_PRIVATE_KEY;
    process.env.JWT_SECRET = 'hs256-test-secret';

    const validHsToken = jwt.sign({ sub: 'hs-user' }, 'hs256-test-secret', { expiresIn: '1h' });
    const expiredHsToken = jwt.sign({ sub: 'hs-user' }, 'hs256-test-secret', { expiresIn: '-5s' });
    const app = buildApp();

    const okRes = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${validHsToken}`);
    expect(okRes.status).toBe(200);
    expect(okRes.body.user.sub).toBe('hs-user');

    const expRes = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${expiredHsToken}`);
    expect(expRes.status).toBe(401);
    expect(expRes.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('returns 500 INTERNAL_ERROR when neither JWT_PUBLIC_KEY nor JWT_SECRET is configured', async () => {
    delete process.env.JWT_PUBLIC_KEY;
    delete process.env.JWT_PRIVATE_KEY;
    delete process.env.JWT_SECRET;

    const app = buildApp();
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer some.jwt.token');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});
