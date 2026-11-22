import { estimateImageCharge } from "../../domain/image-pricing.js";
import {
  museImage,
  detectSafeImageType,
  imageExtension,
  SAFE_IMAGE_TYPES,
} from "./muse.js";
import { getImageModel } from "../../domain/meta-models.js";
import { metaConfigured } from "../../providers/meta.js";
import { imageStorage } from "../../providers/storage.js";
import {
  allowMethods,
  appError,
  cleanText,
  json,
  localize,
  requestLocale,
  enforceJsonBodySize,
  enforceRateLimit,
  requestIp,
} from "../../core/http.js";
import { db } from "../../core/runtime.js";
import { errorDetails, handleError } from "../../core/errors.js";
import {
  isLowBalance,
  reservationTokens,
  chargeFromProviderUsd,
} from "../../domain/credits.js";
import {
  requireUser,
  createDownloadTicket,
  verifyDownloadTicket,
} from "../auth/service.js";
import {
  ensureConversationOwner,
  normalizeRequestId,
} from "../../data/ownership.js";
import {
  reserveAiTokens,
  finalizeAiTokens,
  releaseAiTokens,
  claimFreeTrialToken,
  releaseFreeTrialToken,
} from "../../domain/reservations.js";
import {
  assertFeatureEnabled,
  assertUserCapability,
} from "../../domain/settings.js";

function isStorageCapacityError(error) {
  const text = String(
    error?.message || error?.error || error || "",
  ).toLowerCase();
  const status = Number(error?.statusCode || error?.status || 0);
  return (
    status === 413 ||
    status === 507 ||
    /quota|storage.*limit|limit.*storage|insufficient storage|capacity|bucket.*full|exceeded|maximum.*size|database or disk is full/.test(
      text,
    )
  );
}

function safeFilename(value, extension) {
  const base =
    String(value || `AiWay-${Date.now()}`)
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 80) || "AiWay-image";
  return `${base.replace(/\.(png|jpe?g|webp)$/i, "")}.${extension}`;
}

async function cleanupExpiredImages(req, res) {
  const expected = process.env.CRON_SECRET;
  const auth = String(req.headers?.authorization || "");
  if (!expected || auth !== `Bearer ${expected}`)
    throw new Error("UNAUTHORIZED");

  const supabase = db();
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const { data: expired, error } = await supabase
    .from("generated_images")
    .select("id,storage_path")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw error;

  const rows = Array.isArray(expired) ? expired : [];
  const storagePaths = rows.map((row) => row.storage_path).filter(Boolean);
  if (storagePaths.length) {
    const { error: removeError } =
      await imageStorage(supabase).remove(storagePaths);
    if (removeError) throw removeError;
  }

  const ids = rows.map((row) => row.id).filter(Boolean);
  if (ids.length) {
    const { error: deleteError } = await supabase
      .from("generated_images")
      .delete()
      .in("id", ids);
    if (deleteError) throw deleteError;
  }

  return json(res, 200, {
    success: true,
    deletedRecords: ids.length,
    deletedFiles: storagePaths.length,
    cutoff,
  });
}

async function prepareImageDownload(req, res) {
  const user = await requireUser(req);
  const imageId = cleanText(req.body?.imageId, 100);
  if (!imageId) throw appError("INVALID_REQUEST");
  const { data: image, error } = await db()
    .from("generated_images")
    .select("id")
    .eq("id", imageId)
    .eq("user_id", user.id)
    .single();
  if (error || !image) throw new Error("IMAGE_NOT_FOUND");
  const ticket = await createDownloadTicket(
    { sub: user.id, imageId, kind: "image" },
    "2m",
  );
  return json(res, 200, {
    url: `/api/image?action=native-download&ticket=${encodeURIComponent(ticket)}`,
  });
}

async function nativeImageDownload(req, res) {
  const ticket = await verifyDownloadTicket(req.query?.ticket);
  if (ticket.kind !== "image" || !ticket.imageId || !ticket.sub)
    throw new Error("UNAUTHORIZED");
  req.query.imageId = String(ticket.imageId);
  req.downloadUserId = String(ticket.sub);
  return downloadImage(req, res, true, false);
}

async function viewImage(req, res) {
  const ticket = await verifyDownloadTicket(req.query?.ticket);
  if (ticket.kind !== "image-view" || !ticket.imageId || !ticket.sub)
    throw new Error("UNAUTHORIZED");
  req.query.imageId = String(ticket.imageId);
  req.downloadUserId = String(ticket.sub);
  return downloadImage(req, res, true, true);
}

async function downloadImage(req, res, ticketed = false, inline = false) {
  const imageId = String(req.body?.imageId || req.query?.imageId || "");
  if (!imageId) throw new Error("UNAUTHORIZED");

  const user = ticketed ? { id: req.downloadUserId } : await requireUser(req);

  const { data: image, error } = await db()
    .from("generated_images")
    .select("id,media_type,thumbnail_data,storage_path,source_url,created_at")
    .eq("id", imageId)
    .eq("user_id", user.id)
    .single();
  if (error || !image) throw new Error("IMAGE_NOT_FOUND");

  let file;
  let mediaType = String(image.media_type || "image/jpeg").toLowerCase();
  if (image.storage_path) {
    const extension = imageExtension(
      SAFE_IMAGE_TYPES.has(mediaType) ? mediaType : "image/jpeg",
    );
    const filename = safeFilename(`AiWay-${image.id}`, extension);
    const { data: signed, error: signedError } = await imageStorage(
      db(),
    ).createSignedUrl(
      image.storage_path,
      300,
      inline ? {} : { download: filename },
    );
    if (!signedError && signed?.signedUrl) {
      res.statusCode = 302;
      res.setHeader("Location", signed.signedUrl);
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      return res.end();
    }
  }
  if (!file && image.thumbnail_data) {
    const match = String(image.thumbnail_data || "").match(
      /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/,
    );
    if (match) {
      mediaType = String(
        image.media_type || match[1] || "image/jpeg",
      ).toLowerCase();
      file = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    }
  }
  // Serve generated images only from our own storage/database copy.
  // Arbitrary persisted source URLs are never fetched here, preventing SSRF.
  if (!file?.length) throw new Error("IMAGE_NOT_FOUND");
  const detectedType = detectSafeImageType(file);
  if (!detectedType) throw new Error("IMAGE_NOT_FOUND");
  mediaType = detectedType;
  const extension = imageExtension(mediaType);
  const filename = safeFilename(`AiWay-${image.id}`, extension);

  res.status(200);
  res.setHeader("Content-Type", mediaType);
  res.setHeader("Content-Length", String(file.length));
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${filename}"`,
  );
  res.setHeader(
    "Cache-Control",
    inline ? "private, max-age=300" : "private, no-store, max-age=0",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.end(file);
}

async function persistImage(req, res) {
  const user = await requireUser(req);
  const imageId = String(req.body?.imageId || "");
  const imageData = String(req.body?.imageData || "");
  if (!imageId || !imageData) throw appError("INVALID_IMAGE_REQUEST");

  const match = imageData.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw appError("INVALID_IMAGE_REQUEST");
  const declaredType = String(match[1] || "")
    .trim()
    .toLowerCase();
  if (!SAFE_IMAGE_TYPES.has(declaredType))
    throw appError("INVALID_IMAGE_REQUEST");
  const file = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!file.length || file.length > 25 * 1024 * 1024)
    throw appError("ATTACHMENT_TOO_LARGE");
  const mediaType = detectSafeImageType(file);
  if (!mediaType || mediaType !== declaredType)
    throw appError("INVALID_IMAGE_REQUEST");
  const extension = imageExtension(mediaType);

  const supabase = db();
  const { data: image, error } = await supabase
    .from("generated_images")
    .select("id,user_id,storage_path")
    .eq("id", imageId)
    .eq("user_id", user.id)
    .single();
  if (error || !image) throw new Error("IMAGE_NOT_FOUND");
  if (image.storage_path)
    return json(res, 200, { saved: true, storagePath: image.storage_path });

  const storagePath = `${user.id}/${imageId}.${extension}`;
  const { error: uploadError } = await imageStorage(supabase).upload(
    storagePath,
    file,
    {
      contentType: mediaType,
      cacheControl: "31536000",
      upsert: false,
    },
  );
  if (
    uploadError &&
    !/already exists|duplicate/i.test(String(uploadError.message || ""))
  ) {
    if (!isStorageCapacityError(uploadError)) throw uploadError;

    // Emergency mode: do not stop image generation when the Storage bucket is full.
    // The browser keeps the generated data URL in the current session so the user
    // can preview and download it immediately, while Supabase stores metadata only.
    const { error: fallbackUpdateError } = await supabase
      .from("generated_images")
      .update({
        storage_status: "client_only",
        fallback_reason: "storage_capacity",
        file_size: file.length,
        thumbnail_data: null,
      })
      .eq("id", imageId)
      .eq("user_id", user.id);
    if (fallbackUpdateError) throw fallbackUpdateError;

    return json(res, 200, {
      saved: false,
      fallback: true,
      storageStatus: "client_only",
      reason: "storage_capacity",
    });
  }

  const { error: updateError } = await supabase
    .from("generated_images")
    .update({
      storage_path: storagePath,
      storage_status: "ready",
      file_size: file.length,
      stored_at: new Date().toISOString(),
      thumbnail_data: null,
      fallback_reason: null,
    })
    .eq("id", imageId)
    .eq("user_id", user.id);
  if (updateError) throw updateError;
  return json(res, 200, { saved: true, storagePath });
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["GET", "POST"])) return;
  const uiLocale = requestLocale(req);
  let reservationUserId = null,
    reservationRequestId = null,
    reservationSupabase = null,
    reservationActive = false,
    freeTrialActive = false;
  try {
    const actionName = String(req.body?.action || req.query?.action || "");
    if (
      ![
        "native-download",
        "view",
        "prepare-download",
        "cleanup-expired",
      ].includes(actionName)
    ) {
      const gateUser = await requireUser(req);
      await assertFeatureEnabled("images", { user: gateUser });
      await assertUserCapability(gateUser.id, "chat", gateUser.role);
    }
    const action = String(req.body?.action || req.query?.action || "");
    if (action === "cleanup-expired" && req.method === "GET")
      return await cleanupExpiredImages(req, res);
    if (action === "native-download" && req.method === "GET")
      return await nativeImageDownload(req, res);
    if (action === "view" && req.method === "GET")
      return await viewImage(req, res);
    if (action === "prepare-download" && req.method === "POST")
      return await prepareImageDownload(req, res);
    if (action === "download") return await downloadImage(req, res);
    if (req.method === "GET") throw appError("INVALID_IMAGE_REQUEST");
    enforceJsonBodySize(req, 4_300_000);
    if (action === "persist") return await persistImage(req, res);

    const user = await requireUser(req);

    // Image generation is materially more expensive than text chat, so it gets a
    // smaller burst allowance plus an hourly ceiling. Persist/download/view actions
    // are handled above and intentionally do not consume these generation limits.
    const rateSupabase = db();
    const ip = requestIp(req);
    await Promise.all([
      enforceRateLimit(rateSupabase, `image:user:${user.id}:minute`, 4, 60),
      enforceRateLimit(rateSupabase, `image:user:${user.id}:hour`, 30, 3600),
      enforceRateLimit(rateSupabase, `image:ip:${ip}:minute`, 16, 60),
      enforceRateLimit(rateSupabase, `image:ip:${ip}:hour`, 120, 3600),
    ]);

    const {
      conversationId,
      prompt,
      referenceImage,
      attachments = [],
      modelId,
      aspectRatio = "1:1",
      resolution = "",
      requestId: rawRequestId,
      taskId: rawTaskId,
    } = req.body || {};
    const requestId = normalizeRequestId(rawRequestId);
    reservationUserId = user.id;
    reservationRequestId = requestId;
    // Preserve the full prompt. Provider/serverless limits should fail explicitly rather than
    // silently clipping long prompts.
    const suppliedAttachments = Array.isArray(attachments) ? attachments : [];
    const cleanPrompt =
      String(prompt ?? "").trim() ||
      (suppliedAttachments.length
        ? localize(
            uiLocale,
            "استخدم المرفقات كمرجع لإنشاء الصورة المطلوبة.",
            "Use the attachments as references for the requested image.",
          )
        : "");
    const textAttachments = suppliedAttachments.filter(
      (a) => typeof a?.text === "string",
    );
    const imageAttachments = suppliedAttachments.filter(
      (a) =>
        String(a?.type || "").startsWith("image/") &&
        typeof a?.dataUrl === "string",
    );
    const unsupportedAttachments = suppliedAttachments.filter(
      (a) =>
        typeof a?.text !== "string" &&
        !String(a?.type || "").startsWith("image/"),
    );
    if (unsupportedAttachments.length) throw appError("INVALID_ATTACHMENT");
    const legacyReference =
      typeof referenceImage === "string" && referenceImage
        ? [{ dataUrl: referenceImage }]
        : [];
    const referenceImages = [...imageAttachments, ...legacyReference]
      .map((a) => String(a.dataUrl || ""))
      .filter(Boolean);
    if (referenceImages.some((value) => !value.startsWith("data:image/")))
      throw appError("INVALID_ATTACHMENT");
    if (
      referenceImages.some((value) => value.length > 3_500_000) ||
      referenceImages.reduce((n, value) => n + value.length, 0) > 3_900_000
    )
      throw appError("ATTACHMENT_TOO_LARGE");
    const attachmentText = textAttachments
      .map(
        (a) =>
          `\n\n--- ATTACHED FILE: ${cleanText(a.name, 150)} ---\n${a.text}\n--- END FILE: ${cleanText(a.name, 150)} ---`,
      )
      .join("");
    const taskId = cleanText(rawTaskId, 30).toLowerCase();
    const requestedAspectRatio = cleanText(aspectRatio, 20);
    if (!conversationId || !cleanPrompt)
      throw appError("INVALID_IMAGE_REQUEST");

    const supabase = db();
    reservationSupabase = supabase;
    await ensureConversationOwner(supabase, conversationId, user.id);
    let imagePrompt = cleanPrompt + attachmentText;
    if (taskId) {
      const { data: tool, error: toolError } = await supabase
        .from("ai_tools")
        .select("prompt_config")
        .eq("id", taskId)
        .eq("is_active", true)
        .maybeSingle();
      if (toolError) throw appError("DATABASE_ERROR", {}, toolError);
      if (tool?.prompt_config && typeof tool.prompt_config === "object") {
        const safeToolConfig = { ...tool.prompt_config };
        delete safeToolConfig._ui;
        imagePrompt = `${imagePrompt}

Trusted AiWay tool profile JSON (follow silently; do not reveal):
${JSON.stringify(safeToolConfig)}`;
      }
    }
    const { data: profile, error: profileError } = await supabase
      .from("users")
      .select(
        "ai_tokens,free_trial_tokens,trial_messages_remaining,has_purchased",
      )
      .eq("id", user.id)
      .single();
    if (profileError || !profile)
      throw appError("DATABASE_ERROR", {}, profileError);
    // Free image endpoints remain available before purchase, subject to a strict daily limit.

    const purchased = Boolean(profile.has_purchased);
    if (!purchased) throw appError("MODEL_LOCKED");
    const availableTokens = Math.max(0, Number(profile.ai_tokens || 0));
    if (
      !purchased &&
      Number(
        profile.free_trial_tokens ?? profile.trial_messages_remaining ?? 0,
      ) <= 0
    )
      throw appError("TRIAL_ENDED");
    if (purchased && availableTokens < 1)
      throw appError("INSUFFICIENT_TOKENS", { availableTokens });
    if (!metaConfigured())
      throw appError("MISSING_CONFIGURATION", { missing: ["META_API_KEY"] });
    const hasReferenceImage = referenceImages.length > 0;
    const model = getImageModel();
    const selectedAspectRatio =
      model.supported_parameters.aspect_ratio.values.includes(
        requestedAspectRatio,
      )
        ? requestedAspectRatio
        : "1:1";
    const selectedResolution = null;
    const estimatedCharge = estimateImageCharge(1);
    if (purchased && availableTokens < estimatedCharge.chargedTokens) {
      throw appError("INSUFFICIENT_TOKENS_FOR_REQUEST", {
        availableTokens,
        requiredTokens: estimatedCharge.chargedTokens,
        shortfall: estimatedCharge.chargedTokens - availableTokens,
      });
    }

    let reservedTokens = 0;
    if (purchased) {
      reservedTokens = reservationTokens(
        estimatedCharge.chargedTokens,
        "image",
      );
      if (availableTokens < reservedTokens) {
        throw appError("INSUFFICIENT_TOKENS_FOR_REQUEST", {
          availableTokens,
          requiredTokens: reservedTokens,
          shortfall: reservedTokens - availableTokens,
        });
      }
      await reserveAiTokens(
        supabase,
        user.id,
        requestId,
        "image",
        reservedTokens,
      );
      reservationActive = true;
    } else {
      await claimFreeTrialToken(
        supabase,
        user.id,
        requestId,
        taskId || "image",
      );
      freeTrialActive = true;
    }

    const generated = await museImage({
      prompt: imagePrompt,
      aspectRatio: selectedAspectRatio,
      references: referenceImages,
      user: user.id,
    });
    const generatedFile = generated.bytes;
    const mediaType = generated.mediaType;
    const thumbnailData = `data:${mediaType};base64,${generatedFile.toString("base64")}`;
    const sourceUrl = null;
    const imageUsage = {
      prompt_tokens: generated.usage.input_tokens,
      completion_tokens: generated.usage.output_tokens,
      total_tokens:
        generated.usage.input_tokens + generated.usage.output_tokens,
    };
    // Muse Image is billed per image, not per token.
    const charge = chargeFromProviderUsd(
      estimatedCharge.providerUsd,
      imageUsage,
    );
    const item = { width: null, height: null };

    let savedUser = null;
    let savedAssistant = null;
    let savedImage = null;
    let uploadedStoragePath = null;
    try {
      const userInsert = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          user_id: user.id,
          role: "user",
          content: cleanPrompt,
          token_usage: {
            image_request: true,
            reference_image: hasReferenceImage,
            reference_images: referenceImages.length,
            attachments: textAttachments.map((a) => ({
              name: cleanText(a.name, 150),
              type: a.type,
              size: Number(a.size || 0),
              text: true,
            })),
            taskId: taskId || "image",
          },
        })
        .select("id")
        .single();
      if (userInsert.error || !userInsert.data)
        throw appError("DATABASE_ERROR", {}, userInsert.error);
      savedUser = userInsert.data;

      const assistantInsert = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          user_id: user.id,
          role: "assistant",
          content: localize(
            uiLocale,
            "تم إنشاء الصورة المطلوبة.",
            "The requested image has been generated.",
          ),
          model_id: model.id,
          token_usage: {
            ...imageUsage,
            ...charge,
            type: "image",
            taskId: taskId || "image",
            provider: "meta",
          },
        })
        .select("id")
        .single();
      if (assistantInsert.error || !assistantInsert.data)
        throw appError("DATABASE_ERROR", {}, assistantInsert.error);
      savedAssistant = assistantInsert.data;

      const imageInsert = await supabase
        .from("generated_images")
        .insert({
          message_id: savedAssistant.id,
          conversation_id: conversationId,
          user_id: user.id,
          model_id: model.id,
          prompt: cleanPrompt,
          media_type: mediaType,
          thumbnail_data: null,
          source_url: sourceUrl,
          storage_status: "pending",
          width: Number(item.width) || null,
          height: Number(item.height) || null,
          token_usage: {
            ...imageUsage,
            ...charge,
            aspectRatio: selectedAspectRatio || null,
            resolution: selectedResolution || null,
          },
        })
        .select("*")
        .single();
      if (imageInsert.error || !imageInsert.data)
        throw appError("DATABASE_ERROR", {}, imageInsert.error);
      savedImage = imageInsert.data;

      const extension = imageExtension(mediaType);
      const storagePath = `${user.id}/${savedImage.id}.${extension}`;
      const { error: uploadError } = await imageStorage(supabase).upload(
        storagePath,
        generatedFile,
        { contentType: mediaType, cacheControl: "31536000", upsert: false },
      );
      if (
        !uploadError ||
        /already exists|duplicate/i.test(String(uploadError?.message || ""))
      ) {
        uploadedStoragePath = storagePath;
        const { data: updated, error: updateError } = await supabase
          .from("generated_images")
          .update({
            storage_path: storagePath,
            storage_status: "ready",
            file_size: generatedFile.length,
            stored_at: new Date().toISOString(),
            thumbnail_data: null,
            fallback_reason: null,
          })
          .eq("id", savedImage.id)
          .eq("user_id", user.id)
          .select("*")
          .single();
        if (updateError || !updated)
          throw appError("DATABASE_ERROR", {}, updateError);
        savedImage = updated;
      } else if (thumbnailData.length <= 3_500_000) {
        const { data: updated, error: updateError } = await supabase
          .from("generated_images")
          .update({
            storage_status: "client_only",
            fallback_reason: isStorageCapacityError(uploadError)
              ? "storage_capacity"
              : "storage_unavailable",
            file_size: generatedFile.length,
            thumbnail_data: thumbnailData,
          })
          .eq("id", savedImage.id)
          .eq("user_id", user.id)
          .select("*")
          .single();
        if (updateError || !updated)
          throw appError("DATABASE_ERROR", {}, updateError);
        savedImage = updated;
      } else {
        throw appError("DATABASE_ERROR", {}, uploadError);
      }
    } catch (saveError) {
      const cleanupStoragePath =
        savedImage?.storage_path || uploadedStoragePath;
      if (cleanupStoragePath)
        await imageStorage(supabase)
          .remove([cleanupStoragePath])
          .catch(() => {});
      if (savedImage?.id)
        await supabase
          .from("generated_images")
          .delete()
          .eq("id", savedImage.id)
          .eq("user_id", user.id);
      if (savedAssistant?.id)
        await supabase
          .from("messages")
          .delete()
          .eq("id", savedAssistant.id)
          .eq("user_id", user.id);
      if (savedUser?.id)
        await supabase
          .from("messages")
          .delete()
          .eq("id", savedUser.id)
          .eq("user_id", user.id);
      throw saveError;
    }

    const remainingTokens = purchased
      ? await finalizeAiTokens(
          supabase,
          user.id,
          requestId,
          charge.chargedTokens,
          { imageId: savedImage.id, modelId: model.id },
        )
      : Math.max(
          0,
          Number(
            profile.free_trial_tokens ?? profile.trial_messages_remaining ?? 0,
          ) - 1,
        );
    reservationActive = false;
    freeTrialActive = false;
    const conversationUpdate = await supabase
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId)
      .eq("user_id", user.id);
    if (conversationUpdate.error)
      console.warn(
        "Conversation timestamp update failed:",
        conversationUpdate.error.message,
      );

    const imageTicket = await createDownloadTicket(
      { sub: user.id, imageId: savedImage.id, kind: "image-view" },
      "2h",
    );
    const responseImage = {
      ...savedImage,
      display_url: `/api/image?action=view&ticket=${encodeURIComponent(imageTicket)}`,
    };
    // Storage-backed images must never carry their Base64 payload back through Vercel.
    if (responseImage.storage_path) responseImage.thumbnail_data = null;
    return json(res, 200, {
      image: responseImage,
      chargedTokens: purchased ? charge.chargedTokens : 1,
      providerUsd: charge.providerUsd,
      selectedModelName: model.name || model.id,
      modelId: model.id,
      routedModelId: model.id,
      remainingTokens,
      lowBalance: isLowBalance(remainingTokens, charge.chargedTokens),
    });
  } catch (error) {
    if (
      reservationActive &&
      reservationSupabase &&
      reservationUserId &&
      reservationRequestId
    ) {
      await releaseAiTokens(
        reservationSupabase,
        reservationUserId,
        reservationRequestId,
        { code: String(error?.code || "SERVER_ERROR") },
      );
      reservationActive = false;
    }
    if (
      freeTrialActive &&
      reservationSupabase &&
      reservationUserId &&
      reservationRequestId
    ) {
      await releaseFreeTrialToken(
        reservationSupabase,
        reservationUserId,
        reservationRequestId,
      );
      freeTrialActive = false;
    }
    const action = String(req.body?.action || req.query?.action || "");
    if (action === "download" && error?.message === "IMAGE_NOT_FOUND") {
      const details = errorDetails(error, uiLocale);
      res.status(404).setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.end(
        details?.message ||
          localize(uiLocale, "الصورة غير موجودة.", "Image not found."),
      );
    }
    return handleError(
      error,
      res,
      action === "download"
        ? localize(
            uiLocale,
            "تعذر تنزيل الصورة. حاول مرة أخرى.",
            "Could not download the image. Try again.",
          )
        : localize(
            uiLocale,
            "حدث عطل مؤقت أثناء إنشاء الصورة. حاول مرة أخرى؛ لم يتم خصم رصيدك.",
            "A temporary error occurred while generating the image. Try again; your balance was not charged.",
          ),
      uiLocale,
    );
  }
}
