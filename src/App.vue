<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import AnnotatedPdfViewer from "./components/AnnotatedPdfViewer.vue";
import ReviewMarkdown from "./components/ReviewMarkdown.vue";
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
    getUploadBody,
    getUploadMimeType,
    safeFilename,
    validateCompositionFile,
} from "./lib/uploads";

const authReady = ref(false);
const session = ref(null);
const authError = ref("");
const selectedFiles = ref([]);
const instrumentationMode = ref("auto");
const selectedInstruments = ref([]);
const selectedDocType = ref("auto");
const uploadStatus = ref("idle");
const uploadMessage = ref("");
const compositionTitle = ref("");
const lastUpload = ref(null);
const reviewStatus = ref("idle");
const reviewMessage = ref("Engraving review will appear here after submission.");
const reviewText = ref("");
const reviewError = ref("");
const reviewId = ref("");
const reviewPolished = ref(false);
const activeReviewAction = ref("analyze");
const pageFindings = ref([]);
const routePath = ref(normalizePath(window.location.pathname));
const adminFeedbackRows = ref([]);
const adminFeedbackStatus = ref("idle");
const adminFeedbackError = ref("");

let authSubscription = null;
let reviewAbortController = null;
const pdfPreviewUrls = new Set();

const reviewStreamUrl =
    (import.meta.env.VITE_REVIEW_STREAM_URL ?? "/api/engraving-stream").trim() ||
    "/api/engraving-stream";

const INSTRUMENT_OPTIONS = [
    { label: "Violin", value: "violin" },
    { label: "Viola", value: "viola" },
    { label: "Cello", value: "cello" },
    { label: "Guitar", value: "guitar" },
    { label: "Piano", value: "piano" },
    { label: "Voice", value: "voice" },
    { label: "Flute", value: "flute" },
    { label: "Clarinet", value: "clarinet" },
    { label: "Percussion", value: "percussion" },
];

const DOC_TYPE_OPTIONS = [
    { label: "Auto", value: "auto" },
    { label: "Score", value: "score" },
    { label: "Part", value: "part" },
];

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
                body: "You retain ownership of PDFs, metadata, and other materials you upload. You grant Composition Critique a limited license to store, process, display, and transmit that content only as needed to operate and improve the service.",
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
const pdfPreviewAssets = computed(
    () =>
        lastUpload.value?.assets?.filter(
            (asset) => asset.assetType === "pdf" && asset.previewUrl,
        ) ?? [],
);
const debugGeometry = computed(() => {
    routePath.value;
    const params = new URLSearchParams(window.location.search);
    return params.get("debugGeometry") === "1";
});
const findingCount = computed(() =>
    pageFindings.value.reduce(
        (total, page) => total + (page.findings?.length ?? 0),
        0,
    ),
);
const showDebugReviewJson = computed(
    () =>
        debugGeometry.value &&
        hasSubmittedUpload.value &&
        (pageFindings.value.length > 0 ||
            reviewStatus.value !== "idle" ||
            Boolean(reviewText.value) ||
            Boolean(reviewError.value)),
);
const debugReviewJson = computed(() =>
    JSON.stringify(
        {
            finding_count: findingCount.value,
            pages: pageFindings.value,
            review_error: reviewError.value || null,
            review_id: reviewId.value || null,
            review_status: reviewStatus.value,
        },
        null,
        2,
    ),
);
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
const canReconnectReview = computed(
    () => reviewStatus.value === "error" && Boolean(lastUpload.value?.compositionId),
);
const canPolishReview = computed(
    () =>
        !debugGeometry.value &&
        reviewStatus.value === "complete" &&
        !reviewPolished.value &&
        Boolean(reviewText.value.trim()) &&
        Boolean(lastUpload.value?.compositionId),
);
const reviewRoutingPayload = computed(() => buildReviewRoutingPayload());
const authCallbackUrl = computed(() => `${window.location.origin}/auth/callback`);
const isAuthCallbackRoute = computed(() => routePath.value === "/auth/callback");
const isOauthConsentRoute = computed(
    () => routePath.value === "/oauth/consent",
);
const isAdminFeedbackRoute = computed(
    () => routePath.value === "/admin/feedback",
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

watch(
    () => [routePath.value, session.value?.access_token],
    () => {
        if (isAdminFeedbackRoute.value && session.value?.access_token) {
            loadAdminFeedback();
        }
    },
);

onUnmounted(() => {
    window.removeEventListener("popstate", syncRoute);
    authSubscription?.unsubscribe();
    abortReviewStream();
    revokePdfPreviewUrls();
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

async function authorizedFetch(url, options = {}) {
    const token = session.value?.access_token;
    if (!token) {
        throw new Error("Sign in before continuing.");
    }
    return fetch(url, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            ...(options.headers ?? {}),
        },
    });
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

    resetUpload();
    logAuthEvent("sign_out_succeeded");
}

function handleFileSelection(event) {
    revokePdfPreviewUrls();
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

function setInstrumentationMode(mode) {
    instrumentationMode.value = mode;
    if (mode === "auto") {
        selectedInstruments.value = [];
    }
}

function toggleInstrument(instrument) {
    if (instrumentationMode.value === "auto") {
        instrumentationMode.value = "manual";
    }

    selectedInstruments.value = selectedInstruments.value.includes(instrument)
        ? selectedInstruments.value.filter((item) => item !== instrument)
        : [...selectedInstruments.value, instrument];
}

function buildReviewRoutingPayload() {
    const payload = {};

    if (instrumentationMode.value === "manual" && selectedInstruments.value.length) {
        payload.instruments = [...selectedInstruments.value];
    }

    if (selectedDocType.value !== "auto") {
        payload.doc_type = selectedDocType.value;
    }

    return Object.keys(payload).length ? payload : null;
}

function resetUpload() {
    abortReviewStream();
    revokePdfPreviewUrls();
    selectedFiles.value = [];
    instrumentationMode.value = "auto";
    selectedInstruments.value = [];
    selectedDocType.value = "auto";
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
    revokePdfPreviewUrls();
    resetReviewPanel("Engraving review will start after the upload completes.");
    uploadStatus.value = "uploading";
    uploadMessage.value = "Verifying signed-in user.";

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
        session.value = null;
        uploadStatus.value = "error";
        uploadMessage.value =
            userError?.message ?? "Sign in again before submitting files.";
        resetReviewPanel("Engraving review will appear after a successful submission.");
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
        resetReviewPanel("Engraving review will appear after a successful submission.");
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
        const uploadBody = getUploadBody(item.file, mimeType);
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
            .upload(storagePath, uploadBody, {
                cacheControl: "3600",
                contentType: mimeType,
                metadata: {
                    asset_id: assetId,
                    asset_type: assetType,
                    composition_id: compositionId,
                    detected_mime_type: item.file.type || "unknown",
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

        item.status = "uploaded";
        item.assetId = assetId;
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

    const shouldCreatePreviews = failed.length === 0;

    const reviewRouting = reviewRoutingPayload.value;

    lastUpload.value = {
        compositionId,
        title,
        assets: uploaded.map((item) => ({
            id: item.assetId ?? item.id,
            name: item.file.name,
            assetType: item.assetType,
            file: item.file,
            previewUrl: shouldCreatePreviews ? createPdfPreviewUrl(item) : "",
            size: item.file.size,
        })),
        failedAssets: failed.map((item) => ({
            id: item.id,
            name: item.file.name,
            error: item.error,
        })),
        uploaded: uploaded.length,
        failed: failed.length,
        reviewRouting,
    };

    uploadStatus.value = failed.length ? "error" : "success";
    uploadMessage.value = failed.length
        ? `${uploaded.length} uploaded, ${failed.length} failed.`
        : `${uploaded.length} file${uploaded.length === 1 ? "" : "s"} uploaded.`;

    if (failed.length) {
        resetReviewPanel("Engraving review will start after all files submit successfully.");
    } else if (uploaded.length) {
        startReviewStream(compositionId, { routing: reviewRouting });
    }
}

function createPdfPreviewUrl(item) {
    if (item.assetType !== "pdf") {
        return "";
    }

    const previewUrl = URL.createObjectURL(item.file);
    pdfPreviewUrls.add(previewUrl);
    return previewUrl;
}

function revokePdfPreviewUrls() {
    pdfPreviewUrls.forEach((previewUrl) => {
        URL.revokeObjectURL(previewUrl);
    });
    pdfPreviewUrls.clear();
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

function resetReviewPanel(message = "Engraving review will appear here after submission.") {
    reviewStatus.value = "idle";
    reviewMessage.value = message;
    reviewText.value = "";
    reviewError.value = "";
    reviewId.value = "";
    reviewPolished.value = false;
    activeReviewAction.value = "analyze";
    pageFindings.value = [];
}

function abortReviewStream() {
    reviewAbortController?.abort();
    reviewAbortController = null;
}

function reconnectReviewStream() {
    if (!lastUpload.value?.compositionId) {
        return;
    }

    startReviewStream(lastUpload.value.compositionId, {
        routing: lastUpload.value.reviewRouting,
    });
}

function polishReviewOutput() {
    if (!lastUpload.value?.compositionId || !reviewText.value.trim()) {
        return;
    }

    startReviewStream(lastUpload.value.compositionId, {
        action: "polish",
        reviewRunId: reviewId.value,
        sourceText: reviewText.value,
    });
}

async function startReviewStream(compositionId, options = {}) {
    const action = options.action ?? "analyze";
    const previousReviewText = reviewText.value;
    abortReviewStream();
    reviewText.value = "";
    reviewError.value = "";
    if (action === "analyze") {
        reviewId.value = "";
        reviewPolished.value = false;
        pageFindings.value = [];
    }
    activeReviewAction.value = action;

    if (!reviewStreamUrl) {
        reviewStatus.value = "not_configured";
        reviewMessage.value = "Engraving review stream not configured.";
        return;
    }

    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) {
        reviewStatus.value = "error";
        reviewMessage.value = "Unable to start engraving review.";
        reviewError.value =
            error?.message ?? "Sign in again before starting the engraving review stream.";
        return;
    }

    const controller = new AbortController();
    reviewAbortController = controller;
    reviewStatus.value = "connecting";
    reviewMessage.value =
        action === "polish"
            ? "Connecting to polish stream."
            : "Connecting to engraving review stream.";

    try {
        const requestBody = {
            action,
            composition_id: compositionId,
            review_run_id: options.reviewRunId ?? "",
            source_text: options.sourceText ?? "",
        };
        if (action === "analyze" && options.routing) {
            Object.assign(requestBody, options.routing);
        }

        const response = await fetch(reviewStreamUrl, {
            method: "POST",
            headers: {
                Accept: "text/event-stream",
                Authorization: `Bearer ${data.session.access_token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(
                `Engraving review stream failed with ${response.status} ${response.statusText}`.trim(),
            );
        }

        if (!response.body) {
            throw new Error("Engraving review stream response did not include a readable body.");
        }

        reviewStatus.value = "waiting";
        reviewMessage.value = "Waiting for engraving review.";
        await readReviewSseStream(response.body, controller);

        if (reviewAbortController === controller && reviewStatus.value !== "error") {
            reviewStatus.value = "complete";
            if (action === "polish") {
                reviewPolished.value = true;
            }
            reviewMessage.value = reviewText.value
                ? action === "polish"
                    ? "Polished engraving review complete."
                    : "Engraving review complete."
                : "Engraving review stream closed.";
        }
    } catch (error) {
        if (controller.signal.aborted) {
            return;
        }

        reviewStatus.value = "error";
        reviewMessage.value = "Engraving review stream interrupted.";
        reviewError.value =
            error instanceof Error ? error.message : "Unable to stream engraving review.";
        if (action === "polish" && !reviewText.value) {
            reviewText.value = previousReviewText;
        }
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
        reviewMessage.value = payload.message ?? "Waiting for engraving review.";
        return;
    }

    if (event === "delta" || event === "message") {
        const nextText = payload.text ?? payload.delta ?? payload.content ?? data;
        if (nextText) {
            reviewText.value += nextText;
        }
        reviewStatus.value = "streaming";
        reviewMessage.value = payload.message ?? "Engraving review streaming.";
        return;
    }

    if (event === "findings") {
        addPageFindings(payload);
        reviewStatus.value = "streaming";
        reviewMessage.value = payload.findings?.length
            ? `Placed ${payload.findings.length} finding${payload.findings.length === 1 ? "" : "s"} on page ${payload.page ?? payload.page_number}.`
            : `Page ${payload.page ?? payload.page_number} checked.`;
        return;
    }

    if (event === "done") {
        reviewStatus.value = "complete";
        if (payload.polished) {
            reviewPolished.value = true;
        }
        reviewMessage.value = payload.polished
            ? "Polished engraving review complete."
            : "Engraving review complete.";
        reviewId.value = payload.review_id ?? payload.id ?? "";
        return;
    }

    if (event === "error") {
        reviewStatus.value = "error";
        reviewMessage.value = "Engraving review stream interrupted.";
        reviewError.value = payload.message ?? "Unable to stream engraving review.";
    }
}

function addPageFindings(payload) {
    const sourcePageId = payload.source_page_id ?? "";
    const pageNumber = Number(payload.page ?? payload.page_number ?? 0) || null;
    const findings = Array.isArray(payload.findings) ? payload.findings : [];
    const normalizedFindings = findings.map((finding, index) => ({
        ...finding,
        asset_filename: payload.asset_filename ?? finding.asset_filename ?? "",
        id:
            finding.id ??
            [
                sourcePageId || `page-${pageNumber ?? "unknown"}`,
                finding.rule_id || "finding",
                index + 1,
            ].join(":"),
        page_number: Number(finding.page_number ?? pageNumber) || pageNumber,
        source_page_id: finding.source_page_id ?? sourcePageId,
    }));

    pageFindings.value = [
        ...pageFindings.value.filter((page) => {
            if (sourcePageId) return page.source_page_id !== sourcePageId;
            return page.page !== pageNumber;
        }),
        {
            analysis_height: payload.analysis_height ?? null,
            analysis_width: payload.analysis_width ?? null,
            asset_filename: payload.asset_filename ?? "",
            findings: normalizedFindings,
            model_notes: payload.model_notes ?? "",
            page: pageNumber,
            source_page_id: sourcePageId,
        },
    ].sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
}

async function submitFindingVerdict({ finding, verdict }) {
    const findingDbId = finding.finding_db_id;
    if (!findingDbId) {
        updateFindingFeedback(finding.id, {
            feedback_status: "Feedback unavailable for this finding.",
        });
        return;
    }

    updateFindingFeedback(finding.id, {
        feedback_status: "Saving feedback.",
    });

    try {
        const response = await authorizedFetch("/api/finding-verdicts", {
            body: JSON.stringify({
                finding_db_id: findingDbId,
                verdict,
            }),
            method: "POST",
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.error ?? "Unable to save feedback.");
        }
        updateFindingFeedback(finding.id, {
            feedback_status: "Feedback saved.",
            feedback_verdict: verdict,
            verdict_id: payload.verdict?.id ?? finding.verdict_id ?? null,
        });
    } catch (error) {
        updateFindingFeedback(finding.id, {
            feedback_status:
                error instanceof Error ? error.message : "Unable to save feedback.",
        });
    }
}

function updateFindingFeedback(findingId, updates) {
    pageFindings.value = pageFindings.value.map((page) => ({
        ...page,
        findings: (page.findings ?? []).map((finding) =>
            finding.id === findingId ? { ...finding, ...updates } : finding,
        ),
    }));
}

async function loadAdminFeedback() {
    adminFeedbackStatus.value = "loading";
    adminFeedbackError.value = "";

    try {
        const response = await authorizedFetch("/api/admin/feedback?status=pending", {
            method: "GET",
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.error ?? "Unable to load feedback queue.");
        }
        adminFeedbackRows.value = (payload.feedback ?? []).map(prepareAdminFeedbackRow);
        adminFeedbackStatus.value = "ready";
    } catch (error) {
        adminFeedbackError.value =
            error instanceof Error ? error.message : "Unable to load feedback queue.";
        adminFeedbackStatus.value = "error";
    }
}

async function canonicalizeFeedback(row, canonicalKind) {
    adminFeedbackError.value = "";
    row.__saving = canonicalKind;

    try {
        const canonicalPayload = JSON.parse(row.__payloadText || "{}");
        const response = await authorizedFetch("/api/admin/feedback", {
            body: JSON.stringify({
                canonical_kind: canonicalKind,
                canonical_payload_json: canonicalPayload,
                verdict_id: row.id,
            }),
            method: "PATCH",
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.error ?? "Unable to canonicalize feedback.");
        }
        adminFeedbackRows.value = adminFeedbackRows.value.filter(
            (item) => item.id !== row.id,
        );
    } catch (error) {
        adminFeedbackError.value =
            error instanceof Error ? error.message : "Unable to canonicalize feedback.";
    } finally {
        row.__saving = "";
    }
}

function prepareAdminFeedbackRow(row) {
    const defaultKind =
        row.verdict === "not_true"
            ? "known_false_positive"
            : row.verdict === "irrelevant"
              ? "suppressed"
              : "accepted";
    return {
        ...row,
        __payloadText: JSON.stringify(defaultCanonicalPayload(row, defaultKind), null, 2),
        __saving: "",
    };
}

function defaultCanonicalPayload(row, canonicalKind) {
    const finding = row.engraving_findings ?? {};
    const metadata = finding.metadata_json ?? {};
    const ruleId = canonicalKind === "ignore" ? "IGNORE" : metadata.rule_id;
    return {
        gt_id: `verdict-${String(row.id ?? "").slice(0, 8)}`,
        measure_number: metadata.measure_number ?? null,
        note: row.note || finding.evidence || "",
        page: metadata.source_page_id ?? "",
        rule_id: ruleId ?? "",
        severity: finding.severity ?? "medium",
        source: canonicalKind === "user_miss" ? "user_miss" : "verdict",
        staff_label: metadata.staff_label ?? null,
        suppressed: canonicalKind === "suppressed",
        system_number: metadata.system_number ?? null,
    };
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
            v-if="isAdminFeedbackRoute"
            class="admin-page"
            aria-labelledby="admin-feedback-title"
        >
            <article class="admin-card">
                <div class="section-heading">
                    <div>
                        <p class="eyebrow">Feedback Admin</p>
                        <h2 id="admin-feedback-title">Finding verdict queue</h2>
                    </div>
                    <button class="button" type="button" @click="loadAdminFeedback">
                        Refresh
                    </button>
                </div>

                <p v-if="!user" class="auth-helper">
                    Sign in with an allowlisted admin email to review feedback.
                </p>
                <p v-else-if="adminFeedbackStatus === 'loading'" class="viewer-status">
                    Loading feedback.
                </p>
                <p v-if="adminFeedbackError" class="error-text">
                    {{ adminFeedbackError }}
                </p>
                <p
                    v-if="
                        user &&
                        adminFeedbackStatus === 'ready' &&
                        !adminFeedbackRows.length
                    "
                    class="viewer-status"
                >
                    No pending feedback.
                </p>

                <article
                    v-for="row in adminFeedbackRows"
                    :key="row.id"
                    class="admin-feedback-row"
                >
                    <div>
                        <strong>
                            {{ row.engraving_findings?.metadata_json?.rule_id ?? "rule" }}
                            · {{ row.verdict }}
                        </strong>
                        <p>
                            {{ row.engraving_findings?.evidence }}
                        </p>
                        <p v-if="row.engraving_findings?.recommendation">
                            {{ row.engraving_findings.recommendation }}
                        </p>
                    </div>
                    <textarea
                        v-model="row.__payloadText"
                        class="admin-feedback-payload"
                        rows="8"
                    />
                    <div class="admin-feedback-actions">
                        <button
                            class="button button--compact"
                            type="button"
                            :disabled="Boolean(row.__saving)"
                            @click="canonicalizeFeedback(row, 'accepted')"
                        >
                            Accepted
                        </button>
                        <button
                            class="button button--compact"
                            type="button"
                            :disabled="Boolean(row.__saving)"
                            @click="canonicalizeFeedback(row, 'suppressed')"
                        >
                            Suppressed
                        </button>
                        <button
                            class="button button--compact"
                            type="button"
                            :disabled="Boolean(row.__saving)"
                            @click="canonicalizeFeedback(row, 'known_false_positive')"
                        >
                            Known FP
                        </button>
                        <button
                            class="button button--compact"
                            type="button"
                            :disabled="Boolean(row.__saving)"
                            @click="canonicalizeFeedback(row, 'user_miss')"
                        >
                            User miss
                        </button>
                        <button
                            class="button button--compact"
                            type="button"
                            :disabled="Boolean(row.__saving)"
                            @click="canonicalizeFeedback(row, 'ignore')"
                        >
                            Ignore
                        </button>
                        <button
                            class="button button--compact"
                            type="button"
                            :disabled="Boolean(row.__saving)"
                            @click="canonicalizeFeedback(row, 'discard')"
                        >
                            Discard
                        </button>
                    </div>
                </article>
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
            v-if="
                !isAuthCallbackRoute &&
                !isOauthConsentRoute &&
                !isLegalRoute &&
                !isAdminFeedbackRoute
            "
            class="workspace"
        >
            <section class="upload-panel" aria-labelledby="upload-title">
                <div class="section-heading">
                    <div>
                        <p class="eyebrow">Upload</p>
                        <h2 id="upload-title">
                            {{
                                hasSubmittedUpload
                                    ? lastUpload.title
                                    : "PDF score"
                            }}
                        </h2>
                        <p v-if="hasSubmittedUpload" class="upload-subtitle">
                            {{ lastUpload.uploaded }} uploaded
                        </p>
                    </div>
                    <div v-if="hasSubmittedUpload" class="submitted-actions">
                        <button
                            class="button button--compact"
                            type="button"
                            @click="resetUpload"
                        >
                            Submit another
                        </button>
                        <a
                            v-if="pdfPreviewAssets[0]"
                            class="button button--compact"
                            :href="pdfPreviewAssets[0].previewUrl"
                            target="_blank"
                            rel="noreferrer"
                        >
                            PDF
                        </a>
                    </div>
                    <span v-else class="status-pill">{{ uploadStatus }}</span>
                </div>

                <div v-if="hasSubmittedUpload" class="submitted-workspace">
                    <div class="review-status-bar">
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
                        <p>{{ reviewMessage }}</p>
                        <strong v-if="findingCount">
                            {{ findingCount }} finding{{
                                findingCount === 1 ? "" : "s"
                            }}
                        </strong>
                    </div>

                    <div
                        v-if="pdfPreviewAssets.length"
                        class="pdf-preview-list"
                    >
                        <AnnotatedPdfViewer
                            :assets="pdfPreviewAssets"
                            :debug-geometry="debugGeometry"
                            :findings="pageFindings"
                            :review-status="reviewStatus"
                            @verdict="submitFindingVerdict"
                        />
                    </div>

                    <div
                        v-if="showDebugReviewJson"
                        class="fallback-review"
                    >
                        <div class="section-heading">
                            <div>
                                <p class="eyebrow">Debug geometry</p>
                                <h3>JSON output</h3>
                            </div>
                        </div>
                        <pre class="debug-json-output"><code>{{ debugReviewJson }}</code></pre>
                    </div>

                    <div
                        v-if="reviewText && !findingCount && !debugGeometry"
                        class="fallback-review"
                    >
                        <div class="section-heading">
                            <div>
                                <p class="eyebrow">Fallback review</p>
                                <h3>Text output</h3>
                            </div>
                        </div>
                        <ReviewMarkdown
                            class="review-output"
                            :content="reviewText"
                        />
                    </div>

                    <p v-if="reviewId" class="review-meta">
                        Review ID: {{ reviewId }}
                    </p>
                    <p v-if="reviewError" class="error-text">
                        {{ reviewError }}
                    </p>
                    <div class="review-actions">
                        <button
                            v-if="canPolishReview"
                            class="button"
                            type="button"
                            @click="polishReviewOutput"
                        >
                            Polish output
                        </button>
                        <button
                            v-if="canReconnectReview"
                            class="button"
                            type="button"
                            @click="reconnectReviewStream"
                        >
                            Reconnect
                        </button>
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

                    <div class="routing-control">
                        <div class="routing-control__header">
                            <span class="field-label">Instrumentation</span>
                            <div
                                class="segmented-control"
                                aria-label="Instrumentation mode"
                            >
                                <button
                                    class="segmented-control__button"
                                    :class="{
                                        'segmented-control__button--active':
                                            instrumentationMode === 'auto',
                                    }"
                                    type="button"
                                    :disabled="isUploading"
                                    @click="setInstrumentationMode('auto')"
                                >
                                    Auto-detect
                                </button>
                                <button
                                    class="segmented-control__button"
                                    :class="{
                                        'segmented-control__button--active':
                                            instrumentationMode === 'manual',
                                    }"
                                    type="button"
                                    :disabled="isUploading"
                                    @click="setInstrumentationMode('manual')"
                                >
                                    Select
                                </button>
                            </div>
                        </div>

                        <div
                            v-if="instrumentationMode === 'manual'"
                            class="instrument-chip-list"
                            aria-label="Instruments"
                        >
                            <button
                                v-for="instrument in INSTRUMENT_OPTIONS"
                                :key="instrument.value"
                                class="instrument-chip"
                                :class="{
                                    'instrument-chip--active':
                                        selectedInstruments.includes(
                                            instrument.value,
                                        ),
                                }"
                                type="button"
                                :aria-pressed="
                                    selectedInstruments.includes(instrument.value)
                                "
                                :disabled="isUploading"
                                @click="toggleInstrument(instrument.value)"
                            >
                                {{ instrument.label }}
                            </button>
                        </div>

                        <label class="field-label" for="doc-type"
                            >Document type</label
                        >
                        <select
                            id="doc-type"
                            v-model="selectedDocType"
                            class="select-input"
                            :disabled="isUploading"
                        >
                            <option
                                v-for="option in DOC_TYPE_OPTIONS"
                                :key="option.value"
                                :value="option.value"
                            >
                                {{ option.label }}
                            </option>
                        </select>
                    </div>

                    <label class="file-drop" for="composition-files">
                        <span>Choose PDF score files</span>
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
        </div>
    </main>
</template>
