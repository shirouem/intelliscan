import { NextRequest, NextResponse } from "next/server";
import { getBrowserServiceUrl } from "./browserService";

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

const withLocalImageUrl = (data: BrowserCaptureResponse): BrowserCaptureResponse => ({
    ...data,
    imageUrl: data.imageUrl ? `/api/capture-test/latest/image?t=${encodeURIComponent(data.capturedAt || Date.now())}` : data.imageUrl,
});

export async function POST(req: NextRequest) {
    try {
        const browserServiceUrl = getBrowserServiceUrl();
        const body = await req.text();
        const response = await fetch(`${browserServiceUrl}/capture`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            signal: AbortSignal.timeout(30_000),
        });

        const data = await response.json().catch(() => ({
            error: `Browser service returned a non-JSON response with HTTP ${response.status}`,
        })) as BrowserCaptureResponse;

        return NextResponse.json(withLocalImageUrl(data), { status: response.status });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to send capture to browser service.";
        console.error("[capture-test proxy] Upload failed:", message);
        return NextResponse.json(
            { ok: false, error: `Browser service capture upload failed: ${message}` },
            { status: 502 }
        );
    }
}
