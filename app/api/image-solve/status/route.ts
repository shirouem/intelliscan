import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
    const url = new URL(req.url);
    const jobId = url.searchParams.get("jobId");

    if (!jobId) {
        return NextResponse.json({ error: "Missing jobId parameter" }, { status: 400 });
    }

    const browserServiceUrl = process.env.BROWSER_SERVICE_URL || "http://localhost:3001";

    try {
        const res = await fetch(`${browserServiceUrl}/image-solve/status/${jobId}`, {
            signal: AbortSignal.timeout(10_000), // Short timeout for polling requests
        });

        if (!res.ok) {
            return NextResponse.json(
                { error: `Browser service returned status: ${res.status}` },
                { status: res.status }
            );
        }

        const data = await res.json();
        return NextResponse.json(data);
    } catch (err: any) {
        console.error("[image-solve status proxy] Error:", err.message);
        return NextResponse.json({ error: "Failed to fetch status from browser service" }, { status: 500 });
    }
}
