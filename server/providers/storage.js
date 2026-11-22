// The adapter owns bucket operations; feature handlers own authorization and paths.
export const IMAGE_BUCKET = "generated-images";
export function imageStorage(client) {
  const bucket = client.storage.from(IMAGE_BUCKET);
  return {
    upload: (path, bytes, options) => bucket.upload(path, bytes, options),
    remove: (paths) => bucket.remove(paths),
    createSignedUrl: (path, seconds, options) =>
      bucket.createSignedUrl(path, seconds, options),
  };
}

// Agent workspace: generated files (ZIP/PDF/DOCX/...), generated images, uploaded
// attachments and extracted-text sidecars. The bucket is private; downloads always go
// through short-lived signed tickets issued after an ownership check.
export const AGENT_BUCKET = "agent-files";
export function agentStorage(client) {
  const bucket = client.storage.from(AGENT_BUCKET);
  const ensure = async () => {
    const { error } = await client.storage.createBucket(AGENT_BUCKET, {
      public: false,
    });
    if (error && !/already exists|duplicate/i.test(String(error.message || "")))
      throw error;
  };
  return {
    async upload(path, bytes, options = {}) {
      let result = await bucket.upload(path, bytes, {
        upsert: true,
        ...options,
      });
      // The bucket is created lazily the first time an agent stores a file.
      if (
        result.error &&
        /not found|bucket/i.test(String(result.error.message))
      ) {
        await ensure();
        result = await bucket.upload(path, bytes, { upsert: true, ...options });
      }
      return result;
    },
    download: (path) => bucket.download(path),
    remove: (paths) => bucket.remove(paths),
    list: (prefix, options) => bucket.list(prefix, options),
  };
}
