import {
  allowMethods,
  json,
  requestLocale,
  localize,
} from "../../core/http.js";
import { requireUser } from "../auth/service.js";
import { db } from "../../core/runtime.js";
import { packageQuote } from "../../domain/payment-quotes.js";
import {
  getPaymentPackages,
  getFeatureFlags,
  getGlobalAnnouncement,
} from "../../domain/settings.js";
import {
  TOKEN_USD,
  estimateChatCharge,
  fitMessagesToModelContext,
} from "../../domain/credits.js";
import { getAiTools } from "../../domain/tools.js";
import { getChatModel, getImageModel } from "../../domain/meta-models.js";
import { estimateImageCharge } from "../../domain/image-pricing.js";
import { agentTools, resolveAgent, isAgentTask } from "../agents/registry.js";

// This endpoint bootstraps the app. Model choice is intentionally hidden from users, so
// the catalog it returns is the single fixed chat model plus the single image model.
async function userBilling(req) {
  try {
    const user = await requireUser(req);
    const { data } = await db()
      .from("users")
      .select("has_purchased,ai_tokens")
      .eq("id", user.id)
      .single();
    return {
      purchased: Boolean(data?.has_purchased),
      availableTokens: Math.max(0, Number(data?.ai_tokens || 0)),
    };
  } catch {
    return { purchased: false, availableTokens: 0, anonymous: true };
  }
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["GET", "POST"])) return;
  const locale = requestLocale(req);
  try {
    if (req.method === "POST") {
      const body =
        typeof req.body === "string"
          ? JSON.parse(req.body || "{}")
          : req.body || {};
      if (body.action !== "estimate-message")
        return json(res, 400, {
          error: localize(locale, "طلب غير صالح.", "Invalid request."),
        });
      const { purchased } = await userBilling(req);
      const taskId = String(body.taskId || "")
        .trim()
        .toLowerCase();
      const chat = getChatModel();
      const image = getImageModel();
      const freeTrial = !purchased;

      if (taskId === "image" || body.modelId === image.id) {
        const estimate = estimateImageCharge(1);
        return json(res, 200, {
          type: "image",
          modelId: image.id,
          routedModelId: image.id,
          modelName: image.name,
          ...(purchased ? estimate : { providerUsd: 0, chargedTokens: 1 }),
          approximate: true,
          freeTrial,
          billingMode: purchased ? "paid" : "free_trial",
          resolution: String(body.resolution || ""),
          aspectRatio: String(body.aspectRatio || ""),
          pricingBasis: estimate.pricingBasis,
          unitPrice: estimate.unitPrice,
        });
      }

      if (isAgentTask(taskId)) {
        // Agents run several steps, so the figure is an upper bound (what is held
        // while the run is in progress); the final charge is the actual usage.
        const limits = resolveAgent(taskId).limits;
        const maxUsd = Number(limits.reserveUsd || 0.05);
        return json(res, 200, {
          type: "agent",
          agentId: taskId,
          modelId: chat.id,
          routedModelId: chat.id,
          modelName: chat.name,
          providerUsd: maxUsd,
          chargedTokens: purchased ? Math.ceil(maxUsd / TOKEN_USD) : 1,
          maxChargedTokens: Math.ceil(maxUsd / TOKEN_USD),
          approximate: true,
          upperBound: true,
          freeTrial,
          billingMode: purchased ? "paid" : "free_trial",
        });
      }

      const estimateMessages = Array.isArray(body.messages)
        ? body.messages
        : [];
      const fitted = fitMessagesToModelContext(
        estimateMessages,
        Number(chat.contextLength || 0),
        purchased ? 32768 : 16384,
        locale,
      );
      if (fitted.tooLarge)
        return json(res, 413, {
          error: localize(
            locale,
            "المحتوى أكبر من سعة النموذج المختار.",
            "The content exceeds the model context capacity.",
          ),
          code: "CONTEXT_TOO_LONG",
        });
      const estimate = estimateChatCharge(
        chat.pricing,
        fitted.messages,
        Boolean(body.webSearch),
        0,
      );
      return json(res, 200, {
        type: "chat",
        modelId: chat.id,
        routedModelId: chat.id,
        modelName: chat.name,
        ...(purchased
          ? estimate
          : { ...estimate, providerUsd: 0, chargedTokens: 1 }),
        approximate: true,
        omittedContextMessages:
          Number(body.clientOmittedContextMessages || 0) +
          Number(fitted.omittedMessages || 0),
        freeTrial,
        billingMode: purchased ? "paid" : "free_trial",
      });
    }

    const { purchased } = await userBilling(req);
    const chat = getChatModel();
    const image = getImageModel();
    const chatEntry = {
      ...chat,
      type: "chat",
      isAuto: false,
      isFree: false,
      locked: false,
      trial: true,
      costPerMillion:
        (Number(chat.pricing.prompt) + Number(chat.pricing.completion)) * 1e6,
    };
    const packageConfig = await getPaymentPackages();
    const packages = {};
    for (const id of Object.keys(packageConfig)) {
      try {
        packages[id] = await packageQuote(id);
      } catch {
        packages[id] = { ...packageConfig[id], amountPi: null };
      }
    }
    const storedTools = await getAiTools();
    const agentIds = new Set(agentTools().map((t) => t.id));
    return json(res, 200, {
      name: "AiWay",
      models: [chatEntry],
      chatModelOrders: {
        cheapest: [chat.id],
        paid: [chat.id],
        mostExpensive: [chat.id],
        free: [chat.id],
      },
      trialModelId: chat.id,
      packages,
      imageModels: [
        {
          ...image,
          type: "image",
          supportedAspectRatios: image.supported_parameters.aspect_ratio.values,
          supportedResolutions: image.supported_parameters.resolution.values,
          locked: !purchased,
          isFree: false,
        },
      ],
      tokenUsd: TOKEN_USD,
      // Agents first, then the remaining stored tools (an admin-defined tool can never
      // shadow a built-in agent id).
      tools: [
        ...agentTools(),
        ...storedTools.filter((tool) => !agentIds.has(tool.id)),
      ],
      featureFlags: await getFeatureFlags(),
      globalAnnouncement: await getGlobalAnnouncement(),
      modelSelection: "hidden",
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(error);
    return json(res, 500, {
      error: localize(
        locale,
        "تعذر تحميل الأدوات والأسعار.",
        "Could not load tools and pricing.",
      ),
      code: "SERVER_ERROR",
    });
  }
}
