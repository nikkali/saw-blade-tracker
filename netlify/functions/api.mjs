import { handle } from '../../lib/core.mjs';
import { blobStore } from '../../lib/store-blobs.mjs';

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(\.netlify\/functions\/)?api\/?/, '');
  let body = {};
  if (req.method === 'POST') {
    try {
      const raw = await req.text();
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return new Response(JSON.stringify({ error: 'Bad request.' }), { status: 400 });
    }
  }
  const res = await handle(blobStore(), process.env, {
    method: req.method,
    path,
    passcode: req.headers.get('x-passcode'),
    body,
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
};

export const config = { path: '/api/*' };
