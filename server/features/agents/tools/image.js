import { museImage } from "../../images/muse.js";
import { storeArtifact, readArtifactBytes } from "../artifacts.js";
import { loadConversationFiles } from "../conversation-files.js";
import { IMAGE_UNIT_USD } from "../../../domain/image-pricing.js";
import { META_IMAGE_ASPECT_SIZES } from "../../../domain/meta-models.js";

const MAX_IMAGES_PER_CALL = 4;
const ASPECTS = Object.keys(META_IMAGE_ASPECT_SIZES);

const blockedMessage = (error) =>
  error?.code === "CONTENT_BLOCKED"
    ? "blocked by the content-safety filter; reword the prompt with a safer description"
    : String(error?.message || "image generation failed").slice(0, 200);

// Images are saved as private artifacts of the run; the browser receives them as file
// cards (with inline previews) once the assistant message has been saved.
async function saveImages(ctx, results, label) {
  const artifacts = [];
  for (const [i, result] of results.entries()) {
    const ext = result.mediaType === "image/png" ? "png" : "jpg";
    artifacts.push(
      await storeArtifact({
        supabase: ctx.supabase,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        name: `${label}-${Date.now().toString(36)}-${i + 1}.${ext}`,
        bytes: result.bytes,
        mime: result.mediaType,
        kind: "image",
        existing: ctx.artifacts,
      }),
    );
  }
  ctx.artifacts.push(...artifacts);
  return artifacts;
}

export function imageTools() {
  const generate = {
    name: "generate_image",
    paidOnly: true,
    label: (a) => `image: ${String(a?.prompt || "").slice(0, 50)}`,
    description: `Generate 1-${MAX_IMAGES_PER_CALL} images from a detailed English prompt. Each image costs the user balance, so use count 1 unless variations were requested. Returns the ids of the created images (usable as the source for edit_image).`,
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed image prompt." },
        aspect_ratio: { type: "string", enum: ASPECTS, default: "1:1" },
        count: {
          type: "integer",
          minimum: 1,
          maximum: MAX_IMAGES_PER_CALL,
          default: 1,
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const prompt = String(args.prompt || "").trim();
      if (!prompt) throw new Error("prompt is required");
      const affordable = Math.floor(ctx.remainingUsd / IMAGE_UNIT_USD);
      const count = Math.min(
        MAX_IMAGES_PER_CALL,
        Math.max(1, Math.floor(Number(args.count) || 1)),
        affordable,
      );
      if (count < 1) throw new Error("not enough balance left for an image");
      const aspect = ASPECTS.includes(args.aspect_ratio)
        ? args.aspect_ratio
        : "1:1";
      const settled = await Promise.allSettled(
        Array.from({ length: count }, () =>
          museImage({ prompt, aspectRatio: aspect, user: ctx.userId }),
        ),
      );
      const ok = settled
        .filter((r) => r.status === "fulfilled")
        .map((r) => r.value);
      if (!ok.length) throw new Error(blockedMessage(settled[0].reason));
      const artifacts = await saveImages(ctx, ok, "image");
      return {
        content: `Created ${ok.length} image(s) (${aspect}): ${artifacts.map((a) => `${a.id} (${a.name})`).join(", ")}.${ok.length < count ? ` ${count - ok.length} failed or were blocked and were not billed.` : ""} They are shown to the user automatically.`,
        usd: ok.length * IMAGE_UNIT_USD,
        images: ok.length,
        artifacts,
      };
    },
  };

  const edit = {
    name: "edit_image",
    paidOnly: true,
    label: (a) => `edit image: ${String(a?.prompt || "").slice(0, 40)}`,
    description:
      'Edit or restyle an existing image. `source` is "attachment" (the newest image the user attached) or the id of an image created earlier in this conversation. Describe the full desired result and what must stay unchanged.',
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        source: { type: "string", default: "attachment" },
        aspect_ratio: {
          type: "string",
          enum: ASPECTS,
          description: "Optional; omit to keep the source proportions.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const prompt = String(args.prompt || "").trim();
      if (!prompt) throw new Error("prompt is required");
      if (ctx.remainingUsd < IMAGE_UNIT_USD)
        throw new Error("not enough balance left for an image");
      let reference;
      const source = String(args.source || "attachment");
      if (source === "attachment") {
        reference = ctx.attachmentImages?.[0];
        if (!reference) throw new Error("the user attached no image");
      } else {
        const files = await loadConversationFiles(
          ctx.supabase,
          ctx.userId,
          ctx.conversationId,
        );
        const file = [...files, ...ctx.artifacts].find(
          (f) => f.id === source && /^image\//.test(f.mime || ""),
        );
        if (!file) throw new Error("unknown image id");
        const bytes = await readArtifactBytes(ctx.supabase, file);
        reference = `data:${file.mime};base64,${bytes.toString("base64")}`;
      }
      const aspect = ASPECTS.includes(args.aspect_ratio)
        ? args.aspect_ratio
        : null;
      let result;
      try {
        result = await museImage({
          prompt,
          aspectRatio: aspect,
          references: [reference],
          user: ctx.userId,
        });
      } catch (error) {
        throw new Error(blockedMessage(error));
      }
      const [artifact] = await saveImages(ctx, [result], "edit");
      return {
        content: `Edited image created: ${artifact.id} (${artifact.name}). It is shown to the user automatically.`,
        usd: IMAGE_UNIT_USD,
        images: 1,
        artifacts: [artifact],
      };
    },
  };
  return [generate, edit];
}
