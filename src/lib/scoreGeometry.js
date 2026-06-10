import { displayToNormalized, normalizeRect } from "./coords.js";

const DARK_THRESHOLD = 205;

export function detectScoreGeometry(canvas) {
    const context = canvas?.getContext?.("2d", { willReadFrequently: true });
    const width = canvas?.width ?? 0;
    const height = canvas?.height ?? 0;

    if (!context || width <= 0 || height <= 0) {
        return emptyGeometry(width, height);
    }

    const imageData = context.getImageData(0, 0, width, height);
    return detectScoreGeometryFromPixels({
        data: imageData.data,
        height,
        width,
    });
}

export function detectScoreGeometryFromPixels({ data, height, width }) {
    if (!data || width <= 0 || height <= 0) {
        return emptyGeometry(width, height);
    }

    const imageData = { data };
    const { rowCounts } = buildInkProfiles(imageData, width, height);
    const staffLines = detectStaffLines(rowCounts, width);
    const staves = detectStaves(staffLines);
    const systems = groupStavesIntoSystems(staves, height).map((system, index) =>
        addMeasuresToSystem(system, index + 1, imageData, width, height),
    );

    return {
        height,
        staffLines,
        staves,
        systems,
        width,
    };
}

export function snapFindingToGeometry(finding, geometry) {
    const width = geometry?.width ?? 0;
    const height = geometry?.height ?? 0;
    const systems = Array.isArray(geometry?.systems) ? geometry.systems : [];
    const systemNumber = positiveInt(
        finding?.system_number ?? parseOrdinal(finding?.location_label, /system\s*(\d+)/i),
    );

    if (!systemNumber || !systems[systemNumber - 1] || width <= 0 || height <= 0) {
        return {
            reason: "system_not_detected",
            rect: null,
            systemNumber,
            unlocalized: true,
        };
    }

    const system = systems[systemNumber - 1];
    const measureNumber = positiveInt(
        finding?.measure_number ??
            parseOrdinal(finding?.location_label, /(?:measure|m\.)\s*(\d+)/i),
    );
    const staff = pickStaff(system, finding?.staff_label);
    const measure =
        measureNumber && Array.isArray(system.measures)
            ? system.measures.find((item) => item.index === measureNumber)
            : null;
    const systemStaffRect = {
        x: system.xLeft,
        y: staff?.yTop ?? system.yTop,
        width: system.xRight - system.xLeft,
        height: (staff?.yBottom ?? system.yBottom) - (staff?.yTop ?? system.yTop),
    };

    let pixelRect = {
        x: measure?.xLeft ?? system.xLeft,
        y: staff?.yTop ?? system.yTop,
        width: (measure?.xRight ?? system.xRight) - (measure?.xLeft ?? system.xLeft),
        height: (staff?.yBottom ?? system.yBottom) - (staff?.yTop ?? system.yTop),
    };

    pixelRect = applyBBoxHint(pixelRect, finding?.bbox_hint, width, height, systemStaffRect);
    pixelRect = applyTextPositionHint(pixelRect, finding, systemStaffRect);

    return {
        measureNumber,
        rect: displayToNormalized(pixelRect, { height, width }),
        staffIndex: staff?.index ?? null,
        systemNumber,
        unlocalized: false,
    };
}

function buildInkProfiles(imageData, width, height) {
    const rowCounts = new Array(height).fill(0);
    const data = imageData.data;

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * 4;
            const alpha = data[offset + 3];
            if (alpha < 24) continue;

            const red = data[offset];
            const green = data[offset + 1];
            const blue = data[offset + 2];
            const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
            if (luminance < DARK_THRESHOLD) {
                rowCounts[y] += 1;
            }
        }
    }

    return { rowCounts };
}

function detectStaffLines(rowCounts, width) {
    const maxRowInk = Math.max(...rowCounts, 0);
    if (!maxRowInk) return [];

    const threshold = Math.max(width * 0.07, maxRowInk * 0.34);
    const clusters = [];
    let active = null;

    rowCounts.forEach((count, y) => {
        if (count >= threshold) {
            if (!active) {
                active = { count: 0, end: y, peak: count, start: y, weighted: 0 };
            }
            active.end = y;
            active.count += count;
            active.peak = Math.max(active.peak, count);
            active.weighted += y * count;
        } else if (active) {
            clusters.push(active);
            active = null;
        }
    });

    if (active) clusters.push(active);

    return clusters
        .map((cluster) => ({
            center: cluster.count ? cluster.weighted / cluster.count : (cluster.start + cluster.end) / 2,
            end: cluster.end,
            peak: cluster.peak,
            start: cluster.start,
        }))
        .filter((line) => line.end - line.start <= 8);
}

function detectStaves(staffLines) {
    const staves = [];
    let index = 0;

    while (index <= staffLines.length - 5) {
        const candidate = staffLines.slice(index, index + 5);
        const spacings = [];
        for (let offset = 0; offset < 4; offset += 1) {
            spacings.push(candidate[offset + 1].center - candidate[offset].center);
        }
        const medianSpacing = median(spacings);
        const isRegular =
            medianSpacing >= 3 &&
            medianSpacing <= 34 &&
            spacings.every((spacing) => Math.abs(spacing - medianSpacing) <= medianSpacing * 0.42);

        if (isRegular) {
            const topLine = candidate[0].center;
            const bottomLine = candidate[4].center;
            staves.push({
                bottomLine,
                index: staves.length + 1,
                lineSpacing: medianSpacing,
                lines: candidate,
                yBottom: bottomLine + medianSpacing * 0.8,
                yTop: topLine - medianSpacing * 0.8,
            });
            index += 5;
        } else {
            index += 1;
        }
    }

    return staves;
}

function groupStavesIntoSystems(staves, pageHeight) {
    if (!staves.length) return [];

    const staffHeights = staves.map((staff) => staff.bottomLine - staff.topLine);
    const medianStaffHeight = median(staffHeights) || 24;
    const systems = [];
    let current = [staves[0]];

    for (let index = 1; index < staves.length; index += 1) {
        const previous = current[current.length - 1];
        const next = staves[index];
        const gap = next.yTop - previous.yBottom;
        if (gap <= medianStaffHeight * 4.5) {
            current.push(next);
        } else {
            systems.push(buildSystem(current, systems.length + 1, pageHeight));
            current = [next];
        }
    }

    systems.push(buildSystem(current, systems.length + 1, pageHeight));
    return systems;
}

function buildSystem(staves, index, pageHeight) {
    const staffHeight = median(staves.map((staff) => staff.bottomLine - staff.topLine)) || 24;
    return {
        index,
        staves: staves.map((staff, staffIndex) => ({ ...staff, index: staffIndex + 1 })),
        xLeft: 0,
        xRight: 1,
        yBottom: Math.min(pageHeight, Math.max(...staves.map((staff) => staff.yBottom)) + staffHeight * 1.8),
        yTop: Math.max(0, Math.min(...staves.map((staff) => staff.yTop)) - staffHeight * 1.8),
    };
}

function addMeasuresToSystem(system, index, imageData, width, height) {
    const yTop = Math.max(0, Math.floor(Math.min(...system.staves.map((staff) => staff.yTop))));
    const yBottom = Math.min(height - 1, Math.ceil(Math.max(...system.staves.map((staff) => staff.yBottom))));
    const xRange = detectSystemXRange(imageData, width, yTop, yBottom);
    const barlines = detectBarlines(imageData, width, yTop, yBottom, xRange);
    const measures = buildMeasuresFromBarlines(barlines, xRange, width);

    return {
        ...system,
        index,
        measures,
        xLeft: xRange.xLeft,
        xRight: xRange.xRight,
    };
}

function detectSystemXRange(imageData, width, yTop, yBottom) {
    const columnCounts = new Array(width).fill(0);
    const threshold = Math.max(3, (yBottom - yTop) * 0.025);
    let xLeft = 0;
    let xRight = width;

    for (let x = 0; x < width; x += 1) {
        for (let y = yTop; y <= yBottom; y += 1) {
            if (isDarkPixel(imageData, width, x, y)) {
                columnCounts[x] += 1;
            }
        }
    }

    for (let x = 0; x < width; x += 1) {
        if (columnCounts[x] >= threshold) {
            xLeft = Math.max(0, x - 8);
            break;
        }
    }

    for (let x = width - 1; x >= 0; x -= 1) {
        if (columnCounts[x] >= threshold) {
            xRight = Math.min(width, x + 8);
            break;
        }
    }

    return xRight - xLeft > 24 ? { xLeft, xRight } : { xLeft: 0, xRight: width };
}

function detectBarlines(imageData, width, yTop, yBottom, xRange) {
    const height = yBottom - yTop + 1;
    const candidates = [];

    for (let x = Math.floor(xRange.xLeft); x < Math.ceil(xRange.xRight); x += 1) {
        let darkCount = 0;
        let firstDark = null;
        let lastDark = null;

        for (let y = yTop; y <= yBottom; y += 1) {
            if (isDarkPixel(imageData, width, x, y)) {
                darkCount += 1;
                firstDark ??= y;
                lastDark = y;
            }
        }

        const span = firstDark === null ? 0 : lastDark - firstDark + 1;
        if (darkCount >= height * 0.34 && span >= height * 0.62) {
            candidates.push(x);
        }
    }

    return clusterColumns(candidates)
        .filter((cluster) => cluster.width <= 10)
        .map((cluster) => cluster.center);
}

function buildMeasuresFromBarlines(barlines, xRange, pageWidth) {
    const boundaries = [xRange.xLeft, ...barlines, xRange.xRight]
        .sort((a, b) => a - b)
        .filter((value, index, values) => index === 0 || value - values[index - 1] > 12);

    if (boundaries.length < 3) return null;

    const measures = [];
    for (let index = 0; index < boundaries.length - 1; index += 1) {
        const xLeft = Math.max(0, boundaries[index]);
        const xRight = Math.min(pageWidth, boundaries[index + 1]);
        if (xRight - xLeft < 18) continue;
        measures.push({
            index: measures.length + 1,
            xLeft,
            xRight,
        });
    }

    return measures.length >= 2 ? measures : null;
}

function clusterColumns(columns) {
    if (!columns.length) return [];
    const clusters = [];
    let start = columns[0];
    let end = columns[0];

    for (let index = 1; index < columns.length; index += 1) {
        const column = columns[index];
        if (column - end <= 2) {
            end = column;
        } else {
            clusters.push({ center: (start + end) / 2, width: end - start + 1 });
            start = column;
            end = column;
        }
    }

    clusters.push({ center: (start + end) / 2, width: end - start + 1 });
    return clusters;
}

function isDarkPixel(imageData, width, x, y) {
    const offset = (y * width + x) * 4;
    const data = imageData.data;
    const alpha = data[offset + 3];
    if (alpha < 24) return false;
    const luminance = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
    return luminance < DARK_THRESHOLD;
}

function pickStaff(system, staffLabel) {
    const label = String(staffLabel ?? "").toLowerCase();
    const staffNumber = positiveInt(parseOrdinal(label, /staff\s*(\d+)/i));
    if (staffNumber && system.staves[staffNumber - 1]) return system.staves[staffNumber - 1];
    if (label.includes("violin") && system.staves[0]) return system.staves[0];
    if (label.includes("guitar") && system.staves[1]) return system.staves[1];
    if ((label.includes("treble") || label.includes("right hand")) && system.staves[0]) {
        return system.staves[0];
    }
    if ((label.includes("bass") || label.includes("left hand")) && system.staves[1]) {
        return system.staves[1];
    }
    return null;
}

function applyBBoxHint(pixelRect, bboxHint, width, height, guardRect = pixelRect) {
    const hint = normalizeBBoxHint(bboxHint);
    if (!hint) return pixelRect;

    const hintRect = {
        height: hint.height * height,
        width: hint.width * width,
        x: hint.x * width,
        y: hint.y * height,
    };
    const centerX = hintRect.x + hintRect.width / 2;
    const centerY = hintRect.y + hintRect.height / 2;
    const inside =
        centerX >= guardRect.x &&
        centerX <= guardRect.x + guardRect.width &&
        centerY >= guardRect.y &&
        centerY <= guardRect.y + guardRect.height;

    if (!inside) return pixelRect;

    const paddingX = Math.max(guardRect.width * 0.035, 16);
    const paddingY = Math.max(guardRect.height * 0.12, 10);
    const x = Math.max(guardRect.x, hintRect.x - paddingX);
    const y = Math.max(guardRect.y, hintRect.y - paddingY);
    const xRight = Math.min(guardRect.x + guardRect.width, hintRect.x + hintRect.width + paddingX);
    const yBottom = Math.min(guardRect.y + guardRect.height, hintRect.y + hintRect.height + paddingY);

    return {
        height: Math.max(12, yBottom - y),
        width: Math.max(18, xRight - x),
        x,
        y,
    };
}

function applyTextPositionHint(pixelRect, finding, guardRect) {
    if (!guardRect || guardRect.width <= 0 || guardRect.height <= 0) return pixelRect;
    const text = [
        finding?.location_label,
        finding?.evidence,
        finding?.recommendation,
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    if (!text) return pixelRect;

    const hasRightHint = /\b(right edge|end of (?:the )?(?:system|line)|line end|right side)\b/.test(text);
    const hasLeftHint = /\b(left edge|start of (?:the )?(?:system|line)|line start|left side)\b/.test(text);
    if (!hasRightHint && !hasLeftHint) return pixelRect;

    const width = Math.max(Math.min(pixelRect.width, guardRect.width * 0.2), 22);
    return {
        height: pixelRect.height,
        width,
        x: hasRightHint ? guardRect.x + guardRect.width - width : guardRect.x,
        y: pixelRect.y,
    };
}

function normalizeBBoxHint(value) {
    if (Array.isArray(value) && value.length === 4) {
        return normalizeRect({
            height: value[3],
            width: value[2],
            x: value[0],
            y: value[1],
        });
    }

    if (value && typeof value === "object") {
        return normalizeRect(value);
    }

    return null;
}

function parseOrdinal(value, pattern) {
    const match = String(value ?? "").match(pattern);
    return match ? match[1] : null;
}

function positiveInt(value) {
    const number = Number.parseInt(value ?? "", 10);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function median(values) {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const midpoint = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[midpoint]
        : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function emptyGeometry(width, height) {
    return {
        height,
        staffLines: [],
        staves: [],
        systems: [],
        width,
    };
}
