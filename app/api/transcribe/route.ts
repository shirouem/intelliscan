import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

if (typeof (globalThis as any).geminiKeyIndex === "undefined") {
    (globalThis as any).geminiKeyIndex = 0;
}

export const maxDuration = 180; // 3 minutes

const TRANSCRIBER_SYSTEM_PROMPT = `You are a **Transcript Solution Encoder**.

Your job is to convert a **Text Solution** into a **Transcript Solution** that can be read aloud so a listener can reconstruct the original Text Solution as accurately and unambiguously as possible.

### Core principle

**PRESERVE LANGUAGE. ENCODE NOTATION.**

The Text Solution is the source of truth.

* Preserve ordinary English **verbatim** whenever possible.
* Do not paraphrase, summarize, simplify, explain, correct, reorder, or improve the solution.
* Only transform parts that cannot be reliably understood/reconstructed through speech.

### What must be encoded

Explicitly and unambiguously encode:

* equations and calculations
* mathematical operators and relationships
* chemical formulae
* subscripts and superscripts
* charges and signs
* fractions
* brackets/grouping
* symbols
* units
* reaction arrows
* tables, lists, and meaningful formatting
* any visual structure whose loss could change the written answer

### Minimal transformation

Transform the **smallest possible span**.

For example:

> According to the Nernst equation, \\(E = E^\\circ - \\frac{0.0591}{n}\\log Q\\).

becomes:

> According to the Nernst equation, E equals E degree minus zero point zero five nine one divided by n log Q.

The surrounding English remains unchanged.

### Explicitness > brevity

If natural speech could correspond to multiple written forms, make it more explicit.

For example:

$$
5-(-3)
$$

→

> five minus open bracket negative three close bracket

rather than simply:

> five minus negative three

Similarly, preserve numerator/denominator boundaries, grouping, subscripts, superscripts, charges, and signs whenever they could otherwise be lost.

However, **do not over-encode obvious notation**. Use the shortest natural spoken form that remains unambiguous.

### Calculations

Preserve every step.

Turn visual continuation into minimal structural glue where necessary:

$$
M=\\frac{n}{V}=\\frac{0.5}{2}=0.25M
$$

→

> M equals n by V, which equals 0.5 by 2, which equals 0.25 M.

Do not skip intermediate work or add reasoning.

### No invented information

You may add tiny structural phrases such as "which equals", "first", or "open bracket" when required to encode the written structure.

Never add substantive information, explanations, assumptions, corrections, or conclusions that aren't present in the Text Solution.

### Final test

Before outputting, ask:

> **Could someone who only hears this Transcript Solution reproduce the original Text Solution without seeing it?**

If anything important could be lost or interpreted ambiguously, make that part more explicit.

Optimize:

$$
\\boxed{\\text{Natural speech} \\quad \\text{subject to} \\quad \\text{maximum reconstructability}}
$$

Output **only the Transcript Solution**.`;

/**
 * Extracts a concise 1-sentence intro from the question so the listener can recognize the problem.
 */
function extractQuestionIntro(questionText: string, questionNumber?: string): string {
    const cleanText = (questionText || "").replace(/\s+/g, " ").trim();
    if (!cleanText) {
        return questionNumber ? `Question ${questionNumber}.` : "Question.";
    }

    // Match up to the first sentence terminal (. ? !) or max 20 words
    const sentenceMatch = cleanText.match(/^([^.?!]+[.?!])/);
    let firstSentence = sentenceMatch ? sentenceMatch[1].trim() : cleanText;
    const words = firstSentence.split(" ");
    if (words.length > 22) {
        firstSentence = words.slice(0, 20).join(" ") + "...";
    }

    const prefix = questionNumber ? `Question ${questionNumber}: ` : "";
    return `${prefix}${firstSentence}`;
}

async function convertTextWithGemini(solutionText: string): Promise<string> {
    const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
    const apiKeys = rawKeys.split(",").map(k => k.trim()).filter(Boolean);

    if (apiKeys.length === 0) {
        throw new Error("GEMINI_API_KEYS is missing.");
    }

    const prompt = `${TRANSCRIBER_SYSTEM_PROMPT}

Text Solution to encode:
${solutionText}
`;

    const modelsToTry = [
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.7-flash",
        "gemini-3.8-flash",
        "gemini-3-flash-preview",
        "gemini-3.5-flash-lite",
        "gemini-2.5-flash"
    ];

    let result = "";
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
                        temperature: 0.1,
                    }
                });

                if (response.text) {
                    result = response.text.trim();
                    success = true;
                    break;
                }
            } catch (err: any) {
                console.warn(`[Transcribe] Model ${modelName} failed:`, err?.message);
            }
        }

        if (success) {
            break;
        } else {
            (globalThis as any).geminiKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
        }
    }

    if (!success || !result) {
        throw new Error("Failed to encode transcript with Gemini.");
    }

    return result;
}

async function generateDeepgramAudio(text: string): Promise<string | null> {
    const deepgramKey = process.env.DEEPGRAM_KEY || process.env.DEEPGRAM_API_KEY;
    if (!deepgramKey) {
        console.warn("[Transcribe] DEEPGRAM_KEY not found in environment.");
        return null;
    }

    try {
        const res = await fetch("https://api.deepgram.com/v1/speak?model=aura-asteria-en", {
            method: "POST",
            headers: {
                "Authorization": `Token ${deepgramKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ text }),
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error(`[Transcribe] Deepgram TTS API error (${res.status}):`, errText);
            return null;
        }

        const arrayBuffer = await res.arrayBuffer();
        const base64Audio = Buffer.from(arrayBuffer).toString("base64");
        return `data:audio/mp3;base64,${base64Audio}`;
    } catch (err) {
        console.error("[Transcribe] Deepgram TTS request failed:", err);
        return null;
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { questionText, solutionText, questionNumber } = body;

        if (!solutionText || typeof solutionText !== "string" || !solutionText.trim()) {
            return NextResponse.json({ error: "solutionText is required" }, { status: 400 });
        }

        // 1. Convert written solution into spoken transcript using Transcript Solution Encoder
        const transcript = await convertTextWithGemini(solutionText.trim());

        // 2. Formulate spoken intro from question
        const questionIntro = extractQuestionIntro(questionText || "", questionNumber);
        const spokenText = `${questionIntro} ${transcript}`.trim();

        // 3. Generate TTS audio via Deepgram
        const audioDataUrl = await generateDeepgramAudio(spokenText);

        return NextResponse.json({
            transcript,
            questionIntro,
            spokenText,
            audioDataUrl,
        });
    } catch (error: any) {
        console.error("[Transcribe API] Error:", error);
        return NextResponse.json(
            { error: error?.message || "Failed to process transcript" },
            { status: 500 }
        );
    }
}
