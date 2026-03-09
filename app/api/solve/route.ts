import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

if (typeof (globalThis as any).geminiKeyIndex === "undefined") {
    (globalThis as any).geminiKeyIndex = 0;
}

export async function POST(req: NextRequest) {
    const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
    const apiKeys = rawKeys.split(",").map(k => k.trim()).filter(Boolean);

    if (apiKeys.length === 0) {
        return NextResponse.json({
            error: "GEMINI_API_KEYS is not set. Please add it to your .env.local file."
        }, { status: 500 });
    }

    try {
        const body = await req.json();
        const { questions } = body;

        if (!questions || !Array.isArray(questions) || questions.length === 0) {
            return NextResponse.json({ error: "No questions provided." }, { status: 400 });
        }

        const prompt = `
        You are an expert tutor. I am providing you with an array of questions extracted from a question paper.
        Please solve each question accurately and provide a clear, step-by-step solution.
        
        Return your answer as a raw strict JSON object ONLY. 
        The keys of the JSON object must correspond to the exact 'id' of each provided question, and the value should be the string containing your detailed solution.
        Do not wrap the text in markdown blocks (e.g. \`\`\`json). Just return the raw JSON braces.

        Here are the questions:
        ${JSON.stringify(questions, null, 2)}
        `;

        const modelsToTry = [
            "gemini-3.0-flash-preview",
            "gemini-3.1-flash-lite-preview",
            "gemini-2.5-flash"
        ];

        let rawText = null;
        let lastError = null;
        let success = false;
        const maxKeyAttempts = apiKeys.length;

        for (let keyAttempt = 0; keyAttempt < maxKeyAttempts; keyAttempt++) {
            const currentKeyIndex = (globalThis as any).geminiKeyIndex;
            const currentApiKey = apiKeys[currentKeyIndex];
            const ai = new GoogleGenAI({ apiKey: currentApiKey });

            console.log(`[Solve API] Using API Key at Index: ${currentKeyIndex}`);

            for (const modelName of modelsToTry) {
                try {
                    console.log(`  Attempting solution generation with model: ${modelName}`);
                    const response = await ai.models.generateContent({
                        model: modelName,
                        contents: [prompt],
                        config: {
                            temperature: 0.2,
                            responseMimeType: "application/json",
                        }
                    });

                    rawText = response.text;
                    if (rawText) {
                        console.log(`  Successfully generated solutions using ${modelName}`);
                        success = true;
                        break;
                    }
                } catch (error: any) {
                    console.warn(`  Model ${modelName} failed:`, error.message);
                    lastError = error;
                }
            }

            if (success) {
                break;
            } else {
                console.warn(`All models failed for API Key index ${currentKeyIndex}. Switching to next key.`);
                (globalThis as any).geminiKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
            }
        }

        if (!success || !rawText) {
            console.error("All models and keys failed. Last error:", lastError);
            return NextResponse.json(
                { error: `All models and keys failed to solve questions. Last error: ${lastError?.message || 'Unknown error'}` },
                { status: 500 }
            );
        }

        try {
            const parsedSolutions = JSON.parse(rawText);
            return NextResponse.json({ solutions: parsedSolutions });
        } catch (jsonError) {
            console.error("Failed to parse AI solution output:", rawText);
            return NextResponse.json({ error: "Failed to parse solutions from AI." }, { status: 500 });
        }

    } catch (error: any) {
        console.error("Solve API Error:", error);
        return NextResponse.json(
            { error: error.message || "An error occurred while solving the questions." },
            { status: 500 }
        );
    }
}
