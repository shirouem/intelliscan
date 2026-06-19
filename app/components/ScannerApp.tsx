"use client";

import React, { useRef, useState, useCallback, useEffect } from "react";
import "./ScannerApp.css";

// Interface for API response
interface ScannedQuestion {
    id: string;
    questionNumber: string;
    text: string;
    solution?: string;
    isSolving?: boolean; // UI state for loading indicator
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

type PollingSolveItem = {
    id: string;
    createdAt: string;
    image: string;
    status: "capturing" | "solving" | "done" | "error";
    primaryProvider: ImageSolveProvider;
    answer?: string | null;
    screenshot?: string | null;
    answerProvider?: string | null;
    backupAnswer?: string | null;
    backupScreenshot?: string | null;
    backupStatus?: "idle" | "queued" | "solving" | "done" | "error";
    backupProvider?: ImageSolveProvider | string | null;
    backupError?: string | null;
    browserError?: string | null;
    error?: string | null;
};

type SheetDetectionMetrics = {
    detected: boolean;
    baselineReady: boolean;
    score: number;
    averageBrightness: number;
    darkPixelRatio: number;
    edgeDensity: number;
    centerDarkRatio: number;
    lightPixelRatio: number;
    changeRatio: number;
    centerChangeRatio: number;
    mode: "none" | "frame-filled" | "region";
};

type SheetFrameAnalysis = {
    metrics: SheetDetectionMetrics;
    gray: Uint8Array;
};

type CaptureFrameOptions = {
    mimeType: "image/png" | "image/jpeg";
    quality: number;
    minQuality: number;
    maxWidth: number;
    maxHeight: number;
    maxDataUrlLength: number;
};

const scanCaptureOptions: CaptureFrameOptions = {
    mimeType: "image/jpeg",
    quality: 0.92,
    minQuality: 0.72,
    maxWidth: 1920,
    maxHeight: 1440,
    maxDataUrlLength: 3_200_000,
};

const imageSolveCaptureOptions: CaptureFrameOptions = {
    mimeType: "image/jpeg",
    quality: 0.92,
    minQuality: 0.72,
    maxWidth: 1920,
    maxHeight: 1440,
    maxDataUrlLength: 3_200_000,
};

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

const getBackupProvider = (provider: ImageSolveProvider): ImageSolveProvider =>
    provider === "gemini" ? "chatgpt" : "gemini";

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

const pollingDbName = "intelliscan_polling_solve";
const pollingStoreName = "results";

const openPollingDb = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(pollingDbName, 1);
    request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(pollingStoreName)) {
            db.createObjectStore(pollingStoreName, { keyPath: "id" });
        }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

const loadPollingSolveItems = async () => {
    const db = await openPollingDb();
    return new Promise<PollingSolveItem[]>((resolve, reject) => {
        const tx = db.transaction(pollingStoreName, "readonly");
        const request = tx.objectStore(pollingStoreName).getAll();
        request.onsuccess = () => {
            const items = (request.result as PollingSolveItem[])
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
            resolve(items);
        };
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
    });
};

const savePollingSolveItem = async (item: PollingSolveItem) => {
    const db = await openPollingDb();
    return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(pollingStoreName, "readwrite");
        tx.objectStore(pollingStoreName).put(item);
        tx.oncomplete = () => {
            db.close();
            resolve();
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
    });
};

const clearPollingSolveItems = async () => {
    const db = await openPollingDb();
    return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(pollingStoreName, "readwrite");
        tx.objectStore(pollingStoreName).clear();
        tx.oncomplete = () => {
            db.close();
            resolve();
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
    });
};

const emptySheetDetection: SheetDetectionMetrics = {
    detected: false,
    baselineReady: false,
    score: 0,
    averageBrightness: 0,
    darkPixelRatio: 0,
    edgeDensity: 0,
    centerDarkRatio: 0,
    lightPixelRatio: 0,
    changeRatio: 0,
    centerChangeRatio: 0,
    mode: "none",
};

const analyzeSheetFrame = (
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    baseline: Uint8Array | null,
): SheetFrameAnalysis => {
    if (!video.videoWidth || !video.videoHeight) {
        return { metrics: emptySheetDetection, gray: new Uint8Array() };
    }

    const targetWidth = 320;
    const targetHeight = Math.max(1, Math.round(targetWidth * (video.videoHeight / video.videoWidth)));
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return { metrics: emptySheetDetection, gray: new Uint8Array() };

    ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
    const { data } = ctx.getImageData(0, 0, targetWidth, targetHeight);
    const gray = new Uint8Array(targetWidth * targetHeight);
    const pixels = targetWidth * targetHeight;

    let brightnessSum = 0;
    let darkPixels = 0;
    let lightPixels = 0;
    let centerDarkPixels = 0;
    let centerPixels = 0;
    let edgePixels = 0;
    let sampledEdges = 0;
    let changedPixels = 0;
    let centerChangedPixels = 0;

    const centerLeft = Math.round(targetWidth * 0.18);
    const centerRight = Math.round(targetWidth * 0.82);
    const centerTop = Math.round(targetHeight * 0.18);
    const centerBottom = Math.round(targetHeight * 0.82);

    for (let y = 0; y < targetHeight; y += 1) {
        for (let x = 0; x < targetWidth; x += 1) {
            const pixelIndex = y * targetWidth + x;
            const dataIndex = pixelIndex * 4;
            const value = Math.round(data[dataIndex] * 0.299 + data[dataIndex + 1] * 0.587 + data[dataIndex + 2] * 0.114);
            gray[pixelIndex] = value;
            brightnessSum += value;
            if (value < 115) darkPixels += 1;
            if (value > 165) lightPixels += 1;

            if (x >= centerLeft && x <= centerRight && y >= centerTop && y <= centerBottom) {
                centerPixels += 1;
                if (value < 125) centerDarkPixels += 1;
            }

            if (baseline && baseline.length === pixels) {
                const changed = Math.abs(value - baseline[pixelIndex]) > 34;
                if (changed) {
                    changedPixels += 1;
                    if (x >= centerLeft && x <= centerRight && y >= centerTop && y <= centerBottom) {
                        centerChangedPixels += 1;
                    }
                }
            }
        }
    }

    for (let y = 1; y < targetHeight; y += 2) {
        for (let x = 1; x < targetWidth; x += 2) {
            const pixelIndex = y * targetWidth + x;
            const horizontal = Math.abs(gray[pixelIndex] - gray[pixelIndex - 1]);
            const vertical = Math.abs(gray[pixelIndex] - gray[pixelIndex - targetWidth]);
            if (horizontal + vertical > 52) edgePixels += 1;
            sampledEdges += 1;
        }
    }

    const averageBrightness = brightnessSum / pixels;
    const darkPixelRatio = darkPixels / pixels;
    const lightPixelRatio = lightPixels / pixels;
    const centerDarkRatio = centerPixels ? centerDarkPixels / centerPixels : 0;
    const edgeDensity = sampledEdges ? edgePixels / sampledEdges : 0;
    const baselineReady = Boolean(baseline && baseline.length === pixels);
    const changeRatio = baselineReady ? changedPixels / pixels : 0;
    const centerChangeRatio = baselineReady && centerPixels ? centerChangedPixels / centerPixels : 0;

    const frameFilledDocument =
        averageBrightness > 118 &&
        darkPixelRatio > 0.012 &&
        darkPixelRatio < 0.48 &&
        centerDarkRatio > 0.008 &&
        edgeDensity > 0.018;

    const regionDocument =
        lightPixelRatio > 0.32 &&
        averageBrightness > 105 &&
        darkPixelRatio > 0.01 &&
        centerDarkRatio > 0.006 &&
        edgeDensity > 0.014;

    const changedFromBaseline =
        baselineReady &&
        changeRatio > 0.075 &&
        centerChangeRatio > 0.045;

    const frameFilledDetected = frameFilledDocument && changedFromBaseline;
    const regionDetected = regionDocument && changedFromBaseline;

    const score =
        Math.min(1, averageBrightness / 180) * 0.24 +
        Math.min(1, darkPixelRatio / 0.08) * 0.28 +
        Math.min(1, edgeDensity / 0.07) * 0.28 +
        Math.min(1, lightPixelRatio / 0.65) * 0.2;

    return {
        metrics: {
        detected: frameFilledDetected || regionDetected,
        baselineReady,
        score,
        averageBrightness,
        darkPixelRatio,
        edgeDensity,
        centerDarkRatio,
        lightPixelRatio,
        changeRatio,
        centerChangeRatio,
        mode: frameFilledDetected ? "frame-filled" : regionDetected ? "region" : "none",
        },
        gray,
    };
};

export default function ScannerApp() {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const pollingDetectionCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isCapturing, setIsCapturing] = useState(false);
    const [savedQuestions, setSavedQuestions] = useState<ScannedQuestion[]>([]);
    const [selectedQuestionIds, setSelectedQuestionIds] = useState<Set<string>>(new Set());
    const [isProcessingSolutions, setIsProcessingSolutions] = useState(false);
    const [expandedSolutionIds, setExpandedSolutionIds] = useState<Set<string>>(new Set());
    const [activeTab, setActiveTab] = useState<"all" | "unsolved" | "solved">("all");

    // Settings state
    const defaultSolvePrompt = "You are an expert tutor. I am providing you with an array of questions extracted from a question paper.\nPlease solve each question accurately and provide a clear, step-by-step solution.";
    const [customSolvePrompt, setCustomSolvePrompt] = useState(defaultSolvePrompt);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

    // Edit mode state
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingText, setEditingText] = useState("");
    const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
    const imageSolveRunIdRef = useRef(0);
    const cameraRunIdRef = useRef(0);
    const pollingSolveActiveRef = useRef(false);
    const pollingCooldownUntilRef = useRef(0);
    const pollingBaselineRef = useRef<Uint8Array | null>(null);

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
    const [imageSolvePrimaryProvider, setImageSolvePrimaryProvider] = useState<ImageSolveProvider>("chatgpt");
    const [imageSolveBackupProvider, setImageSolveBackupProvider] = useState<ImageSolveProvider | null>(null);
    const [imageSolveCountdown, setImageSolveCountdown] = useState<number | null>(null);
    const [expandedSolverScreenshot, setExpandedSolverScreenshot] = useState<{ src: string; label: string } | null>(null);
    const [imageSolveUploadMode, setImageSolveUploadMode] = useState(false);
    const [uploadedImagePreview, setUploadedImagePreview] = useState<string | null>(null);
    const [uploadedImageBase64, setUploadedImageBase64] = useState<string | null>(null);
    const [pollingSolveMode, setPollingSolveMode] = useState(false);
    const [pollingSolveEnabled, setPollingSolveEnabled] = useState(false);
    const [pollingSolveCountdown, setPollingSolveCountdown] = useState<number | null>(null);
    const [pollingSolveDelay, setPollingSolveDelay] = useState(6);
    const [pollingDetection, setPollingDetection] = useState<SheetDetectionMetrics>(emptySheetDetection);
    const [pollingSolveResults, setPollingSolveResults] = useState<PollingSolveItem[]>([]);
    const [isPollingResultsLoaded, setIsPollingResultsLoaded] = useState(false);
    const [isPollingSolveActive, setIsPollingSolveActive] = useState(false);

    // Mounted state to avoid hydration errors around browser-only camera APIs.
    const [mounted, setMounted] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);
    const [cameraError, setCameraError] = useState<string | null>(null);

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
        if (storedPrompt) {
            setCustomSolvePrompt(storedPrompt);
        }

        const storedImageSolvePrimaryProvider = localStorage.getItem("scannerApp_imageSolvePrimaryProvider");
        if (storedImageSolvePrimaryProvider === "chatgpt" || storedImageSolvePrimaryProvider === "gemini") {
            setImageSolvePrimaryProvider(storedImageSolvePrimaryProvider);
        }

        setIsLoaded(true);
        setMounted(true);
    }, []);

    // Persist to localStorage whenever savedQuestions changes
    useEffect(() => {
        if (isLoaded) {
            localStorage.setItem("scannerApp_savedQuestions", JSON.stringify(savedQuestions));
            localStorage.setItem("scannerApp_solvePrompt", customSolvePrompt);
            localStorage.setItem("scannerApp_imageSolvePrimaryProvider", imageSolvePrimaryProvider);
        }
    }, [savedQuestions, customSolvePrompt, imageSolvePrimaryProvider, isLoaded]);

    useEffect(() => {
        if (!mounted) return;
        loadPollingSolveItems()
            .then((items) => {
                setPollingSolveResults(items);
                setIsPollingResultsLoaded(true);
            })
            .catch((error) => {
                console.error("Failed to load polling solve results", error);
                setIsPollingResultsLoaded(true);
            });
    }, [mounted]);

    const upsertPollingSolveItem = useCallback((item: PollingSolveItem) => {
        setPollingSolveResults((prev) => {
            const withoutCurrent = prev.filter((existingItem) => existingItem.id !== item.id);
            return [item, ...withoutCurrent].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        });

        savePollingSolveItem(item).catch((error) => {
            console.error("Failed to save polling solve result", error);
        });
    }, []);

    const clearPollingSolveStack = useCallback(() => {
        setPollingSolveResults([]);
        clearPollingSolveItems().catch((error) => {
            console.error("Failed to clear polling solve results", error);
        });
    }, []);

    const resetPollingBaseline = useCallback(() => {
        pollingBaselineRef.current = null;
        setPollingDetection(emptySheetDetection);
        setPollingSolveCountdown(null);
    }, []);

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

            const track = stream.getVideoTracks()[0];
            const settings = track?.getSettings();
            console.log(`Camera stream active at ${settings?.width || "?"}x${settings?.height || "?"}`);
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
            const canvas = drawCaptureToCanvas(video, video.videoWidth, video.videoHeight, false, options);
            console.log(`Captured video frame at ${video.videoWidth}x${video.videoHeight}`);
            return encodeCanvasWithinLimit(canvas, options);
        }

        return null;
    }, [drawCaptureToCanvas, encodeCanvasWithinLimit]);

    const getCaptureResolution = () => {
        const video = videoRef.current;
        if (!video) return null;
        return {
            width: video.videoWidth,
            height: video.videoHeight,
        };
    };

    const capture = useCallback(async (autoTriggered = false) => {
        if (!videoRef.current) return;

        // Haptic feedback for timer-triggered captures.
        if (autoTriggered) {
            try {
                if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);
            } catch { }
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
                // Send the flipped image!
                body: JSON.stringify({ image: base64Image }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `API returned ${response.status}`);
            }

            const data = await response.json();
            const newQuestions: ScannedQuestion[] = data.questions || [];

            // Accumulate questions, ignoring ones that already exist by number
            setSavedQuestions(prev => {
                const updatedList = [...prev];

                newQuestions.forEach(newQ => {
                    // Create a normalized string of the first ~25 alphanumeric characters for comparison
                    const getLexicalPrefix = (str: string) => str.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().substring(0, 25);
                    const newPrefix = getLexicalPrefix(newQ.text || "");

                    // Check if question text is extremely similar (meaning it has the same prefix)
                    const isSimilar = updatedList.some(
                        existingQ => {
                            const existingPrefix = getLexicalPrefix(existingQ.text || "");
                            // Return true if either prefix is entirely contained within the other
                            // and the prefix is at least 15 characters long to prevent false positives on very short questions
                            const minLength = Math.min(newPrefix.length, existingPrefix.length);
                            if (minLength < 15) {
                                // For very short text, require a high degree of similarity or exact match
                                return newPrefix === existingPrefix && newPrefix.length > 5;
                            }
                            return newPrefix.startsWith(existingPrefix) || existingPrefix.startsWith(newPrefix);
                        }
                    );

                    if (!isSimilar) {
                        updatedList.push({
                            ...newQ,
                            // Ignore the ID from the API because if we scan twice, it might return 'id: 1' both times
                            id: `q-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
                        });
                    }
                });

                // Return the updated list in the exact order items were processed
                return updatedList;
            });

            setScanStatus("success");
        } catch (error: unknown) {
            console.error("Scan error:", error);
            setScanStatus("error");
            setErrorMessage(getErrorMessage(error, "Failed to process the question paper."));
        }
    }, [captureHighQualityFrame]);

    // Timer logic for 6-second countdown
    useEffect(() => {
        if (countdown === null) return;

        if (countdown > 0) {
            const timer = setTimeout(() => setCountdown(countdown - 1), 1000);

            // Optional: Play a tick sound here so the user can hear the countdown
            try {
                if ("vibrate" in navigator) navigator.vibrate(50);
            } catch { }

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

    const handleImageSolvePrimaryProviderChange = (provider: ImageSolveProvider) => {
        if (provider === imageSolvePrimaryProvider) return;

        if (
            imageSolveStatus === "solving" ||
            imageSolveStatus === "capturing" ||
            imageSolveCountdown !== null ||
            pollingSolveCountdown !== null ||
            isPollingSolveActive
        ) return;

        setImageSolvePrimaryProvider(provider);
        clearImageSolveResult();
    };

    const resetScanner = () => {
        // We do NOT clear savedQuestions here, we just wipe errors/status
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
        setSelectedQuestionIds(prev => {
            const next = new Set(prev);
            next.delete(idToDelete);
            return next;
        });
        setExpandedSolutionIds(prev => {
            const next = new Set(prev);
            next.delete(idToDelete);
            return next;
        });
    };

    const toggleSolutionExpanded = (id: string) => {
        setExpandedSolutionIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const handleCardClick = (id: string, hasSolution: boolean) => {
        if (editingId === id) return;

        if (hasSolution) {
            toggleSolutionExpanded(id);
        } else {
            toggleSelection(id);
        }
    };

    const toggleSelection = (id: string) => {
        // Prevent selection if we're in edit mode for this card clicking around
        if (editingId === id) return;

        setSelectedQuestionIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    // --- Long Press Edit Logic ---
    const handlePointerDown = (q: ScannedQuestion) => {
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = setTimeout(() => {
            // Trigger edit mode after 600ms long press
            setEditingId(q.id);
            setEditingText(q.text);
            try {
                if ("vibrate" in navigator) navigator.vibrate(50); // haptic feedback
            } catch { }
        }, 600);
    };

    const handlePointerUp = () => {
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    };

    const handlePointerLeave = () => {
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    };

    const saveEdit = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setSavedQuestions(prev => prev.map(q =>
            q.id === id ? { ...q, text: editingText } : q
        ));
        setEditingId(null);
        setEditingText("");
    };

    const cancelEdit = (e: React.MouseEvent) => {
        e.stopPropagation();
        setEditingId(null);
        setEditingText("");
    };

    // ── Image Solve: capture frame → /api/image-solve → show answer ──────────
    const captureAndImageSolve = useCallback(async () => {
        if (!videoRef.current || imageSolveStatus === "solving" || imageSolveStatus === "capturing") return;

        const runId = imageSolveRunIdRef.current + 1;
        imageSolveRunIdRef.current = runId;
        const isCurrentImageSolveRun = () => imageSolveRunIdRef.current === runId;

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

        const requestPrimaryProvider = imageSolvePrimaryProvider;
        const requestBackupProvider = getBackupProvider(requestPrimaryProvider);
        setImageSolveBackupProvider(requestBackupProvider);

        let base64Image: string | null = null;
        try {
            base64Image = await captureHighQualityFrame(imageSolveCaptureOptions);
        } catch (err: unknown) {
            if (!isCurrentImageSolveRun()) return;
            setImageSolveStatus("error");
            setImageSolveError(`Image capture failed: ${getErrorMessage(err)}`);
            return;
        }

        if (!isCurrentImageSolveRun()) return;

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

        setImageSolveStatus("solving");

        try {
            const response = await fetch("/api/image-solve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    image: base64Image,
                    prompt: customSolvePrompt,
                    primaryProvider: requestPrimaryProvider,
                }),
            });

            const data = await readImageSolveResponse(response);

            if (!isCurrentImageSolveRun()) return;

            if (!response.ok || (data.error && !data.jobId && !data.fallbackRequired)) {
                throw new Error(data.error || `Server returned ${response.status}`);
            }

            const applyImageSolveData = (statusData: ImageSolveStatusData) => {
                if (!isCurrentImageSolveRun()) return true;

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

            if (data.fallbackRequired) {
                setImageSolveBackupStatus("solving");

                const fallbackResponse = await fetch("/api/image-solve", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        image: base64Image,
                        prompt: customSolvePrompt,
                        primaryProvider: requestPrimaryProvider,
                        useFallbackOnly: true,
                        browserError: data.browserError || data.primaryError || data.error,
                    }),
                });
                const fallbackData = await readImageSolveResponse(fallbackResponse);

                if (!isCurrentImageSolveRun()) return;

                if (!fallbackResponse.ok) {
                    const fallbackError = fallbackData.error || `Fallback returned ${fallbackResponse.status}`;
                    setImageSolveBackupStatus("error");
                    setImageSolveBackupError(fallbackError);
                    throw new Error(fallbackError);
                }

                setImageSolveBackupStatus("done");
                applyImageSolveData(fallbackData);
                return;
            }

            if (data.jobId) {
                const pollInterval = setInterval(async () => {
                    try {
                        if (!isCurrentImageSolveRun()) {
                            clearInterval(pollInterval);
                            return;
                        }

                        const statusRes = await fetch(`/api/image-solve/status?jobId=${data.jobId}`);
                        if (!statusRes.ok) return; // ignore temporary network errors
                        const statusData = await readImageSolveResponse(statusRes);

                        const shouldStop = applyImageSolveData(statusData);
                        if (shouldStop) {
                            clearInterval(pollInterval);
                        }
                    } catch (e: unknown) {
                        console.error("Polling error:", e);
                    }
                }, 3000);
            } else if (!data.primaryScreenshot && !data.backupScreenshot) {
                setImageSolveAnswer(data.answer || "(No answer returned)");
                setImageSolveAnswerProvider(data.provider || data.source || null);
                setImageSolveStatus("done");
            }
        } catch (err: unknown) {
            if (!isCurrentImageSolveRun()) return;
            setImageSolveError(getErrorMessage(err));
            setImageSolveStatus("error");
        }
    }, [imageSolveStatus, customSolvePrompt, imageSolvePrimaryProvider, captureHighQualityFrame]);

    // ── Image Solve: solve from uploaded file ─────────────────────────────────
    const solveWithUploadedImage = useCallback(async (base64Image: string) => {
        if (imageSolveStatus === "solving" || imageSolveStatus === "capturing") return;

        const runId = imageSolveRunIdRef.current + 1;
        imageSolveRunIdRef.current = runId;
        const isCurrentRun = () => imageSolveRunIdRef.current === runId;

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

        const requestPrimaryProvider = imageSolvePrimaryProvider;
        const requestBackupProvider = getBackupProvider(requestPrimaryProvider);
        setImageSolveBackupProvider(requestBackupProvider);

        try {
            const response = await fetch("/api/image-solve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    image: base64Image,
                    prompt: customSolvePrompt,
                    primaryProvider: requestPrimaryProvider,
                }),
            });

            const data = await readImageSolveResponse(response);
            if (!isCurrentRun()) return;

            if (!response.ok || (data.error && !data.jobId && !data.fallbackRequired)) {
                throw new Error(data.error || `Server returned ${response.status}`);
            }

            const applyData = (statusData: ImageSolveStatusData) => {
                if (!isCurrentRun()) return true;
                const browserError = statusData.browserError || statusData.primaryError || (!statusData.primaryAnswer && statusData.error ? statusData.error : null);
                if (browserError) setImageSolveBrowserError(browserError);
                const primaryAnswer = statusData.primaryAnswer || statusData.answer;
                const primaryScreenshot = statusData.primaryScreenshot;
                const resultProvider = statusData.provider || statusData.source || requestPrimaryProvider;
                if (primaryScreenshot) { setImageSolveScreenshot(primaryScreenshot); setImageSolveAnswerProvider(resultProvider); setImageSolveStatus("done"); }
                if (primaryAnswer) { setImageSolveAnswer(primaryAnswer); setImageSolveAnswerProvider(resultProvider); setImageSolveStatus("done"); }
                if (statusData.backupStatus) setImageSolveBackupStatus(statusData.backupStatus);
                const normBackup = normalizeImageSolveProvider(statusData.backupProvider);
                if (normBackup) setImageSolveBackupProvider(normBackup);
                if (statusData.backupAnswer) { setImageSolveBackupAnswer(statusData.backupAnswer); setImageSolveBackupStatus("done"); }
                if (statusData.backupScreenshot) { setImageSolveBackupScreenshot(statusData.backupScreenshot); setImageSolveBackupStatus("done"); if (!primaryScreenshot && !primaryAnswer) { setImageSolveAnswerProvider(normBackup || statusData.provider || requestBackupProvider); setImageSolveStatus("done"); } }
                if (statusData.backupError) { setImageSolveBackupError(statusData.backupError); setImageSolveBackupStatus("error"); }
                if (!primaryAnswer && !primaryScreenshot && statusData.status === "error") { setImageSolveError(statusData.error || "Image solve failed."); setImageSolveStatus("error"); return true; }
                return (statusData.backupStatus === "done" || statusData.backupStatus === "error" || Boolean(statusData.backupAnswer) || Boolean(statusData.backupScreenshot) || Boolean(statusData.backupError));
            };

            applyData(data);

            if (data.fallbackRequired) {
                setImageSolveBackupStatus("solving");
                const fallbackResponse = await fetch("/api/image-solve", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ image: base64Image, prompt: customSolvePrompt, primaryProvider: requestPrimaryProvider, useFallbackOnly: true, browserError: data.browserError || data.primaryError || data.error }),
                });
                const fallbackData = await readImageSolveResponse(fallbackResponse);
                if (!isCurrentRun()) return;
                if (!fallbackResponse.ok) { setImageSolveBackupStatus("error"); setImageSolveBackupError(fallbackData.error || `Fallback returned ${fallbackResponse.status}`); throw new Error(fallbackData.error || `Fallback returned ${fallbackResponse.status}`); }
                setImageSolveBackupStatus("done");
                applyData(fallbackData);
                return;
            }

            if (data.jobId) {
                const pollInterval = setInterval(async () => {
                    try {
                        if (!isCurrentRun()) { clearInterval(pollInterval); return; }
                        const statusRes = await fetch(`/api/image-solve/status?jobId=${data.jobId}`);
                        if (!statusRes.ok) return;
                        const statusData = await readImageSolveResponse(statusRes);
                        if (applyData(statusData)) clearInterval(pollInterval);
                    } catch (e: unknown) { console.error("Polling error:", e); }
                }, 3000);
            } else if (!data.primaryScreenshot && !data.backupScreenshot) {
                setImageSolveAnswer(data.answer || "(No answer returned)");
                setImageSolveAnswerProvider(data.provider || data.source || null);
                setImageSolveStatus("done");
            }
        } catch (err: unknown) {
            if (!isCurrentRun()) return;
            setImageSolveError(getErrorMessage(err));
            setImageSolveStatus("error");
        }
    }, [imageSolveStatus, customSolvePrompt, imageSolvePrimaryProvider]);

    const solvePollingImage = useCallback(async (base64Image: string) => {
        if (pollingSolveActiveRef.current) return;

        pollingSolveActiveRef.current = true;
        setIsPollingSolveActive(true);
        const requestPrimaryProvider = imageSolvePrimaryProvider;
        const requestBackupProvider = getBackupProvider(requestPrimaryProvider);
        let currentItem: PollingSolveItem = {
            id: `poll-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: new Date().toISOString(),
            image: base64Image,
            status: "solving",
            primaryProvider: requestPrimaryProvider,
            backupStatus: "idle",
            backupProvider: requestBackupProvider,
        };

        const persistPatch = (patch: Partial<PollingSolveItem>) => {
            currentItem = { ...currentItem, ...patch };
            upsertPollingSolveItem(currentItem);
        };

        upsertPollingSolveItem(currentItem);

        const applyPollingData = (statusData: ImageSolveStatusData) => {
            const browserError =
                statusData.browserError ||
                statusData.primaryError ||
                (!statusData.primaryAnswer && statusData.error ? statusData.error : null);
            const primaryAnswer = statusData.primaryAnswer || statusData.answer;
            const primaryScreenshot = statusData.primaryScreenshot;
            const resultProvider = statusData.provider || statusData.source || requestPrimaryProvider;
            const normalizedBackupProvider = normalizeImageSolveProvider(statusData.backupProvider);

            const patch: Partial<PollingSolveItem> = {};
            if (browserError) patch.browserError = browserError;
            if (primaryAnswer) {
                patch.answer = primaryAnswer;
                patch.answerProvider = resultProvider;
                patch.status = "done";
            }
            if (primaryScreenshot) {
                patch.screenshot = primaryScreenshot;
                patch.answerProvider = resultProvider;
                patch.status = "done";
            }
            if (statusData.backupStatus) patch.backupStatus = statusData.backupStatus;
            if (normalizedBackupProvider) patch.backupProvider = normalizedBackupProvider;
            if (statusData.backupAnswer) {
                patch.backupAnswer = statusData.backupAnswer;
                patch.backupStatus = "done";
            }
            if (statusData.backupScreenshot) {
                patch.backupScreenshot = statusData.backupScreenshot;
                patch.backupStatus = "done";
                if (!primaryAnswer && !primaryScreenshot) {
                    patch.answerProvider = normalizedBackupProvider || statusData.provider || requestBackupProvider;
                    patch.status = "done";
                }
            }
            if (statusData.backupError) {
                patch.backupError = statusData.backupError;
                patch.backupStatus = "error";
            }
            if (!primaryAnswer && !primaryScreenshot && statusData.status === "error") {
                patch.error = statusData.error || "Image solve failed.";
                patch.status = "error";
            }

            persistPatch(patch);

            return (
                statusData.backupStatus === "done" ||
                statusData.backupStatus === "error" ||
                Boolean(statusData.backupAnswer) ||
                Boolean(statusData.backupScreenshot) ||
                Boolean(statusData.backupError)
            );
        };

        try {
            const response = await fetch("/api/image-solve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    image: base64Image,
                    prompt: customSolvePrompt,
                    primaryProvider: requestPrimaryProvider,
                }),
            });

            const data = await readImageSolveResponse(response);
            if (!response.ok || (data.error && !data.jobId && !data.fallbackRequired)) {
                throw new Error(data.error || `Server returned ${response.status}`);
            }

            applyPollingData(data);

            if (data.fallbackRequired) {
                persistPatch({ backupStatus: "solving" });
                const fallbackResponse = await fetch("/api/image-solve", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        image: base64Image,
                        prompt: customSolvePrompt,
                        primaryProvider: requestPrimaryProvider,
                        useFallbackOnly: true,
                        browserError: data.browserError || data.primaryError || data.error,
                    }),
                });
                const fallbackData = await readImageSolveResponse(fallbackResponse);
                if (!fallbackResponse.ok) {
                    const fallbackError = fallbackData.error || `Fallback returned ${fallbackResponse.status}`;
                    persistPatch({ backupStatus: "error", backupError: fallbackError, status: currentItem.status === "done" ? "done" : "error", error: fallbackError });
                    return;
                }
                applyPollingData(fallbackData);
                return;
            }

            if (data.jobId) {
                await new Promise<void>((resolve) => {
                    const pollInterval = setInterval(async () => {
                        try {
                            const statusRes = await fetch(`/api/image-solve/status?jobId=${data.jobId}`);
                            if (!statusRes.ok) return;
                            const statusData = await readImageSolveResponse(statusRes);
                            const shouldStop = applyPollingData(statusData);
                            if (shouldStop) {
                                clearInterval(pollInterval);
                                resolve();
                            }
                        } catch (error) {
                            console.error("Polling solve stack status error:", error);
                        }
                    }, 3000);

                    setTimeout(() => {
                        clearInterval(pollInterval);
                        resolve();
                    }, 300000);
                });
            } else if (!data.primaryScreenshot && !data.backupScreenshot) {
                persistPatch({
                    answer: data.answer || "(No answer returned)",
                    answerProvider: data.provider || data.source || null,
                    status: "done",
                });
            }
        } catch (error: unknown) {
            persistPatch({
                status: "error",
                error: getErrorMessage(error),
            });
        } finally {
            pollingSolveActiveRef.current = false;
            setIsPollingSolveActive(false);
            pollingCooldownUntilRef.current = Date.now() + 5000;
        }
    }, [customSolvePrompt, imageSolvePrimaryProvider, upsertPollingSolveItem]);

    useEffect(() => {
        if (!pollingSolveEnabled || !pollingSolveMode || imageSolveUploadMode) {
            pollingBaselineRef.current = null;
            setPollingDetection(emptySheetDetection);
            return;
        }

        const interval = window.setInterval(() => {
            const video = videoRef.current;
            const canvas = pollingDetectionCanvasRef.current;
            if (!video || !canvas || !video.videoWidth || !video.videoHeight) return;

            const analysis = analyzeSheetFrame(video, canvas, pollingBaselineRef.current);
            const { metrics, gray } = analysis;

            if (!metrics.baselineReady) {
                pollingBaselineRef.current = gray;
            } else if (
                !metrics.detected &&
                metrics.changeRatio < 0.025 &&
                metrics.centerChangeRatio < 0.02 &&
                pollingSolveCountdown === null &&
                !pollingSolveActiveRef.current
            ) {
                pollingBaselineRef.current = gray;
            }

            setPollingDetection(metrics);

            const busy =
                pollingSolveActiveRef.current ||
                pollingSolveCountdown !== null ||
                imageSolveStatus === "solving" ||
                imageSolveStatus === "capturing" ||
                imageSolveBackupStatus === "queued" ||
                imageSolveBackupStatus === "solving" ||
                Date.now() < pollingCooldownUntilRef.current;

            if (!busy && metrics.detected) {
                setPollingSolveCountdown(pollingSolveDelay);
            }
        }, 250);

        return () => window.clearInterval(interval);
    }, [
        pollingSolveEnabled,
        pollingSolveMode,
        imageSolveUploadMode,
        pollingSolveCountdown,
        pollingSolveDelay,
        imageSolveStatus,
        imageSolveBackupStatus,
    ]);

    useEffect(() => {
        if (pollingSolveCountdown === null) return;

        if (pollingSolveCountdown > 0) {
            const timer = window.setTimeout(() => setPollingSolveCountdown(pollingSolveCountdown - 1), 1000);
            return () => window.clearTimeout(timer);
        }

        const runCapture = async () => {
            setPollingSolveCountdown(null);
            pollingCooldownUntilRef.current = Date.now() + 1000;
            try {
                const base64Image = await captureHighQualityFrame(imageSolveCaptureOptions);
                if (!base64Image) throw new Error("Failed to capture image from camera.");
                await solvePollingImage(base64Image);
            } catch (error) {
                const item: PollingSolveItem = {
                    id: `poll-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    createdAt: new Date().toISOString(),
                    image: "",
                    status: "error",
                    primaryProvider: imageSolvePrimaryProvider,
                    error: getErrorMessage(error, "Polling capture failed."),
                    backupStatus: "idle",
                };
                upsertPollingSolveItem(item);
                pollingCooldownUntilRef.current = Date.now() + 5000;
            }
        };

        runCapture();
    }, [pollingSolveCountdown, captureHighQualityFrame, solvePollingImage, imageSolvePrimaryProvider, upsertPollingSolveItem]);

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

    // Countdown for Image Solve mode
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


    const processSelectedQuestions = async () => {
        if (selectedQuestionIds.size === 0 || isProcessingSolutions) return;

        setIsProcessingSolutions(true);

        // Mark specific questions as 'isSolving'
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
                body: JSON.stringify({
                    questions: questionsToSend,
                    customSolvePrompt: customSolvePrompt
                }),
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
                return { ...q, isSolving: false }; // clear loading state if no solution
            }));

            // Auto-expand successfully solved questions
            setExpandedSolutionIds(prev => {
                const next = new Set(prev);
                selectedQuestionIds.forEach(id => {
                    if (solutions[id]) next.add(id);
                });
                return next;
            });

            // Clear selection after process
            setSelectedQuestionIds(new Set());

        } catch (error: unknown) {
            console.error("Solve error:", error);
            alert("Failed to process solutions: " + getErrorMessage(error));
            // Revert loading states
            setSavedQuestions(prev => prev.map(q => ({ ...q, isSolving: false })));
        } finally {
            setIsProcessingSolutions(false);
        }
    };

    const filteredQuestions = savedQuestions.filter(q => {
        if (activeTab === "all") return true;
        if (activeTab === "solved") return !!q.solution;
        if (activeTab === "unsolved") return !q.solution;
        return true;
    });

    if (!mounted) return null;

    const imageSolveBusy =
        imageSolveStatus === "solving" ||
        imageSolveStatus === "capturing" ||
        imageSolveBackupStatus === "queued" ||
        imageSolveBackupStatus === "solving" ||
        isPollingSolveActive;
    const imageSolveSelectorLocked =
        imageSolveStatus === "solving" ||
        imageSolveStatus === "capturing" ||
        imageSolveCountdown !== null ||
        pollingSolveCountdown !== null ||
        isPollingSolveActive;

    const imageSolveProviderLabel =
        imageSolveAnswerProvider === "chatgpt" ? "ChatGPT Browser" :
            imageSolveAnswerProvider === "gemini" ? "Gemini Browser" :
                imageSolveAnswerProvider === "gemini-api" ? "Gemini API" :
                    "Image Solve";
    const imageSolvePrimaryLabel = getProviderLabel(imageSolvePrimaryProvider);
    const imageSolveDisplayedBackupProvider = imageSolveBackupProvider || getBackupProvider(imageSolvePrimaryProvider);
    const imageSolveBackupLabel = getProviderLabel(imageSolveDisplayedBackupProvider);
    const hasImageSolveResult =
        imageSolveStatus === "done" &&
        Boolean(imageSolveAnswer || imageSolveScreenshot || imageSolveBackupAnswer || imageSolveBackupScreenshot);
    const pollingDetectionLabel = pollingDetection.detected
        ? `Sheet detected (${pollingDetection.mode}, ${Math.round(pollingDetection.score * 100)}%)`
        : pollingDetection.baselineReady
            ? `Watching for new sheet (${Math.round(pollingDetection.changeRatio * 100)}% change)`
            : "Learning empty scene...";

    return (
        <div className="scanner-layout">
            {/* Left side: Camera Viewport */}
            <div className="scanner-section">
                <div className="webcam-container">
                    <video
                        ref={videoRef}
                        className={`webcam-preview ${isCapturing ? "capture-flash" : ""}`}
                        autoPlay
                        muted
                        playsInline
                    />
                    {cameraError && (
                        <div className="camera-error-overlay">
                            {cameraError}
                        </div>
                    )}

                    {/* Overlay scanning effects */}
                    {scanStatus === "scanning" && (
                        <div className="scanning-overlay">
                            <div className="scan-line"></div>
                            <div className="scan-text">Analyzing intelligence...</div>
                        </div>
                    )}

                    {/* Countdown Overlay — shared by both scan and image solve timers */}
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
                                    className={`image-solve-source-btn ${!imageSolveUploadMode && !pollingSolveMode ? 'active' : ''}`}
                                    onClick={() => {
                                        setImageSolveUploadMode(false);
                                        setPollingSolveMode(false);
                                        setPollingSolveEnabled(false);
                                        resetPollingBaseline();
                                        clearImageSolveResult();
                                    }}
                                    disabled={imageSolveBusy || imageSolveCountdown !== null || pollingSolveCountdown !== null}
                                >Camera</button>
                                <button
                                    className={`image-solve-source-btn ${pollingSolveMode ? 'active' : ''}`}
                                    onClick={() => {
                                        setImageSolveUploadMode(false);
                                        setPollingSolveMode(true);
                                        resetPollingBaseline();
                                        clearImageSolveResult();
                                    }}
                                    disabled={imageSolveBusy || imageSolveCountdown !== null || pollingSolveCountdown !== null}
                                >Polling</button>
                                <button
                                    className={`image-solve-source-btn ${imageSolveUploadMode ? 'active' : ''}`}
                                    onClick={() => {
                                        setImageSolveUploadMode(true);
                                        setPollingSolveMode(false);
                                        setPollingSolveEnabled(false);
                                        resetPollingBaseline();
                                        clearImageSolveResult();
                                    }}
                                    disabled={imageSolveBusy || imageSolveCountdown !== null || pollingSolveCountdown !== null}
                                >Upload</button>
                            </div>

                            <div className="provider-priority-toggle">
                                <span className="provider-priority-label">First response</span>
                                <div className="provider-priority-actions" role="radiogroup" aria-label="First response provider">
                                    <label className="provider-priority-option">
                                        <input
                                            type="radio"
                                            name="image-solve-primary-provider"
                                            className="provider-priority-input"
                                            value="chatgpt"
                                            checked={imageSolvePrimaryProvider === "chatgpt"}
                                            onChange={() => handleImageSolvePrimaryProviderChange("chatgpt")}
                                            disabled={imageSolveSelectorLocked}
                                        />
                                        <span className={`provider-priority-choice ${imageSolvePrimaryProvider === "chatgpt" ? "selected" : ""}`}>
                                            ChatGPT
                                        </span>
                                    </label>
                                    <label className="provider-priority-option">
                                        <input
                                            type="radio"
                                            name="image-solve-primary-provider"
                                            className="provider-priority-input"
                                            value="gemini"
                                            checked={imageSolvePrimaryProvider === "gemini"}
                                            onChange={() => handleImageSolvePrimaryProviderChange("gemini")}
                                            disabled={imageSolveSelectorLocked}
                                        />
                                        <span className={`provider-priority-choice ${imageSolvePrimaryProvider === "gemini" ? "selected" : ""}`}>
                                            Gemini
                                        </span>
                                    </label>
                                </div>
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
                                        disabled={imageSolveBusy || !uploadedImageBase64}
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
                            ) : pollingSolveMode ? (
                                <>
                                    <div className="polling-solve-panel">
                                        <div className="polling-solve-header">
                                            <div>
                                                <div className="polling-solve-title">Polling Image Solve</div>
                                                <div className={`polling-solve-detection ${pollingDetection.detected ? "detected" : ""}`}>
                                                    {pollingSolveCountdown !== null
                                                        ? `Sheet found. Capturing in ${pollingSolveCountdown}s...`
                                                        : pollingSolveEnabled
                                                            ? pollingDetectionLabel
                                                            : "Polling is paused"}
                                                </div>
                                            </div>
                                            <button
                                                className={`image-solve-source-btn ${pollingSolveEnabled ? "active" : ""}`}
                                                onClick={() => {
                                                    setPollingSolveEnabled((enabled) => {
                                                        if (!enabled) resetPollingBaseline();
                                                        else setPollingSolveCountdown(null);
                                                        return !enabled;
                                                    });
                                                }}
                                                disabled={isPollingSolveActive}
                                            >
                                                {pollingSolveEnabled ? "Pause" : "Start"}
                                            </button>
                                            <button
                                                className="image-solve-source-btn"
                                                onClick={resetPollingBaseline}
                                                disabled={isPollingSolveActive}
                                            >
                                                Reset Baseline
                                            </button>
                                        </div>

                                        <div className="polling-solve-metrics">
                                            <span>Brightness {Math.round(pollingDetection.averageBrightness)}</span>
                                            <span>Text {Math.round(pollingDetection.darkPixelRatio * 1000) / 10}%</span>
                                            <span>Edges {Math.round(pollingDetection.edgeDensity * 1000) / 10}%</span>
                                            <span>Change {Math.round(pollingDetection.changeRatio * 1000) / 10}%</span>
                                        </div>

                                        <div className="delay-slider-container">
                                            <label className="delay-label">
                                                Polling Capture Delay: <span>{pollingSolveDelay}s</span>
                                            </label>
                                            <input
                                                type="range"
                                                min="1"
                                                max="20"
                                                value={pollingSolveDelay}
                                                onChange={(e) => setPollingSolveDelay(parseInt(e.target.value))}
                                                className="delay-slider"
                                                disabled={pollingSolveCountdown !== null || isPollingSolveActive}
                                            />
                                        </div>

                                        <p className="instruction-text" style={{ marginTop: '0.5rem', marginBottom: '1rem' }}>
                                            {isPollingSolveActive && `Sending polling capture to ${imageSolvePrimaryLabel}...`}
                                            {!isPollingSolveActive && pollingSolveCountdown === null && pollingSolveEnabled && 'Hold a question sheet in view to start the timer.'}
                                            {!isPollingSolveActive && pollingSolveCountdown === null && !pollingSolveEnabled && 'Start polling to automatically detect a sheet.'}
                                        </p>
                                    </div>

                                    <div className="polling-results-panel">
                                        <div className="polling-results-header">
                                            <span>Polling Solve Stack ({pollingSolveResults.length})</span>
                                            {pollingSolveResults.length > 0 && (
                                                <button className="delete-btn" onClick={clearPollingSolveStack}>
                                                    Clear
                                                </button>
                                            )}
                                        </div>
                                        {!isPollingResultsLoaded && (
                                            <div className="polling-results-empty">Loading saved polling results...</div>
                                        )}
                                        {isPollingResultsLoaded && pollingSolveResults.length === 0 && (
                                            <div className="polling-results-empty">No polling solves yet.</div>
                                        )}
                                        {pollingSolveResults.map((item) => {
                                            const itemProviderLabel = getProviderLabel(item.answerProvider || item.primaryProvider);
                                            return (
                                                <div className={`polling-result-card ${item.status}`} key={item.id}>
                                                    <button
                                                        className="polling-result-image"
                                                        onClick={() => item.image && setExpandedSolverScreenshot({ src: item.image, label: "Polling Request Image" })}
                                                        disabled={!item.image}
                                                    >
                                                        {item.image ? <img src={item.image} alt="Polling request" /> : <span>No image</span>}
                                                    </button>
                                                    <div className="polling-result-content">
                                                        <div className="polling-result-meta">
                                                            <span>{new Date(item.createdAt).toLocaleTimeString()}</span>
                                                            <span>{item.status}</span>
                                                            <span>{itemProviderLabel}</span>
                                                        </div>
                                                        {item.error && <div className="polling-result-error">{item.error}</div>}
                                                        {item.browserError && <div className="polling-result-warning">{item.browserError}</div>}
                                                        {item.answer && <div className="polling-result-answer">{item.answer}</div>}
                                                        {item.screenshot && (
                                                            <button
                                                                className="polling-result-link"
                                                                onClick={() => setExpandedSolverScreenshot({ src: item.screenshot!, label: `${itemProviderLabel} Screenshot` })}
                                                            >
                                                                Open primary screenshot
                                                            </button>
                                                        )}
                                                        {(item.backupStatus === "queued" || item.backupStatus === "solving") && (
                                                            <div className="polling-result-warning">{getProviderLabel(item.backupProvider)} backup running...</div>
                                                        )}
                                                        {item.backupScreenshot && (
                                                            <button
                                                                className="polling-result-link"
                                                                onClick={() => setExpandedSolverScreenshot({ src: item.backupScreenshot!, label: `${getProviderLabel(item.backupProvider)} Backup Screenshot` })}
                                                            >
                                                                Open backup screenshot
                                                            </button>
                                                        )}
                                                        {item.backupAnswer && <div className="polling-result-answer">{item.backupAnswer}</div>}
                                                        {item.backupError && <div className="polling-result-error">{item.backupError}</div>}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </>
                            ) : (
                                <>
                                    <button
                                        className={`capture-btn image-solve-btn ${imageSolveBusy || imageSolveCountdown !== null ? 'counting' : ''}`}
                                        onClick={startImageSolve}
                                        disabled={imageSolveBusy || imageSolveCountdown !== null}
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
                                        <button
                                            className="delete-btn"
                                            onClick={clearImageSolveResult}
                                        >✕</button>
                                    </div>
                                    {imageSolveAnswer && (
                                        <div className="image-solve-result-body">
                                            {imageSolveAnswer}
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
                    <h2>Extracted Questions ({savedQuestions.length})</h2>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
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
                    </div>
                </div>

                {savedQuestions.length > 0 && (
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

                <div className="results-content">
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
                                    // Pointer events for long tap detection
                                    onPointerDown={(e) => {
                                        // Ignore pointer down if clicking the checkbox/buttons directly
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
                                        <div className="question-body">
                                            {q.text}
                                        </div>
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
                </div>
            </div>
            <canvas ref={pollingDetectionCanvasRef} hidden />
        </div>
    );
}
