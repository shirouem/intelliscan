"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import "./model-test.css";

type DetectorStatus = "loading" | "ready" | "missing" | "error";

type Detector = {
    ort: typeof import("onnxruntime-web");
    session: import("onnxruntime-web").InferenceSession;
    inputName: string;
    outputName: string;
    labels: string[];
    inputSize: number;
};

type Detection = {
    label: string | null;
    score: number;
    classId: number;
    x: number;
    y: number;
    width: number;
    height: number;
};

type Letterbox = {
    scale: number;
    offsetX: number;
    offsetY: number;
};

const modelPath = "/models/document-detector.onnx";
const labelsPath = "/models/document-detector.labels.json";
const inputSize = 640;
const confidenceThreshold = 0.25;
const nmsThreshold = 0.45;
const wasmPath = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
const documentLabelPattern = /document|documents|paper|sheet|page|invoice|receipt|form/i;

const getErrorMessage = (error: unknown, fallback = "Unknown error") => {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return fallback;
};

const loadLabels = async () => {
    try {
        const response = await fetch(labelsPath, { cache: "no-store" });
        if (!response.ok) return ["document"];
        const value: unknown = await response.json();
        if (Array.isArray(value)) {
            return value.filter((label): label is string => typeof label === "string" && label.trim().length > 0);
        }
        if (value && typeof value === "object") {
            return Object.values(value).filter((label): label is string => typeof label === "string" && label.trim().length > 0);
        }
    } catch {
        return ["document"];
    }
    return ["document"];
};

const loadDetector = async (): Promise<Detector> => {
    const [ort, labels, modelResponse] = await Promise.all([
        import("onnxruntime-web"),
        loadLabels(),
        fetch(modelPath, { cache: "no-store" }),
    ]);

    if (modelResponse.status === 404) throw new Error(`Missing ${modelPath}`);
    if (!modelResponse.ok) throw new Error(`Model load failed: ${modelResponse.status}`);

    ort.env.wasm.wasmPaths = wasmPath;
    ort.env.wasm.numThreads = 1;

    const modelBuffer = await modelResponse.arrayBuffer();
    const session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
    });

    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    if (!inputName || !outputName) throw new Error("Model has no readable input/output names.");

    return {
        ort,
        session,
        inputName,
        outputName,
        labels: labels.length ? labels : ["document"],
        inputSize,
    };
};

const getOutputValue = (
    data: ArrayLike<number>,
    rowIndex: number,
    colIndex: number,
    rowCount: number,
    colCount: number,
    transposed: boolean,
) => Number(data[transposed ? colIndex * rowCount + rowIndex : rowIndex * colCount + colIndex]);

const parseDetections = (output: import("onnxruntime-web").Tensor, labels: string[]) => {
    const data = output.data as ArrayLike<number>;
    const dims = output.dims;
    let rowCount = 0;
    let colCount = 0;
    let transposed = false;

    if (dims.length === 3) {
        const dimA = dims[1] || 0;
        const dimB = dims[2] || 0;
        if (dimA >= 5 && dimB > dimA) {
            rowCount = dimB;
            colCount = dimA;
            transposed = true;
        } else {
            rowCount = dimA;
            colCount = dimB;
        }
    } else if (dims.length === 2) {
        const dimA = dims[0] || 0;
        const dimB = dims[1] || 0;
        if (dimA >= 5 && dimB > dimA) {
            rowCount = dimB;
            colCount = dimA;
            transposed = true;
        } else {
            rowCount = dimA;
            colCount = dimB;
        }
    }

    if (!rowCount || colCount < 5) return [];

    const detections: Detection[] = [];

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const x = getOutputValue(data, rowIndex, 0, rowCount, colCount, transposed);
        const y = getOutputValue(data, rowIndex, 1, rowCount, colCount, transposed);
        const widthOrX2 = getOutputValue(data, rowIndex, 2, rowCount, colCount, transposed);
        const heightOrY2 = getOutputValue(data, rowIndex, 3, rowCount, colCount, transposed);
        let score = 0;
        let classId = 0;
        let usesCornerBox = false;

        if (colCount === 5) {
            score = getOutputValue(data, rowIndex, 4, rowCount, colCount, transposed);
        } else if (colCount === 6) {
            const objectnessOrScore = getOutputValue(data, rowIndex, 4, rowCount, colCount, transposed);
            const classOrClassScore = getOutputValue(data, rowIndex, 5, rowCount, colCount, transposed);
            if (labels.length <= 1 && classOrClassScore >= 0 && classOrClassScore <= 1) {
                score = objectnessOrScore * classOrClassScore;
            } else {
                score = objectnessOrScore;
                classId = Math.max(0, Math.round(classOrClassScore));
                usesCornerBox = true;
            }
        } else {
            const classStart = labels.length > 0 && colCount === labels.length + 4 ? 4 : 5;
            const objectness = classStart === 5
                ? getOutputValue(data, rowIndex, 4, rowCount, colCount, transposed)
                : 1;

            let bestClassScore = 0;
            for (let colIndex = classStart; colIndex < colCount; colIndex += 1) {
                const classScore = getOutputValue(data, rowIndex, colIndex, rowCount, colCount, transposed);
                if (classScore > bestClassScore) {
                    bestClassScore = classScore;
                    classId = colIndex - classStart;
                }
            }
            score = objectness * bestClassScore;
        }

        const label = labels[classId] || null;
        const documentLike = !label || labels.length <= 1 || documentLabelPattern.test(label);
        if (!documentLike || !Number.isFinite(score) || score < confidenceThreshold) continue;

        detections.push({
            label,
            score,
            classId,
            x: usesCornerBox ? x : x - widthOrX2 / 2,
            y: usesCornerBox ? y : y - heightOrY2 / 2,
            width: usesCornerBox ? widthOrX2 - x : widthOrX2,
            height: usesCornerBox ? heightOrY2 - y : heightOrY2,
        });
    }

    return nms(detections.sort((a, b) => b.score - a.score));
};

const boxIou = (a: Detection, b: Detection) => {
    const ax2 = a.x + a.width;
    const ay2 = a.y + a.height;
    const bx2 = b.x + b.width;
    const by2 = b.y + b.height;
    const ix1 = Math.max(a.x, b.x);
    const iy1 = Math.max(a.y, b.y);
    const ix2 = Math.min(ax2, bx2);
    const iy2 = Math.min(ay2, by2);
    const intersection = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
    const union = a.width * a.height + b.width * b.height - intersection;
    return union > 0 ? intersection / union : 0;
};

const nms = (detections: Detection[]) => {
    const kept: Detection[] = [];
    for (const detection of detections) {
        if (kept.every((item) => boxIou(item, detection) < nmsThreshold)) {
            kept.push(detection);
        }
    }
    return kept.slice(0, 12);
};

const clampBox = (detection: Detection, width: number, height: number): Detection => {
    const x = Math.max(0, Math.min(width, detection.x));
    const y = Math.max(0, Math.min(height, detection.y));
    const right = Math.max(0, Math.min(width, detection.x + detection.width));
    const bottom = Math.max(0, Math.min(height, detection.y + detection.height));
    return {
        ...detection,
        x,
        y,
        width: Math.max(0, right - x),
        height: Math.max(0, bottom - y),
    };
};

export default function ModelTestPage() {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const overlayRef = useRef<HTMLCanvasElement | null>(null);
    const modelCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const detectorRef = useRef<Detector | null>(null);
    const [status, setStatus] = useState<DetectorStatus>("loading");
    const [message, setMessage] = useState("Loading model...");
    const [detections, setDetections] = useState<Detection[]>([]);
    const [outputShape, setOutputShape] = useState("-");
    const [inferenceMs, setInferenceMs] = useState(0);
    const [videoSize, setVideoSize] = useState("-");

    const startCamera = useCallback(async () => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                facingMode: { ideal: "environment" },
            },
        });
        streamRef.current = stream;
        if (videoRef.current) {
            videoRef.current.srcObject = stream;
            await videoRef.current.play();
        }
    }, []);

    const drawOverlay = useCallback((items: Detection[]) => {
        const canvas = overlayRef.current;
        const video = videoRef.current;
        if (!canvas || !video || !video.videoWidth || !video.videoHeight) return;

        const rect = video.getBoundingClientRect();
        const pixelRatio = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(rect.width * pixelRatio));
        canvas.height = Math.max(1, Math.round(rect.height * pixelRatio));
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.lineWidth = 3 * pixelRatio;
        ctx.font = `${13 * pixelRatio}px Inter, system-ui, sans-serif`;
        ctx.textBaseline = "top";

        const scaleX = canvas.width / video.videoWidth;
        const scaleY = canvas.height / video.videoHeight;

        items.forEach((item) => {
            const x = item.x * scaleX;
            const y = item.y * scaleY;
            const width = item.width * scaleX;
            const height = item.height * scaleY;
            const label = `${item.label || `class ${item.classId}`} ${Math.round(item.score * 100)}%`;

            ctx.strokeStyle = "#36f59f";
            ctx.fillStyle = "rgba(54, 245, 159, 0.18)";
            ctx.strokeRect(x, y, width, height);
            ctx.fillRect(x, y, width, height);

            const metrics = ctx.measureText(label);
            const labelWidth = metrics.width + 12 * pixelRatio;
            const labelHeight = 24 * pixelRatio;
            ctx.fillStyle = "rgba(8, 14, 23, 0.92)";
            ctx.fillRect(x, Math.max(0, y - labelHeight), labelWidth, labelHeight);
            ctx.fillStyle = "#e9fff5";
            ctx.fillText(label, x + 6 * pixelRatio, Math.max(0, y - labelHeight) + 5 * pixelRatio);
        });
    }, []);

    const runDetection = useCallback(async () => {
        const detector = detectorRef.current;
        const video = videoRef.current;
        const canvas = modelCanvasRef.current;
        if (!detector || !video || !canvas || !video.videoWidth || !video.videoHeight) return;

        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) return;

        canvas.width = detector.inputSize;
        canvas.height = detector.inputSize;
        const scale = Math.min(detector.inputSize / video.videoWidth, detector.inputSize / video.videoHeight);
        const drawWidth = Math.round(video.videoWidth * scale);
        const drawHeight = Math.round(video.videoHeight * scale);
        const letterbox: Letterbox = {
            scale,
            offsetX: Math.floor((detector.inputSize - drawWidth) / 2),
            offsetY: Math.floor((detector.inputSize - drawHeight) / 2),
        };

        ctx.fillStyle = "#727272";
        ctx.fillRect(0, 0, detector.inputSize, detector.inputSize);
        ctx.drawImage(video, letterbox.offsetX, letterbox.offsetY, drawWidth, drawHeight);

        const imageData = ctx.getImageData(0, 0, detector.inputSize, detector.inputSize);
        const pixelCount = detector.inputSize * detector.inputSize;
        const input = new Float32Array(3 * pixelCount);
        for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
            const sourceIndex = pixelIndex * 4;
            input[pixelIndex] = imageData.data[sourceIndex] / 255;
            input[pixelCount + pixelIndex] = imageData.data[sourceIndex + 1] / 255;
            input[pixelCount * 2 + pixelIndex] = imageData.data[sourceIndex + 2] / 255;
        }

        const start = performance.now();
        const tensor = new detector.ort.Tensor("float32", input, [1, 3, detector.inputSize, detector.inputSize]);
        const results = await detector.session.run({ [detector.inputName]: tensor });
        const output = results[detector.outputName] || Object.values(results)[0];
        const elapsed = performance.now() - start;
        const modelDetections = output ? parseDetections(output, detector.labels) : [];

        const mapped = modelDetections
            .map((item) => clampBox({
                ...item,
                x: (item.x - letterbox.offsetX) / letterbox.scale,
                y: (item.y - letterbox.offsetY) / letterbox.scale,
                width: item.width / letterbox.scale,
                height: item.height / letterbox.scale,
            }, video.videoWidth, video.videoHeight))
            .filter((item) => item.width > 1 && item.height > 1);

        setOutputShape(output ? output.dims.join(" x ") : "-");
        setInferenceMs(Math.round(elapsed));
        setVideoSize(`${video.videoWidth} x ${video.videoHeight}`);
        setDetections(mapped);
        drawOverlay(mapped);
    }, [drawOverlay]);

    useEffect(() => {
        let cancelled = false;

        const boot = async () => {
            try {
                setStatus("loading");
                setMessage("Loading model...");
                const detector = await loadDetector();
                if (cancelled) return;
                detectorRef.current = detector;
                setStatus("ready");
                setMessage(`Ready: ${detector.labels.join(", ")}`);

                await startCamera();
            } catch (error) {
                if (cancelled) return;
                const text = getErrorMessage(error, "Model test failed.");
                setStatus(text.includes("Missing") ? "missing" : "error");
                setMessage(text);
            }
        };

        boot();

        return () => {
            cancelled = true;
            streamRef.current?.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
        };
    }, [startCamera]);

    useEffect(() => {
        if (status !== "ready") return;

        let stopped = false;
        let inFlight = false;
        let lastRun = 0;
        let animationId = 0;

        const tick = async (time: number) => {
            if (stopped) return;
            if (!inFlight && time - lastRun > 160) {
                inFlight = true;
                lastRun = time;
                try {
                    await runDetection();
                } catch (error) {
                    console.error("Realtime detector failed", error);
                    setMessage(getErrorMessage(error, "Realtime detector failed."));
                    setStatus("error");
                } finally {
                    inFlight = false;
                }
            }
            animationId = requestAnimationFrame(tick);
        };

        animationId = requestAnimationFrame(tick);
        return () => {
            stopped = true;
            cancelAnimationFrame(animationId);
        };
    }, [runDetection, status]);

    return (
        <main className="model-test-page">
            <section className="model-test-shell">
                <div className="model-test-header">
                    <div>
                        <h1>Document Detector Test</h1>
                        <p>{message}</p>
                    </div>
                    <div className={`model-test-status ${status}`}>{status}</div>
                </div>

                <div className="model-test-video-wrap">
                    <video ref={videoRef} className="model-test-video" autoPlay muted playsInline />
                    <canvas ref={overlayRef} className="model-test-overlay" />
                </div>

                <div className="model-test-stats">
                    <span>Video {videoSize}</span>
                    <span>Output {outputShape}</span>
                    <span>Inference {inferenceMs}ms</span>
                    <span>Detections {detections.length}</span>
                    <span>Threshold {Math.round(confidenceThreshold * 100)}%</span>
                </div>

                <div className="model-test-detections">
                    {detections.length === 0 && <div className="model-test-empty">No boxes above threshold.</div>}
                    {detections.map((item, index) => (
                        <div className="model-test-row" key={`${item.classId}-${index}`}>
                            <span>{item.label || `class ${item.classId}`}</span>
                            <span>{Math.round(item.score * 100)}%</span>
                            <span>
                                {Math.round(item.x)}, {Math.round(item.y)}, {Math.round(item.width)} x {Math.round(item.height)}
                            </span>
                        </div>
                    ))}
                </div>

                <canvas ref={modelCanvasRef} hidden />
            </section>
        </main>
    );
}
