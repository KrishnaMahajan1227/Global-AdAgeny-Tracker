# Darshan Ops — Image Prompt Pack (v3, premium)

## The set: one city, six photographs, zero baked-in text

Every checkpoint in the product lives in **one consistent city** now — not
six different stock photos from six different worlds. Three locations get
revisited from a second angle so the same stretch of scroll never repeats
the exact same frame twice, without breaking consistency:

| File | Used for | Role |
|---|---|---|
| `01_main_city_revamp.jpg` | Hero + both flow-arc scenes | Establishing aerial |
| `03_shop_survey_with_people.jpg` | Survey + Installation | Shop spot |
| `04_agency_exterior_revamp.jpg` | Design + Ops | Agency spot — angle A |
| `04b_agency_floor.jpg` | Production + Load-check | Agency spot — angle B |
| `08_client_tower_revamp.jpg` | Client visibility | Client spot — angle A |
| `09b_client_close.jpg` | Billing | Client spot — angle B |

All six: **2400×1350 or larger, 16:9, JPG, no watermark, no logo, no readable
text/UI/dashboard baked into the pixels anywhere in frame.** The flow-arc
graphics and the survey measurement card are rendered live in code — never
put them in the photo.

---

## Master style bible — paste before every prompt, unchanged every time

```
Editorial architectural photography, the kind used for a nine-figure
real-estate marketing campaign — not a generic stock photo. Shot from a
drone at a high three-quarter aerial angle over a sunlit coastal
metropolitan business district: a wide palm-lined boulevard, contemporary
glass-and-white-stone towers (8–35 storeys) with real material depth —
brushed metal mullions, warm travertine podiums, glass that actually
reflects the sky rather than looking flat. Soft warm golden-hour key light
from camera-left, gentle atmospheric haze toward the horizon, a calm bay in
the far distance. Color grade: rich warm highlights, cool-leaning shadows,
restrained film-like contrast — think a luxury travel magazine spread, not
an HDR real-estate listing. Tack-sharp focus, natural 35mm-equivalent
perspective, no fisheye, no drone-shot barrel distortion. Absolutely no
readable text, logos, signage copy, UI panels, graphs, dashboards, or
watermarks anywhere in the frame. 16:9, 2400x1350 or larger.

Negative prompt: text, watermark, signature, logo, blurry, low resolution,
oversaturated, HDR halo, fisheye distortion, warped architecture, extra
limbs, illustration, cartoon, painterly, flat lighting, stock-photo look.
```

---

## Prompt 1 — Hero establishing aerial
*→ `01_main_city_revamp.jpg`*

```
[MASTER STYLE BIBLE]

Wide establishing shot, camera pulled back and high, looking down the full
length of the boulevard toward the bay — the frame that sells the whole
world in one glance. The boulevard curves gently through the composition. A
cluster of the tallest towers sits right-of-center, one unmistakably taller
than the rest as the skyline's signature landmark. Light traffic, palm
trees and low storefronts lining the street. Composition stays spacious —
nothing important within 15% of any edge.
```

## Prompt 2 — Shop spot (survey / installation)
*→ `03_shop_survey_with_people.jpg`*

```
[MASTER STYLE BIBLE]

Same city, same boulevard, camera now at street level, looking up at one
modern storefront with a large illuminated sign board above the entrance
(blank/generic — no readable brand text). Lower-left to lower-center of
frame: two people in reflective safety vests, three-quarter or back angle,
one holding a tablet, one raising a measuring tool toward the sign board —
mid site-survey. Keep both people and the storefront well inside the center
70% of frame. Golden-hour light raking across the glass. Palm trees and
softly-blurred parked cars in the background.
```

## Prompt 3 — Agency spot, angle A (design / ops)
*→ `04_agency_exterior_revamp.jpg`*

```
[MASTER STYLE BIBLE]

Same city, camera at mid-height three-quarter angle toward one specific
mid-rise glass office building, set back slightly from the boulevard —
visibly distinct from the shop storefront and the hero's landmark tower.
Warm interior lighting glows through several floors of glass, hinting at
active work inside, no readable signage. Landscaped plaza at ground level.
No people needed. Same materials, same key light, same city as every other
frame in this set.
```

## Prompt 4 — Agency spot, angle B (production / load-check)
*→ `04b_agency_floor.jpg`*

```
[MASTER STYLE BIBLE]

The exact same agency building as Prompt 3, from a different, closer
vantage — camera lower and nearer, angled toward the building's loading /
ground-floor level rather than the full elevation. A service entrance or
covered dock area visible at street level, suggesting active production and
dispatch behind the scenes, still no readable signage or text. Same time of
day, same light direction, same color grade as Prompt 3 — this must read as
"a different moment at the same building," not a different building.
```

## Prompt 5 — Client spot, angle A (client visibility)
*→ `08_client_tower_revamp.jpg`*

```
[MASTER STYLE BIBLE]

Same city, camera looking up at a taller, more premium glass tower — clearly
distinct from the agency building, positioned further along the boulevard
toward the bay. More polished and corporate than the agency spot: cleaner
glass lines, slightly taller, unmistakably a client HQ. Warm key light
matching every other frame. No people needed.
```

## Prompt 6 — Client spot, angle B (billing / closing)
*→ `09b_client_close.jpg`*

```
[MASTER STYLE BIBLE]

The exact same client tower as Prompt 5, camera now closer and slightly
lower, framing the building's entrance plaza or lower floors rather than
the full elevation — a sense of arrival, of a conversation concluding. Light
can ease very slightly toward the blue hour at the very top edge of frame
only (sky beginning to cool), but the tower itself stays lit in the same
warm key light as the rest of the set. No people needed.
```

---

## Consistency checklist before accepting any generated image

- Same light direction and warmth as the hero shot
- Same architectural language — glass, white stone, travertine, palm trees, boulevard width
- Same color grade — warm highlights, cool shadows, restrained contrast
- **Zero baked-in text, cards, dashboards, or watermarks** — the single most important rule; anything baked in eventually gets cropped or reads soft/blurry on a real screen
- Each "angle B" reads as *the same place, a different moment* — not a different building

## What's built in code already, no image needed

- Flow-arc graphics (Shop→Agency, Agency→Client) — live SVG line + floating cards
- Survey measurement readout (Width / Height / GPS) — live rendered card
- Magnetic-glow CTA buttons, 3D tilt-on-hover checkpoint cards, a soft cursor-follow glow in the hero, animated count-up stats in the client portal preview, and a subtle film-grain texture on dark panels — all interaction polish, zero new assets required

## When you have the files

Drop them in at the exact paths in the table above — nothing else changes. Or upload the six files back to me and I'll wire them in and check the crop on a few screen widths.
