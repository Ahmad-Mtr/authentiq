/**
 * The demo cast's plan (bun run fixtures:demo, seed:demo): who is in it,
 * decided in code so that the model only writes the words. See
 * infra/scripts/gen-demo-data.ts.
 */

export const SEED = 20260930

export const FIELDS = {
  backend: "backend software engineering (APIs, databases, distributed services)",
  frontend: "frontend web development (UI engineering, accessibility, design systems)",
  mobile: "mobile app development (iOS / Android)",
  sre: "site reliability and infrastructure engineering (on-call, cloud, observability)",
  dataeng: "data engineering (pipelines, warehouses, orchestration)",
  datascience: "data science and machine learning (modelling, experimentation)",
  design: "product and UX design (research, interaction and visual design)",
  pm: "product management",
  sales: "B2B sales and account management",
  marketing: "marketing (content, SEO, growth, brand)",
  finance: "finance and accounting (controlling, reporting, audit)",
  legal: "in-house legal counsel (commercial contracts, privacy, employment law)",
  nursing: "nursing (hospital and community care)",
  teaching: "school teaching (primary and secondary)",
  recruiting: "recruiting and talent acquisition",
  mecheng: "mechanical engineering (product design, manufacturing)",
  supplychain: "supply chain and logistics operations",
  civileng: "civil and structural engineering (infrastructure, construction)",
} as const
export type FieldKey = keyof typeof FIELDS

export const SENIORITIES = ["junior", "mid", "senior", "lead"] as const
type Gender = "woman" | "man" | "nonbinary"

/** Where a name comes from. Deliberately independent of where the person lives. */
export const REGIONS: Record<string, { names: string; cities: Array<string> }> = {
  "West Africa": { names: "a name common in West Africa (e.g. Nigeria, Ghana, Senegal, Côte d'Ivoire)", cities: ["Lagos, NG", "Accra, GH", "Dakar, SN", "Abidjan, CI"] },
  "East Africa": { names: "a name common in East Africa (e.g. Kenya, Ethiopia, Rwanda, Uganda)", cities: ["Nairobi, KE", "Kigali, RW", "Addis Ababa, ET", "Kampala, UG"] },
  "Southern Africa": { names: "a name common in Southern Africa (e.g. South Africa, Zambia, Botswana, Zimbabwe)", cities: ["Johannesburg, ZA", "Cape Town, ZA", "Lusaka, ZM", "Gaborone, BW"] },
  "North Africa": { names: "a name common in North Africa (e.g. Egypt, Morocco, Tunisia, Algeria)", cities: ["Cairo, EG", "Casablanca, MA", "Tunis, TN"] },
  "Middle East": { names: "a name common in the Middle East (e.g. Jordan, Lebanon, Türkiye, Iran, Gulf states)", cities: ["Amman, JO", "Beirut, LB", "Dubai, AE", "Istanbul, TR"] },
  "South Asia": { names: "a name common in South Asia (e.g. India, Pakistan, Bangladesh, Sri Lanka, Nepal)", cities: ["Bengaluru, IN", "Karachi, PK", "Dhaka, BD", "Colombo, LK", "Pune, IN"] },
  "East Asia": { names: "a name common in East Asia (e.g. China, Japan, Korea, Taiwan), written in Latin script", cities: ["Seoul, KR", "Taipei, TW", "Osaka, JP", "Shenzhen, CN"] },
  "Southeast Asia": { names: "a name common in Southeast Asia (e.g. Philippines, Indonesia, Vietnam, Thailand, Malaysia)", cities: ["Manila, PH", "Jakarta, ID", "Ho Chi Minh City, VN", "Kuala Lumpur, MY", "Singapore"] },
  "Latin America": { names: "a name common in Latin America (e.g. Brazil, Mexico, Colombia, Peru, Argentina)", cities: ["São Paulo, BR", "Mexico City, MX", "Bogotá, CO", "Lima, PE", "Buenos Aires, AR"] },
  Caribbean: { names: "a name common in the Caribbean (e.g. Jamaica, Trinidad and Tobago, Haiti, Barbados)", cities: ["Kingston, JM", "Port of Spain, TT"] },
  "Western Europe": { names: "a name common in Western Europe (e.g. France, Germany, Spain, Portugal, Ireland, the Netherlands)", cities: ["Berlin, DE", "Lisbon, PT", "Amsterdam, NL", "Lyon, FR", "Dublin, IE", "Barcelona, ES"] },
  "Eastern Europe": { names: "a name common in Eastern Europe (e.g. Poland, Romania, Ukraine, Czechia, Estonia)", cities: ["Warsaw, PL", "Bucharest, RO", "Kyiv, UA", "Tallinn, EE", "Prague, CZ"] },
  Nordics: { names: "a name common in the Nordic countries or among the Sámi", cities: ["Stockholm, SE", "Oslo, NO", "Helsinki, FI", "Copenhagen, DK"] },
  "North America": { names: "a name common in the United States or Canada, of any background", cities: ["Toronto, CA", "Chicago, US", "Atlanta, US", "Montréal, CA", "Austin, US", "Vancouver, CA"] },
  Oceania: { names: "a name common in Australia, New Zealand (including Māori) or the Pacific Islands", cities: ["Auckland, NZ", "Melbourne, AU", "Suva, FJ", "Brisbane, AU"] },
}

export type Slot = {
  index: number
  field: FieldKey
  seniority: (typeof SENIORITIES)[number]
  gender: Gender
  region: string
  location: string
  openToWork: boolean
}

/** mulberry32: a small seeded PRNG, so the plan is the same on every run. */
export function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export function shuffle<T>(xs: Array<T>, rand: () => number) {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/**
 * 18 fields × 3 people. Within a field, genders alternate (W M W / M W M) so
 * every field has both, and four fields spread across the list have a
 * non-binary person in the third slot. Seniority rotates with slot and
 * field pair, which gives each gender every seniority equally often. (The
 * first planned run rotated by field + slot, which lined up with the gender
 * pattern: every lead was a man and every junior a woman. The audit caught
 * it; see docs/evals.md.) Open to work is 40% within each gender. Name
 * region and city are shuffled separately, and a person lives in their
 * name's region only about half the time, as many people do not.
 */
export function plan(): Array<Slot> {
  const rand = prng(SEED)
  const fields = Object.keys(FIELDS) as Array<FieldKey>
  const regionNames = Object.keys(REGIONS)
  const count = fields.length * 3
  const regions = shuffle(
    Array.from({ length: count }, (_, i) => regionNames[i % regionNames.length]!),
    rand
  )
  const nonbinary = new Set([1, 6, 11, 16])
  const slots: Array<Slot> = []
  fields.forEach((field, f) => {
    for (let j = 0; j < 3; j++) {
      const index = f * 3 + j
      const womanFirst = f % 2 === 0
      let gender: Gender = (j % 2 === 0) === womanFirst ? "woman" : "man"
      if (j === 2 && nonbinary.has(f)) gender = "nonbinary"
      const region = regions[index]!
      const home = rand() < 0.5
      const cityRegion = home
        ? region
        : regionNames[Math.floor(rand() * regionNames.length)]!
      const cities = REGIONS[cityRegion]!.cities
      slots.push({
        index,
        field,
        seniority: SENIORITIES[(Math.floor(f / 2) + j) % 4]!,
        gender,
        region,
        location: cities[Math.floor(rand() * cities.length)]!,
        openToWork: false,
      })
    }
  })
  for (const g of ["woman", "man", "nonbinary"] as const) {
    const group = shuffle(slots.filter((s) => s.gender === g), rand)
    group.slice(0, Math.round(group.length * 0.4)).forEach((s) => (s.openToWork = true))
  }
  return slots
}


/**
 * Real organisations the model is known to reach for. A match drops the
 * person or posting at generation, and the record at seeding. It is a
 * tripwire, not proof of fiction: the fixtures were also read by hand, and
 * the last four names were added from that reading
 * (docs/phases/09-evals-writeup.md).
 */
export const REAL_ORGS =
  /\b(google|alphabet|microsoft|amazon|aws|meta|facebook|instagram|apple|netflix|ibm|oracle|sap|siemens|accenture|deloitte|pwc|kpmg|ernst ?& ?young|mckinsey|boston consulting|bain|salesforce|adobe|intel|nvidia|samsung|tencent|alibaba|infosys|tata|wipro|spotify|uber|airbnb|stripe|shopify|zalando|revolut|n26|twitter|linkedin|tesla|toyota|volkswagen|bosch|unilever|nestl[eé]|procter|pfizer|novartis|roche|mayo clinic|nhs|red cross|unicef|world bank|harvard|stanford|mit\b|massachusetts institute|oxford|cambridge|eth z[uü]rich|sorbonne|tsinghua|peking university|iit\b|indian institute of technology|university of tokyo|nus\b|national university of singapore|imperial college|ucl\b|berkeley|yale|princeton|columbia university|university of toronto|mcgill|university of (lagos|nairobi|cairo|cape town|melbourne|sydney|auckland|lisbon|warsaw|amsterdam|dublin|oslo|helsinki|copenhagen|stockholm|manila|jakarta|s[aã]o paulo|mexico|buenos aires|bogot[aá]|lima|chicago|texas|washington)|tu delft|tu munich|kth\b|mpesa|m-pesa|safaricom|flutterwave|paystack|jumia|careem|grab\b|gojek|tokopedia|mercado ?libre|nubank|rappi|kaspi|yandex|baidu|huawei|xiaomi|sony|nintendo|hitachi|infineon|ericsson|nokia|volvo|ikea|maersk|lego|novo nordisk|spotify|bright horizons|harborview|clearwater analytics|brightline)\b/i

