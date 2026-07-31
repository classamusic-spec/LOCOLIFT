# Loco Lift — Art Reference

**Binding art direction for every visual module. This is the standard screenshots get graded against.**

Companion to `docs/ARCHITECTURE.md` §"Art direction". Where this document and
`ARCHITECTURE.md` disagree on a number, this document wins; where it disagrees on
a *rule* (ownership, no external assets, performance), `ARCHITECTURE.md` wins.

Palette constants already in `src/core/Config.ts` (`PALETTE`) are the *seed*, not
the target. §4 below supersedes and extends them. Do not edit `Config.ts` to match
this doc — build your local palettes from the tables here and let the integrator
reconcile.

---

## 0. North star

> **Old San Juan at 50 metres per second.** A real, specific, 500-year-old Spanish
> colonial city — wall-to-wall pastel townhouses over blue-grey slag cobblestone,
> iron balconies dripping bougainvillea, sandstone forts holding back the Atlantic —
> rendered with the **saturation, contrast and silhouette discipline of a Sega arcade
> cabinet**. Every surface is period-correct and materially believable. Every frame
> is legible at speed. Nothing is beige, nothing is muddy, nothing is a generic
> "tropical town". The city is the star; the Jeep is the brightest thing in it.

Three tests any frame must pass, in this order:

1. **Place test** — could someone who has been to Old San Juan name the city from
   this screenshot? (Adoquín + wall-to-wall façades + garita silhouette + iron
   balconies + azulejo street plaques.)
2. **Speed test** — can a first-time player, at 45 m/s, tell where the road goes in
   under 200 ms?
3. **Arcade test** — is this obviously a *game*, not a photogrammetry demo? High
   chroma, clean value separation, exaggerated bounce light, no grey mush.

Reference mental image: **Crazy Taxi's shape-clarity and colour punch × Forza
Horizon's material and lighting finish × a real UNESCO World Heritage streetscape.**

---

## 1. Hard numbers — architecture

All values are metres unless stated. "Real" = documented/measured reality.
"**Spec**" = what implementers must build. Where they differ, the spec is a
deliberate arcade adjustment and the reason is given.

### 1.1 Street corridor and grid

| Element | Real | **Spec** | Notes |
|---|---|---|---|
| Historic core extent | ~990 × 396 m | **1400 × 620 m** built city | Scaled 1.4× so a 90 s shift covers ~3–4 blocks per fare |
| Total drivable bounds (incl. forts, esplanade, docks) | — | **1620 × 900 m** | Fits `drawDistance` 1300 (ultra) and `camera.far` 2200 |
| Block footprint | ~91 × 55 m ("cuadras de poco más de cien yardas") | **88 × 56 m** | Long axis along the calles largas |
| Grid pitch, long axis (street c/c) | — | **100.5 m** | 88 m block + 12.5 m street |
| Grid pitch, cross axis (street c/c) | — | **68.5 m** | 56 m block + 12.5 m street |
| Arterial street, façade-to-façade | ~11 m | **16.0** | Fortaleza / San Francisco analogues |
| — carriageway | ~6 m | **11.0** | 2 lanes @ 4.0 + 1.5 m drift margin |
| — sidewalk each side | ~1.2 m | **2.5** | |
| Standard street, façade-to-façade | ~9 m | **12.5** | The default. Most of the map. |
| — carriageway | ~5.5 m | **8.5** | |
| — sidewalk each side | ~1.2 m | **2.0** | |
| Narrow street (calle estrecha) | ~7.5 m | **9.5** | Risk/reward shortcuts |
| — carriageway | ~5 m | **6.5** | |
| Callejón (alley) | 3–4 m | **4.2** | No sidewalk. Drivable at cost. 4 named ones exist in reality |
| Seafront boulevard (Norzagaray / Recinto Sur) | ~14 m | **22.0** | 14 m carriageway, 4 m promenade seaward |
| Kerb height / width | 0.15 / 0.20 | **0.14 / 0.20** | Mountable at >12 m/s with a 0.06 m bump impulse |
| Street cross-fall (camber) | ~2 % | **2.0 %** crown | 0.085 m rise over 8.5 m. Bake into road mesh, not normal map |
| Longitudinal grade, cross streets | up to 12 % | **6–11 %**, max **13 %** | The N-S "uncomfortable incline" is the city's signature; use it for air time |
| Longitudinal grade, long streets | ~0–2 % | **0–2.5 %** | "leveled, wide and straight" |
| Street-name plaque | azulejo tile panel | **0.42 × 0.30**, centre **2.55** above sidewalk | Blue-on-white ceramic. Mandatory, one per corner per street |

### 1.2 Townhouse (casa) — the workhorse building

Documented typology: façades aligned flush to the street, **no front gardens
anywhere**; bays organised tripartite or quadripartite (1 bay on the narrowest
houses, up to 7 on a *palacete*); 1–3 storeys standard; interior courtyard in
every building except churches, usually pushed against a party wall rather than
central; balconettes at ground level and **never a balcony at ground level**.

| Element | Real | **Spec** | Notes |
|---|---|---|---|
| Lot frontage, 3-bay house | 7.5–9 m | **8.7** | 3 × 2.90 bay module |
| Lot frontage, 4-bay | 10–11.5 m | **11.6** | |
| Lot frontage, 1-bay (narrow) | 3.5–4.5 m | **4.3** | Use sparingly, 1 in 12 |
| Lot depth | 18–30 m | **22.0** | Front block 9 m, patio 5 m, rear wing 8 m |
| **Bay module (c/c)** | — | **2.90** | The single most important façade number |
| Ground storey, floor-to-floor | 4.0–4.6 m | **4.30** | Tall; commercial/zaguán |
| Upper storey, floor-to-floor | 3.5–4.2 m | **3.80** | |
| Cornice underside, 2-storey | — | **8.10** | 4.30 + 3.80 |
| Cornice band height / projection | — | **0.42 / 0.30** | Continuous, dead level, runs across the whole façade |
| Parapet above cornice (azotea) | 1.0–1.3 m | **1.10** | Top of parapet 2-storey = **9.62** |
| Total height, 1 / 2 / 3 storey | — | **5.8 / 9.6 / 13.4** | To parapet top |
| Wall thickness, exterior | 0.94 m (tapiería 3'1") / 0.6–0.9 masonry | **0.75** | Visible in every reveal — do not model 0.1 m walls |
| Wall thickness, party wall | 0.69 m (2'3") | **0.50** | |
| Reveal depth at openings | — | **0.28** | Set glass/shutter this far back. This is what makes windows read as holes, not decals |
| Plinth / podium base course | 0.4–0.9 m | **0.55** | Darker, dirtier, splash-stained band at pavement |

### 1.3 Openings

| Element | Real | **Spec** | Notes |
|---|---|---|---|
| Ground-floor door, clear width | 1.3–1.6 m | **1.40** | Double leaf, 0.70 each |
| Ground-floor door, clear height | 3.0–3.4 m | **3.20** | Head at 3.20 above floor |
| Fanlight / transom above door | 0.45–0.65 m | **0.55** | Semicircular or segmental; radiating glazing bars, 7 or 9 bars |
| Door panel grid | — | **2 wide × 4 tall** per leaf, stile 0.11, rail 0.13 | Panels recessed 0.022 |
| Ground-floor window (with balconette) | — | **1.20 w × 2.60 h**, sill at **0.85** | Behind an iron *reja* or shallow balconette |
| Upper-floor balcony door | — | **1.10 w × 2.70 h** | Full-height, opens onto the balcony. Never a "window" upstairs on the street face |
| Upper transom | — | **0.40** | Rectangular with 3 vertical bars, or louvered |
| Opening : pier ratio | — | **1.20 : 1.70** | Solid must outweigh void at 59 : 41. If your façade is more glass than wall, it is wrong |
| Encadrement (painted border) width | — | **0.20** | Projects **0.035** from the wall plane |
| Encadrement colour rule | documented | **always lighter than the wall** | See §4.2 |
| "Floating lintel" motif | period-correct | on **1 in 5** buildings | A stucco lintel band hovering 0.10 above the encadrement head |

### 1.4 Balconies (balcón) and balconettes

The documented rule, verbatim in spirit: *balconettes* at ground level, *balconies*
from the second floor up, **never a balcony at ground level**. Wooden-balustrade
balconies are usually **roofed**; metal-balustrade balconies usually are **not**.

| Element | Real | **Spec** | Notes |
|---|---|---|---|
| Balconette (balcón raso) projection | 0.12–0.20 m | **0.16** | Just the iron guard bellying out from the reveal |
| Balconette height | 0.95–1.05 m | **1.00** | Bar spacing 0.11, bar Ø 0.016, 2 horizontal rails |
| Iron balcony, projection (depth) | 0.75–1.05 m | **0.95** | Deep enough to read in silhouette from 60 m |
| Iron balcony, slab thickness | 0.12–0.18 m | **0.15** | |
| Iron balcony, balustrade height | 0.95–1.10 m | **1.02** | |
| Iron balustrade bar pitch | 0.10–0.13 m | **0.115** | Bar Ø 0.018, twisted or plain; top rail Ø 0.032 |
| Iron balcony, bracket (ménsula) | — | **3 brackets**, pitch **1.45**, projection **0.85**, thickness **0.05** | S-scroll profile |
| Wooden roofed balcony, projection | 0.9–1.3 m | **1.15** | |
| — balustrade | turned balusters | **1.00** high, baluster Ø **0.075**, pitch **0.16** | |
| — roof clear height above balcony floor | — | **2.45** | |
| — roof pitch / overhang | — | **12°**, overhang **0.20** | Corrugated zinc or clay tile |
| — supporting posts | — | **0.10 × 0.10**, at balcony ends + 1 mid | |
| Balcony floor underside height (2nd fl.) | — | **4.30** | = ground storey height |
| Balcony run | — | unites **all bays** of the upper floor on ~55 % of houses; single-bay on 45 % | "physically united by the roofed wooden balcony" |
| Corner *cuarto esquinero* balcony | period-correct | wraps the corner on **1 in 6** corner buildings | High-value silhouette moment — put one on every plaza corner |
| Plants on balcony | ubiquitous | **≥ 60 %** of balconies carry 2–5 pots | Bougainvillea, croton, helecho, orquídea. Trailing growth 0.4–1.2 m |
| Laundry / flag on balcony | common | **≤ 15 %** of balconies | 1 in 3 of those is a Puerto Rican flag (standard flag — see §7.4) |

### 1.5 Persianas (louvered shutters) and carpentry

Historically a pair of louvered leaves was added *outside* the standard double
doors from the 19th century on. Model both layers where you can afford it.

| Element | **Spec** |
|---|---|
| Persiana leaf width | **0.62** (2 leaves per 1.24 opening; 0.55 for the 1.10 opening) |
| Persiana leaf height | matches opening: **2.70** upstairs, **3.20** downstairs |
| Louvre slat pitch | **0.048** |
| Louvre slat thickness / depth | **0.010 / 0.022** |
| Louvre slat angle | **35°** from horizontal, sloping down-and-out |
| Slat count per upstairs leaf | **52** — bake to a normal + AO map, never model as geometry beyond 25 m |
| Stile / rail width | **0.075 / 0.090** |
| Mid rail position | **0.42** of leaf height from bottom |
| Open-shutter angle variance | **0 / 20 / 45 / 78 / 105°**, random per leaf | 
| Fraction of shutters closed | **35 %** by day, **62 %** at night |

### 1.6 Roofs

| Element | **Spec** | Notes |
|---|---|---|
| Azotea (flat roof) share | **70 %** of townhouses | "flat roofs like the ones in Cádiz" — this is the dominant roof |
| Azotea slope | **1.5 %** to a scupper | Scupper spout projecting 0.30 through the parapet, 1 per 8 m |
| Azotea clutter | **cistern/tank 1.1 Ø × 1.4 h**, TV aerial, 2–5 potted plants, clothesline, AC condenser (modern) | Visible from balconies and from the fort ramparts |
| Tiled roof share | **30 %** | Barrel/Spanish tile, on churches, corner buildings, rear wings |
| Tile pitch | **22°** | |
| Barrel tile pan/cover pitch | **0.185** across, tile length **0.40**, cover Ø **0.115** | Ridge tile Ø 0.14 |
| Eaves overhang (tiled) | **0.45** | With exposed rafter tails 0.08 × 0.14 at 0.55 pitch |
| Parapet coping | **0.28 w × 0.10 h**, projecting 0.04 each side | |

### 1.7 Courtyards, party walls, and the wall-to-wall rule

- **Zero gaps.** Between two buildings on the same block face there is **never** a
  gap, a side yard, a driveway, or a visible side wall. Adjacent façades share a
  party wall and their stucco planes meet with at most a **0.04 m** offset. A
  screenshot showing daylight between two townhouses is an automatic fail.
- Façade planes may step **±0.06 m** between neighbours (different renders) and
  parapet heights **must** step: no two adjacent buildings share the same parapet
  height. Minimum step **0.55 m**, target average step **1.4 m**.
- **Interior courtyard (patio)** in every non-religious building. Typical
  **5.0 × 6.5 m**, positioned against a party wall, not centred. Visible from
  above (fort ramparts, azoteas) and through open zaguanes at street level —
  this is worth doing because it is what makes the block read as inhabited rather
  than as an extruded shell.
- **Zaguán**: a through-passage **2.6 m wide × 3.6 m high**, 6–9 m deep, from the
  street door to the patio. Present on ~40 % of houses. At street level, an open
  zaguán is a **dark rectangle with a bright warm sunlit patio at the far end** —
  a free, gorgeous, cheap depth cue. Use a small emissive card if you cannot
  afford geometry.

### 1.8 Fortifications, gate, and urban furniture

| Element | Real | **Spec** | Notes |
|---|---|---|---|
| El Morro overall height above sea | 43 m (140 ft) | **43.0** | Six levels |
| Castle wall thickness | 5.5–7.6 m (up to 12.2) | **6.5** | Model the thickness — it must read in every embrasure |
| City curtain wall height above glacis | ~18 m (60 ft) | **16.0** | Seaward; 11.0 on the bay side |
| Curtain wall batter (talud) | — | **1 : 7** (8.1° from vertical) | Non-negotiable; a vertical fort wall reads as a modern retaining wall |
| Wall walk (adarve) width | — | **4.5** | Drivable in one secret section |
| Wall parapet height above walk | — | **1.6**, merlon/embrasure rhythm **2.4 m** pitch | |
| **Garita (sentry box)** outer Ø | ~2.0–2.4 m | **2.20** | Octagonal drum on a flaring corbel |
| Garita total height | — | **4.30** | Corbel 0.9 + drum 2.2 + cornice 0.15 + dome 1.05 |
| Garita dome | — | Ø **2.35**, rise **1.05**, ribbed, small finial ball Ø 0.22 | |
| Garita slit windows | — | **3 ×** 0.26 w × 0.62 h, splayed 0.30 deep | |
| Garita finish | — | **limewash white** over sandstone | The single most iconic silhouette in Puerto Rico. Get it right or don't ship it |
| Garita placement | — | every bastion angle + **1 per 90 m** of seaward curtain | |
| Puerta de San Juan opening | 4.9 m (16 ft) tall, wall 6 m thick | **3.20 w × 4.90 h**, tunnel **6.0** deep | Segmental arch |
| Puerta de San Juan doors | — | double timber leaves **1.55 × 4.60**, **red** (§4.3) | Iron studs Ø 0.07 at 0.34 grid |
| Esplanade (glacis) in front of El Morro | 28 ha incl. castle | **250 × 180 m** open lawn | No trees — historically restored to be treeless. Great skybox/vista moment |
| Dry moat | — | **12 w × 7 deep**, batter both sides | |
| Street lamp, wall lantern | — | mount **3.40** above sidewalk, arm **0.75**, lantern **0.55 h × 0.30 w** | |
| Street lamp, pole | — | lamp base **4.20**, shaft Ø **0.14 → 0.09**, plinth **0.45 h × 0.34 Ø**, lantern **0.75 h** | Fluted cast iron, black |
| Street lamp spacing | — | **21 m**, alternating sides | |
| Plaza monumental lamp | — | **6.20** total, **5 globes** Ø 0.36 at 4.9–6.2 | Two of these anchor Plaza de Armas |
| Paseo lamp (Princesa) | — | **4.60**, twin globes Ø 0.40 | White-painted, along the sea wall |
| Bench | — | **1.80 l × 0.62 d**, seat **0.45**, back top **0.85** | Cast-iron ends, 5 timber slats 0.09 wide |
| Bollard | — | **0.80 h × 0.20 Ø**, pitch **1.60** | Black iron, ball top |
| Tree pit | — | **1.20 × 1.20** iron grate, flush | |
| Traffic sign, PARE | — | octagon **0.75** across, centre **2.20** | Puerto Rico uses **PARE**, not STOP |
| Kiosk (plaza) | — | **3.2 × 2.4 × 3.1 h** | Painted timber, shutter counter, striped awning |
| Piragua cart | — | **1.55 l × 0.85 w × 1.90 h** incl. umbrella Ø 1.9 | See §7.3 |

### 1.9 Vegetation

| Species | Trunk Ø | Clear height | Canopy Ø | Total height | Where |
|---|---|---|---|---|---|
| Flamboyán (*Delonix regia*) | 0.55 | 2.8 | **11.0** | 9.0 | Plazas, waterfront. Flat umbrella crown, **scarlet-orange flowers Jun–Aug** |
| Ficus / laurel | 0.85 | 3.2 | **14.0** | 12.0 | Plaza de Armas, San José — pollarded, very dense dark canopy |
| Palma real (*Roystonea borinquena*) | 0.45 | 13.0 | 6.0 | **18.0** | Paseo de la Princesa, esplanade edges. Smooth pale grey trunk with green crownshaft |
| Coconut palm | 0.35 | 9.0 | 7.5 | 13.0 | Seafront only. **Leaning 8–18° from vertical** |
| Ceiba | 1.6 | 4.0 | 18.0 | 16.0 | One hero specimen only, near the fort |
| Bougainvillea | — | — | spread 3–6 | 4.0 | Walls, balconies, patio walls. Magenta / coral / white |
| Almendro (sea almond) | 0.5 | 2.5 | 9.0 | 8.0 | Waterfront; horizontally tiered branching |

**Rule:** vegetation is **sparse in the streets** and **concentrated in plazas and
along the sea walls**. A colonial street with street trees every 20 m is wrong —
the streets are hard, stone, shaded by buildings. Plazas are green islands.

### 1.10 Vehicle and scale sanity checks

| Element | **Spec** |
|---|---|
| Jeep taxi length / width / height | **4.10 / 1.95 / 1.86** (open top, roll cage to 1.86) |
| Wheel Ø | **0.78** |
| Eye/camera reference height | **1.55** driver eye |
| Pedestrian height | **1.55 – 1.90**, mean **1.70** |
| Traffic car footprint | **4.4 × 1.8 × 1.5** sedan; **5.6 × 2.0 × 1.95** pickup; **5.4 × 2.0 × 2.6** público van |
| OSJ tourist trolley | **8.4 × 2.4 × 3.2** — signature vehicle, white/green livery |
| Cruise ship (background) | **300 l × 38 w × 60 h** above waterline, 14 deck bands | 
| Cruise pier | **365 m** long × 26 m wide, deck 2.2 above water |

**Scale sanity:** a 2-storey house is **5.2× the Jeep's height**. If your buildings
are not at least 4.5× the car, the city reads as a toy set and the speed
disappears.

---

## 2. Adoquín — the signature surface

The blue-grey paving is the single most recognisable material in Old San Juan and
gets its own section because it will be on screen in **every** frame.

### 2.1 What it actually is

Nineteenth-century mass-produced **slag blocks** — the vitreous waste from Spanish
iron smelting, cast into bricks, carried to the island as **ship ballast**, then
laid as paving. The documented dimensions are **approximately 3 × 5 inches and 4
inches deep**, set in sand. The National Register nomination describes them as
**"silvery-grey parallelepipeds"** that *"tint the roads in a silvery-grey tone
while providing their surface with a rich texture."* Popular description calls
them blue; the truth is that they read **cool silvery-grey when dry and bleached
in sun, and unmistakably blue-slate when wet or in shade.** Build both.

### 2.2 Geometry spec

| Property | **Spec** |
|---|---|
| Stone face | **0.127 × 0.076 m** (5" × 3") |
| Stone depth (irrelevant visually, matters for kerb reveals) | **0.102 m** |
| Joint width (sand) | **0.009 m** |
| Course pitch (with joint) | **0.085 m** across, **0.136 m** along |
| Per-stone height variance | **±0.006 m** — some proud, some sunk. This is the whole material |
| Per-stone rotation jitter | **±2.5°** in plan |
| Laying pattern | **running bond, courses perpendicular to the direction of travel** — long axis of the stone across the street |
| Bond offset | half-stone (0.068 m), with **7 %** of courses randomly offset by a third instead |
| Curves and junctions | courses **fan radially**; at a crossroads the two grids meet in a **woven square panel** 3 × 3 m |
| Gutter | **2 courses** of stone laid *along* the street at each kerb, in a shallow 0.05 m dish |
| Sidewalk | **losa canaria** — dark grey basalt slabs **0.60 × 0.40 × 0.05**, running bond, joint 0.006 |

### 2.3 Anti-tiling protocol (mandatory)

Repeating cobblestone is the #1 tell of an amateur city. Required stack:

1. **Base albedo/normal/roughness** texture footprint **≥ 4.08 m × 4.08 m**
   (48 × 30 stones). Never smaller.
2. **Macro variation** multiply layer at **23.7 m** — low-frequency mottling,
   ±14 % value, ±6° hue. Not a harmonic of 4.08.
3. **Mega variation** at **71.3 m** — wear paths, oil, damp patches, ±9 % value.
4. **Per-segment UV hash**: each road segment offsets base UV by
   `hash(segmentId)` and randomly flips U and V. Prevents seam-lock at joins.
5. **Baked per-stone colour steps ≥ 8**, spanning **L\* 38 → 72** in the base map,
   so the "each stone is a different stone" reading survives at any zoom.
6. **Acceptance test:** at 25 m/s with the chase camera, **no repeating motif may
   be identifiable within 30 m of the camera.** A critic should not be able to
   point at "that same pale stone again".

### 2.4 Reading conditions

| Condition | Base colour | Roughness | Behaviour |
|---|---|---|---|
| Dry, direct midday sun | `#7A8494` → bleached `#8A9099` on wear paths | 0.86 | Almost white specular sheen on proud stone crowns; joints read as a fine dark grid |
| Dry, in shade | `#5C6675`, cooler | 0.86 | Blue shifts up; ambient sky fill dominates → this is where "blue cobblestone" comes from |
| Golden hour, raking light | `#8C7F76` warm crowns, `#3D4756` shadowed joints | 0.86 | **Maximum texture read.** Every stone casts a 6–12 mm shadow. The money shot |
| Wet | `#2E3A4A` | 0.30 | Albedo × 0.62; mirror-sharp reflections of façade colour and lamp light stretch 6–14 m down the street |
| Puddle (joints + low spots) | `#1B2430` | 0.06 | Flat normal, full reflection. Coverage 0.35 in rain, 0.12 for 90 s after |
| Night, under sodium lamp | `#4A4235` warm pool → `#232A36` cold outside | 0.86 | Lamp pools are the primary night navigation cue |

---

## 3. Colour — façade palettes

### 3.1 The historical rule that governs everything

Documented: original colours were natural earth tones; the **pastel scheme is a
20th-century invention that is now the protected traditional treatment**, and the
rule is —

> *the encadrements, cornices, applied decorations, mouldings and engaged orders
> are painted in a **lighter colour (usually white)** and the rest of the wall in a
> **contrasting pastel hue**.*

Plus the modern municipal rule: **a building must not be the same colour as its
neighbours.**

Therefore three hard colour laws:

- **L1 — Trim is always lighter than wall.** ΔL\* ≥ 22. Never a dark encadrement.
- **L2 — Joinery (doors, persianas, iron) is always darker and more saturated than
  the wall.** ΔL\* ≥ 30 the other way. This is the value sandwich that makes the
  architecture read: mid wall, light frame, dark hole.
- **L3 — No two adjacent buildings share a hue.** Minimum hue separation **35°**
  between neighbours, and **no more than 2 buildings in any 5-building run** may
  come from the same warm/cool family.

### 3.2 Façade walls — `PALETTE.facadeWall`

| Name | Hex | Family | Weight |
|---|---|---|---|
| Amarillo Fortaleza | `#E8A93B` | warm | 9 |
| Ocre Colonial | `#D08A2E` | warm | 7 |
| Mostaza Vieja | `#C99A46` | warm | 5 |
| Melón | `#F0A868` | warm | 6 |
| Salmón | `#EFA48B` | warm | 7 |
| Rosa Sanjuanera | `#E8836F` | warm | 8 |
| Rosa Palo | `#D9A0A0` | warm | 5 |
| Terracota | `#C25A3C` | warm | 6 |
| Rojo Teja | `#A63E2C` | warm | 3 |
| Crema Cal | `#F2E4C4` | neutral-warm | 9 |
| Blanco Hueso | `#F5EFE2` | neutral | 6 |
| Gris Perla | `#C9C6BC` | neutral | 3 |
| Verde Menta | `#A8D5C0` | cool | 7 |
| Turquesa Caribe | `#4FBFB1` | cool | 8 |
| Verde Loro | `#6FA84A` | cool | 4 |
| Verde Oliva Claro | `#B7C182` | cool | 4 |
| Azul Cielo | `#8FBEDB` | cool | 8 |
| Azul Añil | `#3E6E9E` | cool | 5 |
| Lila Bougainvillea | `#C08BC0` | cool | 4 |
| Violeta Suave | `#9F86C0` | cool | 3 |

Distribution target across a whole street face: **55 % warm, 30 % cool, 15 %
neutral.** Warm dominance is what makes it Old San Juan and not Burano or
Nyhavn.

Per-building variation: multiply the chosen hex by a per-instance
`hsl(±0.012 h, ±0.06 s, ±0.05 l)` jitter so two "Turquesa Caribe" buildings on
different blocks are not literally identical.

**Weathering (mandatory, per building):**
- Bottom **0.55 m**: darken to 0.72×, desaturate 25 % — splash and grime.
- Under every cornice, sill and balcony: a **0.10–0.35 m** vertical drip streak,
  0.85× value, on **35 %** of features, always aligned with gravity.
- **12 %** of buildings get a **patchy repaint** — a rectangle of a *different*
  palette colour over part of the façade. Real, cheap, instantly authentic.
- **8 %** get exposed masonry: stucco spalled off to show `#A89478` rubble stone.

### 3.3 Trim / encadrement — `PALETTE.trim`

| Name | Hex | Use |
|---|---|---|
| Blanco Cal | `#FBF7EE` | Default encadrement, cornice, parapet coping |
| Blanco Roto | `#F1EBDD` | Aged variant |
| Crema Trim | `#EDE2CB` | On cool-walled buildings |
| Gris Claro | `#DCD8CE` | On pale-walled buildings (keeps ΔL\* ≥ 22) |
| Azul Trim | `#BBD4E4` | Rare (8 %), only on cream/white walls |

### 3.4 Joinery, iron and doors — `PALETTE.joinery`

| Name | Hex | Use |
|---|---|---|
| Verde Botella | `#14523C` | **The** classic Puerto Rican shutter/door green. Highest weight |
| Verde Persiana | `#2E6B4F` | Lighter shutter green |
| Azul Marino | `#1B3A5C` | Deep navy doors |
| Azul Persiana | `#2E5E86` | Mid blue shutters |
| Rojo Puerta | `#9E2B25` | Doors. **Also the exact family for the Puerta de San Juan leaves** |
| Vino | `#6E2230` | Deep wine doors |
| Caoba | `#5A2E1B` | Varnished mahogany — reserve for grand houses and church doors |
| Turquesa Oscuro | `#10736E` | |
| Mostaza Oscura | `#B07B1E` | Rare accent |
| Negro Herrería | `#1A1D20` | Wrought iron default |
| Verde Herrería | `#1E2A26` | Very dark green-black iron — the more authentic second option |
| Gris Herrería | `#3A4046` | Weathered/rusting iron base |

### 3.5 Roofs, stone, sea, sky

| Name | Hex | Use |
|---|---|---|
| Teja Criolla | `#B0553A` | Barrel tile, main |
| Teja Vieja | `#A04A2F` | |
| Teja Clara | `#C4663F` | |
| Teja Quemada | `#8C3D26` | |
| Azotea Nueva | `#C8BFA8` | Flat roof screed |
| Azotea Vieja | `#A8A093` | |
| Azotea Alquitrán | `#4A4642` | Tar patches, 20 % coverage |
| Adoquín Seco | `#6A7382` | Cobble base, dry |
| Adoquín Sol | `#8A9099` | Bleached wear path |
| Adoquín Sombra | `#5C6675` | In shade |
| Adoquín Mojado | `#2E3A4A` | Wet |
| Adoquín Óxido | `#7A6E62` | Iron-bloom stones, 6 % of stones |
| Losa Canaria | `#565A5C` | Sidewalk basalt |
| Bordillo | `#7E7A72` | Kerb |
| Piedra Fuerte Sol | `#D8C9A8` | Fort sandstone, sunlit |
| Piedra Fuerte Sombra | `#B0A184` | Fort sandstone, shade |
| Piedra Fuerte Líquen | `#9FA88C` | Damp/lichened lower courses |
| Cal Garita | `#EFE9D8` | Limewash on garitas and upper works |
| Atlántico Profundo | `#0C3E63` | Deep ocean, north side |
| Atlántico Medio | `#10618F` | |
| Bahía Turquesa | `#1E9BAA` | Bay, south side |
| Bajío | `#56C7C0` | Shallow / sand bottom |
| Espuma | `#EAF6F7` | Foam, breakers |

**Sea rule:** the Atlantic (north/`-Z`) is **deep, cold, wave-driven blue**; the
bay (south/`+Z`) is **warm turquoise, glassy, with ships**. They must not be the
same water material.

### 3.6 Reserved gameplay colours — off-limits to the environment

Nothing in the city may use these. They belong exclusively to the game layer.

| Name | Hex | Use |
|---|---|---|
| Loco Magenta | `#FF2FA8` | Destination markers, route ribbon |
| Loco Cyan | `#00E5FF` | Pickups, boost pads, near-miss flash |
| Loco Lime | `#B6FF3B` | Combo / score pops |
| Taxi Yellow | `#FFC21A` | **The Jeep body only** |

Corollary: **no façade within 25 m of a drivable road may use a hue within ±20° of
`#FFC21A` at chroma > 0.35.** Amarillo Fortaleza and Mostaza Vieja must be pushed
to the *far* side of the street or to non-road-facing elevations near the player's
usual line. The taxi must always be the brightest, most saturated object in frame.

---

## 4. Lighting palettes

Latitude **18.47° N**. Solar noon ≈ **12:27**. Winter noon solar elevation ≈ **48°**;
around the summer zenith passages the sun is within **5°** of vertical. Daylight
11:00 → 13:20. **Twilight is short — about 25 minutes.** This is a low-latitude
city: dawn and dusk are fast, midday is brutal and near-vertical, and shadows are
short and hard for most of the day.

### 4.1 World orientation (binding)

- The **calles largas** (Sol / Luna / San Sebastián / Fortaleza analogues) run along
  world **±X**. The cross streets run along world **±Z**.
- **Atlantic Ocean = −Z. San Juan Bay + cruise piers = +Z. El Morro = −X.
  Castillo San Cristóbal / Plaza Colón / city gate out = +X.**
- Sun azimuth convention: `az = 0` when the sun is over −Z (Atlantic), increasing
  clockwise seen from above. So `az = 90°` is over +X, `az = 270°` is over −X.
- **Consequence, and it is deliberate:** at dawn the sun is at `az ≈ 92°`, at
  sunset `az ≈ 268°` — both **rake straight down the long streets**. Golden hour
  turns every calle larga into a tunnel of light with the fort silhouetted at the
  end. This is the game's signature shot. Do not rotate the city off this axis.
- At midday the sun sits at `az ≈ 176°`, elevation 78° — shadows are short and fall
  toward −Z, so the **Atlantic-facing (north) façades are in shade and the
  bay-facing (south) façades blaze.** Use this for readability: the player's eye
  follows the bright side.

### 4.2 Time-of-day table

Tuned for **ACESFilmic tone mapping, `outputColorSpace = SRGBColorSpace`,
`renderer.useLegacyLights = false`** (Three r155+ default). `sun` is a
`DirectionalLight`; `hemi` a `HemisphereLight`; `fog` is `FogExp2`.

| Key | Time | Sun az / el | Sun colour | Sun int. | Hemi sky | Hemi ground | Hemi int. | Fog colour | Fog density | Exposure | Bloom str. |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `dawn` | 06:15 | 92° / 3° | `#FFB27A` | 1.6 | `#6E86B8` | `#4A3E38` | 0.55 | `#C9A98F` | 0.0022 | 1.05 | 0.55 |
| `morning` | 09:00 | 128° / 42° | `#FFF0D6` | 2.9 | `#9EC4E8` | `#7A6A54` | 0.75 | `#BFD8E8` | 0.0011 | 1.00 | 0.35 |
| `midday` | 12:30 | 176° / 78° | `#FFF8EC` | 3.6 | `#A9CFF0` | `#8A7A62` | 0.90 | `#C6DCEC` | 0.0009 | 0.95 | 0.28 |
| `afternoon` | 15:30 | 226° / 50° | `#FFE9C2` | 3.1 | `#9CC3E6` | `#836F55` | 0.78 | `#C4D9E6` | 0.0012 | 1.00 | 0.38 |
| `golden` | 18:15 | 268° / 8° | `#FF9E4D` | 2.4 | `#7FA8D8` | `#6B4E3A` | 0.60 | `#E8A56B` | 0.0018 | 1.08 | 0.70 |
| `dusk` | 19:05 | 272° / −4° | `#C4623C` | 0.50 | `#4A6A9E` | `#2C2E3A` | 0.50 | `#7A6A86` | 0.0026 | 1.15 | 0.90 |
| `night` | 22:00 | (moon) 210° / 38° | `#9FB4D8` | 0.28 | `#22304C` | `#14161C` | 0.32 | `#101828` | 0.0034 | 1.25 | 1.10 |
| `rain` | any | inherit, el ≥ 20° | `#DCE2E6` | ×0.35 | `#7E8C98` | `#4A4F52` | 0.85 | `#97A5AE` | 0.0038 | 1.10 | 0.45 |
| `storm` | any | inherit | `#C8D2DA` | ×0.18 | `#5F6C78` | `#33383C` | 0.80 | `#77848D` | 0.0062 | 1.12 | 0.50 |

Notes an implementer needs:

- **Shadow length is the whole story.** Shadow length = height ÷ tan(elevation).
  `midday` (78°): a 9.6 m building casts **2.0 m** — the street is 84 % sunlit and
  the city looks bleached and hot. `golden` (8°): the same building casts **68 m** —
  the entire street is in shadow with **slabs of orange light at every cross
  street**. Both extremes must be visibly, obviously different. If your midday and
  your golden hour look like the same scene with a different tint, you have failed.
- **Shadow bias / cascades:** with an 850 m draw distance and 4.08 m cobble detail,
  use 3 cascades at **0–35 m / 35–120 m / 120–380 m**, `shadowMapSize` from
  `QUALITY_BUDGET`, normalBias `0.02`, bias `-0.0004`. Contact hardening not
  required; a soft PCF radius of ~2.5 texels on the near cascade is enough.
- **Fog is the depth grader.** With `FogExp2`, fogged fraction = `1 − exp(−(d·z)²)`.
  Sanity: `midday` d=0.0009 → 44 % at 850 m. `night` d=0.0034 → 65 % at 300 m,
  which is exactly what hides the draw-distance edge. Do not turn fog off "for
  clarity"; instead raise fog *colour* toward the sky and lower density.
- **Sky must be a gradient, never a flat colour.** Zenith → horizon at midday:
  `#2E7BC4` → `#BFE0F2`. At golden: `#2A4E86` → `#FFB35C` with a `#FF6B3D` band
  within 6° of the horizon. Cumulus clouds are mandatory in daylight — the
  Caribbean trade-wind sky is 25–45 % cloud-covered with **flat-based, hard-topped
  cumulus** at ~700 m base. A cloudless empty sky reads as a placeholder.
- **Lightning (`storm`):** flash of `#DDE8FF` at sun intensity **9.0** for **0.08 s**,
  double-strike 40 % of the time (second at 0.11 s offset, 0.6 intensity), interval
  **9–22 s** randomised. Suppress entirely when `photosensitiveSafe` is on.

### 4.3 Artificial light (dusk → night)

| Source | Colour | Intensity | Range | Height | Notes |
|---|---|---|---|---|---|
| Street lantern (sodium-ish) | `#FFB765` (≈2400 K) | 4.0 | 14 m | 4.2 | Emissive globe `#FFD9A0` at 3.5× bloom threshold |
| Plaza monumental lamp | `#FFC98A` | 5.5 | 20 m | 6.2 | 5 globes; only 1 real light + 5 emissive meshes |
| Wall lantern | `#FFB765` | 2.2 | 9 m | 3.4 | Baked into the wall lightmap beyond 60 m |
| Window interior glow | `#FFD79A` | emissive only | — | — | **55 %** of windows lit; no flicker; per-window random warm/cool ±200 K |
| Shop / bar interior spill | `#FFCE8E` | 3.0 | 8 m | 2.6 | Only at ground floor, only on `#windowLightDistance` |
| Neon / LED sign | 6 hues only: `#FF3E6C` `#22E0C8` `#FFD400` `#6BE04F` `#4FA8FF` `#FF7A29` | emissive 4–8 | — | 3.0–4.5 | Max **1 sign per 3 buildings**. This is a colonial city, not Shibuya |
| Vehicle headlight | `#F2F6FF` | 6.0 | 32 m, 26° cone | 0.72 | |
| Vehicle tail / brake | `#FF2A18` | emissive 2.5 / 7.0 | — | 0.78 | |
| Fort floodlight (El Morro at night) | `#FFE3B0` | 3.0 | 60 m | ground-up | Uplights the sandstone; the fort is the night skyline |
| Moon disc | `#E8EEFF` | emissive | — | — | 0.52° angular; visible over the Atlantic |

**Night navigation contract:** the driving line at night must be legible from lamp
pools alone. Lamp spacing 21 m with a 14 m range means pools **overlap by ~40 %**
along the sidewalk edge and leave the crown of the road slightly darker — which is
correct, and which is why the **wet-road reflection of the lamps** and the
**emissive kerb glint** are load-bearing. Do not solve it with a global ambient
lift; that is the amateur move (see §8).

---

## 5. Material spec table

Targets for `MeshStandardMaterial` / `MeshPhysicalMaterial`. `nScale` = normal map
strength. `Wet Δ` describes behaviour at `wetness = 1.0`.

| Surface | Base colour | Rough | Metal | nScale | Extra | Wet Δ |
|---|---|---|---|---|---|---|
| Adoquín (road) | `#6A7382` | **0.86** | 0.0 | **1.00** | AO map from joint depth | rough → **0.30**, albedo × **0.62**, puddle mask at joints |
| Adoquín joint sand | `#8A8271` | 0.95 | 0.0 | 0.60 | — | rough → 0.55, albedo × 0.55 |
| Losa canaria (sidewalk) | `#565A5C` | **0.80** | 0.0 | 0.50 | — | rough → 0.28, albedo × 0.60 |
| Kerb stone | `#7E7A72` | 0.84 | 0.0 | 0.45 | — | rough → 0.32, albedo × 0.66 |
| Asphalt patch | `#3A3B3E` | 0.88 | 0.0 | 0.70 | 9 % of road area | rough → 0.20, albedo × 0.60 |
| Painted lime stucco (façade) | palette §3.2 | **0.78** | 0.0 | **0.35** | subtle 0.6 m-scale trowel normal | rough → 0.55, albedo × **0.80** (vertical, sheds water) |
| Stucco, splash zone (0–0.55 m) | ×0.72 of wall | 0.90 | 0.0 | 0.55 | — | rough → 0.42, albedo × 0.70 |
| Exposed rubble masonry | `#A89478` | 0.92 | 0.0 | 0.95 | 8 % of buildings | rough → 0.48, albedo × 0.68 |
| Painted wood (doors, persianas) | palette §3.4 | **0.42** | 0.0 | 0.50 | `clearcoat 0.25 / ccRough 0.30` | rough → 0.22, albedo × 0.88 |
| Varnished mahogany door | `#5A2E1B` | **0.28** | 0.0 | 0.40 | `clearcoat 0.40 / ccRough 0.12` | rough → 0.15 |
| Wrought iron, painted | `#1A1D20` | **0.45** | **0.35** | 0.70 | — | rough → 0.18, albedo × 0.85 |
| Wrought iron, rusting | `#6B4A33` | 0.78 | 0.60 | 0.90 | 20 % blend on lower balconies | rough → 0.40 |
| Clay barrel roof tile | `#B0553A` | **0.82** | 0.0 | **0.85** | per-tile hue jitter ±0.03 h | rough → 0.30, albedo × 0.66 |
| Azotea screed | `#C8BFA8` | 0.88 | 0.0 | 0.40 | — | rough → 0.32, albedo × 0.64, **standing water pools** |
| Fort sandstone | `#D8C9A8` | **0.90** | 0.0 | **0.90** | 1.8 m block coursing in normal | rough → 0.45, albedo × 0.70 |
| Fort limewash (garitas) | `#EFE9D8` | 0.85 | 0.0 | 0.30 | — | rough → 0.50, albedo × 0.82 |
| Window glass | `#0E1418` | **0.06** | 0.0 | 0.15 | envMap intensity 1.0, or `transmission 0.9 / ior 1.5` on hero glass only | add streak normal, rough → 0.04 |
| Sea, Atlantic | `#0C3E63` → `#10618F` | **0.05–0.12** | 0.0 | 0.60 animated (2 scrolling normals, 0.22 & 0.09 m/s, non-parallel) | Fresnel-driven; foam via depth-difference mask | n/a |
| Sea, bay | `#1E9BAA` → `#56C7C0` | 0.09 | 0.0 | 0.45 animated | glassier, slower | n/a |
| Vehicle body paint | `#FFC21A` | **0.30** | 0.05 | — | `clearcoat 1.0 / ccRough 0.06` | rough → 0.22 |
| Vehicle chrome / bull bar | `#EFEFF2` | 0.12 | **1.0** | — | — | rough → 0.08 |
| Tyre rubber | `#14161A` | 0.92 | 0.0 | 0.80 | — | rough → 0.55 |
| Foliage | per §1.9 | **0.62** | 0.0 | 0.40 | `side: DoubleSide`, `alphaTest 0.4`, wind vertex anim 0.35 Hz | rough → 0.45, albedo × 0.85 |
| Awning canvas | striped, sat 0.55 | 0.80 | 0.0 | 0.50 | `side: DoubleSide` | rough → 0.55, albedo × 0.80 |
| Azulejo tile plaque | `#F4F1E8` / `#1F4E8C` | **0.22** | 0.0 | 0.20 | `clearcoat 0.5` | rough → 0.14 |
| Painted mural | source art | 0.72 | 0.0 | inherit wall × 0.6 | — | rough → 0.45, albedo × 0.82 |

### 5.1 Wetness model (one shared function)

Follow the standard physically-based wet-surface model: water fills micro-detail,
so **roughness drops** and, because the surface is porous, **albedo darkens**, with
the amount of darkening driven by porosity.

```
// porosity: 0 = sealed (glass, paint, metal), 1 = fully porous (stucco, sandstone)
// wetness:  0..1 global, modulated per-surface by an up-facing mask
//           upMask = saturate(dot(worldNormal, up) * 1.6 - 0.2)

float w        = wetness * upMask;
float darken   = mix(1.0, 0.35, w * porosity);           // never below 0.35 total
vec3  albedoW  = albedo * darken;
float roughW   = max(0.055, mix(roughness, roughness * 0.22, w * (0.35 + 0.65*porosity)));

// puddles: where a low-frequency height/mask says water pools
float puddle   = smoothstep(0.55, 0.80, puddleMask) * wetness;
roughW         = mix(roughW, 0.04, puddle);
normalW        = normalize(mix(normalW, worldUp, puddle));   // flatten to mirror
```

Porosity values: adoquín **0.85**, losa canaria 0.7, stucco **0.9**, sandstone
**0.95**, painted wood 0.25, painted iron 0.1, tile 0.6, glass 0.0, vehicle paint
0.0.

**Dry-down:** after rain stops, `wetness` lerps 1 → 0 over **75 s**, and `puddle`
lerps over **150 s** (puddles outlive the sheen). Never snap.

---

## 6. Composition and readability at speed

### 6.1 Camera

| Parameter | Value | Notes |
|---|---|---|
| Base FOV | **62°** (from `CONFIG.camera.fov`) | at rest |
| FOV at 45 m/s | **76°** | `lerp` on `speed/45`, ease-out cubic; +4° more while boosting, +2° while drifting |
| Follow distance | **7.0 m** at rest → **8.8 m** at 45 m/s | |
| Camera height above car origin | **2.60 m** → **2.35 m** at speed | flattens as you go faster |
| Look-at point | **1.40 m** up, **6.0 m ahead** of the car along velocity (not heading) | leading the driving line is what makes it feel arcade |
| Pitch | **−8°** at rest → **−4°** at speed | |
| Drift yaw lag | camera lags drift angle by **0.35 ×**, max **18°** | you see *around* the corner, not into the wall |
| Horizon screen position | **45 %–58 %** of screen height, always | < 40 % you cannot read the road; > 62 % is claustrophobic |
| Shake | `settings.screenShake` scaled: 0.9 px @ 30 m/s, 3.2 px @ 50 m/s, 11 px on impact (0.18 s decay) | |

The FOV-widens-with-speed convention is deliberate: increasing peripheral optical
flow is the strongest velocity cue available, at the cost of shrinking distant
detail. Compensate with the distance pull-back and radial blur below, **not** by
reverting to a narrow FOV.

### 6.2 Readability laws

- **R1 — The corridor.** The drivable surface must occupy **≥ 22 %** of screen area
  at all times in normal driving. If a building, prop or crowd pushes it below
  that, cut the prop.
- **R2 — Value separation at the road edge.** The road surface stays in
  **L\* 32–58**. Building bases at the wall/ground junction must differ from the
  road by **ΔL\* ≥ 18**. That contrast (plus AO, §8) is what draws the edge of the
  drivable world without a painted line.
- **R3 — Gaps are honest.** Any gap ≥ **3.2 m** (1.6 × vehicle width) must be
  drivable. Any gap that is *not* drivable must be visually plugged — gate, stair,
  planter run, bollard row, parked van, market stall. **No ambiguous dark slots.**
- **R4 — Read distance.** A junction, a ramp, a shortcut mouth or a passenger
  marker must be identifiable from **≥ 55 m** at 45 m/s. Test by screenshot, not
  by feel.
- **R5 — Three depth planes.** Near 0–40 m: full chroma, full contrast, full detail.
  Mid 40–160 m: chroma × 0.85. Far 160 m+: fog-desaturated, chroma × 0.55. Fog does
  most of this; verify per time-of-day.
- **R6 — Silhouette budget.** Along any 100 m of street, there must be **≥ 4
  distinct silhouette events** breaking the parapet line: a balcony canopy, a
  tower, a taller neighbour, a palm crown, a corner *cuarto esquinero*, a garita.
  A flat unbroken skyline is a dead street.
- **R7 — Landmark triangulation.** From **any** point on the drivable map, at least
  **two** of the five hero landmarks must be visible: El Morro + lighthouse, the
  Cathedral dome/tower, San Cristóbal, the cruise ship, the city gate. This is how
  the player builds a mental map without reading a minimap.
- **R8 — Gameplay colour supremacy.** `#FF2FA8` / `#00E5FF` / `#B6FF3B` are never in
  the environment (§3.6). The taxi is always the highest-chroma object in frame.
- **R9 — Speed evidence.** At ≥ 45 m/s the frame must contain **6–14 discrete
  motion events per second** — leaves, papers, pigeon burst, spray, dust puff,
  sparks off the kerb, awning flap, laundry snap, pedestrian flinch. Under 4/s
  reads as slow no matter what the speedometer says.
- **R10 — Never blur the centre.** Radial blur strength **0.18** at the screen edge,
  **0.0** inside the central **42 %** radius. Same for chromatic aberration.
- **R11 — The arrow.** Crazy Taxi's destination arrow is a load-bearing mechanic,
  not decoration. Screen position **68–76 %** height, minimum stroke **6 px** at
  1280×720, `#FF2FA8`, with a 2 px `#0A0C10` outline so it survives against a
  bright cream façade *and* a dark alley.

### 6.3 Post-processing chain (in order)

1. **SSAO / GTAO** — radius **0.55 m**, intensity **0.9**, bias 0.02, 12 samples.
   Applies to indirect only. Mandatory at wall/ground junctions, under balconies,
   inside zaguanes, under cornices, in window reveals.
2. **Bloom** — threshold **0.85**, radius **0.55**, strength per §4.2 table.
3. **Motion blur** — velocity-buffer based, shutter **0.5**, max **12 px** at
   1600×900, disabled inside the centre 42 % (see R10).
4. **Tone mapping** — `ACESFilmicToneMapping`, exposure per §4.2.
5. **Colour grade** — per-ToD 32³ LUT. Global saturation **+8 %** vs neutral. Lift
   shadows by `#0E1A28` × 0.03 (never crushed pure black in daylight).
6. **Chromatic aberration** — 0.0012 of screen width, edges only.
7. **Vignette** — strength **0.22**, smoothness 0.55.
8. **Film grain** — **0.012**. Barely present. This is a sunny arcade game, not a
   horror game.
9. **CAS sharpen** — **0.35**, after any upscale from `renderScale`.

**Depth of field: off while driving.** Maximum permitted is a 0.5 m circle of
confusion beyond 220 m. Full DOF only in photo mode / results screens.

### 6.4 Measurable frame statistics

A critic can compute these from a screenshot. They are pass/fail.

| Statistic | Daylight target | Night target |
|---|---|---|
| Mean luminance (sRGB 0–1) | **0.38 – 0.52** | **0.14 – 0.24** |
| Pixels clipped at 255 | **≤ 1.5 %** | ≤ 0.6 % |
| Pixels at 0 | **≤ 0.8 %** | ≤ 4 % |
| Mean HSV saturation, centre 50 % of frame | **0.34 – 0.52** | 0.26 – 0.44 |
| Distinct hues (20-bin histogram, bins ≥ 1 % of pixels) | **≥ 6** | ≥ 4 |
| Luminance std. dev. | **≥ 0.17** | ≥ 0.13 |

Below 0.25 mean saturation = washed out. Above 0.62 = garish. Below 0.17
luminance std. dev. = flat, unlit, no light modelling happening.

---

## 7. Cultural authenticity

Old San Juan is a living UNESCO World Heritage city with 400+ historic buildings
and a specific, non-interchangeable culture. Specificity is the whole job.

### 7.1 Signage — Spanish must be correct and idiomatic

Real business types to put on shopfronts: **Farmacia · Panadería · Repostería ·
Cafetería · Colmado · Barbería · Salón de Belleza · Ferretería · Joyería ·
Librería · Heladería · Zapatería · Fonda · Chinchorro · Taller · Óptica ·
Floristería · Artesanías · Café · Marisquería · Lavandería · Notaría**.

Utility text: `ABIERTO` / `CERRADO` · `SE VENDE` · `SE ALQUILA` · `HORARIO` ·
`NO ESTACIONE` · `SOLO SALIDA` · `CEDA EL PASO` · `PARE` (Puerto Rican stop signs
say **PARE**, not STOP) · `PROHIBIDO EL PASO` · `SE HABLA INGLÉS`.

- **Street name plaques are blue-and-white ceramic azulejo panels set into the
  wall**, not poles. Format: `CALLE DE LA` on line 1, `FORTALEZA` on line 2,
  serif caps, cobalt `#1F4E8C` on `#F4F1E8`, decorative border. This detail alone
  is worth ten generic props.
- House numbers on small matching tiles beside the door.
- Distances in **kilometres**, speed limits in **miles per hour** — a genuine
  Puerto Rican quirk. Use it.
- Typography: use ordinary Spanish-language shop lettering — hand-painted sans and
  slab serifs, vinyl-cut modern sans, gold-leaf on glass. **Never** a "Latin-flavour"
  novelty typeface, never faux-woodcut, never fake-accented English.
- Every Spanish string must be grammatical and correctly accented. `Panadería`, not
  `Panaderia`. `Artesanías`, not `Artesanias`.

### 7.2 Traffic and street life — what actually drives and walks here

- **Traffic:** ordinary modern Caribbean-US traffic. Toyota Corolla, Honda Civic,
  Nissan Sentra, Ford F-150 and Toyota Tacoma pickups, small box delivery trucks,
  scooters, **white 15-passenger *público* vans**, and the **free Old San Juan
  trolley** (white/green, open-sided — the signature local vehicle). Police in
  Policía de Puerto Rico blue. Vehicles are dusty, sun-faded, occasionally dented.
- **Not** 1950s American classic cars. That is Havana, a different island, a
  different history. Getting this wrong is the single most common Caribbean
  stereotype error.
- **Pedestrians:** office workers around the government district, cruise passengers
  with lanyards and shopping bags, school kids in uniform, artists, elderly
  residents on plaza benches, dominoes players, street vendors, joggers on the
  Paseo. Dress is light cotton — shorts, tees, sundresses, linen shirts, the
  occasional *guayabera* on an older man. Umbrellas out fast when rain starts.
- **Skin tone range must span the actual Puerto Rican population** — Afro-Puerto
  Rican, white, and everything between, with genuinely varied hair texture. Ship a
  wide continuous melanin range, not three presets.
- **Street vendors:** piragüero with a shaved-ice cart (bright paint, striped
  umbrella, glass syrup bottles — tamarindo, coco, frambuesa), alcapurria/empanadilla
  fryer, coffee kiosk, flag and hat sellers near the piers, artisans with
  handmade goods.
- **Signature living details:** the **cat colony** around Paseo del Morro (a real,
  beloved, managed colony — cats on the walls and steps), pigeons at Parque de las
  Palomas, kite-flyers on the El Morro esplanade, dominoes tables in the plazas.

### 7.3 Music and audio (art-adjacent, but it sells the place)

The city's music is **bomba** (Loíza, barril drums), **plena** (panderos), **salsa**,
**reggaetón** and **trap latino** (both born here), **danza** and **aguinaldos** at
Christmas. The *cuatro* is the national string instrument. Music leaks from open
shutters, bar doorways and car windows — different genres from different sources
in the same street is exactly right. **No mariachi. No steel drums. No generic
"island" pan flute.**

### 7.4 Symbols — use with knowledge

- **Puerto Rican flag**: use the standard flag (`#ED0000` red, `#0050F0` blue,
  white). Everywhere: balconies, doors, shopfronts, murals, car decals.
- **La Puerta de la Bandera** (the flag door on Calle San José, near San Sebastián)
  is a real landmark. Its **black-and-white version is an active political statement**
  about the island's status, painted in protest in 2016. Referencing it is fine and
  respectful; treating it as generic decoration is not. If in doubt, use the
  standard colours.
- **Garita** — the sentry box is the de-facto national emblem. It appears on signs,
  logos, souvenirs and license plates. Use it as the game's own iconographic motif.
- **Vejigante masks** — festival masks from Loíza (coconut, bomba tradition) and
  Ponce (papier-mâché, carnival). They belong in artisan shop windows and at
  festival dressing, not scattered as generic street decoration.
- **Coquí** frog, **sol taíno** petroglyph, **santos de palo**, **flamboyán** —
  all correct and locally meaningful.
- **Murals**: Old San Juan's street art is real and largely political/celebratory —
  portraits, flags, sea life, poetry, folk-art motifs. Concentrate murals on
  **party-wall end elevations, callejón walls, and roll-down shutters**, not on
  historic façades (which are protected). Budget **6–10 murals** on the whole map;
  more than that and they stop reading as special.

### 7.5 What to avoid — checkable blacklist

Sombreros · maracas · mariachi · piñatas · papel picado · Day of the Dead
imagery · cacti · Rasta colours · steel drums · tiki anything · 1950s Havana
cars · "Mexican restaurant" typefaces · Spanish text with missing accents · a
single "Latin" character stereotype (loud, gesticulating, sunglasses) ·
palm-tree-and-parrot generic tropical shorthand · a mariachi-adjacent musical
sting on pickup · any building signage in English-only · a beach. **Old San Juan
has no beach inside the walls.**

---

## 8. AAA vs amateur checklist

Tick these while looking at a screenshot. Each is a specific, observable failure.
**Any item ticked in the "Fail" column is a defect with a name.**

### Geometry and grounding
1. ☐ Buildings **float** above the ground plane, or their base intersects the road
   at a visible straight seam with no dirt/plinth/AO transition.
2. ☐ **No ambient occlusion at the wall-to-ground junction.** Every façade must sit
   in a soft dark contact band ~0.35 m tall.
3. ☐ Walls are paper-thin — window reveals show **< 0.2 m** of depth, or none.
4. ☐ **Gaps between adjacent townhouses.** Daylight, sky, or a bare side wall
   visible between two buildings on the same block face.
5. ☐ Parapet heights of adjacent buildings are **identical** — extruded-box city.
6. ☐ Balconies have **zero projection** (decal-flat against the wall).
7. ☐ Balcony floor slabs are infinitely thin, or have no brackets underneath.
8. ☐ Cornices are a texture stripe, not geometry that casts a shadow.
9. ☐ Roof planes are empty — no cistern, no aerial, no parapet coping, no clutter.
10. ☐ Doors are the same size as windows, or upper floors have windows where the
    typology demands full-height balcony doors.
11. ☐ Street furniture floats: lamps, benches, bollards with no contact shadow.
12. ☐ Kerbs missing — road and sidewalk are the same plane.
13. ☐ Fort walls are **vertical** instead of battered.
14. ☐ Garitas are cylinders with a cone on top instead of a corbelled octagonal
    drum with a ribbed dome and a finial.

### Texture and material
15. ☐ **Cobblestone tiling is visibly repeating within 30 m of the camera.**
16. ☐ Cobblestone reads as a flat photo — no per-stone height variance, no joint AO,
    no specular breakup along the stone crowns.
17. ☐ Every stucco wall has the **same** trowel texture at the same scale and phase.
18. ☐ No weathering: façades are perfectly clean top to bottom, no splash zone, no
    drip streaks under sills.
19. ☐ Roughness is uniform across the whole scene — everything is equally shiny or
    equally matte.
20. ☐ Metal (iron balconies) has `metalness = 0` and reads as painted plastic, or
    `metalness = 1` and reads as chrome.
21. ☐ Glass is a flat opaque grey rectangle with no reflection and no interior
    depth.
22. ☐ Normal maps at strength 1.0 on everything, producing plastic-looking stucco.
23. ☐ **Wet surfaces just got darker** — roughness unchanged, so no wet sheen, no
    reflections, no puddles.
24. ☐ Puddles are flat blue circles rather than mirrors with a flattened normal.
25. ☐ Foliage is a solid green blob with no alpha cutout, no two-sided lighting, no
    wind motion.

### Colour
26. ☐ **All façades are the same hue** or the same value — a beige/pastel mush.
27. ☐ Two adjacent buildings share a hue (violates L3).
28. ☐ **Trim is darker than the wall** (violates L1) — instantly reads as fantasy,
    not Old San Juan.
29. ☐ Doors and shutters are lighter than the walls (violates L2) — the façade
    loses its value sandwich and goes flat.
30. ☐ Fewer than 6 distinct hues covering ≥ 1 % of the frame.
31. ☐ Mean HSV saturation below 0.25 (washed out) or above 0.62 (garish).
32. ☐ The taxi is not the highest-chroma object in frame.
33. ☐ Reserved gameplay colours (`#FF2FA8`, `#00E5FF`) appear on scenery.
34. ☐ Sea is one flat colour with no depth gradient, no foam, no horizon fade.
35. ☐ Sky is a flat colour or an untextured gradient with **no clouds**.

### Lighting
36. ☐ **Flat unlit ambient** — no directional key, or ambient so high that shadows
    are washed to nothing.
37. ☐ Luminance standard deviation below 0.17 — the scene has no light modelling.
38. ☐ Shadows are missing on any object over 1 m tall within 120 m.
39. ☐ Shadow direction is inconsistent between objects, or between baked and
    dynamic shadows.
40. ☐ **Midday and golden hour produce the same shadow lengths** — the sun elevation
    is not actually changing.
41. ☐ Shadow acne, peter-panning (shadows detached from their caster), or a visible
    cascade boundary within 120 m.
42. ☐ No bounce/fill: shadowed façades are pure grey-black instead of picking up
    warm reflected light from the sunlit wall opposite.
43. ☐ Fog colour does not match the sky at the horizon — a visible band where the
    world ends.
44. ☐ At night, the world is uniformly dim-lit rather than lit by discrete lamp
    pools; or lamps have emissive globes but cast no light.
45. ☐ Emissive windows are all identical brightness and colour.
46. ☐ Bloom is applied globally so the whole frame hazes, instead of thresholded on
    genuine highlights.
47. ☐ Clipping: > 1.5 % of pixels blown to pure white in daylight.

### Composition and readability
48. ☐ The road occupies less than 22 % of screen area.
49. ☐ A junction or shortcut cannot be identified from 55 m.
50. ☐ Non-drivable gaps look drivable (unplugged dark slots).
51. ☐ The horizon sits outside 45–58 % of screen height in normal driving.
52. ☐ 100 m of street with fewer than 4 silhouette-breaking events.
53. ☐ Motion blur or chromatic aberration is applied to the centre of the frame.
54. ☐ Detail noise (props, decals, foliage) obscures the driving line.
55. ☐ No landmark visible for orientation.

### Density and life
56. ☐ Balconies with no plants (target ≥ 60 % planted).
57. ☐ Zero laundry, awnings, signs, wires, AC units, satellite dishes — a museum,
    not a city.
58. ☐ Shopfronts are blank rectangles with no signage, no goods, no interior.
59. ☐ Streets are empty of traffic and pedestrians in a shot where the game says
    they should be present.
60. ☐ Fewer than 4 motion events per second at 45 m/s.
61. ☐ Every window has the same shutter state and the same open angle.

### Cultural
62. ☐ Any item from the §7.5 blacklist appears.
63. ☐ Spanish text with a spelling or accent error, or a machine-translated phrase.
64. ☐ Street names on poles instead of azulejo wall plaques.
65. ☐ Stop signs say STOP instead of PARE.
66. ☐ Pedestrian skin tones span fewer than 5 clearly distinct values.
67. ☐ Classic 1950s American cars in traffic.

---

## 9. Scoring rubric

Ten dimensions, each scored **1–10** against the anchors below. A screenshot (or a
short capture) is the unit of evaluation. Grade **the same shot list every time**:

**Standard shot list (8 shots):** ① narrow street at 45 m/s, midday · ② calle larga
at golden hour looking west toward El Morro · ③ plaza (Armas or San José) at rest ·
④ fort wall + garita + sea, afternoon · ⑤ night street with lamps and wet road ·
⑥ rain, mid-block, 40 m/s · ⑦ waterfront with cruise ship and dock · ⑧ elevated /
airborne shot showing skyline and azoteas.

| # | Dimension | Weight |
|---|---|---|
| 1 | Place authenticity | 1.5 |
| 2 | Architectural craft | 1.25 |
| 3 | Surface & material believability | 1.25 |
| 4 | Colour discipline | 1.25 |
| 5 | Lighting quality | 1.25 |
| 6 | Readability at speed | 1.5 |
| 7 | Silhouette & shape language | 1.0 |
| 8 | Density, life & set dressing | 1.0 |
| 9 | Frame finish (post, AA, grade) | 0.75 |
| 10 | Cultural respect & specificity | 1.25 |

**Weighted score = Σ(score × weight) / 12.0.** Report to one decimal.

**Gates:**
- Ship gate: weighted score **≥ 7.5**, **no dimension below 6**, and **dimension 10
  ≥ 8**.
- Dimension 10 below 7 is an **automatic fail** regardless of total.
- Dimension 6 below 6 is an **automatic fail** — an unreadable arcade racer is not
  shippable at any level of beauty.

### Anchors

**1 — Place authenticity** *(is this Old San Juan?)*
- **1–2**: Generic city. Could be anywhere. No adoquín, no colonial typology.
- **3–4**: Generic "colonial/Mediterranean". Pastel boxes, cobbles, no specificity.
- **5–6**: Recognisably Spanish colonial Caribbean. Some correct elements
  (balconies, shutters) but the mix is off — wrong roof ratio, no azulejo plaques,
  no garitas, front gardens, gaps between buildings.
- **7–8**: Clearly Old San Juan. Adoquín, wall-to-wall pastel façades, iron
  balconies, azoteas, garitas, correct street plaques. A visitor names it.
- **9–10**: Specific *streets* are recognisable. The blue-grey cobble reads
  correctly wet and dry, the fort/city relationship is right, and the small stuff
  (losa canaria sidewalks, encadrements, cuarto esquinero corners, zaguán views)
  is all present and correct.

**2 — Architectural craft**
- **1–2**: Extruded boxes with texture. No cornices, no reveals, no depth.
- **3–4**: Some modelled detail but wrong proportions — squat storeys, oversize
  windows, flat balconies, uniform parapets.
- **5–6**: Correct proportions, modelled cornices and balconies, but repetitive; the
  same 3 buildings tiled.
- **7–8**: §1 dimensions honoured. Bay rhythm reads. Reveals 0.28 m deep. Parapets
  step. Balcony brackets present. Meaningful variety.
- **9–10**: Typology-literate — Type A/B plans implied by the façade, floating
  lintels, encadrement families, buttressed older buildings, podium bases solving
  street slopes, hand-placed hero buildings among procedural neighbours.

**3 — Surface & material believability**
- **1–2**: Flat colours, no textures, or one texture reused everywhere.
- **3–4**: Textures present but obviously tiling; uniform roughness; plastic look.
- **5–6**: Correct roughness families, some weathering, but tiling visible within
  30 m and wetness is albedo-only.
- **7–8**: §5 targets met. Anti-tiling stack in place. Wetness changes roughness and
  produces reflections and puddles. Weathering follows gravity and geometry.
- **9–10**: Materials tell stories — bleached wear paths in the cobble where tyres
  run, iron-bloom stones, salt haze on seaward walls, spalled stucco showing rubble,
  drip streaks under every sill, wet-road reflections stretching lamps 14 m.

**4 — Colour discipline**
- **1–2**: Monochrome mush, or randomly saturated chaos.
- **3–4**: Pastel-ish but all the same value/hue family; trim and joinery rules
  broken.
- **5–6**: L1/L2 mostly honoured, decent variety, but neighbours repeat hues and the
  warm/cool ratio is off.
- **7–8**: L1/L2/L3 all honoured. 55/30/15 warm/cool/neutral. ≥ 6 distinct hues.
  Gameplay colours reserved. Taxi is the chroma peak.
- **9–10**: The palette is *composed*, not sampled — colour leads the eye down the
  street, cool accents punctuate warm runs, the sea and sky sit in deliberate
  relation to the façades, and the whole frame could be a colour key.

**5 — Lighting quality**
- **1–2**: Flat ambient, no shadows.
- **3–4**: A directional light with shadows, but no fill, no bounce, crushed
  shadows, and the time of day does not visibly change.
- **5–6**: Correct-ish key/fill, shadows land, but shadow lengths don't match the
  claimed sun elevation and the shadow colour is neutral grey.
- **7–8**: §4.2 table implemented. Sun elevation produces correct shadow lengths.
  Warm bounce in shadowed façades, cool sky fill. Fog matches horizon. Night is lit
  by discrete lamp pools.
- **9–10**: Light is authored — golden hour rakes the calles largas end-on with
  slabs of light at cross streets, midday bleaches the cobble and pushes the north
  façades into cool shade, and rain/night/dawn are each unmistakably a different
  time in the same place.

**6 — Readability at speed**
- **1–2**: You cannot tell where the road goes.
- **3–4**: Road is findable but junctions surprise you; non-drivable gaps look
  drivable.
- **5–6**: Drivable line readable, but detail noise competes, or the corridor
  shrinks below 22 %, or markers get lost against façades.
- **7–8**: R1–R11 satisfied. Junctions read at 55 m. Gameplay colour cuts through.
  Blur/CA stay off-centre.
- **9–10**: The city is *designed* for the camera — sightlines aim at landmarks,
  bright façades mark turns, plazas open as decision spaces, and a first-time player
  never has to slow down to understand the world.

**7 — Silhouette & shape language**
- **1–2**: Uniform rectangular skyline.
- **3–4**: Some height variety, no distinct shapes.
- **5–6**: Recognisable landmark shapes but weak street-level silhouette rhythm.
- **7–8**: R6 satisfied — 4+ silhouette events per 100 m. Garita, dome, palm, tower,
  corner balcony all readable as pure black shapes.
- **9–10**: The frame works as a **pure silhouette test** — turn the image to
  black-and-white with threshold at 50 % and the composition still reads as Old San
  Juan, with the taxi clearly separated from everything else.

**8 — Density, life & set dressing**
- **1–2**: Empty streets, blank walls.
- **3–4**: A few props, repeated, floating.
- **5–6**: Reasonable dressing but repetitive and evenly distributed (no clustering).
- **7–8**: Balconies planted, shopfronts stocked, awnings, wires, signs, laundry,
  AC units, traffic and pedestrians at budget, all with contact shadows.
- **9–10**: Streets feel *lived in and locally specific* — cats on the sea wall,
  dominoes in the plaza, a piragua cart working a corner, a repaint patch, a
  half-finished scaffold, and the density clusters where people actually gather.

**9 — Frame finish**
- **1–2**: Aliased, banded, untone-mapped, no AA.
- **3–4**: AA present, no grade, blown highlights, crushed blacks.
- **5–6**: ACES + bloom in place but over-bloomed or over-graded; visible shimmer on
  the cobble at distance.
- **7–8**: §6.3 chain complete. §6.4 statistics in range. No shimmer (anisotropy
  from `QUALITY_BUDGET` applied, mips correct), no banding, no clipping.
- **9–10**: Cinematic finish — per-ToD LUTs, tasteful bloom that only touches real
  highlights, motion blur that reads as speed rather than smear, and a frame you'd
  put on a store page unretouched.

**10 — Cultural respect & specificity**
- **1–2**: Stereotype content present (blacklist §7.5). Offensive shorthand.
- **3–4**: Generic tropical/Latin. Fake Spanish, invented signage, wrong island's
  cultural markers.
- **5–6**: Broadly respectful, but generic — correct Spanish, no specific Puerto
  Rican content, no local detail.
- **7–8**: Specifically Puerto Rican. Correct idiomatic Spanish, real business
  types, PARE signs, azulejo plaques, PR flags, local traffic, full skin-tone range.
- **9–10**: A Puerto Rican player would recognise their city and feel represented,
  not exhibited — real streets, real symbols used knowledgeably, murals and street
  life that mean something, and nothing that flattens the place into a backdrop.

---

## 10. Quick-reference constants for implementers

```ts
// Street corridor
const STREET = {
  arterial:  { total: 16.0, road: 11.0, walk: 2.5 },
  standard:  { total: 12.5, road:  8.5, walk: 2.0 },
  narrow:    { total:  9.5, road:  6.5, walk: 1.5 },
  callejon:  { total:  4.2, road:  4.2, walk: 0.0 },
  seafront:  { total: 22.0, road: 14.0, walk: 4.0 },
  kerbH: 0.14, kerbW: 0.20, camber: 0.02,
};

// Block grid
const GRID = { blockX: 88.0, blockZ: 56.0, pitchX: 100.5, pitchZ: 68.5 };
const BOUNDS = { x: 1620, z: 900 };           // total drivable

// Townhouse
const CASA = {
  bay: 2.90, groundH: 4.30, upperH: 3.80,
  corniceH: 0.42, cornicePr: 0.30, parapetH: 1.10,
  wallT: 0.75, revealD: 0.28, plinthH: 0.55,
  doorW: 1.40, doorH: 3.20, fanlightH: 0.55,
  balconyDoorW: 1.10, balconyDoorH: 2.70,
  encadrementW: 0.20, encadrementPr: 0.035,
};

// Balcony
const BALCON = {
  ironDepth: 0.95, ironSlabT: 0.15, railH: 1.02, barPitch: 0.115, barD: 0.018,
  bracketCount: 3, bracketPitch: 1.45, bracketPr: 0.85,
  woodDepth: 1.15, woodRailH: 1.00, woodRoofH: 2.45, woodRoofPitchDeg: 12,
  balconetteDepth: 0.16, balconetteH: 1.00,
};

// Adoquín
const ADOQUIN = {
  faceL: 0.127, faceW: 0.076, depth: 0.102, joint: 0.009,
  heightJitter: 0.006, rotJitterDeg: 2.5,
  tileBase: 4.08, tileMacro: 23.7, tileMega: 71.3,   // never harmonics
};

// Fort
const FORT = {
  morroH: 43.0, wallT: 6.5, curtainH: 16.0, batter: 1 / 7, adarveW: 4.5,
  garitaOD: 2.20, garitaH: 4.30, garitaDomeRise: 1.05,
  gateW: 3.20, gateH: 4.90, gateTunnelD: 6.0,
};

// Camera
const CAM = {
  fovRest: 62, fovFast: 76, fovSpeedRef: 45,   // m/s
  distRest: 7.0, distFast: 8.8,
  heightRest: 2.60, heightFast: 2.35,
  lookAhead: 6.0, lookUp: 1.40,
  pitchRest: -8, pitchFast: -4,
  driftYawLag: 0.35, driftYawMaxDeg: 18,
};
```

---

## Sources

**Old San Juan — architecture, urbanism, paving**
- [Old San Juan Historic District / Distrito Histórico del Viejo San Juan — National Register of Historic Places Registration Form (NPS)](https://npshistory.com/publications/nr-forms/pr/old-san-juan.pdf) — the primary source for façade typology (bays, storey counts, balconettes vs balconies, persianas, encadrements, colour rule), tapiería/mampostería wall thicknesses, patios and zaguanes, street layout, and the adoquín dimensions ("approximately 3 × 5 inches and 4 inches deep", "silvery-grey parallelepipeds", set in sand) and losa canaria sidewalks.
- [Registro Nacional — Zona Histórica de San Juan (docs.pr.gov)](https://docs.pr.gov/files/OECH/Lugares%20Historicos/Propiedades%20en%20el%20Registro%20Nacional/San%20Juan/Zona%20Historica%20de%20San%20Juan.pdf)
- [La Fortaleza and San Juan National Historic Site — UNESCO World Heritage Centre](https://whc.unesco.org/en/list/266/)
- [Architecture of Puerto Rico — Wikipedia](https://en.wikipedia.org/wiki/Architecture_of_Puerto_Rico)
- [Puerto Rico's Unique Architectural Heritage — Welcome to Puerto Rico](https://welcome.topuertorico.org/culture/architec.shtml)
- [Exploring Old San Juan: A Design and Architecture Tour — Dreamers Welcome](https://dreamerswelcome.com/guidebook/exploring-old-san-juan-a-design-and-architecture-tour)
- [Puerto Rico Architecture: Diversity, History, and Resilience — Parametric Architecture](https://parametric-architecture.com/puerto-rico-architecture/)
- [HABS measured drawings, San Juan, Puerto Rico — Library of Congress](https://www.loc.gov/collections/historic-american-buildings-landscapes-and-engineering-records/?all=true&fa=contributor:historic+american+buildings+survey&q=puerto+rico)
- [HABS PR-106, Casa Blanca — Library of Congress](https://www.loc.gov/resource/hhh.pr0095.sheet/?sp=1&st=slideshow)
- [HABS, 101 Calle Fortaleza (House) — Library of Congress](https://www.loc.gov/resource/hhh.pr0057.sheet/?q=PUERTO+RICO+San+Juan&sp=2)

**Adoquines**
- [Adoquines, the blue cobblestones of Viejo San Juan](https://synchronicityoftheheart.wordpress.com/2018/02/10/adoquines-the-blue-cobblestones-of-viejo-san-juan/)
- [Colony of Cobblestone — Contingent Magazine](https://contingentmagazine.org/2021/04/25/colony-of-cobblestone/)
- [Old San Juan Blue Cobblestone Streets — I Heart PR Tours](https://iheartprtours.com/2026/04/27/old-san-juan-blue-cobblestone-streets/)
- [San Juan, Puerto Rico: Blue Cobblestones](http://travelwithterrysanjuan.blogspot.com/2010/01/blue-cobblestones.html)

**Fortifications, gate, plazas, waterfront**
- [Castillo San Felipe del Morro — Wikipedia](https://en.wikipedia.org/wiki/Castillo_San_Felipe_del_Morro) (43 m height, 5.5–7.6 m wall thickness, six levels, limestone/sandstone with rubble core, esplanade, moat)
- [Castillo San Cristóbal (San Juan) — Wikipedia](https://en.wikipedia.org/wiki/Castillo_San_Crist%C3%B3bal_(San_Juan))
- [San Juan National Historic Site — Wikipedia](https://en.wikipedia.org/wiki/San_Juan_National_Historic_Site)
- [La Puerta de San Juan — Atlas Obscura](https://www.atlasobscura.com/places/san-juan-gate) (16 ft gate height, 20 ft wall thickness, 1635)
- [Plaza de Armas, San Juan — Wikipedia](https://en.wikipedia.org/wiki/Plaza_de_Armas,_San_Juan)
- [Plaza de Armas, Viejo San Juan — anonymous_architecture](https://anonymous-architecture.com/2018/11/08/plaza-de-armas-viejo-san-juan-2/) (1:3.5 paved proportion, two lines of trees, two monumental light posts, Alberto del Toro 1980s)
- [Plazas and Parks — Tour Old San Juan](https://www.touroldsanjuan.com/parks-and-plazas/)
- [San Juan Cruise Port — official port page](https://www.sanjuancruiseport.com/port/) and [San Juan cruise port terminals review — IQCruising](https://www.iqcruising.com/ports/caribbean/puerto-rico/san-juan/piers-and-terminals-san-juan-cruise-port-review-and-port-guide.html) (Pan American Pier 2,000 ft wharf; Pier 6 1,196 ft; max vessel 1,184 ft)
- [San Juan Islet — Wikipedia](https://en.wikipedia.org/wiki/San_Juan_Islet)

**Light, sun and weather**
- [Sunrise and sunset times in San Juan — timeanddate.com](https://www.timeanddate.com/sun/puerto-rico/san-juan)
- [Daylight hours in Puerto Rico — WorldData](https://www.worlddata.info/america/puerto-rico/sunset.php) (winter noon elevation ≈ 48°, solar noon ≈ 12:27, ~25 min twilight)
- [Solar panel angles for San Juan — Solarific](https://solarific.co/cities/us-pr-san-juan)
- [National Weather Service San Juan PR — Area Forecast Discussion](https://forecast.weather.gov/product.php?site=NWS&issuedby=SJU&product=AFD&format=ci&version=1&glossary=1) (trade winds 10–20 mph E, afternoon showers, widespread haze)
- [Climate San Juan — US Climate Data](https://usclimatedata.com/climate/san-juan/puerto-rico/united-states/uspr0087)
- [Mastering Golden Hour, Blue Hour and Twilights — PhotoPills](https://www.photopills.com/articles/mastering-golden-hour-blue-hour-magic-hours-and-twilights)
- [Colour temperature by sky condition — ResearchGate figure](https://www.researchgate.net/figure/Usual-color-temperature-CT-in-Kelvin-for-different-sky-conditions-and-sun-position_fig1_313083757)
- [Colour temperature reference — Engineering ToolBox](https://www.engineeringtoolbox.com/color-temperature-d_1776.html)

**Rendering, materials, arcade visual language**
- [Water drop 3b — Physically based wet surfaces, Sébastien Lagarde](https://seblagarde.wordpress.com/2013/04/14/water-drop-3b-physically-based-wet-surfaces/) (diffuse attenuation floor 0.2, `factor = lerp(1, 0.2, porosity)`, gloss boost, water IOR 1.33, porosity-from-gloss remap)
- [Water drop 3a — Physically based wet surfaces](https://seblagarde.wordpress.com/2013/03/19/water-drop-3a-physically-based-wet-surfaces/)
- [Physically Based Materials — Unreal Engine documentation](https://dev.epicgames.com/documentation/en-us/unreal-engine/physically-based-materials-in-unreal-engine)
- [Physically accurate material values — Polycount](https://polycount.com/discussion/164435/physically-accurate-material-values)
- [Why do things look darker when wet? Translate to PBR? — Polycount](https://polycount.com/discussion/154210/why-do-things-look-darker-when-wet-translate-to-pbr)
- [Game environments part C: making wet environments — fxguide](https://www.fxguide.com/fxfeatured/game-environments-partc/)
- [Crazy Taxi (video game) — Wikipedia](https://en.wikipedia.org/wiki/Crazy_Taxi_(video_game)) (Kenji Kanno; freedom of movement, fluidity and speed; the patented destination arrow)
- [Interview: Kenji Kanno on Crazy Taxi — TheSixthAxis](https://www.thesixthaxis.com/2014/07/29/interview-kenji-kanno-on-crazy-taxi-city-rush-developing-for-mobile-devices/)
- [Racing games with the greatest sense of speed — ResetEra discussion](https://www.resetera.com/threads/racing-games-with-the-greatest-sense-of-speed.747841/)
- [Motion blur in games — Sharan et al., MIG (MIT CSAIL)](https://people.csail.mit.edu/lavanya/PDF/sharanetal13_MIG.pdf)
- [Art Directing VFX for Stylized Games — GDC Vault](https://www.gdcvault.com/play/1024715/Art-Directing-VFX-for-Stylized)
- [Art Direction for AAA UI — GDC Vault](https://gdcvault.com/play/1025052/Art-Direction-for-AAA)
- [LUTious Color: Grading for Games — GDC Vault](https://www.gdcvault.com/play/1026004/LUTious-Color-Grading-for)

**Culture, street life, signage, representation**
- [La Puerta de la Bandera / Callejón de la Puerta con la Bandera](https://mindtrip.ai/attraction/san-juan-puerto-rico/callejon-de-la-puerta-con-la-bandera/at-SnBndTWK) and [Murals and social justice in San Juan](https://marlapoirier.com/blogs/travel/murals-and-social-justice-in-san-juan/) (2012 original, 2016 black-and-white resistance repaint, PROMESA context)
- [An Illustrated Guide To San Juan's Post-Hurricane Street Vendors — NPR](https://www.npr.org/2017/10/27/560179644/a-weekend-with-7-vendors-of-san-juan-illustrated)
- [The Must-Try Street Food of Old San Juan — Secret Food Tours](https://www.secretfoodtours.com/blog/the-must-try-street-food-of-old-san-juan/)
- [Shopping in Puerto Rico's Old San Juan — Moon Travel Guides](https://www.moontravelguides.com/travel/arts-culture/shopping-in-puerto-ricos-old-san-juan/) (vejigante masks, santos de palo, Taíno reproductions)
- [A local's guide to San Juan, Puerto Rico — Washington Post](https://www.washingtonpost.com/travel/united-states/san-juan-puerto-rico-local-guide/)
- [Bomba and bioluminescence — National Geographic](https://www.nationalgeographic.com/travel/article/why-you-should-visit-puerto-rico)
- [The Flamboyán Tree: A Puerto Rico Icon — Caribbean Trading](https://caribbeantrading.com/the-flamboyan-tree-a-puerto-rico-icon/)
- [Hispanic (Mis)Representation in Gaming History — Jaime Pineda, Medium](https://medium.com/@jaapined/hispanic-mis-representation-or-lack-thereof-in-gaming-history-307f154deba9)
- [Identity, Language and Community Through Video Games — Latino USA](https://www.latinousa.org/2022/12/13/videogames/)
- [Cultural consultant feels "tokenized, used and discarded" — BoardGameGeek](https://boardgamegeek.com/thread/3296602/cultural-consultant-feels-tokenized-used-and-disca) (a cautionary case on treating cultural input as decoration)
- [Calles de Viejo San Juan, sus nombres e historia — Crónica Urbana](https://cronica.cronicaurbana.com/blog/calles-historia-viejo-san-juan/)
- [Viejo San Juan, Puerto Rico — La Ciudad Amurallada](https://boricuaonline.com/en/old-san-juan-puerto-rico/)
