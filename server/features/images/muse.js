import { appError } from "../../core/http.js";
import { metaError } from "../../core/errors.js";
import { generateImage, editImage } from "../../providers/meta.js";
import {
  META_IMAGE_MODEL_ID,
  imageSizeForAspect,
} from "../../domain/meta-models.js";

export const SAFE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export function detectSafeImageType(file) {
  if (!Buffer.isBuffer(file) || !file.length) return "";
  if (
    file.length >= 8 &&
    file
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (
    file.length >= 3 &&
    file[0] === 0xff &&
    file[1] === 0xd8 &&
    file[2] === 0xff
  )
    return "image/jpeg";
  if (
    file.length >= 12 &&
    file.toString("ascii", 0, 4) === "RIFF" &&
    file.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return "";
}

export const imageExtension = (mediaType) =>
  mediaType === "image/png"
    ? "png"
    : mediaType === "image/webp"
      ? "webp"
      : "jpg";

// One Muse Image call. Without references it is text-to-image (/images/generations);
// with references it is an edit (/images/edits, JSON `images` array of data URLs).
// Returns validated bytes; the caller owns persistence and billing.
export async function museImage({
  prompt,
  aspectRatio = "1:1",
  references = [],
  user,
} = {}) {
  const body = {
    model: META_IMAGE_MODEL_ID,
    prompt: String(prompt),
    n: 1,
    // Omitting `size` lets edits keep the source image's own proportions.
    ...(aspectRatio ? { size: imageSizeForAspect(aspectRatio) } : {}),
    response_format: "b64_json",
    output_format: "png",
    ...(user ? { user: String(user) } : {}),
  };
  const edit = references.length > 0;
  if (edit) body.images = references.map((url) => ({ image_url: url }));
  const { response, data } = await (edit ? editImage : generateImage)(body);
  if (!response.ok) throw metaError(response.status, data, { kind: "image" });
  const part = data?.data?.[0];
  if (!part?.b64_json) throw appError("EMPTY_RESPONSE");
  const bytes = Buffer.from(String(part.b64_json).replace(/\s/g, ""), "base64");
  const mediaType = detectSafeImageType(bytes);
  if (!bytes.length || bytes.length > 25 * 1024 * 1024 || !mediaType)
    throw appError("EMPTY_RESPONSE");
  return {
    bytes,
    mediaType,
    revisedPrompt: part.revised_prompt || null,
    usage: {
      input_tokens: Number(data?.usage?.input_tokens || 0),
      output_tokens: Number(data?.usage?.output_tokens || 0),
    },
    aspectRatio,
    size: body.size || null,
  };
}
