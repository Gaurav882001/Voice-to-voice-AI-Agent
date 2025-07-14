import os
import tempfile
import sounddevice as sd
from scipy.io.wavfile import write
from groq import Groq, APIError
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import asyncio
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# === Configuration ===
DURATION = 5  # seconds to record query
# GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_API_KEY = "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"
app = FastAPI()

# CORS setup to allow frontend communication
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://192.168.21.63:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# === Initialize Groq Client ===
groq_client = Groq(api_key=GROQ_API_KEY)

# === Pydantic Model for /generate_response and /tts ===
class PromptRequest(BaseModel):
    prompt: str

# === Step 1: Record Audio (for testing locally, not used in API) ===
def record_audio(filename, duration=DURATION):
    sample_rate = 44100
    audio = sd.rec(int(duration * sample_rate), samplerate=sample_rate, channels=1)
    sd.wait()
    write(filename, sample_rate, audio)
    return filename

# === Step 2: Transcribe Audio ===
async def transcribe_audio(file: UploadFile):
    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_file:
        content = await file.read()
        tmp_file.write(content)
        tmp_file_path = tmp_file.name

    try:
        with open(tmp_file_path, "rb") as audio_file:
            transcription = groq_client.audio.transcriptions.create(
                file=audio_file,
                model="whisper-large-v3-turbo",
                language="en",
                response_format="verbose_json"
            )
        return transcription.text
    finally:
        os.remove(tmp_file_path)

# === Step 3: AI Response ===
def get_ai_response(prompt, model="llama3-70b-8192"):
    try:
        response = groq_client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}]
        )
        return response.choices[0].message.content
    except APIError as e:
        raise HTTPException(status_code=400, detail=str(e))

# === Step 4: TTS Generation ===
def generate_tts(text, voice="Fritz-PlayAI", model="playai-tts", max_chars=200):  # Further reduced max_chars
    short_text = text[:max_chars]
    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_file:
        speech_path = tmp_file.name
    try:
        response = groq_client.audio.speech.create(
            model=model,
            voice=voice,
            input=short_text,
            response_format="wav"
        )
        response.write_to_file(speech_path)
        return speech_path
    except APIError as e:
        if "terms acceptance" in str(e).lower():
            raise HTTPException(
                status_code=400,
                detail="The `playai-tts` model requires terms acceptance. Please accept the terms at https://console.groq.com/playground?model=playai-tts"
            )
        elif "rate_limit_exceeded" in str(e).lower():
            raise HTTPException(status_code=429, detail=str(e))
        raise HTTPException(status_code=400, detail=str(e))

# === API Endpoints ===
@app.post("/transcribe")
async def transcribe_endpoint(file: UploadFile = File(...)):
    if not file.filename.endswith(".wav"):
        raise HTTPException(status_code=400, detail="Only WAV files are supported")
    try:
        text = await transcribe_audio(file)
        if not text.strip():
            raise HTTPException(status_code=400, detail="Transcription is empty")
        return {"transcription": text}
    except APIError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/generate_response")
async def generate_response_endpoint(request: PromptRequest):
    try:
        if not request.prompt.strip():
            raise HTTPException(status_code=422, detail="Prompt cannot be empty")
        ai_text = get_ai_response(request.prompt)
        return {"response": ai_text}
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/tts")
async def tts_endpoint(request: PromptRequest):
    try:
        if not request.prompt.strip():
            raise HTTPException(status_code=422, detail="Text cannot be empty")
        speech_path = generate_tts(request.prompt)
        return FileResponse(speech_path, media_type="audio/wav", filename="response.wav")
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# === Main (for local testing) ===
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)