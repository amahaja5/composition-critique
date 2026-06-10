import { readFile, writeFile } from "node:fs/promises";

let sharpModule = null;
let sharpFailed = false;
let canvasModule = null;
let canvasFailed = false;

export async function readPngPixels(file) {
  const sharp = await loadSharp();
  if (sharp) {
    const { data, info } = await sharp(file)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      data,
      height: info.height,
      width: info.width,
    };
  }

  const { createCanvas, loadImage } = await loadCanvas();
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, image.width, image.height);
  return {
    data: imageData.data,
    height: image.height,
    width: image.width,
  };
}

export async function readPngDataUrlAndSize(file) {
  const bytes = await readFile(file);
  const sharp = await loadSharp();
  if (sharp) {
    const metadata = await sharp(bytes).metadata();
    return {
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      height: metadata.height ?? null,
      width: metadata.width ?? null,
    };
  }

  const { loadImage } = await loadCanvas();
  const image = await loadImage(file);
  return {
    dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
    height: image.height,
    width: image.width,
  };
}

export async function writeSheetPng({ file, geometry, outFile, page }) {
  const sharp = await loadSharp();
  if (sharp) {
    const metadata = await sharp(file).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const overlay = Buffer.from(buildOverlaySvg({ geometry, height, page, width }));
    await sharp(file)
      .composite([{ input: overlay, top: 0, left: 0 }])
      .png()
      .toFile(outFile);
    return;
  }

  const { createCanvas, loadImage } = await loadCanvas();
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  drawOverlay(context, {
    geometry,
    height: image.height,
    page,
    width: image.width,
  });
  await writeFile(outFile, canvas.toBuffer("image/png"));
}

async function loadSharp() {
  if (sharpFailed) return null;
  if (sharpModule) return sharpModule;
  try {
    const imported = await import("sharp");
    sharpModule = imported.default;
    return sharpModule;
  } catch (error) {
    sharpFailed = true;
    console.warn(
      `[eval] sharp unavailable (${error.message.split("\n")[0]}). Falling back to @napi-rs/canvas.`,
    );
    return null;
  }
}

async function loadCanvas() {
  if (canvasFailed) {
    throw new Error("No PNG backend is available. Install working sharp or @napi-rs/canvas native dependencies.");
  }
  if (canvasModule) return canvasModule;
  try {
    canvasModule = await import("@napi-rs/canvas");
    return canvasModule;
  } catch (error) {
    canvasFailed = true;
    throw new Error(
      `No PNG backend is available. sharp failed and @napi-rs/canvas failed: ${error.message.split("\n")[0]}`,
    );
  }
}

function drawOverlay(context, { geometry, page }) {
  const systemColor = "#246b5f";
  const measureColor = "#a85a24";
  context.save();
  context.font = "700 18px Arial";
  context.fillStyle = systemColor;
  context.fillText(page.pageId, 12, 24);

  for (const system of geometry.systems) {
    const x = Math.max(0, system.xLeft);
    const y = Math.max(0, system.yTop);
    const width = Math.max(1, system.xRight - system.xLeft);
    const height = Math.max(1, system.yBottom - system.yTop);
    context.fillStyle = "rgba(36, 107, 95, 0.06)";
    context.strokeStyle = systemColor;
    context.lineWidth = 3;
    context.fillRect(x, y, width, height);
    context.strokeRect(x, y, width, height);

    const labelX = Math.max(0, x - 54);
    context.fillStyle = systemColor;
    roundRect(context, labelX, y, 48, 32, 8);
    context.fill();
    context.fillStyle = "#ffffff";
    context.font = "700 20px Arial";
    context.fillText(`S${system.index}`, labelX + 9, y + 23);

    for (const measure of system.measures ?? []) {
      context.save();
      context.strokeStyle = measureColor;
      context.lineWidth = 2;
      context.setLineDash([8, 6]);
      context.beginPath();
      context.moveTo(measure.xLeft, y);
      context.lineTo(measure.xLeft, system.yBottom);
      context.stroke();
      context.restore();
      context.fillStyle = measureColor;
      context.font = "700 15px Arial";
      context.fillText(`m${measure.index}`, measure.xLeft + 4, Math.max(18, y - 8));
    }
  }
  context.restore();
}

function buildOverlaySvg({ geometry, height, page, width }) {
  const systemColor = "#246b5f";
  const measureColor = "#a85a24";
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<text x="12" y="24" fill="${systemColor}" font-family="Arial, sans-serif" font-size="18" font-weight="700">${escapeXml(page.pageId)}</text>`,
  ];

  for (const system of geometry.systems) {
    const x = Math.max(0, system.xLeft);
    const y = Math.max(0, system.yTop);
    const rectWidth = Math.max(1, system.xRight - system.xLeft);
    const rectHeight = Math.max(1, system.yBottom - system.yTop);
    const labelX = Math.max(0, x - 54);
    lines.push(
      `<rect x="${x}" y="${y}" width="${rectWidth}" height="${rectHeight}" fill="rgba(36,107,95,0.06)" stroke="${systemColor}" stroke-width="3"/>`,
      `<rect x="${labelX}" y="${y}" width="48" height="32" rx="8" fill="${systemColor}"/>`,
      `<text x="${labelX + 9}" y="${y + 23}" fill="#fff" font-family="Arial, sans-serif" font-size="20" font-weight="700">S${system.index}</text>`,
    );

    for (const measure of system.measures ?? []) {
      lines.push(
        `<line x1="${measure.xLeft}" y1="${y}" x2="${measure.xLeft}" y2="${system.yBottom}" stroke="${measureColor}" stroke-width="2" stroke-dasharray="8 6"/>`,
        `<text x="${measure.xLeft + 4}" y="${Math.max(18, y - 8)}" fill="${measureColor}" font-family="Arial, sans-serif" font-size="15" font-weight="700">m${measure.index}</text>`,
      );
    }
  }

  lines.push("</svg>");
  return lines.join("");
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
