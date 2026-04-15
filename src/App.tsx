import { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { AudioPlayer, AudioRecorder } from './lib/audio';
import { Mic, MicOff, Send, Loader2, Sparkles, AlertCircle, Volume2, VolumeX, Square, Trash2, LogOut } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { auth, signInWithGoogle, logOut } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';

const apiKey = process.env.GEMINI_API_KEY || (import.meta as any).env.VITE_GEMINI_API_KEY;
// Initialize lazily to prevent module-level crash if API key is missing on Vercel
let ai: GoogleGenAI | null = null;
try {
  if (apiKey) {
    ai = new GoogleGenAI({ apiKey });
  }
} catch (e) {
  console.error("Failed to initialize Gemini API:", e);
}

type Message = {
  id: string;
  role: 'user' | 'model';
  text: string;
  isStreaming?: boolean;
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const [messages, setMessages] = useState<Message[]>([
    { id: '1', role: 'model', text: "Hi there! I'm your AI friend. We can chat here, or you can click the microphone to start a voice call with me." }
  ]);
  const [inputText, setInputText] = useState('');
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<string>('Kore'); // Default to Kore for clear speech
  const [isTTSEnabled, setIsTTSEnabled] = useState(true);
  
  const chatRef = useRef<any>(null);
  const sessionRef = useRef<any>(null);
  const audioPlayerRef = useRef<AudioPlayer | null>(null);
  const audioRecorderRef = useRef<AudioRecorder | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeLiveMessageIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ai) return;
    chatRef.current = ai.chats.create({
      model: "gemini-3-flash-preview",
      config: {
        systemInstruction: "You are a warm, friendly, and empathetic AI companion. You act like a close friend to the user. Keep your responses conversational, natural, and engaging.",
      },
    });
    
    audioPlayerRef.current = new AudioPlayer();
    audioRecorderRef.current = new AudioRecorder();

    return () => {
      disconnectVoice();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const showError = (msg: string) => {
    setErrorMsg(msg);
    setTimeout(() => setErrorMsg(null), 5000);
  };

  const playTTS = async (text: string) => {
    if (!ai) {
      showError("API Key is missing. Please add VITE_GEMINI_API_KEY to your Vercel environment variables.");
      return;
    }
    try {
      setIsModelSpeaking(true);
      const stream = await ai.models.generateContentStream({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: selectedVoice },
            },
          },
        },
      });
      
      audioPlayerRef.current?.init();
      
      for await (const chunk of stream) {
        const base64Audio = chunk.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (base64Audio) {
          audioPlayerRef.current?.play(base64Audio);
        }
      }
      
      // We don't have a perfect way to know exactly when TTS finishes playing here without tracking the buffer duration,
      // but we can reset the speaking state after a rough estimate or just let it be.
      // For simplicity, we'll turn off the speaking indicator after 2 seconds.
      setTimeout(() => setIsModelSpeaking(false), 2000);
    } catch (err) {
      console.error("TTS Error:", err);
      setIsModelSpeaking(false);
    }
  };

  const stopAudio = () => {
    audioPlayerRef.current?.stop();
    setIsModelSpeaking(false);
  };

  const clearChat = () => {
    setMessages([{ id: Date.now().toString(), role: 'model', text: "Chat cleared. How can I help you today?" }]);
    stopAudio();
  };

  const handleSendText = async () => {
    if (!inputText.trim()) return;
    
    if (!ai) {
      showError("API Key is missing. Please add VITE_GEMINI_API_KEY to your Vercel environment variables.");
      return;
    }
    
    if (!isVoiceActive && isModelSpeaking) {
      stopAudio();
    }
    
    const userMsg: Message = { id: Date.now().toString(), role: 'user', text: inputText };
    setMessages(prev => [...prev, userMsg]);
    setInputText('');

    if (isVoiceActive && sessionRef.current) {
      // Send text through Live API if connected
      sessionRef.current.sendRealtimeInput({ text: userMsg.text });
    } else {
      // Standard text chat
      const modelMsgId = (Date.now() + 1).toString();
      setMessages(prev => [...prev, { id: modelMsgId, role: 'model', text: '', isStreaming: true }]);
      
      try {
        const stream = await chatRef.current.sendMessageStream({ message: userMsg.text });
        let fullText = '';
        for await (const chunk of stream) {
          fullText += chunk.text;
          setMessages(prev => prev.map(m => m.id === modelMsgId ? { ...m, text: fullText } : m));
        }
        setMessages(prev => prev.map(m => m.id === modelMsgId ? { ...m, isStreaming: false } : m));
        
        if (isTTSEnabled && !isVoiceActive) {
          playTTS(fullText);
        }
      } catch (error: any) {
        console.error("Chat error:", error);
        const errorMessage = error?.message || "Sorry, I had trouble processing that.";
        setMessages(prev => prev.map(m => m.id === modelMsgId ? { ...m, text: `Error: ${errorMessage}`, isStreaming: false } : m));
        showError("Failed to send message.");
      }
    }
  };

  const toggleVoice = async () => {
    if (isVoiceActive) {
      disconnectVoice();
    } else {
      await connectVoice();
    }
  };

  const connectVoice = async () => {
    if (!ai) {
      showError("API Key is missing. Please add VITE_GEMINI_API_KEY to your Vercel environment variables.");
      return;
    }
    setIsConnecting(true);
    try {
      audioPlayerRef.current?.init();
      
      const sessionPromise = ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        callbacks: {
          onopen: () => {
            setIsConnecting(false);
            setIsVoiceActive(true);
            audioRecorderRef.current?.start((base64Data) => {
              sessionPromise.then(session => {
                session.sendRealtimeInput({
                  audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
                });
              });
            });
          },
          onmessage: async (message: LiveServerMessage) => {
            // Log message to see transcription format if any
            // console.log("Live message:", message);
            
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              setIsModelSpeaking(true);
              audioPlayerRef.current?.play(base64Audio);
            }
            
            const parts = message.serverContent?.modelTurn?.parts;
            if (parts) {
              const textPart = parts.find(p => p.text);
              if (textPart && textPart.text) {
                setMessages(prev => {
                  if (!activeLiveMessageIdRef.current) {
                    activeLiveMessageIdRef.current = Date.now().toString();
                    return [...prev, { id: activeLiveMessageIdRef.current, role: 'model', text: textPart.text! }];
                  } else {
                    return prev.map(m => m.id === activeLiveMessageIdRef.current ? { ...m, text: m.text + textPart.text! } : m);
                  }
                });
              }
            }
            
            if (message.serverContent?.interrupted) {
              audioPlayerRef.current?.stop();
              setIsModelSpeaking(false);
              activeLiveMessageIdRef.current = null;
            }
            
            if (message.serverContent?.turnComplete) {
              setIsModelSpeaking(false);
              activeLiveMessageIdRef.current = null;
            }
          },
          onclose: () => {
            disconnectVoice();
          },
          onerror: (err: any) => {
            console.error("Live API Error:", err);
            disconnectVoice();
            showError(`Voice connection error: ${err?.message || 'Connection lost'}`);
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } }
          },
          systemInstruction: "You are a warm, friendly, and empathetic AI companion. You act like a close friend to the user. Keep your responses conversational, natural, and engaging. Speak clearly with expressive prosody. You are currently in a voice call.",
          outputAudioTranscription: {},
        }
      });
      
      sessionRef.current = await sessionPromise;
    } catch (error: any) {
      console.error("Failed to connect voice:", error);
      setIsConnecting(false);
      disconnectVoice();
      if (error?.name === 'NotAllowedError') {
        showError("Microphone access denied. Please allow microphone permissions.");
      } else {
        showError(`Voice connection failed: ${error?.message || 'Unknown error'}`);
      }
    }
  };

  const disconnectVoice = () => {
    setIsVoiceActive(false);
    setIsConnecting(false);
    setIsModelSpeaking(false);
    audioRecorderRef.current?.stop();
    audioPlayerRef.current?.stop();
    if (sessionRef.current) {
      try {
        // The SDK might not expose a close method directly on the session object depending on version,
        // but if it does, we call it. Otherwise, we just let it be garbage collected or rely on the server timeout.
        if (typeof sessionRef.current.close === 'function') {
          sessionRef.current.close();
        }
      } catch (e) {}
      sessionRef.current = null;
    }
  };

  const handleLogin = async () => {
    setIsLoggingIn(true);
    try {
      await signInWithGoogle();
    } catch (error: any) {
      showError(`Login failed: ${error?.message || 'Unknown error'}`);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      await logOut();
      disconnectVoice();
      setMessages([{ id: '1', role: 'model', text: "Hi there! I'm your AI friend. We can chat here, or you can click the microphone to start a voice call with me." }]);
    } catch (error: any) {
      showError(`Logout failed: ${error?.message || 'Unknown error'}`);
    }
  };

  if (!isAuthReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0502]">
        <Loader2 className="w-8 h-8 text-[#ff4e00] animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col relative items-center justify-center">
        <div className="atmosphere"></div>
        
        {/* Error Toast */}
        <AnimatePresence>
          {errorMsg && (
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="absolute top-8 left-1/2 -translate-x-1/2 z-50 bg-red-500/80 backdrop-blur-md text-white px-6 py-3 rounded-full shadow-lg border border-red-400/50 flex items-center gap-2"
            >
              <AlertCircle className="w-5 h-5" />
              <span className="text-sm font-medium">{errorMsg}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass-panel p-10 rounded-3xl max-w-md w-full text-center z-10 flex flex-col items-center gap-6"
        >
          <div className="w-20 h-20 rounded-full bg-gradient-to-tr from-[#ff4e00] to-[#ff8a00] flex items-center justify-center shadow-[0_0_40px_rgba(255,78,0,0.4)]">
            <Sparkles className="w-10 h-10 text-white" />
          </div>
          
          <div>
            <h1 className="text-4xl font-serif font-medium tracking-wide mb-2">Aura</h1>
            <p className="text-white/60">Your personal AI companion</p>
          </div>

          <button
            onClick={handleLogin}
            disabled={isLoggingIn}
            className="w-full py-4 px-6 rounded-full bg-white text-black font-medium hover:bg-white/90 transition-colors flex items-center justify-center gap-3 disabled:opacity-70"
          >
            {isLoggingIn ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <>
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                </svg>
                Sign in with Google
              </>
            )}
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col relative">
      <div className="atmosphere"></div>
      
      {/* Error Toast */}
      <AnimatePresence>
        {errorMsg && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="absolute top-24 left-1/2 -translate-x-1/2 z-50 bg-red-500/80 backdrop-blur-md text-white px-6 py-3 rounded-full shadow-lg border border-red-400/50 flex items-center gap-2"
          >
            <AlertCircle className="w-5 h-5" />
            <span className="text-sm font-medium">{errorMsg}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="p-6 flex items-center justify-between z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-[#ff4e00] to-[#ff8a00] flex items-center justify-center shadow-[0_0_20px_rgba(255,78,0,0.4)]">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-serif font-medium tracking-wide">Aura</h1>
            <p className="text-xs text-white/50 uppercase tracking-widest">Your AI Companion</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <button onClick={clearChat} className="p-2 rounded-full bg-white/5 text-white/50 hover:bg-white/10 hover:text-white transition-colors" title="Clear Chat">
            <Trash2 className="w-4 h-4" />
          </button>
          
          <button onClick={handleLogout} className="p-2 rounded-full bg-white/5 text-white/50 hover:bg-white/10 hover:text-white transition-colors" title="Sign Out">
            <LogOut className="w-4 h-4" />
          </button>
          
          {isModelSpeaking && !isVoiceActive && (
            <button onClick={stopAudio} className="p-2 rounded-full bg-red-500/20 text-red-400 hover:bg-red-500/40 transition-colors" title="Stop Speaking">
              <Square className="w-4 h-4" fill="currentColor" />
            </button>
          )}

          {!isVoiceActive && (
            <>
              <button
                onClick={() => setIsTTSEnabled(!isTTSEnabled)}
                className={`p-2 rounded-full transition-colors ${isTTSEnabled ? 'bg-white/20 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}
                title={isTTSEnabled ? "Mute AI responses" : "Read AI responses aloud"}
              >
                {isTTSEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
              </button>
              <select
                value={selectedVoice}
                onChange={(e) => setSelectedVoice(e.target.value)}
                className="bg-white/10 border border-white/20 text-white text-sm rounded-full px-4 py-1.5 outline-none appearance-none cursor-pointer hover:bg-white/20 transition-colors backdrop-blur-md"
              >
                <option value="Kore" className="bg-[#1a1a1a]">Voice: Kore (Female)</option>
                <option value="Aoede" className="bg-[#1a1a1a]">Voice: Aoede (Female)</option>
                <option value="Zephyr" className="bg-[#1a1a1a]">Voice: Zephyr (Male)</option>
                <option value="Puck" className="bg-[#1a1a1a]">Voice: Puck (Male)</option>
                <option value="Charon" className="bg-[#1a1a1a]">Voice: Charon (Male)</option>
                <option value="Fenrir" className="bg-[#1a1a1a]">Voice: Fenrir (Male)</option>
              </select>
            </>
          )}

          {isVoiceActive && (
            <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/10 border border-white/20 backdrop-blur-md">
              <div className={`w-2 h-2 rounded-full ${isModelSpeaking ? 'bg-green-400 animate-pulse' : 'bg-[#ff4e00] animate-pulse'}`}></div>
              <span className="text-xs font-medium uppercase tracking-wider text-white/80">
                {isModelSpeaking ? 'Speaking' : 'Listening'}
              </span>
            </div>
          )}
        </div>
      </header>

      {/* Chat Area */}
      <main className="flex-1 overflow-y-auto p-6 scroll-mask z-10 flex flex-col gap-6">
        <AnimatePresence initial={false}>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div 
                className={`max-w-[80%] p-5 rounded-3xl ${
                  msg.role === 'user' 
                    ? 'bg-white/10 border border-white/20 backdrop-blur-md rounded-tr-sm' 
                    : 'glass-panel rounded-tl-sm'
                }`}
              >
                <p className={`lyric-content ${msg.role === 'user' ? 'text-white/90' : 'active'} text-lg sm:text-xl`}>
                  {msg.text}
                  {msg.isStreaming && <span className="inline-block w-2 h-5 ml-1 bg-white/50 animate-pulse align-middle"></span>}
                </p>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        <div ref={messagesEndRef} />
      </main>

      {/* Input Area */}
      <footer className="p-6 z-10">
        <div className="max-w-3xl mx-auto glass-panel rounded-full p-2 flex items-center gap-2">
          <button
            onClick={toggleVoice}
            disabled={isConnecting}
            className={`p-4 rounded-full transition-all duration-300 flex-shrink-0 ${
              isVoiceActive 
                ? 'bg-[#ff4e00] text-white shadow-[0_0_20px_rgba(255,78,0,0.4)]' 
                : 'bg-white/5 text-white/70 hover:bg-white/10 hover:text-white'
            }`}
          >
            {isConnecting ? (
              <Loader2 className="w-6 h-6 animate-spin" />
            ) : isVoiceActive ? (
              <Mic className="w-6 h-6" />
            ) : (
              <MicOff className="w-6 h-6" />
            )}
          </button>
          
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSendText()}
            placeholder={isVoiceActive ? "Voice call active... (you can still type)" : "Type a message..."}
            className="flex-1 bg-transparent border-none outline-none text-white/90 placeholder:text-white/30 px-4 font-sans text-lg"
          />
          
          <button
            onClick={handleSendText}
            disabled={!inputText.trim()}
            className="p-4 rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-50 disabled:hover:bg-white/10 transition-colors flex-shrink-0"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </footer>
    </div>
  );
}
