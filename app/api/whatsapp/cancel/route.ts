import { NextResponse } from "next/server";
import { getBrowserServiceUrl } from "@/app/api/image-solve-capture/browserService";

export async function POST() {
    try {
        let browserServiceUrl = "http://127.0.0.1:3001";
        try {
            browserServiceUrl = getBrowserServiceUrl();
        } catch {
            browserServiceUrl = process.env.BROWSER_SERVICE_URL || "http://127.0.0.1:3001";
        }

        await fetch(`${browserServiceUrl}/whatsapp/cancel`, {
            method: "POST",
            signal: AbortSignal.timeout(5000),
        });
        return NextResponse.json({ ok: true });
    } catch {
        return NextResponse.json({ ok: true });
    }
}
