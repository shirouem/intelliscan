import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "https://mprqfblotnzfclogmbwv.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1wcnFmYmxvdG56ZmNsb2dtYnd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk4NzMwMTYsImV4cCI6MjA4NTQ0OTAxNn0.AfGoX6R-UtY6dYzAjXpDdUclfvX8hL8xooIKMBAOJDk";

const noCacheHeaders = {
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
};

export interface SyncedCapture {
    id: string;
    createdAt: number;
    type: "scan" | "solve";
    imageData: string;
    metadata?: Record<string, any>;
}

// ── Fallback Local File Storage ───────────────────────────────────────────────
function getFallbackFilePath(): string {
    const localDir = path.join(process.cwd(), "data");
    try {
        if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
        return path.join(localDir, "synced_captures.json");
    } catch {
        return path.join(os.tmpdir(), "synced_captures.json");
    }
}

function readLocalFallback(): SyncedCapture[] {
    const filePath = getFallbackFilePath();
    try {
        if (fs.existsSync(filePath)) {
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            if (Array.isArray(parsed)) return parsed;
        }
    } catch {}
    return [];
}

function writeLocalFallback(captures: SyncedCapture[]) {
    try {
        const filePath = getFallbackFilePath();
        fs.writeFileSync(filePath, JSON.stringify(captures, null, 2), "utf-8");
    } catch {}
}

// ── Cloud Database Store (Supabase REST) ──────────────────────────────────────
async function readCapturesFromCloud(limit = 60): Promise<SyncedCapture[] | null> {
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/intelliscan_captures?select=id,created_at,type,image_data,metadata&order=created_at.desc&limit=${limit}`, {
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
            },
            cache: "no-store",
        });
        if (!res.ok) return null;
        const rows = await res.json();
        if (!Array.isArray(rows)) return null;
        return rows.map((r: any) => ({
            id: r.id,
            createdAt: Number(r.created_at) || Date.now(),
            type: r.type === "solve" ? "solve" : "scan",
            imageData: r.image_data,
            metadata: r.metadata || {},
        }));
    } catch (e) {
        console.warn("[Cloud Captures] Read failed, using fallback:", e);
        return null;
    }
}

async function insertCaptureToCloud(capture: SyncedCapture): Promise<boolean> {
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/intelliscan_captures`, {
            method: "POST",
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                "Content-Type": "application/json",
                Prefer: "return=representation",
            },
            body: JSON.stringify({
                id: capture.id,
                created_at: capture.createdAt,
                type: capture.type,
                image_data: capture.imageData,
                metadata: capture.metadata || {},
            }),
        });
        return res.ok;
    } catch (e) {
        console.warn("[Cloud Captures] Insert failed, using fallback:", e);
        return false;
    }
}

async function deleteCaptureFromCloud(id?: string): Promise<boolean> {
    try {
        const url = id
            ? `${SUPABASE_URL}/rest/v1/intelliscan_captures?id=eq.${encodeURIComponent(id)}`
            : `${SUPABASE_URL}/rest/v1/intelliscan_captures?created_at=gt.0`;

        const res = await fetch(url, {
            method: "DELETE",
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
            },
        });
        return res.ok;
    } catch (e) {
        console.warn("[Cloud Captures] Delete failed, using fallback:", e);
        return false;
    }
}

// ── GET: Fetch synced captures ────────────────────────────────────────────────
export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const limit = Math.min(Number(searchParams.get("limit") || 60), 100);

        const cloudCaptures = await readCapturesFromCloud(limit);
        const captures = cloudCaptures !== null ? cloudCaptures : readLocalFallback();

        return NextResponse.json({
            captures,
            count: captures.length,
            updatedAt: captures[0]?.createdAt || Date.now(),
        }, { headers: noCacheHeaders });
    } catch (err: any) {
        console.error("[Captures API GET] Error:", err);
        return NextResponse.json({ error: err?.message || "Failed to fetch captures" }, { status: 500, headers: noCacheHeaders });
    }
}

// ── POST: Add a new capture and sync across devices ───────────────────────────
export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({}));
        const { id, type = "scan", imageData, metadata = {} } = body;

        if (!imageData || typeof imageData !== "string") {
            return NextResponse.json({ error: "Missing or invalid imageData" }, { status: 400, headers: noCacheHeaders });
        }

        const captureId = id || `cap_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const newCapture: SyncedCapture = {
            id: captureId,
            createdAt: Date.now(),
            type: type === "solve" ? "solve" : "scan",
            imageData,
            metadata,
        };

        // Write to local fallback
        const local = readLocalFallback();
        const updatedLocal = [newCapture, ...local.filter(c => c.id !== captureId)].slice(0, 100);
        writeLocalFallback(updatedLocal);

        // Sync to cloud
        await insertCaptureToCloud(newCapture);

        return NextResponse.json({
            success: true,
            capture: newCapture,
        }, { headers: noCacheHeaders });
    } catch (err: any) {
        console.error("[Captures API POST] Error:", err);
        return NextResponse.json({ error: err?.message || "Failed to save capture" }, { status: 500, headers: noCacheHeaders });
    }
}

// ── DELETE: Delete an individual capture or clear all captures ────────────────
export async function DELETE(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const idToDelete = searchParams.get("id");

        // Update local fallback
        const local = readLocalFallback();
        const updatedLocal = idToDelete ? local.filter(c => c.id !== idToDelete) : [];
        writeLocalFallback(updatedLocal);

        // Delete from cloud
        await deleteCaptureFromCloud(idToDelete || undefined);

        return NextResponse.json({
            success: true,
            cleared: !idToDelete,
            deletedId: idToDelete || null,
        }, { headers: noCacheHeaders });
    } catch (err: any) {
        console.error("[Captures API DELETE] Error:", err);
        return NextResponse.json({ error: err?.message || "Failed to delete capture(s)" }, { status: 500, headers: noCacheHeaders });
    }
}
