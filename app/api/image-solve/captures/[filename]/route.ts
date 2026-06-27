import { NextRequest, NextResponse } from "next/server";

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ filename: string }> }
) {
    const { filename } = await params;
    if (!filename) {
        return new NextResponse("Filename is required", { status: 400 });
    }

    const browserServiceUrl = process.env.BROWSER_SERVICE_URL || "http://localhost:3001";
    const url = `${browserServiceUrl}/image-solve/captures/${encodeURIComponent(filename)}`;

    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) {
            return new NextResponse("Image not found or error", { status: res.status });
        }
        const headers = new Headers(res.headers);
        return new NextResponse(res.body, { status: res.status, headers });
    } catch (err: any) {
        console.error("[image-solve proxy captures error]", err.message);
        return new NextResponse("Failed to fetch image", { status: 500 });
    }
}
