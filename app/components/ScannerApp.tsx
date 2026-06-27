"use client";

import React, { useRef, useState, useCallback, useEffect } from "react";
import "./ScannerApp.css";

// ─── Types ────────────────────────────────────────────────────────────────────
interface ScannedQuestion {
    id: string;
    questionNumber: string;
    text: string;
    solution?: string;
    isSolving?: boolean;
}

type ImageSolveProvider = "chatgpt" | "gemini";

type ImageSolveStatusData = {
    jobId?: string;
    status?: string;
    error?: string;
    answer?: string;
    primaryAnswer?: string;
    primaryScreenshot?: string | null;
    primaryError?: string | null;
    browserError?: string | null;
    backupAnswer?: string | null;
    backupScreenshot?: string | null;
    backupStatus?: "idle" | "queued" | "solving" | "done" | "error";
    backupProvider?: ImageSolveProvider | string | null;
    backupError?: string | null;
    provider?: ImageSolveProvider | "gemini-api" | string | null;
    source?: string | null;
    fallbackRequired?: boolean;
};

type StoredImageSolveItem = {
    jobId: string;
    id: string; // fallback mapped to jobId
    createdAt: string;
    image: string; // mapped to URL
    status: "capturing" | "solving" | "done" | "error" | "superseded" | "primary_done" | "fallback_solving" | "backup_solving";
    primaryProvider: string;
    source: "camera" | "upload" | "browser";
    prompt?: string;
    answer?: string | null;
    screenshot?: string | null;
    answerProvider?: string | null;
    backupAnswer?: string | null;
    backupScreenshot?: string | null;
    backupStatus?: "idle" | "queued" | "solving" | "done" | "error";
    backupProvider?: string | null;
    backupError?: string | null;
    browserError?: string | null;
    error?: string | null;
};

type CaptureFrameOptions = {
    mimeType: "image/png" | "image/jpeg";
    quality: number;
    minQuality: number;
    maxWidth: number;
    maxHeight: number;
    maxDataUrlLength: number;
    mirrorHorizontal?: boolean;
};

// ─── Provider Catalog ─────────────────────────────────────────────────────────
const ALL_SOLVE_PROVIDERS: { id: string; label: string }[] = [
    { id: "chatgpt", label: "ChatGPT" },
    { id: "gemini", label: "Gemini" },
];

// ─── Capture options ──────────────────────────────────────────────────────────
const scanCaptureOptions: CaptureFrameOptions = {
    mimeType: "image/jpeg",
    quality: 0.82,
    minQuality: 0.55,
    maxWidth: 1280,
    maxHeight: 1280,
    maxDataUrlLength: 800_000,
};

const imageSolveCaptureOptions: CaptureFrameOptions = {
    mimeType: "image/jpeg",
    quality: 0.82,
    minQuality: 0.55,
    maxWidth: 1280,
    maxHeight: 1280,
    maxDataUrlLength: 800_000,
    mirrorHorizontal: true,
};

// ─── Utility helpers ──────────────────────────────────────────────────────────
const getErrorMessage = (error: unknown, fallback = "Image solve failed.") => {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return fallback;
};

const isImageDataUrl = (value: string) =>
    /^data:image\/[a-zA-Z0-9.+-]+(?:;[^,]*)?;base64,[A-Za-z0-9+/=\s]+$/.test(value);

const dataUrlByteSize = (dataUrl: string) => {
    const base64 = dataUrl.split(",", 2)[1] || "";
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
};

const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

const getProviderLabel = (provider: string | null | undefined) => {
    if (provider === "chatgpt") return "ChatGPT";
    if (provider === "gemini") return "Gemini";
    if (provider === "gemini-api") return "Gemini API";
    return "Image Solve";
};

const normalizeImageSolveProvider = (provider: string | null | undefined): ImageSolveProvider | null =>
    provider === "chatgpt" || provider === "gemini" ? provider : null;

const readImageSolveResponse = async (response: Response): Promise<ImageSolveStatusData> => {
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();

    if (!text.trim()) return {};

    try {
        return JSON.parse(text) as ImageSolveStatusData;
    } catch {
        const preview = text.replace(/\s+/g, " ").trim().slice(0, 240);
        const responseLabel = `${response.status} ${response.statusText}`.trim();
        return {
            error: `Image solve returned ${responseLabel || "a non-JSON response"}${contentType ? ` (${contentType})` : ""}${preview ? `: ${preview}` : "."}`,
        };
    }
};

// ─── DB code removed for global history ────────────────────────────────────────

// ─── Component ───────────────────────────────────────────────────────────────
export default function ScannerApp() {
    // ── Refs ──────────────────────────────────────────────────────────────────
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null!);
    const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
    const imageSolveRunIdRef = useRef(0);
    const cameraRunIdRef = useRef(0);
    const providerDragIndexRef = useRef<number | null>(null);

    // ── Scan mode ─────────────────────────────────────────────────────────────
    const [isCapturing, setIsCapturing] = useState(false);
    const [savedQuestions, setSavedQuestions] = useState<ScannedQuestion[]>([]);
    const [selectedQuestionIds, setSelectedQuestionIds] = useState<Set<string>>(new Set());
    const [isProcessingSolutions, setIsProcessingSolutions] = useState(false);
    const [expandedSolutionIds, setExpandedSolutionIds] = useState<Set<string>>(new Set());
    const [activeTab, setActiveTab] = useState<"all" | "unsolved" | "solved">("all");
    const [bottomTab, setBottomTab] = useState<"questions" | "imagesolve">("questions");

    // ── Settings ──────────────────────────────────────────────────────────────
    const defaultSolvePrompt =
        "You are an expert tutor. I am providing you with an array of questions extracted from a question paper.\nPlease solve each question accurately and provide a clear, step-by-step solution.";
    const [customSolvePrompt, setCustomSolvePrompt] = useState(defaultSolvePrompt);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

    // ── Edit mode ─────────────────────────────────────────────────────────────
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingText, setEditingText] = useState("");

    const [scanStatus, setScanStatus] = useState<"idle" | "scanning" | "success" | "error">("idle");
    const [errorMessage, setErrorMessage] = useState("");
    const [countdown, setCountdown] = useState<number | null>(null);
    const [captureDelay, setCaptureDelay] = useState(6);

    // ── Image Solve mode ──────────────────────────────────────────────────────
    const [imageSolveMode, setImageSolveMode] = useState(false);
    const [imageSolveStatus, setImageSolveStatus] = useState<"idle" | "capturing" | "solving" | "done" | "error">("idle");
    const [imageSolveAnswer, setImageSolveAnswer] = useState<string | null>(null);
    const [imageSolveScreenshot, setImageSolveScreenshot] = useState<string | null>(null);
    const [imageSolveBackupAnswer, setImageSolveBackupAnswer] = useState<string | null>(null);
    const [imageSolveBackupScreenshot, setImageSolveBackupScreenshot] = useState<string | null>(null);
    const [imageSolveBackupStatus, setImageSolveBackupStatus] = useState<"idle" | "queued" | "solving" | "done" | "error">("idle");
    const [imageSolveBackupError, setImageSolveBackupError] = useState<string | null>(null);
    const [imageSolveError, setImageSolveError] = useState<string | null>(null);
    const [imageSolveBrowserError, setImageSolveBrowserError] = useState<string | null>(null);
    const [imageSolveAnswerProvider, setImageSolveAnswerProvider] = useState<string | null>(null);
    const [imageSolveBackupProvider, setImageSolveBackupProvider] = useState<string | null>(null);
    const [imageSolveCountdown, setImageSolveCountdown] = useState<number | null>(null);
    const [expandedSolverScreenshot, setExpandedSolverScreenshot] = useState<{ src: string; label: string } | null>(null);
    const [imageSolveUploadMode, setImageSolveUploadMode] = useState(false);
    const [uploadedImagePreview, setUploadedImagePreview] = useState<string | null>(null);
    const [uploadedImageBase64, setUploadedImageBase64] = useState<string | null>(null);

    // ── Provider setup: ordered checklist ─────────────────────────────────────
    const [imageSolveProviderOrder, setImageSolveProviderOrder] = useState<string[]>(["chatgpt", "gemini"]);
    const [imageSolveProviderEnabled, setImageSolveProviderEnabled] = useState<Record<string, boolean>>({ chatgpt: true, gemini: true });
    const [providerDragOver, setProviderDragOver] = useState<number | null>(null);

    // ── Retry ─────────────────────────────────────────────────────────────────
    const [lastSolvedImageBase64, setLastSolvedImageBase64] = useState<string | null>(null);
    const [lastSolvedPrompt, setLastSolvedPrompt] = useState<string | null>(null);

    // ── Image solve results stack ─────────────────────────────────────────────
    const [imageSolveResults, setImageSolveResults] = useState<StoredImageSolveItem[]>([]);
    const [isImageSolveResultsLoaded, setIsImageSolveResultsLoaded] = useState(false);

    // ── Mount state ───────────────────────────────────────────────────────────
    const [mounted, setMounted] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);
    const [cameraError, setCameraError] = useState<string | null>(null);

    // ── Initial load ──────────────────────────────────────────────────────────
    useEffect(() => {
        const stored = localStorage.getItem("scannerApp_savedQuestions");
        if (stored) {
            try {
                const parsed: ScannedQuestion[] = JSON.parse(stored);
                const seenIds = new Set<string>();
                const sanitized = parsed.map((q) => {
                    let uniqueId = q.id;
                    if (!uniqueId || seenIds.has(uniqueId) || uniqueId.length < 5) {
                        uniqueId = `q-rec-${Math.random().toString(36).substring(2, 10)}`;
                    }
                    seenIds.add(uniqueId);
                    return { ...q, id: uniqueId };
                });
                setSavedQuestions(sanitized);
            } catch (error) {
                console.error("Failed to load saved questions", error);
            }
        }

        const storedPrompt = localStorage.getItem("scannerApp_solvePrompt");
        if (storedPrompt) setCustomSolvePrompt(storedPrompt);

        const storedOrder = localStorage.getItem("scannerApp_imageSolveProviderOrder");
        if (storedOrder) {
            try {
                const parsed = JSON.parse(storedOrder);
                if (Array.isArray(parsed) && parsed.length > 0) setImageSolveProviderOrder(parsed);
            } catch { /* ignore */ }
        }

        const storedEnabled = localStorage.getItem("scannerApp_imageSolveProviderEnabled");
        if (storedEnabled) {
            try {
                const parsed = JSON.parse(storedEnabled);
                if (parsed && typeof parsed === "object") setImageSolveProviderEnabled(parsed);
            } catch { /* ignore */ }
        }

        setIsLoaded(true);
        setMounted(true);
    }, []);

    // ── Persist state ─────────────────────────────────────────────────────────
    useEffect(() => {
        if (isLoaded) {
            localStorage.setItem("scannerApp_savedQuestions", JSON.stringify(savedQuestions));
            localStorage.setItem("scannerApp_solvePrompt", customSolvePrompt);
            localStorage.setItem("scannerApp_imageSolveProviderOrder", JSON.stringify(imageSolveProviderOrder));
            localStorage.setItem("scannerApp_imageSolveProviderEnabled", JSON.stringify(imageSolveProviderEnabled));
        }
    }, [savedQuestions, customSolvePrompt, imageSolveProviderOrder, imageSolveProviderEnabled, isLoaded]);

    // ── Load image solve history ──────────────────────────────────────────────
    const fetchHistory = useCallback(async () => {
        try {
            const res = await fetch("/api/image-solve/history");
            if (res.ok) {
                const data = await res.json();
                if (data.history) {
                    const mapped: StoredImageSolveItem[] = data.history.map((job: any) => {
                        let imageUrl = "";
                        if (job.imageSolveCapture && job.imageSolveCapture.filename) {
                            imageUrl = `/api/image-solve/captures/${job.imageSolveCapture.filename}`;
                        }
                        return {
                            ...job,
                            id: job.jobId,
                            image: imageUrl,
                            screenshot: job.primaryScreenshot || null,
                            backupScreenshot: job.backupScreenshot || null,
                            source: "browser",
                            primaryProvider: job.provider,
                            answerProvider: job.primaryScreenshot ? job.provider : (job.backupScreenshot ? job.backupProvider : null),
                            status: job.status,
                            createdAt: job.createdAt || new Date().toISOString(),
                        };
                    });
                    setImageSolveResults(mapped);
                }
            }
        } catch (error) {
            console.error("Failed to load global history", error);
        } finally {
            setIsImageSolveResultsLoaded(true);
        }
    }, []);

    useEffect(() => {
        if (!mounted) return;
        fetchHistory();
    }, [mounted, fetchHistory]);

    // ── Camera ────────────────────────────────────────────────────────────────
    const stopCamera = useCallback(() => {
        cameraRunIdRef.current += 1;
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
    }, []);

    const startCamera = useCallback(async () => {
        setCameraError(null);
        stopCamera();
        const runId = cameraRunIdRef.current + 1;
        cameraRunIdRef.current = runId;

        try {
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error("This browser does not expose camera capture APIs.");
            }

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    width: { ideal: 2560 },
                    height: { ideal: 1440 },
                    aspectRatio: { ideal: 16 / 9 },
                    facingMode: { ideal: "user" },
                },
            });

            if (cameraRunIdRef.current !== runId) {
                stream.getTracks().forEach((track) => track.stop());
                return;
            }

            streamRef.current = stream;
            const video = videoRef.current;
            if (video) {
                video.srcObject = stream;
                await video.play();
            }

            // Auto-restart if the hardware track dies (e.g. camera taken by another app)
            const track = stream.getVideoTracks()[0];
            if (track) {
                const settings = track.getSettings();
                console.log(`Camera stream active at ${settings?.width || "?"}x${settings?.height || "?"}`);
                track.addEventListener("ended", () => {
                    if (cameraRunIdRef.current === runId) {
                        console.warn("Camera track ended unexpectedly, restarting...");
                        startCamera();
                    }
                });
            }
        } catch (error) {
            const message = getErrorMessage(error, "Could not start camera.");
            console.error("Camera start error:", error);
            setCameraError(message);
            stopCamera();
        }
    }, [stopCamera]);

    useEffect(() => {
        if (!mounted) return;
        startCamera();
        return () => stopCamera();
    }, [mounted, startCamera, stopCamera]);

    // ── Canvas capture helpers ────────────────────────────────────────────────
    const drawCaptureToCanvas = useCallback((
        source: CanvasImageSource,
        sourceWidth: number,
        sourceHeight: number,
        flip: boolean,
        options: CaptureFrameOptions,
    ) => {
        const scale = Math.min(1, options.maxWidth / sourceWidth, options.maxHeight / sourceHeight);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(sourceWidth * scale));
        canvas.height = Math.max(1, Math.round(sourceHeight * scale));
        const ctx = canvas.getContext("2d", { alpha: false });

        if (!ctx) throw new Error("Could not create image capture canvas.");

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = scale < 1;
        ctx.imageSmoothingQuality = "high";
        if (flip) {
            ctx.translate(canvas.width, 0);
            ctx.scale(-1, 1);
        }
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        return canvas;
    }, []);

    const encodeCanvasWithinLimit = useCallback((sourceCanvas: HTMLCanvasElement, options: CaptureFrameOptions) => {
        let canvas = sourceCanvas;
        let quality = options.quality;
        let dataUrl = canvas.toDataURL(options.mimeType, quality);
        let attempts = 0;

        while (dataUrl.length > options.maxDataUrlLength && attempts < 12) {
            attempts += 1;
            if (quality > options.minQuality + 0.01) {
                quality = Math.max(options.minQuality, quality - 0.08);
            } else {
                const resizedCanvas = document.createElement("canvas");
                resizedCanvas.width = Math.max(1, Math.round(canvas.width * 0.84));
                resizedCanvas.height = Math.max(1, Math.round(canvas.height * 0.84));
                const resizedCtx = resizedCanvas.getContext("2d", { alpha: false });
                if (!resizedCtx) throw new Error("Could not resize captured image.");
                resizedCtx.fillStyle = "#ffffff";
                resizedCtx.fillRect(0, 0, resizedCanvas.width, resizedCanvas.height);
                resizedCtx.imageSmoothingEnabled = true;
                resizedCtx.imageSmoothingQuality = "high";
                resizedCtx.drawImage(canvas, 0, 0, resizedCanvas.width, resizedCanvas.height);
                canvas = resizedCanvas;
                quality = options.quality;
            }
            dataUrl = canvas.toDataURL(options.mimeType, quality);
        }

        if (dataUrl.length > options.maxDataUrlLength) {
            throw new Error(
                `Captured image is still too large after compression (${formatBytes(dataUrlByteSize(dataUrl))}). Move the paper closer and try again.`
            );
        }

        console.log(
            `Encoded capture ${canvas.width}x${canvas.height} as ${options.mimeType} (${formatBytes(dataUrlByteSize(dataUrl))}, ${dataUrl.length} chars).`
        );
        return dataUrl;
    }, []);

    const captureHighQualityFrame = useCallback(async (options = scanCaptureOptions) => {
        const video = videoRef.current;
        if (!video) return null;

        if (video.videoWidth && video.videoHeight) {
            const canvas = drawCaptureToCanvas(
                video, video.videoWidth, video.videoHeight,
                Boolean(options.mirrorHorizontal), options
            );
            console.log(`Captured video frame at ${video.videoWidth}x${video.videoHeight}`);
            return encodeCanvasWithinLimit(canvas, options);
        }

        return null;
    }, [drawCaptureToCanvas, encodeCanvasWithinLimit]);

    const getCaptureResolution = () => {
        const video = videoRef.current;
        if (!video) return null;
        return { width: video.videoWidth, height: video.videoHeight };
    };

    // ── Scan mode capture ─────────────────────────────────────────────────────
    const capture = useCallback(async (autoTriggered = false) => {
        if (!videoRef.current) return;

        if (autoTriggered) {
            try { if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]); } catch { }
        }

        setIsCapturing(true);
        setScanStatus("scanning");
        setErrorMessage("");

        setTimeout(() => setIsCapturing(false), 500);

        const base64Image = await captureHighQualityFrame(scanCaptureOptions);
        if (!base64Image) {
            setScanStatus("error");
            setErrorMessage("Failed to capture image from camera.");
            return;
        }

        try {
            const resolution = getCaptureResolution();
            if (resolution?.width && resolution?.height) {
                console.log(`Captured scan frame at ${resolution.width}x${resolution.height}`);
            }

            const response = await fetch("/api/scan", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ image: base64Image }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `API returned ${response.status}`);
            }

            const data = await response.json();
            const newQuestions: ScannedQuestion[] = data.questions || [];

            setSavedQuestions(prev => {
                const updatedList = [...prev];
                newQuestions.forEach(newQ => {
                    const getLexicalPrefix = (str: string) => str.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().substring(0, 25);
                    const newPrefix = getLexicalPrefix(newQ.text || "");
                    const isSimilar = updatedList.some(existingQ => {
                        const existingPrefix = getLexicalPrefix(existingQ.text || "");
                        const minLength = Math.min(newPrefix.length, existingPrefix.length);
                        if (minLength < 15) {
                            return newPrefix === existingPrefix && newPrefix.length > 5;
                        }
                        return newPrefix.startsWith(existingPrefix) || existingPrefix.startsWith(newPrefix);
                    });
                    if (!isSimilar) {
                        updatedList.push({
                            ...newQ,
                            id: `q-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
                        });
                    }
                });
                return updatedList;
            });

            setScanStatus("success");
        } catch (error: unknown) {
            console.error("Scan error:", error);
            setScanStatus("error");
            setErrorMessage(getErrorMessage(error, "Failed to process the question paper."));
        }
    }, [captureHighQualityFrame]);

    // ── Countdown for scan ────────────────────────────────────────────────────
    useEffect(() => {
        if (countdown === null) return;
        if (countdown > 0) {
            const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
            try { if ("vibrate" in navigator) navigator.vibrate(50); } catch { }
            return () => clearTimeout(timer);
        } else if (countdown === 0) {
            setCountdown(null);
            capture(true);
        }
    }, [countdown, capture]);

    const startManualScan = () => {
        if (scanStatus === "scanning" || countdown !== null) return;
        setCountdown(captureDelay);
    };

    // ── Image Solve: shared result apply ──────────────────────────────────────
    const clearImageSolveResult = useCallback(() => {
        imageSolveRunIdRef.current += 1;
        setImageSolveStatus("idle");
        setImageSolveAnswer(null);
        setImageSolveScreenshot(null);
        setImageSolveBackupAnswer(null);
        setImageSolveBackupScreenshot(null);
        setImageSolveBackupStatus("idle");
        setImageSolveBackupError(null);
        setImageSolveError(null);
        setImageSolveBrowserError(null);
        setImageSolveAnswerProvider(null);
        setImageSolveBackupProvider(null);
        setImageSolveCountdown(null);
        setExpandedSolverScreenshot(null);
    }, []);

    // ── Image Solve: camera capture → solve ───────────────────────────────────
    const captureAndImageSolve = useCallback(async () => {
        if (!videoRef.current || imageSolveStatus === "solving" || imageSolveStatus === "capturing") return;

        const runId = imageSolveRunIdRef.current + 1;
        imageSolveRunIdRef.current = runId;
        const isCurrentRun = () => imageSolveRunIdRef.current === runId;

        setImageSolveStatus("capturing");
        setImageSolveAnswer(null);
        setImageSolveScreenshot(null);
        setImageSolveBackupAnswer(null);
        setImageSolveBackupScreenshot(null);
        setImageSolveBackupStatus("idle");
        setImageSolveBackupError(null);
        setImageSolveError(null);
        setImageSolveBrowserError(null);
        setImageSolveAnswerProvider(null);

        // Derive providers from the ordered+enabled list
        const enabledProviders = imageSolveProviderOrder.filter(p => imageSolveProviderEnabled[p]);
        const requestPrimaryProvider = (enabledProviders[0] ?? "chatgpt") as ImageSolveProvider;
        const requestBackupProvider = (enabledProviders[1] ?? null) as ImageSolveProvider | null;
        setImageSolveBackupProvider(requestBackupProvider);

        // Global polling will pick up the new job automatically, so we don't upsert locally.

        let base64Image: string | null = null;
        try {
            base64Image = await captureHighQualityFrame(imageSolveCaptureOptions);
        } catch (err: unknown) {
            if (!isCurrentRun()) return;
            setImageSolveStatus("error");
            setImageSolveError(`Image capture failed: ${getErrorMessage(err)}`);
            return;
        }

        if (!isCurrentRun()) return;

        if (!base64Image) {
            setImageSolveStatus("error");
            setImageSolveError("Failed to capture image from camera.");
            return;
        }

        if (!isImageDataUrl(base64Image)) {
            setImageSolveStatus("error");
            setImageSolveError("Captured image was not a valid base64 image data URL.");
            return;
        }

        const resolution = getCaptureResolution();
        if (resolution?.width && resolution?.height) {
            console.log(`Captured image-solve frame at ${resolution.width}x${resolution.height}`);
        }

        // Store for retry
        setLastSolvedImageBase64(base64Image);
        setLastSolvedPrompt(customSolvePrompt);

        setImageSolveStatus("solving");

        try {
            const response = await fetch("/api/image-solve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    image: base64Image,
                    prompt: customSolvePrompt,
                    primaryProvider: requestPrimaryProvider,
                    backupProvider: requestBackupProvider,
                }),
            });

            const data = await readImageSolveResponse(response);

            if (!isCurrentRun()) return;

            if (!response.ok || (data.error && !data.jobId && !data.fallbackRequired)) {
                throw new Error(data.error || `Server returned ${response.status}`);
            }

            const applyImageSolveData = (statusData: ImageSolveStatusData) => {
                if (!isCurrentRun()) return true;

                const browserError =
                    statusData.browserError ||
                    statusData.primaryError ||
                    (!statusData.primaryAnswer && statusData.error ? statusData.error : null);

                if (browserError) {
                    setImageSolveBrowserError(browserError);
                }

                const primaryAnswer = statusData.primaryAnswer || statusData.answer;
                const primaryScreenshot = statusData.primaryScreenshot;
                const resultProvider = statusData.provider || statusData.source || requestPrimaryProvider;

                if (primaryScreenshot) {
                    setImageSolveScreenshot(primaryScreenshot);
                    setImageSolveAnswerProvider(resultProvider);
                    setImageSolveStatus("done");
                }

                if (primaryAnswer) {
                    setImageSolveAnswer(primaryAnswer);
                    setImageSolveAnswerProvider(resultProvider);
                    setImageSolveStatus("done");
                }

                if (statusData.backupStatus) {
                    setImageSolveBackupStatus(statusData.backupStatus);
                }

                const normalizedBackupProvider = normalizeImageSolveProvider(statusData.backupProvider);
                if (normalizedBackupProvider) {
                    setImageSolveBackupProvider(normalizedBackupProvider);
                }

                if (statusData.backupAnswer) {
                    setImageSolveBackupAnswer(statusData.backupAnswer);
                    setImageSolveBackupStatus("done");
                }

                if (statusData.backupScreenshot) {
                    setImageSolveBackupScreenshot(statusData.backupScreenshot);
                    setImageSolveBackupStatus("done");
                    if (!primaryScreenshot && !primaryAnswer) {
                        setImageSolveAnswerProvider(normalizedBackupProvider || statusData.provider || requestBackupProvider);
                        setImageSolveStatus("done");
                    }
                }

                if (statusData.backupError) {
                    setImageSolveBackupError(statusData.backupError);
                    setImageSolveBackupStatus("error");
                }

                if (!primaryAnswer && !primaryScreenshot && statusData.status === "error") {
                    setImageSolveError(statusData.error || "Image solve failed.");
                    setImageSolveStatus("error");
                    return true;
                }

                return (
                    statusData.backupStatus === "done" ||
                    statusData.backupStatus === "error" ||
                    Boolean(statusData.backupAnswer) ||
                    Boolean(statusData.backupScreenshot) ||
                    Boolean(statusData.backupError)
                );
            };

            applyImageSolveData(data);

            if (data.jobId) {
                const pollInterval = setInterval(async () => {
                    try {
                        if (!isCurrentRun()) { clearInterval(pollInterval); return; }
                        const statusRes = await fetch(`/api/image-solve/status?jobId=${data.jobId}`);
                        if (!statusRes.ok) return;
                        const statusData = await readImageSolveResponse(statusRes);
                        const shouldStop = applyImageSolveData(statusData);
                        if (shouldStop) clearInterval(pollInterval);
                    } catch (e: unknown) {
                        console.error("Status poll error:", e);
                    }
                }, 3000);
            } else if (!data.primaryScreenshot && !data.backupScreenshot) {
                setImageSolveAnswer(data.answer || "(No answer returned)");
                setImageSolveAnswerProvider(data.provider || data.source || null);
                setImageSolveStatus("done");
            }
        } catch (err: unknown) {
            if (!isCurrentRun()) return;
            const message = getErrorMessage(err);
            setImageSolveError(message);
            setImageSolveStatus("error");
        }
    }, [imageSolveStatus, customSolvePrompt, imageSolveProviderOrder, imageSolveProviderEnabled, captureHighQualityFrame]);

    // ── Image Solve: solve from image (upload or retry) ───────────────────────
    const solveWithUploadedImage = useCallback(async (base64Image: string, promptOverride?: string) => {
        if (imageSolveStatus === "solving" || imageSolveStatus === "capturing") return;

        const runId = imageSolveRunIdRef.current + 1;
        imageSolveRunIdRef.current = runId;
        const isCurrentRun = () => imageSolveRunIdRef.current === runId;

        const solvePrompt = promptOverride ?? customSolvePrompt;

        setImageSolveStatus("solving");
        setImageSolveAnswer(null);
        setImageSolveScreenshot(null);
        setImageSolveBackupAnswer(null);
        setImageSolveBackupScreenshot(null);
        setImageSolveBackupStatus("idle");
        setImageSolveBackupError(null);
        setImageSolveError(null);
        setImageSolveBrowserError(null);
        setImageSolveAnswerProvider(null);

        // Derive providers from the ordered+enabled list
        const enabledProviders = imageSolveProviderOrder.filter(p => imageSolveProviderEnabled[p]);
        const requestPrimaryProvider = (enabledProviders[0] ?? "chatgpt") as ImageSolveProvider;
        const requestBackupProvider = (enabledProviders[1] ?? null) as ImageSolveProvider | null;
        setImageSolveBackupProvider(requestBackupProvider);

        // Store for retry
        setLastSolvedImageBase64(base64Image);
        setLastSolvedPrompt(solvePrompt);

        // Global polling will pick up the new job automatically, so we don't upsert locally.

        try {
            const response = await fetch("/api/image-solve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    image: base64Image,
                    prompt: solvePrompt,
                    primaryProvider: requestPrimaryProvider,
                    backupProvider: requestBackupProvider,
                }),
            });

            const data = await readImageSolveResponse(response);
            if (!isCurrentRun()) return;

            if (!response.ok || (data.error && !data.jobId && !data.fallbackRequired)) {
                throw new Error(data.error || `Server returned ${response.status}`);
            }

            const applyData = (statusData: ImageSolveStatusData) => {
                if (!isCurrentRun()) return true;
                const browserError =
                    statusData.browserError ||
                    statusData.primaryError ||
                    (!statusData.primaryAnswer && statusData.error ? statusData.error : null);
                if (browserError) {
                    setImageSolveBrowserError(browserError);
                }
                const primaryAnswer = statusData.primaryAnswer || statusData.answer;
                const primaryScreenshot = statusData.primaryScreenshot;
                const resultProvider = statusData.provider || statusData.source || requestPrimaryProvider;
                if (primaryScreenshot) {
                    setImageSolveScreenshot(primaryScreenshot);
                    setImageSolveAnswerProvider(resultProvider);
                    setImageSolveStatus("done");
                }
                if (primaryAnswer) {
                    setImageSolveAnswer(primaryAnswer);
                    setImageSolveAnswerProvider(resultProvider);
                    setImageSolveStatus("done");
                }
                if (statusData.backupStatus) {
                    setImageSolveBackupStatus(statusData.backupStatus);
                }
                const normBackup = normalizeImageSolveProvider(statusData.backupProvider);
                if (normBackup) {
                    setImageSolveBackupProvider(normBackup);
                }
                if (statusData.backupAnswer) {
                    setImageSolveBackupAnswer(statusData.backupAnswer);
                    setImageSolveBackupStatus("done");
                }
                if (statusData.backupScreenshot) {
                    setImageSolveBackupScreenshot(statusData.backupScreenshot);
                    setImageSolveBackupStatus("done");
                    if (!primaryScreenshot && !primaryAnswer) {
                        setImageSolveAnswerProvider(normBackup || statusData.provider || requestBackupProvider);
                        setImageSolveStatus("done");
                    }
                }
                if (statusData.backupError) {
                    setImageSolveBackupError(statusData.backupError);
                    setImageSolveBackupStatus("error");
                }
                if (!primaryAnswer && !primaryScreenshot && statusData.status === "error") {
                    const message = statusData.error || "Image solve failed.";
                    setImageSolveError(message);
                    setImageSolveStatus("error");
                    return true;
                }
                return (
                    statusData.backupStatus === "done" ||
                    statusData.backupStatus === "error" ||
                    Boolean(statusData.backupAnswer) ||
                    Boolean(statusData.backupScreenshot) ||
                    Boolean(statusData.backupError)
                );
            };

            applyData(data);

            if (data.jobId) {
                const pollInterval = setInterval(async () => {
                    try {
                        if (!isCurrentRun()) { clearInterval(pollInterval); return; }
                        const statusRes = await fetch(`/api/image-solve/status?jobId=${data.jobId}`);
                        if (!statusRes.ok) return;
                        const statusData = await readImageSolveResponse(statusRes);
                        if (applyData(statusData)) clearInterval(pollInterval);
                    } catch (e: unknown) { console.error("Status poll error:", e); }
                }, 3000);
            } else if (!data.primaryScreenshot && !data.backupScreenshot) {
                setImageSolveAnswer(data.answer || "(No answer returned)");
                setImageSolveAnswerProvider(data.provider || data.source || null);
                setImageSolveStatus("done");
            }
        } catch (err: unknown) {
            if (!isCurrentRun()) return;
            const message = getErrorMessage(err);
            setImageSolveError(message);
            setImageSolveStatus("error");
        }
    }, [imageSolveStatus, customSolvePrompt, imageSolveProviderOrder, imageSolveProviderEnabled]);

    // ── Retry current result ──────────────────────────────────────────────────
    const handleRetry = useCallback(() => {
        const img = lastSolvedImageBase64;
        const prompt = lastSolvedPrompt ?? customSolvePrompt;
        if (!img) return;
        clearImageSolveResult();
        // Allow state reset to flush, then start the new solve
        setTimeout(() => solveWithUploadedImage(img, prompt), 0);
    }, [lastSolvedImageBase64, lastSolvedPrompt, customSolvePrompt, clearImageSolveResult, solveWithUploadedImage]);

    // ── Retry from history card ───────────────────────────────────────────────
    const handleRetryItem = useCallback((item: StoredImageSolveItem) => {
        if (!item.image) return;
        clearImageSolveResult();
        setTimeout(() => solveWithUploadedImage(item.image, item.prompt), 0);
    }, [clearImageSolveResult, solveWithUploadedImage]);

    const handleDeleteItem = useCallback(async (jobId: string) => {
        if (!window.confirm("Are you sure you want to permanently delete this record?")) return;
        try {
            const res = await fetch(`/api/image-solve/${jobId}`, { method: 'DELETE' });
            if (res.ok) {
                setImageSolveResults(prev => prev.filter(item => item.id !== jobId));
            } else {
                alert("Failed to delete record.");
            }
        } catch (err) {
            alert("Error deleting record.");
        }
    }, []);

    // ── File upload ───────────────────────────────────────────────────────────
    const handleFileUpload = useCallback((file: File) => {
        if (!file.type.startsWith("image/")) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target?.result as string;
            if (!dataUrl) return;
            setUploadedImagePreview(dataUrl);
            setUploadedImageBase64(dataUrl);
            clearImageSolveResult();
        };
        reader.readAsDataURL(file);
    }, [clearImageSolveResult]);

    // ── Countdown for image solve ─────────────────────────────────────────────
    const startImageSolve = () => {
        if (
            imageSolveStatus === "solving" ||
            imageSolveStatus === "capturing" ||
            imageSolveBackupStatus === "queued" ||
            imageSolveBackupStatus === "solving" ||
            imageSolveCountdown !== null
        ) return;
        setImageSolveCountdown(captureDelay);
    };

    useEffect(() => {
        if (imageSolveCountdown === null) return;
        if (imageSolveCountdown > 0) {
            const timer = setTimeout(() => setImageSolveCountdown(imageSolveCountdown - 1), 1000);
            try { if ("vibrate" in navigator) navigator.vibrate(50); } catch { }
            return () => clearTimeout(timer);
        } else {
            setImageSolveCountdown(null);
            captureAndImageSolve();
        }
    }, [imageSolveCountdown, captureAndImageSolve]);

    // ── Solve selected questions ──────────────────────────────────────────────
    const processSelectedQuestions = async () => {
        if (selectedQuestionIds.size === 0 || isProcessingSolutions) return;

        setIsProcessingSolutions(true);
        setSavedQuestions(prev => prev.map(q =>
            selectedQuestionIds.has(q.id) ? { ...q, isSolving: true } : q
        ));

        try {
            const questionsToSend = Array.from(selectedQuestionIds)
                .map(id => {
                    const q = savedQuestions.find(sq => sq.id === id);
                    return q ? { id: q.id, text: q.text } : null;
                })
                .filter(Boolean);

            const response = await fetch("/api/solve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ questions: questionsToSend, customSolvePrompt }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `API returned ${response.status}`);
            }

            const data = await response.json();
            const solutions: Record<string, string> = data.solutions || {};

            setSavedQuestions(prev => prev.map(q => {
                if (selectedQuestionIds.has(q.id) && solutions[q.id]) {
                    return { ...q, solution: solutions[q.id], isSolving: false };
                }
                return { ...q, isSolving: false };
            }));

            setExpandedSolutionIds(prev => {
                const next = new Set(prev);
                selectedQuestionIds.forEach(id => { if (solutions[id]) next.add(id); });
                return next;
            });

            setSelectedQuestionIds(new Set());
        } catch (error: unknown) {
            console.error("Solve error:", error);
            alert("Failed to process solutions: " + getErrorMessage(error));
            setSavedQuestions(prev => prev.map(q => ({ ...q, isSolving: false })));
        } finally {
            setIsProcessingSolutions(false);
        }
    };

    // ── Provider Reordering ───────────────────────────────────────────────────
    const moveProviderUp = (index: number) => {
        if (index <= 0) return;
        const newOrder = [...imageSolveProviderOrder];
        [newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]];
        setImageSolveProviderOrder(newOrder);
    };

    const moveProviderDown = (index: number) => {
        if (index >= imageSolveProviderOrder.length - 1) return;
        const newOrder = [...imageSolveProviderOrder];
        [newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]];
        setImageSolveProviderOrder(newOrder);
    };

    // ── Misc scan helpers ─────────────────────────────────────────────────────
    const resetScanner = () => {
        setScanStatus("idle");
        setErrorMessage("");
        setCountdown(null);
    };

    const clearAllQuestions = () => {
        setSavedQuestions([]);
        setSelectedQuestionIds(new Set());
        setScanStatus("idle");
    };

    const deleteQuestion = (idToDelete: string) => {
        setSavedQuestions(prev => prev.filter(q => q.id !== idToDelete));
        setSelectedQuestionIds(prev => { const next = new Set(prev); next.delete(idToDelete); return next; });
        setExpandedSolutionIds(prev => { const next = new Set(prev); next.delete(idToDelete); return next; });
    };

    const toggleSolutionExpanded = (id: string) => {
        setExpandedSolutionIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handleCardClick = (id: string, hasSolution: boolean) => {
        if (editingId === id) return;
        if (hasSolution) toggleSolutionExpanded(id); else toggleSelection(id);
    };

    const toggleSelection = (id: string) => {
        if (editingId === id) return;
        setSelectedQuestionIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handlePointerDown = (q: ScannedQuestion) => {
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = setTimeout(() => {
            setEditingId(q.id);
            setEditingText(q.text);
            try { if ("vibrate" in navigator) navigator.vibrate(50); } catch { }
        }, 600);
    };

    const handlePointerUp = () => { if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current); };
    const handlePointerLeave = () => { if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current); };

    const saveEdit = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setSavedQuestions(prev => prev.map(q => q.id === id ? { ...q, text: editingText } : q));
        setEditingId(null);
        setEditingText("");
    };

    const cancelEdit = (e: React.MouseEvent) => {
        e.stopPropagation();
        setEditingId(null);
        setEditingText("");
    };

    const filteredQuestions = savedQuestions.filter(q => {
        if (activeTab === "all") return true;
        if (activeTab === "solved") return !!q.solution;
        if (activeTab === "unsolved") return !q.solution;
        return true;
    });

    if (!mounted) return null;

    // ── Derived UI values ─────────────────────────────────────────────────────
    const imageSolveBusy =
        imageSolveStatus === "solving" ||
        imageSolveStatus === "capturing" ||
        imageSolveBackupStatus === "queued" ||
        imageSolveBackupStatus === "solving";

    const imageSolveSelectorLocked =
        imageSolveStatus === "solving" ||
        imageSolveStatus === "capturing" ||
        imageSolveCountdown !== null;

    const enabledProviders = imageSolveProviderOrder.filter(p => imageSolveProviderEnabled[p]);
    const activePrimaryProvider = enabledProviders[0] ?? null;
    const activeBackupProvider = enabledProviders[1] ?? null;

    const imageSolveProviderLabel =
        imageSolveAnswerProvider === "chatgpt" ? "ChatGPT Browser" :
            imageSolveAnswerProvider === "gemini" ? "Gemini Browser" :
                imageSolveAnswerProvider === "gemini-api" ? "Gemini API" :
                    "Image Solve";

    const imageSolvePrimaryLabel = getProviderLabel(activePrimaryProvider);
    const imageSolveDisplayedBackupProvider = imageSolveBackupProvider || activeBackupProvider;
    const imageSolveBackupLabel = getProviderLabel(imageSolveDisplayedBackupProvider);

    const hasImageSolveResult =
        (imageSolveStatus === "done" || imageSolveStatus === "error") &&
        Boolean(imageSolveAnswer || imageSolveScreenshot || imageSolveBackupAnswer || imageSolveBackupScreenshot || imageSolveError);

    const canRetry = hasImageSolveResult && Boolean(lastSolvedImageBase64) && !imageSolveBusy;

    // ─── Render ───────────────────────────────────────────────────────────────
    return (
        <div className="scanner-layout">
            {/* Left side: Camera Viewport + Controls */}
            <div className="scanner-section">
                <div className="webcam-container">
                    <video
                        ref={videoRef}
                        className={`webcam-preview ${isCapturing ? "capture-flash" : ""}`}
                        autoPlay
                        muted
                        playsInline
                        onError={() => {
                            console.warn("Video element error — restarting camera.");
                            startCamera();
                        }}
                    />
                    {cameraError && (
                        <div className="camera-error-overlay">
                            <div>
                                <div style={{ marginBottom: '0.75rem' }}>{cameraError}</div>
                                <button
                                    onClick={startCamera}
                                    style={{
                                        background: 'hsl(var(--accent-primary))',
                                        color: '#fff',
                                        border: 'none',
                                        borderRadius: 'var(--radius-sm)',
                                        padding: '0.5rem 1.2rem',
                                        fontWeight: 700,
                                        cursor: 'pointer',
                                        fontSize: '0.9rem',
                                    }}
                                >
                                    ↺ Retry Camera
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Scanning overlay */}
                    {scanStatus === "scanning" && (
                        <div className="scanning-overlay">
                            <div className="scan-line"></div>
                            <div className="scan-text">Analyzing intelligence...</div>
                        </div>
                    )}

                    {/* Countdown Overlay */}
                    {((countdown !== null && countdown > 0) || (imageSolveCountdown !== null && imageSolveCountdown > 0)) && (
                        <div className="countdown-overlay">
                            <span className="countdown-text">{countdown ?? imageSolveCountdown}</span>
                        </div>
                    )}

                    <div className="camera-corners">
                        <div className="corner top-left"></div>
                        <div className="corner top-right"></div>
                        <div className="corner bottom-left"></div>
                        <div className="corner bottom-right"></div>
                    </div>
                </div>

                <div className="controls">
                    {/* Mode toggle */}
                    <div className="solve-mode-toggle">
                        <button
                            className={`mode-btn ${!imageSolveMode ? 'active' : ''}`}
                            onClick={() => {
                                if (!imageSolveMode) return;
                                setImageSolveMode(false);
                                clearImageSolveResult();
                            }}
                        >
                            📄 Scan Mode
                        </button>
                        <button
                            className={`mode-btn ${imageSolveMode ? 'active' : ''}`}
                            onClick={() => {
                                if (imageSolveMode) return;
                                setImageSolveMode(true);
                                clearImageSolveResult();
                                setBottomTab("imagesolve");
                            }}
                        >
                            🧠 Image Solve
                        </button>
                    </div>

                    {!imageSolveMode ? (
                        <>
                            <button
                                className={`capture-btn ${countdown !== null ? 'counting' : ''}`}
                                onClick={startManualScan}
                                disabled={scanStatus === "scanning" || countdown !== null}
                            >
                                <div className="capture-inner"></div>
                            </button>
                            <p className="instruction-text" style={{ marginTop: '0.5rem', marginBottom: '1.5rem' }}>
                                {countdown !== null
                                    ? "Position paper. Capturing soon..."
                                    : `Tap to start ${captureDelay}-second scan timer`}
                            </p>

                            <div className="delay-slider-container">
                                <label className="delay-label">
                                    Capture Delay: <span>{captureDelay}s</span>
                                </label>
                                <input
                                    type="range"
                                    min="1"
                                    max="20"
                                    value={captureDelay}
                                    onChange={(e) => setCaptureDelay(parseInt(e.target.value))}
                                    className="delay-slider"
                                    disabled={scanStatus === "scanning" || countdown !== null}
                                />
                            </div>
                        </>
                    ) : (
                        <>
                            {/* Upload / Camera sub-mode toggle */}
                            <div className="image-solve-source-toggle">
                                <button
                                    className={`image-solve-source-btn ${!imageSolveUploadMode ? 'active' : ''}`}
                                    onClick={() => {
                                        setImageSolveUploadMode(false);
                                        clearImageSolveResult();
                                    }}
                                    disabled={imageSolveBusy || imageSolveCountdown !== null}
                                >Camera</button>
                                <button
                                    className={`image-solve-source-btn ${imageSolveUploadMode ? 'active' : ''}`}
                                    onClick={() => {
                                        setImageSolveUploadMode(true);
                                        clearImageSolveResult();
                                    }}
                                    disabled={imageSolveBusy || imageSolveCountdown !== null}
                                >Upload</button>
                            </div>

                            {/* ── Provider Setup ── */}
                            <div className="provider-setup">
                                <div className="provider-setup-label">Providers <span className="provider-setup-hint">(use arrows to reorder · check to enable)</span></div>
                                <div className="provider-list">
                                    {imageSolveProviderOrder.map((providerId, index) => {
                                        const providerInfo = ALL_SOLVE_PROVIDERS.find(p => p.id === providerId);
                                        const isEnabled = imageSolveProviderEnabled[providerId] ?? false;
                                        const enabledIdx = enabledProviders.indexOf(providerId);

                                        return (
                                            <div
                                                key={providerId}
                                                className={`provider-list-item${!isEnabled ? ' disabled-provider' : ''}`}
                                            >
                                                <div className="provider-reorder-actions">
                                                    <button 
                                                        className="reorder-btn" 
                                                        onClick={() => moveProviderUp(index)}
                                                        disabled={index === 0 || imageSolveSelectorLocked}
                                                        title="Move Up"
                                                    >▲</button>
                                                    <button 
                                                        className="reorder-btn" 
                                                        onClick={() => moveProviderDown(index)}
                                                        disabled={index === imageSolveProviderOrder.length - 1 || imageSolveSelectorLocked}
                                                        title="Move Down"
                                                    >▼</button>
                                                </div>
                                                <input
                                                    type="checkbox"
                                                    id={`provider-chk-${providerId}`}
                                                    checked={isEnabled}
                                                    onChange={(e) => {
                                                        setImageSolveProviderEnabled(prev => ({
                                                            ...prev,
                                                            [providerId]: e.target.checked,
                                                        }));
                                                    }}
                                                    disabled={imageSolveSelectorLocked}
                                                />
                                                <label
                                                    htmlFor={`provider-chk-${providerId}`}
                                                    className="provider-list-label"
                                                >
                                                    {providerInfo?.label ?? providerId}
                                                </label>
                                                {isEnabled && enabledIdx >= 0 && (
                                                    <span className={`provider-priority-badge${enabledIdx === 1 ? ' backup' : ''}`}>
                                                        {enabledIdx === 0 ? 'Primary' : 'Backup'}
                                                    </span>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                                {enabledProviders.length === 0 && (
                                    <p className="provider-setup-warning">⚠ Enable at least one provider to solve.</p>
                                )}
                            </div>

                            {imageSolveUploadMode ? (
                                <>
                                    {/* File upload zone */}
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept="image/*"
                                        className="image-upload-file-input"
                                        disabled={imageSolveBusy}
                                        onChange={(e) => {
                                            const file = e.target.files?.[0];
                                            if (file) handleFileUpload(file);
                                            e.target.value = '';
                                        }}
                                    />
                                    <div
                                        className={`image-upload-zone ${uploadedImagePreview ? 'has-preview' : ''} ${imageSolveBusy ? 'disabled' : ''}`}
                                        onClick={() => !imageSolveBusy && fileInputRef.current?.click()}
                                        onDragOver={(e) => e.preventDefault()}
                                        onDrop={(e) => {
                                            e.preventDefault();
                                            const file = e.dataTransfer.files?.[0];
                                            if (file) handleFileUpload(file);
                                        }}
                                    >
                                        {uploadedImagePreview ? (
                                            <img src={uploadedImagePreview} alt="Uploaded preview" className="image-upload-preview" />
                                        ) : (
                                            <div className="image-upload-placeholder">
                                                <span className="image-upload-icon">📷</span>
                                                <span className="image-upload-hint">Tap to choose image</span>
                                                <span className="image-upload-hint-sub">or drag &amp; drop</span>
                                            </div>
                                        )}
                                    </div>
                                    <button
                                        className={`capture-btn image-solve-btn ${imageSolveBusy ? 'counting' : ''}`}
                                        onClick={() => { if (uploadedImageBase64) solveWithUploadedImage(uploadedImageBase64); }}
                                        disabled={imageSolveBusy || !uploadedImageBase64 || enabledProviders.length === 0}
                                    >
                                        <div className="capture-inner"></div>
                                    </button>
                                    <p className="instruction-text" style={{ marginTop: '0.5rem', marginBottom: '1rem' }}>
                                        {imageSolveStatus === 'solving' && !imageSolveBrowserError && `Sending to ${imageSolvePrimaryLabel} via browser...`}
                                        {imageSolveStatus === 'solving' && imageSolveBrowserError && 'Browser solve failed. Running fallback...'}
                                        {imageSolveStatus === 'done' && imageSolveBackupStatus !== 'queued' && imageSolveBackupStatus !== 'solving' && 'Result received!'}
                                        {imageSolveStatus === 'done' && (imageSolveBackupStatus === 'queued' || imageSolveBackupStatus === 'solving') && `${imageSolvePrimaryLabel} screenshot received. Waiting for ${imageSolveBackupLabel} backup...`}
                                        {imageSolveStatus === 'error' && '❌ ' + imageSolveError}
                                        {imageSolveStatus === 'idle' && !uploadedImageBase64 && 'Choose an image to solve'}
                                        {imageSolveStatus === 'idle' && uploadedImageBase64 && 'Tap the button to send image'}
                                    </p>
                                </>
                            ) : (
                                <>
                                    <button
                                        className={`capture-btn image-solve-btn ${imageSolveBusy || imageSolveCountdown !== null ? 'counting' : ''}`}
                                        onClick={startImageSolve}
                                        disabled={imageSolveBusy || imageSolveCountdown !== null || enabledProviders.length === 0}
                                    >
                                        <div className="capture-inner"></div>
                                    </button>
                                    <p className="instruction-text" style={{ marginTop: '0.5rem', marginBottom: '1rem' }}>
                                        {imageSolveCountdown !== null && `Position paper. Capturing in ${imageSolveCountdown}s...`}
                                        {imageSolveCountdown === null && imageSolveStatus === 'capturing' && 'Capturing image...'}
                                        {imageSolveCountdown === null && imageSolveStatus === 'solving' && !imageSolveBrowserError && `Sending to ${imageSolvePrimaryLabel} via browser...`}
                                        {imageSolveCountdown === null && imageSolveStatus === 'solving' && imageSolveBrowserError && 'Browser solve failed. Running fallback...'}
                                        {imageSolveCountdown === null && imageSolveStatus === 'done' && imageSolveBackupStatus !== 'queued' && imageSolveBackupStatus !== 'solving' && 'Result received!'}
                                        {imageSolveCountdown === null && imageSolveStatus === 'done' && (imageSolveBackupStatus === 'queued' || imageSolveBackupStatus === 'solving') && `${imageSolvePrimaryLabel} screenshot received. Waiting for ${imageSolveBackupLabel} backup...`}
                                        {imageSolveCountdown === null && imageSolveStatus === 'error' && '❌ ' + imageSolveError}
                                        {imageSolveCountdown === null && imageSolveStatus === 'idle' && `Tap to start ${captureDelay}-second image solve timer`}
                                    </p>

                                    <div className="delay-slider-container">
                                        <label className="delay-label">
                                            Capture Delay: <span>{captureDelay}s</span>
                                        </label>
                                        <input
                                            type="range"
                                            min="1"
                                            max="20"
                                            value={captureDelay}
                                            onChange={(e) => setCaptureDelay(parseInt(e.target.value))}
                                            className="delay-slider"
                                            disabled={imageSolveBusy || imageSolveCountdown !== null}
                                        />
                                    </div>
                                </>
                            )}

                            {/* Result panel */}
                            {hasImageSolveResult && (
                                <div className="image-solve-result">
                                    <div className="image-solve-result-header">
                                        <span>{imageSolveProviderLabel} Result</span>
                                        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                                            {canRetry && (
                                                <button
                                                    className="retry-btn"
                                                    onClick={handleRetry}
                                                    disabled={imageSolveBusy}
                                                    title="Retry with same image"
                                                >
                                                    ↺ Retry
                                                </button>
                                            )}
                                            <button
                                                className="delete-btn"
                                                onClick={clearImageSolveResult}
                                            >✕</button>
                                        </div>
                                    </div>
                                    {imageSolveAnswer && (
                                        <div className="image-solve-result-body">
                                            {imageSolveAnswer}
                                        </div>
                                    )}
                                    {imageSolveError && !imageSolveAnswer && (
                                        <div className="image-solve-result-body" style={{ color: 'hsl(var(--accent-danger))' }}>
                                            {imageSolveError}
                                        </div>
                                    )}
                                    {imageSolveScreenshot && (
                                        <div className="solver-screenshot-card">
                                            <div className="solver-screenshot-label">{imageSolveProviderLabel} Screenshot</div>
                                            <button
                                                className="solver-screenshot-button"
                                                onClick={() => setExpandedSolverScreenshot({ src: imageSolveScreenshot, label: `${imageSolveProviderLabel} Screenshot` })}
                                                aria-label={`Expand ${imageSolveProviderLabel} screenshot`}
                                            >
                                                <img src={imageSolveScreenshot} alt={`${imageSolveProviderLabel} solver screenshot`} />
                                            </button>
                                        </div>
                                    )}
                                    {(imageSolveBackupStatus === 'queued' || imageSolveBackupStatus === 'solving') && (
                                        <div className="image-solve-backup">
                                            {imageSolveBackupLabel} backup is still running...
                                        </div>
                                    )}
                                    {imageSolveBackupStatus === 'done' && (imageSolveBackupAnswer || imageSolveBackupScreenshot) && (
                                        <div className="image-solve-backup">
                                            <div className="image-solve-backup-title">{imageSolveBackupLabel} Backup Result</div>
                                            {imageSolveBackupAnswer && <div>{imageSolveBackupAnswer}</div>}
                                            {imageSolveBackupScreenshot && (
                                                <div className="solver-screenshot-card backup">
                                                    <div className="solver-screenshot-label">{imageSolveBackupLabel} Screenshot</div>
                                                    <button
                                                        className="solver-screenshot-button"
                                                        onClick={() => setExpandedSolverScreenshot({ src: imageSolveBackupScreenshot, label: `${imageSolveBackupLabel} Screenshot` })}
                                                        aria-label={`Expand ${imageSolveBackupLabel} screenshot`}
                                                    >
                                                        <img src={imageSolveBackupScreenshot} alt={`${imageSolveBackupLabel} solver screenshot`} />
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {imageSolveBackupStatus === 'error' && imageSolveBackupError && (
                                        <div className="image-solve-backup error">
                                            {imageSolveBackupLabel} backup failed: {imageSolveBackupError}
                                        </div>
                                    )}
                                </div>
                            )}

                        </>
                    )}


                    <button
                        className="settings-btn"
                        onClick={() => setIsSettingsOpen(true)}
                        title="Settings"
                    >
                        ⚙️ Settings
                    </button>
                </div>
            </div>

            {/* Settings Overlay */}
            {isSettingsOpen && (
                <div className="settings-overlay" onClick={() => setIsSettingsOpen(false)}>
                    <div className="settings-modal" onClick={e => e.stopPropagation()}>
                        <div className="settings-header">
                            <h3>Settings</h3>
                            <button className="close-btn" onClick={() => setIsSettingsOpen(false)}>✕</button>
                        </div>
                        <div className="settings-content">
                            <label className="settings-label">
                                AI Solve System Prompt
                                <span className="settings-hint">The JSON formatting instructions will be appended automatically.</span>
                            </label>
                            <textarea
                                className="settings-textarea"
                                value={customSolvePrompt}
                                onChange={(e) => setCustomSolvePrompt(e.target.value)}
                                placeholder={defaultSolvePrompt}
                            />
                            <div className="settings-actions">
                                <button className="reset-btn" onClick={() => setCustomSolvePrompt(defaultSolvePrompt)}>Reset Default</button>
                                <button className="process-btn" onClick={() => setIsSettingsOpen(false)}>Done</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Right side: Results */}
            <div className="results-section">
                <div className="results-header">
                    <div className="bottom-tab-bar">
                        <button
                            className={`tab-btn ${bottomTab === "questions" ? "active" : ""}`}
                            onClick={() => setBottomTab("questions")}
                        >
                            Questions ({savedQuestions.length})
                        </button>
                        <button
                            className={`tab-btn ${bottomTab === "imagesolve" ? "active" : ""}`}
                            onClick={() => { setBottomTab("imagesolve"); fetchHistory(); }}
                        >
                            Image Solve Stack ({imageSolveResults.length})
                        </button>
                    </div>
                    {bottomTab === "questions" && <div style={{ display: "flex", gap: "0.5rem" }}>
                        {selectedQuestionIds.size > 0 && (
                            <button
                                className="process-btn"
                                onClick={processSelectedQuestions}
                                disabled={isProcessingSolutions}
                            >
                                {isProcessingSolutions ? 'Processing...' : `Process (${selectedQuestionIds.size})`}
                            </button>
                        )}
                        {(scanStatus === "error" || scanStatus === "success") && (
                            <button className="reset-btn" onClick={resetScanner}>Clear Status</button>
                        )}
                        {savedQuestions.length > 0 && (
                            <button className="reset-btn danger" onClick={clearAllQuestions}>Clear All</button>
                        )}
                    </div>}
                </div>

                {bottomTab === "imagesolve" && (
                    <div className="polling-results-panel image-solve-history-panel" style={{ margin: 0, border: 'none', boxShadow: 'none' }}>
                        {!isImageSolveResultsLoaded && (
                            <div className="polling-results-empty">Loading...</div>
                        )}
                        {isImageSolveResultsLoaded && imageSolveResults.length === 0 && (
                            <div className="polling-results-empty">No image solves yet.</div>
                        )}
                        {imageSolveResults.map((item) => {
                            const itemProviderLabel = getProviderLabel(item.answerProvider || item.primaryProvider);
                            const displayScreenshot = item.screenshot || item.backupScreenshot || null;
                            const screenshotLabel = item.screenshot
                                ? `${getProviderLabel(item.primaryProvider)} Screenshot`
                                : item.backupScreenshot ? `${getProviderLabel(item.backupProvider)} Backup Screenshot` : "";
                            return (
                                <div className={`polling-result-card ${item.status}`} key={item.id}>
                                    <button
                                        className="polling-result-image"
                                        onClick={() => displayScreenshot && setExpandedSolverScreenshot({ src: displayScreenshot, label: screenshotLabel })}
                                        disabled={!displayScreenshot}
                                        title={displayScreenshot ? "View screenshot" : "No screenshot yet"}
                                    >
                                        {displayScreenshot
                                            ? <img src={displayScreenshot} alt="AI response screenshot" />
                                            : <span style={{ fontSize: '0.7rem', opacity: 0.5 }}>{item.status === 'solving' || item.status === 'capturing' ? '⏳' : 'No screenshot'}</span>
                                        }
                                    </button>
                                    <div className="polling-result-content">
                                        <div className="polling-result-meta">
                                            <span>{new Date(item.createdAt).toLocaleTimeString()}</span>
                                            <span>{item.status}</span>
                                            <span>{itemProviderLabel}</span>
                                        </div>
                                        {item.answer && <div className="polling-result-answer">{item.answer}</div>}
                                        {item.error && !item.screenshot && <div className="polling-result-error">{item.error}</div>}
                                        {(item.backupStatus === "queued" || item.backupStatus === "solving") && (
                                            <div className="polling-result-warning">{getProviderLabel(item.backupProvider)} backup running...</div>
                                        )}
                                        {item.backupAnswer && <div className="polling-result-answer">{item.backupAnswer}</div>}
                                        {item.backupError && <div className="polling-result-error">{item.backupError}</div>}
                                        {item.image && item.status !== "solving" && item.status !== "capturing" && (
                                            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                                                <button
                                                    className="retry-btn"
                                                    onClick={() => handleRetryItem(item)}
                                                    disabled={imageSolveBusy}
                                                    title="Retry this solve"
                                                    style={{ flex: 1 }}
                                                >
                                                    ↺ Retry
                                                </button>
                                                <button
                                                    className="delete-btn"
                                                    onClick={() => handleDeleteItem(item.id)}
                                                    disabled={imageSolveBusy}
                                                    title="Delete this record"
                                                    style={{ 
                                                        flex: 1, 
                                                        background: 'rgba(255, 59, 48, 0.1)', 
                                                        color: '#ff3b30',
                                                        border: '1px solid rgba(255, 59, 48, 0.3)',
                                                        borderRadius: '8px',
                                                        padding: '0.5rem',
                                                        fontSize: '0.9rem',
                                                        fontWeight: 600,
                                                        cursor: 'pointer'
                                                    }}
                                                >
                                                    🗑️ Delete
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {bottomTab === "questions" && savedQuestions.length > 0 && (
                    <div className="tabs-container">
                        <button
                            className={`tab-btn ${activeTab === "all" ? "active" : ""}`}
                            onClick={() => setActiveTab("all")}
                        >
                            All ({savedQuestions.length})
                        </button>
                        <button
                            className={`tab-btn ${activeTab === "unsolved" ? "active" : ""}`}
                            onClick={() => setActiveTab("unsolved")}
                        >
                            Unsolved ({savedQuestions.filter(q => !q.solution).length})
                        </button>
                        <button
                            className={`tab-btn ${activeTab === "solved" ? "active" : ""}`}
                            onClick={() => setActiveTab("solved")}
                        >
                            Solved ({savedQuestions.filter(q => !!q.solution).length})
                        </button>
                    </div>
                )}

                {bottomTab === "questions" && <div className="results-content">
                    {scanStatus === "idle" && savedQuestions.length === 0 && (
                        <div className="empty-state">
                            <div className="empty-icon">📄</div>
                            <p>Scan a question paper to add questions.</p>
                        </div>
                    )}

                    {scanStatus === "scanning" && (
                        <div className="loading-state">
                            <div className="spinner"></div>
                            <p>Extracting text literally...</p>
                        </div>
                    )}

                    {scanStatus === "error" && (
                        <div className="error-state">
                            <p className="error-icon">⚠️</p>
                            <p>{errorMessage}</p>
                        </div>
                    )}

                    {savedQuestions.length > 0 && filteredQuestions.length === 0 && (
                        <div className="empty-state" style={{ marginTop: '2rem' }}>
                            <p>No {activeTab} questions found.</p>
                        </div>
                    )}

                    {filteredQuestions.length > 0 && (
                        <div className="questions-list">
                            {filteredQuestions.map((q, idx) => (
                                <div
                                    key={q.id || idx}
                                    className={`question-card ${selectedQuestionIds.has(q.id) ? 'selected' : ''}`}
                                    onClick={() => handleCardClick(q.id, !!q.solution)}
                                    onPointerDown={(e) => {
                                        if ((e.target as HTMLElement).tagName.toLowerCase() !== 'input' && editingId !== q.id) {
                                            handlePointerDown(q);
                                        }
                                    }}
                                    onPointerUp={handlePointerUp}
                                    onPointerLeave={handlePointerLeave}
                                    onPointerCancel={handlePointerLeave}
                                    onPointerMove={handlePointerUp}
                                    style={{ animationDelay: `${idx * 0.05}s` }}
                                >
                                    <div className="question-header">
                                        <div className="question-header-left">
                                            <input
                                                type="checkbox"
                                                className="question-checkbox"
                                                checked={selectedQuestionIds.has(q.id)}
                                                onChange={() => toggleSelection(q.id)}
                                                onClick={(e) => e.stopPropagation()}
                                            />
                                            <span className="question-number">Question {q.questionNumber}</span>
                                        </div>
                                        <button
                                            className="delete-btn"
                                            onClick={(e) => { e.stopPropagation(); deleteQuestion(q.id); }}
                                            aria-label="Delete question"
                                        >
                                            ✕
                                        </button>
                                    </div>

                                    {editingId === q.id ? (
                                        <div className="edit-mode-container" onClick={(e) => e.stopPropagation()}>
                                            <textarea
                                                className="edit-textarea"
                                                value={editingText}
                                                onChange={(e) => setEditingText(e.target.value)}
                                                autoFocus
                                                rows={5}
                                            />
                                            <div className="edit-controls">
                                                <button className="reset-btn danger" onClick={cancelEdit}>Cancel</button>
                                                <button className="process-btn" style={{ padding: '0.4rem 1.5rem' }} onClick={(e) => saveEdit(q.id, e)}>Save</button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="question-body">{q.text}</div>
                                    )}

                                    {(q.solution || q.isSolving) && !editingId && (
                                        <div className="question-solution">
                                            <h4>
                                                AI Solution
                                                {q.solution && (
                                                    <span style={{ fontSize: '0.7em', float: 'right', opacity: 0.7, textTransform: 'none' }}>
                                                        {expandedSolutionIds.has(q.id) ? '▲ Tap to collapse' : '▼ Tap to expand'}
                                                    </span>
                                                )}
                                            </h4>
                                            {q.isSolving ? (
                                                <div className="solution-loading">
                                                    <div className="spinner-small"></div>
                                                    <span>Generating answer...</span>
                                                </div>
                                            ) : expandedSolutionIds.has(q.id) && (
                                                <div className="solution-text">{q.solution}</div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>}
            </div>

            {/* Screenshot expanded overlay */}
            {expandedSolverScreenshot && (
                <div className="solver-screenshot-overlay" onClick={() => setExpandedSolverScreenshot(null)}>
                    <div className="solver-screenshot-expanded" onClick={(e) => e.stopPropagation()}>
                        <div className="solver-screenshot-expanded-title">{expandedSolverScreenshot.label}</div>
                        <img src={expandedSolverScreenshot.src} alt={expandedSolverScreenshot.label} />
                        <button
                            className="solver-screenshot-close"
                            onClick={() => setExpandedSolverScreenshot(null)}
                        >
                            Close
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
