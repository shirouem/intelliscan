"use client";

import React, { useRef, useState, useCallback, useEffect } from "react";
import "./ScannerApp.css";
import { DEFAULT_SOLVE_PROMPT } from "@/app/constants/prompts";

// ─── Types ────────────────────────────────────────────────────────────────────
interface ScannedQuestion {
    id: string;
    questionNumber: string;
    text: string;
    solution?: string;
    isSolving?: boolean;
    transcript?: string;
    audioDataUrl?: string | null;
    questionIntro?: string;
    isTranscribing?: boolean;
}

type ImageSolveProvider = "deepseek" | "gemini";

type ImageSolveStatusData = {
    jobId?: string;
    status?: string;
    error?: string;
    answer?: string;
    primaryAnswer?: string;
    primaryScreenshot?: string | null;
    primaryError?: string | null;
    browserError?: string | null;
    backupAnswer?: string | null;
    backupScreenshot?: string | null;
    backupStatus?: "idle" | "queued" | "solving" | "done" | "error";
    backupProvider?: ImageSolveProvider | string | null;
    backupError?: string | null;
    provider?: ImageSolveProvider | "gemini-api" | string | null;
    source?: string | null;
    fallbackRequired?: boolean;
};

type StoredImageSolveItem = {
    jobId: string;
    id: string; // fallback mapped to jobId
    createdAt: string;
    image: string; // mapped to URL
    status: "capturing" | "solving" | "done" | "error" | "superseded" | "primary_done" | "fallback_solving" | "backup_solving";
    primaryProvider: string;
    source: "camera" | "upload" | "browser";
    prompt?: string;
    answer?: string | null;
    screenshot?: string | null;
    answerProvider?: string | null;
    backupAnswer?: string | null;
    backupScreenshot?: string | null;
    backupStatus?: "idle" | "queued" | "solving" | "done" | "error";
    backupProvider?: string | null;
    backupError?: string | null;
    browserError?: string | null;
    error?: string | null;
    flipClipboard?: boolean;
};

type CaptureFrameOptions = {
    mimeType: "image/png" | "image/jpeg";
    quality: number;
    minQuality: number;
    maxWidth: number;
    maxHeight: number;
    maxDataUrlLength: number;
    mirrorHorizontal?: boolean;
};

// ─── Provider Catalog ─────────────────────────────────────────────────────────
const ALL_SOLVE_PROVIDERS: { id: string; label: string }[] = [
    { id: "deepseek", label: "DeepSeek" },
    { id: "gemini", label: "Gemini" },
];

// ─── Capture options ──────────────────────────────────────────────────────────
const scanCaptureOptions: CaptureFrameOptions = {
    mimeType: "image/jpeg",
    quality: 0.82,
    minQuality: 0.55,
    maxWidth: 1280,
    maxHeight: 1280,
    maxDataUrlLength: 800_000,
};

const imageSolveCaptureOptions: CaptureFrameOptions = {
    mimeType: "image/jpeg",
    quality: 0.82,
    minQuality: 0.55,
    maxWidth: 1280,
    maxHeight: 1280,
    maxDataUrlLength: 800_000,
    mirrorHorizontal: true,
};

// ─── Utility helpers ──────────────────────────────────────────────────────────
const getErrorMessage = (error: unknown, fallback = "Image solve failed.") => {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return fallback;
};

const isImageDataUrl = (value: string) =>
    /^data:image\/[a-zA-Z0-9.+-]+(?:;[^,]*)?;base64,[A-Za-z0-9+/=\s]+$/.test(value);

const dataUrlByteSize = (dataUrl: string) => {
    const base64 = dataUrl.split(",", 2)[1] || "";
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
};

const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

interface SyncedCapture {
    id: string;
    createdAt: number;
    type: "scan" | "solve";
    imageData: string;
    metadata?: Record<string, any>;
}

const getProviderLabel = (provider: string | null | undefined) => {
    if (provider === "deepseek") return "DeepSeek";
    if (provider === "gemini") return "Gemini";
    if (provider === "gemini-api") return "Gemini API";
    return "Image Solve";
};

const normalizeImageSolveProvider = (provider: string | null | undefined): ImageSolveProvider | null =>
    provider === "deepseek" || provider === "gemini" ? provider : null;

const readImageSolveResponse = async (response: Response): Promise<ImageSolveStatusData> => {
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();

    if (!text.trim()) return {};

    try {
        return JSON.parse(text) as ImageSolveStatusData;
    } catch {
        const preview = text.replace(/\s+/g, " ").trim().slice(0, 240);
        const responseLabel = `${response.status} ${response.statusText}`.trim();
        return {
            error: `Image solve returned ${responseLabel || "a non-JSON response"}${contentType ? ` (${contentType})` : ""}${preview ? `: ${preview}` : "."}`,
        };
    }
};

/**
 * Resilient solution key matcher that handles any AI formatting:
 * e.g. "q1", "1", "question1", "Question 1", or positional array index.
 */
function findSolutionForQuestion(q: ScannedQuestion, idx: number, solutionsMap: Record<string, any>): string | null {
    if (!solutionsMap || typeof solutionsMap !== "object") return null;

    // Handle array of solutions
    if (Array.isArray(solutionsMap)) {
        if (solutionsMap[idx] && typeof solutionsMap[idx] === "string") {
            return String(solutionsMap[idx]);
        }
        if (solutionsMap[idx] && typeof solutionsMap[idx] === "object" && solutionsMap[idx].solution) {
            return String(solutionsMap[idx].solution);
        }
    }

    // 1. Exact ID match
    if (solutionsMap[q.id]) return String(solutionsMap[q.id]);

    // 2. Question number match (e.g. "1", "2")
    const qNum = q.questionNumber || String(idx + 1);
    if (solutionsMap[qNum]) return String(solutionsMap[qNum]);

    // 3. Normalized key variants: "q1", "q_1", "question1", "question 1"
    const candidates = [
        `q${qNum}`,
        `q_${qNum}`,
        `q-${qNum}`,
        `question${qNum}`,
        `question_${qNum}`,
        `question ${qNum}`,
        `Question ${qNum}`,
        `Question_${qNum}`,
        qNum,
        String(idx + 1),
        String(idx)
    ];
    for (const key of candidates) {
        if (solutionsMap[key]) return String(solutionsMap[key]);
    }

    // 4. Normalized key match (removing non-alphanumerics)
    const targetNorm = q.id.toLowerCase().replace(/[^a-z0-9]/g, '');
    const numNorm = `q${qNum}`.toLowerCase();
    for (const k of Object.keys(solutionsMap)) {
        const kNorm = k.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (kNorm === targetNorm || kNorm === numNorm || kNorm === qNum) {
            return String(solutionsMap[k]);
        }
    }

    // 5. Positional fallback: use by array index if available
    const values = Object.values(solutionsMap);
    if (values[idx] && typeof values[idx] === "string") {
        return String(values[idx]);
    }

    return null;
}

function extractBalancedBraces(str: string, startIndex: number): { content: string; endIndex: number } | null {
    if (str[startIndex] !== '{') return null;
    let depth = 0;
    for (let i = startIndex; i < str.length; i++) {
        if (str[i] === '{') depth++;
        else if (str[i] === '}') {
            depth--;
            if (depth === 0) {
                return { content: str.substring(startIndex + 1, i), endIndex: i };
            }
        }
    }
    return null;
}

function replaceFractions(str: string): string {
    let result = str;
    let idx = result.indexOf("\\frac");
    let safety = 0;
    while (idx !== -1 && safety++ < 50) {
        let cursor = idx + 5;
        while (cursor < result.length && /\s/.test(result[cursor])) cursor++;
        const numData = extractBalancedBraces(result, cursor);
        if (!numData) {
            idx = result.indexOf("\\frac", idx + 5);
            continue;
        }
        cursor = numData.endIndex + 1;
        while (cursor < result.length && /\s/.test(result[cursor])) cursor++;
        const denData = extractBalancedBraces(result, cursor);
        if (!denData) {
            idx = result.indexOf("\\frac", idx + 5);
            continue;
        }

        const num = replaceFractions(numData.content.trim());
        const den = replaceFractions(denData.content.trim());
        const replacement = `(${num}) / (${den})`;
        result = result.substring(0, idx) + replacement + result.substring(denData.endIndex + 1);
        idx = result.indexOf("\\frac");
    }
    return result;
}

/**
 * Transforms raw LaTeX and technical notation for CBSE Class 12 Mathematics,
 * Physics & Chemistry into clean, readable typography.
 */
function cleanMathAndPhysicsText(raw: string): string {
    if (!raw) return "";

    let text = raw;

    // 1. Normalize LaTeX delimiters ($$, $, \[, \], \(, \))
    text = text.replace(/\$\$([\s\S]*?)\$\$/g, "$1");
    text = text.replace(/\\\[([\s\S]*?)\\\]/g, "$1");
    text = text.replace(/\$([^\$]+)\$/g, "$1");
    text = text.replace(/\\\(([^\)]+)\\\)/g, "$1");

    // 2. Remove LaTeX text wrappers: \text{...}, \mathrm{...}, \mathbf{...}, \operatorname{...}
    text = text.replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\{([^}]+)\}/g, "$1");

    // 3. Remove LaTeX spacing: \, \; \! \quad \qquad
    text = text.replace(/\\(?:quad|qquad|!)/g, " ");
    text = text.replace(/\\([,;])/g, " ");

    // 4. Remove \left and \right delimiters
    text = text.replace(/\\left\s*([(\[{|.\\])/g, "$1");
    text = text.replace(/\\right\s*([)\]}|.\\])/g, "$1");
    text = text.replace(/\\left\b/g, "");
    text = text.replace(/\\right\b/g, "");

    // 5. Replace \frac{a}{b} with balanced brace parsing
    text = replaceFractions(text);

    // 6. Matrix & Determinant environments
    text = text.replace(/\\begin\{(?:bmatrix|pmatrix|matrix)\}([\s\S]*?)\\end\{(?:bmatrix|pmatrix|matrix)\}/g, (_match, body) => {
        const rows = body.trim().split(/\\\\|\n/).map((row: string) => row.trim().replace(/&/g, "  ")).filter(Boolean);
        return `[ ${rows.join("  |  ")} ]`;
    });
    text = text.replace(/\\begin\{vmatrix\}([\s\S]*?)\\end\{vmatrix\}/g, (_match, body) => {
        const rows = body.trim().split(/\\\\|\n/).map((row: string) => row.trim().replace(/&/g, "  ")).filter(Boolean);
        return `| ${rows.join("  |  ")} |`;
    });

    // 7. Square roots: \sqrt{x} -> √(x), \sqrt[n]{x} -> ⁿ√(x)
    text = text.replace(/\\sqrt\[(\d+)\]\{([^}]+)\}/g, "$1√($2)");
    text = text.replace(/\\sqrt\{([^}]+)\}/g, "√($1)");
    text = text.replace(/\bsqrt\(([^)]+)\)/g, "√($1)");

    // 8. Inverse trig functions
    text = text.replace(/\\?(?:sin)\s*\^?\s*\{?-1\}?/gi, "sin⁻¹");
    text = text.replace(/\\?(?:cos)\s*\^?\s*\{?-1\}?/gi, "cos⁻¹");
    text = text.replace(/\\?(?:tan)\s*\^?\s*\{?-1\}?/gi, "tan⁻¹");
    text = text.replace(/\\?(?:cot)\s*\^?\s*\{?-1\}?/gi, "cot⁻¹");
    text = text.replace(/\\?(?:sec)\s*\^?\s*\{?-1\}?/gi, "sec⁻¹");
    text = text.replace(/\\?(?:csc|cosec)\s*\^?\s*\{?-1\}?/gi, "cosec⁻¹");

    // 9. Standard trig, log, and exp
    text = text.replace(/\\(sin|cos|tan|cot|sec|csc|cosec|ln|log|exp)\b/g, "$1");

    // 10. Limits & Integrals
    text = text.replace(/\\lim_\{([^}]+)\}/g, "lim ($1)");
    text = text.replace(/\\lim\b/g, "lim");
    text = text.replace(/\\int_\{([^}]+)\}\^\{([^}]+)\}/g, "∫_($1)^($2) ");
    text = text.replace(/\\int_([a-zA-Z0-9]+)\^([a-zA-Z0-9]+)/g, "∫_($1)^($2) ");
    text = text.replace(/\\iint\b/g, "∬");
    text = text.replace(/\\oint\b/g, "∮");
    text = text.replace(/\\int\b/g, "∫");
    text = text.replace(/\bint\b/g, "∫");
    text = text.replace(/\\partial\b/g, "∂");
    text = text.replace(/\\nabla\b/g, "∇");

    // 11. Vectors & Unit vectors
    text = text.replace(/\\vec\{([a-zA-Z]+)\}/g, "$1⃗");
    text = text.replace(/vec\(([a-zA-Z]+)\)/g, "$1⃗");
    text = text.replace(/\\hat\{i\}|\bi_hat\b/g, "î");
    text = text.replace(/\\hat\{j\}|\bj_hat\b/g, "ĵ");
    text = text.replace(/\\hat\{k\}|\bk_hat\b/g, "k̂");
    text = text.replace(/\\hat\{n\}|\bn_hat\b/g, "n̂");
    text = text.replace(/\\hat\{r\}|\br_hat\b/g, "r̂");
    text = text.replace(/\\hat\{([a-zA-Z]+)\}/g, "$1̂");
    text = text.replace(/\\cdot\b/g, " · ");
    text = text.replace(/\\times\b/g, " × ");

    // 12. Matrices & Determinants
    text = text.replace(/\\det\b/g, "det");
    text = text.replace(/\\operatorname\{adj\}|\\adj\b/g, "adj");
    text = text.replace(/\b([A-Z])\^\{-?1\}/g, "$1⁻¹");
    text = text.replace(/\b([A-Z])\^-1\b/g, "$1⁻¹");
    text = text.replace(/\b([A-Z])\^\{?T\}?\b/g, "$1ᵀ");

    // 13. Sets, Relations & Logic
    text = text.replace(/\\in\b/g, "∈");
    text = text.replace(/\\notin\b/g, "∉");
    text = text.replace(/\\subset\b/g, "⊂");
    text = text.replace(/\\subseteq\b/g, "⊆");
    text = text.replace(/\\cup\b/g, "∪");
    text = text.replace(/\\cap\b/g, "∩");
    text = text.replace(/\\emptyset\b|\\phi\b/g, "∅");
    text = text.replace(/\\forall\b/g, "∀");
    text = text.replace(/\\exists\b/g, "∃");

    // 14. Arrows and Implication
    text = text.replace(/\\implies\b/g, "⇒");
    text = text.replace(/==>/g, "⇒");
    text = text.replace(/=>/g, "⇒");
    text = text.replace(/\\iff\b/g, "⇔");
    text = text.replace(/<=>/g, "⇔");
    text = text.replace(/\\to\b/g, "→");
    text = text.replace(/-->/g, "→");
    text = text.replace(/->/g, "→");

    // 15. Common Math & Physics constants & symbols
    text = text.replace(/\\therefore\b/g, "∴");
    text = text.replace(/\\because\b/g, "∵");
    text = text.replace(/\\pm\b/g, "±");
    text = text.replace(/\+-/g, "±");
    text = text.replace(/\\mp\b/g, "∓");
    text = text.replace(/\\le\b|\\leq\b|<=/g, "≤");
    text = text.replace(/\\ge\b|\\geq\b|>=/g, "≥");
    text = text.replace(/\\neq\b|!=/g, "≠");
    text = text.replace(/\\approx\b|~=/g, "≈");
    text = text.replace(/\\equiv\b/g, "≡");
    text = text.replace(/\\infty\b/g, "∞");
    text = text.replace(/\\sum\b/g, "∑");
    text = text.replace(/\\prod\b/g, "∏");
    text = text.replace(/\\circ\b|\^\\circ/g, "°");
    text = text.replace(/\\angle\b/g, "∠");
    text = text.replace(/\\perp\b/g, "⊥");
    text = text.replace(/\\parallel\b/g, "∥");

    // 16. Greek letters
    text = text.replace(/\\alpha\b/g, "α");
    text = text.replace(/\\beta\b/g, "β");
    text = text.replace(/\\gamma\b/g, "γ");
    text = text.replace(/\\theta\b/g, "θ");
    text = text.replace(/\\lambda\b/g, "λ");
    text = text.replace(/\\mu_0\b/g, "μ₀");
    text = text.replace(/\\mu\b/g, "μ");
    text = text.replace(/\\pi\b/g, "π");
    text = text.replace(/\\rho\b/g, "ρ");
    text = text.replace(/\\sigma\b/g, "σ");
    text = text.replace(/\\tau\b/g, "τ");
    text = text.replace(/\\phi\b/g, "φ");
    text = text.replace(/\\omega\b/g, "ω");
    text = text.replace(/\\Delta\b/g, "Δ");
    text = text.replace(/\b(?:eps_0|epsilon_0)\b|\\epsilon_0\b/g, "ε₀");
    text = text.replace(/\\epsilon\b/g, "ε");

    // 17. Exponents and subscripts
    text = text.replace(/\^\{([^}]+)\}/g, "^($1)");
    text = text.replace(/_\{([^}]+)\}/g, "_($1)");

    return text;
}

/**
 * Parses inline formatting: superscripts, subscripts, vectors, Greek symbols, bold, and code.
 */
function renderInlineFormattedText(text: string): React.ReactNode {
    if (!text) return null;

    const processed = cleanMathAndPhysicsText(text);
    const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`|\^(?:\([^)]+\)|[a-zA-Z0-9+-]+)|_(?:\([^)]+\)|[a-zA-Z0-9+-]+)|\*[^*]+\*)/g;
    const parts = processed.split(tokenRegex);

    return parts.map((part, i) => {
        if (!part) return null;
        if (part.startsWith("**") && part.endsWith("**")) {
            return <strong key={i} className="solution-bold">{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith("`") && part.endsWith("`")) {
            return <code key={i} className="solution-code">{part.slice(1, -1)}</code>;
        }
        if (part.startsWith("^") && !part.startsWith("*")) {
            let exp = part.slice(1);
            if (exp.startsWith("(") && exp.endsWith(")")) exp = exp.slice(1, -1);
            return <sup key={i}>{exp}</sup>;
        }
        if (part.startsWith("_") && !part.startsWith("*")) {
            let sub = part.slice(1);
            if (sub.startsWith("(") && sub.endsWith(")")) sub = sub.slice(1, -1);
            return <sub key={i}>{sub}</sub>;
        }
        if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
            return <em key={i} className="solution-italic">{part.slice(1, -1)}</em>;
        }
        return <React.Fragment key={i}>{part}</React.Fragment>;
    });
}

interface ParsedSection {
    type: "given" | "formula" | "steps" | "final" | "general";
    title: string;
    lines: string[];
}

function parseSolutionSections(solutionText: string): ParsedSection[] {
    if (!solutionText) return [];

    const lines = solutionText.split("\n");
    const sections: ParsedSection[] = [];
    let currentSection: ParsedSection = { type: "general", title: "", lines: [] };

    const finalizeSection = () => {
        if (currentSection.lines.some(l => l.trim().length > 0)) {
            sections.push(currentSection);
        }
    };

    lines.forEach(rawLine => {
        const line = rawLine.trim();
        if (!line) {
            if (currentSection.lines.length > 0 && currentSection.lines[currentSection.lines.length - 1] !== "") {
                currentSection.lines.push("");
            }
            return;
        }

        const givenHeader = /^(?:\*{1,2}|#{1,4}\s*)?(?:Given|Given\s*Data|Known|To\s*Prove|To\s*Find|Problem\s*Statement)\s*:?(?:\*{1,2})?:?\s*(.*)$/i.exec(line);
        const formulaHeader = /^(?:\*{1,2}|#{1,4}\s*)?(?:Formula|Key\s*Formula|Governing\s*Formula|Principle|Law|Theorem|Identit(?:y|ies)|Propert(?:y|ies)\s*Used)\s*:?(?:\*{1,2})?:?\s*(.*)$/i.exec(line);
        const stepsHeader = /^(?:\*{1,2}|#{1,4}\s*)?(?:Calculation|Substitution|Steps?|Step-by-step|Working|Proof|Solution|Derivation)\s*:?(?:\*{1,2})?:?\s*(.*)$/i.exec(line);
        const finalHeader = /^(?:\*{1,2}|#{1,4}\s*)?(?:Final\s*Answer|Final\s*Result|Answer|Ans|Hence\s*Proved|Conclusion|Result)\s*:?(?:\*{1,2})?:?\s*(.*)$/i.exec(line);

        if (finalHeader) {
            finalizeSection();
            const title = /hence\s*proved/i.test(line) ? "🎯 Hence Proved / Conclusion" : "🎯 Final Answer";
            currentSection = { type: "final", title, lines: [] };
            if (finalHeader[1] && finalHeader[1].trim()) {
                currentSection.lines.push(finalHeader[1].trim());
            }
        } else if (formulaHeader) {
            finalizeSection();
            currentSection = { type: "formula", title: "📐 Formula & Identities", lines: [] };
            if (formulaHeader[1] && formulaHeader[1].trim()) {
                currentSection.lines.push(formulaHeader[1].trim());
            }
        } else if (givenHeader) {
            finalizeSection();
            const title = /to\s*prove/i.test(line) ? "📋 Given & To Prove" : "📋 Given Parameters";
            currentSection = { type: "given", title, lines: [] };
            if (givenHeader[1] && givenHeader[1].trim()) {
                currentSection.lines.push(givenHeader[1].trim());
            }
        } else if (stepsHeader) {
            finalizeSection();
            const title = /proof/i.test(line) ? "🔢 Step-by-Step Proof" : "🔢 Step-by-Step Working";
            currentSection = { type: "steps", title, lines: [] };
            if (stepsHeader[1] && stepsHeader[1].trim()) {
                currentSection.lines.push(stepsHeader[1].trim());
            }
        } else {
            currentSection.lines.push(line);
        }
    });

    finalizeSection();
    return sections;
}

function renderSectionLines(lines: string[], type: string): React.ReactNode[] {
    const elements: React.ReactNode[] = [];
    let listBuffer: string[] = [];

    const flushList = (keyPrefix: string) => {
        if (listBuffer.length > 0) {
            elements.push(
                <ul key={`${keyPrefix}-list`} className="solution-list">
                    {listBuffer.map((item, lIdx) => (
                        <li key={lIdx} className="solution-list-item">
                            {renderInlineFormattedText(item)}
                        </li>
                    ))}
                </ul>
            );
            listBuffer = [];
        }
    };

    lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed) {
            flushList(`fl-${idx}`);
            return;
        }

        const bulletMatch = /^(?:[-*•]|\d+\.)\s+(.*)/.exec(trimmed);
        if (bulletMatch) {
            listBuffer.push(bulletMatch[1]);
            return;
        }

        flushList(`fl-pre-${idx}`);

        const isEquation = type === "formula" ||
            /^(?:vec\([a-zA-Z]+\)|[a-zA-Z]\s*=|dy\/dx\b|d\^?2y\/dx\^?2|∫|lim\b|LHS\b|RHS\b|det\b|adj\b|P\([A-Z]|\b[A-Z]_[a-z0-9]+\s*=|⇒|∴|∵|\b[a-zA-Z]\s*[=<>≤≥]\s*)/i.test(trimmed) ||
            (trimmed.includes("=") && trimmed.length < 90 && !trimmed.endsWith(":") && !trimmed.startsWith("Step"));

        if (isEquation) {
            elements.push(
                <div key={`eq-${idx}`} className="solution-equation-line">
                    {renderInlineFormattedText(trimmed)}
                </div>
            );
            return;
        }

        elements.push(
            <p key={`p-${idx}`} className="solution-paragraph">
                {renderInlineFormattedText(trimmed)}
            </p>
        );
    });

    flushList("fl-end");
    return elements;
}

/**
 * Renders technical and CBSE Class 12 Physics & Chemistry solutions with structured visual hierarchy
 */
function renderFormattedSolution(solutionText?: string) {
    if (!solutionText) return null;

    const sections = parseSolutionSections(solutionText);

    return (
        <div className="formatted-solution-container">
            {sections.map((sec, sIdx) => {
                let boxClass = "general-box";
                if (sec.type === "final") boxClass = "final-answer-box";
                else if (sec.type === "formula") boxClass = "formula-box";
                else if (sec.type === "given") boxClass = "given-box";
                else if (sec.type === "steps") boxClass = "steps-box";

                return (
                    <div key={`sec-${sIdx}`} className={`solution-section ${boxClass}`}>
                        {sec.title && <span className={`section-tag ${sec.type}-tag`}>{sec.title}</span>}
                        <div className={`section-content ${sec.type}-content`}>
                            {renderSectionLines(sec.lines, sec.type)}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function ScannerApp() {
    // ── Refs ──────────────────────────────────────────────────────────────────
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null!);
    const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
    const imageSolveRunIdRef = useRef(0);
    const cameraRunIdRef = useRef(0);
    const providerDragIndexRef = useRef<number | null>(null);
    const pollingCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const darknessStartTimeRef = useRef<number | null>(null);
    const abortedDueToLongDarknessRef = useRef<boolean>(false);
    const countdownTriggeredByDarknessRef = useRef<boolean>(false);
    const lightTicksRef = useRef<number>(0);

    // ── Scan mode ─────────────────────────────────────────────────────────────
    const [isCapturing, setIsCapturing] = useState(false);
    const [savedQuestions, setSavedQuestions] = useState<ScannedQuestion[]>([]);
    const [selectedQuestionIds, setSelectedQuestionIds] = useState<Set<string>>(new Set());
    const [isProcessingSolutions, setIsProcessingSolutions] = useState(false);
    const [expandedSolutionIds, setExpandedSolutionIds] = useState<Set<string>>(new Set());
    const [activeTab, setActiveTab] = useState<"all" | "unsolved" | "solved">("all");
    const [bottomTab, setBottomTab] = useState<"questions" | "captures" | "imagesolve">("questions");

    // ── Synced Captures State ──────────────────────────────────────────────────
    const [syncedCaptures, setSyncedCaptures] = useState<SyncedCapture[]>([]);
    const [capturesLoading, setCapturesLoading] = useState(false);
    const [capturesSyncStatus, setCapturesSyncStatus] = useState<"synced" | "syncing" | "offline">("synced");
    const [activeCaptureModal, setActiveCaptureModal] = useState<SyncedCapture | null>(null);
    const [capturesFilter, setCapturesFilter] = useState<"all" | "scan" | "solve">("all");

    // ── WhatsApp & Settings ───────────────────────────────────────────────────
    const [sendToWhatsApp, setSendToWhatsApp] = useState<boolean>(true);
    const defaultSolvePrompt = DEFAULT_SOLVE_PROMPT;
    const [customSolvePrompt, setCustomSolvePrompt] = useState(DEFAULT_SOLVE_PROMPT);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

    // ── Edit mode ─────────────────────────────────────────────────────────────
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingText, setEditingText] = useState("");

    const [scanStatus, setScanStatus] = useState<"idle" | "scanning" | "success" | "error">("idle");
    const [errorMessage, setErrorMessage] = useState("");
    const [countdown, setCountdown] = useState<number | null>(null);
    const [captureDelay, setCaptureDelay] = useState(10);
    const [darknessDuration, setDarknessDuration] = useState<number>(0);
    const [darknessStatus, setDarknessStatus] = useState<"idle" | "covering" | "countdown" | "aborted">("idle");
    const [darknessAbortMessage, setDarknessAbortMessage] = useState<string | null>(null);

    const savedQuestionsRef = useRef<ScannedQuestion[]>([]);
    savedQuestionsRef.current = savedQuestions;

    // ── Multi-Device Sync & Solved UX States ──────────────────────────────────
    const lastServerUpdatedAtRef = useRef<number | null>(null);
    const isSettingsOpenRef = useRef(isSettingsOpen);
    isSettingsOpenRef.current = isSettingsOpen;
    const [syncStatus, setSyncStatus] = useState<"synced" | "syncing" | "offline">("synced");
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [copiedAll, setCopiedAll] = useState<boolean>(false);
    const questionCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

    // ── Image Solve mode ──────────────────────────────────────────────────────
    const [imageSolveMode, setImageSolveMode] = useState(false);
    const [imageSolveJobId, setImageSolveJobId] = useState<string | null>(null);
    const [imageSolveStatus, setImageSolveStatus] = useState<"idle" | "capturing" | "solving" | "done" | "error">("idle");
    const [imageSolveAnswer, setImageSolveAnswer] = useState<string | null>(null);
    const [imageSolveScreenshot, setImageSolveScreenshot] = useState<string | null>(null);
    const [imageSolveBackupAnswer, setImageSolveBackupAnswer] = useState<string | null>(null);
    const [imageSolveBackupScreenshot, setImageSolveBackupScreenshot] = useState<string | null>(null);
    const [imageSolveBackupStatus, setImageSolveBackupStatus] = useState<"idle" | "queued" | "solving" | "done" | "error">("idle");
    const [imageSolveBackupError, setImageSolveBackupError] = useState<string | null>(null);
    const [imageSolveError, setImageSolveError] = useState<string | null>(null);
    const [imageSolveBrowserError, setImageSolveBrowserError] = useState<string | null>(null);
    const [imageSolveAnswerProvider, setImageSolveAnswerProvider] = useState<string | null>(null);
    const [imageSolveBackupProvider, setImageSolveBackupProvider] = useState<string | null>(null);
    const [imageSolveCountdown, setImageSolveCountdown] = useState<number | null>(null);
    const [expandedSolverScreenshot, setExpandedSolverScreenshot] = useState<{ src: string; label: string } | null>(null);
    const [imageSolveUploadMode, setImageSolveUploadMode] = useState(false);
    const [uploadedImagePreviews, setUploadedImagePreviews] = useState<string[]>([]);
    const [uploadedImagesBase64, setUploadedImagesBase64] = useState<string[]>([]);

    // ── File upload ───────────────────────────────────────────────────────────
    const handleFilesUpload = useCallback(async (files: FileList | File[]) => {
        const imageFiles = Array.from(files).filter(f => f.type.startsWith("image/"));
        if (!imageFiles.length) return;

        const readPromises = imageFiles.map(file => {
            return new Promise<string>((resolve) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target?.result as string);
                reader.readAsDataURL(file);
            });
        });

        const dataUrls = await Promise.all(readPromises);
        const validUrls = dataUrls.filter(Boolean) as string[];
        if (!validUrls.length) return;

        setUploadedImagePreviews(validUrls);
        setUploadedImagesBase64(validUrls);
        clearImageSolveResult();
    }, []);

    // ── Provider setup: ordered checklist ─────────────────────────────────────
    const [imageSolveProviderOrder, setImageSolveProviderOrder] = useState<string[]>(["deepseek", "gemini"]);
    const [imageSolveProviderEnabled, setImageSolveProviderEnabled] = useState<Record<string, boolean>>({ deepseek: true, gemini: true });
    const [providerDragOver, setProviderDragOver] = useState<number | null>(null);

    // ── Retry ─────────────────────────────────────────────────────────────────
    const [lastSolvedImageBase64, setLastSolvedImageBase64] = useState<string | null>(null);
    const [lastSolvedPrompt, setLastSolvedPrompt] = useState<string | null>(null);
    const [lastSolvedFlipClipboard, setLastSolvedFlipClipboard] = useState<boolean>(true);

    // ── Image solve results stack ─────────────────────────────────────────────
    const [imageSolveResults, setImageSolveResults] = useState<StoredImageSolveItem[]>([]);
    const [isImageSolveResultsLoaded, setIsImageSolveResultsLoaded] = useState(false);

    // ── Mount state ───────────────────────────────────────────────────────────
    const [mounted, setMounted] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);
    const [cameraError, setCameraError] = useState<string | null>(null);

    // ── Initial load ──────────────────────────────────────────────────────────
    useEffect(() => {
        const stored = localStorage.getItem("scannerApp_savedQuestions");
        if (stored) {
            try {
                const parsed: ScannedQuestion[] = JSON.parse(stored);
                const seenIds = new Set<string>();
                const sanitized = parsed.map((q) => {
                    let uniqueId = q.id;
                    if (!uniqueId || seenIds.has(uniqueId) || uniqueId.length < 5) {
                        uniqueId = `q-rec-${Math.random().toString(36).substring(2, 10)}`;
                    }
                    seenIds.add(uniqueId);
                    return { ...q, id: uniqueId };
                });
                setSavedQuestions(sanitized);
            } catch (error) {
                console.error("Failed to load saved questions", error);
            }
        }

        const storedPrompt = localStorage.getItem("scannerApp_solvePrompt");
        if (storedPrompt) setCustomSolvePrompt(storedPrompt);

        const storedWhatsApp = localStorage.getItem("scannerApp_sendToWhatsApp");
        if (storedWhatsApp !== null) setSendToWhatsApp(storedWhatsApp === "true");

        const storedOrder = localStorage.getItem("scannerApp_imageSolveProviderOrder");
        if (storedOrder) {
            try {
                let parsed = JSON.parse(storedOrder);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    // Migrate legacy "chatgpt" saved in localStorage to "deepseek"
                    parsed = parsed.map(p => p === "chatgpt" ? "deepseek" : p);
                    setImageSolveProviderOrder(parsed);
                }
            } catch { /* ignore */ }
        }

        const storedEnabled = localStorage.getItem("scannerApp_imageSolveProviderEnabled");
        if (storedEnabled) {
            try {
                const parsed = JSON.parse(storedEnabled);
                if (parsed && typeof parsed === "object") {
                    // Migrate legacy "chatgpt" key to "deepseek"
                    if ("chatgpt" in parsed) {
                        parsed.deepseek = parsed.chatgpt;
                        delete parsed.chatgpt;
                    }
                    setImageSolveProviderEnabled(parsed);
                }
            } catch { /* ignore */ }
        }

        setIsLoaded(true);
        setMounted(true);
    }, []);

    // ── Persist state ─────────────────────────────────────────────────────────
    useEffect(() => {
        if (isLoaded) {
            localStorage.setItem("scannerApp_savedQuestions", JSON.stringify(savedQuestions));
            localStorage.setItem("scannerApp_solvePrompt", customSolvePrompt);
            localStorage.setItem("scannerApp_sendToWhatsApp", String(sendToWhatsApp));
            localStorage.setItem("scannerApp_imageSolveProviderOrder", JSON.stringify(imageSolveProviderOrder));
            localStorage.setItem("scannerApp_imageSolveProviderEnabled", JSON.stringify(imageSolveProviderEnabled));
        }
    }, [savedQuestions, customSolvePrompt, sendToWhatsApp, imageSolveProviderOrder, imageSolveProviderEnabled, isLoaded]);

    // ── Server Sync Functions ─────────────────────────────────────────────────
    const syncQuestionsToServer = useCallback(async (questions: ScannedQuestion[]) => {
        try {
            setSyncStatus("syncing");
            const res = await fetch("/api/questions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ questions }),
            });
            if (res.ok) {
                const data = await res.json();
                if (data.updatedAt) lastServerUpdatedAtRef.current = data.updatedAt;
                setSyncStatus("synced");
            }
        } catch {
            setSyncStatus("offline");
        }
    }, []);

    const syncPromptsToServer = useCallback(async (solvePrompt?: string) => {
        try {
            setSyncStatus("syncing");
            const body: Record<string, string> = {};
            if (typeof solvePrompt === "string") body.solvePrompt = solvePrompt;
            const res = await fetch("/api/questions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                const data = await res.json();
                if (data.updatedAt) lastServerUpdatedAtRef.current = data.updatedAt;
                setSyncStatus("synced");
            }
        } catch {
            setSyncStatus("offline");
        }
    }, []);

    const syncClearServerQuestions = useCallback(async () => {
        try {
            setSyncStatus("syncing");
            const res = await fetch("/api/questions", { method: "DELETE" });
            if (res.ok) {
                const data = await res.json();
                if (data.updatedAt) lastServerUpdatedAtRef.current = data.updatedAt;
                setSyncStatus("synced");
            }
        } catch {
            setSyncStatus("offline");
        }
    }, []);

    const syncDeleteQuestionFromServer = useCallback(async (id: string) => {
        try {
            setSyncStatus("syncing");
            const res = await fetch(`/api/questions?id=${encodeURIComponent(id)}`, { method: "DELETE" });
            if (res.ok) {
                const data = await res.json();
                if (data.updatedAt) lastServerUpdatedAtRef.current = data.updatedAt;
                setSyncStatus("synced");
            }
        } catch {
            setSyncStatus("offline");
        }
    }, []);

    // ── Background Multi-Device Sync Poller ────────────────────────────────────
    useEffect(() => {
        let isMounted = true;
        let isPolling = false;

        const pollServerQuestions = async () => {
            if (isPolling) return;
            isPolling = true;
            try {
                const timestamp = Date.now();
                const url = lastServerUpdatedAtRef.current
                    ? `/api/questions?since=${encodeURIComponent(lastServerUpdatedAtRef.current)}&_t=${timestamp}`
                    : `/api/questions?_t=${timestamp}`;
                const res = await fetch(url, {
                    cache: "no-store",
                    headers: {
                        "Cache-Control": "no-cache, no-store, must-revalidate",
                        "Pragma": "no-cache",
                    },
                });
                if (!res.ok) {
                    if (isMounted) setSyncStatus("offline");
                    return;
                }
                const data = await res.json();
                if (!isMounted) return;

                if (data.updatedAt) {
                    lastServerUpdatedAtRef.current = data.updatedAt;
                }
                setSyncStatus("synced");

                if (data.changed) {
                    // Update questions list
                    if (Array.isArray(data.questions)) {
                        setSavedQuestions(data.questions);
                        localStorage.setItem("scannerApp_savedQuestions", JSON.stringify(data.questions));

                        // Auto-expand any questions with solutions so they're immediately visible
                        const solvedIds = data.questions.filter((q: ScannedQuestion) => !!q.solution).map((q: ScannedQuestion) => q.id);
                        if (solvedIds.length > 0) {
                            setExpandedSolutionIds(prev => {
                                const next = new Set(prev);
                                solvedIds.forEach((id: string) => next.add(id));
                                return next;
                            });
                        }
                    }

                    // Update prompt if settings modal is not open
                    if (!isSettingsOpenRef.current) {
                        if (typeof data.solvePrompt === "string" && data.solvePrompt.trim()) {
                            setCustomSolvePrompt(data.solvePrompt);
                            localStorage.setItem("scannerApp_solvePrompt", data.solvePrompt);
                        }
                    }
                }
            } catch {
                if (isMounted) setSyncStatus("offline");
            } finally {
                isPolling = false;
            }
        };

        pollServerQuestions();
        const interval = setInterval(pollServerQuestions, 2000);
        return () => {
            isMounted = false;
            clearInterval(interval);
        };
    }, []);

    // ── Captures Sync Functions ───────────────────────────────────────────────
    const pollServerCaptures = useCallback(async () => {
        try {
            const res = await fetch(`/api/captures?limit=60&_t=${Date.now()}`, {
                cache: "no-store",
                headers: {
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache",
                },
            });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data.captures)) {
                    setSyncedCaptures(data.captures);
                    setCapturesSyncStatus("synced");
                }
            } else {
                setCapturesSyncStatus("offline");
            }
        } catch {
            setCapturesSyncStatus("offline");
        }
    }, []);

    useEffect(() => {
        pollServerCaptures();
        const interval = setInterval(pollServerCaptures, 2500);
        return () => clearInterval(interval);
    }, [pollServerCaptures]);

    const uploadCaptureToServer = useCallback(async (imageData: string, type: "scan" | "solve", metadata?: any) => {
        try {
            const tempId = `cap_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            const optimisticCapture: SyncedCapture = {
                id: tempId,
                createdAt: Date.now(),
                type,
                imageData,
                metadata,
            };
            setSyncedCaptures(prev => [optimisticCapture, ...prev.filter(c => c.id !== tempId)]);
            setCapturesSyncStatus("syncing");

            const res = await fetch("/api/captures", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: tempId, type, imageData, metadata }),
            });
            if (res.ok) {
                const data = await res.json();
                if (data?.capture) {
                    setSyncedCaptures(prev => [data.capture, ...prev.filter(c => c.id !== tempId && c.id !== data.capture.id)]);
                }
                setCapturesSyncStatus("synced");
            } else {
                setCapturesSyncStatus("offline");
            }
        } catch (err) {
            console.warn("[Captures] Failed to upload capture to server:", err);
            setCapturesSyncStatus("offline");
        }
    }, []);

    const deleteCapture = useCallback(async (id: string) => {
        setSyncedCaptures(prev => prev.filter(c => c.id !== id));
        if (activeCaptureModal?.id === id) setActiveCaptureModal(null);
        try {
            await fetch(`/api/captures?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        } catch (e) {
            console.warn("[Captures] Failed to delete capture:", e);
        }
    }, [activeCaptureModal]);

    const clearAllCaptures = useCallback(async () => {
        if (!confirm("Are you sure you want to clear all synced captures across all devices?")) return;
        setSyncedCaptures([]);
        setActiveCaptureModal(null);
        try {
            await fetch("/api/captures", { method: "DELETE" });
        } catch (e) {
            console.warn("[Captures] Failed to clear captures:", e);
        }
    }, []);

    const downloadCaptureImage = useCallback((capture: SyncedCapture) => {
        try {
            const link = document.createElement("a");
            link.href = capture.imageData;
            link.download = `capture_${capture.type}_${capture.id}.jpg`;
            link.style.display = "none";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (e) {
            console.warn("[Captures] Download failed:", e);
        }
    }, []);

    const copyQuestionAndSolution = useCallback((q: ScannedQuestion, e: React.MouseEvent) => {
        e.stopPropagation();
        const textToCopy = `Question ${q.questionNumber}:\n${q.text}\n\nSolution:\n${q.solution || "(No solution)"}`;
        if (typeof navigator !== "undefined" && navigator.clipboard) {
            navigator.clipboard.writeText(textToCopy).then(() => {
                setCopiedId(q.id);
                setTimeout(() => setCopiedId(null), 2000);
            }).catch(() => {});
        }
    }, []);

    const copyAllSolutions = useCallback(() => {
        const solvedList = savedQuestions.filter(q => !!q.solution);
        if (solvedList.length === 0) return;

        const header = `INTELLISCAN - SOLVED QUESTIONS & SOLUTIONS (${solvedList.length} total)\n==================================================\n\n`;
        const body = solvedList.map(q => `Question ${q.questionNumber}:\n${q.text}\n\nSolution:\n${q.solution}\n\n--------------------------------------------------\n`).join("\n");
        const fullText = header + body;

        if (typeof navigator !== "undefined" && navigator.clipboard) {
            navigator.clipboard.writeText(fullText).then(() => {
                setCopiedAll(true);
                setTimeout(() => setCopiedAll(false), 2000);
            }).catch(() => {});
        }
    }, [savedQuestions]);

    const toggleExpandAll = useCallback(() => {
        const solvedList = savedQuestions.filter(q => !!q.solution);
        if (solvedList.length === 0) return;
        const allExpanded = solvedList.every(q => expandedSolutionIds.has(q.id));
        if (allExpanded) {
            setExpandedSolutionIds(new Set());
        } else {
            setExpandedSolutionIds(new Set(solvedList.map(q => q.id)));
        }
    }, [savedQuestions, expandedSolutionIds]);

    // ── Load image solve history ──────────────────────────────────────────────
    const fetchHistory = useCallback(async () => {
        try {
            const res = await fetch("/api/image-solve/history");
            if (res.ok) {
                const data = await res.json();
                if (data.history) {
                    const mapped: StoredImageSolveItem[] = data.history.map((job: any) => {
                        let imageUrl = "";
                        if (job.imageSolveCapture && job.imageSolveCapture.filename) {
                            imageUrl = `/api/image-solve/captures/${job.imageSolveCapture.filename}`;
                        }
                        return {
                            ...job,
                            id: job.jobId,
                            image: imageUrl,
                            screenshot: job.primaryScreenshot || null,
                            backupScreenshot: job.backupScreenshot || null,
                            source: "browser",
                            primaryProvider: job.provider,
                            answerProvider: job.primaryScreenshot ? job.provider : (job.backupScreenshot ? job.backupProvider : null),
                            status: job.status,
                            flipClipboard: job.flipClipboard,
                            createdAt: job.createdAt || new Date().toISOString(),
                        };
                    });
                    setImageSolveResults(mapped);
                }
            }
        } catch (error) {
            console.error("Failed to load global history", error);
        } finally {
            setIsImageSolveResultsLoaded(true);
        }
    }, []);

    useEffect(() => {
        if (!mounted) return;
        fetchHistory();
    }, [mounted, fetchHistory]);

    // ── Camera ────────────────────────────────────────────────────────────────
    const stopCamera = useCallback(() => {
        cameraRunIdRef.current += 1;
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
    }, []);

    const startCamera = useCallback(async () => {
        setCameraError(null);
        stopCamera();
        const runId = cameraRunIdRef.current + 1;
        cameraRunIdRef.current = runId;

        try {
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error("This browser does not expose camera capture APIs.");
            }

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    width: { ideal: 2560 },
                    height: { ideal: 1440 },
                    aspectRatio: { ideal: 16 / 9 },
                    facingMode: { ideal: "user" },
                },
            });

            if (cameraRunIdRef.current !== runId) {
                stream.getTracks().forEach((track) => track.stop());
                return;
            }

            streamRef.current = stream;
            const video = videoRef.current;
            if (video) {
                video.srcObject = stream;
                await video.play();
            }

            // Auto-restart if the hardware track dies (e.g. camera taken by another app)
            const track = stream.getVideoTracks()[0];
            if (track) {
                const settings = track.getSettings();
                console.log(`Camera stream active at ${settings?.width || "?"}x${settings?.height || "?"}`);
                track.addEventListener("ended", () => {
                    if (cameraRunIdRef.current === runId) {
                        console.warn("Camera track ended unexpectedly, restarting...");
                        startCamera();
                    }
                });
            }
        } catch (error) {
            const message = getErrorMessage(error, "Could not start camera.");
            console.error("Camera start error:", error);
            setCameraError(message);
            stopCamera();
        }
    }, [stopCamera]);

    useEffect(() => {
        if (!mounted) return;
        startCamera();
        return () => stopCamera();
    }, [mounted, startCamera, stopCamera]);

    // ── Canvas capture helpers ────────────────────────────────────────────────
    const drawCaptureToCanvas = useCallback((
        source: CanvasImageSource,
        sourceWidth: number,
        sourceHeight: number,
        flip: boolean,
        options: CaptureFrameOptions,
    ) => {
        const scale = Math.min(1, options.maxWidth / sourceWidth, options.maxHeight / sourceHeight);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(sourceWidth * scale));
        canvas.height = Math.max(1, Math.round(sourceHeight * scale));
        const ctx = canvas.getContext("2d", { alpha: false });

        if (!ctx) throw new Error("Could not create image capture canvas.");

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = scale < 1;
        ctx.imageSmoothingQuality = "high";
        if (flip) {
            ctx.translate(canvas.width, 0);
            ctx.scale(-1, 1);
        }
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        return canvas;
    }, []);

    const encodeCanvasWithinLimit = useCallback((sourceCanvas: HTMLCanvasElement, options: CaptureFrameOptions) => {
        let canvas = sourceCanvas;
        let quality = options.quality;
        let dataUrl = canvas.toDataURL(options.mimeType, quality);
        let attempts = 0;

        while (dataUrl.length > options.maxDataUrlLength && attempts < 12) {
            attempts += 1;
            if (quality > options.minQuality + 0.01) {
                quality = Math.max(options.minQuality, quality - 0.08);
            } else {
                const resizedCanvas = document.createElement("canvas");
                resizedCanvas.width = Math.max(1, Math.round(canvas.width * 0.84));
                resizedCanvas.height = Math.max(1, Math.round(canvas.height * 0.84));
                const resizedCtx = resizedCanvas.getContext("2d", { alpha: false });
                if (!resizedCtx) throw new Error("Could not resize captured image.");
                resizedCtx.fillStyle = "#ffffff";
                resizedCtx.fillRect(0, 0, resizedCanvas.width, resizedCanvas.height);
                resizedCtx.imageSmoothingEnabled = true;
                resizedCtx.imageSmoothingQuality = "high";
                resizedCtx.drawImage(canvas, 0, 0, resizedCanvas.width, resizedCanvas.height);
                canvas = resizedCanvas;
                quality = options.quality;
            }
            dataUrl = canvas.toDataURL(options.mimeType, quality);
        }

        if (dataUrl.length > options.maxDataUrlLength) {
            throw new Error(
                `Captured image is still too large after compression (${formatBytes(dataUrlByteSize(dataUrl))}). Move the paper closer and try again.`
            );
        }

        console.log(
            `Encoded capture ${canvas.width}x${canvas.height} as ${options.mimeType} (${formatBytes(dataUrlByteSize(dataUrl))}, ${dataUrl.length} chars).`
        );
        return dataUrl;
    }, []);

    const captureHighQualityFrame = useCallback(async (options = scanCaptureOptions) => {
        const video = videoRef.current;
        if (!video) return null;

        if (video.videoWidth && video.videoHeight) {
            const canvas = drawCaptureToCanvas(
                video, video.videoWidth, video.videoHeight,
                Boolean(options.mirrorHorizontal), options
            );
            console.log(`Captured video frame at ${video.videoWidth}x${video.videoHeight}`);
            return encodeCanvasWithinLimit(canvas, options);
        }

        return null;
    }, [drawCaptureToCanvas, encodeCanvasWithinLimit]);

    const getCaptureResolution = () => {
        const video = videoRef.current;
        if (!video) return null;
        return { width: video.videoWidth, height: video.videoHeight };
    };

    // ── Auto Solve Process ────────────────────────────────────────────────────
    const autoSolveQuestions = useCallback(async (questionsToSolve: ScannedQuestion[]) => {
        if (!questionsToSolve || questionsToSolve.length === 0) return;

        setIsProcessingSolutions(true);

        let solvedList: ScannedQuestion[] = [];

        try {
            const payload = questionsToSolve.map(q => ({ id: q.id, text: q.text }));
            const solveRes = await fetch("/api/solve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ questions: payload, customSolvePrompt }),
            });

            if (!solveRes.ok) {
                const errData = await solveRes.json();
                throw new Error(errData.error || `Solve failed: ${solveRes.status}`);
            }

            const solveData = await solveRes.json();
            const solutionsMap: Record<string, string> = solveData.solutions || {};

            // Map solutions to newly solved batch
            const newlySolvedBatch = questionsToSolve.map((q, idx) => {
                const sol = findSolutionForQuestion(q, idx, solutionsMap);
                return sol ? { ...q, solution: sol, isSolving: false } : { ...q, isSolving: false };
            });

            const newlySolvedMap = new Map<string, ScannedQuestion>(newlySolvedBatch.map(q => [q.id, q]));

            // Cumulatively merge into all saved questions without wiping previous batches
            const currentSaved = savedQuestionsRef.current;
            const allUpdated = currentSaved.map(q => newlySolvedMap.get(q.id) || q);

            // In case any newly solved question was not yet in currentSaved, append it
            newlySolvedBatch.forEach(q => {
                if (!allUpdated.some(existing => existing.id === q.id)) {
                    allUpdated.push(q);
                }
            });

            setSavedQuestions(allUpdated);
            await syncQuestionsToServer(allUpdated);
            solvedList = newlySolvedBatch.filter(q => !!q.solution);

            // Add new question IDs to expandedSolutionIds
            setExpandedSolutionIds(prev => {
                const next = new Set(prev);
                questionsToSolve.forEach(q => next.add(q.id));
                return next;
            });
        } catch (err: unknown) {
            console.error("Auto solve failed:", err);
            setErrorMessage(getErrorMessage(err, "Failed to solve questions."));
            const failedIds = new Set(questionsToSolve.map(q => q.id));
            setSavedQuestions(prev => prev.map(q => failedIds.has(q.id) ? { ...q, isSolving: false } : q));
        } finally {
            setIsProcessingSolutions(false);
        }

        // ── STRICTLY AFTER EVERYTHING ELSE HAS COMPLETED: Send to WhatsApp (if enabled) ──
        if (sendToWhatsApp && solvedList.length > 0) {
            console.log("[WhatsApp] Dispatching solutions strictly AFTER solve completion without delay...");
            try {
                const whatsappPayload = solvedList.map(q => ({
                    questionNumber: q.questionNumber,
                    text: q.text,
                    solution: q.solution,
                }));

                const res = await fetch("/api/whatsapp/send-solutions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ solutions: whatsappPayload, delaySeconds: 0, blockDelaySeconds: 0 }),
                });
                const data = await res.json().catch(() => ({}));
                if (data.ok) {
                    console.log("[WhatsApp] Solutions dispatched without delay:", data);
                } else {
                    console.warn("[WhatsApp] Dispatch warning:", data.error);
                }
            } catch (e) {
                console.warn("[WhatsApp] Dispatch request failed:", e);
            }
        }
    }, [customSolvePrompt, sendToWhatsApp, syncQuestionsToServer]);

    // ── Scan mode capture ─────────────────────────────────────────────────────
    const capture = useCallback(async (autoTriggered = false) => {
        if (!videoRef.current) return;


        setIsCapturing(true);
        setScanStatus("scanning");
        setErrorMessage("");

        setTimeout(() => setIsCapturing(false), 500);

        const base64Image = await captureHighQualityFrame(scanCaptureOptions);
        if (!base64Image) {
            setScanStatus("error");
            setErrorMessage("Failed to capture image from camera.");
            return;
        }

        // Sync capture across all devices
        uploadCaptureToServer(base64Image, "scan");

        try {
            const resolution = getCaptureResolution();
            if (resolution?.width && resolution?.height) {
                console.log(`Captured scan frame at ${resolution.width}x${resolution.height}`);
            }

            const response = await fetch("/api/scan", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ image: base64Image }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `API returned ${response.status}`);
            }

            const data = await response.json();
            const rawQuestions = data.questions || [];
            if (rawQuestions.length === 0) {
                setScanStatus("error");
                setErrorMessage("No questions detected in the scanned image. Please position the paper and try again.");
                return;
            }

            const existingQuestions = savedQuestionsRef.current;
            const existingCount = existingQuestions.length;

            const assignedQuestions: ScannedQuestion[] = rawQuestions.map((newQ: any, idx: number) => {
                const questionNum = newQ.questionNumber && !existingQuestions.some(eq => eq.questionNumber === newQ.questionNumber)
                    ? newQ.questionNumber
                    : String(existingCount + idx + 1);

                return {
                    id: newQ.id || `q-${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 6)}`,
                    questionNumber: questionNum,
                    text: newQ.text || "",
                    isSolving: true,
                    createdAt: Date.now(),
                };
            });

            // CUMULATIVELY append to existing questions
            const cumulativeQuestions = [...existingQuestions, ...assignedQuestions];
            setSavedQuestions(cumulativeQuestions);
            setScanStatus("success");

            // IMMEDIATELY sync cumulative questions to server so Device 2 displays all previous + new solving questions
            syncQuestionsToServer(cumulativeQuestions);

            // Automatically solve ONLY the new batch of questions
            autoSolveQuestions(assignedQuestions);
        } catch (error: unknown) {
            console.error("Scan error:", error);
            setScanStatus("error");
            setErrorMessage(getErrorMessage(error, "Failed to process the question paper."));
        }
    }, [captureHighQualityFrame, autoSolveQuestions, syncQuestionsToServer, uploadCaptureToServer]);

    // ── Re-scan from synced capture ───────────────────────────────────────────
    const reScanCapture = useCallback(async (captureItem: SyncedCapture) => {
        setBottomTab("questions");
        setIsCapturing(true);
        setScanStatus("scanning");
        setErrorMessage("");

        setTimeout(() => setIsCapturing(false), 500);

        try {
            const response = await fetch("/api/scan", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ image: captureItem.imageData }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `API returned ${response.status}`);
            }

            const data = await response.json();
            const rawQuestions = data.questions || [];
            if (rawQuestions.length === 0) {
                setScanStatus("error");
                setErrorMessage("No questions detected in this captured image.");
                return;
            }

            const existingQuestions = savedQuestionsRef.current;
            const existingCount = existingQuestions.length;

            const assignedQuestions: ScannedQuestion[] = rawQuestions.map((newQ: any, idx: number) => {
                const questionNum = newQ.questionNumber && !existingQuestions.some(eq => eq.questionNumber === newQ.questionNumber)
                    ? newQ.questionNumber
                    : String(existingCount + idx + 1);

                return {
                    id: newQ.id || `q-${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 6)}`,
                    questionNumber: questionNum,
                    text: newQ.text || "",
                    isSolving: true,
                    createdAt: Date.now(),
                };
            });

            const cumulativeQuestions = [...existingQuestions, ...assignedQuestions];
            setSavedQuestions(cumulativeQuestions);
            setScanStatus("success");
            syncQuestionsToServer(cumulativeQuestions);
            autoSolveQuestions(assignedQuestions);
        } catch (error: unknown) {
            console.error("Re-scan error:", error);
            setScanStatus("error");
            setErrorMessage(getErrorMessage(error, "Failed to process the captured image."));
        }
    }, [autoSolveQuestions, syncQuestionsToServer]);

    // ── Frame Darkness Detection ──────────────────────────────────────────────
    const checkFrameDarkness = useCallback((): { isDark: boolean; avgLuminance: number } => {
        const video = videoRef.current;
        if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
            return { isDark: false, avgLuminance: 255 };
        }

        if (!pollingCanvasRef.current) {
            pollingCanvasRef.current = document.createElement("canvas");
            pollingCanvasRef.current.width = 32;
            pollingCanvasRef.current.height = 32;
        }

        const canvas = pollingCanvasRef.current;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return { isDark: false, avgLuminance: 255 };

        ctx.drawImage(video, 0, 0, 32, 32);
        const imageData = ctx.getImageData(0, 0, 32, 32);
        const data = imageData.data;
        let totalLuminance = 0;
        let totalG = 0;
        let totalB = 0;
        const pixelCount = data.length / 4;
        const luminances: number[] = [];
        let skinScatterCount = 0;

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            totalLuminance += lum;
            totalG += g;
            totalB += b;
            luminances.push(lum);

            // Translucent skin-scatter check: skin allows red through while absorbing green and blue
            if (r > 1.4 * g && g < 55 && b < 45) {
                skinScatterCount++;
            }
        }

        const avgLuminance = totalLuminance / pixelCount;
        const avgG = totalG / pixelCount;
        const avgB = totalB / pixelCount;

        luminances.sort((a, b) => a - b);
        const p90Luminance = luminances[Math.floor(pixelCount * 0.90)] || avgLuminance;

        // Covered camera detection:
        // 1. Pure dark: avgLuminance < 36 and 90th percentile < 65
        // 2. Translucent finger/palm skin scatter: green & blue strongly attenuated
        const isPureDark = avgLuminance < 36 && p90Luminance < 65;
        const isSkinCovered = (skinScatterCount / pixelCount > 0.40) && (avgG < 50 && avgB < 45);

        const isDark = isPureDark || isSkinCovered;
        return { isDark, avgLuminance };
    }, []);

    // ── Camera Polling for Darkness (Scan Mode Gesture) ───────────────────────
    useEffect(() => {
        if (!mounted || imageSolveMode || scanStatus === "scanning" || cameraError) {
            darknessStartTimeRef.current = null;
            abortedDueToLongDarknessRef.current = false;
            countdownTriggeredByDarknessRef.current = false;
            lightTicksRef.current = 0;
            setDarknessDuration(0);
            return;
        }

        const interval = setInterval(() => {
            const { isDark } = checkFrameDarkness();
            const now = Date.now();

            if (isDark) {
                lightTicksRef.current = 0;

                if (countdown !== null) {
                    return;
                }

                if (darknessStartTimeRef.current === null) {
                    darknessStartTimeRef.current = now;
                }

                const elapsed = (now - darknessStartTimeRef.current) / 1000;
                setDarknessDuration(Math.min(elapsed, 3.5));

                if (elapsed >= 3.5 && !countdownTriggeredByDarknessRef.current && countdown === null) {
                    console.log("[Darkness Poller] Darkness reached 3.5s! Initiating scan countdown.");
                    countdownTriggeredByDarknessRef.current = true;
                    darknessStartTimeRef.current = null;
                    setDarknessDuration(0);
                    setCountdown(captureDelay);
                    setDarknessStatus("countdown");
                    setDarknessAbortMessage(null);
                } else if (elapsed < 3.5) {
                    setDarknessStatus("covering");
                }
            } else {
                lightTicksRef.current += 1;

                // When camera is uncovered for at least 2 ticks (200ms)
                if (lightTicksRef.current >= 2) {
                    if (abortedDueToLongDarknessRef.current) {
                        abortedDueToLongDarknessRef.current = false;
                        setDarknessStatus("idle");
                        setDarknessAbortMessage(null);
                    }

                    darknessStartTimeRef.current = null;
                    setDarknessDuration(0);

                    if (countdown === null && darknessStatus !== "aborted") {
                        setDarknessStatus("idle");
                    }
                }
            }
        }, 100);

        return () => clearInterval(interval);
    }, [mounted, imageSolveMode, scanStatus, cameraError, countdown, captureDelay, darknessStatus, checkFrameDarkness]);

    // ── Countdown for scan ────────────────────────────────────────────────────
    useEffect(() => {
        if (countdown === null) return;
        if (countdown > 0) {
            const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
            return () => clearTimeout(timer);
        } else if (countdown === 0) {
            setCountdown(null);
            countdownTriggeredByDarknessRef.current = false;
            darknessStartTimeRef.current = null;
            setDarknessDuration(0);

            // Check if by the time countdown ends it is STILL dark
            const { isDark } = checkFrameDarkness();
            if (isDark) {
                console.log("[Countdown End] Camera is STILL dark. Aborting scan.");
                abortedDueToLongDarknessRef.current = true;
                setDarknessStatus("aborted");
                setDarknessAbortMessage("Scan aborted: Camera remained covered when countdown ended. Uncover camera to resume.");
                return;
            }

            // Camera is uncovered (light detected): capture document!
            setDarknessStatus("idle");
            setDarknessAbortMessage(null);
            capture(true);
        }
    }, [countdown, capture, checkFrameDarkness]);

    const cancelScanCountdown = useCallback(() => {
        setCountdown(null);
        countdownTriggeredByDarknessRef.current = false;
        darknessStartTimeRef.current = null;
        setDarknessDuration(0);
        setDarknessStatus("idle");
        setDarknessAbortMessage(null);
    }, []);

    const startManualScan = () => {
        if (scanStatus === "scanning" || countdown !== null) return;
        countdownTriggeredByDarknessRef.current = false;
        darknessStartTimeRef.current = null;
        setDarknessDuration(0);
        setCountdown(captureDelay);
        setDarknessStatus("countdown");
        setDarknessAbortMessage(null);
    };

    // ── Image Solve: shared result apply ──────────────────────────────────────
    const clearImageSolveResult = useCallback(() => {
        imageSolveRunIdRef.current += 1;
        setImageSolveStatus("idle");
        setImageSolveAnswer(null);
        setImageSolveScreenshot(null);
        setImageSolveBackupAnswer(null);
        setImageSolveBackupScreenshot(null);
        setImageSolveBackupStatus("idle");
        setImageSolveBackupError(null);
        setImageSolveError(null);
        setImageSolveBrowserError(null);
        setImageSolveAnswerProvider(null);
        setImageSolveBackupProvider(null);
        setImageSolveJobId(null);
        setImageSolveCountdown(null);
        setExpandedSolverScreenshot(null);
    }, []);

    // ── Image Solve: camera capture → solve ───────────────────────────────────
    const captureAndImageSolve = useCallback(async () => {
        if (!videoRef.current || imageSolveStatus === "solving" || imageSolveStatus === "capturing") return;

        const runId = imageSolveRunIdRef.current + 1;
        imageSolveRunIdRef.current = runId;
        const isCurrentRun = () => imageSolveRunIdRef.current === runId;

        setImageSolveStatus("capturing");
        setImageSolveAnswer(null);
        setImageSolveScreenshot(null);
        setImageSolveBackupAnswer(null);
        setImageSolveBackupScreenshot(null);
        setImageSolveBackupStatus("idle");
        setImageSolveBackupError(null);
        setImageSolveError(null);
        setImageSolveBrowserError(null);
        setImageSolveAnswerProvider(null);

        // Derive providers from the ordered+enabled list
        const enabledProviders = imageSolveProviderOrder.filter(p => imageSolveProviderEnabled[p]);
        const requestPrimaryProvider = (enabledProviders[0] ?? "deepseek") as ImageSolveProvider;
        const requestBackupProvider = (enabledProviders[1] ?? null) as ImageSolveProvider | null;
        setImageSolveBackupProvider(requestBackupProvider);

        // Global polling will pick up the new job automatically, so we don't upsert locally.

        let base64Image: string | null = null;
        try {
            base64Image = await captureHighQualityFrame(imageSolveCaptureOptions);
        } catch (err: unknown) {
            if (!isCurrentRun()) return;
            setImageSolveStatus("error");
            setImageSolveError(`Image capture failed: ${getErrorMessage(err)}`);
            return;
        }

        if (!isCurrentRun()) return;

        if (!base64Image) {
            setImageSolveStatus("error");
            setImageSolveError("Failed to capture image from camera.");
            return;
        }

        if (!isImageDataUrl(base64Image)) {
            setImageSolveStatus("error");
            setImageSolveError("Captured image was not a valid base64 image data URL.");
            return;
        }

        // Sync capture across all devices
        uploadCaptureToServer(base64Image, "solve");

        const resolution = getCaptureResolution();
        if (resolution?.width && resolution?.height) {
            console.log(`Captured image-solve frame at ${resolution.width}x${resolution.height}`);
        }

        // Store for retry
        setLastSolvedImageBase64(base64Image);
        setLastSolvedPrompt(customSolvePrompt);
        setLastSolvedFlipClipboard(true);

        setImageSolveStatus("solving");

        try {
            const response = await fetch("/api/image-solve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    image: base64Image,
                    prompt: customSolvePrompt,
                    primaryProvider: requestPrimaryProvider,
                    backupProvider: requestBackupProvider,
                    flipClipboard: true,
                }),
            });

            const data = await readImageSolveResponse(response);

            if (!isCurrentRun()) return;

            if (!response.ok || (data.error && !data.jobId && !data.fallbackRequired)) {
                throw new Error(data.error || `Server returned ${response.status}`);
            }

            if (data.jobId) {
                setImageSolveJobId(data.jobId);
            }

            const applyImageSolveData = (statusData: ImageSolveStatusData) => {
                if (!isCurrentRun()) return true;

                const browserError =
                    statusData.browserError ||
                    statusData.primaryError ||
                    (!statusData.primaryAnswer && statusData.error ? statusData.error : null);

                if (browserError) {
                    setImageSolveBrowserError(browserError);
                }

                const primaryAnswer = statusData.primaryAnswer || statusData.answer;
                const primaryScreenshot = statusData.primaryScreenshot;
                const resultProvider = statusData.provider || statusData.source || requestPrimaryProvider;

                if (primaryScreenshot) {
                    setImageSolveScreenshot(primaryScreenshot);
                    setImageSolveAnswerProvider(resultProvider);
                    setImageSolveStatus("done");
                }

                if (primaryAnswer) {
                    setImageSolveAnswer(primaryAnswer);
                    setImageSolveAnswerProvider(resultProvider);
                    setImageSolveStatus("done");
                }

                if (statusData.backupStatus) {
                    setImageSolveBackupStatus(statusData.backupStatus);
                }

                const normalizedBackupProvider = normalizeImageSolveProvider(statusData.backupProvider);
                if (normalizedBackupProvider) {
                    setImageSolveBackupProvider(normalizedBackupProvider);
                }

                if (statusData.backupAnswer) {
                    setImageSolveBackupAnswer(statusData.backupAnswer);
                    setImageSolveBackupStatus("done");
                }

                if (statusData.backupScreenshot) {
                    setImageSolveBackupScreenshot(statusData.backupScreenshot);
                    setImageSolveBackupStatus("done");
                    if (!primaryScreenshot && !primaryAnswer) {
                        setImageSolveAnswerProvider(normalizedBackupProvider || statusData.provider || requestBackupProvider);
                        setImageSolveStatus("done");
                    }
                }

                if (statusData.backupError) {
                    setImageSolveBackupError(statusData.backupError);
                    setImageSolveBackupStatus("error");
                }

                if (!primaryAnswer && !primaryScreenshot && statusData.status === "error") {
                    setImageSolveError(statusData.error || "Image solve failed.");
                    setImageSolveStatus("error");
                    return true;
                }

                return (
                    statusData.backupStatus === "done" ||
                    statusData.backupStatus === "error" ||
                    Boolean(statusData.backupAnswer) ||
                    Boolean(statusData.backupScreenshot) ||
                    Boolean(statusData.backupError)
                );
            };

            applyImageSolveData(data);

            if (data.jobId) {
                const pollInterval = setInterval(async () => {
                    try {
                        if (!isCurrentRun()) { clearInterval(pollInterval); return; }
                        const statusRes = await fetch(`/api/image-solve/status?jobId=${data.jobId}`);
                        if (!statusRes.ok) return;
                        const statusData = await readImageSolveResponse(statusRes);
                        const shouldStop = applyImageSolveData(statusData);
                        if (shouldStop) clearInterval(pollInterval);
                    } catch (e: unknown) {
                        console.error("Status poll error:", e);
                    }
                }, 3000);
            } else if (!data.primaryScreenshot && !data.backupScreenshot) {
                setImageSolveAnswer(data.answer || "(No answer returned)");
                setImageSolveAnswerProvider(data.provider || data.source || null);
                setImageSolveStatus("done");
            }
        } catch (err: unknown) {
            if (!isCurrentRun()) return;
            const message = getErrorMessage(err);
            setImageSolveError(message);
            setImageSolveStatus("error");
        }
    }, [imageSolveStatus, customSolvePrompt, imageSolveProviderOrder, imageSolveProviderEnabled, captureHighQualityFrame, uploadCaptureToServer]);

    // ── Image Solve: solve batch from images ──────────────────────────────────
    const solveBatchUploadedImages = useCallback(async (base64Images: string[]) => {
        if (imageSolveStatus === "solving" || imageSolveStatus === "capturing" || base64Images.length === 0) return;

        setImageSolveStatus("solving");
        setImageSolveAnswer(null);
        setImageSolveScreenshot(null);
        setImageSolveBackupAnswer(null);
        setImageSolveBackupScreenshot(null);
        setImageSolveBackupStatus("idle");
        setImageSolveBackupError(null);
        setImageSolveError(null);
        setImageSolveBrowserError(null);
        setImageSolveAnswerProvider(null);

        const enabledProviders = imageSolveProviderOrder.filter(p => imageSolveProviderEnabled[p]);
        const requestPrimaryProvider = (enabledProviders[0] ?? "deepseek") as ImageSolveProvider;
        const requestBackupProvider = (enabledProviders[1] ?? null) as ImageSolveProvider | null;
        setImageSolveBackupProvider(requestBackupProvider);

        try {
            const response = await fetch("/api/image-solve/batch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    images: base64Images,
                    prompt: customSolvePrompt,
                    primaryProvider: requestPrimaryProvider,
                    backupProvider: requestBackupProvider,
                    flipClipboard: false,
                }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => null);
                throw new Error(errorData?.error || `HTTP error! status: ${response.status}`);
            }
            
            fetchHistory();
            
            setImageSolveStatus("idle");
            setUploadedImagesBase64([]);
            setUploadedImagePreviews([]);
        } catch (error: unknown) {
            console.error("Batch image solve error:", error);
            setImageSolveStatus("error");
            setImageSolveError(`Failed to queue batch solve: ${getErrorMessage(error)}`);
        }
    }, [imageSolveStatus, customSolvePrompt, imageSolveProviderOrder, imageSolveProviderEnabled, fetchHistory]);

    // ── Image Solve: solve from image (upload or retry) ───────────────────────
    const solveWithUploadedImage = useCallback(async (base64Image: string, promptOverride?: string, flipClipboard: boolean = false, providerOverride?: string) => {
        if (imageSolveStatus === "solving" || imageSolveStatus === "capturing") return;

        const runId = imageSolveRunIdRef.current + 1;
        imageSolveRunIdRef.current = runId;
        const isCurrentRun = () => imageSolveRunIdRef.current === runId;

        const solvePrompt = promptOverride ?? customSolvePrompt;

        setImageSolveStatus("solving");
        setImageSolveAnswer(null);
        setImageSolveScreenshot(null);
        setImageSolveBackupAnswer(null);
        setImageSolveBackupScreenshot(null);
        setImageSolveBackupStatus("idle");
        setImageSolveBackupError(null);
        setImageSolveError(null);
        setImageSolveBrowserError(null);
        setImageSolveAnswerProvider(null);

        // If a specific provider override is given, use it as primary with no backup
        let requestPrimaryProvider: ImageSolveProvider;
        let requestBackupProvider: ImageSolveProvider | null;
        if (providerOverride) {
            requestPrimaryProvider = providerOverride as ImageSolveProvider;
            requestBackupProvider = null;
        } else {
            const enabledProviders = imageSolveProviderOrder.filter(p => imageSolveProviderEnabled[p]);
            requestPrimaryProvider = (enabledProviders[0] ?? "deepseek") as ImageSolveProvider;
            requestBackupProvider = (enabledProviders[1] ?? null) as ImageSolveProvider | null;
        }
        setImageSolveBackupProvider(requestBackupProvider);

        // Store for retry
        setLastSolvedImageBase64(base64Image);
        setLastSolvedPrompt(solvePrompt);
        setLastSolvedFlipClipboard(flipClipboard);

        // Global polling will pick up the new job automatically, so we don't upsert locally.

        try {
            const response = await fetch("/api/image-solve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    image: base64Image,
                    prompt: solvePrompt,
                    primaryProvider: requestPrimaryProvider,
                    backupProvider: requestBackupProvider,
                    flipClipboard,
                }),
            });

            const data = await readImageSolveResponse(response);
            if (!isCurrentRun()) return;

            if (!response.ok || (data.error && !data.jobId && !data.fallbackRequired)) {
                throw new Error(data.error || `Server returned ${response.status}`);
            }

            if (data.jobId) {
                setImageSolveJobId(data.jobId);
            }

            const applyData = (statusData: ImageSolveStatusData) => {
                if (!isCurrentRun()) return true;
                const browserError =
                    statusData.browserError ||
                    statusData.primaryError ||
                    (!statusData.primaryAnswer && statusData.error ? statusData.error : null);
                if (browserError) {
                    setImageSolveBrowserError(browserError);
                }
                const primaryAnswer = statusData.primaryAnswer || statusData.answer;
                const primaryScreenshot = statusData.primaryScreenshot;
                const resultProvider = statusData.provider || statusData.source || requestPrimaryProvider;
                if (primaryScreenshot) {
                    setImageSolveScreenshot(primaryScreenshot);
                    setImageSolveAnswerProvider(resultProvider);
                    setImageSolveStatus("done");
                }
                if (primaryAnswer) {
                    setImageSolveAnswer(primaryAnswer);
                    setImageSolveAnswerProvider(resultProvider);
                    setImageSolveStatus("done");
                }
                if (statusData.backupStatus) {
                    setImageSolveBackupStatus(statusData.backupStatus);
                }
                const normBackup = normalizeImageSolveProvider(statusData.backupProvider);
                if (normBackup) {
                    setImageSolveBackupProvider(normBackup);
                }
                if (statusData.backupAnswer) {
                    setImageSolveBackupAnswer(statusData.backupAnswer);
                    setImageSolveBackupStatus("done");
                }
                if (statusData.backupScreenshot) {
                    setImageSolveBackupScreenshot(statusData.backupScreenshot);
                    setImageSolveBackupStatus("done");
                    if (!primaryScreenshot && !primaryAnswer) {
                        setImageSolveAnswerProvider(normBackup || statusData.provider || requestBackupProvider);
                        setImageSolveStatus("done");
                    }
                }
                if (statusData.backupError) {
                    setImageSolveBackupError(statusData.backupError);
                    setImageSolveBackupStatus("error");
                }
                if (!primaryAnswer && !primaryScreenshot && statusData.status === "error") {
                    const message = statusData.error || "Image solve failed.";
                    setImageSolveError(message);
                    setImageSolveStatus("error");
                    return true;
                }
                return (
                    statusData.backupStatus === "done" ||
                    statusData.backupStatus === "error" ||
                    Boolean(statusData.backupAnswer) ||
                    Boolean(statusData.backupScreenshot) ||
                    Boolean(statusData.backupError)
                );
            };

            applyData(data);

            if (data.jobId) {
                const pollInterval = setInterval(async () => {
                    try {
                        if (!isCurrentRun()) { clearInterval(pollInterval); return; }
                        const statusRes = await fetch(`/api/image-solve/status?jobId=${data.jobId}`);
                        if (!statusRes.ok) return;
                        const statusData = await readImageSolveResponse(statusRes);
                        if (applyData(statusData)) clearInterval(pollInterval);
                    } catch (e: unknown) { console.error("Status poll error:", e); }
                }, 3000);
            } else if (!data.primaryScreenshot && !data.backupScreenshot) {
                setImageSolveAnswer(data.answer || "(No answer returned)");
                setImageSolveAnswerProvider(data.provider || data.source || null);
                setImageSolveStatus("done");
            }
        } catch (err: unknown) {
            if (!isCurrentRun()) return;
            const message = getErrorMessage(err);
            setImageSolveError(message);
            setImageSolveStatus("error");
        }
    }, [imageSolveStatus, customSolvePrompt, imageSolveProviderOrder, imageSolveProviderEnabled]);

    // ── Retry current result ──────────────────────────────────────────────────
    const handleRetry = useCallback(() => {
        const img = lastSolvedImageBase64;
        const prompt = lastSolvedPrompt ?? customSolvePrompt;
        if (!img) return;
        clearImageSolveResult();
        // Allow state reset to flush, then start the new solve
        setTimeout(() => solveWithUploadedImage(img, prompt, lastSolvedFlipClipboard), 0);
    }, [lastSolvedImageBase64, lastSolvedPrompt, lastSolvedFlipClipboard, customSolvePrompt, clearImageSolveResult, solveWithUploadedImage]);

    // ── Retry from history card with specific provider ─────────────────────────
    const handleRetryItemWithProvider = useCallback((item: StoredImageSolveItem, provider: string) => {
        if (!item.image) return;
        clearImageSolveResult();
        setTimeout(() => solveWithUploadedImage(item.image!, item.prompt ?? undefined, item.flipClipboard ?? false, provider), 0);
    }, [clearImageSolveResult, solveWithUploadedImage]);

    const handleDeleteItem = useCallback(async (jobId: string) => {
        if (!window.confirm("Are you sure you want to permanently delete this record?")) return;
        try {
            const res = await fetch(`/api/image-solve/${jobId}`, { method: 'DELETE' });
            if (res.ok) {
                setImageSolveResults(prev => prev.filter(item => item.id !== jobId));
            } else {
                alert("Failed to delete record.");
            }
        } catch (err) {
            alert("Error deleting record.");
        }
    }, []);

    const clearAllImageSolves = useCallback(async () => {
        if (!window.confirm("Are you sure you want to permanently delete ALL records?")) return;
        try {
            const res = await fetch(`/api/image-solve/all`, { method: 'DELETE' });
            if (res.ok) {
                setImageSolveResults([]);
            } else {
                alert("Failed to clear records.");
            }
        } catch (err) {
            alert("Error clearing records.");
        }
    }, []);

    // ── Countdown for image solve ─────────────────────────────────────────────
    const startImageSolve = () => {
        if (
            imageSolveStatus === "solving" ||
            imageSolveStatus === "capturing" ||
            imageSolveBackupStatus === "queued" ||
            imageSolveBackupStatus === "solving" ||
            imageSolveCountdown !== null
        ) return;
        setImageSolveCountdown(captureDelay);
    };

    useEffect(() => {
        if (imageSolveCountdown === null) return;
        if (imageSolveCountdown > 0) {
            const timer = setTimeout(() => setImageSolveCountdown(imageSolveCountdown - 1), 1000);
            return () => clearTimeout(timer);
        } else {
            setImageSolveCountdown(null);
            captureAndImageSolve();
        }
    }, [imageSolveCountdown, captureAndImageSolve]);

    // ── Solve selected questions ──────────────────────────────────────────────
    const processSelectedQuestions = async () => {
        if (selectedQuestionIds.size === 0 || isProcessingSolutions) return;

        const solvingState = savedQuestions.map(q =>
            selectedQuestionIds.has(q.id) ? { ...q, isSolving: true } : q
        );
        setSavedQuestions(solvingState);
        syncQuestionsToServer(solvingState);

        const targetIds = new Set(selectedQuestionIds);
        let newlySolvedList: ScannedQuestion[] = [];

        try {
            const questionsToSend = Array.from(targetIds)
                .map(id => {
                    const q = savedQuestions.find(sq => sq.id === id);
                    return q ? { id: q.id, text: q.text } : null;
                })
                .filter(Boolean);

            const response = await fetch("/api/solve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ questions: questionsToSend, customSolvePrompt }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `API returned ${response.status}`);
            }

            const data = await response.json();
            const solutions: Record<string, string> = data.solutions || {};

            const updated = savedQuestions.map(q => {
                if (targetIds.has(q.id) && solutions[q.id]) {
                    return { ...q, solution: solutions[q.id], isSolving: false };
                }
                return { ...q, isSolving: false };
            });

            setSavedQuestions(updated);
            await syncQuestionsToServer(updated);

            setExpandedSolutionIds(prev => {
                const next = new Set(prev);
                targetIds.forEach(id => { if (solutions[id]) next.add(id); });
                return next;
            });

            newlySolvedList = updated.filter(q => targetIds.has(q.id) && !!q.solution);
            setSelectedQuestionIds(new Set());
        } catch (error: unknown) {
            console.error("Solve error:", error);
            alert("Failed to process solutions: " + getErrorMessage(error));
            setSavedQuestions(prev => prev.map(q => ({ ...q, isSolving: false })));
        } finally {
            setIsProcessingSolutions(false);
        }

        // Send to WhatsApp strictly after all solve/save operations have completed (if enabled)
        if (sendToWhatsApp && newlySolvedList.length > 0) {
            try {
                const whatsappPayload = newlySolvedList.map(q => ({
                    questionNumber: q.questionNumber,
                    text: q.text,
                    solution: q.solution,
                }));
                await fetch("/api/whatsapp/send-solutions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ solutions: whatsappPayload, delaySeconds: 0, blockDelaySeconds: 0 }),
                });
            } catch (e) {
                console.warn("[WhatsApp] Manual solve dispatch failed:", e);
            }
        }
    };

    // ── Provider Reordering ───────────────────────────────────────────────────
    const moveProviderUp = (index: number) => {
        if (index <= 0) return;
        const newOrder = [...imageSolveProviderOrder];
        [newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]];
        setImageSolveProviderOrder(newOrder);
    };

    const moveProviderDown = (index: number) => {
        if (index >= imageSolveProviderOrder.length - 1) return;
        const newOrder = [...imageSolveProviderOrder];
        [newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]];
        setImageSolveProviderOrder(newOrder);
    };

    // ── Misc scan helpers ─────────────────────────────────────────────────────
    const resetScanner = () => {
        setScanStatus("idle");
        setErrorMessage("");
        setCountdown(null);
    };

    const clearAllQuestions = () => {
        fetch("/api/whatsapp/cancel", { method: "POST" }).catch(() => {});
        setSavedQuestions([]);
        setSelectedQuestionIds(new Set());
        setScanStatus("idle");
        syncClearServerQuestions();
    };

    const deleteQuestion = (idToDelete: string) => {
        setSavedQuestions(prev => prev.filter(q => q.id !== idToDelete));
        setSelectedQuestionIds(prev => { const next = new Set(prev); next.delete(idToDelete); return next; });
        setExpandedSolutionIds(prev => { const next = new Set(prev); next.delete(idToDelete); return next; });
        syncDeleteQuestionFromServer(idToDelete);
    };

    const toggleSolutionExpanded = (id: string) => {
        setExpandedSolutionIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handleCardClick = (id: string, hasSolution: boolean) => {
        if (editingId === id) return;
        if (hasSolution) toggleSolutionExpanded(id); else toggleSelection(id);
    };

    const toggleSelection = (id: string) => {
        if (editingId === id) return;
        setSelectedQuestionIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handlePointerDown = (q: ScannedQuestion) => {
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = setTimeout(() => {
            setEditingId(q.id);
            setEditingText(q.text);
        }, 600);
    };

    const handlePointerUp = () => { if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current); };
    const handlePointerLeave = () => { if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current); };

    const saveEdit = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setSavedQuestions(prev => {
            const next = prev.map(q => q.id === id ? { ...q, text: editingText } : q);
            syncQuestionsToServer(next);
            return next;
        });
        setEditingId(null);
        setEditingText("");
    };

    const cancelEdit = (e: React.MouseEvent) => {
        e.stopPropagation();
        setEditingId(null);
        setEditingText("");
    };

    const filteredQuestions = savedQuestions.filter(q => {
        if (activeTab === "all") return true;
        if (activeTab === "solved") return !!q.solution;
        if (activeTab === "unsolved") return !q.solution;
        return true;
    });

    if (!mounted) return null;

    // ── Derived UI values ─────────────────────────────────────────────────────
    const imageSolveBusy =
        imageSolveStatus === "solving" ||
        imageSolveStatus === "capturing" ||
        imageSolveBackupStatus === "queued" ||
        imageSolveBackupStatus === "solving";

    const imageSolveSelectorLocked =
        imageSolveStatus === "solving" ||
        imageSolveStatus === "capturing" ||
        imageSolveCountdown !== null;

    const enabledProviders = imageSolveProviderOrder.filter(p => imageSolveProviderEnabled[p]);
    const activePrimaryProvider = enabledProviders[0] ?? null;
    const activeBackupProvider = enabledProviders[1] ?? null;

    const imageSolveProviderLabel =
        imageSolveAnswerProvider === "deepseek" ? "DeepSeek Browser" :
            imageSolveAnswerProvider === "gemini" ? "Gemini Browser" :
                imageSolveAnswerProvider === "gemini-api" ? "Gemini API" :
                    "Image Solve";

    const imageSolvePrimaryLabel = getProviderLabel(activePrimaryProvider);
    const imageSolveDisplayedBackupProvider = imageSolveBackupProvider || activeBackupProvider;
    const imageSolveBackupLabel = getProviderLabel(imageSolveDisplayedBackupProvider);

    const hasImageSolveResult =
        (imageSolveStatus === "done" || imageSolveStatus === "error") &&
        Boolean(imageSolveAnswer || imageSolveScreenshot || imageSolveBackupAnswer || imageSolveBackupScreenshot || imageSolveError);

    const canRetry = hasImageSolveResult && Boolean(lastSolvedImageBase64) && !imageSolveBusy;

    // ─── Render ───────────────────────────────────────────────────────────────
    return (
        <div className="scanner-layout">
            {/* Left side: Camera Viewport + Controls */}
            <div className="scanner-section">
                <div className="webcam-container">
                    <video
                        ref={videoRef}
                        className={`webcam-preview ${isCapturing ? "capture-flash" : ""}`}
                        autoPlay
                        muted
                        playsInline
                        onError={() => {
                            console.warn("Video element error — restarting camera.");
                            startCamera();
                        }}
                    />
                    {cameraError && (
                        <div className="camera-error-overlay">
                            <div>
                                <div style={{ marginBottom: '0.75rem' }}>{cameraError}</div>
                                <button
                                    onClick={startCamera}
                                    style={{
                                        background: 'hsl(var(--accent-primary))',
                                        color: '#fff',
                                        border: 'none',
                                        borderRadius: 'var(--radius-sm)',
                                        padding: '0.5rem 1.2rem',
                                        fontWeight: 700,
                                        cursor: 'pointer',
                                        fontSize: '0.9rem',
                                    }}
                                >
                                    ↺ Retry Camera
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Scanning overlay */}
                    {scanStatus === "scanning" && (
                        <div className="scanning-overlay">
                            <div className="scan-line"></div>
                            <div className="scan-text">Analyzing intelligence...</div>
                        </div>
                    )}

                    {/* Countdown Overlay */}
                    {((countdown !== null && countdown > 0) || (imageSolveCountdown !== null && imageSolveCountdown > 0)) && (
                        <div className="countdown-overlay">
                            <span className="countdown-text">{countdown ?? imageSolveCountdown}</span>
                            {countdown !== null && (
                                <div className="countdown-subtext">Position paper · Capturing soon</div>
                            )}
                        </div>
                    )}

                    {/* Darkness Detection Indicator on Video */}
                    {!imageSolveMode && darknessDuration > 0 && countdown === null && (
                        <div className="video-darkness-badge">
                            <span>🌑 Camera Covered: {darknessDuration.toFixed(1)}s / 5.0s</span>
                        </div>
                    )}
                    {!imageSolveMode && darknessDuration > 0 && countdown !== null && (
                        <div className="video-darkness-badge">
                            <span>🌑 Camera Covered — Uncover to capture!</span>
                        </div>
                    )}

                    <div className="camera-corners">
                        <div className="corner top-left"></div>
                        <div className="corner top-right"></div>
                        <div className="corner bottom-left"></div>
                        <div className="corner bottom-right"></div>
                    </div>
                </div>

                <div className="controls">
                    {/* Mode toggle */}
                    <div className="solve-mode-toggle">
                        <button
                            className={`mode-btn ${!imageSolveMode ? 'active' : ''}`}
                            onClick={() => {
                                if (!imageSolveMode) return;
                                setImageSolveMode(false);
                                clearImageSolveResult();
                            }}
                        >
                            📄 Scan Mode
                        </button>
                        <button
                            className={`mode-btn archive-mode-btn ${imageSolveMode ? 'active' : ''}`}
                            onClick={() => {
                                if (imageSolveMode) return;
                                setImageSolveMode(true);
                                clearImageSolveResult();
                                setBottomTab("imagesolve");
                            }}
                        >
                            🧠 Image Solve <span className="archive-pill">Archived</span>
                        </button>
                    </div>

                    {!imageSolveMode ? (
                        <div className="scan-polling-container">
                            <div className={`polling-status-card ${darknessStatus} ${countdown !== null ? 'counting' : ''}`}>
                                <div className="polling-status-header">
                                    <span className={`status-indicator-dot ${darknessStatus}`}></span>
                                    <span className="status-indicator-title">
                                        {countdown !== null
                                            ? `Scan Countdown: ${countdown}s`
                                            : darknessStatus === "covering"
                                                ? `Darkness Detected (${darknessDuration.toFixed(1)}s / 3.5s)`
                                                : darknessStatus === "aborted"
                                                    ? "Scan Aborted (Misfire Protection)"
                                                    : savedQuestions.length > 0
                                                        ? `Auto-Scan Ready (${savedQuestions.length} saved)`
                                                        : "Continuous Polling Active"}
                                    </span>
                                </div>

                                {/* Darkness Progress Bar (0 to 3.5s) */}
                                {countdown === null && darknessStatus !== "aborted" && (
                                    <div className="darkness-meter-wrapper">
                                        <div
                                            className={`darkness-meter-bar ${darknessDuration >= 3.5 ? 'full armed' : ''}`}
                                            style={{ width: `${Math.min(100, (darknessDuration / 3.5) * 100)}%` }}
                                        ></div>
                                    </div>
                                )}

                                <p className="polling-status-desc">
                                    {countdown !== null ? (
                                        darknessDuration > 0 ? (
                                            "Camera is still covered! Uncover camera before countdown ends to scan."
                                        ) : (
                                            "Position paper in view! Capturing automatically when countdown ends..."
                                        )
                                    ) : darknessStatus === "covering" ? (
                                        darknessDuration >= 3.5
                                            ? "3.5s reached! Starting scan countdown..."
                                            : `Hold covered for ${(3.5 - darknessDuration).toFixed(1)}s more to scan next batch...`
                                    ) : darknessStatus === "aborted" ? (
                                        darknessAbortMessage || "Camera remained covered when countdown ended. Uncover camera to resume."
                                    ) : (
                                        savedQuestions.length > 0
                                            ? "Cover camera for 3.5s to scan next batch. New problems are added cumulatively."
                                            : "Cover camera with hand or object for 3.5 seconds to trigger scan."
                                    )}
                                </p>

                                {countdown !== null && (
                                    <button
                                        type="button"
                                        className="cancel-countdown-btn"
                                        onClick={cancelScanCountdown}
                                    >
                                        ✕ Cancel Countdown
                                    </button>
                                )}
                            </div>

                            {/* Secondary manual trigger */}
                            <div className="manual-trigger-row">
                                <button
                                    className={`manual-scan-btn ${countdown !== null ? 'counting' : ''}`}
                                    onClick={startManualScan}
                                    disabled={scanStatus === "scanning" || countdown !== null}
                                    title="Manual scan fallback"
                                >
                                    {countdown !== null ? `Capturing in ${countdown}s` : "📸 Manual Trigger"}
                                </button>
                            </div>

                            <div className="delay-slider-container">
                                <label className="delay-label">
                                    Countdown Timer: <span>{captureDelay}s</span>
                                </label>
                                <input
                                    type="range"
                                    min="3"
                                    max="20"
                                    value={captureDelay}
                                    onChange={(e) => setCaptureDelay(parseInt(e.target.value))}
                                    className="delay-slider"
                                    disabled={scanStatus === "scanning" || countdown !== null}
                                />
                            </div>
                        </div>
                    ) : (
                        <>
                            {/* Archived Feature Banner */}
                            <div className="archived-feature-banner">
                                <span className="archived-banner-icon">📦</span>
                                <div className="archived-banner-text">
                                    <strong>Archived Feature:</strong> Image Solve has been archived. All functionality, history, and solvers remain intact for historical reference.
                                </div>
                            </div>

                            {/* Upload / Camera sub-mode toggle */}
                            <div className="image-solve-source-toggle">
                                <button
                                    className={`image-solve-source-btn ${!imageSolveUploadMode ? 'active' : ''}`}
                                    onClick={() => {
                                        setImageSolveUploadMode(false);
                                        clearImageSolveResult();
                                    }}
                                    disabled={imageSolveBusy || imageSolveCountdown !== null}
                                >Camera</button>
                                <button
                                    className={`image-solve-source-btn ${imageSolveUploadMode ? 'active' : ''}`}
                                    onClick={() => {
                                        setImageSolveUploadMode(true);
                                        clearImageSolveResult();
                                    }}
                                    disabled={imageSolveBusy || imageSolveCountdown !== null}
                                >Upload</button>
                            </div>

                            {/* ── Provider Setup ── */}
                            <div className="provider-setup">
                                <div className="provider-setup-label">Providers <span className="provider-setup-hint">(use arrows to reorder · check to enable)</span></div>
                                <div className="provider-list">
                                    {imageSolveProviderOrder.map((providerId, index) => {
                                        const providerInfo = ALL_SOLVE_PROVIDERS.find(p => p.id === providerId);
                                        const isEnabled = imageSolveProviderEnabled[providerId] ?? false;
                                        const enabledIdx = enabledProviders.indexOf(providerId);

                                        return (
                                            <div
                                                key={providerId}
                                                className={`provider-list-item${!isEnabled ? ' disabled-provider' : ''}`}
                                            >
                                                <div className="provider-reorder-actions">
                                                    <button 
                                                        className="reorder-btn" 
                                                        onClick={() => moveProviderUp(index)}
                                                        disabled={index === 0 || imageSolveSelectorLocked}
                                                        title="Move Up"
                                                    >▲</button>
                                                    <button 
                                                        className="reorder-btn" 
                                                        onClick={() => moveProviderDown(index)}
                                                        disabled={index === imageSolveProviderOrder.length - 1 || imageSolveSelectorLocked}
                                                        title="Move Down"
                                                    >▼</button>
                                                </div>
                                                <input
                                                    type="checkbox"
                                                    id={`provider-chk-${providerId}`}
                                                    checked={isEnabled}
                                                    onChange={(e) => {
                                                        setImageSolveProviderEnabled(prev => ({
                                                            ...prev,
                                                            [providerId]: e.target.checked,
                                                        }));
                                                    }}
                                                    disabled={imageSolveSelectorLocked}
                                                />
                                                <label
                                                    htmlFor={`provider-chk-${providerId}`}
                                                    className="provider-list-label"
                                                >
                                                    {providerInfo?.label ?? providerId}
                                                </label>
                                                {isEnabled && enabledIdx >= 0 && (
                                                    <span className={`provider-priority-badge${enabledIdx === 1 ? ' backup' : ''}`}>
                                                        {enabledIdx === 0 ? 'Primary' : 'Backup'}
                                                    </span>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                                {enabledProviders.length === 0 && (
                                    <p className="provider-setup-warning">⚠ Enable at least one provider to solve.</p>
                                )}
                            </div>

                            {imageSolveUploadMode ? (
                                <>
                                    {/* File upload zone */}
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        multiple
                                        accept="image/*"
                                        className="image-upload-file-input"
                                        disabled={imageSolveBusy}
                                        onChange={(e) => {
                                            const files = e.target.files;
                                            if (files) handleFilesUpload(files);
                                            e.target.value = '';
                                        }}
                                    />
                                    <div
                                        className={`image-upload-zone ${uploadedImagePreviews.length > 0 ? 'has-preview' : ''} ${imageSolveBusy ? 'disabled' : ''}`}
                                        onClick={() => !imageSolveBusy && fileInputRef.current?.click()}
                                        onDragOver={(e) => e.preventDefault()}
                                        onDrop={(e) => {
                                            e.preventDefault();
                                            const files = e.dataTransfer.files;
                                            if (files) handleFilesUpload(files);
                                        }}
                                    >
                                        {uploadedImagePreviews.length > 0 ? (
                                            uploadedImagePreviews.length === 1 ? (
                                                <img src={uploadedImagePreviews[0]} alt="Uploaded preview" className="image-upload-preview" />
                                            ) : (
                                                <div className="image-upload-batch-preview">
                                                    <span className="batch-count" style={{ fontSize: '24px', fontWeight: 'bold' }}>{uploadedImagePreviews.length} images ready</span>
                                                    <span className="batch-hint" style={{ display: 'block', marginTop: '10px' }}>Tap to re-select</span>
                                                </div>
                                            )
                                        ) : (
                                            <div className="image-upload-placeholder">
                                                <span className="image-upload-icon">📷</span>
                                                <span className="image-upload-hint">Tap to choose image(s)</span>
                                                <span className="image-upload-hint-sub">or drag &amp; drop</span>
                                            </div>
                                        )}
                                    </div>
                                    <button
                                        className={`capture-btn image-solve-btn ${imageSolveBusy ? 'counting' : ''}`}
                                        onClick={() => { if (uploadedImagesBase64.length > 0) solveBatchUploadedImages(uploadedImagesBase64); }}
                                        disabled={imageSolveBusy || uploadedImagesBase64.length === 0 || enabledProviders.length === 0}
                                    >
                                        <div className="capture-inner"></div>
                                    </button>
                                    <p className="instruction-text" style={{ marginTop: '0.5rem', marginBottom: '1rem' }}>
                                        {imageSolveStatus === 'solving' && !imageSolveBrowserError && `Sending to ${imageSolvePrimaryLabel} via browser...`}
                                        {imageSolveStatus === 'solving' && imageSolveBrowserError && 'Browser solve failed. Running fallback...'}
                                        {imageSolveStatus === 'done' && imageSolveBackupStatus !== 'queued' && imageSolveBackupStatus !== 'solving' && 'Result received!'}
                                        {imageSolveStatus === 'done' && (imageSolveBackupStatus === 'queued' || imageSolveBackupStatus === 'solving') && `${imageSolvePrimaryLabel} screenshot received. Waiting for ${imageSolveBackupLabel} backup...`}
                                        {imageSolveStatus === 'error' && '❌ ' + imageSolveError}
                                        {imageSolveStatus === 'idle' && uploadedImagesBase64.length === 0 && 'Choose image(s) to solve'}
                                        {imageSolveStatus === 'idle' && uploadedImagesBase64.length > 0 && `Tap the button to send ${uploadedImagesBase64.length > 1 ? 'batch' : 'image'}`}
                                    </p>
                                </>
                            ) : (
                                <>
                                    <button
                                        className={`capture-btn image-solve-btn ${imageSolveBusy || imageSolveCountdown !== null ? 'counting' : ''}`}
                                        onClick={startImageSolve}
                                        disabled={imageSolveBusy || imageSolveCountdown !== null || enabledProviders.length === 0}
                                    >
                                        <div className="capture-inner"></div>
                                    </button>
                                    <p className="instruction-text" style={{ marginTop: '0.5rem', marginBottom: '1rem' }}>
                                        {imageSolveCountdown !== null && `Position paper. Capturing in ${imageSolveCountdown}s...`}
                                        {imageSolveCountdown === null && imageSolveStatus === 'capturing' && 'Capturing image...'}
                                        {imageSolveCountdown === null && imageSolveStatus === 'solving' && !imageSolveBrowserError && `Sending to ${imageSolvePrimaryLabel} via browser...`}
                                        {imageSolveCountdown === null && imageSolveStatus === 'solving' && imageSolveBrowserError && 'Browser solve failed. Running fallback...'}
                                        {imageSolveCountdown === null && imageSolveStatus === 'done' && imageSolveBackupStatus !== 'queued' && imageSolveBackupStatus !== 'solving' && 'Result received!'}
                                        {imageSolveCountdown === null && imageSolveStatus === 'done' && (imageSolveBackupStatus === 'queued' || imageSolveBackupStatus === 'solving') && `${imageSolvePrimaryLabel} screenshot received. Waiting for ${imageSolveBackupLabel} backup...`}
                                        {imageSolveCountdown === null && imageSolveStatus === 'error' && '❌ ' + imageSolveError}
                                        {imageSolveCountdown === null && imageSolveStatus === 'idle' && `Tap to start ${captureDelay}-second image solve timer`}
                                    </p>

                                    <div className="delay-slider-container">
                                        <label className="delay-label">
                                            Capture Delay: <span>{captureDelay}s</span>
                                        </label>
                                        <input
                                            type="range"
                                            min="1"
                                            max="20"
                                            value={captureDelay}
                                            onChange={(e) => setCaptureDelay(parseInt(e.target.value))}
                                            className="delay-slider"
                                            disabled={imageSolveBusy || imageSolveCountdown !== null}
                                        />
                                    </div>
                                </>
                            )}

                            {/* Result panel */}
                            {hasImageSolveResult && (
                                <div className="image-solve-result">
                                    <div className="image-solve-result-header">
                                        <span>{imageSolveProviderLabel} Result</span>
                                        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                                            {canRetry && (
                                                <button
                                                    className="retry-btn"
                                                    onClick={handleRetry}
                                                    disabled={imageSolveBusy}
                                                    title="Retry with same image"
                                                >
                                                    ↺ Retry
                                                </button>
                                            )}
                                            {imageSolveJobId && (
                                                <button
                                                    className="delete-btn"
                                                    onClick={() => {
                                                        handleDeleteItem(imageSolveJobId);
                                                        clearImageSolveResult();
                                                    }}
                                                    title="Permanently delete this record"
                                                    style={{ background: 'rgba(255,59,48,0.1)', color: '#ff3b30', border: '1px solid rgba(255,59,48,0.3)', borderRadius: '4px', padding: '0.2rem 0.5rem', cursor: 'pointer' }}
                                                >
                                                    🗑️ Delete
                                                </button>
                                            )}
                                            {!imageSolveJobId && (
                                                <button
                                                    className="delete-btn"
                                                    onClick={clearImageSolveResult}
                                                >✕</button>
                                            )}
                                        </div>
                                    </div>
                                    {imageSolveAnswer && (
                                        <div className="image-solve-result-body">
                                            {imageSolveAnswer}
                                        </div>
                                    )}
                                    {imageSolveError && !imageSolveAnswer && (
                                        <div className="image-solve-result-body" style={{ color: 'hsl(var(--accent-danger))' }}>
                                            {imageSolveError}
                                        </div>
                                    )}
                                    {imageSolveScreenshot && (
                                        <div className="solver-screenshot-card">
                                            <div className="solver-screenshot-label">{imageSolveProviderLabel} Screenshot</div>
                                            <button
                                                className="solver-screenshot-button"
                                                onClick={() => setExpandedSolverScreenshot({ src: imageSolveScreenshot, label: `${imageSolveProviderLabel} Screenshot` })}
                                                aria-label={`Expand ${imageSolveProviderLabel} screenshot`}
                                            >
                                                <img src={imageSolveScreenshot} alt={`${imageSolveProviderLabel} solver screenshot`} />
                                            </button>
                                        </div>
                                    )}
                                    {(imageSolveBackupStatus === 'queued' || imageSolveBackupStatus === 'solving') && (
                                        <div className="image-solve-backup">
                                            {imageSolveBackupLabel} backup is still running...
                                        </div>
                                    )}
                                    {imageSolveBackupStatus === 'done' && (imageSolveBackupAnswer || imageSolveBackupScreenshot) && (
                                        <div className="image-solve-backup">
                                            <div className="image-solve-backup-title">{imageSolveBackupLabel} Backup Result</div>
                                            {imageSolveBackupAnswer && <div>{imageSolveBackupAnswer}</div>}
                                            {imageSolveBackupScreenshot && (
                                                <div className="solver-screenshot-card backup">
                                                    <div className="solver-screenshot-label">{imageSolveBackupLabel} Screenshot</div>
                                                    <button
                                                        className="solver-screenshot-button"
                                                        onClick={() => setExpandedSolverScreenshot({ src: imageSolveBackupScreenshot, label: `${imageSolveBackupLabel} Screenshot` })}
                                                        aria-label={`Expand ${imageSolveBackupLabel} screenshot`}
                                                    >
                                                        <img src={imageSolveBackupScreenshot} alt={`${imageSolveBackupLabel} solver screenshot`} />
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {imageSolveBackupStatus === 'error' && imageSolveBackupError && (
                                        <div className="image-solve-backup error">
                                            {imageSolveBackupLabel} backup failed: {imageSolveBackupError}
                                        </div>
                                    )}
                                </div>
                            )}

                        </>
                    )}


                    <button
                        className="settings-btn"
                        onClick={() => setIsSettingsOpen(true)}
                        title="Settings"
                    >
                        ⚙️ Settings
                    </button>
                </div>
            </div>

            {/* Settings Overlay */}
            {isSettingsOpen && (
                <div className="settings-overlay" onClick={() => {
                    setIsSettingsOpen(false);
                    syncPromptsToServer(customSolvePrompt);
                }}>
                    <div className="settings-modal" style={{ maxWidth: "640px", maxHeight: "88vh" }} onClick={e => e.stopPropagation()}>
                        <div className="settings-header">
                            <h3>Settings & Prompt Rules</h3>
                            <button className="close-btn" onClick={() => {
                                setIsSettingsOpen(false);
                                syncPromptsToServer(customSolvePrompt);
                            }}>✕</button>
                        </div>

                        <div className="settings-content" style={{ overflowY: "auto", flex: 1, padding: "1.25rem 1.5rem" }}>
                            {/* WhatsApp Integration Setting */}
                            <div className="settings-field" style={{ marginBottom: "1.5rem", paddingBottom: "1.25rem", borderBottom: "1px solid hsla(0, 0%, 100%, 0.1)" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <div>
                                        <div style={{ fontWeight: 600, fontSize: "0.95rem", color: "hsl(var(--text-primary))", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                                            <span>💬 WhatsApp Forwarding</span>
                                            <span style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem", borderRadius: "10px", background: sendToWhatsApp ? "hsla(140, 70%, 40%, 0.2)" : "hsla(0, 0%, 40%, 0.2)", color: sendToWhatsApp ? "hsl(140, 80%, 65%)" : "hsl(0, 0%, 65%)" }}>
                                                {sendToWhatsApp ? "Enabled" : "Disabled"}
                                            </span>
                                        </div>
                                        <span className="settings-hint" style={{ marginTop: "0.25rem", display: "block" }}>
                                            Automatically forward solved questions & answers to WhatsApp after solving completes.
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        className={`whatsapp-toggle-btn ${sendToWhatsApp ? "enabled" : "disabled"}`}
                                        onClick={() => {
                                            setSendToWhatsApp(prev => {
                                                const next = !prev;
                                                localStorage.setItem("scannerApp_sendToWhatsApp", String(next));
                                                return next;
                                            });
                                        }}
                                        style={{ padding: "0.5rem 1rem", fontSize: "0.85rem" }}
                                    >
                                        <span className="toggle-dot" />
                                        <span>{sendToWhatsApp ? "ON" : "OFF"}</span>
                                    </button>
                                </div>
                            </div>

                            <label className="settings-label">
                                AI Solve System Prompt
                                <span className="settings-hint">
                                    Defines how AI models solve the scanned questions. JSON formatting instructions are appended automatically. Synced across all connected devices.
                                </span>
                            </label>
                            <textarea
                                className="settings-textarea"
                                style={{ minHeight: "280px", fontFamily: "monospace", fontSize: "0.85rem", lineHeight: "1.4" }}
                                value={customSolvePrompt}
                                onChange={(e) => setCustomSolvePrompt(e.target.value)}
                                placeholder={defaultSolvePrompt}
                            />
                            <div className="settings-actions">
                                <button className="reset-btn" onClick={() => {
                                    setCustomSolvePrompt(defaultSolvePrompt);
                                    syncPromptsToServer(defaultSolvePrompt);
                                }}>
                                    Reset Default
                                </button>
                                <button className="process-btn" onClick={() => {
                                    setIsSettingsOpen(false);
                                    syncPromptsToServer(customSolvePrompt);
                                }}>
                                    Done
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Right side: Results */}
            <div className="results-section">
                <div className="results-header">
                    <div className="bottom-tab-bar">
                        <button
                            className={`tab-btn ${bottomTab === "questions" ? "active" : ""}`}
                            onClick={() => setBottomTab("questions")}
                        >
                            Questions ({savedQuestions.length})
                        </button>
                        <button
                            className={`tab-btn ${bottomTab === "captures" ? "active" : ""}`}
                            onClick={() => { setBottomTab("captures"); pollServerCaptures(); }}
                        >
                            📸 Captures ({syncedCaptures.length})
                        </button>
                        <button
                            className={`tab-btn ${bottomTab === "imagesolve" ? "active" : ""}`}
                            onClick={() => { setBottomTab("imagesolve"); fetchHistory(); }}
                        >
                            Image Solve Stack ({imageSolveResults.length}) <span className="archive-pill tab">Archived</span>
                        </button>
                    </div>
                    {bottomTab === "questions" && <div style={{ display: "flex", gap: "0.5rem" }}>
                        {selectedQuestionIds.size > 0 && (
                            <button
                                className="process-btn"
                                onClick={processSelectedQuestions}
                                disabled={isProcessingSolutions}
                            >
                                {isProcessingSolutions ? 'Processing...' : `Process (${selectedQuestionIds.size})`}
                            </button>
                        )}
                        {(scanStatus === "error" || scanStatus === "success") && (
                            <button className="reset-btn" onClick={resetScanner}>Clear Status</button>
                        )}
                        {savedQuestions.length > 0 && (
                            <button className="reset-btn danger" onClick={clearAllQuestions}>Clear All</button>
                        )}
                    </div>}
                    {bottomTab === "captures" && <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        <span className={`sync-status-badge ${capturesSyncStatus}`} style={{ fontSize: "0.72rem" }}>
                            <span className="sync-dot" />
                            <span>{capturesSyncStatus === "syncing" ? "Syncing..." : capturesSyncStatus === "synced" ? "Synced" : "Offline"}</span>
                        </span>
                        <button
                            className="tab-action-btn"
                            onClick={() => pollServerCaptures()}
                            title="Refresh Captures"
                        >
                            🔄 Refresh
                        </button>
                        {syncedCaptures.length > 0 && (
                            <button className="reset-btn danger" onClick={clearAllCaptures}>Clear All</button>
                        )}
                    </div>}
                    {bottomTab === "imagesolve" && <div style={{ display: "flex", gap: "0.5rem" }}>
                        {imageSolveResults.length > 0 && (
                            <button className="reset-btn danger" onClick={clearAllImageSolves}>Clear All</button>
                        )}
                    </div>}
                </div>

                {bottomTab === "imagesolve" && (
                    <div className="polling-results-panel image-solve-history-panel" style={{ margin: 0, border: 'none', boxShadow: 'none' }}>
                        {!isImageSolveResultsLoaded && (
                            <div className="polling-results-empty">Loading...</div>
                        )}
                        {isImageSolveResultsLoaded && imageSolveResults.length === 0 && (
                            <div className="polling-results-empty">No image solves yet.</div>
                        )}
                        {imageSolveResults.map((item) => {
                            const itemProviderLabel = getProviderLabel(item.answerProvider || item.primaryProvider);
                            const displayScreenshot = item.screenshot || item.backupScreenshot || null;
                            const screenshotLabel = item.screenshot
                                ? `${getProviderLabel(item.primaryProvider)} Screenshot`
                                : item.backupScreenshot ? `${getProviderLabel(item.backupProvider)} Backup Screenshot` : "";
                            return (
                                <div className={`polling-result-card ${item.status}`} key={item.id}>
                                    <button
                                        className="polling-result-image"
                                        onClick={() => displayScreenshot && setExpandedSolverScreenshot({ src: displayScreenshot, label: screenshotLabel })}
                                        disabled={!displayScreenshot}
                                        title={displayScreenshot ? "View screenshot" : "No screenshot yet"}
                                    >
                                        {displayScreenshot
                                            ? <img src={displayScreenshot} alt="AI response screenshot" />
                                            : <span style={{ fontSize: '0.7rem', opacity: 0.5 }}>{item.status === 'solving' || item.status === 'capturing' ? '⏳' : 'No screenshot'}</span>
                                        }
                                    </button>
                                    <div className="polling-result-content">
                                        <div className="polling-result-meta">
                                            <span>{new Date(item.createdAt).toLocaleTimeString()}</span>
                                            <span>{item.status}</span>
                                            <span>{itemProviderLabel}</span>
                                        </div>
                                        {item.answer && <div className="polling-result-answer">{item.answer}</div>}
                                        {item.error && !item.screenshot && <div className="polling-result-error">{item.error}</div>}
                                        {(item.backupStatus === "queued" || item.backupStatus === "solving") && (
                                            <div className="polling-result-warning">{getProviderLabel(item.backupProvider)} backup running...</div>
                                        )}
                                        {item.backupAnswer && <div className="polling-result-answer">{item.backupAnswer}</div>}
                                        {item.backupError && <div className="polling-result-error">{item.backupError}</div>}
                                        {item.image && item.status !== "solving" && item.status !== "capturing" && (
                                            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                                                <button
                                                    className="retry-btn"
                                                    onClick={() => handleRetryItemWithProvider(item, 'deepseek')}
                                                    disabled={imageSolveBusy}
                                                    title="Retry with DeepSeek"
                                                    style={{ flex: 1 }}
                                                >
                                                    ↺ DeepSeek
                                                </button>
                                                <button
                                                    className="retry-btn"
                                                    onClick={() => handleRetryItemWithProvider(item, 'gemini')}
                                                    disabled={imageSolveBusy}
                                                    title="Retry with Gemini"
                                                    style={{ flex: 1 }}
                                                >
                                                    ↺ Gemini
                                                </button>
                                                <button
                                                    className="delete-btn"
                                                    onClick={() => handleDeleteItem(item.id)}
                                                    disabled={imageSolveBusy}
                                                    title="Delete this record"
                                                    style={{ 
                                                        flex: 1, 
                                                        background: 'rgba(255, 59, 48, 0.1)', 
                                                        color: '#ff3b30',
                                                        border: '1px solid rgba(255, 59, 48, 0.3)',
                                                        borderRadius: '8px',
                                                        padding: '0.5rem',
                                                        fontSize: '0.9rem',
                                                        fontWeight: 600,
                                                        cursor: 'pointer'
                                                    }}
                                                >
                                                    🗑️ Delete
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {bottomTab === "captures" && (
                    <div className="captures-tab-panel">
                        {/* Filter pills bar */}
                        {syncedCaptures.length > 0 && (
                            <div className="captures-filter-bar">
                                <div className="tabs-container" style={{ marginBottom: 0 }}>
                                    <button
                                        className={`tab-btn ${capturesFilter === "all" ? "active" : ""}`}
                                        onClick={() => setCapturesFilter("all")}
                                    >
                                        All ({syncedCaptures.length})
                                    </button>
                                    <button
                                        className={`tab-btn ${capturesFilter === "scan" ? "active" : ""}`}
                                        onClick={() => setCapturesFilter("scan")}
                                    >
                                        Scan Mode ({syncedCaptures.filter(c => c.type === "scan").length})
                                    </button>
                                    <button
                                        className={`tab-btn ${capturesFilter === "solve" ? "active" : ""}`}
                                        onClick={() => setCapturesFilter("solve")}
                                    >
                                        Solve Mode ({syncedCaptures.filter(c => c.type === "solve").length})
                                    </button>
                                </div>
                            </div>
                        )}

                        {syncedCaptures.length === 0 && (
                            <div className="empty-state">
                                <div className="empty-icon">📸</div>
                                <p style={{ fontWeight: 600, fontSize: "1.05rem", color: "hsl(var(--text-primary))", margin: "0.5rem 0" }}>No Captured Images Yet</p>
                                <p style={{ fontSize: "0.85rem", color: "hsl(var(--text-secondary))", maxWidth: "340px", textAlign: "center" }}>
                                    When you capture an image using the camera (Scan or Image Solve), it will automatically be synced here across all your connected devices in real time.
                                </p>
                            </div>
                        )}

                        {syncedCaptures.length > 0 && (
                            <div className="captures-grid">
                                {syncedCaptures
                                    .filter(c => capturesFilter === "all" || c.type === capturesFilter)
                                    .map(capture => (
                                        <div key={capture.id} className="capture-card">
                                            <div
                                                className="capture-thumb-wrapper"
                                                onClick={() => setActiveCaptureModal(capture)}
                                            >
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img
                                                    src={capture.imageData}
                                                    alt={`Capture ${capture.id}`}
                                                    className="capture-thumb-img"
                                                    loading="lazy"
                                                />
                                                <div className="capture-overlay-hover">
                                                    <span>🔍 View Large</span>
                                                </div>
                                                <span className={`capture-type-pill ${capture.type}`}>
                                                    {capture.type === "scan" ? "📄 Scan" : "⚡ Solve"}
                                                </span>
                                            </div>
                                            <div className="capture-card-body">
                                                <div className="capture-meta">
                                                    <span className="capture-time">
                                                        {new Date(capture.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                                    </span>
                                                    <span className="capture-date">
                                                        {new Date(capture.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                                                    </span>
                                                </div>
                                                <div className="capture-card-actions">
                                                    <button
                                                        type="button"
                                                        className="capture-action-btn primary"
                                                        onClick={() => reScanCapture(capture)}
                                                        title="Scan questions from this image"
                                                    >
                                                        ⚡ Scan
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="capture-action-btn"
                                                        onClick={() => downloadCaptureImage(capture)}
                                                        title="Download image"
                                                    >
                                                        ⬇️
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="capture-action-btn danger"
                                                        onClick={() => deleteCapture(capture.id)}
                                                        title="Delete from all devices"
                                                    >
                                                        🗑️
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                            </div>
                        )}
                    </div>
                )}

                {bottomTab === "questions" && savedQuestions.length > 0 && (
                    <div className="questions-header-bar">
                        <div className="tabs-container" style={{ marginBottom: 0 }}>
                            <button
                                className={`tab-btn ${activeTab === "all" ? "active" : ""}`}
                                onClick={() => setActiveTab("all")}
                            >
                                All ({savedQuestions.length})
                            </button>
                            <button
                                className={`tab-btn ${activeTab === "unsolved" ? "active" : ""}`}
                                onClick={() => setActiveTab("unsolved")}
                            >
                                Unsolved ({savedQuestions.filter(q => !q.solution).length})
                            </button>
                            <button
                                className={`tab-btn ${activeTab === "solved" ? "active" : ""}`}
                                onClick={() => setActiveTab("solved")}
                            >
                                Solved ({savedQuestions.filter(q => !!q.solution).length})
                            </button>
                        </div>

                        <div className="questions-toolbar-actions">
                            {savedQuestions.some(q => !!q.solution) && (
                                <>
                                    <button
                                        type="button"
                                        className={`toolbar-action-btn ${copiedAll ? "success" : ""}`}
                                        onClick={copyAllSolutions}
                                        title="Copy all solved questions and answers to clipboard"
                                    >
                                        {copiedAll ? "✓ Copied All" : "📋 Copy All"}
                                    </button>
                                    <button
                                        type="button"
                                        className="toolbar-action-btn"
                                        onClick={toggleExpandAll}
                                        title="Toggle expand/collapse on all solutions"
                                    >
                                        ↕️ {savedQuestions.filter(q => !!q.solution).every(q => expandedSolutionIds.has(q.id)) ? "Collapse All" : "Expand All"}
                                    </button>
                                </>
                            )}

                            <button
                                type="button"
                                className="toolbar-action-btn danger"
                                onClick={clearAllQuestions}
                                title="Clear all questions"
                            >
                                🗑️ Clear All
                            </button>

                            <div
                                className={`sync-status-badge ${syncStatus}`}
                                title={syncStatus === "synced" ? "Synced with server & other devices" : syncStatus === "syncing" ? "Syncing changes..." : "Server offline"}
                            >
                                <span className="sync-dot"></span>
                                <span>{syncStatus === "synced" ? "Synced" : syncStatus === "syncing" ? "Syncing..." : "Offline"}</span>
                            </div>
                        </div>
                    </div>
                )}

                {bottomTab === "questions" && <div className="results-content">
                    {scanStatus === "idle" && savedQuestions.length === 0 && (
                        <div className="empty-state">
                            <div className="empty-icon">📄</div>
                            <p>Scan a question paper to add questions.</p>
                        </div>
                    )}

                    {scanStatus === "scanning" && (
                        <div className="loading-state">
                            <div className="spinner"></div>
                            <p>Extracting text literally...</p>
                        </div>
                    )}

                    {scanStatus === "error" && (
                        <div className="error-state">
                            <p className="error-icon">⚠️</p>
                            <p>{errorMessage}</p>
                        </div>
                    )}

                    {savedQuestions.length > 0 && filteredQuestions.length === 0 && (
                        <div className="empty-state" style={{ marginTop: '2rem' }}>
                            <p>No {activeTab} questions found.</p>
                        </div>
                    )}

                    {filteredQuestions.length > 0 && (
                        <div className="questions-list">
                            {filteredQuestions.map((q, idx) => {
                                return (
                                <div
                                    key={q.id || idx}
                                    ref={(el) => {
                                        if (el) questionCardRefs.current.set(q.id, el);
                                        else questionCardRefs.current.delete(q.id);
                                    }}
                                    className={`question-card ${selectedQuestionIds.has(q.id) ? 'selected' : ''}`}
                                    onClick={() => handleCardClick(q.id, !!q.solution)}
                                    onPointerDown={(e) => {
                                        if ((e.target as HTMLElement).tagName.toLowerCase() !== 'input' && editingId !== q.id) {
                                            handlePointerDown(q);
                                        }
                                    }}
                                    onPointerUp={handlePointerUp}
                                    onPointerLeave={handlePointerLeave}
                                    onPointerCancel={handlePointerLeave}
                                    onPointerMove={handlePointerUp}
                                    style={{ animationDelay: `${idx * 0.05}s` }}
                                >
                                    <div className="question-header">
                                        <div className="question-header-left">
                                            <input
                                                type="checkbox"
                                                className="question-checkbox"
                                                checked={selectedQuestionIds.has(q.id)}
                                                onChange={() => toggleSelection(q.id)}
                                                onClick={(e) => e.stopPropagation()}
                                            />
                                            <span className="question-number">Question {q.questionNumber}</span>
                                        </div>
                                        <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                                            {q.solution && (
                                                <button
                                                    type="button"
                                                    className={`card-copy-btn ${copiedId === q.id ? "copied" : ""}`}
                                                    onClick={(e) => copyQuestionAndSolution(q, e)}
                                                    title="Copy Question and Solution"
                                                >
                                                    {copiedId === q.id ? "✓ Copied" : "📋 Copy"}
                                                </button>
                                            )}
                                            <button
                                                className="delete-btn"
                                                onClick={(e) => { e.stopPropagation(); deleteQuestion(q.id); }}
                                                aria-label="Delete question"
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    </div>

                                    {editingId === q.id ? (
                                        <div className="edit-mode-container" onClick={(e) => e.stopPropagation()}>
                                            <textarea
                                                className="edit-textarea"
                                                value={editingText}
                                                onChange={(e) => setEditingText(e.target.value)}
                                                autoFocus
                                                rows={5}
                                            />
                                            <div className="edit-controls">
                                                <button className="reset-btn danger" onClick={cancelEdit}>Cancel</button>
                                                <button className="process-btn" style={{ padding: '0.4rem 1.5rem' }} onClick={(e) => saveEdit(q.id, e)}>Save</button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="question-body">{q.text}</div>
                                    )}

                                    {(q.solution || q.isSolving) && !editingId && (
                                        <div className="question-solution">
                                            <h4>
                                                AI Solution
                                                {q.solution && (
                                                    <span style={{ fontSize: '0.7em', float: 'right', opacity: 0.7, textTransform: 'none' }}>
                                                        {expandedSolutionIds.has(q.id) ? '▲ Tap to collapse' : '▼ Tap to expand'}
                                                    </span>
                                                )}
                                            </h4>
                                            {q.isSolving ? (
                                                <div className="solution-loading">
                                                    <div className="spinner-small"></div>
                                                    <span>Generating answer...</span>
                                                </div>
                                            ) : expandedSolutionIds.has(q.id) && (
                                                <div className="solution-text">
                                                    {renderFormattedSolution(q.solution)}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                                );
                            })}
                        </div>
                    )}
                </div>}
            </div>

            {/* Screenshot expanded overlay */}
            {expandedSolverScreenshot && (
                <div className="solver-screenshot-overlay" onClick={() => setExpandedSolverScreenshot(null)}>
                    <div className="solver-screenshot-expanded" onClick={(e) => e.stopPropagation()}>
                        <div className="solver-screenshot-expanded-title">{expandedSolverScreenshot.label}</div>
                        <img src={expandedSolverScreenshot.src} alt={expandedSolverScreenshot.label} />
                        <button
                            className="solver-screenshot-close"
                            onClick={() => setExpandedSolverScreenshot(null)}
                        >
                            Close
                        </button>
                    </div>
                </div>
            )}

            {/* Capture Lightbox / Preview Modal */}
            {activeCaptureModal && (
                <div className="settings-overlay capture-modal-overlay" onClick={() => setActiveCaptureModal(null)}>
                    <div className="capture-modal-content" onClick={e => e.stopPropagation()}>
                        <div className="capture-modal-header">
                            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                                <span className={`capture-type-pill ${activeCaptureModal.type}`} style={{ position: "static" }}>
                                    {activeCaptureModal.type === "scan" ? "📄 Scan Frame" : "⚡ Solve Frame"}
                                </span>
                                <span style={{ fontSize: "0.85rem", color: "hsl(var(--text-secondary))" }}>
                                    {new Date(activeCaptureModal.createdAt).toLocaleString()}
                                </span>
                            </div>
                            <button className="close-btn" onClick={() => setActiveCaptureModal(null)}>✕</button>
                        </div>
                        <div className="capture-modal-body">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={activeCaptureModal.imageData}
                                alt="Capture preview"
                                className="capture-modal-img"
                            />
                        </div>
                        <div className="capture-modal-footer">
                            <button
                                className="process-btn"
                                onClick={() => {
                                    const cap = activeCaptureModal;
                                    setActiveCaptureModal(null);
                                    reScanCapture(cap);
                                }}
                            >
                                ⚡ Scan Questions from Image
                            </button>
                            <button
                                className="tab-action-btn"
                                onClick={() => downloadCaptureImage(activeCaptureModal)}
                            >
                                ⬇️ Download
                            </button>
                            <button
                                className="reset-btn danger"
                                onClick={() => deleteCapture(activeCaptureModal.id)}
                            >
                                🗑️ Delete Everywhere
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
