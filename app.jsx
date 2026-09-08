/* Generated from the artifact source. React and ReactDOM arrive as globals. */
const { useState, useEffect, useRef, useCallback } = React;

/* ------------------------------------------------------------------ */
/*  Storage layout                                                     */
/*    wardrobe:garments      -> JSON array of tag objects (no images)  */
/*    wardrobe:thumbs:{n}    -> JSON object { id: dataUrl }, 8 per key */
/* ------------------------------------------------------------------ */

const THUMBS_PER_CHUNK = 8;
const GARMENTS_KEY = "wardrobe:garments";
const thumbKey = (n) => `wardrobe:thumbs:${n}`;

/* Storage writes occasionally fail transiently. Retry rather than surfacing a
   scary error for something that succeeds on the second attempt. */
async function storageSet(key, value) {
  let attempt = 0;
  let lastErr = null;
  while (attempt < 3) {
    try {
      const ok = await window.storage.set(key, value);
      if (ok) return true;
      lastErr = new Error("write returned no result");
    } catch (e) {
      lastErr = e;
    }
    attempt += 1;
    if (attempt < 3) await new Promise((r) => setTimeout(r, 700 * attempt));
  }
  throw lastErr || new Error("write failed");
}

/* The tagged queue is persisted in two parts, deliberately.

   Thumbnails are heavy (~40KB each) and never change once tagged, so they are
   written once, in chunks. Tags are tiny and change on every tap, so they live
   in a single small key that can be rewritten freely. Keeping them together
   meant every statement tap rewrote several megabytes, which is what made
   storage fail on large batches. */
const QUEUE_TAGS_KEY = "wardrobe:queue:tags";
const QUEUE_META = "wardrobe:queue:meta";
const QUEUE_THUMBS_PER_CHUNK = 6;
const queueThumbKey = (n) => `wardrobe:queue:thumbs:${n}`;

async function writeQueueTags(items) {
  const slim = items
    .filter((i) => i.status === "tagged")
    .map(({ id, filename, tags }) => ({ id, filename, tags }));
  await storageSet(QUEUE_TAGS_KEY, JSON.stringify(slim));
}

async function writeQueueThumbs(items) {
  const tagged = items.filter((i) => i.status === "tagged" && i.thumb);
  const chunks = Math.ceil(tagged.length / QUEUE_THUMBS_PER_CHUNK);
  for (let i = 0; i < chunks; i++) {
    const payload = {};
    tagged
      .slice(i * QUEUE_THUMBS_PER_CHUNK, (i + 1) * QUEUE_THUMBS_PER_CHUNK)
      .forEach((t) => {
        payload[t.id] = t.thumb;
      });
    await storageSet(queueThumbKey(i), JSON.stringify(payload));
  }
  await storageSet(QUEUE_META, JSON.stringify({ thumbChunks: chunks }));
}

async function readQueue() {
  let tags = [];
  try {
    const r = await window.storage.get(QUEUE_TAGS_KEY);
    if (r && r.value) tags = JSON.parse(r.value);
  } catch {
    return [];
  }
  if (!tags.length) return [];

  let thumbChunks = 0;
  try {
    const r = await window.storage.get(QUEUE_META);
    if (r && r.value) thumbChunks = JSON.parse(r.value).thumbChunks || 0;
  } catch {
    /* tags without thumbnails is degraded but usable */
  }
  const thumbs = {};
  for (let i = 0; i < thumbChunks; i++) {
    try {
      const r = await window.storage.get(queueThumbKey(i));
      if (r && r.value) Object.assign(thumbs, JSON.parse(r.value));
    } catch {
      /* skip a missing chunk */
    }
  }
  return tags.map((t) => ({
    ...t,
    status: "tagged",
    error: null,
    thumb: thumbs[t.id] || null,
    analysis: null,
  }));
}

const CATEGORIES = [
  "dress",
  "jumpsuit",
  "top",
  "sweater",
  "poncho",
  "pants",
  "skirt",
  "shorts",
  "jacket",
  "coat",
  "sandals",
  "flats",
  "sneakers",
  "heels",
  "boots",
  "bag",
  "accessory",
];

/* The occasion model. Floors only — no ceilings, deliberately. See the design
   brief, section 7: a formality ceiling would reintroduce "too nice for a
   Tuesday", which is the behaviour this tool exists to break. */
const OCCASIONS = [
  { key: "home", label: "Working from home", formality: 1, statement: 1, statementMax: 2, exclude: ["dress", "skirt"] },
  { key: "coffee", label: "Coffee with a friend", formality: 1, statement: 2, exclude: [] },
  { key: "shopping", label: "Shopping in town", formality: 1, statement: 2, exclude: [] },
  { key: "date_day", label: "First date — daytime", formality: 2, statement: 2, exclude: [] },
  { key: "day_event", label: "Day event", formality: 3, statement: 2, exclude: [] },
  { key: "evening", label: "Evening out", formality: 3, statement: 3, exclude: [] },
];

/* Footwear, bags and accessories are not anchor pieces. Whether shoes deserve
   a rotation of their own is undecided. */
const NON_ANCHOR = ["bag", "accessory", "sandals", "flats", "sneakers", "heels", "boots"];

function eligiblePool(garments, occ, season = "summer") {
  return garments.filter(
    (g) =>
      !g.stored &&
      !NON_ANCHOR.includes(g.category) &&
      (g.season === season || g.season === "all-season") &&
      g.formality >= occ.formality &&
      g.statement >= occ.statement &&
      g.statement <= (occ.statementMax || 3) &&
      !occ.exclude.includes(g.category)
  );
}

/* A dressing decision covers a body, not a garment. A dress resolves on its
   own; a top leaves a bottom unaccounted for. Without this the worn bottom
   keeps its old date, looks neglected forever, and crowds the queue. */
/* Combinations actually chosen. Nothing reads this yet — it exists so that if
   outfit suggestions are ever built, they start from a real record of taste
   rather than from colour theory. Capturing it costs nothing now and cannot be
   reconstructed later. One record per occasion per day, upserted. */
const OUTFITS_KEY = "wardrobe:outfits";

const SLOT = {
  dress: "full",
  jumpsuit: "full",
  top: "top",
  sweater: "top",
  poncho: "top",
  pants: "bottom",
  skirt: "bottom",
  shorts: "bottom",
  bottom: "bottom",
  jacket: "layer",
  coat: "coat",
};

const COMPLEMENT = { top: "bottom", bottom: "top" };

function slotOf(g) {
  return SLOT[g.category] || "other";
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function daysSince(iso) {
  if (!iso) return 9999;
  const then = new Date(iso + "T00:00:00");
  return Math.max(0, Math.round((Date.now() - then.getTime()) / 86400000));
}

/* Days since worn is the dominant term, and deliberately the only positive one.
   A seeded "hardly ever" already sits at 300 days, so a separate never-worn
   bonus would be redundant. The single negative term stops a garment you just
   passed over from reappearing tomorrow; it decays to nothing over three weeks. */
function neglectScore(g) {
  const worn = daysSince(g.lastWorn);
  const dec = g.lastDeclined ? daysSince(g.lastDeclined) : 9999;
  const penalty = dec < 21 ? (21 - dec) * 8 : 0;
  return worn - penalty;
}

/* Three candidates that are genuinely different from each other. Category is
   the available proxy for silhouette. If the pool is too narrow to fill three
   distinct categories, the guard relaxes rather than returning fewer. */
function pickThree(pool) {
  const sorted = [...pool].sort((a, b) => neglectScore(b) - neglectScore(a));
  const chosen = [];
  const seen = new Set();
  for (const g of sorted) {
    if (chosen.length >= 3) break;
    if (!seen.has(g.category)) {
      chosen.push(g);
      seen.add(g.category);
    }
  }
  for (const g of sorted) {
    if (chosen.length >= 3) break;
    if (!chosen.includes(g)) chosen.push(g);
  }
  return chosen;
}

/* Offered and declined three or more times, across two or more occasions.
   A single decline means nothing — you wanted something else that day. */
function donateCandidates(garments) {
  return garments.filter(
    (g) => (g.timesDeclined || 0) >= 3 && (g.declinedOccasions || []).length >= 2
  );
}

const SEASONS = ["summer", "all-season", "winter"];

/* Vision often returns a synonym rather than the exact enum value. Map the
   unambiguous ones. The one retired value still in the data — bottom — is
   deliberately NOT mapped: guessing between pants/skirt/shorts
   would be inventing data. They surface as unrecognised and get reassigned. */
const CATEGORY_ALIASES = {
  trousers: "pants",
  trouser: "pants",
  pant: "pants",
  jeans: "pants",
  leggings: "pants",
  chinos: "pants",
  culottes: "pants",
  skirts: "skirt",
  short: "shorts",
  tshirt: "top",
  "t-shirt": "top",
  shirt: "top",
  blouse: "top",
  tank: "top",
  bodysuit: "top",
  cardigan: "sweater",
  jumper: "sweater",
  pullover: "sweater",
  knitwear: "sweater",
  cape: "poncho",
  ruana: "poncho",
  shawl: "poncho",
  blazer: "jacket",
  sneaker: "sneakers",
  trainer: "sneakers",
  trainers: "sneakers",
  sandal: "sandals",
  heel: "heels",
  boot: "boots",
  flat: "flats",
  loafers: "flats",
  mules: "flats",
};

function normalizeCategory(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (CATEGORIES.includes(v)) return v;
  if (CATEGORY_ALIASES[v]) return CATEGORY_ALIASES[v];
  return v || "unrecognised";
}

/* A select must never display a value it isn't holding. If the current value
   is outside the enum, prepend it so the browser cannot fall back to showing
   the first option instead. */
function categoryOptions(current) {
  return CATEGORIES.includes(current) ? CATEGORIES : [current, ...CATEGORIES];
}

const FORMALITY_LABELS = {
  1: "Very casual",
  2: "Casual",
  3: "Smart casual",
  4: "Dressy",
  5: "Formal",
};

const STATEMENT_LABELS = { 1: "Plain", 2: "Nice", 3: "Statement" };

const WARMTH_LABELS = { 1: "Hot only", 2: "Transitional", 3: "Cold" };

/* Warmth was added after 259 garments were catalogued. Legacy records derive a
   value from season rather than being migrated: nothing is written until the
   value is edited, so no mass rewrite and no invented precision. Note that
   all-season conflates "light enough for summer" with "warm enough for winter",
   so the derived 2 is a placeholder for those, not a reading. */
const SEASON_WARMTH = { summer: 1, "all-season": 2, winter: 3 };

function warmthOf(g) {
  return g.warmth || SEASON_WARMTH[g.season] || 2;
}

const WEAR_SEEDS = [
  { label: "A lot", days: 3 },
  { label: "Now and then", days: 60 },
  { label: "Hardly ever", days: 300 },
];

const VISION_PROMPT = `You are cataloguing one garment from a personal wardrobe. The photo shows a single item.

Return ONLY a raw JSON object. No preamble, no markdown fences, no explanation.

{
  "name": "short plain description, max 6 words, e.g. 'navy linen shirt dress'",
  "category": "one of: dress, jumpsuit, top, sweater, poncho, pants, skirt, shorts, jacket, coat, sandals, flats, sneakers, heels, boots, bag, accessory",
  "colors": ["one to three colour words"],
  "pattern": "one of: solid, striped, floral, print, textured, other",
  "fabric": "best guess at fabric, one or two words",
  "season": "one of: summer, all-season, winter",
  "warmth": 1,
  "formality": 1,
  "statement": 1,
  "note": "one short clause on anything distinctive, or empty string"
}

CATEGORY
dress, jumpsuit — one piece covering top and bottom.
top — shirts, blouses, tees, tanks, bodysuits.
sweater — knitwear with sleeves and a fitted body: jumpers, cardigans, knit vests.
poncho — anything worn over the shoulders with no fitted sleeves: ponchos, capes, ruanas, blanket wraps. If it drapes rather than fits, it is a poncho, not a sweater.
pants, skirt, shorts — lower body. Wide-leg, palazzo and wrap trousers photographed flat can look like a skirt; look for a centre division or two leg openings before calling it a skirt.
jacket — outerwear that is part of the outfit: denim, leather, blazer, bomber, light overshirt.
coat — outerwear worn to go outside rather than as part of the look: wool coats, trenches, puffers, parkas.
sandals, flats, sneakers, heels, boots — footwear. Use flats for ballet flats, loafers and mules; sneakers for trainers of any kind.
bag, accessory — everything else.

WARMTH (1-3) — the temperature range the piece is actually wearable in. Independent of formality and statement.
1 Hot only: linen, cotton voile, sleeveless, unlined, open weave. Stops working as soon as it cools.
2 Transitional: light knits, thin long sleeves, unlined jackets. Right in spring and autumn — too warm for a hot day, not enough for a cold one.
3 Cold: wool, thick or dense knit, lined coats, anything that only makes sense when it is properly cold.

FORMALITY (1-5) — what a dress code would demand. Judge cut, fabric and construction, not how nice it looks.
1 Very casual: jersey tee, sweatpants, beach cover-up
2 Casual: jeans, cotton sundress, casual sandals
3 Smart casual: linen shirt, tailored shorts, midi skirt
4 Dressy: silk dress, structured blazer, heeled sandals
5 Formal: evening gown, tuxedo-grade tailoring

STATEMENT (1-3) — how much the piece announces itself. This is INDEPENDENT of formality. A plain black tee is formality 1, statement 1. A bold printed sundress is formality 2, statement 3.
1 Plain: neutral, unremarkable, background. The thing you wear when you aren't thinking about it.
2 Nice: has a deliberate quality — good colour, good cut, nice fabric. Someone would register it as chosen.
3 Statement: bold colour, strong print, distinctive silhouette. Someone would comment on it.

Be honest on statement. Judge only how much the piece announces itself — never its condition, quality or price. A plain but perfectly good basic is 1. Do not inflate.`;

/* ---------------------------- helpers ----------------------------- */

function makeId() {
  return "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/* Read the first bytes so an error can say what the file actually is,
   instead of guessing. */
async function sniffFormat(file) {
  try {
    const buf = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const hex = (i) => buf[i];
    if (hex(0) === 0xff && hex(1) === 0xd8 && hex(2) === 0xff) return "JPEG";
    if (hex(0) === 0x89 && hex(1) === 0x50 && hex(2) === 0x4e && hex(3) === 0x47) return "PNG";
    const brand = String.fromCharCode(...buf.slice(4, 12));
    if (brand.startsWith("ftyp")) {
      const sub = brand.slice(4);
      if (/heic|heix|hevc|mif1|msf1/.test(sub)) return "HEIC";
      return "ISO-BMFF (" + sub + ")";
    }
    if (String.fromCharCode(...buf.slice(0, 4)) === "RIFF") return "WebP";
    if (String.fromCharCode(...buf.slice(0, 4)) === "II*\u0000") return "TIFF";
    return "unrecognised";
  } catch {
    return "unreadable";
  }
}

function imgFromSrc(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image element refused the source"));
    img.src = src;
  });
}

/* Three decode paths, most robust first. createImageBitmap decodes the Blob
   directly — no URL is ever loaded, so a sandbox CSP on blob: or data: URLs
   cannot block it. The two fallbacks cover browsers where it is unavailable. */
async function decodeImage(file) {
  const tried = [];

  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      tried.push("bitmap/oriented");
      try {
        return await createImageBitmap(file);
      } catch (e2) {
        tried.push("bitmap/plain");
      }
    }
  } else {
    tried.push("bitmap/unavailable");
  }

  try {
    const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(new Error("FileReader failed"));
      fr.readAsDataURL(file);
    });
    return await imgFromSrc(dataUrl);
  } catch {
    tried.push("data-url");
  }

  let objUrl = null;
  try {
    objUrl = URL.createObjectURL(file);
    const img = await imgFromSrc(objUrl);
    URL.revokeObjectURL(objUrl);
    return img;
  } catch {
    if (objUrl) URL.revokeObjectURL(objUrl);
    tried.push("object-url");
  }

  const fmt = await sniffFormat(file);
  throw new Error(
    `Could not decode — file reads as ${fmt}. Failed paths: ${tried.join(", ")}.`
  );
}

function resize(img, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APIKEY_KEY = "tuesday:apikey";

/* Merging two copies of the wardrobe.

   The two copies hold different fresh things: whichever one you have been
   tagging in has current tags, whichever one you have been wearing from has
   current history. So tags come from the incoming file, and wear history
   never goes backwards on either side.

   Deliberately max rather than sum on the counters: importing the same file
   twice must not double anything. */
function mergeGarment(existing, incoming) {
  const wornLater =
    (incoming.lastWorn || "") >= (existing.lastWorn || "") ? incoming : existing;
  const declinedLater =
    (incoming.lastDeclined || "") >= (existing.lastDeclined || "") ? incoming : existing;
  return {
    ...existing,
    ...incoming,
    lastWorn: wornLater.lastWorn || null,
    lastWornOccasion: wornLater.lastWornOccasion || null,
    timesWorn: Math.max(existing.timesWorn || 0, incoming.timesWorn || 0),
    timesOffered: Math.max(existing.timesOffered || 0, incoming.timesOffered || 0),
    timesDeclined: declinedLater.timesDeclined || 0,
    lastDeclined: declinedLater.lastDeclined || null,
    declinedOccasions: declinedLater.declinedOccasions || [],
  };
}

function mergeGarments(existing, incoming) {
  const byId = new Map(existing.map((g) => [g.id, g]));
  let added = 0;
  let updated = 0;
  incoming.forEach((g) => {
    if (byId.has(g.id)) {
      byId.set(g.id, mergeGarment(byId.get(g.id), g));
      updated += 1;
    } else {
      byId.set(g.id, g);
      added += 1;
    }
  });
  return { list: Array.from(byId.values()), added, updated };
}

/* Outfit records union by date and occasion, the same rule the manual log
   uses, so a piece recorded on one device is never dropped by the other. */
function mergeOutfits(existing, incoming) {
  const key = (o) => o.date + "|" + o.occasion;
  const byKey = new Map(existing.map((o) => [key(o), o]));
  let added = 0;
  incoming.forEach((o) => {
    const k = key(o);
    if (byKey.has(k)) {
      const items = Array.from(new Set([...(byKey.get(k).items || []), ...(o.items || [])]));
      byKey.set(k, { ...byKey.get(k), items });
    } else {
      byKey.set(k, o);
      added += 1;
    }
  });
  return { list: Array.from(byKey.values()), added };
}

/* Two runtimes, one call.

   Inside the Claude artifact the runtime injects credentials, so the request
   must carry none. On a plain web page it needs a key, the API version, and
   an explicit opt-in to browser access — without that last header the browser
   is refused before the request is sent, which surfaces as a bare "Load
   failed" with no status code rather than a 401. */
async function tagGarment(base64, apiKey) {
  let attempt = 0;
  let lastErr = null;
  while (attempt < 3) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: apiKey
          ? {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "anthropic-dangerous-direct-browser-access": "true",
            }
          : { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/jpeg", data: base64 },
                },
                { type: "text", text: VISION_PROMPT },
              ],
            },
          ],
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error("rate-limited");
      }
      if (res.status === 401) {
        throw new Error("key rejected — check it is correct and has credit");
      }
      if (!res.ok) throw new Error("API returned " + res.status);
      const data = await res.json();
      const text = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
      const first = clean.indexOf("{");
      const last = clean.lastIndexOf("}");
      if (first === -1 || last === -1) throw new Error("No JSON in model response");
      return JSON.parse(clean.slice(first, last + 1));
    } catch (e) {
      lastErr = e;
      attempt += 1;
      if (attempt < 3) await sleep(1200 * attempt);
    }
  }
  throw lastErr || new Error("Tagging failed");
}

/* ------------------------------ app ------------------------------- */

/* The app mark. Two garments, no letter — the wordmark does the naming.
   See the design brief, section 11. */
function AppMark({ size = 34 }) {
  const clip = "tuesdayMarkClip";
  return (
    <svg width={size} height={size} viewBox="0 0 116 116" aria-hidden="true">
      <defs>
        <clipPath id={clip}>
          <path d="M76 42 Q87 38 98 42 L100 48 L108 54 Q112 59 108 64 L98 58 L99 76 Q87 83 75 76 L76 58 L66 64 Q62 59 66 54 L74 48 Z" />
        </clipPath>
      </defs>
      <rect width="116" height="116" rx="26" fill="#378ADD" />
      <g transform="translate(0,8)">
        <g transform="rotate(6 87 56)">
          <path
            d="M76 42 Q87 38 98 42 L100 48 L108 54 Q112 59 108 64 L98 58 L99 76 Q87 83 75 76 L76 58 L66 64 Q62 59 66 54 L74 48 Z"
            fill="#F0997B"
            stroke="#10263C"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <g clipPath={`url(#${clip})`}>
            <rect x="60" y="49" width="56" height="5" fill="#F7EEDC" />
            <rect x="60" y="60" width="56" height="5" fill="#F7EEDC" />
            <rect x="60" y="71" width="56" height="5" fill="#F7EEDC" />
          </g>
          <path
            d="M76 42 Q87 38 98 42 L100 48 L108 54 Q112 59 108 64 L98 58 L99 76 Q87 83 75 76 L76 58 L66 64 Q62 59 66 54 L74 48 Z"
            fill="none"
            stroke="#10263C"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </g>
        <g transform="rotate(-6 30 56)">
          <path
            d="M23 32 Q30 28 37 32 L38 50 Q50 60 51 72 Q44 80 36 76 Q28 84 20 76 Q12 82 9 72 Q10 60 22 50 Z"
            fill="#C0DD97"
            stroke="#10263C"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <circle cx="19" cy="63" r="3.4" fill="#F7EEDC" />
          <circle cx="31" cy="69" r="3.4" fill="#F7EEDC" />
          <circle cx="43" cy="63" r="3.4" fill="#F7EEDC" />
          <ellipse cx="23" cy="50" rx="6" ry="4.6" fill="#F7EEDC" stroke="#10263C" strokeWidth="1.5" transform="rotate(-16 23 50)" />
          <ellipse cx="37" cy="50" rx="6" ry="4.6" fill="#F7EEDC" stroke="#10263C" strokeWidth="1.5" transform="rotate(16 37 50)" />
          <circle cx="30" cy="50" r="3.4" fill="#F7EEDC" stroke="#10263C" strokeWidth="1.5" />
        </g>
      </g>
    </svg>
  );
}

function TuesdayApp() {
  const [tab, setTab] = useState("add");
  const [occasion, setOccasion] = useState(null);
  const [season, setSeason] = useState("summer");
  const [offered, setOffered] = useState([]);
  const [outfits, setOutfits] = useState([]);
  const [excluded, setExcluded] = useState([]);
  const [lastAction, setLastAction] = useState(null);
  const [garments, setGarments] = useState([]);
  const [thumbs, setThumbs] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState(null);
  const [queue, setQueue] = useState([]); // {id, status, name, thumb, tags, error}
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null);
  const [queueSaved, setQueueSaved] = useState(true);
  const [exportText, setExportText] = useState(null);
  const [exportName, setExportName] = useState("");
  const [copyState, setCopyState] = useState("idle");
  const [exportMode, setExportMode] = useState("catalogue");
  const [logDate, setLogDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [logOccasion, setLogOccasion] = useState(null);
  const [logSelected, setLogSelected] = useState([]);
  const [logQuery, setLogQuery] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [thumbChunks, setThumbChunks] = useState([]);
  const [thumbPart, setThumbPart] = useState(0);
  const [catFilter, setCatFilter] = useState("all");
  const [catSelected, setCatSelected] = useState([]);
  const exportRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") setPreview(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* Debounced autosave of tags only. Thumbnails are written once, when tagging
     finishes, so a wear tap costs a few kilobytes rather than several megabytes. */
  useEffect(() => {
    if (!loaded) return undefined;
    const t = setTimeout(() => {
      writeQueueTags(queue)
        .then(() => setQueueSaved(true))
        .catch((e) => setStorageError("Could not save review progress: " + e.message));
    }, 800);
    setQueueSaved(false);
    return () => clearTimeout(t);
  }, [queue, loaded]);

  /* -------- load -------- */
  useEffect(() => {
    (async () => {
      try {
        let list = [];
        try {
          const r = await window.storage.get(GARMENTS_KEY);
          if (r && r.value) list = JSON.parse(r.value);
        } catch {
          list = [];
        }
        setGarments(list);
        const chunkCount = Math.ceil(list.length / THUMBS_PER_CHUNK);
        const all = {};
        for (let i = 0; i < chunkCount; i++) {
          try {
            const r = await window.storage.get(thumbKey(i));
            if (r && r.value) Object.assign(all, JSON.parse(r.value));
          } catch {
            /* chunk missing — thumbnails are non-critical */
          }
        }
        setThumbs(all);

        try {
          const r = await window.storage.get(OUTFITS_KEY);
          if (r && r.value) setOutfits(JSON.parse(r.value));
        } catch {
          /* no outfit history yet */
        }

        try {
          const r = await window.storage.get(APIKEY_KEY);
          if (r && r.value) {
            setApiKey(r.value);
            setKeySaved(true);
          }
        } catch {
          /* no key stored; the artifact runtime does not need one */
        }

        const restored = await readQueue();
        if (restored.length) {
          setQueue(restored);
          setTab("review");
        } else if (list.length) {
          setTab("today");
        }
      } catch (e) {
        setStorageError("Could not read saved catalogue: " + e.message);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  /* -------- ingest -------- */
  const saveApiKey = async () => {
    const v = apiKey.trim();
    try {
      if (v) {
        await storageSet(APIKEY_KEY, v);
        setKeySaved(true);
      } else {
        await window.storage.delete(APIKEY_KEY);
        setKeySaved(false);
      }
    } catch (e) {
      setStorageError("Could not save the key: " + e.message);
    }
  };

  const handleFiles = useCallback(async (files) => {
    const arr = Array.from(files);
    const prepared = [];
    for (const f of arr) {
      const id = makeId();
      try {
        const src = await decodeImage(f);
        const thumb = resize(src, 400, 0.72);
        const analysis = resize(src, 768, 0.8);
        if (typeof src.close === "function") src.close();
        prepared.push({
          id,
          filename: f.name,
          status: "queued",
          thumb,
          analysis,
          tags: null,
          error: null,
        });
      } catch (e) {
        prepared.push({
          id,
          filename: f.name,
          status: "failed",
          thumb: null,
          analysis: null,
          tags: null,
          error: e.message,
        });
      }
    }
    setQueue((q) => [...q, ...prepared]);
  }, []);

  /* -------- tag queue -------- */
  const runQueue = useCallback(async () => {
    setProcessing(true);
    const pending = queue.filter((i) => i.status === "queued" || i.status === "failed");
    for (const item of pending) {
      if (!item.analysis) continue;
      setQueue((q) => q.map((i) => (i.id === item.id ? { ...i, status: "tagging", error: null } : i)));
      try {
        const base64 = item.analysis.split(",")[1];
        const tags = await tagGarment(base64, apiKey);
        const clean = {
          name: String(tags.name || "Untitled").slice(0, 60),
          category: normalizeCategory(tags.category),
          colors: Array.isArray(tags.colors) ? tags.colors.slice(0, 3) : [],
          pattern: tags.pattern || "solid",
          fabric: tags.fabric || "",
          season: SEASONS.includes(tags.season) ? tags.season : "summer",
          warmth: Math.min(3, Math.max(1, parseInt(tags.warmth, 10) || 1)),
          formality: Math.min(5, Math.max(1, parseInt(tags.formality, 10) || 2)),
          statement: Math.min(3, Math.max(1, parseInt(tags.statement, 10) || 2)),
          note: tags.note || "",
          wearSeed: null,
        };
        setQueue((q) => q.map((i) => (i.id === item.id ? { ...i, status: "tagged", tags: clean } : i)));
      } catch (e) {
        setQueue((q) =>
          q.map((i) => (i.id === item.id ? { ...i, status: "failed", error: e.message } : i))
        );
      }
      await sleep(400);
    }
    setProcessing(false);
    setTab("review");
    setQueue((q) => {
      writeQueueThumbs(q).catch((e) =>
        setStorageError("Thumbnails could not be saved: " + e.message + " Tags are safe.")
      );
      return q;
    });
  }, [queue]);

  const updateTag = (id, patch) =>
    setQueue((q) => q.map((i) => (i.id === id ? { ...i, tags: { ...i.tags, ...patch } } : i)));

  const dropItem = (id) => setQueue((q) => q.filter((i) => i.id !== id));

  /* -------- save -------- */
  const readyToSave = queue.filter((i) => i.status === "tagged" && i.tags.wearSeed !== null);

  const saveBatch = async () => {
    if (!readyToSave.length) return;
    setSaving(true);
    setStorageError(null);
    try {
      const newGarments = readyToSave.map((i) => ({
        id: i.id,
        sourceFile: i.filename || null,
        ...i.tags,
        lastWorn: daysAgoISO(i.tags.wearSeed),
        timesOffered: 0,
        timesDeclined: 0,
        declinedOccasions: [],
        addedOn: new Date().toISOString().slice(0, 10),
      }));
      const merged = [...garments, ...newGarments];

      // rebuild only the chunks the new items land in
      const startIndex = garments.length;
      const firstChunk = Math.floor(startIndex / THUMBS_PER_CHUNK);
      const lastChunk = Math.floor((merged.length - 1) / THUMBS_PER_CHUNK);
      const newThumbs = { ...thumbs };
      readyToSave.forEach((i) => {
        if (i.thumb) newThumbs[i.id] = i.thumb;
      });

      for (let c = firstChunk; c <= lastChunk; c++) {
        const slice = merged.slice(c * THUMBS_PER_CHUNK, (c + 1) * THUMBS_PER_CHUNK);
        const payload = {};
        slice.forEach((g) => {
          if (newThumbs[g.id]) payload[g.id] = newThumbs[g.id];
        });
        await storageSet(thumbKey(c), JSON.stringify(payload));
      }

      await storageSet(GARMENTS_KEY, JSON.stringify(merged));

      const remaining = queue.filter((i) => !readyToSave.find((r) => r.id === i.id));
      setGarments(merged);
      setThumbs(newThumbs);
      setQueue(remaining);
      await writeQueueThumbs(remaining);
      setTab("catalogue");
    } catch (e) {
      setStorageError(
        "Save failed: " + e.message + " Nothing was lost from this batch — try again."
      );
    } finally {
      setSaving(false);
    }
  };

  const exportStamp = () => {
    const now = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return (
      `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
      `-${p(now.getHours())}${p(now.getMinutes())}`
    );
  };

  /* The catalogue is small and travels in one piece. Thumbnails are roughly
     10 MB of base64, which no clipboard will take in a single go, so they are
     split into parts sized to paste comfortably. Nothing is lost: every part
     names itself and its position. */
  const THUMB_CHUNK_CHARS = 700000;

  const buildThumbChunks = () => {
    const entries = garments
      .filter((g) => thumbs[g.id])
      .map((g) => [g.id, thumbs[g.id]]);
    const chunks = [];
    let current = [];
    let size = 0;
    for (const entry of entries) {
      if (size + entry[1].length > THUMB_CHUNK_CHARS && current.length) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(entry);
      size += entry[1].length;
    }
    if (current.length) chunks.push(current);
    return chunks;
  };

  const showThumbPart = (chunks, index) => {
    const stamp = exportStamp();
    const part = String(index + 1).padStart(2, "0");
    const total = String(chunks.length).padStart(2, "0");
    setExportName(`tuesday-thumbs-${part}-of-${total}-${stamp}.json`);
    setExportText(
      JSON.stringify({
        part: index + 1,
        of: chunks.length,
        thumbs: Object.fromEntries(chunks[index]),
      })
    );
    setCopyState("idle");
  };

  const openExport = () => {
    setExportMode("catalogue");
    setExportName(`tuesday-catalogue-${exportStamp()}.json`);
    setExportText(
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          garments,
          outfits,
        },
        null,
        2
      )
    );
    setCopyState("idle");
  };

  /* Rewrites every thumbnail chunk from a full map. Used after an import, where
     chunk boundaries must be rebuilt to match the imported garment order. */
  const persistThumbs = async (list, thumbMap) => {
    const chunkCount = Math.ceil(list.length / THUMBS_PER_CHUNK);
    for (let c = 0; c < chunkCount; c++) {
      const slice = list.slice(c * THUMBS_PER_CHUNK, (c + 1) * THUMBS_PER_CHUNK);
      const payload = {};
      slice.forEach((g) => {
        if (thumbMap[g.id]) payload[g.id] = thumbMap[g.id];
      });
      await storageSet(thumbKey(c), JSON.stringify(payload));
    }
  };

  const openImport = () => {
    setExportMode("import");
    setExportName("");
    setExportText("");
    setCopyState("idle");
  };

  /* Accepts whatever an export produced, and works out which kind it is from
     the shape rather than asking. Catalogue must be loaded before photo parts,
     since thumbnail chunks are laid out to follow the garment order. */
  const importPaste = async (mode) => {
    let data;
    try {
      data = JSON.parse(exportText);
    } catch (e) {
      setStorageError("That is not valid JSON — check nothing was truncated. " + e.message);
      return;
    }
    try {
      const incomingGarments = Array.isArray(data)
        ? data
        : Array.isArray(data.garments)
        ? data.garments
        : null;

      if (incomingGarments) {
        const incomingOutfits = Array.isArray(data.outfits) ? data.outfits : [];
        let nextGarments;
        let nextOutfits;
        let summary;

        if (mode === "replace") {
          nextGarments = incomingGarments;
          nextOutfits = incomingOutfits;
          summary = `Replaced everything with ${incomingGarments.length} garments and ${incomingOutfits.length} outfit records.`;
        } else {
          const g = mergeGarments(garments, incomingGarments);
          const o = mergeOutfits(outfits, incomingOutfits);
          nextGarments = g.list;
          nextOutfits = o.list;
          summary = `Merged: ${g.added} new, ${g.updated} updated, ${o.added} new outfit records. Nothing lost — tags came from the file, wear history kept whichever was later.`;
        }

        await storageSet(GARMENTS_KEY, JSON.stringify(nextGarments));
        await storageSet(OUTFITS_KEY, JSON.stringify(nextOutfits));
        setGarments(nextGarments);
        setOutfits(nextOutfits);
        setLastAction(summary);
      } else if (data.thumbs) {
        if (!garments.length) {
          setStorageError("Load the catalogue first — photo parts are filed against it.");
          return;
        }
        const merged = { ...thumbs, ...data.thumbs };
        setThumbs(merged);
        await persistThumbs(garments, merged);
        const have = garments.filter((g) => merged[g.id]).length;
        setLastAction(
          `Photo part ${data.part || "?"} of ${data.of || "?"} loaded. ${have} of ${garments.length} garments have a photo.`
        );
      } else {
        setStorageError("Unrecognised — expected a catalogue export or a photo part.");
        return;
      }
      setExportText(null);
      setTab("catalogue");
    } catch (e) {
      setStorageError("Import failed: " + e.message);
    }
  };

  const openThumbExport = () => {
    const chunks = buildThumbChunks();
    if (!chunks.length) {
      setStorageError("No thumbnails stored to export.");
      return;
    }
    setThumbChunks(chunks);
    setThumbPart(0);
    setExportMode("thumbs");
    showThumbPart(chunks, 0);
  };

  const copyExport = async () => {
    try {
      await navigator.clipboard.writeText(exportText);
      setCopyState("copied");
      return;
    } catch {
      /* clipboard API is often unavailable inside a sandboxed frame */
    }
    try {
      const ta = exportRef.current;
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      setCopyState(ok ? "copied" : "manual");
    } catch {
      setCopyState("manual");
    }
  };

  /* Best effort only. Downloads are blocked in some sandboxes; if it fails the
     copy panel above is the guaranteed path. */
  const tryDownload = () => {
    try {
      const a = document.createElement("a");
      a.href = "data:application/json;charset=utf-8," + encodeURIComponent(exportText);
      a.download = exportName;
      a.click();
    } catch {
      setCopyState("manual");
    }
  };

  /* Upsert one outfit record per occasion per day. */
  const recordOutfit = async (merged, occKey) => {
    const items = merged
      .filter((g) => g.lastWorn === todayISO() && g.lastWornOccasion === occKey)
      .map((g) => g.id);
    if (!items.length) return;
    const entry = { date: todayISO(), occasion: occKey, items };
    const list = [
      ...outfits.filter((o) => !(o.date === entry.date && o.occasion === occKey)),
      entry,
    ];
    setOutfits(list);
    try {
      await storageSet(OUTFITS_KEY, JSON.stringify(list));
    } catch {
      /* the wear log is the load-bearing record; this one is a bonus */
    }
  };

  /* Choosing one garment implicitly passes over the other two. That is the
     signal the donate flag is built on, and it costs no extra taps. Wearing a
     garment clears its decline history — you evidently do want it. */
  const applyOutcome = async (wornId, offeredIds, occKey) => {
    const day = todayISO();
    const merged = garments.map((g) => {
      if (!offeredIds.includes(g.id)) return g;
      if (g.id === wornId) {
        return {
          ...g,
          lastWorn: day,
          lastWornOccasion: occKey,
          timesWorn: (g.timesWorn || 0) + 1,
          timesOffered: (g.timesOffered || 0) + 1,
          timesDeclined: 0,
          declinedOccasions: [],
          lastDeclined: null,
        };
      }
      return {
        ...g,
        timesOffered: (g.timesOffered || 0) + 1,
        timesDeclined: (g.timesDeclined || 0) + 1,
        lastDeclined: day,
        declinedOccasions: Array.from(
          new Set([...(g.declinedOccasions || []), occKey])
        ),
      };
    });
    setGarments(merged);
    setOffered([]);
    if (wornId) {
      setExcluded([]);
    } else {
      setExcluded((prev) => [...prev, ...offeredIds]);
    }

    if (wornId) {
      await recordOutfit(merged, occKey);
      const wornNow = merged.filter(
        (g) => g.lastWorn === todayISO() && g.lastWornOccasion === occKey
      );
      const slots = new Set(wornNow.map(slotOf));
      const dressed = slots.has("full") || (slots.has("top") && slots.has("bottom"));
      const coatsExist = merged.some(
        (g) => g.category === "coat" && (g.season === season || g.season === "all-season")
      );
      const coatSettled = !coatsExist || slots.has("coat");
      if (dressed && coatSettled) {
        const label = (OCCASIONS.find((o) => o.key === occKey) || {}).label || "";
        setLastAction(
          `Logged for ${label.toLowerCase()}: ${wornNow.map((g) => g.name).join(", ")}.`
        );
        setOccasion(null);
      }
    }

    try {
      await storageSet(GARMENTS_KEY, JSON.stringify(merged));
    } catch (e) {
      setStorageError("Could not record that: " + e.message);
    }
  };

  /* Logging something the app never offered. No declines recorded — nothing
     was passed over, this is just the truth about what got worn. */
  const logExtra = async (id, occKey) => {
    const day = todayISO();
    const merged = garments.map((g) =>
      g.id === id
        ? {
            ...g,
            lastWorn: day,
            lastWornOccasion: occKey,
            timesWorn: (g.timesWorn || 0) + 1,
            timesDeclined: 0,
            declinedOccasions: [],
            lastDeclined: null,
          }
        : g
    );
    setGarments(merged);
    await recordOutfit(merged, occKey);
    try {
      await storageSet(GARMENTS_KEY, JSON.stringify(merged));
    } catch (e) {
      setStorageError("Could not record that: " + e.message);
    }
  };

  /* A wear you already decided on. Records the truth and nothing else: no
     declines, because nothing was offered and nothing was passed over.

     A backdated entry never moves lastWorn backwards. If a piece has been worn
     since the date being logged, rewinding its clock would make it look more
     neglected than it is and push it back up the queue. The wear still counts. */
  const saveManualLog = async () => {
    if (!logOccasion || !logSelected.length) return;
    const day = logDate;
    const merged = garments.map((g) => {
      if (!logSelected.includes(g.id)) return g;
      const advances = !g.lastWorn || day >= g.lastWorn;
      return {
        ...g,
        stored: false,
        lastWorn: advances ? day : g.lastWorn,
        lastWornOccasion: advances ? logOccasion : g.lastWornOccasion,
        timesWorn: (g.timesWorn || 0) + 1,
        timesDeclined: 0,
        declinedOccasions: [],
        lastDeclined: null,
      };
    });

    /* Merge rather than replace — a later addition should not wipe what is
       already recorded against the same day and occasion. */
    const existing = outfits.find((o) => o.date === day && o.occasion === logOccasion);
    const items = Array.from(new Set([...(existing ? existing.items : []), ...logSelected]));
    const list = [
      ...outfits.filter((o) => !(o.date === day && o.occasion === logOccasion)),
      { date: day, occasion: logOccasion, items },
    ];

    const names = garments
      .filter((g) => logSelected.includes(g.id))
      .map((g) => g.name)
      .join(", ");
    const label = (OCCASIONS.find((o) => o.key === logOccasion) || {}).label || "";

    setGarments(merged);
    setOutfits(list);
    setLogSelected([]);
    setLastAction(`Logged for ${label.toLowerCase()} on ${day}: ${names}.`);
    try {
      await storageSet(GARMENTS_KEY, JSON.stringify(merged));
      await storageSet(OUTFITS_KEY, JSON.stringify(list));
    } catch (e) {
      setStorageError("Could not save that log: " + e.message);
    }
  };

  const resolveDonate = async (id, keep) => {
    const merged = keep
      ? garments.map((g) =>
          g.id === id
            ? { ...g, timesDeclined: 0, declinedOccasions: [], lastDeclined: null }
            : g
        )
      : garments.filter((g) => g.id !== id);
    setGarments(merged);
    try {
      await storageSet(GARMENTS_KEY, JSON.stringify(merged));
    } catch (e) {
      setStorageError("Could not save that: " + e.message);
    }
  };

  const updateGarment = async (id, patch) => {
    const merged = garments.map((g) => (g.id === id ? { ...g, ...patch } : g));
    setGarments(merged);
    try {
      await storageSet(GARMENTS_KEY, JSON.stringify(merged));
    } catch (e) {
      setStorageError("Could not save that change: " + e.message);
    }
  };

  /* Confirming is not changing. A select fires nothing when the value it
     already shows is chosen again, so a correct derived warmth could never be
     accepted. This writes the derived value as a real one. */
  /* Physical availability, kept separate from season. A garment in a box under
     the bed is not a garment you declined — it must not be offered, and it must
     not accumulate declines while it cannot be reached. */
  const setStored = async (list, stored) => {
    const ids = new Set(list.map((g) => g.id));
    const merged = garments.map((g) => (ids.has(g.id) ? { ...g, stored } : g));
    setGarments(merged);
    try {
      await storageSet(GARMENTS_KEY, JSON.stringify(merged));
    } catch (e) {
      setStorageError("Could not update storage state: " + e.message);
    }
  };

  const confirmWarmth = async (list) => {
    const ids = new Set(list.map((g) => g.id));
    const merged = garments.map((g) =>
      ids.has(g.id) ? { ...g, warmth: warmthOf(g) } : g
    );
    setGarments(merged);
    try {
      await storageSet(GARMENTS_KEY, JSON.stringify(merged));
    } catch (e) {
      setStorageError("Could not confirm those: " + e.message);
    }
  };

  const removeGarment = async (id) => {
    const merged = garments.filter((g) => g.id !== id);
    try {
      await storageSet(GARMENTS_KEY, JSON.stringify(merged));
      setGarments(merged);
    } catch (e) {
      setStorageError("Could not remove: " + e.message);
    }
  };

  /* ---------------------------- render ---------------------------- */

  const taggedCount = queue.filter((i) => i.status === "tagged").length;
  const distribution = [1, 2, 3].map(
    (s) => garments.filter((g) => g.statement === s).length
  );
  const legacyCount = garments.filter((g) => !CATEGORIES.includes(g.category)).length;
  const noWarmthCount = garments.filter((g) => !g.warmth).length;
  const storedCount = garments.filter((g) => g.stored).length;
  const storedBytes =
    JSON.stringify(garments).length +
    Object.values(thumbs).reduce((a, t) => a + (t ? t.length : 0), 0) +
    queue.reduce((a, i) => a + (i.thumb ? i.thumb.length : 0), 0);
  const storedMB = (storedBytes / 1048576).toFixed(1);

  const activeOccasion = OCCASIONS.find((o) => o.key === occasion) || null;
  const day = todayISO();
  const wornForOccasion = activeOccasion
    ? garments.filter((g) => g.lastWorn === day && g.lastWornOccasion === activeOccasion.key)
    : [];
  const slotsWorn = new Set(wornForOccasion.map(slotOf));
  const needsSlot =
    slotsWorn.has("full") || !activeOccasion
      ? null
      : slotsWorn.has("top") && !slotsWorn.has("bottom")
      ? "bottom"
      : slotsWorn.has("bottom") && !slotsWorn.has("top")
      ? "top"
      : null;

  const anchorPool = activeOccasion ? eligiblePool(garments, activeOccasion, season) : [];
  const anchorCandidates = anchorPool.filter((g) => !excluded.includes(g.id));
  const anchorPicks = pickThree(anchorCandidates);
  const completePicks = needsSlot
    ? pickThree(
        anchorPool.filter((g) => slotOf(g) === needsSlot && !excluded.includes(g.id))
      )
    : [];
  const wornToday = garments.filter((g) => g.lastWorn === todayISO());
  const todayGroups = OCCASIONS.map((o) => ({
    label: o.label,
    items: wornToday.filter((g) => g.lastWornOccasion === o.key),
  }))
    .filter((grp) => grp.items.length)
    .concat(
      wornToday.some((g) => !OCCASIONS.find((o) => o.key === g.lastWornOccasion))
        ? [
            {
              label: "Not recorded against an occasion",
              items: wornToday.filter(
                (g) => !OCCASIONS.find((o) => o.key === g.lastWornOccasion)
              ),
            },
          ]
        : []
    );

  /* Distinct garments worn in a window, from the outfit log. Counts pieces,
     not wears — repeating one thing four times is not variety. */
  const liveIds = new Set(garments.map((g) => g.id));
  const distinctWorn = (days) => {
    const cutoff = daysAgoISO(days - 1);
    const ids = new Set();
    outfits.forEach((o) => {
      if (o.date >= cutoff) o.items.forEach((i) => liveIds.has(i) && ids.add(i));
    });
    return ids.size;
  };
  const weekCount = distinctWorn(7);
  const monthCount = distinctWorn(30);
  /* Coverage. The tallies above measure how much the app has been used; this
     measures the thing the app is for — how much of the wardrobe has had a
     turn. It only ever rises, and it is the number that answers the question. */
  const everWorn = garments.filter((g) => (g.timesWorn || 0) > 0).length;
  const seasonGarments = garments
    .filter((g) => g.season === season || g.season === "all-season")
    .filter((g) => !NON_ANCHOR.includes(g.category))
    .sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name));
  const coatPool = garments.filter(
    (g) =>
      !g.stored &&
      g.category === "coat" &&
      (g.season === season || g.season === "all-season")
  );
  const coatPicks = activeOccasion ? pickThree(coatPool).slice(0, 2) : [];
  const donateList = donateCandidates(garments);
  const logCandidates = (() => {
    const q = logQuery.trim().toLowerCase();
    const pool = q
      ? garments.filter(
          (g) =>
            (g.name || "").toLowerCase().includes(q) ||
            (g.category || "").toLowerCase().includes(q)
        )
      : garments;
    /* Selected pieces stay visible even when the search no longer matches them,
       so a selection cannot be silently lost while hunting for the next item. */
    const selected = garments.filter(
      (g) => logSelected.includes(g.id) && !pool.includes(g)
    );
    return [...selected, ...pool];
  })();
  const shownGarments = garments.filter((g) => {
    if (catFilter === "all") return true;
    if (catFilter === "legacy") return !CATEGORIES.includes(g.category);
    if (catFilter === "nowarmth") return !g.warmth;
    if (catFilter === "stored") return !!g.stored;
    if (catFilter === "summer") return g.season === "summer";
    if (catFilter === "winter") return g.season === "winter";
    return String(g.statement) === catFilter;
  });
  /* Ticking nothing means "all of these", which keeps the two-tap changeover.
     Ticking some means "just these", for the pieces that stay out. */
  const bulkTargets = catSelected.length
    ? shownGarments.filter((g) => catSelected.includes(g.id))
    : shownGarments;
  const bulkOthers = shownGarments.filter((g) => !catSelected.includes(g.id));

  return (
    <div className="wc-root">
      <style>{`
        .wc-root {
          --ground:#EEF3FA; --card:#FFFFFF; --ink:#10263C; --muted:#5E7180;
          --rule:#CBD9E7; --signal:#2C79C9; --seed:#B85A34; --warn:#A33F2D;
          --pistachio:#C0DD97; --coral:#F0997B; --cream:#F7EEDC;
          background:var(--ground); color:var(--ink); min-height:100vh;
          font-family:"Inter","Helvetica Neue",Arial,sans-serif;
          font-size:14px; line-height:1.5; padding:0 0 64px;
        }
        .wc-wrap { max-width:820px; margin:0 auto; padding:0 20px; }
        .wc-head { display:flex; align-items:center; justify-content:space-between;
          gap:16px; padding:26px 0 14px; flex-wrap:wrap; }
        .wc-brand { display:flex; align-items:center; gap:12px; }
        .wc-title { font-family:"Avenir Next","Nunito","Segoe UI",system-ui,sans-serif;
          font-size:30px; letter-spacing:-0.025em; margin:0; font-weight:800; }
        .wc-sub { color:var(--muted); font-size:12px; letter-spacing:0.08em;
          text-transform:uppercase; }
        .wc-tabs { display:flex; gap:2px; border-bottom:1px solid var(--rule); margin-bottom:24px; }
        .wc-tab { background:none; border:none; border-bottom:2px solid transparent;
          padding:9px 14px; font:inherit; color:var(--muted); cursor:pointer; margin-bottom:-1px; }
        .wc-tab:hover { color:var(--ink); }
        .wc-tab[data-on="1"] { color:var(--ink); border-bottom-color:var(--signal); }
        .wc-tab:focus-visible, .wc-btn:focus-visible, .wc-chip:focus-visible,
        .wc-mini:focus-visible, input:focus-visible, select:focus-visible {
          outline:2px solid var(--signal); outline-offset:2px; }
        .wc-btn { background:var(--signal); color:#fff; border:none; padding:11px 20px;
          font:inherit; cursor:pointer; border-radius:2px; }
        .wc-btn[disabled] { background:var(--rule); color:var(--muted); cursor:not-allowed; }
        .wc-btn-ghost { background:none; color:var(--signal); border:1px solid var(--rule); }
        .wc-note { color:var(--muted); font-size:13px; max-width:56ch; }
        .wc-alert { background:#F7E9E5; border-left:3px solid var(--warn); color:var(--warn);
          padding:11px 14px; margin:16px 0; font-size:13px; }
        .wc-drop { border:1px dashed var(--rule); background:var(--card); padding:38px 24px;
          text-align:center; margin:20px 0; }
        .wc-card { background:var(--card); border:1px solid var(--rule); margin-bottom:14px;
          display:flex; gap:16px; padding:14px; align-items:flex-start; }
        .wc-thumb { width:132px; height:190px; object-fit:contain; background:#fff;
          border:1px solid var(--rule); flex:0 0 auto; cursor:zoom-in; }
        .wc-body { flex:1 1 auto; min-width:0; }
        .wc-name { font-family:"Avenir Next","Nunito","Segoe UI",system-ui,sans-serif;
          font-size:17px; width:100%; border:none; border-bottom:1px solid var(--rule);
          background:none; padding:2px 0 5px; color:var(--ink); }
        .wc-meta { display:flex; flex-wrap:wrap; gap:10px 18px; margin:10px 0 12px;
          font-size:12px; color:var(--muted); }
        .wc-meta select { font:inherit; font-size:12px; background:none; border:none;
          border-bottom:1px solid var(--rule); color:var(--ink); padding:1px 0; }
        .wc-meta select[data-legacy="1"] { color:var(--warn); border-bottom-color:var(--warn); }
        .wc-row { margin-top:11px; }
        .wc-lab { font-size:11px; letter-spacing:0.09em; text-transform:uppercase;
          color:var(--muted); display:block; margin-bottom:5px; }
        .wc-chips { display:flex; gap:6px; flex-wrap:wrap; }
        .wc-chip { border:1px solid var(--rule); background:none; color:var(--muted);
          padding:7px 13px; font:inherit; font-size:13px; cursor:pointer; border-radius:2px; }
        .wc-chip:hover { border-color:var(--muted); }
        .wc-chip[data-on="1"] { background:var(--signal); border-color:var(--signal); color:#fff; }
        .wc-chip[data-seed="1"][data-on="1"] { background:var(--seed); border-color:var(--seed); }
        .wc-mini { border:none; background:none; color:var(--muted); font:inherit;
          font-size:12px; cursor:pointer; text-decoration:underline; padding:0; }
        .wc-status { font-size:12px; color:var(--muted); }
        .wc-pool { border-collapse:collapse; width:100%; max-width:460px; margin:0 0 10px;
          font-size:13px; }
        .wc-pool th { text-align:left; font-weight:400; font-size:11px; letter-spacing:0.09em;
          text-transform:uppercase; color:var(--muted); border-bottom:1px solid var(--rule);
          padding:5px 10px 5px 0; }
        .wc-pool td { padding:6px 10px 6px 0; border-bottom:1px solid var(--rule); }
        .wc-pool th:last-child, .wc-pool td:last-child { text-align:right; padding-right:0; }
        .wc-pool tr[data-thin="1"] td { color:var(--warn); }
        .wc-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(146px,1fr));
          gap:14px; }
        .wc-tile { background:var(--card); border:1px solid var(--rule); padding:8px;
          position:relative; }
        .wc-tick { position:absolute; top:14px; right:14px; width:28px; height:28px;
          border-radius:50%; border:1.5px solid var(--rule); background:#fff;
          color:var(--rule); font-size:15px; line-height:1; padding:0; cursor:pointer;
          display:flex; align-items:center; justify-content:center; }
        .wc-tick:hover { border-color:var(--muted); color:var(--muted); }
        .wc-tick[data-on="1"] { background:var(--signal); border-color:var(--signal);
          color:#fff; }
        .wc-tile img { width:100%; height:190px; object-fit:contain; background:#fff;
          border:1px solid var(--rule); cursor:zoom-in; }
        .wc-export { position:fixed; inset:0; background:rgba(20,24,18,0.72);
          display:flex; align-items:center; justify-content:center; padding:24px; z-index:60; }
        .wc-export-inner { background:var(--ground); border:1px solid var(--rule);
          padding:22px; max-width:720px; width:100%; max-height:88vh; overflow:auto; }
        .wc-export-title { font-family:"Avenir Next","Nunito","Segoe UI",system-ui,sans-serif;
          font-size:22px; font-weight:700; margin:0 0 8px; }
        .wc-export-text { width:100%; height:260px; margin:14px 0; font-family:ui-monospace,
          "SF Mono",Menlo,Consolas,monospace; font-size:11px; line-height:1.45;
          background:#fff; border:1px solid var(--rule); color:var(--ink); padding:10px;
          resize:vertical; }
        .wc-export-actions { display:flex; gap:12px; align-items:center; flex-wrap:wrap;
          margin-bottom:10px; }
        .wc-h2 { font-family:"Avenir Next","Nunito","Segoe UI",system-ui,sans-serif;
          font-size:20px; font-weight:700; margin:0 0 12px; }
        .wc-picks { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
          gap:16px; margin-bottom:16px; }
        .wc-pick { background:var(--card); border:1px solid var(--rule); padding:10px; }
        .wc-pick img { width:100%; height:230px; object-fit:contain; background:#fff;
          border:1px solid var(--rule); cursor:zoom-in; }
        .wc-pick-blank { height:230px; background:var(--rule); }
        .wc-pick-name { font-family:"Avenir Next","Nunito","Segoe UI",system-ui,sans-serif;
          font-weight:600; font-size:16px; margin:9px 0 3px; }
        .wc-why { font-size:12px; color:var(--seed); margin-top:5px; }
        .wc-said { border-left:2px solid var(--signal); padding-left:11px; margin-bottom:18px; }
        .wc-donate { background:#F7E9E5; border-left:3px solid var(--warn); padding:14px;
          margin-bottom:24px; display:flex; gap:14px; align-items:flex-start; font-size:13px; }
        .wc-donate img { width:78px; height:104px; object-fit:contain; background:#fff;
          flex:0 0 auto; }
        .wc-settled { border-left:2px solid var(--signal); padding:2px 0 2px 14px;
          margin-bottom:20px; }
        .wc-tally { display:flex; gap:22px; flex-wrap:wrap; font-size:13px; color:var(--muted);
          border-top:1px solid var(--rule); border-bottom:1px solid var(--rule);
          padding:11px 0; margin-bottom:24px; }
        .wc-tally strong { color:var(--ink); font-size:16px; }
        .wc-worn { display:flex; gap:16px; flex-wrap:wrap; }
        .wc-worn-item { display:flex; gap:9px; align-items:center; font-size:14px; }
        .wc-worn-item img { width:46px; height:62px; object-fit:contain; background:#fff;
          border:1px solid var(--rule); cursor:zoom-in; }
        .wc-manual { font:inherit; font-size:13px; background:#fff; border:1px solid var(--rule);
          color:var(--ink); padding:9px 10px; max-width:100%; }
        .wc-logrow { display:flex; gap:18px; flex-wrap:wrap; margin-bottom:18px; }
        .wc-pickgrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(112px,1fr));
          gap:10px; }
        .wc-picktile { display:block; width:100%; text-align:left; background:var(--card);
          border:1px solid var(--rule); padding:6px; font:inherit; font-size:11px;
          color:var(--muted); cursor:pointer; border-radius:2px; }
        .wc-picktile img, .wc-picktile-blank { width:100%; height:120px; object-fit:contain;
          background:#fff; border:1px solid var(--rule); display:block; margin-bottom:5px; }
        .wc-picktile-blank { background:var(--rule); }
        .wc-picktile span { display:block; overflow:hidden; text-overflow:ellipsis;
          white-space:nowrap; }
        .wc-picktile[data-on="1"] { border-color:var(--signal); background:#DCEAF9;
          color:var(--ink); box-shadow:inset 0 0 0 2px var(--signal); }
        .wc-lightbox { position:fixed; inset:0; background:rgba(20,24,18,0.86);
          display:flex; align-items:center; justify-content:center; padding:28px;
          z-index:50; cursor:zoom-out; }
        .wc-lightbox img { max-width:100%; max-height:100%; object-fit:contain;
          background:#fff; }
        .wc-tile-name { font-size:13px; margin:7px 0 3px; }
        .wc-tile-meta { font-size:11px; color:var(--muted); }
        .wc-tile-links { display:flex; gap:12px; margin-top:6px; }
        .wc-ticked { font-size:12px; letter-spacing:0.08em; text-transform:uppercase;
          color:var(--signal); }
        .wc-tile img[data-stored="1"] { opacity:0.42; }
        .wc-tile-edit { display:flex; flex-wrap:wrap; gap:5px; margin:5px 0 6px; }
        .wc-tile-edit select { flex:1 1 46%; min-width:0; font:inherit; font-size:11px;
          background:#fff; border:1px solid var(--rule); color:var(--ink); padding:3px 4px; }
        .wc-tile-edit select[data-unset="1"] { color:var(--muted); border-style:dashed; }
        .wc-tile-edit select[data-legacy="1"] { border-color:var(--warn); color:var(--warn); }
        .wc-bar { display:flex; gap:14px; align-items:center; flex-wrap:wrap;
          padding:14px 0 20px; }
        .wc-dist { font-size:12px; color:var(--muted); border-left:2px solid var(--rule);
          padding-left:12px; }
        .wc-sticky { position:sticky; bottom:0; background:var(--ground);
          border-top:1px solid var(--rule); padding:14px 0; display:flex; gap:14px;
          align-items:center; flex-wrap:wrap; }
        @media (max-width:520px) {
          .wc-wrap { padding:0 14px; }
          .wc-card { flex-direction:column; }
          .wc-thumb { width:100%; height:220px; }
          .wc-head { padding:20px 0 10px; }
          .wc-title { font-size:26px; }
          .wc-tabs { overflow-x:auto; flex-wrap:nowrap; white-space:nowrap;
            -webkit-overflow-scrolling:touch; }
          .wc-tab { padding:11px 12px; flex:0 0 auto; }
          .wc-chip { padding:10px 15px; font-size:14px; }
          .wc-picks { grid-template-columns:1fr; gap:20px; }
          .wc-pick img, .wc-pick-blank { height:260px; }
          .wc-btn { padding:13px 20px; }
          .wc-pool { font-size:12px; }
          .wc-donate { flex-direction:column; }
          .wc-donate img { width:104px; height:138px; }
          .wc-export-inner { padding:16px; }
          .wc-export-text { height:200px; }
        }
        @media (prefers-reduced-motion:reduce) { * { transition:none !important; } }
      `}</style>

      <div className="wc-wrap">
        <div className="wc-head">
          <div className="wc-brand">
            <AppMark size={38} />
            <h1 className="wc-title">Tuesday</h1>
          </div>
          <span className="wc-sub">
            {garments.length} catalogued · summer
          </span>
        </div>

        <div className="wc-tabs">
          {[
            ["today", "Today"],
            ["log", "Log a wear"],
            ["add", "Add photos"],
            ["review", `Review${taggedCount ? " · " + taggedCount : ""}`],
            ["catalogue", "Catalogue"],
          ].map(([k, label]) => (
            <button
              key={k}
              className="wc-tab"
              data-on={tab === k ? "1" : "0"}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
        </div>

        {storageError && <div className="wc-alert">{storageError}</div>}
        {!loaded && <p className="wc-note">Opening the catalogue…</p>}

        {/* ------------------------ TODAY ------------------------ */}
        {loaded && tab === "today" && (
          <div>
            {garments.length === 0 ? (
              <p className="wc-note">Nothing catalogued yet.</p>
            ) : (
              <>
                {donateList.length > 0 && (
                  <div className="wc-donate">
                    {thumbs[donateList[0].id] && (
                      <img src={thumbs[donateList[0].id]} alt={donateList[0].name} />
                    )}
                    <div>
                      <strong>{donateList[0].name}</strong> has come up{" "}
                      {donateList[0].timesDeclined} times across{" "}
                      {donateList[0].declinedOccasions.length} occasions and you've passed
                      every time. You don't love it as much as you think you do.
                      <div className="wc-export-actions" style={{ marginTop: 10 }}>
                        <button
                          className="wc-btn"
                          onClick={() => resolveDonate(donateList[0].id, false)}
                        >
                          Let it go
                        </button>
                        <button
                          className="wc-btn wc-btn-ghost"
                          onClick={() => resolveDonate(donateList[0].id, true)}
                        >
                          Keep it
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {wornToday.length > 0 && (
                  <div className="wc-settled">
                    <h2 className="wc-h2">Today</h2>
                    {todayGroups.map((grp) => (
                      <div key={grp.label} style={{ marginBottom: 12 }}>
                        <span className="wc-lab">{grp.label}</span>
                        <div className="wc-worn">
                          {grp.items.map((g) => (
                            <div className="wc-worn-item" key={g.id}>
                              {thumbs[g.id] && (
                                <img
                                  src={thumbs[g.id]}
                                  alt={g.name}
                                  onClick={() => setPreview(thumbs[g.id])}
                                />
                              )}
                              <span>{g.name}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {(monthCount > 0 || everWorn > 0) && (
                  <div className="wc-tally">
                    <span>
                      <strong>{weekCount}</strong> pieces in the last 7 days
                    </span>
                    <span>
                      <strong>{monthCount}</strong> in the last 30
                    </span>
                    <span>
                      <strong>{everWorn}</strong> of {garments.length} have had a turn
                    </span>
                  </div>
                )}

                <span className="wc-lab">Season</span>
                <div className="wc-chips" style={{ marginBottom: 20 }}>
                  {["summer", "winter"].map((s) => (
                    <button
                      key={s}
                      className="wc-chip"
                      data-on={season === s ? "1" : "0"}
                      onClick={() => {
                        setSeason(s);
                        setOffered([]);
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>

                <span className="wc-lab">What are you doing?</span>
                <div className="wc-chips" style={{ marginBottom: 24 }}>
                  {OCCASIONS.map((o) => (
                    <button
                      key={o.key}
                      className="wc-chip"
                      data-on={occasion === o.key ? "1" : "0"}
                      onClick={() => {
                        setOccasion(o.key);
                        setOffered([]);
                        setExcluded([]);
                        setLastAction(null);
                      }}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>

                {lastAction && <p className="wc-note wc-said">{lastAction}</p>}

                {activeOccasion && (
                  <>
                    {needsSlot ? (
                      <>
                        <h2 className="wc-h2">
                          {needsSlot === "bottom" ? "And a bottom" : "And a top"}
                        </h2>
                        <p className="wc-note" style={{ marginBottom: 14 }}>
                          Most neglected eligible pieces. Pick on looks — the point is
                          that these need wearing, not that they match.
                        </p>
                        <div className="wc-picks">
                          {completePicks.map((g) => (
                            <div className="wc-pick" key={g.id}>
                              {thumbs[g.id] ? (
                                <img
                                  src={thumbs[g.id]}
                                  alt={g.name}
                                  onClick={() => setPreview(thumbs[g.id])}
                                />
                              ) : (
                                <div className="wc-pick-blank" />
                              )}
                              <div className="wc-pick-name">{g.name}</div>
                              <div className="wc-tile-meta">
                                {g.category} · {STATEMENT_LABELS[g.statement]}
                              </div>
                              <div className="wc-why">
                                not worn in {daysSince(g.lastWorn)} days
                              </div>
                              <button
                                className="wc-btn"
                                style={{ width: "100%", marginTop: 8 }}
                                onClick={() => {
                                  applyOutcome(
                                    g.id,
                                    completePicks.map((x) => x.id),
                                    activeOccasion.key
                                  );
                                  setLastAction(null);
                                }}
                              >
                                Wearing this
                              </button>
                            </div>
                          ))}
                        </div>
                        <div className="wc-export-actions">
                          <button
                            className="wc-btn wc-btn-ghost"
                            onClick={() =>
                              setExcluded([...excluded, ...completePicks.map((g) => g.id)])
                            }
                          >
                            Show three different
                          </button>
                          <select
                            className="wc-manual"
                            value=""
                            onChange={(e) => {
                              if (e.target.value) logExtra(e.target.value, activeOccasion.key);
                            }}
                          >
                            <option value="">Wore something else…</option>
                            {seasonGarments
                              .filter((g) => slotOf(g) === needsSlot)
                              .map((g) => (
                                <option key={g.id} value={g.id}>
                                  {g.name}
                                </option>
                              ))}
                          </select>
                        </div>
                      </>
                    ) : wornForOccasion.length > 0 ? (
                      <div className="wc-export-actions">
                        <span className="wc-note">
                          Nothing else to decide. Suggestions for{" "}
                          {activeOccasion.label.toLowerCase()} are done for today.
                        </span>
                        <select
                          className="wc-manual"
                          value=""
                          onChange={(e) => {
                            if (e.target.value) logExtra(e.target.value, activeOccasion.key);
                          }}
                        >
                          <option value="">Log another piece…</option>
                          {seasonGarments
                            .filter((g) => !wornForOccasion.find((w) => w.id === g.id))
                            .map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.category} — {g.name}
                              </option>
                            ))}
                        </select>
                      </div>
                    ) : anchorPicks.length === 0 ? (
                      excluded.length > 0 ? (
                        <div className="wc-export-actions">
                          <span className="wc-note">
                            That's everything eligible for{" "}
                            {activeOccasion.label.toLowerCase()} — you've passed on all{" "}
                            {anchorPool.length}.
                          </span>
                          <button
                            className="wc-btn wc-btn-ghost"
                            onClick={() => setExcluded([])}
                          >
                            Start again
                          </button>
                        </div>
                      ) : (
                        <p className="wc-note">
                          Nothing eligible. {activeOccasion.label} needs formality{" "}
                          {activeOccasion.formality}+ and statement{" "}
                          {activeOccasion.statementMax
                            ? `${activeOccasion.statement}–${activeOccasion.statementMax}`
                            : `${activeOccasion.statement}+`}{" "}
                          in {season}.
                        </p>
                      )
                    ) : (
                      <>
                        <h2 className="wc-h2">Wear one of these</h2>
                        <div className="wc-picks">
                          {anchorPicks.map((g) => (
                            <div className="wc-pick" key={g.id}>
                              {thumbs[g.id] ? (
                                <img
                                  src={thumbs[g.id]}
                                  alt={g.name}
                                  onClick={() => setPreview(thumbs[g.id])}
                                />
                              ) : (
                                <div className="wc-pick-blank" />
                              )}
                              <div className="wc-pick-name">{g.name}</div>
                              <div className="wc-tile-meta">
                                {g.category} · {STATEMENT_LABELS[g.statement]}
                              </div>
                              <div className="wc-why">
                                not worn in {daysSince(g.lastWorn)} days
                              </div>
                              <button
                                className="wc-btn"
                                style={{ width: "100%", marginTop: 8 }}
                                onClick={() => {
                                  applyOutcome(
                                    g.id,
                                    anchorPicks.map((x) => x.id),
                                    activeOccasion.key
                                  );
                                  setLastAction(null);
                                }}
                              >
                                Wearing this
                              </button>
                            </div>
                          ))}
                        </div>
                        <div className="wc-export-actions" style={{ marginTop: 4 }}>
                          <button
                            className="wc-btn wc-btn-ghost"
                            onClick={() => {
                              applyOutcome(
                                null,
                                anchorPicks.map((x) => x.id),
                                activeOccasion.key
                              );
                              setLastAction("Passed on all three. Three more below.");
                            }}
                          >
                            None of these
                          </button>
                          <span className="wc-note">
                            {anchorPool.length} eligible for {activeOccasion.label}
                          </span>
                        </div>
                      </>
                    )}

                    {coatPicks.length > 0 && !slotsWorn.has("coat") && (
                      <>
                        <h2 className="wc-h2" style={{ marginTop: 30 }}>
                          And a coat
                        </h2>
                        <div className="wc-picks">
                          {coatPicks.map((g) => (
                            <div className="wc-pick" key={g.id}>
                              {thumbs[g.id] ? (
                                <img
                                  src={thumbs[g.id]}
                                  alt={g.name}
                                  onClick={() => setPreview(thumbs[g.id])}
                                />
                              ) : (
                                <div className="wc-pick-blank" />
                              )}
                              <div className="wc-pick-name">{g.name}</div>
                              <div className="wc-why">
                                not worn in {daysSince(g.lastWorn)} days
                              </div>
                              <button
                                className="wc-btn"
                                style={{ width: "100%", marginTop: 8 }}
                                onClick={() =>
                                  applyOutcome(
                                    g.id,
                                    coatPicks.map((x) => x.id),
                                    activeOccasion.key
                                  )
                                }
                              >
                                Wearing this
                              </button>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* -------------------- LOG A WEAR ----------------------- */}
        {loaded && tab === "log" && (
          <div>
            {garments.length === 0 ? (
              <p className="wc-note">Nothing catalogued yet.</p>
            ) : (
              <>
                <p className="wc-note">
                  For something you already decided on. Records the wear and the
                  combination; nothing is counted as declined, because nothing was
                  offered.
                </p>

                <div className="wc-logrow">
                  <div>
                    <span className="wc-lab">Date</span>
                    <input
                      type="date"
                      className="wc-manual"
                      value={logDate}
                      max={todayISO()}
                      onChange={(e) => setLogDate(e.target.value)}
                    />
                  </div>
                  <div style={{ flex: "1 1 240px" }}>
                    <span className="wc-lab">Find a piece</span>
                    <input
                      className="wc-manual"
                      style={{ width: "100%" }}
                      placeholder="name or category"
                      value={logQuery}
                      onChange={(e) => setLogQuery(e.target.value)}
                    />
                  </div>
                </div>

                <span className="wc-lab">What were you doing?</span>
                <div className="wc-chips" style={{ marginBottom: 20 }}>
                  {OCCASIONS.map((o) => (
                    <button
                      key={o.key}
                      className="wc-chip"
                      data-on={logOccasion === o.key ? "1" : "0"}
                      onClick={() => setLogOccasion(o.key)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>

                {lastAction && <p className="wc-note wc-said">{lastAction}</p>}

                <div className="wc-sticky">
                  <button
                    className="wc-btn"
                    disabled={!logOccasion || !logSelected.length}
                    onClick={saveManualLog}
                  >
                    Log {logSelected.length || ""} {logSelected.length === 1 ? "piece" : "pieces"}
                  </button>
                  <span className="wc-note">
                    {!logOccasion
                      ? "Pick an occasion."
                      : !logSelected.length
                      ? "Tap the pieces you wore."
                      : logDate === todayISO()
                      ? "Today."
                      : `Backdated to ${logDate} — the neglect clock only moves forward.`}
                  </span>
                </div>

                <div className="wc-pickgrid">
                  {logCandidates.map((g) => (
                    <button
                      key={g.id}
                      className="wc-picktile"
                      data-on={logSelected.includes(g.id) ? "1" : "0"}
                      onClick={() =>
                        setLogSelected((prev) =>
                          prev.includes(g.id)
                            ? prev.filter((x) => x !== g.id)
                            : [...prev, g.id]
                        )
                      }
                    >
                      {thumbs[g.id] ? (
                        <img src={thumbs[g.id]} alt="" />
                      ) : (
                        <div className="wc-picktile-blank" />
                      )}
                      <span>{g.name}</span>
                    </button>
                  ))}
                </div>
                {logCandidates.length === 0 && (
                  <p className="wc-note">Nothing matches “{logQuery}”.</p>
                )}
              </>
            )}
          </div>
        )}

        {/* ------------------------- ADD ------------------------- */}
        {loaded && tab === "add" && (
          <div>
            <p className="wc-note">
              One garment per photo, laid flat or hung. Shoot a batch, then review them
              together — judging <em>statement</em> is more consistent when you can see
              twenty side by side.
            </p>

            <div className="wc-card" style={{ display: "block", marginBottom: 18 }}>
              <span className="wc-lab">Anthropic API key</span>
              <input
                className="wc-manual"
                style={{ width: "100%", maxWidth: 480 }}
                type="password"
                autoComplete="off"
                spellCheck="false"
                placeholder={keySaved ? "saved on this device" : "sk-ant-…"}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setKeySaved(false);
                }}
              />
              <div className="wc-export-actions" style={{ marginTop: 10 }}>
                <button className="wc-btn" onClick={saveApiKey}>
                  {keySaved ? "Saved" : "Save key"}
                </button>
                <span className="wc-note">
                  Needed only outside the Claude artifact, where no credentials are
                  supplied. Held on this device and never in the repository. Get one at
                  console.anthropic.com — it is billed separately from a Claude
                  subscription.
                </span>
              </div>
            </div>
            <div className="wc-drop">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  handleFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button className="wc-btn" onClick={() => fileRef.current?.click()}>
                Choose photos
              </button>
              <p className="wc-note" style={{ margin: "14px auto 0" }}>
                JPEG, PNG or WebP. If a file fails, the message names the format it
                actually is and which decode paths were tried.
              </p>
            </div>

            {queue.length > 0 && (
              <>
                <p className="wc-status">
                  {queue.length} in the queue ·{" "}
                  {queue.filter((i) => i.status === "tagged").length} tagged ·{" "}
                  {queue.filter((i) => i.status === "failed").length} failed
                </p>
                <div style={{ marginTop: 12 }}>
                  {queue.map((i) => (
                    <div
                      key={i.id}
                      style={{
                        display: "flex",
                        gap: 12,
                        alignItems: "center",
                        padding: "7px 0",
                        borderBottom: "1px solid var(--rule)",
                      }}
                    >
                      {i.thumb ? (
                        <img
                          src={i.thumb}
                          alt=""
                          style={{ width: 34, height: 44, objectFit: "contain", background: "#fff" }}
                        />
                      ) : (
                        <div style={{ width: 34, height: 44, background: "var(--rule)" }} />
                      )}
                      <span style={{ flex: 1, fontSize: 13, wordBreak: "break-all" }}>
                        {i.filename}
                      </span>
                      <span
                        className="wc-status"
                        style={{ color: i.status === "failed" ? "var(--warn)" : undefined }}
                      >
                        {i.status === "failed" ? i.error : i.status}
                      </span>
                      <button className="wc-mini" onClick={() => dropItem(i.id)}>
                        remove
                      </button>
                    </div>
                  ))}
                </div>
                <div className="wc-sticky">
                  <button
                    className="wc-btn"
                    disabled={processing || !queue.some((i) => i.analysis && i.status !== "tagged")}
                    onClick={runQueue}
                  >
                    {processing ? "Tagging…" : "Tag these"}
                  </button>
                  <span className="wc-note">
                    One API call per photo, run in sequence. Failures are retried three
                    times and then shown, never silently dropped.
                    {!apiKey && !keySaved
                      ? " No key saved — this works inside the Claude artifact, and needs a key anywhere else."
                      : ""}
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {/* ------------------------ REVIEW ------------------------ */}
        {loaded && tab === "review" && (
          <div>
            {taggedCount === 0 ? (
              <p className="wc-note">
                Nothing to review. Add photos and tag them first.
              </p>
            ) : (
              <>
                <p className="wc-note">
                  Two decisions per garment: correct <em>statement</em> if the tag is wrong,
                  and record how much you've actually worn it. Everything else is optional.
                </p>
                {queue
                  .filter((i) => i.status === "tagged")
                  .map((i) => (
                    <div className="wc-card" key={i.id}>
                      {i.thumb && (
                        <img
                          className="wc-thumb"
                          src={i.thumb}
                          alt={i.tags.name}
                          onClick={() => setPreview(i.analysis || i.thumb)}
                        />
                      )}
                      <div className="wc-body">
                        <input
                          className="wc-name"
                          value={i.tags.name}
                          onChange={(e) => updateTag(i.id, { name: e.target.value })}
                        />
                        <div className="wc-meta">
                          <select
                            value={i.tags.category}
                            data-legacy={CATEGORIES.includes(i.tags.category) ? "0" : "1"}
                            onChange={(e) => updateTag(i.id, { category: e.target.value })}
                          >
                            {categoryOptions(i.tags.category).map((c) => (
                              <option key={c} value={c}>
                                {CATEGORIES.includes(c) ? c : `${c} — reassign`}
                              </option>
                            ))}
                          </select>
                          <select
                            value={i.tags.season}
                            onChange={(e) => updateTag(i.id, { season: e.target.value })}
                          >
                            {SEASONS.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                          <select
                            value={i.tags.warmth || 1}
                            onChange={(e) =>
                              updateTag(i.id, { warmth: parseInt(e.target.value, 10) })
                            }
                          >
                            {[1, 2, 3].map((w) => (
                              <option key={w} value={w}>
                                {WARMTH_LABELS[w]}
                              </option>
                            ))}
                          </select>
                          <select
                            value={i.tags.formality}
                            onChange={(e) =>
                              updateTag(i.id, { formality: parseInt(e.target.value, 10) })
                            }
                          >
                            {[1, 2, 3, 4, 5].map((f) => (
                              <option key={f} value={f}>
                                {f} · {FORMALITY_LABELS[f]}
                              </option>
                            ))}
                          </select>
                          <span>
                            {i.tags.colors.join(", ")}
                            {i.tags.fabric ? " · " + i.tags.fabric : ""}
                          </span>
                        </div>

                        <div className="wc-row">
                          <span className="wc-lab">Statement</span>
                          <div className="wc-chips">
                            {[1, 2, 3].map((s) => (
                              <button
                                key={s}
                                className="wc-chip"
                                data-on={i.tags.statement === s ? "1" : "0"}
                                onClick={() => updateTag(i.id, { statement: s })}
                              >
                                {STATEMENT_LABELS[s]}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="wc-row">
                          <span className="wc-lab">How much have you worn this?</span>
                          <div className="wc-chips">
                            {WEAR_SEEDS.map((w) => (
                              <button
                                key={w.label}
                                className="wc-chip"
                                data-seed="1"
                                data-on={i.tags.wearSeed === w.days ? "1" : "0"}
                                onClick={() => updateTag(i.id, { wearSeed: w.days })}
                              >
                                {w.label}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div style={{ marginTop: 12 }}>
                          <button className="wc-mini" onClick={() => dropItem(i.id)}>
                            discard this one
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}

                <div className="wc-sticky">
                  <button className="wc-btn" disabled={!readyToSave.length || saving} onClick={saveBatch}>
                    {saving ? "Saving…" : `Save ${readyToSave.length} to catalogue`}
                  </button>
                  <span className="wc-note">
                    {taggedCount - readyToSave.length > 0
                      ? `${taggedCount - readyToSave.length} still need a wear answer.`
                      : "All answered."}{" "}
                    {queueSaved ? "Progress saved — safe to close." : "Saving…"}
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {/* ---------------------- CATALOGUE ----------------------- */}
        {loaded && tab === "catalogue" && (
          <div>
            {garments.length === 0 ? (
              <p className="wc-note">Empty. Start with thirty summer pieces.</p>
            ) : (
              <>
                <div className="wc-bar">
                  <button className="wc-btn wc-btn-ghost" onClick={openExport}>
                    Export catalogue
                  </button>
                  <button className="wc-btn wc-btn-ghost" onClick={openThumbExport}>
                    Export photos
                  </button>
                  <button className="wc-btn wc-btn-ghost" onClick={openImport}>
                    Import
                  </button>
                  <span className="wc-dist">
                    Statement spread — plain {distribution[0]} · nice {distribution[1]} ·
                    statement {distribution[2]}
                  </span>
                  <span className="wc-dist">{storedMB} MB stored</span>
                  {legacyCount > 0 && (
                    <span className="wc-dist" style={{ color: "var(--warn)" }}>
                      {legacyCount} on retired labels — reassign below
                    </span>
                  )}
                </div>

                <table className="wc-pool">
                  <thead>
                    <tr>
                      <th>Occasion</th>
                      <th>Form.</th>
                      <th>Stmt.</th>
                      <th>Eligible</th>
                    </tr>
                  </thead>
                  <tbody>
                    {OCCASIONS.map((o) => {
                      const n = eligiblePool(garments, o).length;
                      return (
                        <tr key={o.key} data-thin={n < 8 ? "1" : "0"}>
                          <td>{o.label}</td>
                          <td>{o.formality}+</td>
                          <td>{o.statementMax ? `${o.statement}–${o.statementMax}` : `${o.statement}+`}</td>
                          <td>{n}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="wc-note" style={{ margin: "0 0 20px" }}>
                  Summer and all-season garments only; footwear, bags and accessories
                  excluded. Under eight makes a ranked top-three meaningless.
                </p>

                <div className="wc-chips" style={{ marginBottom: 18 }}>
                  {[
                    ["all", `All ${garments.length}`],
                    ["1", `Plain ${distribution[0]}`],
                    ["2", `Nice ${distribution[1]}`],
                    ["3", `Statement ${distribution[2]}`],
                  ]
                    .concat(legacyCount > 0 ? [["legacy", `Retired ${legacyCount}`]] : [])
                    .concat([
                      ["summer", "Summer"],
                      ["winter", "Winter"],
                    ])
                    .concat(storedCount > 0 ? [["stored", `In storage ${storedCount}`]] : [])
                    .concat(
                      noWarmthCount > 0
                        ? [["nowarmth", `No warmth ${noWarmthCount}`]]
                        : []
                    )
                    .map(([k, label]) => (
                      <button
                        key={k}
                        className="wc-chip"
                        data-on={catFilter === k ? "1" : "0"}
                        onClick={() => {
                          setCatFilter(k);
                          setCatSelected([]);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                </div>

                {(["summer", "winter", "stored"].includes(catFilter) ||
                  catSelected.length > 0) &&
                  shownGarments.length > 0 && (
                    <div className="wc-export-actions" style={{ marginBottom: 18 }}>
                      {catSelected.length > 0 ? (
                        <>
                          <span className="wc-ticked">{catSelected.length} ticked</span>
                          <button
                            className="wc-btn"
                            onClick={() => {
                              setStored(bulkTargets, true);
                              setCatSelected([]);
                            }}
                          >
                            Put these away
                          </button>
                          <button
                            className="wc-btn wc-btn-ghost"
                            onClick={() => {
                              setStored(bulkTargets, false);
                              setCatSelected([]);
                            }}
                          >
                            Bring these out
                          </button>
                          {["summer", "winter"].includes(catFilter) && (
                            <button
                              className="wc-btn wc-btn-ghost"
                              onClick={() => {
                                setStored(bulkOthers, true);
                                setCatSelected([]);
                              }}
                            >
                              Keep these out, put the other {bulkOthers.length} away
                            </button>
                          )}
                          <button className="wc-mini" onClick={() => setCatSelected([])}>
                            clear ticks
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="wc-btn"
                            onClick={() => setStored(shownGarments, catFilter !== "stored")}
                          >
                            {catFilter === "stored"
                              ? `Bring all ${shownGarments.length} out`
                              : `Put all ${shownGarments.length} away`}
                          </button>
                          <span className="wc-note">
                            Or tick a few first. Nothing in storage is offered or counted
                            as declined.
                          </span>
                        </>
                      )}
                    </div>
                  )}

                {catFilter === "nowarmth" && shownGarments.length > 0 && (
                  <div className="wc-export-actions" style={{ marginBottom: 18 }}>
                    <button
                      className="wc-btn"
                      onClick={() => {
                        confirmWarmth(bulkTargets);
                        setCatSelected([]);
                      }}
                    >
                      These {bulkTargets.length} are right
                    </button>
                    <span className="wc-note">
                      Correct any that are wrong first — they leave this list as you
                      change them. This accepts the rest as tagged.
                    </span>
                  </div>
                )}

                <div className="wc-grid">
                  {shownGarments.map((g) => (
                    <div className="wc-tile" key={g.id}>
                      <button
                        className="wc-tick"
                        data-on={catSelected.includes(g.id) ? "1" : "0"}
                        aria-label={`Select ${g.name}`}
                        onClick={() =>
                          setCatSelected((prev) =>
                            prev.includes(g.id)
                              ? prev.filter((x) => x !== g.id)
                              : [...prev, g.id]
                          )
                        }
                      >
                        ✓
                      </button>
                      {thumbs[g.id] ? (
                        <img
                          src={thumbs[g.id]}
                          alt={g.name}
                          data-stored={g.stored ? "1" : "0"}
                          onClick={() => setPreview(thumbs[g.id])}
                        />
                      ) : (
                        <div style={{ height: 190, background: "var(--rule)" }} />
                      )}
                      <div className="wc-tile-name">{g.name}</div>
                      <div className="wc-tile-edit">
                        <select
                          value={g.category}
                          onChange={(e) => updateGarment(g.id, { category: e.target.value })}
                          data-legacy={CATEGORIES.includes(g.category) ? "0" : "1"}
                        >
                          {categoryOptions(g.category).map((c) => (
                            <option key={c} value={c}>
                              {CATEGORIES.includes(c) ? c : `${c} — reassign`}
                            </option>
                          ))}
                        </select>
                        <select
                          value={g.statement}
                          onChange={(e) =>
                            updateGarment(g.id, { statement: parseInt(e.target.value, 10) })
                          }
                        >
                          {[1, 2, 3].map((s) => (
                            <option key={s} value={s}>
                              {STATEMENT_LABELS[s]}
                            </option>
                          ))}
                        </select>
                        <select
                          value={warmthOf(g)}
                          onChange={(e) =>
                            updateGarment(g.id, { warmth: parseInt(e.target.value, 10) })
                          }
                          data-unset={g.warmth ? "0" : "1"}
                        >
                          {[1, 2, 3].map((w) => (
                            <option key={w} value={w}>
                              {WARMTH_LABELS[w]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="wc-tile-meta">
                        formality {g.formality} · {g.season}
                      </div>
                      <div className="wc-tile-meta">last worn {g.lastWorn}</div>
                      <div className="wc-tile-links">
                        <button
                          className="wc-mini"
                          onClick={() => setStored([g], !g.stored)}
                        >
                          {g.stored ? "bring out" : "put away"}
                        </button>
                        <button className="wc-mini" onClick={() => removeGarment(g.id)}>
                          remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {exportText !== null && (
        <div className="wc-export">
          <div className="wc-export-inner">
            <h2 className="wc-export-title">
              {exportMode === "import"
                ? "Import"
                : exportMode === "thumbs"
                ? "Export photos"
                : "Export catalogue"}
            </h2>
            {exportMode === "import" ? (
              <p className="wc-note">
                Paste a catalogue export or a photo part. The catalogue goes first —
                photo parts are filed against it, and they always merge.
                <br />
                <br />
                <strong>Merge</strong> is almost always what you want: tags come from
                the pasted file, wear history keeps whichever side is later, and
                garments missing from the file are left alone. Safe in either
                direction. <strong>Replace</strong> is for restoring a backup onto an
                empty or broken copy, and discards anything not in the file.
              </p>
            ) : exportMode === "thumbs" ? (
              <p className="wc-note">
                Part <strong>{thumbPart + 1}</strong> of {thumbChunks.length}. Copy this
                and save it as <strong>{exportName}</strong>, then move to the next part.
                All parts are needed; each names its own position.
              </p>
            ) : (
              <p className="wc-note">
                {garments.length} garments with wear history, plus {outfits.length} outfit
                records. No photos — those are the separate export. Save as{" "}
                <strong>{exportName}</strong> alongside your photo folder.
              </p>
            )}
            <textarea
              ref={exportRef}
              className="wc-export-text"
              readOnly={exportMode !== "import"}
              placeholder={exportMode === "import" ? "Paste here" : undefined}
              value={exportText}
              onChange={(e) => setExportText(e.target.value)}
            />
            <div className="wc-export-actions">
              {exportMode === "import" ? (
                <>
                  <button
                    className="wc-btn"
                    disabled={!exportText.trim()}
                    onClick={() => importPaste("merge")}
                  >
                    Merge in
                  </button>
                  <button
                    className="wc-btn wc-btn-ghost"
                    disabled={!exportText.trim()}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Replace everything here with the pasted file? Any wear history not in that file is lost."
                        )
                      ) {
                        importPaste("replace");
                      }
                    }}
                  >
                    Replace instead
                  </button>
                </>
              ) : (
                <button className="wc-btn" onClick={copyExport}>
                  {copyState === "copied" ? "Copied" : "Copy to clipboard"}
                </button>
              )}
              {exportMode !== "import" && (
                <button className="wc-btn wc-btn-ghost" onClick={tryDownload}>
                  Try file download
                </button>
              )}
              {exportMode === "thumbs" && (
                <>
                  <button
                    className="wc-btn wc-btn-ghost"
                    disabled={thumbPart === 0}
                    onClick={() => {
                      const n = thumbPart - 1;
                      setThumbPart(n);
                      showThumbPart(thumbChunks, n);
                    }}
                  >
                    Previous
                  </button>
                  <button
                    className="wc-btn"
                    disabled={thumbPart >= thumbChunks.length - 1}
                    onClick={() => {
                      const n = thumbPart + 1;
                      setThumbPart(n);
                      showThumbPart(thumbChunks, n);
                    }}
                  >
                    Next part
                  </button>
                </>
              )}
              <button className="wc-mini" onClick={() => setExportText(null)}>
                close
              </button>
            </div>
            {copyState === "manual" && (
              <p className="wc-note" style={{ color: "var(--warn)" }}>
                Clipboard access is blocked here. Click into the box, select all and copy
                by hand.
              </p>
            )}
            <p className="wc-note">
              File download may be blocked by the sandbox. If nothing appears in your
              Downloads folder, use the copy button instead.
            </p>
          </div>
        </div>
      )}

      {preview && (
        <div className="wc-lightbox" onClick={() => setPreview(null)}>
          <img src={preview} alt="Garment, full frame" />
        </div>
      )}
    </div>
  );
}


ReactDOM.createRoot(document.getElementById("root")).render(<TuesdayApp />);
