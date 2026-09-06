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
    transcript?: string;
    audioDataUrl?: string | null;
    questionIntro?: string;
    isTranscribing?: boolean;
}

type ImageSolveProvider = "deepseek" | "gemini";

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
    flipClipboard?: boolean;
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
    { id: "deepseek", label: "DeepSeek" },
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
    if (provider === "deepseek") return "DeepSeek";
    if (provider === "gemini") return "Gemini";
    if (provider === "gemini-api") return "Gemini API";
    return "Image Solve";
};

const normalizeImageSolveProvider = (provider: string | null | undefined): ImageSolveProvider | null =>
    provider === "deepseek" || provider === "gemini" ? provider : null;

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

// ─── Sound Effects (WAV Data URI + Web Audio API Dual Pipeline) ───────────────
const createWavDataUri = (sampleRate: number, generateSample: (t: number, dur: number) => number, durationSec: number): string => {
    const numSamples = Math.floor(sampleRate * durationSec);
    const headerSize = 44;
    const totalSize = headerSize + numSamples;
    const buffer = new Uint8Array(totalSize);

    const writeString = (offset: number, str: string) => {
        for (let i = 0; i < str.length; i++) buffer[offset + i] = str.charCodeAt(i);
    };
    const writeUint32 = (offset: number, val: number) => {
        buffer[offset] = val & 0xff;
        buffer[offset + 1] = (val >> 8) & 0xff;
        buffer[offset + 2] = (val >> 16) & 0xff;
        buffer[offset + 3] = (val >> 24) & 0xff;
    };
    const writeUint16 = (offset: number, val: number) => {
        buffer[offset] = val & 0xff;
        buffer[offset + 1] = (val >> 8) & 0xff;
    };

    writeString(0, "RIFF");
    writeUint32(4, 36 + numSamples);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    writeUint32(16, 16); // Subchunk1Size
    writeUint16(20, 1);  // AudioFormat (PCM)
    writeUint16(22, 1);  // NumChannels (1 mono)
    writeUint32(24, sampleRate);
    writeUint32(28, sampleRate); // ByteRate (sampleRate * 1 * 1)
    writeUint16(32, 1);  // BlockAlign
    writeUint16(34, 8);  // BitsPerSample
    writeString(36, "data");
    writeUint32(40, numSamples);

    for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        const val = generateSample(t, durationSec);
        buffer[44 + i] = Math.max(0, Math.min(255, Math.round((val + 1) * 127.5)));
    }

    let binary = "";
    const len = buffer.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(buffer[i]);
    }
    return `data:audio/wav;base64,${btoa(binary)}`;
};

let boopAudioElement: HTMLAudioElement | null = null;
let cancelAudioElement: HTMLAudioElement | null = null;
let sharedAudioCtx: AudioContext | null = null;

const getSharedAudioContext = () => {
    if (typeof window === "undefined") return null;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
        sharedAudioCtx = new AudioCtx();
    }
    if (sharedAudioCtx.state === "suspended") {
        sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
};

const getBoopAudio = () => {
    if (typeof window === "undefined") return null;
    if (!boopAudioElement) {
        try {
            const uri = createWavDataUri(22050, (t, dur) => {
                const freq = 520 + (960 - 520) * (t / dur);
                const env = Math.max(0, 1 - t / dur);
                return Math.sin(2 * Math.PI * freq * t) * env * 0.95;
            }, 0.18);
            boopAudioElement = new Audio(uri);
            boopAudioElement.volume = 0.85;
        } catch { }
    }
    return boopAudioElement;
};

const getCancelAudio = () => {
    if (typeof window === "undefined") return null;
    if (!cancelAudioElement) {
        try {
            const uri = createWavDataUri(22050, (t, dur) => {
                if (t < 0.1) {
                    const freq = 380 - (380 - 260) * (t / 0.1);
                    const env = 1 - t / 0.1;
                    return Math.sin(2 * Math.PI * freq * t) * env * 0.8;
                } else {
                    const t2 = t - 0.1;
                    const dur2 = dur - 0.1;
                    const freq = 240 - (240 - 130) * (t2 / dur2);
                    const env = 1 - t2 / dur2;
                    return Math.sin(2 * Math.PI * freq * t2) * env * 0.9;
                }
            }, 0.28);
            cancelAudioElement = new Audio(uri);
            cancelAudioElement.volume = 0.85;
        } catch { }
    }
    return cancelAudioElement;
};

const playBoopSound = () => {
    if (typeof window === "undefined") return;

    // 1. Play via HTML5 Audio
    try {
        const audio = getBoopAudio();
        if (audio) {
            audio.currentTime = 0;
            audio.play().catch(() => {});
        }
    } catch {}

    // 2. Play via Web Audio API
    try {
        const ctx = getSharedAudioContext();
        if (ctx) {
            const synth = () => {
                const now = ctx.currentTime;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = "sine";
                osc.frequency.setValueAtTime(520, now);
                osc.frequency.exponentialRampToValueAtTime(960, now + 0.08);
                gain.gain.setValueAtTime(0.4, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(now);
                osc.stop(now + 0.18);
            };

            if (ctx.state === "suspended") {
                ctx.resume().then(synth).catch(() => {});
            } else {
                synth();
            }
        }
    } catch (e) {
        console.warn("Could not play boop sound:", e);
    }
};

const playCancelSound = () => {
    if (typeof window === "undefined") return;

    // 1. Play via HTML5 Audio
    try {
        const audio = getCancelAudio();
        if (audio) {
            audio.currentTime = 0;
            audio.play().catch(() => {});
        }
    } catch {}

    // 2. Play via Web Audio API
    try {
        const ctx = getSharedAudioContext();
        if (ctx) {
            const synth = () => {
                const now = ctx.currentTime;
                // Tone 1: 380Hz -> 260Hz
                const osc1 = ctx.createOscillator();
                const gain1 = ctx.createGain();
                osc1.type = "triangle";
                osc1.frequency.setValueAtTime(380, now);
                osc1.frequency.exponentialRampToValueAtTime(260, now + 0.1);
                gain1.gain.setValueAtTime(0.35, now);
                gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
                osc1.connect(gain1);
                gain1.connect(ctx.destination);
                osc1.start(now);
                osc1.stop(now + 0.12);

                // Tone 2: 240Hz -> 130Hz
                const osc2 = ctx.createOscillator();
                const gain2 = ctx.createGain();
                osc2.type = "triangle";
                osc2.frequency.setValueAtTime(240, now + 0.09);
                osc2.frequency.exponentialRampToValueAtTime(130, now + 0.28);
                gain2.gain.setValueAtTime(0.35, now + 0.09);
                gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
                osc2.connect(gain2);
                gain2.connect(ctx.destination);
                osc2.start(now + 0.09);
                osc2.stop(now + 0.3);
            };

            if (ctx.state === "suspended") {
                ctx.resume().then(synth).catch(() => {});
            } else {
                synth();
            }
        }
    } catch (e) {
        console.warn("Could not play cancel sound:", e);
    }
};

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
    const pollingCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const darknessStartTimeRef = useRef<number | null>(null);
    const abortedDueToLongDarknessRef = useRef<boolean>(false);
    const countdownTriggeredByDarknessRef = useRef<boolean>(false);

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
    const [captureDelay, setCaptureDelay] = useState(10);
    const [darknessDuration, setDarknessDuration] = useState<number>(0);
    const [darknessStatus, setDarknessStatus] = useState<"idle" | "covering" | "countdown" | "aborted">("idle");
    const [darknessAbortMessage, setDarknessAbortMessage] = useState<string | null>(null);

    // ── Spoken Audio Playback & Looping ───────────────────────────────────────
    const [activeAudioIndex, setActiveAudioIndex] = useState<number | null>(null);
    const [isAudioPlaying, setIsAudioPlaying] = useState<boolean>(false);
    const [audioStatusMessage, setAudioStatusMessage] = useState<string | null>(null);
    const currentAudioRef = useRef<HTMLAudioElement | null>(null);
    const speechUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
    const isLoopingRef = useRef<boolean>(true);
    const audioDataCacheRef = useRef<Map<string, { audioDataUrl?: string | null; transcript: string; spokenText: string; questionIntro?: string }>>(new Map());

    // ── Image Solve mode ──────────────────────────────────────────────────────
    const [imageSolveMode, setImageSolveMode] = useState(false);
    const [imageSolveJobId, setImageSolveJobId] = useState<string | null>(null);
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
    const [uploadedImagePreviews, setUploadedImagePreviews] = useState<string[]>([]);
    const [uploadedImagesBase64, setUploadedImagesBase64] = useState<string[]>([]);

    // ── File upload ───────────────────────────────────────────────────────────
    const handleFilesUpload = useCallback(async (files: FileList | File[]) => {
        const imageFiles = Array.from(files).filter(f => f.type.startsWith("image/"));
        if (!imageFiles.length) return;

        const readPromises = imageFiles.map(file => {
            return new Promise<string>((resolve) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target?.result as string);
                reader.readAsDataURL(file);
            });
        });

        const dataUrls = await Promise.all(readPromises);
        const validUrls = dataUrls.filter(Boolean) as string[];
        if (!validUrls.length) return;

        setUploadedImagePreviews(validUrls);
        setUploadedImagesBase64(validUrls);
        clearImageSolveResult();
    }, []);

    // ── Provider setup: ordered checklist ─────────────────────────────────────
    const [imageSolveProviderOrder, setImageSolveProviderOrder] = useState<string[]>(["deepseek", "gemini"]);
    const [imageSolveProviderEnabled, setImageSolveProviderEnabled] = useState<Record<string, boolean>>({ deepseek: true, gemini: true });
    const [providerDragOver, setProviderDragOver] = useState<number | null>(null);

    // ── Retry ─────────────────────────────────────────────────────────────────
    const [lastSolvedImageBase64, setLastSolvedImageBase64] = useState<string | null>(null);
    const [lastSolvedPrompt, setLastSolvedPrompt] = useState<string | null>(null);
    const [lastSolvedFlipClipboard, setLastSolvedFlipClipboard] = useState<boolean>(true);

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
                let parsed = JSON.parse(storedOrder);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    // Migrate legacy "chatgpt" saved in localStorage to "deepseek"
                    parsed = parsed.map(p => p === "chatgpt" ? "deepseek" : p);
                    setImageSolveProviderOrder(parsed);
                }
            } catch { /* ignore */ }
        }

        const storedEnabled = localStorage.getItem("scannerApp_imageSolveProviderEnabled");
        if (storedEnabled) {
            try {
                const parsed = JSON.parse(storedEnabled);
                if (parsed && typeof parsed === "object") {
                    // Migrate legacy "chatgpt" key to "deepseek"
                    if ("chatgpt" in parsed) {
                        parsed.deepseek = parsed.chatgpt;
                        delete parsed.chatgpt;
                    }
                    setImageSolveProviderEnabled(parsed);
                }
            } catch { /* ignore */ }
        }

        // Warm up and unlock audio context on first user interaction
        const unlockAudio = () => {
            getSharedAudioContext();
            getBoopAudio();
            getCancelAudio();
        };
        window.addEventListener("pointerdown", unlockAudio, { once: true });
        window.addEventListener("click", unlockAudio, { once: true });
        window.addEventListener("touchstart", unlockAudio, { once: true });
        window.addEventListener("keydown", unlockAudio, { once: true });

        setIsLoaded(true);
        setMounted(true);

        return () => {
            window.removeEventListener("pointerdown", unlockAudio);
            window.removeEventListener("click", unlockAudio);
            window.removeEventListener("touchstart", unlockAudio);
            window.removeEventListener("keydown", unlockAudio);
        };
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
                            flipClipboard: job.flipClipboard,
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

    // ── Spoken Audio Playback Functions ───────────────────────────────────────
    const stopCurrentAudio = useCallback(() => {
        if (currentAudioRef.current) {
            try {
                currentAudioRef.current.pause();
                currentAudioRef.current.currentTime = 0;
            } catch { }
            currentAudioRef.current = null;
        }
        if (typeof window !== "undefined" && "speechSynthesis" in window) {
            try {
                window.speechSynthesis.cancel();
            } catch { }
        }
        setIsAudioPlaying(false);
    }, []);

    const playBrowserSpeechFallback = useCallback((text: string) => {
        if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
        try {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.rate = 0.95;
            utterance.onend = () => {
                if (isLoopingRef.current) {
                    setTimeout(() => {
                        try { window.speechSynthesis.speak(utterance); } catch { }
                    }, 400);
                }
            };
            speechUtteranceRef.current = utterance;
            window.speechSynthesis.speak(utterance);
            setIsAudioPlaying(true);
        } catch (e) {
            console.warn("Speech synthesis fallback failed:", e);
        }
    }, []);

    const prefetchRemainingAudio = useCallback(async (list: ScannedQuestion[], currentIndex: number) => {
        for (let i = 0; i < list.length; i++) {
            const nextIdx = (currentIndex + 1 + i) % list.length;
            if (nextIdx === currentIndex) continue;
            const q = list[nextIdx];
            if (!q || !q.solution || audioDataCacheRef.current.has(q.id)) continue;

            try {
                const res = await fetch("/api/transcribe", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        questionText: q.text,
                        solutionText: q.solution,
                        questionNumber: q.questionNumber || String(nextIdx + 1),
                    }),
                });
                if (res.ok) {
                    const data = await res.json();
                    audioDataCacheRef.current.set(q.id, {
                        audioDataUrl: data.audioDataUrl,
                        transcript: data.transcript,
                        spokenText: data.spokenText,
                        questionIntro: data.questionIntro,
                    });
                    setSavedQuestions(prev => prev.map(sq => sq.id === q.id ? {
                        ...sq,
                        transcript: data.transcript,
                        audioDataUrl: data.audioDataUrl,
                        questionIntro: data.questionIntro
                    } : sq));
                }
            } catch (e) {
                console.warn("Background prefetch failed for question:", q.id, e);
            }
        }
    }, []);

    const playQuestionAudio = useCallback(async (index: number, list?: ScannedQuestion[]) => {
        setSavedQuestions(currentSaved => {
            const solvedList = list || currentSaved.filter(q => !!q.solution);
            if (!solvedList || solvedList.length === 0) return currentSaved;

            const boundedIndex = ((index % solvedList.length) + solvedList.length) % solvedList.length;
            const targetQ = solvedList[boundedIndex];
            if (!targetQ || !targetQ.solution) return currentSaved;

            setActiveAudioIndex(boundedIndex);
            stopCurrentAudio();

            setAudioStatusMessage(`Encoding spoken audio for Question ${targetQ.questionNumber || boundedIndex + 1}...`);

            (async () => {
                try {
                    let cached = audioDataCacheRef.current.get(targetQ.id);
                    if (!cached) {
                        const res = await fetch("/api/transcribe", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                questionText: targetQ.text,
                                solutionText: targetQ.solution,
                                questionNumber: targetQ.questionNumber || String(boundedIndex + 1),
                            }),
                        });

                        if (!res.ok) {
                            const errJson = await res.json();
                            throw new Error(errJson.error || `Transcribe failed: ${res.status}`);
                        }

                        const data = await res.json();
                        cached = {
                            audioDataUrl: data.audioDataUrl,
                            transcript: data.transcript,
                            spokenText: data.spokenText,
                            questionIntro: data.questionIntro,
                        };
                        audioDataCacheRef.current.set(targetQ.id, cached);

                        setSavedQuestions(prev => prev.map(q => q.id === targetQ.id ? {
                            ...q,
                            transcript: data.transcript,
                            audioDataUrl: data.audioDataUrl,
                            questionIntro: data.questionIntro
                        } : q));
                    }

                    if (cached.audioDataUrl) {
                        const audio = new Audio(cached.audioDataUrl);
                        audio.loop = true;
                        audio.onplay = () => setIsAudioPlaying(true);
                        audio.onpause = () => setIsAudioPlaying(false);
                        audio.onerror = () => {
                            console.warn("Audio element error. Falling back to browser speech synthesis.");
                            playBrowserSpeechFallback(cached!.spokenText);
                        };

                        currentAudioRef.current = audio;
                        await audio.play();
                        setIsAudioPlaying(true);
                        setAudioStatusMessage(`Playing Question ${targetQ.questionNumber || boundedIndex + 1} (Looping)`);
                    } else {
                        playBrowserSpeechFallback(cached.spokenText);
                        setAudioStatusMessage(`Playing Question ${targetQ.questionNumber || boundedIndex + 1} (Browser Speech, Looping)`);
                    }

                    // Prefetch the remaining questions in background
                    prefetchRemainingAudio(solvedList, boundedIndex);
                } catch (err: unknown) {
                    console.error("Play question audio error:", err);
                    setAudioStatusMessage("Audio playback failed: " + getErrorMessage(err));
                }
            })();

            return currentSaved;
        });
    }, [stopCurrentAudio, playBrowserSpeechFallback, prefetchRemainingAudio]);

    const autoSolveAndPlay = useCallback(async (questionsToSolve: ScannedQuestion[]) => {
        if (!questionsToSolve || questionsToSolve.length === 0) return;

        setIsProcessingSolutions(true);
        setAudioStatusMessage("Solving scanned questions with AI...");

        try {
            const payload = questionsToSolve.map(q => ({ id: q.id, text: q.text }));
            const solveRes = await fetch("/api/solve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ questions: payload, customSolvePrompt }),
            });

            if (!solveRes.ok) {
                const errData = await solveRes.json();
                throw new Error(errData.error || `Solve failed: ${solveRes.status}`);
            }

            const solveData = await solveRes.json();
            const solutionsMap: Record<string, string> = solveData.solutions || {};

            const solvedList: ScannedQuestion[] = [];

            setSavedQuestions(prev => {
                const updated = prev.map(q => {
                    const sol = solutionsMap[q.id];
                    if (sol) {
                        const solvedItem = { ...q, solution: sol, isSolving: false };
                        solvedList.push(solvedItem);
                        return solvedItem;
                    }
                    return { ...q, isSolving: false };
                });
                return updated;
            });

            setExpandedSolutionIds(new Set(questionsToSolve.map(q => q.id)));

            if (solvedList.length > 0) {
                playQuestionAudio(0, solvedList);
            } else {
                setAudioStatusMessage("No solutions generated from scan.");
            }
        } catch (err: unknown) {
            console.error("Auto solve failed:", err);
            setErrorMessage(getErrorMessage(err, "Failed to solve questions."));
            setAudioStatusMessage("Solving failed: " + getErrorMessage(err));
            setSavedQuestions(prev => prev.map(q => ({ ...q, isSolving: false })));
        } finally {
            setIsProcessingSolutions(false);
        }
    }, [customSolvePrompt, playQuestionAudio]);

    const toggleAudioPlayPause = useCallback(() => {
        if (currentAudioRef.current) {
            if (currentAudioRef.current.paused) {
                currentAudioRef.current.play();
                setIsAudioPlaying(true);
            } else {
                currentAudioRef.current.pause();
                setIsAudioPlaying(false);
            }
        } else if (speechUtteranceRef.current && typeof window !== "undefined" && "speechSynthesis" in window) {
            if (window.speechSynthesis.speaking) {
                if (window.speechSynthesis.paused) {
                    window.speechSynthesis.resume();
                    setIsAudioPlaying(true);
                } else {
                    window.speechSynthesis.pause();
                    setIsAudioPlaying(false);
                }
            } else if (activeAudioIndex !== null) {
                playQuestionAudio(activeAudioIndex);
            }
        } else if (activeAudioIndex !== null) {
            playQuestionAudio(activeAudioIndex);
        } else {
            const solved = savedQuestions.filter(q => !!q.solution);
            if (solved.length > 0) playQuestionAudio(0, solved);
        }
    }, [activeAudioIndex, playQuestionAudio, savedQuestions]);

    const cycleNextSolution = useCallback(() => {
        const solved = savedQuestions.filter(q => !!q.solution);
        if (solved.length === 0) return;
        const nextIndex = activeAudioIndex === null ? 0 : (activeAudioIndex + 1) % solved.length;
        playQuestionAudio(nextIndex, solved);
    }, [savedQuestions, activeAudioIndex, playQuestionAudio]);

    const cyclePrevSolution = useCallback(() => {
        const solved = savedQuestions.filter(q => !!q.solution);
        if (solved.length === 0) return;
        const prevIndex = activeAudioIndex === null ? 0 : (activeAudioIndex - 1 + solved.length) % solved.length;
        playQuestionAudio(prevIndex, solved);
    }, [savedQuestions, activeAudioIndex, playQuestionAudio]);

    // Clean up audio on unmount
    useEffect(() => {
        return () => {
            stopCurrentAudio();
        };
    }, [stopCurrentAudio]);

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
            const rawQuestions = data.questions || [];
            if (rawQuestions.length === 0) {
                setScanStatus("error");
                setErrorMessage("No questions detected in the scanned image. Please position the paper and try again.");
                return;
            }

            const assignedQuestions: ScannedQuestion[] = rawQuestions.map((newQ: any, idx: number) => ({
                id: newQ.id || `q-${Date.now()}-${idx}`,
                questionNumber: newQ.questionNumber || String(idx + 1),
                text: newQ.text || "",
                isSolving: true,
            }));

            setSavedQuestions(assignedQuestions);
            setScanStatus("success");

            // Automatically solve all questions and start spoken looping playback
            autoSolveAndPlay(assignedQuestions);
        } catch (error: unknown) {
            console.error("Scan error:", error);
            setScanStatus("error");
            setErrorMessage(getErrorMessage(error, "Failed to process the question paper."));
        }
    }, [captureHighQualityFrame, autoSolveAndPlay]);

    // ── Frame Darkness Detection ──────────────────────────────────────────────
    const checkFrameDarkness = useCallback((): { isDark: boolean; avgLuminance: number } => {
        const video = videoRef.current;
        if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
            return { isDark: false, avgLuminance: 255 };
        }

        if (!pollingCanvasRef.current) {
            pollingCanvasRef.current = document.createElement("canvas");
            pollingCanvasRef.current.width = 32;
            pollingCanvasRef.current.height = 32;
        }

        const canvas = pollingCanvasRef.current;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return { isDark: false, avgLuminance: 255 };

        ctx.drawImage(video, 0, 0, 32, 32);
        const imageData = ctx.getImageData(0, 0, 32, 32);
        const data = imageData.data;
        let totalLuminance = 0;
        let maxLuminance = 0;
        const pixelCount = data.length / 4;

        for (let i = 0; i < data.length; i += 4) {
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            totalLuminance += lum;
            if (lum > maxLuminance) maxLuminance = lum;
        }

        const avgLuminance = totalLuminance / pixelCount;
        // Covered camera threshold: average luminance < 15 and max luminance < 35
        const isDark = avgLuminance < 15 && maxLuminance < 35;
        return { isDark, avgLuminance };
    }, []);

    // ── Camera Polling for Complete Darkness (Scan Mode) ──────────────────────
    useEffect(() => {
        if (!mounted || imageSolveMode || scanStatus === "scanning" || cameraError) {
            darknessStartTimeRef.current = null;
            abortedDueToLongDarknessRef.current = false;
            countdownTriggeredByDarknessRef.current = false;
            setDarknessDuration(0);
            return;
        }

        const interval = setInterval(() => {
            const { isDark } = checkFrameDarkness();
            const now = Date.now();

            const solvedQuestions = savedQuestions.filter(q => !!q.solution);
            const hasActiveSolutions = solvedQuestions.length > 0;

            if (hasActiveSolutions) {
                // ── PLAYBACK GESTURE MODE ──────────────────────────────────
                if (isDark) {
                    if (darknessStartTimeRef.current === null) {
                        darknessStartTimeRef.current = now;
                    }

                    const elapsed = (now - darknessStartTimeRef.current) / 1000;
                    setDarknessDuration(elapsed);

                    // 10s Continuous Darkness -> RESET
                    if (elapsed >= 10.0) {
                        console.log("[Gesture] 10s continuous darkness -> RESET TRIGGERED!");
                        darknessStartTimeRef.current = null;
                        setDarknessDuration(0);
                        abortedDueToLongDarknessRef.current = true; // Wait for uncover
                        stopCurrentAudio();
                        setSavedQuestions([]);
                        setSelectedQuestionIds(new Set());
                        setActiveAudioIndex(null);
                        setAudioStatusMessage(null);
                        audioDataCacheRef.current.clear();
                        setDarknessStatus("aborted");
                        setDarknessAbortMessage("RESET complete: All questions cleared. Uncover camera to resume scan polling.");
                        playCancelSound();
                        try { if ("vibrate" in navigator) navigator.vibrate([200, 100, 200]); } catch { }
                        return;
                    } else if (elapsed >= 4.5 && elapsed <= 7.5) {
                        setDarknessStatus("covering");
                        setDarknessAbortMessage("Ready! Release now to cycle to next solution (Refresh)");
                    } else if (elapsed > 7.5) {
                        setDarknessStatus("covering");
                        setDarknessAbortMessage(`Hold until 10s to RESET (${(10 - elapsed).toFixed(1)}s remaining)`);
                    } else {
                        setDarknessStatus("covering");
                        setDarknessAbortMessage(`Covering camera: ${elapsed.toFixed(1)}s (Release at 5s to cycle, hold 10s to reset)`);
                    }
                } else {
                    // Light detected! Camera uncovered.
                    if (abortedDueToLongDarknessRef.current) {
                        console.log("[Gesture] Camera uncovered after reset. Ready for scan.");
                        abortedDueToLongDarknessRef.current = false;
                        setDarknessStatus("idle");
                        setDarknessAbortMessage(null);
                        darknessStartTimeRef.current = null;
                        setDarknessDuration(0);
                        return;
                    }

                    if (darknessStartTimeRef.current !== null) {
                        const coverDuration = (now - darknessStartTimeRef.current) / 1000;
                        darknessStartTimeRef.current = null;
                        setDarknessDuration(0);
                        setDarknessStatus("idle");
                        setDarknessAbortMessage(null);

                        // REFRESH: 5s with 1-2s buffer (4.5s to 7.5s)
                        if (coverDuration >= 4.5 && coverDuration <= 7.5) {
                            console.log(`[Gesture] Camera uncovered after ${coverDuration.toFixed(1)}s -> REFRESH TRIGGERED!`);
                            playBoopSound();
                            try { if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]); } catch { }
                            const nextIndex = activeAudioIndex === null ? 0 : (activeAudioIndex + 1) % solvedQuestions.length;
                            playQuestionAudio(nextIndex, solvedQuestions);
                        } else {
                            console.log(`[Gesture] Camera uncovered after ${coverDuration.toFixed(1)}s (not within 4.5s - 7.5s buffer)`);
                        }
                    } else {
                        setDarknessStatus("idle");
                    }
                }
                return;
            }

            // ── IDLE / SCAN MODE (No active solutions) ─────────────────────
            if (isDark) {
                // If already aborted at countdown end, do not re-trigger while darkness persists! Wait for light.
                if (abortedDueToLongDarknessRef.current) {
                    return;
                }

                // If countdown is active, camera is currently covered during countdown
                if (countdown !== null) {
                    setDarknessDuration(5);
                    return;
                }

                if (darknessStartTimeRef.current === null) {
                    darknessStartTimeRef.current = now;
                }

                const elapsed = (now - darknessStartTimeRef.current) / 1000;
                setDarknessDuration(Math.min(elapsed, 5));

                // Trigger scan countdown at the 5.0-second mark of continuous darkness
                if (elapsed >= 5.0 && !countdownTriggeredByDarknessRef.current && countdown === null) {
                    console.log("[Darkness Poller] Darkness reached 5s! Initiating countdown.");
                    countdownTriggeredByDarknessRef.current = true;
                    setCountdown(captureDelay);
                    setDarknessStatus("countdown");
                    setDarknessAbortMessage(null);
                    playBoopSound();
                    try { if ("vibrate" in navigator) navigator.vibrate([120, 60, 120]); } catch { }
                } else if (elapsed < 5.0) {
                    setDarknessStatus("covering");
                }
            } else {
                // Camera sees light!
                if (abortedDueToLongDarknessRef.current) {
                    // Re-arm sensor now that the camera has been uncovered
                    console.log("[Darkness Poller] Camera uncovered. Sensor re-armed.");
                    abortedDueToLongDarknessRef.current = false;
                    setDarknessStatus("idle");
                    setDarknessAbortMessage(null);
                }

                darknessStartTimeRef.current = null;
                setDarknessDuration(0);

                if (countdown === null) {
                    setDarknessStatus("idle");
                }
            }
        }, 100);

        return () => clearInterval(interval);
    }, [mounted, imageSolveMode, scanStatus, cameraError, countdown, captureDelay, checkFrameDarkness, savedQuestions, activeAudioIndex, playQuestionAudio, stopCurrentAudio]);

    // ── Countdown for scan ────────────────────────────────────────────────────
    useEffect(() => {
        if (countdown === null) return;
        if (countdown > 0) {
            const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
            try { if ("vibrate" in navigator) navigator.vibrate(50); } catch { }
            return () => clearTimeout(timer);
        } else if (countdown === 0) {
            setCountdown(null);
            countdownTriggeredByDarknessRef.current = false;

            // Check if by the time countdown ends it is STILL dark
            const { isDark } = checkFrameDarkness();
            if (isDark) {
                console.log("[Countdown End] Camera is STILL dark. Aborting scan.");
                abortedDueToLongDarknessRef.current = true;
                setDarknessStatus("aborted");
                setDarknessAbortMessage("Scan aborted: Camera remained covered when countdown ended. Uncover camera to resume.");
                playCancelSound();
                try { if ("vibrate" in navigator) navigator.vibrate([200, 100, 200]); } catch { }
                return;
            }

            // Camera is uncovered (light detected): capture document!
            setDarknessStatus("idle");
            playBoopSound();
            capture(true);
        }
    }, [countdown, capture, checkFrameDarkness]);

    const cancelScanCountdown = useCallback(() => {
        setCountdown(null);
        countdownTriggeredByDarknessRef.current = false;
        darknessStartTimeRef.current = null;
        setDarknessDuration(0);
        setDarknessStatus("idle");
        playCancelSound();
    }, []);

    const startManualScan = () => {
        if (scanStatus === "scanning" || countdown !== null) return;
        countdownTriggeredByDarknessRef.current = false;
        setCountdown(captureDelay);
        setDarknessStatus("countdown");
        playBoopSound();
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
        setImageSolveJobId(null);
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
        const requestPrimaryProvider = (enabledProviders[0] ?? "deepseek") as ImageSolveProvider;
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
        setLastSolvedFlipClipboard(true);

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
                    flipClipboard: true,
                }),
            });

            const data = await readImageSolveResponse(response);

            if (!isCurrentRun()) return;

            if (!response.ok || (data.error && !data.jobId && !data.fallbackRequired)) {
                throw new Error(data.error || `Server returned ${response.status}`);
            }

            if (data.jobId) {
                setImageSolveJobId(data.jobId);
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

    // ── Image Solve: solve batch from images ──────────────────────────────────
    const solveBatchUploadedImages = useCallback(async (base64Images: string[]) => {
        if (imageSolveStatus === "solving" || imageSolveStatus === "capturing" || base64Images.length === 0) return;

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

        const enabledProviders = imageSolveProviderOrder.filter(p => imageSolveProviderEnabled[p]);
        const requestPrimaryProvider = (enabledProviders[0] ?? "deepseek") as ImageSolveProvider;
        const requestBackupProvider = (enabledProviders[1] ?? null) as ImageSolveProvider | null;
        setImageSolveBackupProvider(requestBackupProvider);

        try {
            const response = await fetch("/api/image-solve/batch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    images: base64Images,
                    prompt: customSolvePrompt,
                    primaryProvider: requestPrimaryProvider,
                    backupProvider: requestBackupProvider,
                    flipClipboard: false,
                }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => null);
                throw new Error(errorData?.error || `HTTP error! status: ${response.status}`);
            }
            
            fetchHistory();
            
            setImageSolveStatus("idle");
            setUploadedImagesBase64([]);
            setUploadedImagePreviews([]);
        } catch (error: unknown) {
            console.error("Batch image solve error:", error);
            setImageSolveStatus("error");
            setImageSolveError(`Failed to queue batch solve: ${getErrorMessage(error)}`);
        }
    }, [imageSolveStatus, customSolvePrompt, imageSolveProviderOrder, imageSolveProviderEnabled, fetchHistory]);

    // ── Image Solve: solve from image (upload or retry) ───────────────────────
    const solveWithUploadedImage = useCallback(async (base64Image: string, promptOverride?: string, flipClipboard: boolean = false, providerOverride?: string) => {
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

        // If a specific provider override is given, use it as primary with no backup
        let requestPrimaryProvider: ImageSolveProvider;
        let requestBackupProvider: ImageSolveProvider | null;
        if (providerOverride) {
            requestPrimaryProvider = providerOverride as ImageSolveProvider;
            requestBackupProvider = null;
        } else {
            const enabledProviders = imageSolveProviderOrder.filter(p => imageSolveProviderEnabled[p]);
            requestPrimaryProvider = (enabledProviders[0] ?? "deepseek") as ImageSolveProvider;
            requestBackupProvider = (enabledProviders[1] ?? null) as ImageSolveProvider | null;
        }
        setImageSolveBackupProvider(requestBackupProvider);

        // Store for retry
        setLastSolvedImageBase64(base64Image);
        setLastSolvedPrompt(solvePrompt);
        setLastSolvedFlipClipboard(flipClipboard);

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
                    flipClipboard,
                }),
            });

            const data = await readImageSolveResponse(response);
            if (!isCurrentRun()) return;

            if (!response.ok || (data.error && !data.jobId && !data.fallbackRequired)) {
                throw new Error(data.error || `Server returned ${response.status}`);
            }

            if (data.jobId) {
                setImageSolveJobId(data.jobId);
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
        setTimeout(() => solveWithUploadedImage(img, prompt, lastSolvedFlipClipboard), 0);
    }, [lastSolvedImageBase64, lastSolvedPrompt, lastSolvedFlipClipboard, customSolvePrompt, clearImageSolveResult, solveWithUploadedImage]);

    // ── Retry from history card with specific provider ─────────────────────────
    const handleRetryItemWithProvider = useCallback((item: StoredImageSolveItem, provider: string) => {
        if (!item.image) return;
        clearImageSolveResult();
        setTimeout(() => solveWithUploadedImage(item.image!, item.prompt ?? undefined, item.flipClipboard ?? false, provider), 0);
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

    const clearAllImageSolves = useCallback(async () => {
        if (!window.confirm("Are you sure you want to permanently delete ALL records?")) return;
        try {
            const res = await fetch(`/api/image-solve/all`, { method: 'DELETE' });
            if (res.ok) {
                setImageSolveResults([]);
            } else {
                alert("Failed to clear records.");
            }
        } catch (err) {
            alert("Error clearing records.");
        }
    }, []);

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
        stopCurrentAudio();
        setSavedQuestions([]);
        setSelectedQuestionIds(new Set());
        setActiveAudioIndex(null);
        setAudioStatusMessage(null);
        audioDataCacheRef.current.clear();
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
        imageSolveAnswerProvider === "deepseek" ? "DeepSeek Browser" :
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
                            {countdown !== null && (
                                <div className="countdown-subtext">Position paper · Capturing soon</div>
                            )}
                        </div>
                    )}

                    {/* Darkness Detection Indicator on Video */}
                    {!imageSolveMode && darknessDuration > 0 && countdown === null && (
                        <div className="video-darkness-badge">
                            <span>🌑 Camera Covered: {darknessDuration.toFixed(1)}s / 5.0s</span>
                        </div>
                    )}
                    {!imageSolveMode && darknessDuration > 0 && countdown !== null && (
                        <div className="video-darkness-badge">
                            <span>🌑 Camera Covered — Uncover to capture!</span>
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
                            className={`mode-btn archive-mode-btn ${imageSolveMode ? 'active' : ''}`}
                            onClick={() => {
                                if (imageSolveMode) return;
                                setImageSolveMode(true);
                                clearImageSolveResult();
                                setBottomTab("imagesolve");
                            }}
                        >
                            🧠 Image Solve <span className="archive-pill">Archived</span>
                        </button>
                    </div>

                    {!imageSolveMode ? (
                        <div className="scan-polling-container">
                            {savedQuestions.some(q => !!q.solution) ? (
                                <div className={`polling-status-card ${darknessStatus}`}>
                                    <div className="polling-status-header">
                                        <span className={`status-indicator-dot ${darknessStatus}`}></span>
                                        <span className="status-indicator-title">
                                            {darknessStatus === "covering"
                                                ? darknessDuration >= 4.5 && darknessDuration <= 7.5
                                                    ? "Ready! Release to cycle (Refresh)"
                                                    : darknessDuration > 7.5
                                                        ? `Hold for 10s to RESET (${(10 - darknessDuration).toFixed(1)}s)`
                                                        : `Covered (${darknessDuration.toFixed(1)}s / 5.0s)`
                                                : darknessStatus === "aborted"
                                                    ? "Reset Complete"
                                                    : "Audio Playback Gestures Active"}
                                        </span>
                                    </div>

                                    {/* Darkness Progress Bar towards 10s */}
                                    <div className="darkness-meter-wrapper">
                                        <div
                                            className={`darkness-meter-bar ${darknessDuration >= 4.5 ? 'full' : ''}`}
                                            style={{ width: `${Math.min(100, (darknessDuration / 10) * 100)}%` }}
                                        ></div>
                                    </div>

                                    <p className="polling-status-desc">
                                        {darknessAbortMessage || (
                                            darknessStatus === "covering"
                                                ? "Release between 5s to cycle to next solution. Hold for 10s to reset all problems."
                                                : "🖐️ Cover camera for 5s & release to skip to next solution. Cover for 10s to reset."
                                        )}
                                    </p>
                                </div>
                            ) : (
                                <div className={`polling-status-card ${darknessStatus} ${countdown !== null ? 'counting' : ''}`}>
                                    <div className="polling-status-header">
                                        <span className={`status-indicator-dot ${darknessStatus}`}></span>
                                        <span className="status-indicator-title">
                                            {countdown !== null
                                                ? `Scan Countdown: ${countdown}s`
                                                : darknessStatus === "covering"
                                                    ? `Darkness Detected (${darknessDuration.toFixed(1)}s / 5.0s)`
                                                    : darknessStatus === "aborted"
                                                        ? "Scan Aborted (Misfire Protection)"
                                                        : "Continuous Polling Active"}
                                        </span>
                                    </div>

                                    {/* Darkness Progress Bar (0 to 5s) */}
                                    {countdown === null && darknessStatus !== "aborted" && (
                                        <div className="darkness-meter-wrapper">
                                            <div
                                                className={`darkness-meter-bar ${darknessDuration >= 5 ? 'full' : ''}`}
                                                style={{ width: `${Math.min(100, (darknessDuration / 5) * 100)}%` }}
                                            ></div>
                                        </div>
                                    )}

                                    <p className="polling-status-desc">
                                        {countdown !== null ? (
                                            darknessDuration > 0 ? (
                                                "Camera is still covered! Uncover camera before countdown ends to scan."
                                            ) : (
                                                "Position paper in view! Capturing automatically when countdown ends..."
                                            )
                                        ) : darknessStatus === "covering" ? (
                                            "Hold covered for 5 seconds to trigger scan countdown..."
                                        ) : darknessStatus === "aborted" ? (
                                            darknessAbortMessage || "Camera remained covered when countdown ended. Uncover camera to resume."
                                        ) : (
                                            "Cover camera with hand or object for 5 seconds to trigger scan."
                                        )}
                                    </p>

                                    {countdown !== null && (
                                        <button
                                            type="button"
                                            className="cancel-countdown-btn"
                                            onClick={cancelScanCountdown}
                                        >
                                            ✕ Cancel Countdown
                                        </button>
                                    )}
                                </div>
                            )}

                            {/* Secondary manual trigger */}
                            <div className="manual-trigger-row">
                                <button
                                    className={`manual-scan-btn ${countdown !== null ? 'counting' : ''}`}
                                    onClick={startManualScan}
                                    disabled={scanStatus === "scanning" || countdown !== null}
                                    title="Manual scan fallback"
                                >
                                    {countdown !== null ? `Capturing in ${countdown}s` : "📸 Manual Trigger"}
                                </button>
                            </div>

                            <div className="delay-slider-container">
                                <label className="delay-label">
                                    Countdown Timer: <span>{captureDelay}s</span>
                                </label>
                                <input
                                    type="range"
                                    min="3"
                                    max="20"
                                    value={captureDelay}
                                    onChange={(e) => setCaptureDelay(parseInt(e.target.value))}
                                    className="delay-slider"
                                    disabled={scanStatus === "scanning" || countdown !== null}
                                />
                            </div>
                        </div>
                    ) : (
                        <>
                            {/* Archived Feature Banner */}
                            <div className="archived-feature-banner">
                                <span className="archived-banner-icon">📦</span>
                                <div className="archived-banner-text">
                                    <strong>Archived Feature:</strong> Image Solve has been archived. All functionality, history, and solvers remain intact for historical reference.
                                </div>
                            </div>

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
                                        multiple
                                        accept="image/*"
                                        className="image-upload-file-input"
                                        disabled={imageSolveBusy}
                                        onChange={(e) => {
                                            const files = e.target.files;
                                            if (files) handleFilesUpload(files);
                                            e.target.value = '';
                                        }}
                                    />
                                    <div
                                        className={`image-upload-zone ${uploadedImagePreviews.length > 0 ? 'has-preview' : ''} ${imageSolveBusy ? 'disabled' : ''}`}
                                        onClick={() => !imageSolveBusy && fileInputRef.current?.click()}
                                        onDragOver={(e) => e.preventDefault()}
                                        onDrop={(e) => {
                                            e.preventDefault();
                                            const files = e.dataTransfer.files;
                                            if (files) handleFilesUpload(files);
                                        }}
                                    >
                                        {uploadedImagePreviews.length > 0 ? (
                                            uploadedImagePreviews.length === 1 ? (
                                                <img src={uploadedImagePreviews[0]} alt="Uploaded preview" className="image-upload-preview" />
                                            ) : (
                                                <div className="image-upload-batch-preview">
                                                    <span className="batch-count" style={{ fontSize: '24px', fontWeight: 'bold' }}>{uploadedImagePreviews.length} images ready</span>
                                                    <span className="batch-hint" style={{ display: 'block', marginTop: '10px' }}>Tap to re-select</span>
                                                </div>
                                            )
                                        ) : (
                                            <div className="image-upload-placeholder">
                                                <span className="image-upload-icon">📷</span>
                                                <span className="image-upload-hint">Tap to choose image(s)</span>
                                                <span className="image-upload-hint-sub">or drag &amp; drop</span>
                                            </div>
                                        )}
                                    </div>
                                    <button
                                        className={`capture-btn image-solve-btn ${imageSolveBusy ? 'counting' : ''}`}
                                        onClick={() => { if (uploadedImagesBase64.length > 0) solveBatchUploadedImages(uploadedImagesBase64); }}
                                        disabled={imageSolveBusy || uploadedImagesBase64.length === 0 || enabledProviders.length === 0}
                                    >
                                        <div className="capture-inner"></div>
                                    </button>
                                    <p className="instruction-text" style={{ marginTop: '0.5rem', marginBottom: '1rem' }}>
                                        {imageSolveStatus === 'solving' && !imageSolveBrowserError && `Sending to ${imageSolvePrimaryLabel} via browser...`}
                                        {imageSolveStatus === 'solving' && imageSolveBrowserError && 'Browser solve failed. Running fallback...'}
                                        {imageSolveStatus === 'done' && imageSolveBackupStatus !== 'queued' && imageSolveBackupStatus !== 'solving' && 'Result received!'}
                                        {imageSolveStatus === 'done' && (imageSolveBackupStatus === 'queued' || imageSolveBackupStatus === 'solving') && `${imageSolvePrimaryLabel} screenshot received. Waiting for ${imageSolveBackupLabel} backup...`}
                                        {imageSolveStatus === 'error' && '❌ ' + imageSolveError}
                                        {imageSolveStatus === 'idle' && uploadedImagesBase64.length === 0 && 'Choose image(s) to solve'}
                                        {imageSolveStatus === 'idle' && uploadedImagesBase64.length > 0 && `Tap the button to send ${uploadedImagesBase64.length > 1 ? 'batch' : 'image'}`}
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
                                            {imageSolveJobId && (
                                                <button
                                                    className="delete-btn"
                                                    onClick={() => {
                                                        handleDeleteItem(imageSolveJobId);
                                                        clearImageSolveResult();
                                                    }}
                                                    title="Permanently delete this record"
                                                    style={{ background: 'rgba(255,59,48,0.1)', color: '#ff3b30', border: '1px solid rgba(255,59,48,0.3)', borderRadius: '4px', padding: '0.2rem 0.5rem', cursor: 'pointer' }}
                                                >
                                                    🗑️ Delete
                                                </button>
                                            )}
                                            {!imageSolveJobId && (
                                                <button
                                                    className="delete-btn"
                                                    onClick={clearImageSolveResult}
                                                >✕</button>
                                            )}
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
                            Image Solve Stack ({imageSolveResults.length}) <span className="archive-pill tab">Archived</span>
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
                    {bottomTab === "imagesolve" && <div style={{ display: "flex", gap: "0.5rem" }}>
                        {imageSolveResults.length > 0 && (
                            <button className="reset-btn danger" onClick={clearAllImageSolves}>Clear All</button>
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
                                                    onClick={() => handleRetryItemWithProvider(item, 'deepseek')}
                                                    disabled={imageSolveBusy}
                                                    title="Retry with DeepSeek"
                                                    style={{ flex: 1 }}
                                                >
                                                    ↺ DeepSeek
                                                </button>
                                                <button
                                                    className="retry-btn"
                                                    onClick={() => handleRetryItemWithProvider(item, 'gemini')}
                                                    disabled={imageSolveBusy}
                                                    title="Retry with Gemini"
                                                    style={{ flex: 1 }}
                                                >
                                                    ↺ Gemini
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

                {/* Spoken Audio Playback Banner */}
                {bottomTab === "questions" && savedQuestions.some(q => !!q.solution) && (() => {
                    const solvedList = savedQuestions.filter(q => !!q.solution);
                    const currentIdx = activeAudioIndex !== null ? activeAudioIndex : 0;
                    const activeQ = solvedList[currentIdx] || solvedList[0];

                    return (
                        <div className="audio-playback-banner">
                            <div className="audio-player-header">
                                <div className="audio-player-title">
                                    <span className="audio-pulse-icon">{isAudioPlaying ? "🔊" : "🔈"}</span>
                                    <span>Playing Question {activeQ?.questionNumber || currentIdx + 1} of {solvedList.length}</span>
                                </div>
                                <span className="audio-loop-badge">🔁 Looping</span>
                            </div>

                            {activeQ?.questionIntro && (
                                <div className="audio-intro-text">
                                    "{activeQ.questionIntro}"
                                </div>
                            )}

                            <div className="audio-player-controls">
                                <div style={{ display: "flex", gap: "0.4rem" }}>
                                    <button
                                        type="button"
                                        className="audio-ctrl-btn"
                                        onClick={cyclePrevSolution}
                                        title="Previous Question"
                                    >
                                        ⏮️ Prev
                                    </button>
                                    <button
                                        type="button"
                                        className={`audio-ctrl-btn ${isAudioPlaying ? "primary" : ""}`}
                                        onClick={toggleAudioPlayPause}
                                        title={isAudioPlaying ? "Pause audio" : "Play audio"}
                                    >
                                        {isAudioPlaying ? "⏸️ Pause" : "▶️ Play"}
                                    </button>
                                    <button
                                        type="button"
                                        className="audio-ctrl-btn"
                                        onClick={cycleNextSolution}
                                        title="Next Question (Refresh)"
                                    >
                                        ⏭️ Next
                                    </button>
                                </div>

                                <button
                                    type="button"
                                    className="audio-ctrl-btn danger"
                                    onClick={clearAllQuestions}
                                    title="Reset all questions and return to scan polling"
                                >
                                    🔄 Reset All
                                </button>
                            </div>

                            <div className="audio-gesture-guide">
                                <span>🖐️ <strong>Refresh:</strong> Cover camera 5s & release to cycle</span>
                                <span>🛑 <strong>Reset:</strong> Cover camera 10s to wipe</span>
                            </div>

                            {audioStatusMessage && (
                                <div style={{ fontSize: "0.75rem", color: "hsl(var(--accent-secondary))", opacity: 0.9 }}>
                                    {audioStatusMessage}
                                </div>
                            )}
                        </div>
                    );
                })()}

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
                                                <>
                                                    <div className="solution-text">{q.solution}</div>
                                                    {q.transcript && (
                                                        <div className="question-transcript-box">
                                                            <div className="question-transcript-header">
                                                                <span>🎙️ Spoken Transcript</span>
                                                                <button
                                                                    type="button"
                                                                    className="audio-ctrl-btn"
                                                                    style={{ padding: "0.2rem 0.6rem", fontSize: "0.72rem" }}
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        const solvedList = savedQuestions.filter(sq => !!sq.solution);
                                                                        const targetIdx = solvedList.findIndex(sq => sq.id === q.id);
                                                                        if (targetIdx >= 0) playQuestionAudio(targetIdx, solvedList);
                                                                    }}
                                                                >
                                                                    🔊 Play
                                                                </button>
                                                            </div>
                                                            <div>{q.transcript}</div>
                                                        </div>
                                                    )}
                                                </>
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
