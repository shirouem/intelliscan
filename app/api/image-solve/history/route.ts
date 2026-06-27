import { NextResponse } from "next/server";

export async function GET() {
    const browserServiceUrl = process.env.BROWSER_SERVICE_URL || "http://localhost:3001";

    try {
        const res = await fetch(`${browserServiceUrl}/image-solve/history`, {
            signal: AbortSignal.timeout(10_000), // Short timeout for polling
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
        console.error("[image-solve history proxy] Error:", err.message);
        return NextResponse.json({ error: "Failed to fetch history from browser service" }, { status: 500 });
    }
}
