'use strict';

/**
 * tests/register.test.js
 *
 * Tests for POST /register — focuses on the is_primary field behavior (issue #76)
 * and the general registration contract.
 *
 * The existing register-endpoint.test.js covers Express-validator concerns.
 * This file tests the handler logic directly via the /api/v1/register route.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('@stellar/stellar-sdk', () => {
  function crc16Xmodem(buf) {
    let crc = 0x0000;
    for (let i = 0; i < buf.length; i += 1) {
      let code = ((crc >>> 8) & 0xff) ^ (buf[i] & 0xff);
      code ^= code >>> 4;
      crc = ((crc << 8) ^ (code << 12) ^ (code << 5) ^ code) & 0xffff;
    }
    return crc;
  }

  function isValidStellarPublicKey(value) {
    if (typeof value !== 'string' || value.length !== 56 || value !== value.toUpperCase()) {
      return false;
    }
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let acc = 0;
    const bytes = [];
    for (let i = 0; i < value.length; i += 1) {
      const idx = alphabet.indexOf(value[i]);
      if (idx === -1) return false;
      acc = (acc << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((acc >>> bits) & 0xff);
      }
    }
    if (bytes.length !== 35 || (acc & ((1 << bits) - 1)) !== 0) return false;
    if (bytes[0] !== 48) return false;
    const payload = Buffer.from(bytes.slice(0, 33));
    const expectedChecksum = crc16Xmodem(payload);
    const actualChecksum = bytes[33] | (bytes[34] << 8);
    return expectedChecksum === actualChecksum;
  }

  return {
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({ payments: jest.fn() })),
    },
    StrKey: {
      isValidEd25519PublicKey: jest.fn((v) => isValidStellarPublicKey(v)),
    },
    Keypair: {
      fromPublicKey: jest.fn(() => ({ verify: jest.fn(() => true) })),
    },
  };
});

// Mock verifyMultiSignerThreshold to always succeed so tests focus on is_primary
// logic rather than Horizon connectivity.
jest.mock('../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn().mockResolvedValue({
    success: true,
    accountId: 'GABC',
    signerCount: 1,
    thresholdMet: true,
    requiredThreshold: 0,
    totalWeight: 1,
    errorMessage: null,
  }),
}));

jest.mock('redis', () => ({ createClient: jest.fn(() => null) }));
jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({
  scheduleSoftDeletePurgeJob: jest.fn(),
}));

// Prisma mock — individual tests control .count and .create return values.
const mockCount = jest.fn();
const mockCreate = jest.fn();
const mockFindFirst = jest.fn();

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: mockFindFirst,
      count: mockCount,
      create: mockCreate,
      update: jest.fn(),
    },
    payment: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockResolvedValue([0, []]),
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
    $metrics: {
      json: jest.fn().mockResolvedValue({
        counters: [],
        gauges: [],
        histograms: [],
      }),
    },
  },
  isPrismaConnectionError: () => false,
}));

jest.mock('../src/db', () => ({
  poolGet: jest.fn().mockResolvedValue(null),
  poolRun: jest.fn().mockResolvedValue({ changes: 1 }),
  poolAll: jest.fn().mockResolvedValue([]),
  etagCache: (_req, _res, next) => next(),
}));

// Mock activityService so we don't need a real DB for activity recording
jest.mock('../src/services/activityService', () => ({
  ACTIVITY_ACTIONS: { USER_REGISTERED: 'user.registered' },
  recordActivity: jest.fn().mockResolvedValue(undefined),
  listActivity: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
  parseDateRange: jest.fn().mockReturnValue({ range: null, error: null }),
  serializeActivity: jest.fn((r) => r),
}));

jest.mock('pdfkit', () => jest.fn());

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';

const request = require('supertest');
const { app } = require('../server');

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_ADDRESS = 'GARFMBNMMBP34IGQBARST2KQOY7NL7XEHPWAM43C2WUMV4725B5VBUBX';
const VALID_ADDRESS_2 = 'GCX35AFCKVKHUCKWOZNAH7S36WFFZYLAQRT3LZUGV3JIYNFVTENMGH4W';
const BAD_CHECKSUM_ADDRESS = 'GARFMBNMMBP34IGQBARST2KQOY7NL7XEHPWAM43C2WUMV4725B5VBUBA';

function makeRegisterPayload(overrides = {}) {
  return {
    username: 'alice123',
    address: VALID_ADDRESS,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/register — is_primary field (issue #76)', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default: no existing users for the address
    mockCount.mockResolvedValue(0);

    // Default: username not already taken
    mockFindFirst.mockResolvedValue(null);

    // Default: create succeeds
    mockCreate.mockResolvedValue({
      username: 'alice123',
      address: VALID_ADDRESS,
      isPrimary: true,
    });
  });

  // ── Acceptance criterion 1 ──
  it('returns is_primary: true for the first username registered to an address', async () => {
    // No existing usernames for this address
    mockCount.mockResolvedValue(0);
    mockCreate.mockResolvedValue({
      username: 'alice123',
      address: VALID_ADDRESS,
      isPrimary: true,
    });

    const res = await request(app)
      .post('/api/v1/register')
      .set('Content-Type', 'application/json')
      .send(makeRegisterPayload({ username: 'alice123' }));

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.is_primary).toBe(true);
  });

  // ── Acceptance criterion 2 ──
  it('returns is_primary: false for the second username registered to the same address', async () => {
    // Address already has one username registered
    mockCount.mockResolvedValue(1);
    mockCreate.mockResolvedValue({
      username: 'alicepay',
      address: VALID_ADDRESS,
      isPrimary: false,
    });

    const res = await request(app)
      .post('/api/v1/register')
      .set('Content-Type', 'application/json')
      .send(makeRegisterPayload({ username: 'alicepay' }));

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.is_primary).toBe(false);
  });

  it('passes isPrimary=true to prisma.user.create for the first registration', async () => {
    mockCount.mockResolvedValue(0);

    await request(app)
      .post('/api/v1/register')
      .set('Content-Type', 'application/json')
      .send(makeRegisterPayload({ username: 'alice123' }));

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isPrimary: true }),
      }),
    );
  });

  it('passes isPrimary=false to prisma.user.create for alias registrations', async () => {
    mockCount.mockResolvedValue(2); // two existing usernames for this address

    await request(app)
      .post('/api/v1/register')
      .set('Content-Type', 'application/json')
      .send(makeRegisterPayload({ username: 'aliceshop' }));

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isPrimary: false }),
      }),
    );
  });

  // ── Alias registration sequence ──

  it('registers two usernames for the same address with correct is_primary values in sequence', async () => {
    const address = VALID_ADDRESS;

    // First registration: no existing usernames
    mockCount.mockResolvedValueOnce(0);
    mockCreate.mockResolvedValueOnce({
      username: 'alice123',
      address,
      isPrimary: true,
    });

    const first = await request(app)
      .post('/api/v1/register')
      .set('Content-Type', 'application/json')
      .send({ username: 'alice123', address });

    expect(first.status).toBe(201);
    expect(first.body.is_primary).toBe(true);

    // Second registration: address now has 1 username
    mockCount.mockResolvedValueOnce(1);
    mockCreate.mockResolvedValueOnce({
      username: 'alicepay',
      address,
      isPrimary: false,
    });

    const second = await request(app)
      .post('/api/v1/register')
      .set('Content-Type', 'application/json')
      .send({ username: 'alicepay', address });

    expect(second.status).toBe(201);
    expect(second.body.is_primary).toBe(false);

    // Verify that the prisma count was called both times with the correct address
    expect(mockCount).toHaveBeenCalledTimes(2);
    mockCount.mock.calls.forEach((call) => {
      expect(call[0]).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({ address, deletedAt: null }),
        }),
      );
    });
  });

  it('rejects registration when the address already has the maximum usernames', async () => {
    mockCount.mockResolvedValue(5); // MAX_USERNAMES_PER_ADDRESS = 5

    const res = await request(app)
      .post('/api/v1/register')
      .set('Content-Type', 'application/json')
      .send(makeRegisterPayload({ username: 'alicesixth' }));

    expect(res.status).toBe(409);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/register — validation and conflict handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCount.mockResolvedValue(0);
    mockCreate.mockResolvedValue({ username: 'alice123', address: VALID_ADDRESS });
    mockFindFirst.mockResolvedValue(null);
  });

  it('returns 422 when username is missing', async () => {
    const res = await request(app)
      .post('/api/v1/register')
      .set('Content-Type', 'application/json')
      .send({ address: VALID_ADDRESS });

    expect(res.status).toBe(422);
  });

  it('returns 422 when address is missing', async () => {
    const res = await request(app)
      .post('/api/v1/register')
      .set('Content-Type', 'application/json')
      .send({ username: 'alice123' });

    expect(res.status).toBe(422);
  });

  it('returns 415 when Content-Type is not application/json', async () => {
    const res = await request(app)
      .post('/api/v1/register')
      .send('username=alice123&address=' + VALID_ADDRESS);

    expect(res.status).toBe(415);
  });

  it('returns 409 on duplicate username (P2002 Prisma unique constraint)', async () => {
    mockCount.mockResolvedValue(0);
    const conflictErr = new Error('Unique constraint failed on field username');
    conflictErr.code = 'P2002';
    mockCreate.mockRejectedValue(conflictErr);

    const res = await request(app)
      .post('/api/v1/register')
      .set('Content-Type', 'application/json')
      .send(makeRegisterPayload());

    expect(res.status).toBe(409);
  });

  it('returns 400 if a secret key (starts with S) is submitted as address', async () => {
    const res = await request(app)
      .post('/api/v1/register')
      .set('Content-Type', 'application/json')
      .send({ username: 'alice123', address: 'SABC123456789' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Secret Key/i);
  });

  it('returns 200 or 201 and includes username, address, is_primary, federation_address in response', async () => {
    mockCount.mockResolvedValue(0);
    mockCreate.mockResolvedValue({
      username: 'alice123',
      address: VALID_ADDRESS,
      isPrimary: true,
    });

    const res = await request(app)
      .post('/api/v1/register')
      .set('Content-Type', 'application/json')
      .send(makeRegisterPayload());

    expect([200, 201]).toContain(res.status);
    expect(res.body).toMatchObject({
      ok: true,
      username: expect.stringContaining('alice123'),
      address: VALID_ADDRESS,
      is_primary: expect.any(Boolean),
      federation_address: expect.stringContaining('alice123'),
    });
  });

  it('returns 400 INVALID_INPUT referencing address when POST /register receives "BADKEY"', async () => {
    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ username: 'alice123', address: 'BADKEY' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'INVALID_INPUT',
      },
    });
    expect(res.body.error.message).toMatch(/address/i);
    expect(mockCount).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_INPUT referencing address when POST /api/v1/register receives "BADKEY"', async () => {
    const res = await request(app)
      .post('/api/v1/register')
      .set('Content-Type', 'application/json')
      .send({ username: 'alice123', address: 'BADKEY' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'INVALID_INPUT',
      },
    });
    expect(res.body.error.message).toMatch(/address/i);
    expect(mockCount).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a 56-character G... address with an invalid StrKey checksum before any DB operation', async () => {
    for (const endpoint of ['/register', '/api/v1/register']) {
      const res = await request(app)
        .post(endpoint)
        .set('Content-Type', 'application/json')
        .send({ username: 'alice123', address: BAD_CHECKSUM_ADDRESS });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
      expect(res.body.error.message).toMatch(/address/i);
    }
    expect(mockCount).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('accepts a valid checksummed G... key on POST /register', async () => {
    mockCount.mockResolvedValue(0);
    mockCreate.mockResolvedValue({
      username: 'alice123*localhost',
      address: VALID_ADDRESS_2,
      isPrimary: true,
    });

    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ username: 'alice123', address: VALID_ADDRESS_2 });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.address).toBe(VALID_ADDRESS_2);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/v1/register — Location header (issue #199)', () => {
  const originalDomain = process.env.STELLAR_TAG_DOMAIN;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCount.mockResolvedValue(0);
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({
      username: 'alice123',
      address: VALID_ADDRESS,
      isPrimary: true,
    });
  });

  afterEach(() => {
    if (originalDomain === undefined) {
      delete process.env.STELLAR_TAG_DOMAIN;
    } else {
      process.env.STELLAR_TAG_DOMAIN = originalDomain;
    }
  });

  it('includes a Location header pointing to the federation URL on success', async () => {
    process.env.STELLAR_TAG_DOMAIN = 'example.com';

    const res = await request(app)
      .post('/api/v1/register')
      .set('Content-Type', 'application/json')
      .send(makeRegisterPayload({ username: 'alice123' }));

    expect([200, 201]).toContain(res.status);
    expect(res.headers.location).toBe('/federation?q=alice123*example.com');
  });

  it('derives the Location domain from the request host when STELLAR_TAG_DOMAIN is unset', async () => {
    delete process.env.STELLAR_TAG_DOMAIN;

    const res = await request(app)
      .post('/api/v1/register')
      .set('Host', 'stellar.example.org')
      .set('Content-Type', 'application/json')
      .send(makeRegisterPayload({ username: 'alice123' }));

    expect([200, 201]).toContain(res.status);
    expect(res.headers.location).toBe('/federation?q=alice123*stellar.example.org');
  });

  it('keeps the existing response body contract alongside the Location header', async () => {
    process.env.STELLAR_TAG_DOMAIN = 'example.com';

    const res = await request(app)
      .post('/api/v1/register')
      .set('Content-Type', 'application/json')
      .send(makeRegisterPayload({ username: 'alice123' }));

    expect(res.headers.location).toBe('/federation?q=alice123*example.com');
    expect(res.body).toMatchObject({
      ok: true,
      username: expect.stringContaining('alice123'),
      address: VALID_ADDRESS,
      is_primary: expect.any(Boolean),
      federation_address: expect.stringContaining('alice123'),
    });
  });
});
