const PDF_MAX_BYTES = 50 * 1024 * 1024;

export const COMPOSITION_ASSETS_BUCKET = "compositions";

const PDF_EXTENSIONS = [".pdf"];
const PDF_MIME_TYPES = ["application/pdf"];

export const ACCEPTED_UPLOAD_TYPES = [
  ...PDF_EXTENSIONS,
  ...PDF_MIME_TYPES,
].join(",");

export function getAssetType(file) {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();

  if (
    PDF_EXTENSIONS.some((extension) => name.endsWith(extension)) ||
    PDF_MIME_TYPES.includes(type)
  ) {
    return "pdf";
  }

  return "";
}

export function validateCompositionFile(file) {
  const assetType = getAssetType(file);

  if (!assetType) {
    return {
      assetType: "",
      error: "Only PDF files are supported.",
    };
  }

  if (file.size > PDF_MAX_BYTES) {
    return {
      assetType,
      error: `PDF files must be ${formatLimit(PDF_MAX_BYTES)} or smaller.`,
    };
  }

  return {
    assetType,
    error: "",
  };
}

export function safeFilename(filename) {
  return filename.trim().replace(/[^a-zA-Z0-9._-]/g, "_") || "upload";
}

export function buildStoragePath(ownerId, compositionId, assetId, filename) {
  return `user/${ownerId}/compositions/${compositionId}/${assetId}/${filename}`;
}

export function getUploadMimeType() {
  return "application/pdf";
}

export function getUploadBody(file, mimeType) {
  if (file.type.toLowerCase() === mimeType) {
    return file;
  }

  return new Blob([file], { type: mimeType });
}

function formatLimit(bytes) {
  return `${Math.floor(bytes / 1024 / 1024)} MB`;
}
