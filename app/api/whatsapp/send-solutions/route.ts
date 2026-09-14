import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { getBrowserServiceUrl } from "@/app/api/image-solve-capture/browserService";

if (typeof (globalThis as any).geminiKeyIndex === "undefined") {
    (globalThis as any).geminiKeyIndex = 0;
}

export const maxDuration = 120;

const WHATSAPP_PLAIN_TEXT_SYSTEM_PROMPT = `You are an expert CBSE Class 12th Physics & Chemistry Plain-Text Solution Formatter.
Your task is to convert written solutions into clean, crystal-clear, unambiguous plain text formatted specifically for messaging on WhatsApp and viewing in basic text editors (like Notepad) without requiring any LaTeX or special font rendering.

CRITICAL FORMATTING RULES:

1. NO UNRENDERABLE SUPERSCRIPTS OR SUBSCRIPTS:
   - Absolutely DO NOT use Unicode superscripts (like ², ³, ⁺, ⁻, ²⁺, ⁴⁻) or Unicode subscripts (like ₂, ₄). Many text editors and mobile fonts fail to render them, showing broken boxes or question marks.
   - For powers and scientific notation: ALWAYS use caret "^", e.g. "10^-19", "3 * 10^8", "r^2", "v^2", "1.6 * 10^-19 C", "9 * 10^9 N m^2 C^-2".
   - For subshell electronic configurations: "1s^2 2s^2 2p^6 3s^2 3p^6 3d^10 4s^2", "[Ar] 3d^5 4s^1".
   - For ionic charges: "Zn^2+", "Cu^2+", "Al^3+", "Fe^2+", "Fe^3+", "Cl^-", "SO4^2-", "e^-".
   - For chemical formulas: Write standard ASCII numbers without subscript, e.g. "H2O", "H2SO4", "KMnO4", "K2Cr2O7".

2. ZERO LATEX OR MARKDOWN CODE:
   - Absolutely NO LaTeX markup (never output \\frac, \\sqrt, \\vec, \\hat, \\theta, \\lambda, \\mu, \\epsilon, \\omega, \\text, \\left, \\right, \\cdot, \\times, \\pm, \\approx, \\mathbf, \\(, \\), \\[, \\], $, or \\begin/\\end blocks).
   - WhatsApp cannot render LaTeX or MathJax; every single formula must be in readable ASCII text.

3. CBSE CLASS 12 PHYSICS NOTATION & CHAPTER GUIDELINES:
   - Vectors & Unit Vectors:
     - Vector quantities: Write as "vec(E)", "vec(B)", "vec(v)", "vec(F)", "vec(p)".
     - Unit vectors: Write as "i_hat", "j_hat", "k_hat" or "n_hat".
     - Dot product: Write as "vec(A) . vec(B) = |A| * |B| * cos(theta)".
     - Cross product: Write as "vec(A) x vec(B) = |A| * |B| * sin(theta) * n_hat".
   - Electrostatics & Capacitance:
     - Coulomb's Law: F = (1 / (4 * pi * epsilon_0)) * (|q1 * q2| / r^2) where (1 / (4 * pi * epsilon_0)) = 9 * 10^9 N m^2 C^-2.
     - Electric Field & Potential: E = F / q (in N/C or V/m), V = (1 / (4 * pi * epsilon_0)) * (q / r) (in Volts).
     - Capacitance: C = (epsilon_0 * A) / d, with dielectric C = K * C_0, Energy U = (1/2) * C * V^2 = Q^2 / (2 * C).
   - Current Electricity:
     - Drift velocity: v_d = (e * E * tau) / m, Current I = n * e * A * v_d.
     - Ohm's law: V = I * R, Resistance R = rho * L / A, Temperature R_T = R_0 * (1 + alpha * Delta T).
     - Kirchhoff's Rules: Current Law sum(I) = 0, Voltage Law sum(V) = sum(I * R).
     - Wheatstone Bridge: P / Q = R / S; Potentiometer E1 / E2 = l1 / l2.
   - Magnetism & Magnetic Effects:
     - Biot-Savart Law: dB = (mu_0 / (4 * pi)) * (I * dl * sin(theta) / r^2) where mu_0 / (4 * pi) = 10^-7 T m A^-1.
     - Straight wire B = (mu_0 * I) / (2 * pi * d), Circular loop at center B = (mu_0 * N * I) / (2 * R).
     - Solenoid B = mu_0 * n * I, Toroid B = mu_0 * n * I.
     - Lorentz Force: vec(F) = q * (vec(E) + vec(v) x vec(B)), on current wire vec(F) = I * (vec(L) x vec(B)).
     - Galvanometer: Torque tau = N * I * A * B * sin(theta), Shunt S = (I_g * G) / (I - I_g), Multiplier R = (V / I_g) - G.
   - Electromagnetic Induction & AC:
     - Magnetic Flux: Phi_B = B * A * cos(theta) (in Weber, Wb).
     - Faraday's Law: e = - dPhi_B / dt = - N * (Delta Phi_B / Delta t).
     - Motional EMF: e = B * v * l. Self-inductance e = - L * (dI / dt).
     - AC Circuits: V_rms = V_0 / sqrt(2) = 0.707 * V_0, I_rms = I_0 / sqrt(2).
     - Reactance: X_L = omega * L = 2 * pi * f * L, X_C = 1 / (omega * C) = 1 / (2 * pi * f * C).
     - Impedance: Z = sqrt(R^2 + (X_L - X_C)^2).
     - Resonant frequency: f_0 = 1 / (2 * pi * sqrt(L * C)).
     - Power factor: cos(phi) = R / Z, Average power P = V_rms * I_rms * cos(phi).
     - Transformer: V_s / V_p = N_s / N_p = I_p / I_s.
   - Optics (Ray & Wave):
     - Mirror Formula: 1/f = 1/v + 1/u, Magnification m = -v / u.
     - Lens Formula: 1/f = 1/v - 1/u, Magnification m = v / u.
     - Lens Maker's Formula: 1/f = (n - 1) * (1/R1 - 1/R2), Power P = 1 / f (in Diopters, D, f in meters).
     - Prism Formula: n = sin((A + D_m) / 2) / sin(A / 2).
     - YDSE Fringe Width: beta = (lambda * D) / d; Maxima path diff Delta x = n * lambda, Minima Delta x = (2n - 1) * lambda / 2.
     - Single Slit Diffraction: First minimum at a * sin(theta) = lambda, Central max width = 2 * lambda * D / a.
   - Modern Physics & Semiconductors:
     - Photoelectric Effect: K_max = h * nu - phi_0 = e * V_0 (h = 6.63 * 10^-34 J s).
     - de Broglie Wavelength: lambda = h / p = h / sqrt(2 * m * K) = 1.227 / sqrt(V) nm for electron.
     - Bohr Model: E_n = -13.6 * (Z^2 / n^2) eV, r_n = 0.529 * (n^2 / Z) Angstrom.
     - Nuclear Radius R = R_0 * A^(1/3) (R_0 = 1.2 * 10^-15 m).
     - Binding Energy: BE = Delta m * c^2 = Delta m * 931.5 MeV.
     - Logic Gates: AND (Y = A . B), OR (Y = A + B), NOT (Y = not(A)), NAND (Y = not(A . B)), NOR (Y = not(A + B)).

4. PHYSICAL CONSTANTS & GREEK SYMBOLS:
   - Always spell Greek letters in clean English: epsilon_0, mu_0, lambda, omega, theta, phi, Phi_B, rho, tau, nu, alpha, beta, gamma, delta, eta.
   - SI Units: N, C, V, A, Ohm, T (Tesla), Wb (Weber), H (Henry), F (Farad), J, W, eV, MeV, m/s, rad/s, Hz, N/C, V/m, kg, m, s, deg.

5. CBSE CLASS 12 CHEMISTRY NOTATION:
   - Colligative: Delta Tb = i * K_b * m, Delta Tf = i * K_f * m, pi = i * C * R * T.
   - Kinetics: First order k = (2.303 / t) * log10([R]0 / [R]), t_(1/2) = 0.693 / k.
   - Electrochemistry: E_cell = E^0_cell - (0.0591 / n) * log10([Anode ion] / [Cathode ion]).
   - Organic Reactions: Reactant --[Reagents]--> Product (e.g. CH3-CH2-OH --[PCC]--> CH3-CHO).

6. STRUCTURE & READABILITY:
   - Direct, CBSE marking-scheme compliant format:
     *Given:* ...
     *Formula:* ...
     *Substitution:* ...
     *Calculation:* ...
     *Final Answer:* [Symbol] = [Value] [SI Unit]
   - WhatsApp supports basic bold using single asterisks "*text*". Use "*text*" for key labels and final answers. Do NOT use markdown code fences, headers (#), or HTML tags.

7. EXACT ACCURACY:
   - Do NOT alter, omit, or approximate any calculation, number, sign, variable, unit, or step from the original solution.

8. OUTPUT FORMAT:
   - Return ONLY the converted plain-text solution. Start immediately with the solution.`;

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

    // 7. Vectors and unit vectors
    text = text.replace(/\\vec\{([^{}]+)\}/g, "vec($1)");
    text = text.replace(/\\vec\s+([A-Za-z])/g, "vec($1)");
    text = text.replace(/\\hat\{([^{}]+)\}/g, "$1_hat");
    text = text.replace(/\\hat\s+([A-Za-z])/g, "$1_hat");

    // 8. Math & chem functions
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
    text = text.replace(/\\int/g, "int");
    text = text.replace(/\\oint/g, "oint");
    text = text.replace(/\\infty/g, "inf");
    text = text.replace(/\\partial/g, "d");

    // 9. Common Greek letters & Physics Constants
    text = text.replace(/\\pi\s*\\(?:epsilon_0|varepsilon_0)/g, "pi * epsilon_0");
    text = text.replace(/\\epsilon_0|\\varepsilon_0/g, " epsilon_0");
    text = text.replace(/\\mu_0/g, " mu_0");
    text = text.replace(/\\Omega/g, "Ohm");
    text = text.replace(/\\Phi_B/g, "Phi_B");
    text = text.replace(/\\Phi_E/g, "Phi_E");
    text = text.replace(/\\hbar/g, "h/(2*pi)");

    const greek: Record<string, string> = {
        alpha: "alpha", beta: "beta", gamma: "gamma", delta: "Delta",
        theta: "theta", lambda: "lambda", mu: "mu", pi: "pi", sigma: "sigma",
        omega: "omega", tau: "tau", rho: "rho", nu: "nu", eta: "eta", phi: "phi",
        psi: "psi", epsilon: "epsilon"
    };
    for (const [name, sym] of Object.entries(greek)) {
        const reg = new RegExp(`\\\\${name}(?![a-zA-Z])`, "gi");
        text = text.replace(reg, sym);
    }

    // Multiply implied coefficients e.g. 4pi -> 4 * pi, pi epsilon_0 -> pi * epsilon_0
    text = text.replace(/(\d+)\s*(pi|epsilon_0|mu_0|omega)\b/g, "$1 * $2");
    text = text.replace(/(pi)\s*(epsilon_0|mu_0)\b/g, "$1 * $2");

    // 10. Strip LaTeX sizing and text wrappers
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
