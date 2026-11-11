import { getStore } from '@netlify/blobs';

export function blobStore(name = process.env.BLADE_STORE || 'helanbak-blade-tracker-v1') {
  const s = getStore({ name, consistency: 'strong' });
  return {
    async get(key) {
      const r = await s.getWithMetadata(key, { type: 'json' });
      return r ? { data: r.data, etag: r.etag } : null;
    },
    async put(key, data, opts = {}) {
      const r = await s.setJSON(key, data, opts);
      // The SDK reports any conditional response except 412 as modified, outages
      // included. A real write returns an etag, so without one, check what is stored.
      if (r.modified && !r.etag) {
        const back = await s.get(key, { type: 'json' });
        if (JSON.stringify(back) !== JSON.stringify(data)) throw new Error(`Write did not land: ${key}`);
      }
      return r.modified;
    },
    async list(prefix) {
      const { blobs } = await s.list({ prefix });
      return blobs.map((b) => b.key);
    },
  };
}
