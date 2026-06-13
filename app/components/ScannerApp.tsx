"use client";

import React, { useRef, useState, useCallback, useEffect } from "react";
import Webcam from "react-webcam";
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
    quality: 0.9,
    minQuality: 0.72,
    maxWidth: 1920,
    maxHeight: 1440,
    maxDataUrlLength: 3_200_000,
};

const imageSolveCaptureOptions: CaptureFrameOptions = {
    mimeType: "image/jpeg",
    quality: 0.86,
    minQuality: 0.64,
    maxWidth: 1600,
    maxHeight: 1200,
    maxDataUrlLength: 2_400_000,
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

export default function ScannerApp() {
    const webcamRef = useRef<Webcam>(null);
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

    // Mounted state to avoid hydration errors with Webcam
    const [mounted, setMounted] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);

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

    const videoConstraints: MediaTrackConstraints = {
        width: { ideal: 2560 },
        height: { ideal: 1440 },
        aspectRatio: { ideal: 16 / 9 },
        facingMode: "user", // Keep using the same existing front/user camera.
    };

    const loadImage = useCallback((src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new window.Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    }), []);

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

    const normalizeImageSource = useCallback(async (src: string, flip = false, options = scanCaptureOptions) => {
        const img = await loadImage(src);
        const canvas = drawCaptureToCanvas(
            img,
            img.naturalWidth || img.width,
            img.naturalHeight || img.height,
            flip,
            options,
        );

        return encodeCanvasWithinLimit(canvas, options);
    }, [drawCaptureToCanvas, encodeCanvasWithinLimit, loadImage]);

    const captureHighQualityFrame = useCallback(async (options = scanCaptureOptions) => {
        const video = webcamRef.current?.video;
        if (!video) return null;

        if (video.videoWidth && video.videoHeight) {
            const canvas = drawCaptureToCanvas(video, video.videoWidth, video.videoHeight, false, options);
            console.log(`Captured video frame at ${video.videoWidth}x${video.videoHeight}`);
            return encodeCanvasWithinLimit(canvas, options);
        }

        const imageSrc = webcamRef.current?.getScreenshot();
        return imageSrc ? normalizeImageSource(imageSrc, true, options) : null;
    }, [drawCaptureToCanvas, encodeCanvasWithinLimit, normalizeImageSource, webcamRef]);

    const handleUserMedia = useCallback(async (stream: MediaStream) => {
        const track = stream.getVideoTracks()[0];
        if (!track) return;

        try {
            await track.applyConstraints({
                width: { ideal: 2560 },
                height: { ideal: 1440 },
                aspectRatio: { ideal: 16 / 9 },
            } as MediaTrackConstraints);
        } catch (error) {
            console.warn("Camera rejected high-resolution constraints; using browser-selected quality.", error);
        }

        const settings = track.getSettings();
        console.log(`Camera stream active at ${settings.width || "?"}x${settings.height || "?"}`);
    }, []);

    const getCaptureResolution = () => {
        const video = webcamRef.current?.video;
        if (!video) return null;
        return {
            width: video.videoWidth,
            height: video.videoHeight,
        };
    };

    const capture = useCallback(async (autoTriggered = false) => {
        if (!webcamRef.current) return;

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
    }, [webcamRef, captureHighQualityFrame]);

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
            imageSolveBackupStatus === "queued" ||
            imageSolveBackupStatus === "solving" ||
            imageSolveCountdown !== null
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
        if (!webcamRef.current || imageSolveStatus === "solving" || imageSolveStatus === "capturing") return;

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
    }, [webcamRef, imageSolveStatus, customSolvePrompt, imageSolvePrimaryProvider, captureHighQualityFrame]);

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
        imageSolveBackupStatus === "solving";

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

    return (
        <div className="scanner-layout">
            {/* Left side: Camera Viewport */}
            <div className="scanner-section">
                <div className="webcam-container">
                    <Webcam
                        audio={false}
                        ref={webcamRef}
                        screenshotFormat="image/png"
                        minScreenshotWidth={1920}
                        minScreenshotHeight={1080}
                        forceScreenshotSourceSize={true}
                        videoConstraints={videoConstraints}
                        onUserMedia={handleUserMedia}
                        className={`webcam-preview ${isCapturing ? "capture-flash" : ""}`}
                        mirrored={true} // Usually better UX for front camera
                    />

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
                                    setImageSolveMode(false);
                                    clearImageSolveResult();
                                }}
                            >
                                📄 Scan Mode
                            </button>
                            <button
                                className={`mode-btn ${imageSolveMode ? 'active' : ''}`}
                                onClick={() => {
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
                            <div className="provider-priority-toggle">
                                <span>First response</span>
                                <div className="provider-priority-actions">
                                    <button
                                        type="button"
                                        className={`provider-priority-btn ${imageSolvePrimaryProvider === "chatgpt" ? "active" : ""}`}
                                        onClick={() => handleImageSolvePrimaryProviderChange("chatgpt")}
                                        disabled={imageSolveBusy || imageSolveCountdown !== null}
                                        aria-pressed={imageSolvePrimaryProvider === "chatgpt"}
                                    >
                                        ChatGPT
                                    </button>
                                    <button
                                        type="button"
                                        className={`provider-priority-btn ${imageSolvePrimaryProvider === "gemini" ? "active" : ""}`}
                                        onClick={() => handleImageSolvePrimaryProviderChange("gemini")}
                                        disabled={imageSolveBusy || imageSolveCountdown !== null}
                                        aria-pressed={imageSolvePrimaryProvider === "gemini"}
                                    >
                                        Gemini
                                    </button>
                                </div>
                            </div>

                            <button
                                className={`capture-btn image-solve-btn ${imageSolveBusy || imageSolveCountdown !== null ? 'counting' : ''
                                    }`}
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

                            {imageSolveBrowserError && (
                                <div className="image-solve-browser-error">
                                    <strong>Browser solve failed:</strong> {imageSolveBrowserError}
                                    {(imageSolveStatus === 'solving' || imageSolveBackupStatus === 'queued' || imageSolveBackupStatus === 'solving') && (
                                        <span> Fallback is running...</span>
                                    )}
                                </div>
                            )}

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
        </div>
    );
}
