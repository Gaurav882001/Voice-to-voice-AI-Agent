import os
import tempfile
from groq import Groq, APIError
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict
import uvicorn
import asyncio
from dotenv import load_dotenv
import logging

# Set up logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# Load environment variables from .env file
load_dotenv()

# === Configuration ===
DURATION = 5  # seconds to record query
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
app = FastAPI()

# CORS setup to allow frontend communication
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# === Initialize Groq Client ===
groq_client = Groq(api_key=GROQ_API_KEY)

# === Pydantic Model for /generate_response and /tts ===
class PromptRequest(BaseModel):
    prompt: str
    chat_history: List[Dict[str, str]] = []

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
def get_ai_response(prompt, chat_history, model="llama3-70b-8192"):
    try:
        # Log the received chat history
        logger.debug("Received chat_history: %s", chat_history)
        
        # Construct the messages array with chat history
        messages = [{"role": "system", "content": "You are a helpful AI assistant. Use the full conversation history to respond, especially for questions about previous interactions. If asked 'What did I ask you last?' or similar, refer to the most recent user message in the history."}]
        for chat in chat_history:
            if "user" in chat and "ai" in chat:
                messages.append({"role": "user", "content": chat["user"]})
                messages.append({"role": "assistant", "content": chat["ai"]})
        messages.append({"role": "user", "content": prompt})
        logger.debug("Messages sent to Groq API: %s", messages)
        response = groq_client.chat.completions.create(
            model=model,
            messages=messages
        )
        
        return response.choices[0].message.content
    except APIError as e:
        logger.error("API Error: %s", str(e))
        raise HTTPException(status_code=400, detail=str(e))

# === Step 4: TTS Generation ===
def generate_tts(text, voice="Fritz-PlayAI", model="playai-tts"):
    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_file:
        speech_path = tmp_file.name
    try:
        response = groq_client.audio.speech.create(
            model=model,
            voice=voice,
            input=text,
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
        elif "input too long" in str(e).lower() or "invalid input" in str(e).lower():
            raise HTTPException(status_code=400, detail="Input text too long for TTS processing. Please try a shorter response.")
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
        ai_text = get_ai_response(request.prompt, request.chat_history)
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