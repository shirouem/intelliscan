import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { DEFAULT_SOLVE_PROMPT, DEFAULT_TRANSCRIBE_PROMPT } from "@/app/constants/prompts";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DATA_DIR = path.join(process.cwd(), "data");
const FILE_PATH = path.join(DATA_DIR, "scanned_questions.json");

const noCacheHeaders = {
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
};

interface ScannedQuestion {
    id: string;
    questionNumber?: string;
    text: string;
    solution?: string;
    transcript?: string;
    audioDataUrl?: string | null;
    questionIntro?: string;
    isSolving?: boolean;
    createdAt?: number;
}

interface StorageData {
    updatedAt: number;
    version: number;
    questions: ScannedQuestion[];
    solvePrompt?: string;
    transcribePrompt?: string;
}

function ensureDataFile(): StorageData {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(FILE_PATH)) {
        const initial: StorageData = {
            updatedAt: Date.now(),
            version: 1,
            questions: [],
            solvePrompt: DEFAULT_SOLVE_PROMPT,
            transcribePrompt: DEFAULT_TRANSCRIBE_PROMPT,
        };
        fs.writeFileSync(FILE_PATH, JSON.stringify(initial, null, 2), "utf-8");
        return initial;
    }
    try {
        const content = fs.readFileSync(FILE_PATH, "utf-8");
        const parsed = JSON.parse(content) as StorageData;
        let modified = false;

        if (!parsed.solvePrompt) {
            parsed.solvePrompt = DEFAULT_SOLVE_PROMPT;
            modified = true;
        }
        if (!parsed.transcribePrompt) {
            parsed.transcribePrompt = DEFAULT_TRANSCRIBE_PROMPT;
            modified = true;
        }
        if (!Array.isArray(parsed.questions)) {
            parsed.questions = [];
            modified = true;
        }

        if (modified) {
            fs.writeFileSync(FILE_PATH, JSON.stringify(parsed, null, 2), "utf-8");
        }
        return parsed;
    } catch {
        const fallback: StorageData = {
            updatedAt: Date.now(),
            version: 1,
            questions: [],
            solvePrompt: DEFAULT_SOLVE_PROMPT,
            transcribePrompt: DEFAULT_TRANSCRIBE_PROMPT,
        };
        fs.writeFileSync(FILE_PATH, JSON.stringify(fallback, null, 2), "utf-8");
        return fallback;
    }
}

function writeDataFile(data: StorageData) {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const tempPath = `${FILE_PATH}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tempPath, FILE_PATH);
}

// GET: Fetch questions, prompts, and sync status
export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const since = Number(searchParams.get("since") || 0);

        const data = ensureDataFile();

        if (since && since >= data.updatedAt) {
            return NextResponse.json({
                changed: false,
                updatedAt: data.updatedAt,
                version: data.version,
                count: data.questions.length,
            }, { headers: noCacheHeaders });
        }

        return NextResponse.json({
            changed: true,
            updatedAt: data.updatedAt,
            version: data.version,
            questions: data.questions,
            solvePrompt: data.solvePrompt || DEFAULT_SOLVE_PROMPT,
            transcribePrompt: data.transcribePrompt || DEFAULT_TRANSCRIBE_PROMPT,
        }, { headers: noCacheHeaders });
    } catch (err: any) {
        console.error("[Questions API GET] Error:", err);
        return NextResponse.json({ error: err?.message || "Failed to read questions" }, { status: 500, headers: noCacheHeaders });
    }
}

// POST: Save or merge questions and/or sync prompts
export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({}));
        const { questions, action = "set", solvePrompt, transcribePrompt } = body;

        const current = ensureDataFile();
        let newQuestions = current.questions;

        if (Array.isArray(questions)) {
            if (action === "merge") {
                const map = new Map<string, ScannedQuestion>();
                current.questions.forEach(q => map.set(q.id, q));
                questions.forEach((q: ScannedQuestion) => {
                    map.set(q.id, { ...(map.get(q.id) || {}), ...q });
                });
                newQuestions = Array.from(map.values());
            } else {
                // "set" replaces the current list
                newQuestions = questions;
            }
        }

        const newSolvePrompt = (typeof solvePrompt === "string" && solvePrompt.trim().length > 0)
            ? solvePrompt
            : (current.solvePrompt || DEFAULT_SOLVE_PROMPT);

        const newTranscribePrompt = (typeof transcribePrompt === "string" && transcribePrompt.trim().length > 0)
            ? transcribePrompt
            : (current.transcribePrompt || DEFAULT_TRANSCRIBE_PROMPT);

        const updated: StorageData = {
            updatedAt: Date.now(),
            version: (current.version || 1) + 1,
            questions: newQuestions,
            solvePrompt: newSolvePrompt,
            transcribePrompt: newTranscribePrompt,
        };

        writeDataFile(updated);

        return NextResponse.json({
            success: true,
            updatedAt: updated.updatedAt,
            version: updated.version,
            questions: updated.questions,
            solvePrompt: updated.solvePrompt,
            transcribePrompt: updated.transcribePrompt,
        }, { headers: noCacheHeaders });
    } catch (err: any) {
        console.error("[Questions API POST] Error:", err);
        return NextResponse.json({ error: err?.message || "Failed to save questions" }, { status: 500, headers: noCacheHeaders });
    }
}

// DELETE: Clear all questions or delete by ID (preserves prompts)
export async function DELETE(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const idToDelete = searchParams.get("id");

        const current = ensureDataFile();
        let updatedQuestions: ScannedQuestion[] = [];

        if (idToDelete) {
            updatedQuestions = current.questions.filter(q => q.id !== idToDelete);
        } else {
            // Clear all questions
            updatedQuestions = [];
        }

        const updated: StorageData = {
            updatedAt: Date.now(),
            version: (current.version || 1) + 1,
            questions: updatedQuestions,
            solvePrompt: current.solvePrompt || DEFAULT_SOLVE_PROMPT,
            transcribePrompt: current.transcribePrompt || DEFAULT_TRANSCRIBE_PROMPT,
        };

        writeDataFile(updated);

        return NextResponse.json({
            success: true,
            cleared: !idToDelete,
            deletedId: idToDelete || null,
            updatedAt: updated.updatedAt,
            version: updated.version,
            questions: updated.questions,
            solvePrompt: updated.solvePrompt,
            transcribePrompt: updated.transcribePrompt,
        }, { headers: noCacheHeaders });
    } catch (err: any) {
        console.error("[Questions API DELETE] Error:", err);
        return NextResponse.json({ error: err?.message || "Failed to delete questions" }, { status: 500, headers: noCacheHeaders });
    }
}
