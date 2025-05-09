const ALLOWED = new Set([
  'justincourse.com', 
  'interjc.net'
]);

export default {
  async fetch(req, env) {
    // 1) 简单 Referer 检查
    const refHost = new URL(req.headers.get('Referer') || 'http://_').hostname;
    if (!ALLOWED.has(refHost)) return new Response('blocked', { status: 403 });

    // 2) 解析对象 Key
    const key = decodeURIComponent(new URL(req.url).pathname.slice(1));
    if (!key) return new Response('bad request', { status: 400 });

    // 3) 处理 Range 头（视频播放器常用）
    let options = {};
    const range = req.headers.get('Range');
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const [ , start, end ] = m;
        options.range = { offset: +start, length: end ? (+end - +start + 1) : undefined };
      }
    }

    // 4) 读取 R2
    const obj = await env.MEDIA.get(key, options);
    if (!obj) return new Response('404', { status: 404 });

    // 5) 组装响应（含 CORP 头，阻断跨站 <video>）
    const headers = new Headers(obj.httpMetadata);
    headers.set('Cross-Origin-Resource-Policy', 'same-site');
    if (range) {
      const size   = obj.size;
      const start  = options.range.offset;
      const endPos = options.range.length ? start + options.range.length - 1 : size - 1;
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Content-Range', `bytes ${start}-${endPos}/${size}`);
      return new Response(obj.body, { status: 206, headers });
    }
    return new Response(obj.body, { headers });
  }
}
