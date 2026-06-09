export function normalizedToDisplay(rect, displaySize) {
    const normalized = normalizeRect(rect);
    const width = positiveNumber(displaySize?.width);
    const height = positiveNumber(displaySize?.height);

    return {
        height: normalized.height * height,
        width: normalized.width * width,
        x: normalized.x * width,
        y: normalized.y * height,
    };
}

export function displayToNormalized(rect, displaySize) {
    const width = positiveNumber(displaySize?.width);
    const height = positiveNumber(displaySize?.height);

    return clampRect({
        height: safeNumber(rect?.height) / height,
        width: safeNumber(rect?.width) / width,
        x: safeNumber(rect?.x) / width,
        y: safeNumber(rect?.y) / height,
    });
}

export function normalizedToPdfPoints(rect, pdfSize) {
    const normalized = normalizeRect(rect);
    const width = positiveNumber(pdfSize?.width);
    const height = positiveNumber(pdfSize?.height);
    const x = normalized.x * width;
    const rectHeight = normalized.height * height;
    const yFromTop = normalized.y * height;

    return {
        height: rectHeight,
        width: normalized.width * width,
        x,
        y: height - yFromTop - rectHeight,
    };
}

export function normalizeRect(rect) {
    return clampRect({
        height: safeNumber(rect?.height ?? rect?.h),
        width: safeNumber(rect?.width ?? rect?.w),
        x: safeNumber(rect?.x),
        y: safeNumber(rect?.y),
    });
}

export function clampRect(rect) {
    const x = clamp01(rect.x);
    const y = clamp01(rect.y);
    const width = Math.min(clamp01(rect.width), 1 - x);
    const height = Math.min(clamp01(rect.height), 1 - y);

    return { height, width, x, y };
}

function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 1;
}

function safeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function clamp01(value) {
    return Math.min(1, Math.max(0, safeNumber(value)));
}
