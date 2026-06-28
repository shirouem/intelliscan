import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { images, prompt, primaryProvider, backupProvider } = body;

        if (!Array.isArray(images) || images.length === 0) {
            return NextResponse.json({ error: "Missing or invalid images array parameter" }, { status: 400 });
        }

        const browserServiceUrl = process.env.BROWSER_SERVICE_URL || "http://localhost:3001";

        const res = await fetch(`${browserServiceUrl}/image-solve/batch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ images, prompt, primaryProvider, backupProvider }),
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => null);
            return NextResponse.json(
                { error: errData?.error || `Browser service returned status: ${res.status}` },
                { status: res.status }
            );
        }

        const data = await res.json();
        return NextResponse.json(data);
    } catch (err: any) {
        console.error("[image-solve batch proxy] Error:", err.message);
        return NextResponse.json({ error: "Failed to forward request to browser service" }, { status: 500 });
    }
}
