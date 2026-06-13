import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

declare global {
    var imageSolveKeyIndex: number | undefined;
}

type ImageSolveBody = {
    image?: string;
    prompt?: string;
    useFallbackOnly?: boolean;
    browserError?: string | null;
    primaryProvider?: "chatgpt" | "gemini";
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

if (typeof globalThis.imageSolveKeyIndex === "undefined") {
    globalThis.imageSolveKeyIndex = 0;
}

async function solveWithGeminiAPI(imageBase64: string, prompt: string): Promise<string> {
    const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
    const apiKeys = rawKeys.split(",").map((k) => k.trim()).filter(Boolean);

    if (apiKeys.length === 0) throw new Error("No GEMINI_API_KEYS configured.");

    const mimeType = imageBase64.startsWith("data:image/png") ? "image/png" : "image/jpeg";
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");

    const keyIndex = (globalThis.imageSolveKeyIndex ?? 0) % apiKeys.length;
    const apiKey = apiKeys[keyIndex];
    globalThis.imageSolveKeyIndex = (keyIndex + 1) % apiKeys.length;

    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
            {
                role: "user",
                parts: [
                    { inlineData: { mimeType, data: base64Data } },
                    { text: prompt },
                ],
            },
        ],
    });

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) throw new Error("Gemini API returned empty response.");
    return text;
}

export const maxDuration = 300;

export async function POST(req: NextRequest) {
    try {
        const body = await req.json() as ImageSolveBody;
        const { image, prompt, useFallbackOnly } = body;
        const primaryProvider = normalizeProviderName(body.primaryProvider);

        if (!image) {
            return NextResponse.json({ error: "No image provided." }, { status: 400 });
        }

        const solvePrompt = prompt ||
            "This is a question paper or exam image. Please read every question visible and provide clear, accurate answers for each one.";

        const runGeminiApiFallback = async (browserError?: string | null) => {
            console.log("[image-solve] Falling back to Gemini API...");
            try {
                const answer = await solveWithGeminiAPI(image, solvePrompt);
                console.log("[image-solve] Gemini API fallback succeeded.");
                return NextResponse.json({
                    answer,
                    provider: "gemini-api",
                    source: "gemini-api",
                    browserError: browserError || null,
                    primaryError: browserError || null,
                });
            } catch (apiErr: unknown) {
                const apiErrorMessage = getErrorMessage(apiErr);
                console.error("[image-solve] Gemini API fallback failed:", apiErrorMessage);
                return NextResponse.json(
                    {
                        error: browserError
                            ? `Browser solve failed first: ${browserError}. Gemini API fallback failed: ${apiErrorMessage}`
                            : `Gemini API fallback failed: ${apiErrorMessage}`,
                        browserError: browserError || null,
                        primaryError: browserError || null,
                    },
                    { status: 500 }
                );
            }
        };

        if (useFallbackOnly) {
            return runGeminiApiFallback(body.browserError || null);
        }

        // ── 1. Try browser automation service ───────────────────────────────
        const browserServiceUrl = process.env.BROWSER_SERVICE_URL || "http://localhost:3001";
        let browserError: string | null = null;
        try {
            console.log("[image-solve] Trying browser service...");
            const browserRes = await fetch(`${browserServiceUrl}/image-solve`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ image, prompt: solvePrompt, primaryProvider }),
                signal: AbortSignal.timeout(295_000),
            });

            if (browserRes.ok) {
                const data = await browserRes.json() as BrowserSolveResponse;
                if (data.jobId || data.answer || data.primaryScreenshot || data.backupScreenshot) {
                    console.log("[image-solve] Browser service returned image solve job/result.");
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
                        backupProvider: data.backupProvider || (primaryProvider === "gemini" ? "chatgpt" : "gemini"),
                        provider: data.provider || primaryProvider,
                        primaryError: data.primaryError || data.browserError || data.error || null,
                        browserError: data.browserError || data.primaryError || data.error || null,
                        source: "browser",
                    });
                }

                browserError = "Browser service returned no answer or fallback job.";
            } else {
                const errData = await browserRes.json().catch(() => ({})) as { error?: string };
                browserError = errData.error || `Browser service returned HTTP ${browserRes.status}`;
                console.warn("[image-solve] Browser service error:", browserError);
            }
        } catch (browserErr: unknown) {
            browserError = getErrorMessage(browserErr, "Browser service unavailable.");
            console.warn("[image-solve] Browser service unavailable:", browserError);
        }

        return NextResponse.json({
            status: "browser_failed",
            error: browserError || "Browser solve failed.",
            browserError: browserError || "Browser solve failed.",
            primaryError: browserError || "Browser solve failed.",
            fallbackRequired: true,
            fallbackProvider: "gemini-api",
            source: "browser",
        });

    } catch (error: unknown) {
        const errorMessage = getErrorMessage(error, "Failed to process image solve request.");
        console.error("[image-solve route] Unexpected error:", error);
        return NextResponse.json(
            { error: errorMessage },
            { status: 500 }
        );
    }
}
