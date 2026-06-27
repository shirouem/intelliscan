import { NextRequest, NextResponse } from "next/server";

type ImageSolveBody = {
    image?: string;
    prompt?: string;
    primaryProvider?: string;
    backupProvider?: string | null;
};

type BrowserSolveResponse = {
    jobId?: string;
    status?: string;
    error?: string;
    answer?: string;
    primaryAnswer?: string;
    primaryScreenshot?: string | null;
    primaryError?: string | null;
    browserError?: string | null;
    backupAnswer?: string | null;
    backupScreenshot?: string | null;
    backupStatus?: string | null;
    backupProvider?: string;
    provider?: string;
};

function normalizeProviderName(providerName: unknown): "chatgpt" | "gemini" {
    return providerName === "gemini" ? "gemini" : "chatgpt";
}

function getErrorMessage(error: unknown, fallback = "Unknown error") {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return fallback;
}

export const maxDuration = 300;

export async function POST(req: NextRequest) {
    try {
        const body = await req.json() as ImageSolveBody;
        const { image, prompt } = body;
        const primaryProvider = normalizeProviderName(body.primaryProvider);
        const backupProvider = body.backupProvider === undefined ? null : body.backupProvider;

        if (!image) {
            return NextResponse.json({ error: "No image provided." }, { status: 400 });
        }

        const solvePrompt = prompt ||
            "This is a question paper or exam image. Please read every question visible and provide clear, accurate answers for each one.";

        // ── Browser automation service (only path — no hidden fallbacks) ──────
        const browserServiceUrl = process.env.BROWSER_SERVICE_URL || "http://localhost:3001";

        try {
            console.log("[image-solve] Sending to browser service...");
            const browserRes = await fetch(`${browserServiceUrl}/image-solve`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ image, prompt: solvePrompt, primaryProvider, backupProvider }),
                signal: AbortSignal.timeout(295_000),
            });

            if (browserRes.ok) {
                const data = await browserRes.json() as BrowserSolveResponse;
                if (data.jobId || data.answer || data.primaryScreenshot || data.backupScreenshot) {
                    console.log("[image-solve] Browser service succeeded.");
                    return NextResponse.json({
                        jobId: data.jobId,
                        status: data.status,
                        error: data.error,
                        answer: data.answer || null,
                        primaryAnswer: data.primaryAnswer || data.answer || null,
                        primaryScreenshot: data.primaryScreenshot || null,
                        backupAnswer: data.backupAnswer || null,
                        backupScreenshot: data.backupScreenshot || null,
                        backupStatus: data.backupStatus || (data.jobId ? "queued" : null),
                        backupProvider: data.backupProvider || backupProvider,
                        provider: data.provider || primaryProvider,
                        primaryError: data.primaryError || data.browserError || data.error || null,
                        browserError: data.browserError || data.primaryError || data.error || null,
                        source: "browser",
                    });
                }

                const errMsg = "Browser service returned no answer or screenshot.";
                console.warn("[image-solve]", errMsg);
                return NextResponse.json({ error: errMsg, status: "browser_failed" });
            }

            const errData = await browserRes.json().catch(() => ({})) as { error?: string };
            const errMsg = errData.error || `Browser service returned HTTP ${browserRes.status}`;
            console.warn("[image-solve] Browser service error:", errMsg);
            return NextResponse.json({ error: errMsg, status: "browser_failed" });

        } catch (browserErr: unknown) {
            const errMsg = getErrorMessage(browserErr, "Browser service unavailable.");
            console.warn("[image-solve] Browser service unavailable:", errMsg);
            return NextResponse.json({ error: errMsg, status: "browser_failed" });
        }

    } catch (error: unknown) {
        const errorMessage = getErrorMessage(error, "Failed to process image solve request.");
        console.error("[image-solve route] Unexpected error:", error);
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
