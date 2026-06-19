"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import "./capture-test.css";

type LatestCapture = {
  ok: boolean;
  filename?: string;
  mimeType?: string;
  bytes?: number;
  capturedAt?: string;
  imageUrl?: string;
  imagePath?: string;
  error?: string;
};

const defaultBrowserServiceUrl =
  process.env.NEXT_PUBLIC_BROWSER_SERVICE_URL || "http://localhost:3001";

const formatBytes = (bytes?: number) => {
  if (!bytes) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

export default function CaptureTestPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [status, setStatus] = useState("Idle");
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [captureFormat, setCaptureFormat] = useState<"image/jpeg" | "image/png">("image/jpeg");
  const [mirrorCapture, setMirrorCapture] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [latest, setLatest] = useState<LatestCapture | null>(null);
  const [latestImageUrl, setLatestImageUrl] = useState<string | null>(null);
  const [isCameraRunning, setIsCameraRunning] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });

  const serviceBase = defaultBrowserServiceUrl.replace(/\/+$/, "");

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsCameraRunning(false);
    setVideoSize({ width: 0, height: 0 });
  }, []);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const allDevices = await navigator.mediaDevices.enumerateDevices();
    setDevices(allDevices.filter((device) => device.kind === "videoinput"));
  }, []);

  const startCamera = useCallback(async () => {
    setError(null);
    setStatus("Starting camera...");
    stopCamera();

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser does not expose navigator.mediaDevices.getUserMedia.");
      }

      const constraints: MediaStreamConstraints = {
        audio: false,
        video: deviceId
          ? {
              deviceId: { exact: deviceId },
              width: { ideal: 2560 },
              height: { ideal: 1440 },
              aspectRatio: { ideal: 16 / 9 },
            }
          : {
              facingMode: { ideal: facingMode },
              width: { ideal: 2560 },
              height: { ideal: 1440 },
              aspectRatio: { ideal: 16 / 9 },
            },
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setVideoSize({
          width: videoRef.current.videoWidth,
          height: videoRef.current.videoHeight,
        });
      }

      await refreshDevices();
      setIsCameraRunning(true);
      setStatus("Camera ready");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not start camera.";
      setError(message);
      setStatus("Camera failed");
      stopCamera();
    }
  }, [deviceId, facingMode, refreshDevices, stopCamera]);

  const drawCurrentFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) {
      throw new Error("No live video frame is available to capture.");
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Could not create canvas context.");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (mirrorCapture) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL(captureFormat, 0.92);
    setPreviewUrl(dataUrl);
    setVideoSize({ width: video.videoWidth, height: video.videoHeight });
    return dataUrl;
  }, [captureFormat, mirrorCapture]);

  const refreshLatestCapture = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`${serviceBase}/latest-capture`, { cache: "no-store" });
      const data = (await response.json()) as LatestCapture;
      if (!response.ok) throw new Error(data.error || `Latest capture failed with HTTP ${response.status}`);
      setLatest(data);
      setLatestImageUrl(data.imageUrl ? `${data.imageUrl}&viewBust=${Date.now()}` : null);
      setStatus("Latest capture loaded");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not load latest capture.";
      setError(message);
      setStatus("Latest capture unavailable");
    }
  }, [serviceBase]);

  const captureAndSend = useCallback(async () => {
    setIsSending(true);
    setError(null);
    setStatus("Capturing frame...");

    try {
      const image = drawCurrentFrame();
      setStatus("Sending capture to browser service...");

      const response = await fetch(`${serviceBase}/capture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image,
          label: `capture-test ${new Date().toISOString()}`,
        }),
      });
      const data = (await response.json()) as LatestCapture;
      if (!response.ok) throw new Error(data.error || `Upload failed with HTTP ${response.status}`);

      setLatest(data);
      setLatestImageUrl(data.imageUrl ? `${data.imageUrl}&viewBust=${Date.now()}` : null);
      setStatus("Capture stored by browser service");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Capture upload failed.";
      setError(message);
      setStatus("Capture failed");
    } finally {
      setIsSending(false);
    }
  }, [drawCurrentFrame, serviceBase]);

  useEffect(() => {
    refreshDevices().catch(() => undefined);
    return () => stopCamera();
  }, [refreshDevices, stopCamera]);

  return (
    <main className="capture-test-page">
      <section className="capture-test-header">
        <div>
          <p className="capture-test-kicker">Camera Debug</p>
          <h1>Capture Test Console</h1>
          <p className="capture-test-subtitle">
            Isolated camera capture that sends the frame directly to the browser service.
          </p>
        </div>
        <Link className="capture-test-link" href="/">
          Back to scanner
        </Link>
      </section>

      <section className="capture-test-grid">
        <div className="capture-test-panel camera-panel">
          <div className="video-shell">
            <video
              ref={videoRef}
              className={mirrorCapture ? "mirrored" : ""}
              autoPlay
              muted
              playsInline
              onLoadedMetadata={() => {
                if (!videoRef.current) return;
                setVideoSize({
                  width: videoRef.current.videoWidth,
                  height: videoRef.current.videoHeight,
                });
              }}
            />
            {!isCameraRunning && <div className="video-empty">Camera is stopped</div>}
          </div>

          <div className="button-row">
            <button onClick={startCamera}>Start Camera</button>
            <button onClick={stopCamera} disabled={!isCameraRunning}>
              Stop
            </button>
            <button onClick={captureAndSend} disabled={!isCameraRunning || isSending}>
              {isSending ? "Sending..." : "Capture and Send"}
            </button>
          </div>

          <div className="status-line">
            <span>{status}</span>
            <span>{videoSize.width && videoSize.height ? `${videoSize.width} x ${videoSize.height}` : "No frame"}</span>
          </div>
          {error && <div className="capture-test-error">{error}</div>}
        </div>

        <aside className="capture-test-panel controls-panel">
          <label>
            Camera
            <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
              <option value="">Default camera ({facingMode})</option>
              {devices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${index + 1}`}
                </option>
              ))}
            </select>
          </label>

          <div className="segmented-control" aria-label="Facing mode">
            <button
              className={!deviceId && facingMode === "user" ? "active" : ""}
              onClick={() => {
                setDeviceId("");
                setFacingMode("user");
              }}
            >
              Front
            </button>
            <button
              className={!deviceId && facingMode === "environment" ? "active" : ""}
              onClick={() => {
                setDeviceId("");
                setFacingMode("environment");
              }}
            >
              Rear
            </button>
          </div>

          <label>
            Capture format
            <select value={captureFormat} onChange={(event) => setCaptureFormat(event.target.value as "image/jpeg" | "image/png")}>
              <option value="image/jpeg">JPEG</option>
              <option value="image/png">PNG</option>
            </select>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={mirrorCapture}
              onChange={(event) => setMirrorCapture(event.target.checked)}
            />
            Mirror preview and saved capture
          </label>

          <button className="secondary-button" onClick={refreshLatestCapture}>
            Refresh Latest Capture
          </button>

          <div className="endpoint-box">
            <div>POST {serviceBase || "http://localhost:3001"}/capture</div>
            <div>GET {serviceBase || "http://localhost:3001"}/latest-capture</div>
            <div>GET {serviceBase || "http://localhost:3001"}/latest-capture/image</div>
          </div>
        </aside>
      </section>

      <section className="capture-test-grid lower-grid">
        <div className="capture-test-panel">
          <div className="panel-title">Local Captured Frame</div>
          {previewUrl ? <img className="image-preview" src={previewUrl} alt="Locally captured frame" /> : <div className="empty-preview">No local capture yet</div>}
        </div>

        <div className="capture-test-panel">
          <div className="panel-title">Browser Service Latest Capture</div>
          {latestImageUrl ? <img className="image-preview" src={latestImageUrl} alt="Latest capture stored by browser service" /> : <div className="empty-preview">No service capture loaded</div>}
          {latest && (
            <dl className="capture-meta">
              <div>
                <dt>File</dt>
                <dd>{latest.filename || "-"}</dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{latest.mimeType || "-"}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{formatBytes(latest.bytes)}</dd>
              </div>
              <div>
                <dt>Time</dt>
                <dd>{latest.capturedAt ? new Date(latest.capturedAt).toLocaleString() : "-"}</dd>
              </div>
            </dl>
          )}
        </div>
      </section>

      <canvas ref={canvasRef} hidden />
    </main>
  );
}
