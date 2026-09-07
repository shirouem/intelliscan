import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { getBrowserServiceUrl } from "@/app/api/image-solve-capture/browserService";

if (typeof (globalThis as any).geminiKeyIndex === "undefined") {
    (globalThis as any).geminiKeyIndex = 0;
}

export const maxDuration = 120;

const WHATSAPP_PLAIN_TEXT_SYSTEM_PROMPT = `You are an expert CBSE Class 12th Chemistry & STEM Plain-Text Solution Formatter.
Your task is to convert written solutions into clean, crystal-clear, unambiguous plain text formatted specifically for messaging on WhatsApp and viewing in basic text editors (like Notepad) without requiring any LaTeX or special font rendering.

CRITICAL FORMATTING RULES:

1. NO UNRENDERABLE SUPERSCRIPTS OR SUBSCRIPTS:
   - Absolutely DO NOT use Unicode superscripts (like ², ³, ⁺, ⁻, ²⁺, ⁴⁻) or Unicode subscripts (like ₂, ₄). Many text editors and mobile fonts fail to render them, showing broken boxes or question marks.
   - For ionic charges: Use standard caret or parentheses, e.g. "Zn^2+" or "Zn(2+)", "Cu^2+", "Al^3+", "Fe^2+", "Fe^3+", "Cl^-", "SO4^2-", "[Fe(CN)6]^4-", "e^-".
   - For subshell electronic configurations: ALWAYS use caret "^", e.g. "1s^2 2s^2 2p^6 3s^2 3p^6 3d^10 4s^2" or "[Ar] 3d^5 4s^1", "[Ar] 3d^10 4s^1". Never write unrendered unicode like 3d⁵ 4s¹.
   - For chemical molecular formulas: Write standard ASCII numbers without subscript, e.g. "H2O", "H2SO4", "KMnO4", "K2Cr2O7", "CH3-CH2-OH", "Ca(OH)2".

2. ZERO LATEX OR MARKDOWN CODE:
   - Absolutely NO LaTeX markup (never output \\frac, \\sqrt, \\text, \\left, \\right, \\cdot, \\times, \\pm, \\approx, \\mathbf, \\(, \\), \\[, \\], $, or \\begin/\\end blocks).
   - WhatsApp cannot render LaTeX or MathJax; every single formula must be in readable ASCII text.

3. UNAMBIGUOUS MATHEMATICAL & PHYSICAL CHEMISTRY NOTATION:
   - Fractions: Always write as (numerator) / (denominator) with parentheses around compound expressions (e.g. "(P1^0 - P1) / P1^0 = i * x2" or "(-b +/- sqrt(b^2 - 4ac)) / (2a)").
   - Nernst Equation: E_cell = E^0_cell - (0.0591 / n) * log10([Anode ion] / [Cathode ion]) at 298 K.
   - Colligative Properties: Delta Tb = i * K_b * m, Delta Tf = i * K_f * m, pi = i * C * R * T.
   - Chemical Kinetics: First order k = (2.303 / t) * log10([R]0 / [R]), t_(1/2) = 0.693 / k, Rate = k * [A]^x * [B]^y.
   - Roots & Powers: Use "sqrt(...)" and "^", e.g. mu = sqrt(n * (n + 2)) BM, 10^-3, 10^5.
   - Greek Letters & Units: Write as words or clean ASCII: Delta H^0, Delta G^0, Lambda^0_m, kappa, alpha, pi; units: "g/mol", "mol L^-1", "S cm^2 mol^-1", "J/mol", "K", "atm".

4. INORGANIC & COORDINATION CHEMISTRY (CBSE CLASS 12):
   - Coordination complexes: Write clear brackets, e.g. "[Co(NH3)6]Cl3", "[Ni(CN)4]^2-", "K4[Fe(CN)6]".
   - Hybridization & Geometry: Write as "sp^3" (tetrahedral), "dsp^2" (square planar), "d^2sp^3" or "sp^3d^2" (octahedral).
   - Crystal Field Theory: Write splitting as "Delta_o" or "Delta_t", configurations like "t2g^4 eg^2" or "t2g^6 eg^0".
   - Magnetic Moment: mu = sqrt(n * (n + 2)) BM (where n = number of unpaired electrons).

5. ORGANIC CHEMISTRY CONVERSIONS & REACTIONS (CBSE CLASS 12):
   - Reagents over arrow: Format clearly as:
     Reactant  --[Reagent / Conditions]-->  Product
     Examples:
     - CH3-CH2-OH  --[PCC]-->  CH3-CHO
     - CH3-COOH  --[SOCl2]-->  CH3-COCl + SO2 + HCl
     - Benzene  --[conc. HNO3 / conc. H2SO4, 55 deg C]-->  Nitrobenzene
     - R-CONH2  --[Br2 + 4NaOH (Hoffmann Bromamide)]-->  R-NH2 + Na2CO3 + 2NaBr + 2H2O
     - R-CHO  --[Tollens' reagent (ammoniacal AgNO3)]-->  R-COO^- + Ag (Silver Mirror)
   - Distinction tests (Lucas test, Iodoform test, Carbylamine test, Ferric chloride test) with clear observation: e.g. "Forms yellow precipitate of CHI3".
   - Mechanisms: Clearly label "Step 1: Protonation...", "Step 2: Carbocation intermediate...", "Step 3: Elimination...".

6. STRUCTURE & READABILITY:
   - Direct, CBSE marking-scheme compliant steps: Formula -> Substitution -> Calculation -> Final Answer.
   - Format with simple, clean headers: "Step 1: ...", "Step 2: ...", and "*Final Answer:* ...".
   - WhatsApp supports basic bold using single asterisks "*text*". Use "*text*" for key labels and final answers. Do NOT use markdown code fences, headers (#), or HTML tags.

7. EXACT ACCURACY:
   - Do NOT alter, omit, or approximate any calculation, number, sign, variable, unit, or step from the original solution.

8. OUTPUT FORMAT:
   - Return ONLY the converted plain-text solution.
   - Do NOT include any intro like "Here is the WhatsApp formatted text:". Start immediately with the solution.`;

/**
 * Robust nested-brace parser to convert \frac{num}{den} into (num) / (den)
 */
function replaceLaTeXFractions(text: string): string {
    let result = text;
    let iterations = 0;
    while (result.includes("\\frac") && iterations < 20) {
        iterations++;
        const fracIdx = result.indexOf("\\frac");
        if (fracIdx === -1) break;

        let i = fracIdx + 5;
        while (i < result.length && /\s/.test(result[i])) i++;
        if (result[i] !== "{") break;

        let depth = 1;
        const numStart = i + 1;
        let numEnd = -1;
        for (i = numStart; i < result.length; i++) {
            if (result[i] === "{") depth++;
            else if (result[i] === "}") {
                depth--;
                if (depth === 0) { numEnd = i; break; }
            }
        }
        if (numEnd === -1) break;

        i++;
        while (i < result.length && /\s/.test(result[i])) i++;
        if (result[i] !== "{") break;

        depth = 1;
        const denStart = i + 1;
        let denEnd = -1;
        for (i = denStart; i < result.length; i++) {
            if (result[i] === "{") depth++;
            else if (result[i] === "}") {
                depth--;
                if (depth === 0) { denEnd = i; break; }
            }
        }
        if (denEnd === -1) break;

        const num = result.slice(numStart, numEnd).trim();
        const den = result.slice(denStart, denEnd).trim();

        result = result.slice(0, fracIdx) + `(${num}) / (${den})` + result.slice(denEnd + 1);
    }
    return result;
}

/**
 * Deterministic fallback cleaner that translates LaTeX & chemistry to plain text without LLM
 */
function fallbackFormatForWhatsApp(solution: string): string {
    if (!solution) return "";
    let text = solution.trim();

    // 1. Replace Unicode superscripts and subscripts with ASCII representations
    const superSubMap: Record<string, string> = {
        "²⁺": "^2+", "³⁺": "^3+", "⁴⁺": "^4+",
        "²⁻": "^2-", "³⁻": "^3-", "⁴⁻": "^4-",
        "⁺": "+", "⁻": "-",
        "⁰": "^0", "¹": "^1", "²": "^2", "³": "^3", "⁴": "^4",
        "⁵": "^5", "⁶": "^6", "⁷": "^7", "⁸": "^8", "⁹": "^9",
        "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
        "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9"
    };
    for (const [uni, asc] of Object.entries(superSubMap)) {
        text = text.split(uni).join(asc);
    }

    // 2. Fractions & Roots
    text = replaceLaTeXFractions(text);
    text = text.replace(/\\sqrt\[([^\]]+)\]\{([^{}]+)\}/g, "($2)^(1/$1)");
    text = text.replace(/\\sqrt\{([^{}]+)\}/g, "sqrt($1)");

    // 3. Electronic configurations like 1s2, 2s2, 2p6, 3d5, 4s1 -> 1s^2, 2s^2, 2p^6, 3d^5, 4s^1
    text = text.replace(/\b([1-7][spdf])(\d{1,2})\b/g, "$1^$2");

    // 4. Standard electrode / cell notation
    text = text.replace(/E\s*(?:\^\\circ|\^0|\^o)?\s*_\{\s*cell\s*\}/gi, "E^0_cell");
    text = text.replace(/E\s*_\{\s*cell\s*\}/gi, "E_cell");
    text = text.replace(/Delta\s*G\s*(?:\^\\circ|\^0)?/gi, "Delta G^0");
    text = text.replace(/Delta\s*H\s*(?:\^\\circ|\^0)?/gi, "Delta H^0");

    // 5. Unbrace superscripts and subscripts ^{2+} -> ^2+, _{cell} -> _cell
    text = text.replace(/\^{([^}]+)}/g, "^$1");
    text = text.replace(/_{([^}]+)}/g, "_$1");

    // 6. Ions: Zn2+ -> Zn^2+, Cu2+ -> Cu^2+, Fe3+ -> Fe^3+, SO42- -> SO4^2-
    text = text.replace(/\b([A-Z][a-z]?|\bSO4|\bNO3|\bCO3|\bPO4|\bOH)(\d{1,2})([+-])\b/g, "$1^$2$3");
    text = text.replace(/\be-\b/g, "e^-");

    // 7. Math & chem functions
    text = text.replace(/\\log_\{?10\}?/g, "log10");
    text = text.replace(/\\log/g, "log");
    text = text.replace(/\\ln/g, "ln");
    text = text.replace(/\\pm/g, "+/-");
    text = text.replace(/\\mp/g, "-/+");
    text = text.replace(/\\times/g, "*");
    text = text.replace(/\\cdot/g, "*");
    text = text.replace(/\\approx/g, "≈");
    text = text.replace(/\\neq/g, "!=");
    text = text.replace(/\\leq/g, "<=");
    text = text.replace(/\\geq/g, ">=");
    text = text.replace(/\\degree|\^\\circ/g, " deg");
    text = text.replace(/\\rightarrow|\\to/g, "->");
    text = text.replace(/\\rightleftharpoons/g, "<=>");

    // 8. Common Greek letters
    const greek: Record<string, string> = {
        alpha: "alpha", beta: "beta", gamma: "gamma", delta: "Delta",
        theta: "theta", lambda: "lambda", mu: "mu", pi: "pi", sigma: "sigma"
    };
    for (const [name, sym] of Object.entries(greek)) {
        const reg = new RegExp(`\\\\${name}\\b`, "gi");
        text = text.replace(reg, sym);
    }

    // 9. Strip LaTeX sizing and text wrappers
    text = text.replace(/\\(?:text|mathbf|mathit|mathrm|textbf)\{([^{}]+)\}/g, "$1");
    text = text.replace(/\\(?:left|right|big|Big|bigg|Bigg|displaystyle|limits|nolimits)/g, "");
    text = text.replace(/\\(?:quad|qquad|\s*,|\s*;|\s*!)/g, " ");

    // 10. Strip math delimiters \(, \), \[, \], $$, $
    text = text.replace(/\\\(|\\\)/g, " ");
    text = text.replace(/\\\[|\\\]/g, " ");
    text = text.replace(/\$\$|\$/g, "");

    // 11. Convert markdown headers "### Step 1:" -> "*Step 1:*"
    text = text.replace(/^#{1,6}\s*(.*)$/gm, "*$1*");

    // 12. Convert double-asterisk bold **text** to WhatsApp single-asterisk *text*
    text = text.replace(/\*\*([^*]+)\*\*/g, "*$1*");

    // 13. Clean up backslashes before special chars like \{ \}
    text = text.replace(/\\([{}])/g, "$1");

    // 14. Normalize multiple spaces and clean up
    text = text.replace(/[ \t]+/g, " ");
    text = text.replace(/\n{3,}/g, "\n\n");

    return text.trim();
}

/**
 * Calls Gemini LLM to convert a technical solution into unambiguous WhatsApp plain text
 */
async function formatSolutionForWhatsAppWithGemini(solutionText: string): Promise<string> {
    const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
    const apiKeys = rawKeys.split(",").map(k => k.trim()).filter(Boolean);

    if (apiKeys.length === 0) {
        throw new Error("GEMINI_API_KEYS is missing.");
    }

    const prompt = `${WHATSAPP_PLAIN_TEXT_SYSTEM_PROMPT}

Solution to format for WhatsApp:
${solutionText}
`;

    const modelsToTry = [
        "gemini-2.5-flash",
        "gemini-3.5-flash",
        "gemini-3.6-flash",
        "gemini-3.7-flash",
        "gemini-3.8-flash",
        "gemini-3-flash-preview",
        "gemini-3.5-flash-lite",
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
                    },
                });

                if (response.text) {
                    result = response.text.trim();
                    success = true;
                    break;
                }
            } catch (err: any) {
                console.warn(`[WhatsApp LLM] Model ${modelName} attempt failed:`, err?.message);
            }
        }

        if (success) {
            break;
        } else {
            (globalThis as any).geminiKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
        }
    }

    if (!success || !result) {
        throw new Error("Failed to format solution with Gemini.");
    }

    // Strip any markdown code fences
    result = result.replace(/^```(?:markdown|text|plain)?\s*/i, "").replace(/```\s*$/, "").trim();
    // Strip conversational preambles
    result = result.replace(/^(?:Here is the (?:WhatsApp|plain[- ]text|converted)[^:\n]*:?\s*)+/i, "").trim();

    return result;
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { solutions, delaySeconds = 30, blockDelaySeconds = 5 } = body;

        if (!solutions || !Array.isArray(solutions) || solutions.length === 0) {
            return NextResponse.json({ error: "No solutions provided" }, { status: 400 });
        }

        console.log(`[WhatsApp API] Converting ${solutions.length} solutions to unambiguous WhatsApp plain text via LLM...`);

        // Convert each solution into clean, readable, unambiguous plain text specifically for WhatsApp
        const formattedSolutions = await Promise.all(
            solutions.map(async (item: any) => {
                const rawSolution = (item.solution || item.text || "").trim();
                if (!rawSolution) return item;

                try {
                    const plainSolution = await formatSolutionForWhatsAppWithGemini(rawSolution);
                    return { ...item, solution: plainSolution };
                } catch (err: any) {
                    console.warn(`[WhatsApp API] LLM conversion failed for question ${item.questionNumber}, applying enhanced fallback:`, err?.message);
                    const fallbackSolution = fallbackFormatForWhatsApp(rawSolution);
                    return { ...item, solution: fallbackSolution };
                }
            })
        );

        let browserServiceUrl = "http://127.0.0.1:3001";
        try {
            browserServiceUrl = getBrowserServiceUrl();
        } catch {
            browserServiceUrl = process.env.BROWSER_SERVICE_URL || "http://127.0.0.1:3001";
        }

        console.log(`[WhatsApp API] Forwarding ${formattedSolutions.length} formatted solutions to browser service at ${browserServiceUrl}`);

        const res = await fetch(`${browserServiceUrl}/whatsapp/send-solutions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ solutions: formattedSolutions, delaySeconds, blockDelaySeconds }),
            signal: AbortSignal.timeout(10000), // 10s connection timeout
        });

        if (!res.ok) {
            const errText = await res.text();
            console.warn(`[WhatsApp API] Browser service returned ${res.status}:`, errText);
            return NextResponse.json({ ok: false, error: `Browser service error: ${res.status}` }, { status: 502 });
        }

        const data = await res.json();
        return NextResponse.json({ ...data, formattedCount: formattedSolutions.length });
    } catch (err: any) {
        console.warn("[WhatsApp API] Failed to reach browser service:", err?.message);
        return NextResponse.json({ ok: false, error: err?.message || "Browser service unreachable" }, { status: 503 });
    }
}
