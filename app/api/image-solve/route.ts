import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

if (typeof (globalThis as any).imageSolveKeyIndex === "undefined") {
    (globalThis as any).imageSolveKeyIndex = 0;
}

async function solveWithGeminiAPI(imageBase64: string, prompt: string): Promise<string> {
    const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
    const apiKeys = rawKeys.split(",").map((k) => k.trim()).filter(Boolean);

    if (apiKeys.length === 0) throw new Error("No GEMINI_API_KEYS configured.");

    const mimeType = imageBase64.startsWith("data:image/png") ? "image/png" : "image/jpeg";
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");

    const keyIndex = (globalThis as any).imageSolveKeyIndex % apiKeys.length;
    const apiKey = apiKeys[keyIndex];
    (globalThis as any).imageSolveKeyIndex = (keyIndex + 1) % apiKeys.length;

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
        const body = await req.json();
        const { image, prompt } = body;

        if (!image) {
            return NextResponse.json({ error: "No image provided." }, { status: 400 });
        }

        const solvePrompt = prompt ||
            "This is a question paper or exam image. Please read every question visible and provide clear, accurate answers for each one.";

        // ── 1. Try browser automation service ───────────────────────────────
        const browserServiceUrl = process.env.BROWSER_SERVICE_URL || "http://localhost:3001";
        try {
            console.log("[image-solve] Trying browser service…");
            const browserRes = await fetch(`${browserServiceUrl}/image-solve`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ image, prompt: solvePrompt }),
                signal: AbortSignal.timeout(295_000),
            });

            if (browserRes.ok) {
                const data = await browserRes.json();
                if (data.answer) {
                    console.log("[image-solve] Browser service returned primary answer.");
                    return NextResponse.json({
                        jobId: data.jobId,
                        answer: data.answer,
                        primaryAnswer: data.primaryAnswer || data.answer,
                        primaryScreenshot: data.primaryScreenshot || null,
                        backupAnswer: data.backupAnswer || null,
                        backupScreenshot: data.backupScreenshot || null,
                        backupStatus: data.backupStatus || (data.jobId ? "queued" : null),
                        backupProvider: data.backupProvider || "gemini",
                        provider: data.provider || "chatgpt",
                        source: "browser",
                    });
                } else if (data.jobId) {
                    console.log("[image-solve] Browser service queued job:", data.jobId);
                    return NextResponse.json({
                        jobId: data.jobId,
                        status: data.status,
                        error: data.error,
                        backupStatus: data.backupStatus,
                        backupProvider: data.backupProvider || "gemini",
                        provider: data.provider || "chatgpt",
                        source: "browser",
                    });
                }
            } else {
                const errData = await browserRes.json().catch(() => ({}));
                console.warn("[image-solve] Browser service error:", errData.error || browserRes.status);
            }
        } catch (browserErr: any) {
            console.warn("[image-solve] Browser service unavailable:", browserErr.message);
        }

        // ── 2. Fallback: Gemini API ──────────────────────────────────────────
        console.log("[image-solve] Falling back to Gemini API…");
        try {
            const answer = await solveWithGeminiAPI(image, solvePrompt);
            console.log("[image-solve] ✅ Gemini API fallback succeeded.");
            return NextResponse.json({ answer, source: "gemini-api" });
        } catch (apiErr: any) {
            console.error("[image-solve] Gemini API fallback failed:", apiErr.message);
            return NextResponse.json(
                { error: `Both browser service and Gemini API failed. API error: ${apiErr.message}` },
                { status: 500 }
            );
        }

    } catch (error: any) {
        console.error("[image-solve route] Unexpected error:", error);
        return NextResponse.json(
            { error: error.message || "Failed to process image solve request." },
            { status: 500 }
        );
    }
}
