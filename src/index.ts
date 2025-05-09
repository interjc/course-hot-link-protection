const ALLOWED = ['app.justincourse.com', 'interjc.net'];
export default {
  async fetch(request) {
    const ref = new URL(request.headers.get('Referer')||'').hostname;
    if (!ALLOWED.includes(ref)) return new Response('blocked', {status:403});
    return fetch(request);
  }
}
