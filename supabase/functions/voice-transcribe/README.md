# voice-transcribe — setup

Ye function Gemini ko call karta hai (audio → transcript + numbers + detected language),
server-side, taaki Gemini API key kabhi bhi phone/browser ke JS bundle me expose na ho.

## Deploy karne ka tarika (apne laptop / Claude Code se, is chat se nahi — is sandbox ka
network Supabase tak nahi pahuchta)

```bash
# 1. Supabase CLI login (agar pehle se nahi hai)
npx supabase login

# 2. Apne project se link karo (project ref Supabase dashboard ke URL me milega)
npx supabase link --project-ref <your-project-ref>

# 3. Function deploy karo
npx supabase functions deploy voice-transcribe

# 4. Gemini API key ko secret ke roop me set karo — YE KABHI BHI .env ya
#    frontend code me mat daalna, sirf yahan:
npx supabase secrets set GEMINI_API_KEY=<tumhari-gemini-api-key>
```

Bas. Iske baad app khud hi is function ko use karega — koi frontend env var
change nahi karna. Agar ye deploy nahi hua ho, ya key set na ho, to app
khud-ba-khud purane (browser ke built-in) voice input pe fallback kar jayega —
kuch tootega nahi, bas accuracy thodi kam hogi.

## Test karne ka tarika (deploy ke baad)
Supabase Dashboard → Edge Functions → voice-transcribe → Logs me dekh sakte ho
ki calls aa rahi hain ya nahi, aur agar Gemini se koi error aata hai to wahi
uska reason bhi.

## Security note
- API key sirf Supabase secrets me rehti hai, kabhi bhi git me commit mat karna.
- Har request signed-in surveyor/installer ke JWT se verify hoti hai (function
  ke andar `supabaseClient.auth.getUser()`) — koi bhi random request nahi chalegi.
