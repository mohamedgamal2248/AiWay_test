import { inflateRawSync } from "node:zlib";
import { Blob } from "node:buffer";

// In-memory Supabase-like client for agent tests: table results plus a storage bucket.
export function fakeClient(
  results = {},
  rpc = async () => ({ data: true, error: null }),
  storage = null,
) {
  return {
    rpc,
    storage,
    from(table) {
      let filters = [],
        operation = "select",
        patch;
      const q = {
        select: () => q,
        eq(k, v) {
          filters.push([k, v]);
          return q;
        },
        gt: () => q,
        gte: () => q,
        not: () => q,
        in: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: () => q,
        single: () => q,
        update(value) {
          operation = "update";
          patch = value;
          return q;
        },
        insert(value) {
          operation = "insert";
          patch = value;
          return q;
        },
        then(resolve) {
          const result = results[table];
          resolve(
            typeof result === "function"
              ? result({ filters, operation, patch })
              : result || { data: null, error: null },
          );
        },
      };
      return q;
    },
  };
}

export function memoryStorage() {
  const objects = new Map();
  return {
    objects,
    createBucket: async () => ({ error: null }),
    from(bucket) {
      return {
        upload: async (path, bytes) => {
          objects.set(`${bucket}/${path}`, Buffer.from(bytes));
          return { error: null };
        },
        download: async (path) => {
          const value = objects.get(`${bucket}/${path}`);
          return value
            ? { data: new Blob([value]), error: null }
            : { data: null, error: { message: "not found" } };
        },
        remove: async (paths) => {
          for (const p of paths) objects.delete(`${bucket}/${p}`);
          return { error: null };
        },
      };
    },
  };
}

export const sse = (...chunks) =>
  new Response(
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
      "data: [DONE]\n\n",
  );

export const textChunks = (text, usage) => [
  { id: "g1", choices: [{ delta: { content: text }, finish_reason: "stop" }] },
  { id: "g1", choices: [], usage },
];

export function toolCallChunks(calls, usage = {}) {
  const chunks = [];
  calls.forEach((call, index) => {
    const args = JSON.stringify(call.args);
    // Split arguments across chunks the way a streaming API does: id/name only on
    // the first chunk, then argument fragments keyed by index.
    chunks.push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index,
                id: `call_${index}`,
                type: "function",
                function: { name: call.name, arguments: args.slice(0, 5) },
              },
            ],
          },
        },
      ],
    });
    chunks.push({
      choices: [
        {
          delta: {
            tool_calls: [{ index, function: { arguments: args.slice(5) } }],
          },
        },
      ],
    });
  });
  chunks.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  chunks.push({ choices: [], usage });
  return chunks;
}

// Reads a ZIP produced by buildZip() so tests can verify names and contents.
export function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extra = buffer.readUInt16LE(offset + 30);
    const comment = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    const dataStart =
      localOffset +
      30 +
      buffer.readUInt16LE(localOffset + 26) +
      buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(dataStart, dataStart + size);
    files[name] = (method === 8 ? inflateRawSync(raw) : raw).toString("utf8");
    offset += 46 + nameLength + extra + comment;
  }
  return files;
}
