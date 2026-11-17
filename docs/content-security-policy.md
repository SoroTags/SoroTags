# Content Security Policy

The Stellar Tags backend is an API-only service that returns JSON and plain-text protocol responses rather than HTML user interfaces. Every HTTP response includes a strict `Content-Security-Policy` header configured via `helmet.contentSecurityPolicy()` in `stellar-payment-platform/src/middleware/security.js`:

```text
default-src 'none';
script-src 'none';
style-src 'none';
img-src 'none';
connect-src 'none';
font-src 'none';
object-src 'none';
media-src 'none';
frame-ancestors 'none';
base-uri 'none';
form-action 'none'
```

## Rationale

- `default-src 'none'` denies loading any external or inline resource if a client or browser ever interprets an API payload as an active document (for example, through content-type confusion or same-origin documentation surfaces).
- Explicit `'none'` directives for `script-src`, `style-src`, `img-src`, `connect-src`, `font-src`, `object-src`, `media-src`, `base-uri`, and `form-action` reinforce the fallback with `useDefaults: false` so permissive Helmet HTML defaults are never merged into API responses.
- `frame-ancestors 'none'` works alongside `X-Frame-Options: DENY` to prevent framing or clickjacking attacks against any route on the API origin.

## Middleware Placement

`securityMiddleware` is mounted at the top of the Express middleware stack in `stellar-payment-platform/server.js` before any route handlers are registered. As a result, `2xx`, `4xx`, and `5xx` responses across all endpoints include the `Content-Security-Policy` header.

## Verification

`stellar-payment-platform/tests/helmet.test.js` verifies that `Content-Security-Policy` containing `default-src 'none'` is attached across JSON endpoints, plain-text endpoints, not-found responses, and error responses.
