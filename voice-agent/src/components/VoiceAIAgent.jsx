import React, { useState, useRef } from 'react';
import { Square, Pause, X } from 'lucide-react';

export default function VoiceAIAgent() {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState('Click the square button to speak your query');
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioRef = useRef(new Audio());

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
        await processAudio(audioBlob);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorderRef.current.start();
      setIsRecording(true);
      setStatus('Recording your query... Speak now!');
    } catch (err) {
      console.error('Error starting recording:', err);
      setStatus('Error accessing microphone. Please allow microphone access.');
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
    if (match[1]) seconds += parseInt(match[1]) * 3600; // Hours
    if (match[2]) seconds += parseInt(match[2]) * 60; // Minutes
    if (match[3]) seconds += parseFloat(match[3]); // Seconds
    return seconds * 1000; // Convert to milliseconds
  };

  const processAudio = async (audioBlob, retryCount = 0, maxRetries = 3) => {
    try {
      const formData = new FormData();
      formData.append('file', audioBlob, 'user_input.wav');

      // Step 1: Transcribe audio
      const transcribeResponse = await fetch('/transcribe', {
        method: 'POST',
        body: formData,
      });
      if (!transcribeResponse.ok) {
        const errorData = await transcribeResponse.json();
        throw new Error(`Transcription failed: ${errorData.detail || transcribeResponse.statusText}`);
      }
      const { transcription } = await transcribeResponse.json();
      console.log('Transcription:', transcription); // Log for debugging
      if (!transcription || !transcription.trim()) {
        throw new Error('No valid transcription received');
      }
      setStatus(`You said: ${transcription}`);

      // Step 2: Get AI response
      const aiResponse = await fetch('/generate_response', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: transcription }),
      });
      if (!aiResponse.ok) {
        const errorData = await aiResponse.json();
        throw new Error(`AI response failed: ${errorData.detail || aiResponse.statusText}`);
      }
      const { response } = await aiResponse.json();
      console.log('AI Response:', response); // Log for debugging
      const truncatedResponse = response.slice(0, 200); // Match backend max_chars

      // Step 3: Generate and play TTS
      const ttsResponse = await fetch('/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: truncatedResponse }),
      });
      if (!ttsResponse.ok) {
        const errorData = await ttsResponse.json();
        if (ttsResponse.status === 429 && retryCount < maxRetries) {
          const retryAfter = parseRetryAfter(errorData.detail) || 10000; // Default 10s
          setStatus(`Rate limit reached. Retrying in ${retryAfter / 1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter));
          return processAudio(audioBlob, retryCount + 1, maxRetries);
        }
        if (ttsResponse.status === 400 && errorData.detail.includes('terms acceptance')) {
          throw new Error(
            'Please accept the terms for the `playai-tts` model at https://console.groq.com/playground?model=playai-tts to enable text-to-speech.'
          );
        }
        throw new Error(`TTS generation failed: ${errorData.detail || ttsResponse.statusText}`);
      }
      const audioBlobTTS = await ttsResponse.blob();
      const audioUrl = URL.createObjectURL(audioBlobTTS);
      audioRef.current.src = audioUrl;
      audioRef.current.play();
      setStatus('AI is responding...');
    } catch (err) {
      console.error('Error processing audio:', err);
      setStatus(`Error: ${err.message}`);
    } finally {
      setIsProcessing(false);
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
    if (isPaused) {
      audioRef.current.play();
      setIsPaused(false);
      setStatus('AI is responding...');
    } else {
      audioRef.current.pause();
      setIsPaused(true);
      setStatus('Response paused');
    }
  };

  const handleEndCall = () => {
    stopRecording();
    audioRef.current.pause();
    audioRef.current.src = '';
    setIsPaused(false);
    setIsProcessing(false);
    setStatus('Click the square button to speak your query');
  };

  return (
    <div className="flex justify-center items-center w-full h-screen bg-gray-100">
      <div className="relative w-1/2 h-screen bg-gradient-to-b from-black via-gray-900 to-blue-900 overflow-hidden">
        <div className="absolute bottom-0 left-0 right-0 h-64 bg-gradient-to-t from-blue-500/30 via-blue-600/20 to-transparent"></div>
        
        <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 flex items-center space-x-6">
          <button
            onClick={toggleRecording}
            disabled={isProcessing}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200 ${
              isRecording 
                ? 'bg-red-500/80 hover:bg-red-400/80' 
                : 'bg-gray-700/80 hover:bg-gray-600/80'
            } ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}
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

        <div className="absolute top-8 left-1/2 transform -translate-x-1/2">
          <div className="flex items-center space-x-2 px-4 py-2 bg-black/40 rounded-full">
            <div className={`w-2 h-2 rounded-full ${isRecording ? 'bg-red-400 animate-pulse' : isProcessing ? 'bg-yellow-400 animate-pulse' : 'bg-green-400'}`}></div>
            <span className="text-white text-sm">{status}</span>
          </div>
        </div>
      </div>
    </div>
  );
}



