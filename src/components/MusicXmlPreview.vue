<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";

const props = defineProps({
    fileName: {
        type: String,
        default: "MusicXML preview",
    },
    isCompressed: {
        type: Boolean,
        default: false,
    },
    musicXml: {
        type: String,
        default: "",
    },
    musicXmlBuffer: {
        type: Object,
        default: null,
    },
});

const container = ref(null);
const toolkit = shallowRef(null);
const ready = ref(false);
const status = ref("Loading score renderer.");
const error = ref("");

let renderToken = 0;

onMounted(async () => {
    try {
        const [{ default: createVerovioModule }, { VerovioToolkit }] =
            await Promise.all([import("verovio/wasm"), import("verovio/esm")]);
        const verovioModule = await createVerovioModule();
        toolkit.value = new VerovioToolkit(verovioModule);
        toolkit.value.setOptions({
            adjustPageHeight: true,
            breaks: "auto",
            pageWidth: 2100,
            scale: 40,
        });
        ready.value = true;
        await renderScore();
    } catch (renderError) {
        status.value = "";
        error.value =
            renderError instanceof Error
                ? renderError.message
                : "Unable to load the score renderer.";
    }
});

onBeforeUnmount(() => {
    renderToken += 1;
    if (container.value) {
        container.value.innerHTML = "";
    }
    toolkit.value = null;
});

watch(
    () => [props.musicXml, props.musicXmlBuffer, props.isCompressed],
    () => {
        renderScore();
    },
    { flush: "post" },
);

async function renderScore() {
    const currentToken = ++renderToken;
    await nextTick();

    if (!ready.value || !toolkit.value || !container.value) {
        return;
    }

    const hasSource = props.isCompressed
        ? props.musicXmlBuffer instanceof ArrayBuffer
        : Boolean(props.musicXml);

    if (!hasSource) {
        container.value.innerHTML = "";
        status.value = "No MusicXML preview source is available.";
        return;
    }

    status.value = "Rendering score preview.";
    error.value = "";

    try {
        const loaded = props.isCompressed
            ? toolkit.value.loadZipDataBuffer(props.musicXmlBuffer)
            : toolkit.value.loadData(props.musicXml);

        if (!loaded) {
            throw new Error("Verovio could not read this MusicXML file.");
        }

        const pageCount = toolkit.value.getPageCount();
        if (!pageCount) {
            throw new Error("No score pages were produced for this MusicXML file.");
        }

        const pages = [];
        for (let page = 1; page <= pageCount; page += 1) {
            pages.push(
                `<div class="musicxml-preview__page">${toolkit.value.renderToSVG(
                    page,
                    false,
                )}</div>`,
            );
        }

        if (currentToken !== renderToken) {
            return;
        }

        container.value.innerHTML = pages.join("");
        status.value = "";
    } catch (renderError) {
        if (currentToken !== renderToken) {
            return;
        }

        container.value.innerHTML = "";
        status.value = "";
        error.value =
            renderError instanceof Error
                ? renderError.message
                : "Unable to render this MusicXML file.";
    }
}
</script>

<template>
    <article class="musicxml-preview" aria-live="polite">
        <div class="musicxml-preview__header">
            <div>
                <p class="musicxml-preview__eyebrow">Score preview</p>
                <h3>{{ fileName }}</h3>
            </div>
            <span class="musicxml-preview__status">
                {{ status || "Rendered" }}
            </span>
        </div>

        <p v-if="error" class="musicxml-preview__error">{{ error }}</p>
        <p v-else-if="status" class="musicxml-preview__message">{{ status }}</p>
        <div ref="container" class="musicxml-preview__surface" />
    </article>
</template>

<style scoped>
.musicxml-preview {
    display: grid;
    gap: 12px;
    border: 1px solid #b7d6c8;
    border-radius: 8px;
    padding: 14px;
    background: #ffffff;
}

.musicxml-preview__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
}

.musicxml-preview__eyebrow,
.musicxml-preview h3,
.musicxml-preview__message,
.musicxml-preview__error {
    margin: 0;
}

.musicxml-preview__eyebrow {
    color: #9b5d2a;
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.musicxml-preview h3 {
    margin-top: 4px;
    font-size: 1rem;
    letter-spacing: 0;
    overflow-wrap: anywhere;
}

.musicxml-preview__status {
    border: 1px solid #dce2dd;
    border-radius: 999px;
    padding: 5px 10px;
    color: #667069;
    background: #f7f7f4;
    font-size: 0.8rem;
    font-weight: 700;
    white-space: nowrap;
}

.musicxml-preview__message {
    color: #667069;
    line-height: 1.5;
}

.musicxml-preview__error {
    color: #a63d3d;
    line-height: 1.5;
}

.musicxml-preview__surface {
    max-height: min(680px, calc(100svh - 260px));
    overflow: auto;
    border: 1px solid #dce2dd;
    border-radius: 8px;
    padding: 12px;
    background: #f7f7f4;
}

.musicxml-preview__surface:empty {
    display: none;
}

:deep(.musicxml-preview__page) {
    min-width: 640px;
    margin: 0 auto 14px;
    overflow: hidden;
    border: 1px solid #dce2dd;
    border-radius: 6px;
    background: #ffffff;
}

:deep(.musicxml-preview__page:last-child) {
    margin-bottom: 0;
}

:deep(svg) {
    display: block;
    width: 100%;
    height: auto;
}

@media (max-width: 720px) {
    .musicxml-preview__header {
        flex-direction: column;
    }

    :deep(.musicxml-preview__page) {
        min-width: 520px;
    }
}
</style>
