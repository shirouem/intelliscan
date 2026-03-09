import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

if (typeof (globalThis as any).geminiKeyIndex === "undefined") {
    (globalThis as any).geminiKeyIndex = 0;
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { image } = body;

        if (!image) {
            return NextResponse.json({ error: "No image provided" }, { status: 400 });
        }

        // Extract base64 part if it's a data URL
        const base64Data = image.split(",")[1];
        if (!base64Data) {
            return NextResponse.json({ error: "Invalid image format" }, { status: 400 });
        }

        const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
        const apiKeys = rawKeys.split(",").map(k => k.trim()).filter(Boolean);

        if (apiKeys.length === 0) {
            console.warn("No API Keys found.");
            return NextResponse.json(
                { error: "GEMINI_API_KEYS is missing in .env.local. Please add it and restart the server." },
                { status: 400 }
            );
        }

        const prompt = `
      Please analyze this image of a question paper.
      Extract the text literally, separating it out question by question.
      Return ONLY a JSON array with objects in the following precise format, without markdown wrapping or extra text.
      
      [
        {
          "id": "q1",
          "questionNumber": "1",
          "text": "The complete text of the question including multiple choice options if present"
        }
      ]
    `;

        const modelsToTry = [
            "gemini-3.1-flash-lite-preview",
            "gemini-2.5-flash",
            "gemini-3.0-flash-preview",
        ];

        let text = null;
        let lastError = null;
        let success = false;
        const maxKeyAttempts = apiKeys.length;

        for (let keyAttempt = 0; keyAttempt < maxKeyAttempts; keyAttempt++) {
            const currentKeyIndex = (globalThis as any).geminiKeyIndex;
            const currentApiKey = apiKeys[currentKeyIndex];
            const ai = new GoogleGenAI({ apiKey: currentApiKey });

            console.log(`[Scan API] Using API Key at Index: ${currentKeyIndex}`);

            for (const modelName of modelsToTry) {
                try {
                    console.log(`  Attempting image extraction with model: ${modelName}`);
                    const response = await ai.models.generateContent({
                        model: modelName,
                        contents: [
                            prompt,
                            {
                                inlineData: {
                                    data: base64Data,
                                    mimeType: "image/jpeg",
                                },
                            },
                        ],
                        config: {
                            temperature: 0.1,
                            responseMimeType: "application/json",
                        }
                    });

                    text = response.text;
                    if (text) {
                        console.log(`  Successfully extracted text using ${modelName}`);
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

        if (!success || !text) {
            console.error("All models and keys failed. Last error:", lastError);
            throw new Error(`All models and keys failed to process the image. Last error: ${lastError?.message || 'Unknown error'}`);
        }

        if (!text) {
            throw new Error("No response from AI model");
        }

        let parsedQuestions;
        try {
            parsedQuestions = JSON.parse(text);
        } catch (e) {
            console.error("Failed to parse JSON response:", text);
            throw new Error("Failed to parse extracted questions");
        }

        return NextResponse.json({ questions: parsedQuestions });
    } catch (error: any) {
        console.error("API Error in /api/scan:", error);
        return NextResponse.json(
            { error: error.message || "Failed to process image" },
            { status: 500 }
        );
    }
}
