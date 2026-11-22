import { agentStorage } from "../../../providers/storage.js";
import { requireSafePath, storeArtifact } from "../artifacts.js";
import { buildZip } from "../zip.js";
import { validateProject } from "./project-check.js";
import { webSearchTool } from "./web.js";

// The Pi App Builder works in a virtual project folder kept in memory during a run and
// persisted as one JSON snapshot per conversation, so follow-up requests ("add a
// settings page") continue the same project. Nothing is ever executed or written to
// the server's file system.
const MAX_FILE_BYTES = 400_000;
const MAX_TOTAL_BYTES = 2_500_000;
const MAX_FILES = 80;
const READ_CHUNK_CHARS = 12_000;

const snapshotPath = (ctx) =>
  `${ctx.userId}/${ctx.conversationId}/_workspace.json`;

async function loadSnapshot(ctx) {
  try {
    const { data, error } = await agentStorage(ctx.supabase).download(
      snapshotPath(ctx),
    );
    if (error || !data) return;
    const parsed = JSON.parse(
      Buffer.from(await data.arrayBuffer()).toString("utf8"),
    );
    for (const [name, content] of Object.entries(parsed.files || {}))
      if (typeof content === "string")
        ctx.workspace.set(requireSafePath(name), content);
    ctx.projectName = parsed.name || ctx.projectName;
  } catch {
    // A missing or corrupt snapshot simply starts a fresh project.
  }
}

const totalBytes = (ws) =>
  [...ws.values()].reduce((n, c) => n + Buffer.byteLength(c), 0);

const slug = (value) =>
  String(value || "pi-app")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "pi-app";

export async function piBuilderTools(ctx) {
  ctx.workspace = new Map();
  ctx.projectName = "";
  await loadSnapshot(ctx);
  const ws = ctx.workspace;
  let dirty = false;
  ctx.finalizers.push(async () => {
    if (!dirty) return;
    const files = Object.fromEntries(ws);
    const { error } = await agentStorage(ctx.supabase).upload(
      snapshotPath(ctx),
      Buffer.from(JSON.stringify({ name: ctx.projectName, files })),
      { contentType: "application/json" },
    );
    if (error) console.warn("[WORKSPACE_SNAPSHOT_FAILED]", error.message);
  });

  const writeFile = {
    name: "write_file",
    label: (a) => `write ${String(a?.path || "").slice(0, 60)}`,
    description:
      "Create or overwrite a text file in the project. Provide the COMPLETE file content. Use relative paths with forward slashes. Binary files are not supported (use SVG for icons and logos).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: 'e.g. "css/style.css"' },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async run(args) {
      const path = requireSafePath(args.path);
      const content = String(args.content ?? "");
      if (Buffer.byteLength(content) > MAX_FILE_BYTES)
        throw new Error(
          `file is too large (max ${MAX_FILE_BYTES / 1000} KB); split it into modules`,
        );
      const next = new Map(ws).set(path, content);
      if (next.size > MAX_FILES)
        throw new Error(`too many files (max ${MAX_FILES})`);
      if (totalBytes(next) > MAX_TOTAL_BYTES)
        throw new Error("project is too large");
      ws.set(path, content);
      dirty = true;
      return {
        content: `Wrote ${path} (${Buffer.byteLength(content)} bytes). Project now has ${ws.size} file(s).`,
      };
    },
  };

  const editFile = {
    name: "edit_file",
    label: (a) => `edit ${String(a?.path || "").slice(0, 60)}`,
    description:
      "Replace one exact, unique occurrence of old_string with new_string in an existing file. Prefer this over rewriting a large file for small changes.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    async run(args) {
      const path = requireSafePath(args.path);
      const current = ws.get(path);
      if (current === undefined) throw new Error(`${path} does not exist`);
      const old = String(args.old_string);
      if (!old) throw new Error("old_string must not be empty");
      const count = current.split(old).length - 1;
      if (count !== 1)
        throw new Error(
          count
            ? `old_string matches ${count} places; make it unique`
            : "old_string was not found",
        );
      const updated = current.replace(old, () => String(args.new_string));
      if (Buffer.byteLength(updated) > MAX_FILE_BYTES)
        throw new Error("file would become too large");
      ws.set(path, updated);
      dirty = true;
      return { content: `Edited ${path}.` };
    },
  };

  const readFile = {
    name: "read_file",
    label: (a) => `read ${String(a?.path || "").slice(0, 60)}`,
    description: `Read a project file. Returns up to ${READ_CHUNK_CHARS} characters; pass start_line to continue.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "integer", minimum: 1, default: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async run(args) {
      const path = requireSafePath(args.path);
      const content = ws.get(path);
      if (content === undefined) throw new Error(`${path} does not exist`);
      const lines = content.split("\n");
      const start = Math.max(1, Math.floor(Number(args.start_line) || 1));
      let out = "",
        n = start - 1;
      while (
        n < lines.length &&
        out.length + lines[n].length < READ_CHUNK_CHARS
      )
        out += `${n + 1}: ${lines[n++]}\n`;
      return {
        content:
          out +
          (n < lines.length
            ? `…next: start_line=${n + 1} (of ${lines.length} lines)`
            : `(end of file, ${lines.length} lines)`),
      };
    },
  };

  const listFiles = {
    name: "list_files",
    description: "List all files in the project with their sizes.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      if (!ws.size) return { content: "The project is empty." };
      return {
        content: [...ws]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([p, c]) => `${p}  (${Buffer.byteLength(c)} bytes)`)
          .join("\n"),
      };
    },
  };

  const deleteFile = {
    name: "delete_file",
    description: "Delete a file from the project.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    async run(args) {
      const path = requireSafePath(args.path);
      if (!ws.delete(path)) throw new Error(`${path} does not exist`);
      dirty = true;
      return { content: `Deleted ${path}.` };
    },
  };

  const validate = {
    name: "validate_project",
    description:
      "Run static checks (broken links, JS/JSON syntax, Pi SDK usage, secrets in client code, accessibility basics). Returns errors that must be fixed and warnings.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const { errors, warnings } = validateProject(ws);
      return {
        content:
          errors.length || warnings.length
            ? `Errors (${errors.length}):\n${errors.map((e) => `- ${e}`).join("\n") || "none"}\nWarnings (${warnings.length}):\n${warnings.map((w) => `- ${w}`).join("\n") || "none"}`
            : "No problems found.",
      };
    },
  };

  const pack = {
    name: "package_project",
    label: () => "package ZIP",
    description:
      "Package the whole project into a downloadable ZIP that is delivered to the user in the chat. Refuses while validate_project errors remain unless force is true.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Project name used for the ZIP file name.",
        },
        force: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
    async run(args) {
      if (!ws.size) throw new Error("the project is empty");
      const { errors } = validateProject(ws);
      if (errors.length && !args.force)
        throw new Error(
          `fix these errors first (or pass force): ${errors.slice(0, 8).join(" | ")}`,
        );
      ctx.projectName = slug(args.name || ctx.projectName);
      const files = [...ws].map(([path, content]) => ({ path, content }));
      const zip = buildZip(files);
      const single = files.length === 1;
      const artifact = await storeArtifact({
        supabase: ctx.supabase,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        name: single
          ? files[0].path.split("/").pop()
          : `${ctx.projectName}.zip`,
        bytes: single ? Buffer.from(files[0].content) : zip,
        kind: single ? "file" : "project",
        existing: ctx.artifacts,
      });
      ctx.artifacts.push(artifact);
      dirty = true;
      return {
        content: `Packaged ${files.length} file(s) into ${artifact.name} (${artifact.size} bytes). It is delivered to the user automatically.`,
        artifacts: [artifact],
      };
    },
  };

  return [
    webSearchTool,
    listFiles,
    readFile,
    writeFile,
    editFile,
    deleteFile,
    validate,
    pack,
  ];
}
