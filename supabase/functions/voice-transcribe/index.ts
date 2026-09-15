// Supabase Edge Function: voice-transcribe
//
// Receives a short audio clip recorded on the surveyor's phone (base64),
// forwards it to Gemini for transcription, and returns:
//   { transcript: string, detected_language: string, numbers: string[] }
//
// WHY THIS RUNS ON THE SERVER, NOT THE PHONE:
// The Gemini API key must never ship inside the app's JS bundle — anyone
// could open dev tools / decompile the PWA and steal it, then run up
// usage on your quota. This function holds the key as a server-side
// secret (set via `supabase secrets set`, never committed to the repo)
// and the app only ever talks to THIS function, authenticated as the
// already-signed-in surveyor.
//
// WHY GEMINI INSTEAD OF THE BROWSER'S BUILT-IN SPEECH RECOGNITION:
// The browser's Web Speech API is a single-language-per-session, fairly
// noise-sensitive transcriber. Gemini is a full multimodal model — it
// auto-detects the spoken language (including code-mixed Hindi/English,
// Marathi, Gujarati, etc.), and is instructed below to actively look past
// traffic/crowd/wind noise for the actual spoken words, which is exactly
// the "gaadiyan aane jaane wali awaaz" scenario this was built for.
//
// DEPLOY:
//   supabase functions deploy voice-transcribe
//   supabase secrets set GEMINI_API_KEY=your-key-here
//
// The app automatically falls back to the phone's built-in speech
// recognizer if this function isn't deployed yet, or if a call to it
// fails for any reason (see src/lib/geminiVoice.ts) — so nothing breaks
// if this hasn't been set up.

import { createClient } from 'npm:@supabase/supabase-js@2';

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
const GEMINI_MODEL = 'gemini-2.5-flash';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TRANSCRIBE_PROMPT = `You are transcribing a short voice note recorded on a construction/signage field survey app in India. The speaker may be talking in Hindi, Marathi, Gujarati, Tamil, Telugu, Kannada, Bengali, Punjabi, Malayalam, English, or a mix of these (code-switching is very common — e.g. "das by pandra feet"). There is very likely background noise: passing vehicles, traffic, wind, crowd chatter, construction sounds. Focus ONLY on the human speech and IGNORE all background noise — do not let engine/horn/wind sounds get transcribed as words.

The speaker is dictating a measurement — typically one or two numbers (width and/or height of a signboard), sometimes with a unit (feet/ft/inch/meter) or a quantity, sometimes just plain numbers or number-words in their language.

Respond with ONLY a single JSON object, no other text, in exactly this shape:
{
  "transcript": "<your best transcription, in the original language/script actually spoken>",
  "detected_language": "<short name like Hindi, Marathi, Gujarati, English, Hindi-English mix, etc.>",
  "numbers": ["<every number spoken, in the exact order spoken, as plain digit strings like \\"10\\" or \\"15.5\\", converted from number-words if needed>"]
}

If you genuinely cannot make out any clear numbers because of noise or silence, return "numbers": [] rather than guessing.`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    if (!GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'GEMINI_API_KEY not configured on the server. Run: supabase secrets set GEMINI_API_KEY=...' }),
        { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      );
    }

    // Verify the caller is a signed-in user of this project (not a public
    // free-for-all endpoint) — same pattern Supabase's own function
    // templates use: validate the incoming JWT against the project.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const { audioBase64, mimeType } = await req.json();
    if (!audioBase64 || typeof audioBase64 !== 'string') {
      return new Response(JSON.stringify({ error: 'audioBase64 is required' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const geminiResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: TRANSCRIBE_PROMPT },
                { inline_data: { mime_type: mimeType || 'audio/webm', data: audioBase64 } },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0,
          },
        }),
      },
    );

    if (!geminiResp.ok) {
      const errText = await geminiResp.text();
      console.error('[voice-transcribe] Gemini error:', geminiResp.status, errText);
      return new Response(JSON.stringify({ error: `Gemini request failed (${geminiResp.status})` }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const geminiData = await geminiResp.json();
    const rawText: string | undefined = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      console.error('[voice-transcribe] No text in Gemini response:', JSON.stringify(geminiData));
      return new Response(JSON.stringify({ error: 'Gemini returned no transcription' }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    let parsed: { transcript?: string; detected_language?: string; numbers?: unknown[] };
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Model occasionally wraps JSON in ```json fences despite the
      // instruction not to — strip and retry once before giving up.
      const stripped = rawText.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(stripped);
    }

    return new Response(
      JSON.stringify({
        transcript: parsed.transcript || '',
        detected_language: parsed.detected_language || null,
        numbers: Array.isArray(parsed.numbers) ? parsed.numbers.map(String) : [],
      }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[voice-transcribe] Unhandled error:', err);
    return new Response(JSON.stringify({ error: 'Internal error processing voice note' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
