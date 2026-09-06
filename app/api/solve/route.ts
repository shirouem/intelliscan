import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

if (typeof (globalThis as any).geminiKeyIndex === "undefined") {
    (globalThis as any).geminiKeyIndex = 0;
}

export const maxDuration = 300; // 5 minutes

export async function POST(req: NextRequest) {
    const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
    const apiKeys = rawKeys.split(",").map(k => k.trim()).filter(Boolean);

    if (apiKeys.length === 0) {
        return NextResponse.json({ error: "GEMINI_API_KEYS is not set." }, { status: 500 });
    }

    try {
        const body = await req.json();
        const { questions, customSolvePrompt } = body;

        if (!questions || !Array.isArray(questions) || questions.length === 0) {
            return NextResponse.json({ error: "No questions provided." }, { status: 400 });
        }

        const systemPrompt = customSolvePrompt && customSolvePrompt.trim().length > 0
            ? customSolvePrompt
            : `You are an expert academic tutor and problem solver.
You are given an array of questions extracted from camera scans of exam or test papers.
Please carefully solve each question step-by-step and provide a clear, rigorous, and direct final answer.

IMPORTANT GUIDELINES FOR SCAN ARTIFACTS AND MULTIPLE QUESTIONS:
1. Handle Multiple Questions: Solve every question provided in the input array.
2. Robustness to Scan Errors: Because the text comes from real-world camera scans, there may be OCR mistranscriptions, missing letters, line cutoffs, or degraded formatting. Use context and domain knowledge (math, physics, chemistry, biology, general science, etc.) to reconstruct and solve the intended question.
3. Garbled / Corrupted Text: If a question consists of unintelligible gibberish, noise, or severely cutoff text that cannot be reasonably deduced, explicitly state: "Unable to solve: Scan text is incomplete or corrupted."
4. Format: For each question, provide the direct step-by-step working and final answer cleanly.`;


        const prompt = `${systemPrompt}
        
Return ONLY a valid JSON object. 
The keys of the JSON object must correspond to the exact 'id' of each provided question.
The value for each key must be the string containing your detailed solution.
DO NOT wrap the text in markdown blocks (e.g. \`\`\`json). Just return the raw JSON object.

Here are the questions:
${JSON.stringify(questions, null, 2)}
`;

        const modelsToTry = [
            "gemini-3.8-flash",
            "gemini-3.7-flash",
            "gemini-3.6-flash",
            "gemini-3.5-flash",
            "gemini-3-flash-preview",
            "gemini-3.5-flash-lite",
            "gemini-2.5-flash"
        ];

        let rawText = null;
        let success = false;

        for (let keyAttempt = 0; keyAttempt < apiKeys.length; keyAttempt++) {
            const currentKeyIndex = (globalThis as any).geminiKeyIndex;
            const currentApiKey = apiKeys[currentKeyIndex];
            const ai = new GoogleGenAI({ apiKey: currentApiKey });

            for (const modelName of modelsToTry) {
                try {
                    const response = await ai.models.generateContent({
                        model: modelName,
                        contents: [prompt],
                        config: {
                            temperature: 0.2,
                            responseMimeType: "application/json",
                        }
                    });

                    if (response.text) {
                        rawText = response.text;
                        success = true;
                        break;
                    }
                } catch (error: any) {
                    console.warn(`Model ${modelName} failed:`, error.message);
                }
            }

            if (success) {
                break;
            } else {
                (globalThis as any).geminiKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
            }
        }

        if (!success || !rawText) {
            return NextResponse.json({ error: "All models failed to solve questions." }, { status: 500 });
        }

        try {
            // NO FANCY PARSING: Just string replace the markdown backticks if they are there
            const cleanText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
            const parsedSolutions = JSON.parse(cleanText);

            return NextResponse.json({ solutions: parsedSolutions });
        } catch (jsonError) {
            console.error("Failed to parse AI solution output:", rawText);
            return NextResponse.json({ error: "Failed to parse solutions from AI." }, { status: 500 });
        }

    } catch (error: any) {
        console.error("Solve API Error:", error);
        return NextResponse.json({ error: error.message || "An error occurred." }, { status: 500 });
    }
}
