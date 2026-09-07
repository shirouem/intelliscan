import { NextRequest, NextResponse } from "next/server";
import { getBrowserServiceUrl } from "@/app/api/image-solve-capture/browserService";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { solutions, delaySeconds = 30, blockDelaySeconds = 5 } = body;

        if (!solutions || !Array.isArray(solutions) || solutions.length === 0) {
            return NextResponse.json({ error: "No solutions provided" }, { status: 400 });
        }

        let browserServiceUrl = "http://127.0.0.1:3001";
        try {
            browserServiceUrl = getBrowserServiceUrl();
        } catch {
            browserServiceUrl = process.env.BROWSER_SERVICE_URL || "http://127.0.0.1:3001";
        }

        console.log(`[WhatsApp API] Forwarding ${solutions.length} solutions to browser service at ${browserServiceUrl}`);

        const res = await fetch(`${browserServiceUrl}/whatsapp/send-solutions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ solutions, delaySeconds, blockDelaySeconds }),
            signal: AbortSignal.timeout(10000), // 10s connection timeout
        });

        if (!res.ok) {
            const errText = await res.text();
            console.warn(`[WhatsApp API] Browser service returned ${res.status}:`, errText);
            return NextResponse.json({ ok: false, error: `Browser service error: ${res.status}` }, { status: 502 });
        }

        const data = await res.json();
        return NextResponse.json(data);
    } catch (err: any) {
        console.warn("[WhatsApp API] Failed to reach browser service:", err?.message);
        // Do not crash client or block audio; return informative response
        return NextResponse.json({ ok: false, error: err?.message || "Browser service unreachable" }, { status: 503 });
    }
}
