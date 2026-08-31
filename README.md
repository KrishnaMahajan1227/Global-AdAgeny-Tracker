# Mahadhan Dummy Data — Seed Script

## Why a script, not a direct DB edit
Ye chat sandbox ka network sirf kuch allow-listed domains tak jaata hai, `supabase.co` uss list me nahi hai —
isliye main tumhari live DB ko is chat session se seedha touch nahi kar sakta. Ye script wahi kaam karta hai,
bas tumhe ise khud ek normal internet-wale machine (apna laptop, ya Claude Code) pe chalana hoga.

## Pehle: apni service_role key rotate kar lo
Tumne key ek chat message me paste ki thi — ye ek full-access secret hai. Kaam ke baad
(Supabase Dashboard → Project Settings → API → "service_role" → Regenerate) ek baar zaroor rotate kar dena,
taaki purani key kahin bhi expose ho to koi nuksaan na ho.

## Run karne ka tarika
```bash
npm install @supabase/supabase-js
export SUPABASE_URL="https://miqtgtasbxtgtaiowyeb.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<tumhari service_role key>"
node seed-mahadhan-data.js
```

## Ye script kya banayega
- **5 Campaigns**: Inshop Branding (Pan India), MS Pole Hoardings, Hoardings, Flex Printing, Foam Sheet
- **8 Work Orders (Purchase Orders)** under them, jinme se 4 tumhare uploaded PO PDFs ke exact
  po_number/date/amount use karte hain (2999025524, 2999025559, 2999025696, 2999026603) + ek
  2999025846 (jo Rajkot invoice me reference tha), aur 3 naye generated PO numbers un zones ke liye
  jinka koi source PDF nahi tha (MS Pole C1/C2, Hoardings Gujarat/MP) — inhe `notes` field me
  clearly "Generated for demo dataset" likh diya hai.
- **130 Shops**, zones ke hisaab se distribute (Pan India / Karnataka / North-South Maharashtra /
  Gujarat+MP), status mix: ~40% billed, ~30% installed/dispatched (bill pending), ~20% mid-process,
  ~10% abhi shuru.
- Har shop ke liye uske stage tak ka **poora chain**: survey + photos → approval → design → production
  → installation + photos → invoice (jahan billed hai).

## Photos
Real photo files upload nahi kiye — placeholder images (`placehold.co`, labelled e.g. "Shop Front - Pune")
use kiye hain jo turant browser me render ho jaate hain. Agar baad me real photos Storage me chahiye,
uska hissa alag se likh dunga.

## Cleanup
Script ke bottom me commented-out SQL hai jo `MAHADHAN_DUMMY_2026_08` tag se sab kuch delete kar deta hai,
agar kabhi is dummy batch ko hatana ho.

## Assumptions jo verify kar lena run se pehle
- Agency org ka naam me "Darshan" hona chahiye (already hai).
- Agency org me kam se kam ek active profile (user) hona chahiye — surveyor/installer/designer roles
  match kiye jaate hain agar exist karte hain, warna kisi bhi available profile pe fallback hota hai.
- Agar "Mahadhan" client org / clients row pehle se nahi hai to script khud bana degi.
