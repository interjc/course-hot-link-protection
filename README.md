# Course hot-link protection

Cloudflare Worker for protecting R2-hosted course videos from casual hotlinking.

## What this Worker does

- Allows requests only when `Origin` or `Referer` belongs to the configured course domains.
- Reads objects from the private `MEDIA` R2 binding. The R2 bucket does not need a public domain.
- Supports `GET`, `HEAD`, `OPTIONS`, browser video `Range` requests, and CORS response headers.
- Uses `caches.default` for full-object edge caching. If a full object is cached, later `Range` requests can be served as `206` from Cloudflare cache.

The cache behavior is controlled by Wrangler vars:

```jsonc
"vars": {
  "EDGE_CACHE_ENABLED": "true",
  "CACHE_TTL_SECONDS": "86400"
}
```

## Preferred CDN node setup

The Worker cannot choose the Cloudflare edge node after a request arrives. Node selection happens before the Worker runs, at DNS/BGP connection time.

To use the preferred-CDN approach from the referenced tutorial while keeping this R2 bucket private:

1. Bind this Worker to the public video hostname, for example `cdn.example.com/*`.
2. Configure DNS for `cdn.example.com` to point to your preferred Cloudflare CDN entry, such as a tested preferred CNAME or preferred A/AAAA IP.
3. Keep the DNS record in DNS-only mode if you are using the preferred-IP/CNAME technique.
4. Use `https://cdn.example.com/path/to/video.mp4` in the course platform.

The request path remains:

```text
viewer -> preferred Cloudflare entry -> Worker route -> private R2 binding
```

This differs from public R2-domain proxy examples: the Worker talks to R2 through the binding, so users do not get a direct public R2 hostname to bypass.

## Quick checks

```bash
curl -I \
  -H 'Referer: https://justincourse.com/' \
  https://cdn.justincourse.com/path/to/video.mp4

curl -I \
  -H 'Referer: https://justincourse.com/' \
  -H 'Range: bytes=0-1023' \
  https://cdn.justincourse.com/path/to/video.mp4
```

Expected headers include `Accept-Ranges`, `Access-Control-Allow-Origin`, `Content-Length`, and `X-Edge-Cache`.
