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

### Roman Numerals, Subparts, and Bullet Points (CRITICAL FOR SPOKEN ACCURACY)

* **Subparts & Enumeration:**
  For subparts written as (i), (ii), (iii), (iv), (v), (vi), etc., or i., ii., iii.:
  Speak them clearly as **"Part 1:"**, **"Part 2:"**, **"Part 3:"**, **"Part 4:"**, **"Part 5:"**, etc. (or "First", "Second", "Third").
  **NEVER** say "open bracket i close bracket" or "open bracket eye close bracket" or pronounce Roman numerals as letters ("eye", "eye eye", "eye eye eye").
* **Lettered Subparts:**
  Speak (a), (b), (c) as **"Part A:"**, **"Part B:"**, **"Part C:"**.
* **Bullet Points:**
  Do **NOT** say "Bullet point:". Simply read the bulleted point directly or prefix with a natural transition ("First:", "Next:").
* **Brackets vs Conversational Parentheses:**
  Reserve "open bracket ... close bracket" ONLY for mathematical/algebraic groupings (e.g., 5 - (-3) or (x+1)(x-2)) or complex chemical coordination complexes.
  For ordinary conversational or parenthetical English clarifications (e.g., "(anode)", "(from Zn to Ag)", "(Oxidation)", "(Reduction)"), do NOT say "open bracket ... close bracket". Instead, speak them as natural spoken phrases separated by commas or pauses (e.g. ", anode,", ", oxidation:").

### Dictation Pacing and Natural Pauses

* The listener is writing down this solution simultaneously as they listen.
* Separate steps, equations, and subparts with clear punctuation (periods, colons) and line breaks so there are distinct natural pauses between steps.
* Do not run multiple calculation steps together into an unbroken sentence.

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

/**
 * Post-processes transcript for Deepgram TTS:
 * - Fixes any raw Roman numerals or literal "open bracket i close bracket"
 * - Removes "bullet point:"
 * - Cleans chemical phase brackets (e.g. "open bracket s close bracket" -> "solid", "open bracket a q close bracket" -> "aqueous")
 * - Injects breathing pause ellipses (......) after sentence endings and colons so Deepgram naturally pauses for writing
 */
function prepareSpokenTextForTTS(transcript: string): string {
    let text = transcript;

    // 1. Convert any remaining Roman numerals in brackets (i), (ii), (iii), (iv)...
    text = text.replace(/\((i{1,3}|iv|v|vi{0,3}|ix|x)\)/gi, (match, p1) => {
        const romanMap: Record<string, string> = {
            'i': 'Part 1: ', 'ii': 'Part 2: ', 'iii': 'Part 3: ', 'iv': 'Part 4: ',
            'v': 'Part 5: ', 'vi': 'Part 6: ', 'vii': 'Part 7: ', 'viii': 'Part 8: ',
            'ix': 'Part 9: ', 'x': 'Part 10: '
        };
        return romanMap[p1.toLowerCase()] || `Part ${p1}: `;
    });

    // 2. Fix literal "open bracket i close bracket", "open bracket i i close bracket", etc.
    text = text.replace(/open bracket\s*i{1,3}\s*close bracket/gi, (match) => {
        const inner = match.replace(/open bracket\s*/i, '').replace(/\s*close bracket/i, '').trim().toLowerCase();
        const map: Record<string, string> = { 'i': 'Part 1: ', 'ii': 'Part 2: ', 'iii': 'Part 3: ' };
        return map[inner] || `Part ${inner}: `;
    });
    text = text.replace(/open bracket\s+i\s+i\s+close bracket/gi, 'Part 2: ');
    text = text.replace(/open bracket\s+i\s+i\s+i\s+close bracket/gi, 'Part 3: ');
    text = text.replace(/open bracket\s+i\s+v\s+close bracket/gi, 'Part 4: ');
    text = text.replace(/open bracket\s+v\s+close bracket/gi, 'Part 5: ');

    // 3. Fix lettered subparts "open bracket a close bracket" -> "Part A: "
    text = text.replace(/open bracket\s+([a-d])\s+close bracket/gi, (match, p1) => `Part ${p1.toUpperCase()}: `);

    // 4. Remove "Bullet point:"
    text = text.replace(/bullet point:\s*/gi, '... ');

    // 5. Clean up overly literal chemical phase brackets
    text = text.replace(/open bracket\s*s\s*close bracket/gi, 'solid');
    text = text.replace(/open bracket\s*a\s*q\s*close bracket/gi, 'aqueous');
    text = text.replace(/open bracket\s*l\s*close bracket/gi, 'liquid');
    text = text.replace(/open bracket\s*g\s*close bracket/gi, 'gas');

    // 6. Injects deliberate pause breaks for simultaneous writing:
    // Stacking ellipses "......" or "... ..." in Deepgram Aura creates an intentional pause between thoughts/steps
    text = text.replace(/([.!?])\s+(?=[A-Z0-9]|Part)/g, '$1 ...... ');
    text = text.replace(/:\s+(?=[A-Z0-9]|Part)/g, ': ... ... ');

    // Clean whitespace
    text = text.replace(/[ \t]+/g, ' ').trim();

    return text;
}

async function generateDeepgramAudio(text: string, requestedSpeed = 0.85): Promise<string | null> {
    const deepgramKey = process.env.DEEPGRAM_KEY || process.env.DEEPGRAM_API_KEY;
    if (!deepgramKey) {
        console.warn("[Transcribe] DEEPGRAM_KEY not found in environment.");
        return null;
    }

    const speed = Math.max(0.65, Math.min(1.2, requestedSpeed));

    // Try Aura-2 model with speed parameter first
    const primaryUrl = `https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&speed=${speed.toFixed(2)}`;

    try {
        let res = await fetch(primaryUrl, {
            method: "POST",
            headers: {
                "Authorization": `Token ${deepgramKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ text }),
        });

        if (!res.ok) {
            console.warn(`[Transcribe] Primary Aura-2 model failed (${res.status}), attempting fallback model...`);
            // Fallback to aura-asteria-en without speed parameter
            res = await fetch("https://api.deepgram.com/v1/speak?model=aura-asteria-en", {
                method: "POST",
                headers: {
                    "Authorization": `Token ${deepgramKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ text }),
            });
        }

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
        const { questionText, solutionText, questionNumber, speed } = body;

        if (!solutionText || typeof solutionText !== "string" || !solutionText.trim()) {
            return NextResponse.json({ error: "solutionText is required" }, { status: 400 });
        }

        // 1. Convert written solution into spoken transcript using Transcript Solution Encoder
        const transcript = await convertTextWithGemini(solutionText.trim());

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
