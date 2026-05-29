<script setup>
import { computed, markRaw, onMounted, onUnmounted, ref } from "vue";
import MusicXmlPreview from "./components/MusicXmlPreview.vue";
import {
    isSupabaseConfigured,
    supabase,
    supabaseConfigMessage,
} from "./lib/supabase";
import {
    ACCEPTED_UPLOAD_TYPES,
    COMPOSITION_ASSETS_BUCKET,
    buildStoragePath,
    getAssetType,
    getUploadMimeType,
    safeFilename,
    validateCompositionFile,
} from "./lib/uploads";

const authReady = ref(false);
const session = ref(null);
const authError = ref("");
const selectedFiles = ref([]);
const uploadStatus = ref("idle");
const uploadMessage = ref("");
const compositionTitle = ref("");
const lastUpload = ref(null);
const reviewStatus = ref("idle");
const reviewMessage = ref("Review will appear here after submission.");
const reviewText = ref("");
const reviewError = ref("");
const reviewId = ref("");
const routePath = ref(normalizePath(window.location.pathname));

let authSubscription = null;
let reviewAbortController = null;

const reviewStreamUrl =
    (import.meta.env.VITE_REVIEW_STREAM_URL ?? "/api/review-stream").trim() ||
    "/api/review-stream";

const legalPages = [
    {
        path: "/terms",
        label: "Terms of Service",
        title: "Terms of Service",
        updated: "May 28, 2026",
        intro: "These Terms of Service govern access to and use of Composition Critique, a web application for uploading composition source materials and related metadata for critique workflows.",
        sections: [
            {
                title: "Eligibility and Accounts",
                body: "You must be able to form a binding agreement to use the service. You are responsible for the activity that occurs under your account and for keeping your sign-in credentials secure.",
            },
            {
                title: "Uploaded Content",
                body: "You retain ownership of PDFs, MusicXML files, metadata, and other materials you upload. You grant Composition Critique a limited license to store, process, display, and transmit that content only as needed to operate and improve the service.",
            },
            {
                title: "Acceptable Use",
                body: "Do not upload content you do not have the right to use, malicious files, illegal material, or content that infringes another person's rights. Do not attempt to bypass access controls, overload the service, or interfere with other users.",
            },
            {
                title: "Service Availability",
                body: "The service may change, pause, or become unavailable from time to time. Features may be modified or discontinued, especially while the product is in development.",
            },
            {
                title: "No Professional Advice",
                body: "Composition Critique may help organize materials and critique workflows, but it does not replace professional legal, music publishing, licensing, or business advice.",
            },
            {
                title: "Termination",
                body: "Access may be suspended or terminated if these terms are violated or if continued access would create legal, security, or operational risk.",
            },
            {
                title: "Disclaimers and Liability",
                body: "The service is provided as is and as available. To the fullest extent permitted by law, Composition Critique disclaims implied warranties and will not be liable for indirect, incidental, special, consequential, or punitive damages.",
            },
            {
                title: "Contact",
                body: "Questions about these terms should be sent to the project owner through the support or contact channel published with the deployed service.",
            },
        ],
    },
    {
        path: "/eula",
        label: "EULA",
        title: "End User License Agreement",
        updated: "May 28, 2026",
        intro: "This End User License Agreement describes the limited rights granted to use the Composition Critique application and related software interface.",
        sections: [
            {
                title: "License Grant",
                body: "Subject to this agreement, you receive a limited, revocable, non-exclusive, non-transferable license to access and use Composition Critique for lawful composition upload and critique workflows.",
            },
            {
                title: "Restrictions",
                body: "You may not copy, modify, reverse engineer, sell, sublicense, rent, or distribute the application except as expressly allowed by law or by written permission from the project owner.",
            },
            {
                title: "Ownership",
                body: "The application, design, code, documentation, and service infrastructure are owned by the project owner or its licensors. This agreement does not transfer ownership of the application to you.",
            },
            {
                title: "Your Materials",
                body: "You retain ownership of the composition materials you upload. The application may store and process your materials only to provide the service and related functionality.",
            },
            {
                title: "Third-Party Services",
                body: "The application may rely on third-party services, including authentication, hosting, storage, and database providers. Your use of those features may also be subject to the third-party provider terms.",
            },
            {
                title: "Updates",
                body: "The application may be updated automatically. Updates may add, change, or remove functionality and may be required for continued access.",
            },
            {
                title: "Termination",
                body: "This license ends if you stop using the service, if your access is terminated, or if you violate this agreement. After termination, you must stop using the application.",
            },
            {
                title: "Disclaimer",
                body: "The application is provided as is without warranties of any kind. To the fullest extent permitted by law, all implied warranties are disclaimed.",
            },
        ],
    },
];

const user = computed(() => session.value?.user ?? null);
const isUploading = computed(() => uploadStatus.value === "uploading");
const hasSelectionErrors = computed(() =>
    selectedFiles.value.some((item) => item.error),
);
const hasSubmittedUpload = computed(
    () => uploadStatus.value === "success" && lastUpload.value?.assets?.length,
);
const musicXmlPreviewAssets = computed(
    () =>
        lastUpload.value?.assets?.filter(
            (asset) => asset.assetType === "musicxml",
        ) ?? [],
);
const reviewPanelTitle = computed(() => {
    if (reviewStatus.value === "complete") return "Review complete";
    if (reviewStatus.value === "error") return "Review interrupted";
    if (reviewStatus.value === "not_configured") return "Review stream not configured";
    if (["connecting", "waiting", "streaming"].includes(reviewStatus.value)) {
        return "Live review";
    }

    return "Review";
});
const reviewStatusLabel = computed(() => {
    const labels = {
        complete: "complete",
        connecting: "connecting",
        error: "error",
        idle: "pending",
        not_configured: "not configured",
        streaming: "streaming",
        waiting: "waiting",
    };

    return labels[reviewStatus.value] ?? reviewStatus.value;
});
const reviewPlaceholder = computed(() => {
    if (reviewStatus.value === "not_configured") {
        return "Add VITE_REVIEW_STREAM_URL or deploy the review stream endpoint.";
    }

    if (reviewStatus.value === "connecting" || reviewStatus.value === "waiting") {
        return "Waiting for released review output.";
    }

    if (reviewStatus.value === "error") {
        return "No review text was received.";
    }

    return "Review will appear here after submission.";
});
const canReconnectReview = computed(
    () => reviewStatus.value === "error" && Boolean(lastUpload.value?.compositionId),
);
const authCallbackUrl = computed(() => `${window.location.origin}/auth/callback`);
const isAuthCallbackRoute = computed(() => routePath.value === "/auth/callback");
const isOauthConsentRoute = computed(
    () => routePath.value === "/oauth/consent",
);
const currentLegalPage = computed(
    () => legalPages.find((page) => page.path === routePath.value) ?? null,
);
const isLegalRoute = computed(() => Boolean(currentLegalPage.value));
const oauthQueryParams = computed(() => {
    const params = new URLSearchParams(window.location.search);
    return Array.from(params.entries()).map(([key, value]) => ({ key, value }));
});
const canUpload = computed(() => {
    return (
        isSupabaseConfigured &&
        user.value &&
        selectedFiles.value.length > 0 &&
        !hasSelectionErrors.value &&
        !isUploading.value
    );
});

onMounted(async () => {
    window.addEventListener("popstate", syncRoute);

    if (!isSupabaseConfigured) {
        authReady.value = true;
        logAuthEvent("auth_init_skipped", {
            reason: "missing_supabase_environment",
        });
        return;
    }

    const { data, error } = await supabase.auth.getSession();
    if (error) {
        authError.value = error.message;
        logAuthEvent("session_restore_failed", {
            message: error.message,
        });
    } else {
        session.value = data.session;
        if (data.session) {
            logAuthEvent("session_restored", {
                email: data.session.user?.email ?? null,
            });
            if (isAuthCallbackRoute.value) {
                replaceToWorkspace();
            }
        } else if (isAuthCallbackRoute.value) {
            const exchangedSession = await exchangeCallbackCodeForSession();
            if (exchangedSession) {
                session.value = exchangedSession;
                replaceToWorkspace();
            }
        }
    }

    const { data: listener } = supabase.auth.onAuthStateChange(
        (event, nextSession) => {
            session.value = nextSession;
            authError.value = "";
            if (event === "INITIAL_SESSION") {
                return;
            }
            logAuthEvent("auth_state_changed", {
                event,
                hasSession: Boolean(nextSession),
                email: nextSession?.user?.email ?? null,
            });
            if (event === "SIGNED_IN" && isAuthCallbackRoute.value) {
                replaceToWorkspace();
            }
        },
    );

    authSubscription = listener.subscription;
    authReady.value = true;
});

onUnmounted(() => {
    window.removeEventListener("popstate", syncRoute);
    authSubscription?.unsubscribe();
    abortReviewStream();
});

function normalizePath(pathname) {
    const normalized = pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "");
    return normalized || "/";
}

function syncRoute() {
    routePath.value = normalizePath(window.location.pathname);
}

function goToWorkspace() {
    window.history.pushState({}, "", "/");
    syncRoute();
}

function replaceToWorkspace() {
    window.history.replaceState({}, "", "/");
    syncRoute();
}

function navigateTo(path) {
    window.history.pushState({}, "", path);
    syncRoute();
}

function logAuthEvent(event, details = {}) {
    const entry = {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        event,
        details: sanitizeAuthLogDetails(details),
    };

    console.info("[auth]", event, entry.details);
    return writeSupabaseAuthEvent(entry);
}

function sanitizeAuthLogDetails(details) {
    return Object.fromEntries(
        Object.entries(details).filter(
            ([key]) => !key.toLowerCase().includes("token"),
        ),
    );
}

async function exchangeCallbackCodeForSession() {
    const params = new URLSearchParams(window.location.search);
    const callbackError = params.get("error_description") ?? params.get("error");

    if (callbackError) {
        authError.value = callbackError;
        logAuthEvent("session_restore_failed", {
            reason: "auth_callback_error",
            message: callbackError,
        });
        return null;
    }

    const code = params.get("code");
    if (!code) {
        logAuthEvent("session_restore_failed", {
            reason: "auth_callback_missing_session",
            message: "Auth callback loaded without a restored session or code parameter.",
        });
        return null;
    }

    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
        authError.value = error.message;
        logAuthEvent("session_restore_failed", {
            reason: "code_exchange_failed",
            message: error.message,
        });
        return null;
    }

    logAuthEvent("session_restored", {
        email: data.session?.user?.email ?? null,
    });
    return data.session;
}

async function writeSupabaseAuthEvent(entry) {
    if (!isSupabaseConfigured) {
        return;
    }

    const { error } = await supabase.from("auth_events").insert({
        event_type: entry.event,
        route_path: routePath.value,
        message: entry.details.message ?? null,
        metadata_json: entry.details,
    });

    if (error) {
        console.warn("[auth] Unable to write auth event to Supabase", error);
    }
}

async function continueWithGoogle() {
    authError.value = "";
    await logAuthEvent("google_oauth_button_clicked", {
        redirectTo: authCallbackUrl.value,
        path: routePath.value,
    });

    const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
            redirectTo: authCallbackUrl.value,
        },
    });

    if (error) {
        authError.value = error.message;
        logAuthEvent("google_oauth_start_failed", {
            message: error.message,
        });
        return;
    }

    logAuthEvent("google_oauth_redirect_requested", {
        redirectTo: authCallbackUrl.value,
    });
}

async function signOut() {
    authError.value = "";
    abortReviewStream();
    await logAuthEvent("sign_out_requested", {
        email: user.value?.email ?? null,
    });
    const { error } = await supabase.auth.signOut();

    if (error) {
        authError.value = error.message;
        logAuthEvent("sign_out_failed", {
            message: error.message,
        });
        return;
    }

    logAuthEvent("sign_out_succeeded");
}

function handleFileSelection(event) {
    const files = Array.from(event.target.files ?? []);
    selectedFiles.value = files.map((file) => {
        const validation = validateCompositionFile(file);

        return {
            id: crypto.randomUUID(),
            file,
            assetType: validation.assetType,
            error: validation.error,
            status: validation.error ? "error" : "ready",
            storagePath: "",
        };
    });

    uploadStatus.value = files.length ? "ready" : "idle";
    uploadMessage.value = "";
    lastUpload.value = null;
    event.target.value = "";
}

function removeSelectedFile(id) {
    selectedFiles.value = selectedFiles.value.filter((item) => item.id !== id);
    uploadStatus.value = selectedFiles.value.length ? "ready" : "idle";
}

function resetUpload() {
    abortReviewStream();
    selectedFiles.value = [];
    uploadStatus.value = "idle";
    uploadMessage.value = "";
    compositionTitle.value = "";
    lastUpload.value = null;
    resetReviewPanel();
}

async function uploadFiles() {
    if (!canUpload.value || hasSelectionErrors.value) {
        uploadStatus.value = "error";
        uploadMessage.value = hasSelectionErrors.value
            ? "Remove unsupported files before uploading."
            : "Sign in and select files before uploading.";
        return;
    }

    abortReviewStream();
    resetReviewPanel("Review will start after the upload completes.");
    uploadStatus.value = "uploading";
    uploadMessage.value = "Verifying signed-in user.";

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
        session.value = null;
        uploadStatus.value = "error";
        uploadMessage.value =
            userError?.message ?? "Sign in again before submitting files.";
        resetReviewPanel("Review will appear after a successful submission.");
        return;
    }

    uploadMessage.value = "Saving composition.";

    const compositionId = crypto.randomUUID();
    const ownerId = userData.user.id;
    const title = compositionTitle.value.trim() || inferCompositionTitle();

    const compositionResult = await supabase.from("compositions").insert({
        id: compositionId,
        owner_id: ownerId,
        title,
    });

    if (compositionResult.error) {
        uploadStatus.value = "error";
        uploadMessage.value = compositionResult.error.message;
        resetReviewPanel("Review will appear after a successful submission.");
        return;
    }

    const uploaded = [];
    const failed = [];

    for (const item of selectedFiles.value) {
        item.status = "uploading";
        uploadMessage.value = `Uploading ${item.file.name}.`;

        const assetId = crypto.randomUUID();
        const assetType = getAssetType(item.file);
        const filename = safeFilename(item.file.name);
        const mimeType = getUploadMimeType(item.file, assetType);
        const storagePath = buildStoragePath(
            ownerId,
            compositionId,
            assetId,
            filename,
        );
        item.storagePath = storagePath;

        await logUploadEvent({
            ownerId,
            compositionId,
            eventType: "upload_started",
            message: `Started upload for ${item.file.name}`,
            metadata: {
                original_filename: item.file.name,
                asset_type: assetType,
            },
        });

        const uploadResult = await supabase.storage
            .from(COMPOSITION_ASSETS_BUCKET)
            .upload(storagePath, item.file, {
                cacheControl: "3600",
                contentType: mimeType,
                metadata: {
                    asset_id: assetId,
                    asset_type: assetType,
                    composition_id: compositionId,
                    original_filename: item.file.name,
                    owner_id: ownerId,
                },
                upsert: false,
            });

        if (uploadResult.error) {
            item.status = "error";
            item.error = uploadResult.error.message;
            failed.push(item);
            await logUploadEvent({
                ownerId,
                compositionId,
                eventType: "upload_failed",
                message: uploadResult.error.message,
                metadata: {
                    original_filename: item.file.name,
                    storage_path: storagePath,
                },
            });
            continue;
        }

        const assetResult = await supabase.from("composition_assets").insert({
            id: assetId,
            composition_id: compositionId,
            owner_id: ownerId,
            asset_type: assetType,
            original_filename: item.file.name,
            storage_bucket: COMPOSITION_ASSETS_BUCKET,
            storage_path: storagePath,
            mime_type: mimeType,
            byte_size: item.file.size,
            upload_status: "uploaded",
        });

        if (assetResult.error) {
            const cleanupResult = await supabase.storage
                .from(COMPOSITION_ASSETS_BUCKET)
                .remove([storagePath]);
            item.status = "error";
            item.error = assetResult.error.message;
            failed.push(item);
            await logUploadEvent({
                ownerId,
                compositionId,
                eventType: "upload_failed",
                message: assetResult.error.message,
                metadata: {
                    cleanup_error: cleanupResult.error?.message ?? null,
                    original_filename: item.file.name,
                    storage_path: storagePath,
                },
            });
            continue;
        }

        item.preview = await createMusicXmlPreview(item, mimeType);
        item.status = "uploaded";
        uploaded.push(item);
        await logUploadEvent({
            ownerId,
            assetId,
            compositionId,
            eventType: "upload_succeeded",
            message: `Uploaded ${item.file.name}`,
            metadata: {
                storage_path: storagePath,
            },
        });
    }

    lastUpload.value = {
        compositionId,
        title,
        assets: uploaded.map((item) => ({
            id: item.id,
            name: item.file.name,
            assetType: item.assetType,
            preview: item.preview,
            size: item.file.size,
        })),
        failedAssets: failed.map((item) => ({
            id: item.id,
            name: item.file.name,
            error: item.error,
        })),
        uploaded: uploaded.length,
        failed: failed.length,
    };

    uploadStatus.value = failed.length ? "error" : "success";
    uploadMessage.value = failed.length
        ? `${uploaded.length} uploaded, ${failed.length} failed.`
        : `${uploaded.length} file${uploaded.length === 1 ? "" : "s"} uploaded.`;

    if (failed.length) {
        resetReviewPanel("Review will start after all files submit successfully.");
    } else if (uploaded.length) {
        startReviewStream(compositionId);
    }
}

async function createMusicXmlPreview(item, mimeType) {
    if (item.assetType !== "musicxml") {
        return null;
    }

    try {
        if (mimeType === "application/vnd.recordare.musicxml-compressed") {
            return {
                isCompressed: true,
                musicXml: "",
                musicXmlBuffer: markRaw(await item.file.arrayBuffer()),
            };
        }

        return {
            isCompressed: false,
            musicXml: await item.file.text(),
            musicXmlBuffer: null,
        };
    } catch (previewError) {
        return {
            error:
                previewError instanceof Error
                    ? previewError.message
                    : "Unable to prepare this MusicXML preview.",
            isCompressed: false,
            musicXml: "",
            musicXmlBuffer: null,
        };
    }
}

async function logUploadEvent({
    assetId = null,
    compositionId,
    eventType,
    message,
    metadata = {},
    ownerId = user.value?.id ?? null,
}) {
    const { error } = await supabase.from("upload_events").insert({
        asset_id: assetId,
        composition_id: compositionId,
        owner_id: ownerId,
        event_type: eventType,
        message,
        metadata_json: metadata,
    });

    if (error) {
        console.warn("Unable to write upload event", error);
    }
}

function resetReviewPanel(message = "Review will appear here after submission.") {
    reviewStatus.value = "idle";
    reviewMessage.value = message;
    reviewText.value = "";
    reviewError.value = "";
    reviewId.value = "";
}

function abortReviewStream() {
    reviewAbortController?.abort();
    reviewAbortController = null;
}

function reconnectReviewStream() {
    if (!lastUpload.value?.compositionId) {
        return;
    }

    startReviewStream(lastUpload.value.compositionId);
}

async function startReviewStream(compositionId) {
    abortReviewStream();
    reviewText.value = "";
    reviewError.value = "";
    reviewId.value = "";

    if (!reviewStreamUrl) {
        reviewStatus.value = "not_configured";
        reviewMessage.value = "Review stream not configured.";
        return;
    }

    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) {
        reviewStatus.value = "error";
        reviewMessage.value = "Unable to start review.";
        reviewError.value =
            error?.message ?? "Sign in again before starting the review stream.";
        return;
    }

    const controller = new AbortController();
    reviewAbortController = controller;
    reviewStatus.value = "connecting";
    reviewMessage.value = "Connecting to review stream.";

    try {
        const response = await fetch(reviewStreamUrl, {
            method: "POST",
            headers: {
                Accept: "text/event-stream",
                Authorization: `Bearer ${data.session.access_token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                composition_id: compositionId,
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(
                `Review stream failed with ${response.status} ${response.statusText}`.trim(),
            );
        }

        if (!response.body) {
            throw new Error("Review stream response did not include a readable body.");
        }

        reviewStatus.value = "waiting";
        reviewMessage.value = "Waiting for review.";
        await readReviewSseStream(response.body, controller);

        if (reviewAbortController === controller && reviewStatus.value !== "error") {
            reviewStatus.value = "complete";
            reviewMessage.value = reviewText.value
                ? "Review complete."
                : "Review stream closed.";
        }
    } catch (error) {
        if (controller.signal.aborted) {
            return;
        }

        reviewStatus.value = "error";
        reviewMessage.value = "Review stream interrupted.";
        reviewError.value =
            error instanceof Error ? error.message : "Unable to stream review.";
    } finally {
        if (reviewAbortController === controller) {
            reviewAbortController = null;
        }
    }
}

async function readReviewSseStream(body, controller) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";

        for (const eventText of events) {
            handleReviewSseEvent(parseSseEvent(eventText));
        }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
        handleReviewSseEvent(parseSseEvent(buffer));
    }
}

function parseSseEvent(eventText) {
    const dataLines = [];
    let event = "message";

    for (const line of eventText.split(/\r?\n/)) {
        if (!line || line.startsWith(":")) continue;

        const separatorIndex = line.indexOf(":");
        const field =
            separatorIndex === -1 ? line : line.slice(0, separatorIndex);
        let value =
            separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
        if (value.startsWith(" ")) {
            value = value.slice(1);
        }

        if (field === "event") {
            event = value || "message";
        } else if (field === "data") {
            dataLines.push(value);
        }
    }

    return {
        data: dataLines.join("\n"),
        event,
    };
}

function parseReviewPayload(data) {
    if (!data) return {};

    try {
        return JSON.parse(data);
    } catch {
        return {
            message: data,
            text: data,
        };
    }
}

function handleReviewSseEvent({ event, data }) {
    const payload = parseReviewPayload(data);

    if (event === "status") {
        reviewStatus.value = reviewText.value ? "streaming" : "waiting";
        reviewMessage.value = payload.message ?? "Waiting for review.";
        return;
    }

    if (event === "delta" || event === "message") {
        const nextText = payload.text ?? payload.delta ?? payload.content ?? data;
        if (nextText) {
            reviewText.value += nextText;
        }
        reviewStatus.value = "streaming";
        reviewMessage.value = payload.message ?? "Review streaming.";
        return;
    }

    if (event === "done") {
        reviewStatus.value = "complete";
        reviewMessage.value = "Review complete.";
        reviewId.value = payload.review_id ?? payload.id ?? "";
        return;
    }

    if (event === "error") {
        reviewStatus.value = "error";
        reviewMessage.value = "Review stream interrupted.";
        reviewError.value = payload.message ?? "Unable to stream review.";
    }
}

function inferCompositionTitle() {
    const firstFile =
        selectedFiles.value[0]?.file?.name ?? "Untitled composition";
    return firstFile.replace(/\.[^.]+$/, "") || "Untitled composition";
}

function formatBytes(bytes) {
    if (!bytes) return "0 B";

    const units = ["B", "KB", "MB", "GB"];
    const exponent = Math.min(
        Math.floor(Math.log(bytes) / Math.log(1024)),
        units.length - 1,
    );
    const value = bytes / 1024 ** exponent;

    return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}
</script>

<template>
    <main class="app-shell">
        <header class="topbar">
            <div>
                <p class="eyebrow">Composition Critique</p>
                <h1>Score Upload Workspace</h1>
            </div>

            <div class="auth-panel">
                <span v-if="!authReady" class="status-pill"
                    >Restoring session</span
                >
                <span
                    v-else-if="user"
                    class="status-pill status-pill--success"
                    >{{ user.email }}</span
                >
                <span v-else class="status-pill">Signed out</span>

                <button
                    v-if="!user"
                    class="button button--primary"
                    type="button"
                    :disabled="!isSupabaseConfigured || !authReady"
                    @click="continueWithGoogle"
                >
                    Login with Google
                </button>
                <button v-else class="button" type="button" @click="signOut">
                    Sign out
                </button>
                <p v-if="!user" class="auth-helper">
                    New users are created automatically after Google approval.
                </p>
                <nav class="legal-nav" aria-label="Legal pages">
                    <a href="/terms" @click.prevent="navigateTo('/terms')"
                        >Terms</a
                    >
                    <a href="/eula" @click.prevent="navigateTo('/eula')"
                        >EULA</a
                    >
                </nav>
            </div>
        </header>

        <section
            v-if="isOauthConsentRoute"
            class="consent-page"
            aria-labelledby="consent-title"
        >
            <div class="consent-card">
                <p class="eyebrow">OAuth Consent</p>
                <h2 id="consent-title">Composition Critique Authorization</h2>
                <p>
                    This route is implemented for OAuth preview checks. Login
                    with Google to create or restore a Supabase session, then
                    continue to the upload workspace.
                </p>

                <dl v-if="oauthQueryParams.length" class="query-list">
                    <template
                        v-for="param in oauthQueryParams"
                        :key="param.key"
                    >
                        <dt>{{ param.key }}</dt>
                        <dd>{{ param.value }}</dd>
                    </template>
                </dl>

                <div class="consent-actions">
                    <button
                        v-if="!user"
                        class="button button--primary"
                        type="button"
                        :disabled="!isSupabaseConfigured || !authReady"
                        @click="continueWithGoogle"
                    >
                        Login with Google
                    </button>
                    <p v-if="!user" class="auth-helper auth-helper--inline">
                        New users are created automatically after Google approval.
                    </p>
                    <button class="button" type="button" @click="goToWorkspace">
                        Continue to workspace
                    </button>
                </div>

                <div class="legal-link-row">
                    <a href="/terms" @click.prevent="navigateTo('/terms')"
                        >Terms of Service</a
                    >
                    <a href="/eula" @click.prevent="navigateTo('/eula')"
                        >End User License Agreement</a
                    >
                </div>
            </div>
        </section>

        <section
            v-if="isAuthCallbackRoute"
            class="consent-page"
            aria-labelledby="auth-callback-title"
        >
            <div class="consent-card">
                <p class="eyebrow">Authentication</p>
                <h2 id="auth-callback-title">Completing Google sign-in</h2>
                <p>
                    Supabase is restoring your session. You will be sent back to
                    the workspace once the session is ready.
                </p>

                <div class="consent-actions">
                    <button class="button" type="button" @click="goToWorkspace">
                        Back to workspace
                    </button>
                </div>
            </div>
        </section>

        <section
            v-if="currentLegalPage"
            class="legal-page"
            :aria-labelledby="`${currentLegalPage.path.slice(1)}-title`"
        >
            <article class="legal-card">
                <p class="eyebrow">Legal</p>
                <h2 :id="`${currentLegalPage.path.slice(1)}-title`">
                    {{ currentLegalPage.title }}
                </h2>
                <p class="legal-updated">
                    Last updated: {{ currentLegalPage.updated }}
                </p>
                <p class="legal-intro">{{ currentLegalPage.intro }}</p>

                <section
                    v-for="section in currentLegalPage.sections"
                    :key="section.title"
                    class="legal-section"
                >
                    <h3>{{ section.title }}</h3>
                    <p>{{ section.body }}</p>
                </section>

                <div class="consent-actions">
                    <button class="button" type="button" @click="goToWorkspace">
                        Back to workspace
                    </button>
                </div>
            </article>
        </section>

        <section
            v-if="!isSupabaseConfigured && !isLegalRoute"
            class="setup-banner"
        >
            <strong>Supabase environment missing.</strong>
            <span>{{ supabaseConfigMessage }}</span>
        </section>

        <section
            v-if="authError && !isLegalRoute"
            class="setup-banner setup-banner--error"
        >
            <strong>Auth error.</strong>
            <span>{{ authError }}</span>
        </section>

        <div
            v-if="!isAuthCallbackRoute && !isOauthConsentRoute && !isLegalRoute"
            class="workspace"
        >
            <section class="upload-panel" aria-labelledby="upload-title">
                <div class="section-heading">
                    <div>
                        <p class="eyebrow">Upload</p>
                        <h2 id="upload-title">
                            {{
                                hasSubmittedUpload
                                    ? "Submitted assets"
                                    : "PDF and MusicXML assets"
                            }}
                        </h2>
                    </div>
                    <span class="status-pill">{{ uploadStatus }}</span>
                </div>

                <div v-if="hasSubmittedUpload" class="submitted-workspace">
                    <div class="submission-summary">
                        <div class="submission-summary__header">
                            <div>
                                <strong>{{ lastUpload.title }}</strong>
                                <span>
                                    {{ lastUpload.uploaded }}
                                    file{{
                                        lastUpload.uploaded === 1 ? "" : "s"
                                    }}
                                    submitted
                                </span>
                            </div>
                            <span class="status-pill status-pill--success">
                                {{ lastUpload.uploaded }} uploaded
                            </span>
                        </div>

                        <ul>
                            <li
                                v-for="asset in lastUpload.assets"
                                :key="asset.id"
                            >
                                <span>{{ asset.name }}</span>
                                <small>
                                    {{ asset.assetType }} |
                                    {{ formatBytes(asset.size) }}
                                </small>
                            </li>
                        </ul>

                        <button
                            class="button button--compact"
                            type="button"
                            @click="resetUpload"
                        >
                            Submit another
                        </button>
                    </div>

                    <div
                        v-if="musicXmlPreviewAssets.length"
                        class="score-preview-list"
                    >
                        <MusicXmlPreview
                            v-for="asset in musicXmlPreviewAssets"
                            :key="asset.id"
                            :file-name="asset.name"
                            :is-compressed="asset.preview?.isCompressed"
                            :music-xml="asset.preview?.musicXml"
                            :music-xml-buffer="asset.preview?.musicXmlBuffer"
                        />
                    </div>
                </div>

                <div v-else class="upload-form">
                    <label class="field-label" for="composition-title"
                        >Composition title</label
                    >
                    <input
                        id="composition-title"
                        v-model="compositionTitle"
                        class="text-input"
                        type="text"
                        placeholder="Untitled composition"
                        :disabled="isUploading"
                    />

                    <label class="file-drop" for="composition-files">
                        <span>Choose PDF, MusicXML, XML, or MXL files</span>
                        <small>{{ selectedFiles.length }} selected</small>
                    </label>
                    <input
                        id="composition-files"
                        class="sr-only"
                        type="file"
                        multiple
                        :accept="ACCEPTED_UPLOAD_TYPES"
                        :disabled="!user || isUploading || !isSupabaseConfigured"
                        @change="handleFileSelection"
                    />

                    <div v-if="selectedFiles.length" class="file-list">
                        <article
                            v-for="item in selectedFiles"
                            :key="item.id"
                            class="file-row"
                            :class="{ 'file-row--error': item.error }"
                        >
                            <div>
                                <strong>{{ item.file.name }}</strong>
                                <span
                                    >{{ item.assetType || "unsupported" }} |
                                    {{ formatBytes(item.file.size) }}</span
                                >
                                <small v-if="item.error" class="error-text">{{
                                    item.error
                                }}</small>
                            </div>
                            <div class="file-actions">
                                <span class="status-pill">{{
                                    item.status
                                }}</span>
                                <button
                                    class="icon-button"
                                    type="button"
                                    :disabled="isUploading"
                                    aria-label="Remove file"
                                    title="Remove file"
                                    @click="removeSelectedFile(item.id)"
                                >
                                    X
                                </button>
                            </div>
                        </article>
                    </div>

                    <div class="action-row">
                        <button
                            class="button button--primary"
                            type="button"
                            :disabled="!canUpload"
                            @click="uploadFiles"
                        >
                            Submit files
                        </button>
                        <button
                            class="button"
                            type="button"
                            :disabled="isUploading"
                            @click="resetUpload"
                        >
                            Clear
                        </button>
                    </div>
                </div>

                <p
                    v-if="uploadMessage"
                    class="upload-message"
                    :class="{ 'error-text': uploadStatus === 'error' }"
                >
                    {{ uploadMessage }}
                </p>
            </section>

            <aside class="review-panel" aria-labelledby="review-title">
                <div class="section-heading">
                    <div>
                        <p class="eyebrow">Review</p>
                        <h2 id="review-title">{{ reviewPanelTitle }}</h2>
                    </div>
                    <span
                        class="status-pill"
                        :class="{
                            'status-pill--success':
                                reviewStatus === 'complete',
                            'status-pill--error': reviewStatus === 'error',
                        }"
                    >
                        {{ reviewStatusLabel }}
                    </span>
                </div>

                <div class="review-panel__body">
                    <p class="review-message">{{ reviewMessage }}</p>
                    <pre v-if="reviewText" class="review-output">{{
                        reviewText
                    }}</pre>
                    <div v-else class="review-placeholder">
                        {{ reviewPlaceholder }}
                    </div>
                    <p v-if="reviewId" class="review-meta">
                        Review ID: {{ reviewId }}
                    </p>
                    <p v-if="reviewError" class="error-text">
                        {{ reviewError }}
                    </p>
                    <button
                        v-if="canReconnectReview"
                        class="button"
                        type="button"
                        @click="reconnectReviewStream"
                    >
                        Reconnect
                    </button>
                </div>
            </aside>
        </div>
    </main>
</template>
