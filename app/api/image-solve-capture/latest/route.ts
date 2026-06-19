import { NextResponse } from "next/server";
import { getBrowserServiceUrl } from "../browserService";

type BrowserCaptureResponse = {
    ok?: boolean;
    filename?: string;
    mimeType?: string;
    bytes?: number;
    capturedAt?: string;
    imageUrl?: string;
    imagePath?: string;
    error?: string;
};

export async function GET() {
    try {
        const browserServiceUrl = getBrowserServiceUrl();
        const response = await fetch(`${browserServiceUrl}/latest-image-solve-capture`, {
            cache: "no-store",
            signal: AbortSignal.timeout(10_000),
        });

        const data = await response.json().catch(() => ({
            error: `Browser service returned a non-JSON response with HTTP ${response.status}`,
        })) as BrowserCaptureResponse;

        return NextResponse.json(
            {
                ...data,
                imageUrl: data.imageUrl ? `/api/image-solve-capture/latest/image?t=${encodeURIComponent(data.capturedAt || Date.now())}` : data.imageUrl,
            },
            { status: response.status }
        );
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to load latest image-solve capture.";
        console.error("[image-solve-capture proxy] Latest capture failed:", message);
        return NextResponse.json(
            { ok: false, error: `Browser service latest image-solve capture failed: ${message}` },
            { status: 502 }
        );
    }
}
