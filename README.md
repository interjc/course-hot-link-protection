# Course hot-link protection

Cloudflare Worker for protecting R2-hosted course videos from casual hotlinking.

## What this Worker does

- Allows requests only when `Origin` or `Referer` belongs to the configured course domains.
- Reads objects from the private `MEDIA` R2 binding. The R2 bucket does not need a public domain.
- Supports `GET`, `HEAD`, `OPTIONS`, browser video `Range` requests, and CORS response headers.
- Uses `caches.default` for full-object edge caching. If a full object is cached, later `Range` requests can be served as `206` from Cloudflare cache.

The cache behavior is controlled by Wrangler vars. HLS manifests should stay
short-lived, while immutable media segments can be cached much longer:

```jsonc
"vars": {
  "EDGE_CACHE_ENABLED": "true",
  "CACHE_TTL_SECONDS": "86400",
  "MANIFEST_CACHE_TTL_SECONDS": "300",
  "SEGMENT_CACHE_TTL_SECONDS": "2592000"
}
```

- `MANIFEST_CACHE_TTL_SECONDS` applies to `.m3u8` playlists.
- `SEGMENT_CACHE_TTL_SECONDS` applies to `.ts`, `.m4s`, `.mp4`, `.aac`, `.vtt`, and `.webvtt` segment/caption files.
- `CACHE_TTL_SECONDS` is the fallback for every other file type.

Segment responses with a TTL of at least one day also include `immutable`.

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
For HLS, also verify `Cache-Control`. `HEAD` requests are useful for checking
headers, but cache hit checks should use `GET` because this Worker bypasses
edge cache for `HEAD`.

```bash
curl -I \
  -H 'Referer: https://justincourse.com/' \
  https://cdn.justincourse.com/path/to/index.m3u8

curl -I \
  -H 'Referer: https://justincourse.com/' \
  https://cdn.justincourse.com/path/to/segment-001.ts

curl -sS -o /dev/null -D - \
  -H 'Referer: https://justincourse.com/' \
  https://cdn.justincourse.com/path/to/segment-001.ts
```

The manifest should use the manifest TTL, while the segment should use the
long segment TTL. Repeating the `GET` request for the same segment should
eventually return `X-Edge-Cache: HIT` from the same Cloudflare edge location.
