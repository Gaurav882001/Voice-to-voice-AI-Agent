import React, { useState, useRef } from 'react';
import { Square, Pause, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';

export default function VoiceAIAgent() {
  const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:8000';
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState('Click the square button to speak your query');
  const [transcriptionText, setTranscriptionText] = useState('');
  const [chatHistory, setChatHistory] = useState([]);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioRef = useRef(new Audio());
  const processingControllerRef = useRef(null);

  const startRecording = async () => {
    try {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
        audioRef.current = new Audio();
      }
      if (processingControllerRef.current) {
        processingControllerRef.current.abort();
        processingControllerRef.current = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      setIsPaused(false);
      setIsProcessing(false);
      setTranscriptionText('');
      setStatus('Starting recording...');

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current.onstop = async () => {
        try {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
          if (audioBlob.size === 0) {
            throw new Error('Empty audio blob recorded');
          }
          await processAudio(audioBlob);
        } catch (err) {
          console.error('Error in onstop handler:', err);
          setStatus('Error processing audio');
          setIsProcessing(false);
        } finally {
          stream.getTracks().forEach(track => track.stop());
        }
      };

      mediaRecorderRef.current.onerror = (err) => {
        console.error('MediaRecorder error:', err);
        setStatus('Recording error occurred');
        setIsRecording(false);
        setIsProcessing(false);
      };

      mediaRecorderRef.current.start();
      setIsRecording(true);
      setStatus('Recording your query... Speak now!');
    } catch (err) {
      console.error('Error starting recording:', err);
      setStatus('Error accessing microphone. Please allow microphone access.');
      setIsRecording(false);
      setIsProcessing(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setIsProcessing(true);
      setStatus('Processing your query...');
    }
  };

  const parseRetryAfter = (errorMessage) => {
    const match = errorMessage.match(/Please try again in (\d+h)?(\d+m)?(\d+\.\d+s)?/);
    if (!match) return null;
    let seconds = 0;
    if (match[1]) seconds += parseInt(match[1]) * 3600;
    if (match[2]) seconds += parseInt(match[2]) * 60;
    if (match[3]) seconds += parseFloat(match[3]);
    return seconds * 1000;
  };

  const processAudio = async (audioBlob, retryCount = 0, maxRetries = 3) => {
    processingControllerRef.current = new AbortController();
    try {
      const formData = new FormData();
      formData.append('file', audioBlob, 'user_input.wav');

      const transcribeResponse = await fetch(`${API_URL}/transcribe`, {
        method: 'POST',
        body: formData,
        signal: processingControllerRef.current.signal,
      });
      if (!transcribeResponse.ok) {
        const errorData = await transcribeResponse.json();
        throw new Error(`Transcription failed: ${errorData.detail || transcribeResponse.statusText}`);
      }
      const { transcription } = await transcribeResponse.json();
      console.log('Transcription:', transcription);
      if (!transcription || !transcription.trim()) {
        throw new Error('No valid transcription received');
      }
      setTranscriptionText(transcription);
      setStatus(`You said: ${transcription}`);

      console.log('Chat History before request:', JSON.stringify(chatHistory)); // Enhanced logging
      const aiResponse = await fetch(`${API_URL}/generate_response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: transcription, chat_history: chatHistory }),
        signal: processingControllerRef.current.signal,
      });
      if (!aiResponse.ok) {
        const errorData = await aiResponse.json();
        throw new Error(`AI response failed: ${errorData.detail || aiResponse.statusText}`);
      }
      const { response } = await aiResponse.json();
      console.log('AI Response:', response);

      // Update chat history with the new interaction
      setChatHistory(prev => {
        const updatedHistory = [...prev, { user: transcription, ai: response }];
        console.log('Updated Chat History:', JSON.stringify(updatedHistory)); // Enhanced logging
        return updatedHistory;
      });
      setTranscriptionText('');

      try {
        const ttsResponse = await fetch(`${API_URL}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: response }),
          signal: processingControllerRef.current.signal,
        });
        if (!ttsResponse.ok) {
          const errorData = await ttsResponse.json();
          if (ttsResponse.status === 429 && retryCount < maxRetries) {
            const retryAfter = parseRetryAfter(errorData.detail) || 10000;
            console.log(`Rate limit reached. Retrying in ${retryAfter / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, retryAfter));
            return processAudio(audioBlob, retryCount + 1, maxRetries);
          }
          throw new Error(`TTS generation failed: ${errorData.detail || ttsResponse.statusText}`);
        }
        const audioBlobTTS = await ttsResponse.blob();
        const audioUrl = URL.createObjectURL(audioBlobTTS);
        audioRef.current.src = audioUrl;
        audioRef.current.play().catch(err => {
          console.error('Audio playback error:', err);
          setStatus('AI response received');
        });
        setStatus('AI is responding...');
      } catch (ttsError) {
        console.error('TTS Error:', ttsError);
        setStatus('AI response received');
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('Processing aborted due to new recording');
        setStatus('Click the square button to speak your query');
      } else {
        console.error('Error processing audio:', err);
        setStatus(transcriptionText ? `You said: ${transcriptionText}` : `Error processing query: ${err.message}`);
      }
    } finally {
      setIsProcessing(false);
      processingControllerRef.current = null;
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  const togglePause = () => {
    if (!audioRef.current.src || isProcessing) return;
    if (isPaused) {
      audioRef.current.play().catch(err => {
        console.error('Audio playback error:', err);
        setStatus('Error resuming audio');
      });
      setIsPaused(false);
      setStatus('AI is responding...');
    } else {
      audioRef.current.pause();
      setIsPaused(true);
      setStatus('Response paused');
    }
  };

  const handleEndCall = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    if (processingControllerRef.current) {
      processingControllerRef.current.abort();
      processingControllerRef.current = null;
    }
    setIsPaused(false);
    setIsProcessing(false);
    setIsRecording(false);
    setStatus('Click the square button to speak your query');
    setTranscriptionText('');
    setChatHistory([]);
  };

  return (
    <div className="flex justify-center items-center w-full h-screen bg-gray-100">
      <div className="relative w-1/2 h-screen bg-gradient-to-b from-black via-gray-900 to-blue-900 overflow-hidden">
        <style>
          {`
            .scrollbar-hide {
              -ms-overflow-style: none;
              scrollbar-width: none;
            }
            .scrollbar-hide::-webkit-scrollbar {
              display: none;
            }
            .markdown-content h1, .markdown-content h2, .markdown-content h3 {
              color: #ffffff;
              font-weight: bold;
              margin-bottom: 0.5rem;
            }
            .markdown-content p {
              color: #d1d5db;
              margin-bottom: 0.5rem;
            }
            .markdown-content ul, .markdown-content ol {
              color: #d1d5db;
              margin-left: 1.5rem;
              margin-bottom: 0.5rem;
            }
            .markdown-content li {
              margin-bottom: 0.25rem;
            }
            .markdown-content strong {
              color: #ffffff;
            }
            .markdown-content a {
              color: #60a5fa;
              text-decoration: underline;
            }
            .markdown-content code {
              background-color: #1f2937;
              padding: 0.2rem 0.4rem;
              border-radius: 0.25rem;
              color: #f3f4f6;
            }
            .markdown-content pre {
              background-color: #1f2937;
              padding: 1rem;
              border-radius: 0.5rem;
              overflow-x: auto;
            }
            .user-message {
              background-color: #374151;
              border-radius: 0.5rem 0.5rem 0 0.5rem;
              padding: 0.75rem;
              margin-bottom: 0.5rem;
              margin-left: 1rem;
              max-width: 80%;
              align-self: flex-end;
            }
            .ai-message {
              background-color: #1f2937;
              border-radius: 0.5rem 0.5rem 0.5rem 0;
              padding: 0.75rem;
              margin-bottom: 0.5rem;
              margin-right: 1rem;
              max-width: 80%;
              align-self: flex-start;
            }
          `}
        </style>
        <div className="absolute bottom-0 left-0 right-0 h-64 bg-gradient-to-t from-blue-500/30 via-blue-600/20 to-transparent"></div>
        
        <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 flex items-center space-x-6">
          <button
            onClick={toggleRecording}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200 ${
              isRecording 
                ? 'bg-red-500/80 hover:bg-red-400/80' 
                : 'bg-gray-700/80 hover:bg-gray-600/80'
            }`}
            title={isRecording ? 'Stop recording' : 'Start recording'}
          >
            <Square 
              size={16} 
              className={`${isRecording ? 'text-white fill-current' : 'text-white'}`}
            />
          </button>

          <button
            onClick={togglePause}
            disabled={isProcessing || !audioRef.current.src}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200 ${
              isPaused 
                ? 'bg-yellow-500/80 hover:bg-yellow-400/80' 
                : 'bg-gray-700/80 hover:bg-gray-600/80'
            } ${isProcessing || !audioRef.current.src ? 'opacity-50 cursor-not-allowed' : ''}`}
            title={isPaused ? 'Resume response' : 'Pause response'}
          >
            <Pause 
              size={20} 
              className="text-white"
            />
          </button>

          <button
            onClick={handleEndCall}
            className="w-12 h-12 rounded-full bg-red-500/90 hover:bg-red-400/90 flex items-center justify-center transition-all duration-200"
            title="End interaction"
          >
            <X size={20} className="text-white" />
          </button>
        </div>

        <div className="absolute top-8 left-1/2 transform -translate-x-1/2 w-4/5">
          <div className="flex items-center space-x-2 px-4 py-2 bg-black/40 rounded-full">
            <div className={`w-2 h-2 rounded-full ${isRecording ? 'bg-red-400 animate-pulse' : isProcessing ? 'bg-yellow-400 animate-pulse' : 'bg-green-400'}`}></div>
            <span className="text-white text-sm">{status}</span>
          </div>
          <div className="mt-4 p-4 bg-black/60 rounded-lg text-white text-sm max-h-[calc(100vh-200px)] overflow-y-auto scrollbar-hide flex flex-col">
            {chatHistory.map((chat, index) => (
              <div key={index} className="flex flex-col">
                <div className="user-message">
                  <p>{chat.user}</p>
                </div>
                <div className="ai-message">
                  <div className="markdown-content">
                    <ReactMarkdown rehypePlugins={[rehypeRaw]}>
                      {chat.ai}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            ))}
            {transcriptionText && (
              <div className="flex flex-col">
                <div className="user-message">
                  <p>{transcriptionText}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}