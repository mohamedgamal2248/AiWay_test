// Starting points for the Pi App Builder. The user picks one in the UI (templateId); the
// blueprint is appended to the agent's system prompt so the generated project has a
// consistent, reviewed structure that the agent then adapts. Blueprints only describe
// structure and behaviour: they never contain secrets and every Pi payment step runs on the
// app's own server (approve/complete), never in the browser.
const PAYMENTS = `Payments: Pi.createPayment on the client, then POST the paymentId to the app's server endpoints server/approve.js and server/complete.js (Node, fetch to https://api.minepi.com/v2/payments/{id}/approve|complete with "Authorization: Key " + process.env.PI_API_KEY). Verify amount and metadata before approving; make complete idempotent; handle onIncompletePaymentFound.`;

export const TEMPLATES = Object.freeze({
  shop: {
    name_en: "Shop with Pi checkout",
    name_ar: "متجر بدفع Pi",
    description_en:
      "Catalog, cart and Pi checkout for physical or digital products.",
    description_ar: "كتالوج وسلة ودفع Pi لمنتجات مادية أو رقمية.",
    example_en: "A small shop that sells hand-made stickers.",
    example_ar: "متجر صغير يبيع ملصقات مصنوعة يدويًا.",
    blueprint: `Files: index.html (catalog grid), cart.html, orders.html, css/style.css, js/app.js (catalog, cart in localStorage, Pi sign-in), js/pi.js (Pi.init/authenticate/createPayment wrapper), data/products.json (6-8 sample products with price in Pi), server/approve.js, server/complete.js, privacy-policy.html, terms.html, README.md.
Behaviour: product cards with image placeholder (SVG), quantity stepper, cart drawer with total in Pi, "Pay with Pi" button, order confirmation page. ${PAYMENTS}`,
  },
  donations: {
    name_en: "Donation campaign",
    name_ar: "حملة تبرعات",
    description_en:
      "A campaign page with goal progress and one-tap Pi donations.",
    description_ar: "صفحة حملة بشريط تقدم وتبرع Pi بنقرة.",
    example_en: "A campaign to fund a school library.",
    example_ar: "حملة لتمويل مكتبة مدرسة.",
    blueprint: `Files: index.html (story, goal progress bar, preset amounts 1/5/10/custom Pi, recent supporters), thanks.html, css/style.css, js/app.js, js/pi.js, server/approve.js, server/complete.js (also appends the donation to data/donations.json or the app's database), privacy-policy.html, terms.html, README.md.
Behaviour: goal and raised amount read from the server (GET /api/stats), amount validation (min 0.1 Pi), optional anonymous donation, share button. ${PAYMENTS}`,
  },
  loyalty: {
    name_en: "Loyalty card",
    name_ar: "بطاقة ولاء",
    description_en:
      "Digital punch-card with Pi sign-in for cafes and small shops.",
    description_ar: "بطاقة ختم رقمية بتسجيل دخول Pi للمقاهي والمحلات.",
    example_en: "A loyalty card for a coffee shop: 8 stamps give a free drink.",
    example_ar: "بطاقة ولاء لمقهى: 8 أختام تعطي مشروبًا مجانيًا.",
    blueprint: `Files: index.html (my card with stamps), staff.html (staff PIN screen to add a stamp by scanning/typing the customer's Pi username), css/style.css, js/app.js, js/pi.js, server/verify.js (verifies the Pi access token with GET https://api.minepi.com/v2/me), server/stamps.js (add/redeem stamp, rate limited), privacy-policy.html, terms.html, README.md.
Behaviour: Pi.authenticate(["username"]) and server-side token verification; stamps stored server-side per Pi uid; reward screen at N stamps; no payment is required.`,
  },
  quiz: {
    name_en: "Quiz / trivia",
    name_ar: "مسابقة أسئلة",
    description_en: "Timed quiz with score, leaderboard and share card.",
    description_ar: "مسابقة بتوقيت ونتيجة ولوحة صدارة وبطاقة مشاركة.",
    example_en: "A 10-question trivia quiz about Pi Network and crypto basics.",
    example_ar: "مسابقة من 10 أسئلة عن شبكة Pi وأساسيات العملات الرقمية.",
    blueprint: `Files: index.html (start), play.html (one question at a time with countdown), result.html (score, share card), leaderboard.html, css/style.css, js/app.js, js/quiz.js, data/questions.json (10-12 questions with 4 options and an explanation), server/score.js (validates score server-side), privacy-policy.html, terms.html, README.md.
Behaviour: Pi sign-in for the leaderboard name, keyboard and touch friendly, accessible countdown, no payments required (optionally a Pi "tip the creator" button using the payment flow).`,
  },
  booking: {
    name_en: "Appointment booking",
    name_ar: "حجز مواعيد",
    description_en: "Time-slot booking with an optional Pi deposit.",
    description_ar: "حجز مواعيد بفتحات زمنية مع عربون اختياري بـ Pi.",
    example_en: "Booking for a barber shop with a 1 Pi deposit.",
    example_ar: "حجز لصالون حلاقة بعربون 1 Pi.",
    blueprint: `Files: index.html (services and date picker), slots.html (available time slots), confirm.html, my-bookings.html, css/style.css, js/app.js, js/calendar.js, js/pi.js, server/slots.js (availability, prevents double booking), server/book.js, server/approve.js, server/complete.js (deposit), privacy-policy.html, terms.html, README.md.
Behaviour: slots are locked for 10 minutes while paying; cancellation rules text; ${PAYMENTS}`,
  },
  paywall: {
    name_en: "Digital product / paywall",
    name_ar: "منتج رقمي / محتوى مدفوع",
    description_en:
      "Sell a guide, template or file; unlock the download after payment.",
    description_ar: "بيع دليل أو قالب أو ملف؛ يتم فتح التنزيل بعد الدفع.",
    example_en: "Sell a PDF guide about starting a small business.",
    example_ar: "بيع دليل PDF عن بدء مشروع صغير.",
    blueprint: `Files: index.html (product page with preview and price in Pi), success.html (download link), css/style.css, js/app.js, js/pi.js, server/approve.js, server/complete.js (marks the purchase), server/download.js (signed, expiring download link bound to the Pi uid), privacy-policy.html, terms.html, README.md.
Behaviour: no download URL is ever exposed before server-side payment completion; refund/contact text; ${PAYMENTS}`,
  },
});

export const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));

export function templateBlueprint(id) {
  const t = TEMPLATES[String(id || "")];
  return t ? t.blueprint : "";
}

// Public catalog sent to the browser (no blueprints: those stay server-side).
export function templateCatalog() {
  return TEMPLATE_IDS.map((id) => {
    const t = TEMPLATES[id];
    return {
      id,
      name_en: t.name_en,
      name_ar: t.name_ar,
      description_en: t.description_en,
      description_ar: t.description_ar,
      example_en: t.example_en,
      example_ar: t.example_ar,
    };
  });
}
