"use client";

import React, { useRef, useState, useCallback, useEffect } from "react";
import Webcam from "react-webcam";
import "./ScannerApp.css";

// Interface for API response
interface ScannedQuestion {
    id: string;
    questionNumber: string;
    text: string;
    solution?: string;
    isSolving?: boolean; // UI state for loading indicator
}

export default function ScannerApp() {
    const webcamRef = useRef<Webcam>(null);
    const [isCapturing, setIsCapturing] = useState(false);
    const [savedQuestions, setSavedQuestions] = useState<ScannedQuestion[]>([]);
    const [selectedQuestionIds, setSelectedQuestionIds] = useState<Set<string>>(new Set());
    const [isProcessingSolutions, setIsProcessingSolutions] = useState(false);
    const [expandedSolutionIds, setExpandedSolutionIds] = useState<Set<string>>(new Set());
    const [activeTab, setActiveTab] = useState<"all" | "unsolved" | "solved">("all");

    // Settings state
    const defaultSolvePrompt = "You are an expert tutor. I am providing you with an array of questions extracted from a question paper.\nPlease solve each question accurately and provide a clear, step-by-step solution.";
    const [customSolvePrompt, setCustomSolvePrompt] = useState(defaultSolvePrompt);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

    // Edit mode state
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingText, setEditingText] = useState("");
    const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);

    const [scanStatus, setScanStatus] = useState<"idle" | "scanning" | "success" | "error">("idle");
    const [errorMessage, setErrorMessage] = useState("");
    const [countdown, setCountdown] = useState<number | null>(null);
    const [captureDelay, setCaptureDelay] = useState(6);

    // Mounted state to avoid hydration errors with Webcam
    const [mounted, setMounted] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);

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
            } catch (e) {
                console.error("Failed to load saved questions", e);
            }
        }

        const storedPrompt = localStorage.getItem("scannerApp_solvePrompt");
        if (storedPrompt) {
            setCustomSolvePrompt(storedPrompt);
        }

        setIsLoaded(true);
        setMounted(true);
    }, []);

    // Persist to localStorage whenever savedQuestions changes
    useEffect(() => {
        if (isLoaded) {
            localStorage.setItem("scannerApp_savedQuestions", JSON.stringify(savedQuestions));
            localStorage.setItem("scannerApp_solvePrompt", customSolvePrompt);
        }
    }, [savedQuestions, customSolvePrompt, isLoaded]);

    const videoConstraints = {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        facingMode: "user" // specifically requested front camera
    };

    const capture = useCallback(async (autoTriggered = false) => {
        if (!webcamRef.current) return;

        // Play capture animation and sound (optional, but a beep helps UX when blind scanning)
        if (autoTriggered) {
            try {
                const beep = new Audio("data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YU... (simplified beep, can use real API sound or just vibrate)");
                // Just vibrate if supported
                if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);
            } catch (e) { }
        }

        setIsCapturing(true);
        setScanStatus("scanning");
        setErrorMessage("");

        setTimeout(() => setIsCapturing(false), 500);

        const imageSrc = webcamRef.current.getScreenshot();
        if (!imageSrc) {
            setScanStatus("error");
            setErrorMessage("Failed to capture image from camera.");
            return;
        }

        try {
            // Create an image object to perform the horizontal flip
            const img = new window.Image();
            img.src = imageSrc;

            await new Promise((resolve) => {
                img.onload = resolve;
            });

            // Draw flipped image to canvas
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d");

            let base64Image = imageSrc;
            if (ctx) {
                ctx.translate(canvas.width, 0);
                ctx.scale(-1, 1);
                ctx.drawImage(img, 0, 0);
                base64Image = canvas.toDataURL("image/jpeg");
            }

            const response = await fetch("/api/scan", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // Send the flipped image!
                body: JSON.stringify({ image: base64Image }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `API returned ${response.status}`);
            }

            const data = await response.json();
            const newQuestions: ScannedQuestion[] = data.questions || [];

            // Accumulate questions, ignoring ones that already exist by number
            setSavedQuestions(prev => {
                const updatedList = [...prev];

                newQuestions.forEach(newQ => {
                    // Check if question number already exists
                    const exists = updatedList.some(
                        existingQ => String(existingQ.questionNumber).trim() === String(newQ.questionNumber).trim()
                    );

                    if (!exists) {
                        updatedList.push({
                            ...newQ,
                            // Ignore the ID from the API because if we scan twice, it might return 'id: 1' both times
                            id: `q-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
                        });
                    }
                });

                // Return the updated list in the exact order items were processed
                return updatedList;
            });

            setScanStatus("success");
        } catch (error: any) {
            console.error("Scan error:", error);
            setScanStatus("error");
            setErrorMessage(error.message || "Failed to process the question paper.");
        }
    }, [webcamRef]);

    // Timer logic for 6-second countdown
    useEffect(() => {
        if (countdown === null) return;

        if (countdown > 0) {
            const timer = setTimeout(() => setCountdown(countdown - 1), 1000);

            // Optional: Play a tick sound here so the user can hear the countdown
            try {
                if ("vibrate" in navigator) navigator.vibrate(50);
            } catch (e) { }

            return () => clearTimeout(timer);
        } else if (countdown === 0) {
            setCountdown(null);
            capture(true);
        }
    }, [countdown, capture]);

    const startManualScan = () => {
        if (scanStatus === "scanning" || countdown !== null) return;
        setCountdown(captureDelay);
    };

    const resetScanner = () => {
        // We do NOT clear savedQuestions here, we just wipe errors/status
        setScanStatus("idle");
        setErrorMessage("");
        setCountdown(null);
    };

    const clearAllQuestions = () => {
        setSavedQuestions([]);
        setSelectedQuestionIds(new Set());
        setScanStatus("idle");
    };

    const deleteQuestion = (idToDelete: string) => {
        setSavedQuestions(prev => prev.filter(q => q.id !== idToDelete));
        setSelectedQuestionIds(prev => {
            const next = new Set(prev);
            next.delete(idToDelete);
            return next;
        });
        setExpandedSolutionIds(prev => {
            const next = new Set(prev);
            next.delete(idToDelete);
            return next;
        });
    };

    const toggleSolutionExpanded = (id: string) => {
        setExpandedSolutionIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const handleCardClick = (id: string, hasSolution: boolean) => {
        if (editingId === id) return;

        if (hasSolution) {
            toggleSolutionExpanded(id);
        } else {
            toggleSelection(id);
        }
    };

    const toggleSelection = (id: string) => {
        // Prevent selection if we're in edit mode for this card clicking around
        if (editingId === id) return;

        setSelectedQuestionIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    // --- Long Press Edit Logic ---
    const handlePointerDown = (q: ScannedQuestion) => {
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = setTimeout(() => {
            // Trigger edit mode after 600ms long press
            setEditingId(q.id);
            setEditingText(q.text);
            try {
                if ("vibrate" in navigator) navigator.vibrate(50); // haptic feedback
            } catch (e) { }
        }, 600);
    };

    const handlePointerUp = () => {
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    };

    const handlePointerLeave = () => {
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    };

    const saveEdit = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setSavedQuestions(prev => prev.map(q =>
            q.id === id ? { ...q, text: editingText } : q
        ));
        setEditingId(null);
        setEditingText("");
    };

    const cancelEdit = (e: React.MouseEvent) => {
        e.stopPropagation();
        setEditingId(null);
        setEditingText("");
    };

    const processSelectedQuestions = async () => {
        if (selectedQuestionIds.size === 0 || isProcessingSolutions) return;

        setIsProcessingSolutions(true);

        // Mark specific questions as 'isSolving'
        setSavedQuestions(prev => prev.map(q =>
            selectedQuestionIds.has(q.id) ? { ...q, isSolving: true } : q
        ));

        try {
            const questionsToSend = Array.from(selectedQuestionIds)
                .map(id => {
                    const q = savedQuestions.find(sq => sq.id === id);
                    return q ? { id: q.id, text: q.text } : null;
                })
                .filter(Boolean);

            const response = await fetch("/api/solve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    questions: questionsToSend,
                    customSolvePrompt: customSolvePrompt
                }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `API returned ${response.status}`);
            }

            const data = await response.json();
            const solutions: Record<string, string> = data.solutions || {};

            setSavedQuestions(prev => prev.map(q => {
                if (selectedQuestionIds.has(q.id) && solutions[q.id]) {
                    return { ...q, solution: solutions[q.id], isSolving: false };
                }
                return { ...q, isSolving: false }; // clear loading state if no solution
            }));

            // Auto-expand successfully solved questions
            setExpandedSolutionIds(prev => {
                const next = new Set(prev);
                selectedQuestionIds.forEach(id => {
                    if (solutions[id]) next.add(id);
                });
                return next;
            });

            // Clear selection after process
            setSelectedQuestionIds(new Set());

        } catch (error: any) {
            console.error("Solve error:", error);
            alert("Failed to process solutions: " + error.message);
            // Revert loading states
            setSavedQuestions(prev => prev.map(q => ({ ...q, isSolving: false })));
        } finally {
            setIsProcessingSolutions(false);
        }
    };

    const filteredQuestions = savedQuestions.filter(q => {
        if (activeTab === "all") return true;
        if (activeTab === "solved") return !!q.solution;
        if (activeTab === "unsolved") return !q.solution;
        return true;
    });

    if (!mounted) return null;

    return (
        <div className="scanner-layout">
            {/* Left side: Camera Viewport */}
            <div className="scanner-section">
                <div className="webcam-container">
                    <Webcam
                        audio={false}
                        ref={webcamRef}
                        screenshotFormat="image/jpeg"
                        videoConstraints={videoConstraints}
                        className={`webcam-preview ${isCapturing ? "capture-flash" : ""}`}
                        mirrored={true} // Usually better UX for front camera
                    />

                    {/* Overlay scanning effects */}
                    {scanStatus === "scanning" && (
                        <div className="scanning-overlay">
                            <div className="scan-line"></div>
                            <div className="scan-text">Analyzing intelligence...</div>
                        </div>
                    )}

                    {/* Countdown Overlay */}
                    {countdown !== null && countdown > 0 && (
                        <div className="countdown-overlay">
                            <span className="countdown-text">{countdown}</span>
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
                    <button
                        className={`capture-btn ${countdown !== null ? 'counting' : ''}`}
                        onClick={startManualScan}
                        disabled={scanStatus === "scanning" || countdown !== null}
                    >
                        <div className="capture-inner"></div>
                    </button>
                    <p className="instruction-text" style={{ marginTop: '0.5rem', marginBottom: '1.5rem' }}>
                        {countdown !== null
                            ? "Position paper. Capturing soon..."
                            : `Tap to start ${captureDelay}-second scan timer`}
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
                            disabled={scanStatus === "scanning" || countdown !== null}
                        />
                    </div>

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
                <div className="settings-overlay" onClick={() => setIsSettingsOpen(false)}>
                    <div className="settings-modal" onClick={e => e.stopPropagation()}>
                        <div className="settings-header">
                            <h3>Settings</h3>
                            <button className="close-btn" onClick={() => setIsSettingsOpen(false)}>✕</button>
                        </div>
                        <div className="settings-content">
                            <label className="settings-label">
                                AI Solve System Prompt
                                <span className="settings-hint">The JSON formatting instructions will be appended automatically.</span>
                            </label>
                            <textarea
                                className="settings-textarea"
                                value={customSolvePrompt}
                                onChange={(e) => setCustomSolvePrompt(e.target.value)}
                                placeholder={defaultSolvePrompt}
                            />
                            <div className="settings-actions">
                                <button className="reset-btn" onClick={() => setCustomSolvePrompt(defaultSolvePrompt)}>Reset Default</button>
                                <button className="process-btn" onClick={() => setIsSettingsOpen(false)}>Done</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Right side: Results */}
            <div className="results-section">
                <div className="results-header">
                    <h2>Extracted Questions ({savedQuestions.length})</h2>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
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
                    </div>
                </div>

                {savedQuestions.length > 0 && (
                    <div className="tabs-container">
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
                )}

                <div className="results-content">
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
                            {filteredQuestions.map((q, idx) => (
                                <div
                                    key={q.id || idx}
                                    className={`question-card ${selectedQuestionIds.has(q.id) ? 'selected' : ''}`}
                                    onClick={() => handleCardClick(q.id, !!q.solution)}
                                    // Pointer events for long tap detection
                                    onPointerDown={(e) => {
                                        // Ignore pointer down if clicking the checkbox/buttons directly
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
                                        <button
                                            className="delete-btn"
                                            onClick={(e) => { e.stopPropagation(); deleteQuestion(q.id); }}
                                            aria-label="Delete question"
                                        >
                                            ✕
                                        </button>
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
                                        <div className="question-body">
                                            {q.text}
                                        </div>
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
                                                <div className="solution-text">{q.solution}</div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
