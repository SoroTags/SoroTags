'use strict';

const jwt = require('jsonwebtoken');
const { ApiError } = require('../errors');
const { DEFAULT_ISSUER, DEFAULT_AUDIENCE } = require('../utils/jwt');

const normalizeKey = (raw) =>
  typeof raw === 'string' ? raw.replace(/\\n/g, '\n') : raw;

/**
 * Verify a JWT token using the configured RS256 public key (or HS256 secret
 * when running in environments configured via JWT_SECRET).
 *
 * @param {string} token
 * @returns {object} Decoded JWT payload
 */
function verifyBearerToken(token) {
  const publicKey = normalizeKey(process.env.JWT_PUBLIC_KEY);
  if (publicKey) {
    return jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: DEFAULT_ISSUER,
      audience: DEFAULT_AUDIENCE,
    });
  }

  if (process.env.JWT_SECRET) {
    const verifyOptions = {};
    if (process.env.JWT_ISSUER) {
      verifyOptions.issuer = process.env.JWT_ISSUER;
    }
    return jwt.verify(token, process.env.JWT_SECRET, verifyOptions);
  }

  throw new ApiError('INTERNAL_ERROR', 'JWT verification key is not configured.');
}

/**
 * Express authentication middleware that distinguishes expired JWTs
 * (`TOKEN_EXPIRED`) from malformed or tampered tokens (`TOKEN_INVALID`).
 */
function requireAuth(req, res, next) {
  const authHeader = (req && req.headers && req.headers.authorization) || '';
  const trimmed = authHeader.trim();

  if (!trimmed) {
    return next(new ApiError('UNAUTHENTICATED', 'Authentication required'));
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
    return next(
      new ApiError(
        'TOKEN_INVALID',
        'Invalid authentication token. Expected Authorization: Bearer <token>.',
      ),
    );
  }

  const token = parts[1];

  try {
    req.user = verifyBearerToken(token);
    return next();
  } catch (err) {
    if (err instanceof ApiError) {
      return next(err);
    }

    if (err instanceof jwt.TokenExpiredError || err.name === 'TokenExpiredError') {
      return next(
        new ApiError('TOKEN_EXPIRED', 'Your session has expired. Please log in again.', {
          cause: err,
        }),
      );
    }

    return next(
      new ApiError('TOKEN_INVALID', 'Invalid or malformed authentication token.', {
        cause: err,
      }),
    );
  }
}

requireAuth.requireAuth = requireAuth;
module.exports = requireAuth;
