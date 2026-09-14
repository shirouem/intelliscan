import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE_PATH = path.join(DATA_DIR, "scanned_questions.json");

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
}

function ensureDataFile(): StorageData {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(FILE_PATH)) {
        const initial: StorageData = { updatedAt: Date.now(), version: 1, questions: [] };
        fs.writeFileSync(FILE_PATH, JSON.stringify(initial, null, 2), "utf-8");
        return initial;
    }
    try {
        const content = fs.readFileSync(FILE_PATH, "utf-8");
        return JSON.parse(content) as StorageData;
    } catch {
        const fallback: StorageData = { updatedAt: Date.now(), version: 1, questions: [] };
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

// GET: Fetch questions and sync status
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
            });
        }

        return NextResponse.json({
            changed: true,
            updatedAt: data.updatedAt,
            version: data.version,
            questions: data.questions,
        });
    } catch (err: any) {
        console.error("[Questions API GET] Error:", err);
        return NextResponse.json({ error: err?.message || "Failed to read questions" }, { status: 500 });
    }
}

// POST: Save or merge solved questions
export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({}));
        const { questions, action = "set" } = body;

        if (!Array.isArray(questions)) {
            return NextResponse.json({ error: "Questions array required" }, { status: 400 });
        }

        const current = ensureDataFile();
        let newQuestions: ScannedQuestion[] = [];

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

        const updated: StorageData = {
            updatedAt: Date.now(),
            version: (current.version || 1) + 1,
            questions: newQuestions,
        };

        writeDataFile(updated);

        return NextResponse.json({
            success: true,
            updatedAt: updated.updatedAt,
            version: updated.version,
            questions: updated.questions,
        });
    } catch (err: any) {
        console.error("[Questions API POST] Error:", err);
        return NextResponse.json({ error: err?.message || "Failed to save questions" }, { status: 500 });
    }
}

// DELETE: Clear all questions or delete by ID
export async function DELETE(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const idToDelete = searchParams.get("id");

        const current = ensureDataFile();
        let updatedQuestions: ScannedQuestion[] = [];

        if (idToDelete) {
            updatedQuestions = current.questions.filter(q => q.id !== idToDelete);
        } else {
            // Clear all
            updatedQuestions = [];
        }

        const updated: StorageData = {
            updatedAt: Date.now(),
            version: (current.version || 1) + 1,
            questions: updatedQuestions,
        };

        writeDataFile(updated);

        return NextResponse.json({
            success: true,
            cleared: !idToDelete,
            deletedId: idToDelete || null,
            updatedAt: updated.updatedAt,
            version: updated.version,
            questions: updated.questions,
        });
    } catch (err: any) {
        console.error("[Questions API DELETE] Error:", err);
        return NextResponse.json({ error: err?.message || "Failed to delete questions" }, { status: 500 });
    }
}
