
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { db } from './firebaseConfig'; // Firebase setup
import { collection, doc, getDoc, getDocs, setDoc, addDoc, query, orderBy, deleteDoc, writeBatch } from 'firebase/firestore';

const TOTAL_QUESTIONS = 25;
const QUESTION_TIME_LIMIT = 6; // seconds
const PAUSE_DURATION = 3; // seconds

interface Question {
    id: string;
    n1: number;
    n2: number;
    answer: number;
    userAnswer: string | null;
    isCorrect: boolean | null;
}

interface UserPracticeResult {
    id: string;
    score: number;
    totalQuestions: number;
    date: string; // Store as ISO string or use Firestore Timestamp
}

interface AdminResult extends UserPracticeResult {
    userCode: string;
}

const TABLE_SPECS: Record<number, { min: number; max: number; isKS1: boolean }> = {
    2: { min: 0, max: 2, isKS1: true }, 3: { min: 1, max: 3, isKS1: false },
    4: { min: 1, max: 3, isKS1: false }, 5: { min: 1, max: 3, isKS1: true },
    6: { min: 2, max: 4, isKS1: false }, 7: { min: 2, max: 4, isKS1: false },
    8: { min: 2, max: 4, isKS1: false }, 9: { min: 2, max: 4, isKS1: false },
    10: { min: 0, max: 2, isKS1: true }, 11: { min: 1, max: 3, isKS1: false },
    12: { min: 2, max: 4, isKS1: false },
};
const KS_LIMITS = { KS1: { min: 3, max: 7 }, KS2: { min: 18, max: 22 } };

type GameState = 'LOADING' | 'LOGIN' | 'START' | 'PRACTICE_QUESTION' | 'PRACTICE_PAUSE' | 'PRACTICE_RESULTS' | 'VIEW_PAST_RESULTS' | 'ADMIN_DASHBOARD';

const generatePracticeQuestions = (): Question[] => {
    const questions: Question[] = [];
    const usedPairs = new Set<string>();
    const tableCounts: Record<number, number> = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i + 2, 0]));
    let ks1Items = 0, ks2Items = 0;

    const addQuestion = (n1: number, n2: number): boolean => {
        const key = `${Math.min(n1,n2)}x${Math.max(n1,n2)}`; // Ensure n1xn2 and n2xn1 are treated as same
        if (usedPairs.has(key)) return false;

        const tableForSpec = TABLE_SPECS[n1] ? n1 : (TABLE_SPECS[n2] ? n2 : null);
        if (tableForSpec === null) return false; // Should not happen if n1, n2 are 2-12

        const specN1 = TABLE_SPECS[n1];
        const specN2 = TABLE_SPECS[n2];

        // Check table limits for both numbers involved if they are different
        if (n1 !== n2) {
            if (specN1 && tableCounts[n1] >= specN1.max) return false;
            if (specN2 && tableCounts[n2] >= specN2.max) return false;
        } else { // n1 === n2
            if (specN1 && tableCounts[n1] >= specN1.max) return false;
        }

        const isKS1 = specN1?.isKS1 || specN2?.isKS1 || false; // Consider KS1 if either number's table is KS1
                                                        // This interpretation might need refinement based on exact MTC rules

        if (isKS1 && ks1Items >= KS_LIMITS.KS1.max) return false;
        if (!isKS1 && ks2Items >= KS_LIMITS.KS2.max) return false;
        
        if (ks1Items + ks2Items >= KS_LIMITS.KS1.min + KS_LIMITS.KS2.min) {
             if (isKS1 && (ks1Items + 1 > KS_LIMITS.KS1.max)) return false;
             if (!isKS1 && (ks2Items + 1 > KS_LIMITS.KS2.max)) return false;
        }

        questions.push({ id: `q-${n1}-${n2}-${Math.random().toString(36).substring(2, 9)}`, n1, n2, answer: n1 * n2, userAnswer: null, isCorrect: null });
        usedPairs.add(key);
        if (specN1) tableCounts[n1]++;
        if (n1 !== n2 && specN2) tableCounts[n2]++; // Count for the second number only if different
        if (isKS1) ks1Items++; else ks2Items++;
        return true;
    };
    
    // Try to meet minimums for each table
    for (let table = 2; table <= 12; table++) {
        let attempts = 0;
        if (!TABLE_SPECS[table]) continue;
        while (tableCounts[table] < TABLE_SPECS[table].min && questions.length < TOTAL_QUESTIONS && attempts < 50) {
            const n2 = Math.floor(Math.random() * 11) + 2; // 2 to 12
            addQuestion(table, n2);
            attempts++;
        }
    }

    // Try to meet KS minimums
    let ksAttempts = 0;
    while(ks1Items < KS_LIMITS.KS1.min && questions.length < TOTAL_QUESTIONS && ksAttempts < 150) {
        const ks1Tables = Object.keys(TABLE_SPECS).filter(t => TABLE_SPECS[parseInt(t)]?.isKS1).map(Number);
        if (ks1Tables.length === 0) break;
        const table = ks1Tables[Math.floor(Math.random() * ks1Tables.length)];
        const n2 = Math.floor(Math.random() * 11) + 2;
        addQuestion(table, n2);
        ksAttempts++;
    }
    ksAttempts = 0;
     while(ks2Items < KS_LIMITS.KS2.min && questions.length < TOTAL_QUESTIONS && ksAttempts < 150) {
        const ks2Tables = Object.keys(TABLE_SPECS).filter(t => !TABLE_SPECS[parseInt(t)]?.isKS1 && TABLE_SPECS[parseInt(t)]).map(Number);
        if (ks2Tables.length === 0) break;
        const table = ks2Tables[Math.floor(Math.random() * ks2Tables.length)];
        const n2 = Math.floor(Math.random() * 11) + 2;
        addQuestion(table, n2);
        ksAttempts++;
    }
    
    // Fill remaining questions
    let fillAttempts = 0;
    while (questions.length < TOTAL_QUESTIONS && fillAttempts < 500) {
        const n1 = Math.floor(Math.random() * 11) + 2;
        const n2 = Math.floor(Math.random() * 11) + 2;
        addQuestion(n1, n2);
        fillAttempts++;
    }
    // Emergency fill if still not enough (less strict)
    let emergencyAttempts = 0;
    while (questions.length < TOTAL_QUESTIONS && emergencyAttempts < 200) {
        const n1 = Math.floor(Math.random() * 11) + 2;
        const n2 = Math.floor(Math.random() * 11) + 2;
        const key = `${Math.min(n1,n2)}x${Math.max(n1,n2)}`;
        if (!usedPairs.has(key)) {
             questions.push({ id: `eq-${n1}-${n2}-${Math.random().toString(36).substring(2,9)}`, n1, n2, answer: n1*n2, userAnswer: null, isCorrect: null });
            usedPairs.add(key);
        }
        emergencyAttempts++;
    }
    // Shuffle
    for (let i = questions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [questions[i], questions[j]] = [questions[j], questions[i]];
    }
    return questions.slice(0, TOTAL_QUESTIONS);
};

const App: React.FC = () => {
    const [gameState, setGameState] = useState<GameState>('LOGIN');
    const [questions, setQuestions] = useState<Question[]>([]);
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [userAnswer, setUserAnswer] = useState('');
    const [score, setScore] = useState(0);
    const [timerValue, setTimerValue] = useState(QUESTION_TIME_LIMIT);
    const [pauseTimerValue, setPauseTimerValue] = useState(PAUSE_DURATION);
    
    const [loggedInUserCode, setLoggedInUserCode] = useState<string | null>(null);
    const [isAdmin, setIsAdmin] = useState(false);
    const [loginAttempt, setLoginAttempt] = useState({ userCode: '', pin: '' });
    const [loginError, setLoginError] = useState<string | null>(null);
    const [userPastResults, setUserPastResults] = useState<UserPracticeResult[]>([]);
    const [allUserResults, setAllUserResults] = useState<AdminResult[]>([]); // For admin

    const questionTimerRef = useRef<number | null>(null);
    const pauseTimerRef = useRef<number | null>(null);
    const answerInputRef = useRef<HTMLInputElement>(null);
    const userAnswerRef = useRef(userAnswer);

    useEffect(() => { userAnswerRef.current = userAnswer; }, [userAnswer]);

    const resetTimers = useCallback(() => {
        if (questionTimerRef.current) clearInterval(questionTimerRef.current);
        if (pauseTimerRef.current) clearInterval(pauseTimerRef.current);
    }, []);

    // --- Login and User Management ---
    const handleLoginInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setLoginAttempt(prev => ({ ...prev, [name]: value }));
        setLoginError(null);
    };

    const handleLogin = async () => {
        setLoginError(null);
        if (loginAttempt.userCode.toLowerCase() === 'admin' && loginAttempt.pin === '556') {
            setLoggedInUserCode('admin');
            setIsAdmin(true);
            setGameState('ADMIN_DASHBOARD');
            fetchAllUserResults();
            return;
        }

        if (!loginAttempt.userCode || !loginAttempt.pin) {
            setLoginError("User code and PIN cannot be empty.");
            return;
        }

        try {
            const userDocRef = doc(db, 'simpleUserResults', loginAttempt.userCode.toLowerCase());
            const userDocSnap = await getDoc(userDocRef);

            if (userDocSnap.exists()) {
                const userData = userDocSnap.data();
                if (userData.password === loginAttempt.pin) {
                    setLoggedInUserCode(loginAttempt.userCode.toLowerCase());
                    setIsAdmin(false);
                    setGameState('START');
                    fetchUserResults(loginAttempt.userCode.toLowerCase());
                } else {
                    setLoginError("Invalid user code or PIN.");
                }
            } else {
                setLoginError("Invalid user code or PIN.");
            }
        } catch (error) {
            console.error("Error during login:", error);
            setLoginError("Login failed. Please try again.");
        }
    };
    
    const handleLogout = () => {
        setLoggedInUserCode(null);
        setIsAdmin(false);
        setLoginAttempt({ userCode: '', pin: '' });
        setGameState('LOGIN');
        setUserPastResults([]);
        setAllUserResults([]);
    };

    // --- Firestore Data Operations ---
    const fetchUserResults = useCallback(async (userCode: string) => {
        if (!userCode) return;
        try {
            const resultsQuery = query(collection(db, 'simpleUserResults', userCode, 'scores'), orderBy('date', 'desc'));
            const querySnapshot = await getDocs(resultsQuery);
            const results: UserPracticeResult[] = [];
            querySnapshot.forEach((docSnap) => {
                results.push({ id: docSnap.id, ...docSnap.data() } as UserPracticeResult);
            });
            setUserPastResults(results);
        } catch (error) {
            console.error("Error fetching user results:", error);
        }
    }, []);

    const saveUserPracticeResult = async (result: Omit<UserPracticeResult, 'id'>) => {
        if (!loggedInUserCode || isAdmin) return;
        try {
            await addDoc(collection(db, 'simpleUserResults', loggedInUserCode, 'scores'), result);
            fetchUserResults(loggedInUserCode); // Refresh results
        } catch (error) {
            console.error("Error saving practice result:", error);
        }
    };
    
    const clearUserHistory = async () => {
        if (!loggedInUserCode || isAdmin) return;
        if (window.confirm("Are you sure you want to clear all your past results? This cannot be undone.")) {
            try {
                const scoresCollectionRef = collection(db, 'simpleUserResults', loggedInUserCode, 'scores');
                const querySnapshot = await getDocs(scoresCollectionRef);
                const batch = writeBatch(db);
                querySnapshot.forEach((docSnap) => {
                    batch.delete(docSnap.ref);
                });
                await batch.commit();
                setUserPastResults([]);
                alert("Your history has been cleared.");
            } catch (error) {
                console.error("Error clearing user history:", error);
                alert("Failed to clear history. Please try again.");
            }
        }
    };
    
    const fetchAllUserResults = async () => {
        if (!isAdmin) return;
        setGameState('LOADING');
        try {
            const usersSnapshot = await getDocs(collection(db, 'simpleUserResults'));
            const allResults: AdminResult[] = [];
            for (const userDoc of usersSnapshot.docs) {
                const userCode = userDoc.id;
                if (userCode === 'admin') continue; // Skip admin's own 'scores' if any
                const scoresSnapshot = await getDocs(collection(db, 'simpleUserResults', userCode, 'scores'));
                scoresSnapshot.forEach((scoreDoc) => {
                    allResults.push({ userCode, id: scoreDoc.id, ...scoreDoc.data() } as AdminResult);
                });
            }
            allResults.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
            setAllUserResults(allResults);
        } catch (error) {
            console.error("Error fetching all user results:", error);
        } finally {
            if (isAdmin) setGameState('ADMIN_DASHBOARD'); else setGameState('START'); // Or appropriate state
        }
    };


    // --- Game Logic Handlers ---
    const handleStartPractice = useCallback(() => {
        setGameState('LOADING');
        setTimeout(() => {
            const newQuestions = generatePracticeQuestions();
            if (newQuestions.length === 0) {
                alert("Failed to generate enough unique questions for the test. Please try refreshing the page.");
                setGameState('START'); return;
            }
            setQuestions(newQuestions);
            setCurrentQuestionIndex(0);
            setScore(0);
            setUserAnswer('');
            setGameState('PRACTICE_QUESTION');
        }, 100);
    }, []);

    const handleSubmitAnswer = useCallback(() => {
        resetTimers();
        const currentQuestion = questions[currentQuestionIndex];
        if (!currentQuestion) return;
        const answerIsCorrect = parseInt(userAnswerRef.current) === currentQuestion.answer;

        const updatedQuestions = [...questions];
        updatedQuestions[currentQuestionIndex] = { ...currentQuestion, userAnswer: userAnswerRef.current, isCorrect: answerIsCorrect };
        setQuestions(updatedQuestions);

        if (answerIsCorrect) setScore(prevScore => prevScore + 1);
        setGameState('PRACTICE_PAUSE');
    }, [questions, currentQuestionIndex, resetTimers]);

    // --- useEffect Hooks for Game Flow ---
    useEffect(() => {
        if (gameState === 'PRACTICE_QUESTION') {
            setTimerValue(QUESTION_TIME_LIMIT);
            setUserAnswer('');
            answerInputRef.current?.focus();
            questionTimerRef.current = window.setInterval(() => {
                setTimerValue(prev => {
                    if (prev <= 1) { handleSubmitAnswer(); return QUESTION_TIME_LIMIT; }
                    return prev - 1;
                });
            }, 1000);
        } else { if (questionTimerRef.current) clearInterval(questionTimerRef.current); }
        return () => { if (questionTimerRef.current) clearInterval(questionTimerRef.current); };
    }, [gameState, currentQuestionIndex, handleSubmitAnswer]);

    useEffect(() => {
        if (gameState === 'PRACTICE_PAUSE') {
            setPauseTimerValue(PAUSE_DURATION);
            pauseTimerRef.current = window.setInterval(() => {
                setPauseTimerValue(prev => {
                    if (prev <= 1) {
                        if (currentQuestionIndex < questions.length - 1) {
                            setCurrentQuestionIndex(idx => idx + 1);
                            setGameState('PRACTICE_QUESTION');
                        } else {
                            setGameState('PRACTICE_RESULTS');
                        }
                        return PAUSE_DURATION;
                    }
                    return prev - 1;
                });
            }, 1000);
        } else { if (pauseTimerRef.current) clearInterval(pauseTimerRef.current); }
        return () => { if (pauseTimerRef.current) clearInterval(pauseTimerRef.current); };
    }, [gameState, currentQuestionIndex, questions.length]);

    useEffect(() => {
        if (gameState === 'PRACTICE_RESULTS' && questions.length > 0 && loggedInUserCode && !isAdmin) {
            const newResultData = {
                score: score,
                totalQuestions: questions.length,
                date: new Date().toISOString(),
            };
            saveUserPracticeResult(newResultData);
        }
    }, [gameState, score, questions, loggedInUserCode, isAdmin]); // Removed saveUserPracticeResult from deps to avoid loop

    // --- Input Handlers ---
    const handleNumberPadInput = (digit: string) => {
        if (gameState !== 'PRACTICE_QUESTION') return;
        if (digit === 'clear') setUserAnswer('');
        else if (digit === 'enter') handleSubmitAnswer();
        else setUserAnswer(prev => (prev + digit).slice(0, 3));
    };

    const handleKeyboardInput = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (gameState !== 'PRACTICE_QUESTION') return;
        if (event.key === 'Enter') { event.preventDefault(); handleSubmitAnswer(); }
    };

    const handleAnswerChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        if (gameState !== 'PRACTICE_QUESTION') return;
        const numericValue = event.target.value.replace(/[^0-9]/g, '');
        setUserAnswer(numericValue.slice(0, 3));
    };
    
    const handleViewPastResults = () => {
        if (loggedInUserCode && !isAdmin) {
            fetchUserResults(loggedInUserCode); // Ensure fresh data
        }
        setGameState('VIEW_PAST_RESULTS');
    };
    const handleReturnToStart = () => setGameState('START');

    // --- Rendering Logic ---
    if (gameState === 'LOADING') return <div className="loading-message" role="status">Loading...</div>;

    if (gameState === 'LOGIN') {
        return (
            <div className="login-screen">
                <h2>Login</h2>
                <p>Enter your user code and PIN.</p>
                <input type="text" name="userCode" placeholder="User Code (e.g., ab)" value={loginAttempt.userCode} onChange={handleLoginInputChange} maxLength={10} aria-label="User Code"/>
                <input type="password" name="pin" placeholder="PIN (e.g., 123)" value={loginAttempt.pin} onChange={handleLoginInputChange} maxLength={10} aria-label="PIN"/>
                {loginError && <p className="error-message" role="alert">{loginError}</p>}
                <button onClick={handleLogin}>Login</button>
            </div>
        );
    }
    
    if (gameState === 'ADMIN_DASHBOARD') {
        return (
            <div className="admin-dashboard">
                <h2>Admin Dashboard - All User Results</h2>
                <button onClick={handleLogout} className="logout-button">Logout</button>
                {allUserResults.length > 0 ? (
                    <div className="results-table-container">
                        <table>
                            <thead>
                                <tr>
                                    <th>User Code</th>
                                    <th>Score</th>
                                    <th>Total Qs</th>
                                    <th>Date</th>
                                </tr>
                            </thead>
                            <tbody>
                                {allUserResults.map(result => (
                                    <tr key={result.id}>
                                        <td>{result.userCode}</td>
                                        <td>{result.score}</td>
                                        <td>{result.totalQuestions}</td>
                                        <td>{new Date(result.date).toLocaleString()}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <p>No results found for any user, or still loading.</p>
                )}
                 <button onClick={fetchAllUserResults} style={{marginTop: '20px'}}>Refresh Results</button>
            </div>
        );
    }

    if (gameState === 'START') {
        return (
            <div className="start-screen">
                <h1>Multiplication Practice</h1>
                <p>Welcome, {loggedInUserCode}!</p>
                <p>You will have {QUESTION_TIME_LIMIT} seconds for each question.</p>
                <p>There are {TOTAL_QUESTIONS} questions.</p>
                <button onClick={handleStartPractice}>Start Practice Test</button>
                <button onClick={handleViewPastResults} style={{marginTop: '10px'}}>View Your Past Results</button>
                <button onClick={handleLogout} className="logout-button">Logout</button>
            </div>
        );
    }
    
    if (gameState === 'VIEW_PAST_RESULTS') {
        return (
            <div className="past-results-screen">
                <h2>Your Past Results</h2>
                {userPastResults.length > 0 ? (
                    <ul className="past-results-list">
                        {userPastResults.map((result) => (
                            <li key={result.id}>
                                Score: {result.score} / {result.totalQuestions} - <span className="result-date">Date: {new Date(result.date).toLocaleString()}</span>
                            </li>
                        ))}
                    </ul>
                ) : (<p>No past results found for you.</p>)}
                <button onClick={handleReturnToStart}>Back to Start</button>
                {userPastResults.length > 0 && !isAdmin && (
                    <button onClick={clearUserHistory} className="clear-history-button">Clear Your History</button>
                )}
                <button onClick={handleLogout} className="logout-button">Logout</button>
            </div>
        );
    }

    if (gameState === 'PRACTICE_PAUSE') {
        const currentQActual = questions[currentQuestionIndex];
        const message = currentQActual?.isCorrect ? "Correct!" : (currentQActual ? `Incorrect. The answer was ${currentQActual.answer}.` : "Time's up!");
        return (
            <div className="pause-message" role="status" aria-live="polite">
                <p className={currentQActual?.isCorrect ? 'correct-feedback' : 'incorrect-feedback'}>{message}</p>
                Next question in {pauseTimerValue}...
            </div>
        );
    }

    if (gameState === 'PRACTICE_RESULTS') {
        return (
            <div className="results-screen">
                <h2>Practice Complete!</h2>
                <p className="results-score">Your Score: {score} / {questions.length}</p>
                <button onClick={handleStartPractice}>Try Again</button>
                <button onClick={handleViewPastResults} style={{marginTop: '10px'}}>View Your Past Results</button>
                <button onClick={handleLogout} className="logout-button">Logout</button>
            </div>
        );
    }

    const currentQ = questions[currentQuestionIndex];
    if (!currentQ) return <div className="loading-message" role="alert">Error: No question data. Please try refreshing.</div>;

    return (
        <div className="question-container">
            <div className="question-header">Question {currentQuestionIndex + 1} of {questions.length}</div>
            <div className="timer">Time left: {timerValue}s</div>
            <div className="question-text">
                {currentQ.n1} &times; {currentQ.n2} =
                <input ref={answerInputRef} type="text" inputMode="numeric" pattern="[0-9]*" className="answer-input" value={userAnswer} onChange={handleAnswerChange} onKeyDown={handleKeyboardInput} aria-label="Enter your answer" disabled={gameState !== 'PRACTICE_QUESTION'} autoComplete="off" />
            </div>
            <div className="number-pad" role="grid">
                {[..."123456789"].map(d => <button key={d} onClick={() => handleNumberPadInput(d)} disabled={gameState !== 'PRACTICE_QUESTION'}>{d}</button>)}
                <button onClick={() => handleNumberPadInput('clear')} className="control-button" disabled={gameState !== 'PRACTICE_QUESTION'}>Clear</button>
                <button onClick={() => handleNumberPadInput('0')} disabled={gameState !== 'PRACTICE_QUESTION'}>0</button>
                <button onClick={() => handleNumberPadInput('enter')} className="control-button" disabled={gameState !== 'PRACTICE_QUESTION'}>Enter</button>
            </div>
             <div aria-live="polite" className="visually-hidden">{`Question ${currentQuestionIndex + 1}. ${currentQ.n1} times ${currentQ.n2}. You have ${timerValue} seconds.`}</div>
        </div>
    );
};
export default App;
