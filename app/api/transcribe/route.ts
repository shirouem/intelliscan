import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

import { DEFAULT_TRANSCRIBE_PROMPT } from "@/app/constants/prompts";

if (typeof (globalThis as any).geminiKeyIndex === "undefined") {
    (globalThis as any).geminiKeyIndex = 0;
}

export const maxDuration = 180; // 3 minutes

const TRANSCRIBER_SYSTEM_PROMPT = DEFAULT_TRANSCRIBE_PROMPT;

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

async function convertTextWithGemini(solutionText: string, customSystemPrompt?: string): Promise<string> {
    const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
    const apiKeys = rawKeys.split(",").map(k => k.trim()).filter(Boolean);

    if (apiKeys.length === 0) {
        throw new Error("GEMINI_API_KEYS is missing.");
    }

    const systemPromptToUse = (customSystemPrompt && customSystemPrompt.trim())
        ? customSystemPrompt.trim()
        : TRANSCRIBER_SYSTEM_PROMPT;

    const prompt = `${systemPromptToUse}

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

    // Strip markdown code fences if Gemini wrapped output in ```markdown ... ```
    result = result.replace(/^```(?:markdown|text|transcript)?\s*/i, "").replace(/```\s*$/, "").trim();
    // Strip any leading conversational preambles
    result = result.replace(/^(?:Here is the (?:transcript(?: solution)?|spoken version|dictation)[^:\n]*:?\s*)+/i, "").trim();

    return result;
}

/**
 * Post-processes transcript for Deepgram TTS:
 * - Strips raw LaTeX delimiters and markdown formatting that can confuse TTS
 * - Fixes any raw Roman numerals or literal "open bracket i close bracket"
 * - Removes "bullet point:"
 * - Cleans chemical phase brackets (e.g. "open bracket s close bracket" -> "solid")
 * - Injects breathing pause ellipses (......) after sentence endings and colons so Deepgram naturally pauses for writing
 */
function prepareSpokenTextForTTS(transcript: string): string {
    let text = transcript;

    // 0. Strip markdown code fences and backticks
    text = text.replace(/```[a-z]*\n?/gi, ' ').replace(/```/g, ' ').replace(/`/g, ' ');

    // 1. Strip raw LaTeX delimiters \(, \), \[, \], and math $ delimiters so TTS doesn't speak literal symbols
    text = text.replace(/\\\(|\\\)/g, ' ');
    text = text.replace(/\\\[|\\\]/g, ' ');
    text = text.replace(/(^|[^\\])\$/g, '$1 ');

    // Strip markdown formatting symbols like asterisks and headers that TTS may pause on awkwardly
    text = text.replace(/\*{1,3}/g, ' ');
    text = text.replace(/^#{1,6}\s+/gm, ' ');

    // 2. Convert any remaining Roman numerals in brackets (i), (ii), (iii), (iv)...
    text = text.replace(/\((i{1,3}|iv|v|vi{0,3}|ix|x)\)/gi, (match, p1) => {
        const romanMap: Record<string, string> = {
            'i': 'Part 1: ', 'ii': 'Part 2: ', 'iii': 'Part 3: ', 'iv': 'Part 4: ',
            'v': 'Part 5: ', 'vi': 'Part 6: ', 'vii': 'Part 7: ', 'viii': 'Part 8: ',
            'ix': 'Part 9: ', 'x': 'Part 10: '
        };
        return romanMap[p1.toLowerCase()] || `Part ${p1}: `;
    });

    // 3. Fix literal "open bracket i close bracket", "open bracket i i close bracket", etc.
    text = text.replace(/open bracket\s*i{1,3}\s*close bracket/gi, (match) => {
        const inner = match.replace(/open bracket\s*/i, '').replace(/\s*close bracket/i, '').trim().toLowerCase();
        const map: Record<string, string> = { 'i': 'Part 1: ', 'ii': 'Part 2: ', 'iii': 'Part 3: ' };
        return map[inner] || `Part ${inner}: `;
    });
    text = text.replace(/open bracket\s+i\s+i\s+close bracket/gi, 'Part 2: ');
    text = text.replace(/open bracket\s+i\s+i\s+i\s+close bracket/gi, 'Part 3: ');
    text = text.replace(/open bracket\s+i\s+v\s+close bracket/gi, 'Part 4: ');
    text = text.replace(/open bracket\s+v\s+close bracket/gi, 'Part 5: ');

    // 4. Fix lettered subparts "open bracket a close bracket" -> "Part A: "
    text = text.replace(/open bracket\s+([a-d])\s+close bracket/gi, (match, p1) => `Part ${p1.toUpperCase()}: `);

    // 5. Remove "Bullet point:"
    text = text.replace(/bullet point:\s*/gi, '... ');

    // 6. Clean up overly literal chemical phase brackets
    text = text.replace(/open bracket\s*s\s*close bracket/gi, 'solid');
    text = text.replace(/open bracket\s*a\s*q\s*close bracket/gi, 'aqueous');
    text = text.replace(/open bracket\s*l\s*close bracket/gi, 'liquid');
    text = text.replace(/open bracket\s*g\s*close bracket/gi, 'gas');

    // 7. Injects deliberate pause breaks for simultaneous writing:
    text = text.replace(/([.!?])\s+(?=[A-Z0-9]|Part)/g, '$1 ...... ');
    text = text.replace(/:\s+(?=[A-Z0-9]|Part)/g, ': ... ... ');

    // Clean whitespace
    text = text.replace(/[ \t]+/g, ' ').replace(/\n+/g, ' ').trim();

    return text;
}

/**
 * Splits spoken text into safe chunks under maxChunkLength (default 1750 chars)
 * to avoid Deepgram's strict 2000 character limit per request.
 */
function splitSpokenTextIntoChunks(text: string, maxChunkLength = 1750): string[] {
    const cleanText = text.trim();
    if (cleanText.length <= maxChunkLength) {
        return [cleanText];
    }

    const chunks: string[] = [];
    const sentences = cleanText.split(/(?<=[.!?…])\s+/);

    let currentChunk = "";
    for (const sentence of sentences) {
        if (!sentence) continue;
        if (currentChunk.length + sentence.length + 1 <= maxChunkLength) {
            currentChunk = currentChunk ? `${currentChunk} ${sentence}` : sentence;
        } else {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
                currentChunk = "";
            }
            if (sentence.length > maxChunkLength) {
                const words = sentence.split(" ");
                let wordChunk = "";
                for (const word of words) {
                    if (wordChunk.length + word.length + 1 <= maxChunkLength) {
                        wordChunk = wordChunk ? `${wordChunk} ${word}` : word;
                    } else {
                        if (wordChunk) chunks.push(wordChunk.trim());
                        wordChunk = word;
                    }
                }
                if (wordChunk) currentChunk = wordChunk;
            } else {
                currentChunk = sentence;
            }
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }

    return chunks.filter(c => c.length > 0);
}

async function fetchDeepgramChunkAudio(chunkText: string, deepgramKey: string, speed: number): Promise<Buffer | null> {
    const primaryUrl = `https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&speed=${speed.toFixed(2)}`;
    try {
        let res = await fetch(primaryUrl, {
            method: "POST",
            headers: {
                "Authorization": `Token ${deepgramKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ text: chunkText }),
        });

        if (!res.ok) {
            console.warn(`[Transcribe] Primary Aura-2 model failed (${res.status}), attempting fallback model...`);
            res = await fetch("https://api.deepgram.com/v1/speak?model=aura-asteria-en", {
                method: "POST",
                headers: {
                    "Authorization": `Token ${deepgramKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ text: chunkText }),
            });
        }

        if (!res.ok) {
            const errText = await res.text();
            console.error(`[Transcribe] Deepgram TTS API error (${res.status}):`, errText);
            return null;
        }

        const arrayBuffer = await res.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (err) {
        console.error("[Transcribe] Deepgram TTS chunk request failed:", err);
        return null;
    }
}

async function generateDeepgramAudio(text: string, requestedSpeed = 0.85): Promise<string | null> {
    const deepgramKey = process.env.DEEPGRAM_KEY || process.env.DEEPGRAM_API_KEY;
    if (!deepgramKey) {
        console.warn("[Transcribe] DEEPGRAM_KEY not found in environment.");
        return null;
    }

    const speed = Math.max(0.65, Math.min(1.2, requestedSpeed));
    const chunks = splitSpokenTextIntoChunks(text, 1750);

    const buffers: Buffer[] = [];
    for (const chunk of chunks) {
        const buf = await fetchDeepgramChunkAudio(chunk, deepgramKey, speed);
        if (!buf) {
            console.warn("[Transcribe] Failed to generate audio for chunk, aborting full audio.");
            return null;
        }
        buffers.push(buf);
    }

    if (buffers.length === 0) return null;

    const combinedBuffer = Buffer.concat(buffers);
    const base64Audio = combinedBuffer.toString("base64");
    return `data:audio/mp3;base64,${base64Audio}`;
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { questionText, solutionText, questionNumber, speed, transcribePrompt } = body;

        if (!solutionText || typeof solutionText !== "string" || !solutionText.trim()) {
            return NextResponse.json({ error: "solutionText is required" }, { status: 400 });
        }

        // 1. Convert written solution into spoken transcript using Transcript Solution Encoder
        const transcript = await convertTextWithGemini(solutionText.trim(), transcribePrompt);

        // 2. Formulate spoken intro from question
        const questionIntro = extractQuestionIntro(questionText || "", questionNumber);

        // 3. Prepare spoken text with natural dictation pauses and Roman numeral corrections
        const cleanSpokenTranscript = prepareSpokenTextForTTS(transcript);
        const spokenText = `${questionIntro} ...... ${cleanSpokenTranscript}`.trim();

        // 4. Generate TTS audio via Deepgram with dictation speed
        const audioSpeed = typeof speed === "number" && speed > 0 ? speed : 0.85;
        const audioDataUrl = await generateDeepgramAudio(spokenText, audioSpeed);

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
