import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { image, prompt } = body;

        if (!image) {
            return NextResponse.json({ error: "No image provided." }, { status: 400 });
        }

        const browserServiceUrl = process.env.BROWSER_SERVICE_URL || "http://localhost:3001";

        const browserRes = await fetch(`${browserServiceUrl}/image-solve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image, prompt }),
            // Give it plenty of time — nut.js needs ~20s to navigate + wait for response
            signal: AbortSignal.timeout(45_000),
        });

        if (!browserRes.ok) {
            const errData = await browserRes.json().catch(() => ({ error: "Browser service error" }));
            return NextResponse.json(
                { error: errData.error || `Browser service returned ${browserRes.status}` },
                { status: browserRes.status }
            );
        }

        const data = await browserRes.json();
        return NextResponse.json({ answer: data.answer });

    } catch (error: any) {
        console.error("[image-solve route] Error:", error);
        return NextResponse.json(
            { error: error.message || "Failed to process image solve request." },
            { status: 500 }
        );
    }
}
