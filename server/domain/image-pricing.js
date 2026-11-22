import { TOKEN_USD } from "./credits.js";
import { META_PRICING } from "./meta-models.js";

export const IMAGE_UNIT_USD = META_PRICING.image.image;

// Muse Image is a flat per-image price (images blocked by the safety filter are not
// billed upstream), so the estimate is exact and independent of resolution.
export function estimateImageCharge(count = 1) {
  const images = Math.max(1, Math.floor(Number(count) || 1));
  const usd = IMAGE_UNIT_USD * images;
  return {
    providerUsd: usd,
    chargedTokens: Math.max(1, Math.ceil(usd / TOKEN_USD)),
    pricingBasis: "per_image",
    unitPrice: IMAGE_UNIT_USD,
    images,
  };
}
