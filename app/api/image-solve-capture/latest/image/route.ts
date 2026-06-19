import { NextResponse } from "next/server";
import { getBrowserServiceUrl } from "../../browserService";

export async function GET() {
    try {
        const browserServiceUrl = getBrowserServiceUrl();
        const response = await fetch(`${browserServiceUrl}/latest-image-solve-capture/image`, {
            cache: "no-store",
            signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => "");
            return NextResponse.json(
                { ok: false, error: text || `Browser service returned HTTP ${response.status}` },
                { status: response.status }
            );
        }

        const bytes = await response.arrayBuffer();
        return new NextResponse(bytes, {
            headers: {
                "Cache-Control": "no-store",
                "Content-Type": response.headers.get("content-type") || "image/png",
            },
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to load latest image-solve capture image.";
        console.error("[image-solve-capture proxy] Latest capture image failed:", message);
        return NextResponse.json(
            { ok: false, error: `Browser service latest image-solve capture image failed: ${message}` },
            { status: 502 }
        );
    }
}
