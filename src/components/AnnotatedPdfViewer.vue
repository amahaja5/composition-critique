<script setup>
import { computed, markRaw, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { detectScoreGeometry, snapFindingToGeometry } from "../lib/scoreGeometry.js";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const props = defineProps({
    assets: {
        default: () => [],
        type: Array,
    },
    debugGeometry: {
        default: false,
        type: Boolean,
    },
    findings: {
        default: () => [],
        type: Array,
    },
    reviewStatus: {
        default: "idle",
        type: String,
    },
});

const viewerRoot = ref(null);
const pages = ref([]);
const activeFindingId = ref("");
const loadingMessage = ref("");
const canvasRefs = new Map();
const pageShellRefs = new Map();
const pdfDocuments = [];

let resizeObserver = null;
let renderSerial = 0;
let resizeTimer = null;
let initialRenderInProgress = false;

const flattenedFindings = computed(() =>
    props.findings.flatMap((pageRecord) =>
        (pageRecord.findings ?? []).map((finding, index) => ({
            ...finding,
            __assetFilename: pageRecord.asset_filename ?? finding.asset_filename ?? "",
            __fallbackPage: pageRecord.page ?? finding.page_number ?? null,
            __index: index,
            __sourcePageId: pageRecord.source_page_id ?? finding.source_page_id ?? "",
        })),
    ),
);

const unlocalizedFindings = computed(() =>
    pages.value.flatMap((page) =>
        findingsForPage(page)
            .map((finding) => ({
                finding,
                snapped: page.geometry ? snapFindingToGeometry(finding, page.geometry) : null,
            }))
            .filter((item) => !item.snapped || item.snapped.unlocalized)
            .map((item) => ({
                ...item.finding,
                pageLabel: `Page ${page.pageNumber}`,
            })),
    ),
);

onMounted(() => {
    resizeObserver = new ResizeObserver(() => {
        if (initialRenderInProgress || !pages.value.length) return;
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => renderAllPages(), 120);
    });
    if (viewerRoot.value) {
        resizeObserver.observe(viewerRoot.value);
    }
});

onUnmounted(() => {
    clearTimeout(resizeTimer);
    resizeObserver?.disconnect();
    cleanupPdfDocuments();
});

watch(
    () => props.assets,
    () => loadAssets(),
    { deep: true, immediate: true },
);

watch(
    () => props.findings,
    () => {
        if (!flattenedFindings.value.some((finding) => finding.id === activeFindingId.value)) {
            activeFindingId.value = "";
        }
    },
    { deep: true },
);

function setCanvasRef(key, element) {
    if (element) {
        canvasRefs.set(key, element);
    } else {
        canvasRefs.delete(key);
    }
}

function setPageShellRef(key, element) {
    if (element) {
        pageShellRefs.set(key, element);
    } else {
        pageShellRefs.delete(key);
    }
}

async function loadAssets() {
    const serial = ++renderSerial;
    cleanupPdfDocuments();
    pages.value = [];
    activeFindingId.value = "";

    if (!props.assets.length) {
        loadingMessage.value = "";
        return;
    }

    loadingMessage.value = "Loading score preview.";
    const nextPages = [];

    try {
        for (const asset of props.assets) {
            if (!asset.file && !asset.previewUrl) continue;
            const loadingTask = pdfjs.getDocument(await buildPdfLoadSource(asset));
            const document = markRaw(await loadingTask.promise);
            pdfDocuments.push(document);

            for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
                const pdfPage = markRaw(await document.getPage(pageNumber));
                const viewport = pdfPage.getViewport({ scale: 1 });
                nextPages.push({
                    assetId: asset.id,
                    assetName: asset.name,
                    cssHeight: viewport.height,
                    cssWidth: viewport.width,
                    geometry: null,
                    key: `${asset.id}:${pageNumber}`,
                    pageNumber,
                    pdfPage,
                    renderError: "",
                    renderState: "pending",
                    sourcePageId: `${asset.id}:${pageNumber}`,
                });
            }
        }
    } catch (error) {
        loadingMessage.value =
            error instanceof Error
                ? `Unable to load score preview: ${error.message}`
                : "Unable to load score preview.";
        return;
    }

    if (serial !== renderSerial) return;
    pages.value = nextPages;
    loadingMessage.value = nextPages.length ? "Rendering score pages." : "";
    await nextTick();
    initialRenderInProgress = true;
    try {
        await renderAllPages(serial);
    } finally {
        initialRenderInProgress = false;
    }
    loadingMessage.value = "";
}

async function buildPdfLoadSource(asset) {
    const sharedOptions = {
        disableFontFace: false,
        isEvalSupported: false,
        useSystemFonts: true,
    };

    if (asset.file) {
        return {
            ...sharedOptions,
            data: new Uint8Array(await asset.file.arrayBuffer()),
        };
    }

    return {
        ...sharedOptions,
        url: asset.previewUrl,
    };
}

async function renderAllPages(expectedSerial = null) {
    if (!pages.value.length) return;
    const serial = expectedSerial ?? ++renderSerial;

    for (const page of pages.value) {
        if (serial !== renderSerial) return;
        await renderPage(page);
    }
}

async function renderPage(page) {
    const canvas = canvasRefs.get(page.key);
    const shell = pageShellRefs.get(page.key);
    if (!canvas || !shell || !page.pdfPage) return;

    const baseViewport = page.pdfPage.getViewport({ scale: 1 });
    const availableWidth = Math.max(320, shell.clientWidth || baseViewport.width);
    const cssWidth = Math.min(availableWidth, baseViewport.width * 1.7);
    const cssScale = cssWidth / baseViewport.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.pdfPage.getViewport({ scale: cssScale * dpr });
    const context = canvas.getContext("2d", { willReadFrequently: true });

    page.renderState = "rendering";
    page.renderError = "";
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    page.cssWidth = Math.ceil(viewport.width / dpr);
    page.cssHeight = Math.ceil(viewport.height / dpr);
    canvas.style.width = `${page.cssWidth}px`;
    canvas.style.height = `${page.cssHeight}px`;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    try {
        await page.pdfPage.render({
            background: "white",
            canvas: null,
            canvasContext: context,
            viewport,
        }).promise;

        page.geometry = detectScoreGeometry(canvas);
        page.renderState = "ready";
    } catch (error) {
        page.geometry = null;
        page.renderState = "error";
        page.renderError =
            error instanceof Error ? error.message : "Unable to render this page.";
        console.warn("[pdf-preview] Unable to render page.", {
            error,
            page: page.pageNumber,
            sourcePageId: page.sourcePageId,
        });
    }
}

function findingsForPage(page) {
    return flattenedFindings.value.filter((finding) => {
        if (finding.__sourcePageId && finding.__sourcePageId === page.sourcePageId) {
            return true;
        }
        if (finding.source_page_id && finding.source_page_id === page.sourcePageId) {
            return true;
        }
        return (
            Number(finding.__fallbackPage ?? finding.page_number) === page.pageNumber &&
            (!finding.__assetFilename || finding.__assetFilename === page.assetName)
        );
    });
}

function markersForPage(page) {
    if (!page.geometry) return [];

    return findingsForPage(page)
        .map((finding, index) => {
            const snapped = snapFindingToGeometry(finding, page.geometry);
            if (snapped.unlocalized || !snapped.rect) return null;
            return {
                finding,
                index: index + 1,
                rect: snapped.rect,
                snapped,
            };
        })
        .filter(Boolean);
}

function debugSystems(page) {
    if (!props.debugGeometry || !page.geometry) return [];
    return page.geometry.systems.map((system) => rectToPercent({
        height: (system.yBottom - system.yTop) / page.geometry.height,
        width: (system.xRight - system.xLeft) / page.geometry.width,
        x: system.xLeft / page.geometry.width,
        y: system.yTop / page.geometry.height,
    }));
}

function debugMeasures(page) {
    if (!props.debugGeometry || !page.geometry) return [];
    return page.geometry.systems.flatMap((system) =>
        (system.measures ?? []).map((measure) =>
            rectToPercent({
                height: (system.yBottom - system.yTop) / page.geometry.height,
                width: (measure.xRight - measure.xLeft) / page.geometry.width,
                x: measure.xLeft / page.geometry.width,
                y: system.yTop / page.geometry.height,
            }),
        ),
    );
}

function markerStyle(marker) {
    return rectToPercent(marker.rect);
}

function popoverStyle(marker) {
    const rect = marker.rect;
    const isLeftSide = rect.x < 0.5;
    const isUpperPage = rect.y < 0.68;
    const horizontalGap = 1.4;
    const verticalGap = 1.4;
    const style = {};

    if (isLeftSide) {
        style.left = `${Math.min((rect.x + rect.width) * 100 + horizontalGap, 64)}%`;
    } else {
        style.right = `${Math.min((1 - rect.x) * 100 + horizontalGap, 64)}%`;
    }

    if (isUpperPage) {
        style.top = `${Math.min((rect.y + rect.height) * 100 + verticalGap, 76)}%`;
    } else {
        style.bottom = `${Math.min((1 - rect.y) * 100 + verticalGap, 76)}%`;
    }

    return style;
}

function rectToPercent(rect) {
    return {
        height: `${Math.max(rect.height * 100, 2.4)}%`,
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${Math.max(rect.width * 100, 3)}%`,
    };
}

function findingSeverityClass(finding) {
    const severity = String(finding.severity ?? "").toLowerCase();
    if (severity === "high" || severity === "error") return "finding-marker--error";
    if (severity === "low" || severity === "suggestion") return "finding-marker--suggestion";
    return "finding-marker--warning";
}

function selectFinding(finding) {
    activeFindingId.value =
        activeFindingId.value === finding.id ? "" : finding.id;
}

function activeFindingForPage(page) {
    if (!activeFindingId.value) return null;
    return markersForPage(page).find((marker) => marker.finding.id === activeFindingId.value);
}

function cleanupPdfDocuments() {
    while (pdfDocuments.length) {
        pdfDocuments.pop()?.destroy?.();
    }
}
</script>

<template>
    <section class="annotated-viewer" ref="viewerRoot">
        <p v-if="loadingMessage" class="viewer-status">{{ loadingMessage }}</p>

        <article
            v-for="page in pages"
            :key="page.key"
            class="annotated-page"
            :class="{ 'annotated-page--debug': debugGeometry }"
        >
            <div class="annotated-page__header">
                <span>{{ page.assetName }}</span>
                <strong>Page {{ page.pageNumber }}</strong>
            </div>

            <div
                :ref="(element) => setPageShellRef(page.key, element)"
                class="annotated-page__shell"
            >
                <div
                    class="annotated-page__stage"
                    :style="{
                        height: `${page.cssHeight}px`,
                        width: `${page.cssWidth}px`,
                    }"
                >
                    <canvas
                        :ref="(element) => setCanvasRef(page.key, element)"
                        class="annotated-page__canvas"
                    />

                    <div
                        v-if="page.renderState !== 'ready'"
                        class="page-render-state"
                        :class="{
                            'page-render-state--error':
                                page.renderState === 'error',
                        }"
                    >
                        <strong>
                            {{
                                page.renderState === "error"
                                    ? "Preview failed"
                                    : "Rendering page"
                            }}
                        </strong>
                        <span v-if="page.renderError">{{
                            page.renderError
                        }}</span>
                    </div>

                    <div
                        v-if="debugGeometry && page.renderState === 'ready'"
                        class="geometry-debug-layer"
                        aria-hidden="true"
                    >
                        <span
                            v-for="(system, index) in debugSystems(page)"
                            :key="`system-${index}`"
                            class="geometry-debug geometry-debug--system"
                            :style="system"
                        />
                        <span
                            v-for="(measure, index) in debugMeasures(page)"
                            :key="`measure-${index}`"
                            class="geometry-debug geometry-debug--measure"
                            :style="measure"
                        />
                    </div>

                    <button
                        v-for="marker in markersForPage(page)"
                        :key="marker.finding.id"
                        class="finding-marker"
                        :class="[
                            findingSeverityClass(marker.finding),
                            {
                                'finding-marker--active':
                                    activeFindingId === marker.finding.id,
                            },
                        ]"
                        type="button"
                        :style="markerStyle(marker)"
                        @click="selectFinding(marker.finding)"
                    >
                        <span>{{ marker.index }}</span>
                    </button>

                    <article
                        v-if="activeFindingForPage(page)"
                        class="finding-popover"
                        :style="popoverStyle(activeFindingForPage(page))"
                    >
                        <div class="finding-popover__header">
                            <strong>{{
                                activeFindingForPage(page).finding.rule_id
                            }}</strong>
                            <span>{{
                                activeFindingForPage(page).finding.severity
                            }}</span>
                        </div>
                        <p>
                            {{
                                activeFindingForPage(page).finding.evidence ||
                                activeFindingForPage(page).finding.summary
                            }}
                        </p>
                        <p v-if="activeFindingForPage(page).finding.recommendation">
                            {{
                                activeFindingForPage(page).finding
                                    .recommendation
                            }}
                        </p>
                    </article>
                </div>
            </div>
        </article>

        <section v-if="unlocalizedFindings.length" class="unplaced-findings">
            <div class="section-heading">
                <div>
                    <p class="eyebrow">Unplaced findings</p>
                    <h3>Needs manual placement</h3>
                </div>
                <span class="status-pill">{{ unlocalizedFindings.length }}</span>
            </div>
            <article
                v-for="finding in unlocalizedFindings"
                :key="finding.id"
                class="unplaced-finding"
            >
                <strong>{{ finding.pageLabel }} · {{ finding.rule_id }}</strong>
                <p>{{ finding.evidence }}</p>
            </article>
        </section>
    </section>
</template>
