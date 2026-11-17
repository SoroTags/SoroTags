# Content Security Policy

This service is an API-only backend; it never serves interactive HTML, CSS, scripts, or media to a browser. Every response carries a maximally restrictive policy configured with `helmet.contentSecurityPolicy({ useDefaults: false, directives })`:

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

`default-src 'none'` blocks every resource type that a browser might attempt to load from a JSON API response interpreted as HTML (for example, via a content-type sniffing vector). Setting `useDefaults: false` ensures Helmet's permissive HTML defaults are excluded and every directive remains `'none'`.

`frame-ancestors 'none'` complements `X-Frame-Options: DENY` and prevents API responses from being embedded in `<iframe>` or `<object>` elements.

## Enforcement

The policy is created via `helmet.contentSecurityPolicy()` in `src/middleware/security.js` and mounted in `server.js` ahead of all route handlers so every response, including `404` and error responses, carries the header.

## Tests

`tests/helmet.test.js` verifies that all directives are present across API routes, plain-text routes, not-found responses, and error responses.
