import { cleanText } from "../../core/http.js";

// Turns request attachments into model input. Plain chat and the builder/image agents
// embed text files inline (bounded by the request size limit) and pass images/PDF as
// native parts. The General Agent overrides this with stored files + compact manifests
// (see files/ingest.js) so large documents never fill the context window.
export async function prepareAgentAttachments(options) {
  if (options.agent?.id === "general-agent") {
    const { ingestAttachments } = await import("./files/ingest.js");
    return ingestAttachments(options);
  }
  return inlineAttachments(options);
}

export function inlineAttachments({ attachments, baseText }) {
  const textFiles = attachments.filter((a) => typeof a.text === "string");
  const richFiles = attachments.filter((a) => typeof a.text !== "string");
  const payload = textFiles
    .map(
      (a) =>
        `\n\n--- ATTACHED FILE: ${cleanText(a.name, 150)} ---\n${a.text}\n--- END FILE: ${cleanText(a.name, 150)} ---`,
    )
    .join("");
  return {
    text: baseText + payload,
    richParts: richFiles.map((a) =>
      a.type.startsWith("image/")
        ? { type: "image_url", image_url: { url: a.dataUrl } }
        : {
            type: "file",
            file: {
              filename: cleanText(a.name, 150),
              file_data: a.dataUrl,
            },
          },
    ),
    storedFiles: [],
  };
}
