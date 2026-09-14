import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { DEFAULT_SOLVE_PROMPT, DEFAULT_TRANSCRIBE_PROMPT } from "@/app/constants/prompts";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "https://mprqfblotnzfclogmbwv.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1wcnFmYmxvdG56ZmNsb2dtYnd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk4NzMwMTYsImV4cCI6MjA4NTQ0OTAxNn0.AfGoX6R-UtY6dYzAjXpDdUclfvX8hL8xooIKMBAOJDk";

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

// ── Cloud Database Store (Supabase REST) ──────────────────────────────────────
async function readFromCloud(): Promise<StorageData | null> {
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/intelliscan_sync?id=eq.current`, {
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
            },
            cache: "no-store",
        });
        if (!res.ok) return null;
        const rows = await res.json();
        if (!Array.isArray(rows) || rows.length === 0) return null;
        const row = rows[0];
        return {
            updatedAt: Number(row.updated_at) || Date.now(),
            version: Number(row.version) || 1,
            questions: Array.isArray(row.questions) ? row.questions : [],
            solvePrompt: row.solve_prompt || DEFAULT_SOLVE_PROMPT,
            transcribePrompt: row.transcribe_prompt || DEFAULT_TRANSCRIBE_PROMPT,
        };
    } catch (e) {
        console.warn("[Cloud Storage] Read failed, using fallback:", e);
        return null;
    }
}

async function writeToCloud(data: StorageData): Promise<boolean> {
    try {
        const payload = {
            updated_at: data.updatedAt,
            version: data.version,
            questions: data.questions,
            solve_prompt: data.solvePrompt || DEFAULT_SOLVE_PROMPT,
            transcribe_prompt: data.transcribePrompt || DEFAULT_TRANSCRIBE_PROMPT,
        };
        const res = await fetch(`${SUPABASE_URL}/rest/v1/intelliscan_sync?id=eq.current`, {
            method: "PATCH",
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                "Content-Type": "application/json",
                Prefer: "return=representation",
            },
            body: JSON.stringify(payload),
        });
        return res.ok;
    } catch (e) {
        console.warn("[Cloud Storage] Write failed, using fallback:", e);
        return false;
    }
}

// ── Fallback Local File Storage ───────────────────────────────────────────────
function getFallbackFilePath(): string {
    const localDir = path.join(process.cwd(), "data");
    try {
        if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
        return path.join(localDir, "scanned_questions.json");
    } catch {
        return path.join(os.tmpdir(), "scanned_questions.json");
    }
}

function readLocalFallback(): StorageData {
    const filePath = getFallbackFilePath();
    try {
        if (fs.existsSync(filePath)) {
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            return {
                updatedAt: parsed.updatedAt || Date.now(),
                version: parsed.version || 1,
                questions: Array.isArray(parsed.questions) ? parsed.questions : [],
                solvePrompt: parsed.solvePrompt || DEFAULT_SOLVE_PROMPT,
                transcribePrompt: parsed.transcribePrompt || DEFAULT_TRANSCRIBE_PROMPT,
            };
        }
    } catch {}
    return {
        updatedAt: Date.now(),
        version: 1,
        questions: [],
        solvePrompt: DEFAULT_SOLVE_PROMPT,
        transcribePrompt: DEFAULT_TRANSCRIBE_PROMPT,
    };
}

function writeLocalFallback(data: StorageData) {
    try {
        const filePath = getFallbackFilePath();
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch {}
}

// ── Unified Storage Interface ─────────────────────────────────────────────────
async function getStorageData(): Promise<StorageData> {
    const cloudData = await readFromCloud();
    if (cloudData) return cloudData;
    return readLocalFallback();
}

async function saveStorageData(data: StorageData): Promise<void> {
    writeLocalFallback(data);
    await writeToCloud(data);
}

// ── GET: Fetch questions and sync status ───────────────────────────────────────
export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const since = Number(searchParams.get("since") || 0);

        const data = await getStorageData();

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

// ── POST: Save or merge questions and sync prompts ────────────────────────────
export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({}));
        const { questions, action = "set", solvePrompt, transcribePrompt } = body;

        const current = await getStorageData();
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

        await saveStorageData(updated);

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

// ── DELETE: Clear all questions or delete by ID ───────────────────────────────
export async function DELETE(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const idToDelete = searchParams.get("id");

        const current = await getStorageData();
        let updatedQuestions: ScannedQuestion[] = [];

        if (idToDelete) {
            updatedQuestions = current.questions.filter(q => q.id !== idToDelete);
        } else {
            updatedQuestions = [];
        }

        const updated: StorageData = {
            updatedAt: Date.now(),
            version: (current.version || 1) + 1,
            questions: updatedQuestions,
            solvePrompt: current.solvePrompt || DEFAULT_SOLVE_PROMPT,
            transcribePrompt: current.transcribePrompt || DEFAULT_TRANSCRIBE_PROMPT,
        };

        await saveStorageData(updated);

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
