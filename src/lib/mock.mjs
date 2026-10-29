// Deterministic mock responses (MOCK_LLM=1) so the whole pipeline and UI can be developed and tested
// without spending API credits. Shapes match the real schemas exactly.

const MOCK_POSTS = [
  { url: "https://www.threads.com/@rina.kue/post/mock1", author: "rina.kue", text: "Capek banget tiap akhir bulan rekap orderan kue dari WA satu-satu ke Excel, ada yang lupa dibayar pula 😭 ada aplikasi yang simpel ga sih?" },
  { url: "https://www.threads.com/@dimasfreelance/post/mock2", author: "dimasfreelance", text: "Klien telat bayar invoice 2 bulan. Gue lupa follow up karena catetannya di notes HP. Butuh pengingat tagihan otomatis" },
  { url: "https://www.threads.com/@toko.sinar/post/mock3", author: "toko.sinar", text: "Nyari aplikasi kasir + catat utang pelanggan yang gak ribet buat warung. Yang ada pada mahal langganannya" },
  { url: "https://www.kaskus.co.id/thread/mock4", author: "agan_umkm", text: "Gan, ada rekomendasi cara nagih pelanggan yang ngutang tanpa bikin gak enak? Udah numpuk 3 jutaan" },
  { url: "https://www.threads.com/@hijabstore.id/post/mock5", author: "hijabstore.id", text: "Promo hari ini diskon 50% semua gamis! Order via link bio" },
  { url: "https://www.threads.com/@ayu.catering/post/mock6", author: "ayu.catering", text: "Pakai aplikasi pembukuan X tapi ribet banget input-nya, akhirnya balik ke buku tulis lagi" },
  { url: "https://www.reddit.com/r/indonesia/comments/mock7", author: "u/kopiterus", text: "Freelancer di sini pakai apa buat invoice dan reminder pembayaran? Saya sering malu nagih" },
  { url: "https://www.threads.com/@bengkel.jaya/post/mock8", author: "bengkel.jaya", text: "Pelanggan bengkel banyak yang bayar belakangan, catatannya sering ilang. Ada solusi yg bisa kirim WA otomatis?" },
];

function cardFor(input) {
  return {
    name: "TagihIn",
    one_liner: "Catat piutang pelanggan dan kirim pengingat tagihan WhatsApp otomatis untuk UMKM dan freelancer.",
    problem: "Pemilik usaha kecil lupa atau sungkan menagih, sehingga uang tertahan di pelanggan yang telat bayar.",
    audience: [
      { segment: "UMKM kuliner rumahan", description: "Jual kue/katering lewat WhatsApp, rekap manual di Excel atau buku" },
      { segment: "Freelancer kreatif", description: "Desainer/developer dengan klien yang telat bayar invoice" },
      { segment: "Warung & bengkel", description: "Usaha dengan pelanggan langganan yang sering bayar belakangan" },
    ],
    pricing: "Gratis 20 tagihan/bulan, Pro Rp29.000/bulan",
    price_band: "under_5_usd",
    category: "b2b_saas",
    market_language: "id",
    regions: ["Indonesia"],
    search_phrases: [
      "klien telat bayar",
      "lupa nagih pelanggan",
      "catat utang pelanggan",
      "rekap orderan WA",
      "malu nagih utang",
      "aplikasi invoice freelancer",
      "pengingat tagihan otomatis",
      "pembukuan ribet",
    ],
    jobs_to_be_done: ["Tahu siapa yang belum bayar", "Menagih tanpa canggung", "Rekap orderan cepat"],
    restricted_ad_categories: [],
    risks: ["Belum ada bukti sosial di landing page"],
    _input: undefined,
  };
}

export function mockRespond(name, { input } = {}) {
  let json;
  if (name === "product_card") {
    json = cardFor(input);
    delete json._input;
  } else if (name === "cluster_signals") {
    const posts = JSON.parse(input).posts ?? [];
    const idx = posts.map((p) => p.index);
    json = {
      clusters: [
        { label: "Sungkan dan lupa menagih", summary: "Pemilik usaha tahu ada piutang tapi lupa atau malu menagih.", signal_indexes: idx.filter((i) => i % 2 === 0), exact_phrases: ["Klien telat bayar invoice 2 bulan", "Saya sering malu nagih", "nagih pelanggan yang ngutang tanpa bikin gak enak"], intensity: 82 },
        { label: "Rekap manual yang melelahkan", summary: "Orderan dari WhatsApp direkap satu per satu, data sering hilang.", signal_indexes: idx.filter((i) => i % 2 === 1), exact_phrases: ["rekap orderan kue dari WA satu-satu ke Excel", "catatannya sering ilang", "balik ke buku tulis lagi"], intensity: 67 },
      ],
      intermediaries: [
        { name: "Komunitas UMKM Naik Kelas", type: "community", url: "https://www.facebook.com/groups/mock-umkm", why: "Ribuan pemilik usaha kecil bertanya soal pembukuan setiap minggu", offer: "Kelas gratis 30 menit 'Cara menagih tanpa canggung' + akses Pro 3 bulan untuk anggota" },
        { name: "Akun edukasi freelancer @kerjaremote", type: "account", url: "https://www.threads.com/@kerjaremote", why: "Audiensnya freelancer yang sering membahas klien telat bayar", offer: "Template invoice + reminder gratis untuk dibagikan, dengan atribusi" },
      ],
    };
  } else if (name === "plan_experiments") {
    json = {
      experiments: [
        { title: "Balas 5 keluhan 'telat bayar' di Threads", channel: "threads_reply", angle: "Tidak perlu sungkan lagi: pengingat dikirim otomatis dengan bahasa sopan", angle_type: "avoid_risk", target_cluster: "Sungkan dan lupa menagih", hypothesis: "Jika kita membantu langsung orang yang sedang mengeluh, ≥3 dari 5 akan klik karena masalahnya sedang terasa.", success_metric: "signups", success_threshold: 3, drafts: [{ target_url: "https://www.threads.com/@dimasfreelance/post/mock2", text: "Relate banget. Yang saya lakukan: kirim pengingat H-3, H, H+3 dengan template sopan. Saya bikin alat kecil yang ngirim otomatis lewat WA, gratis buat dicoba: {link} (disclaimer: saya yang bikin)" }], prior_evidence: "Bank: threads_reply menang di 2 dari 3 produk B2B kecil berbahasa Indonesia." },
        { title: "Post Threads: 3 kalimat menagih tanpa canggung", channel: "threads_post", angle: "Template kalimat menagih yang sopan, dari kata-kata pengguna sendiri", angle_type: "convenience", target_cluster: "Sungkan dan lupa menagih", hypothesis: "Konten yang langsung bisa dipakai akan disimpan dan dibagikan, membawa klik organik.", success_metric: "clicks", success_threshold: 40, drafts: [{ target_url: "", text: "\"Klien telat bayar invoice 2 bulan\" — kalimat ini muncul terus di timeline. 3 template nagih yang tetap sopan:\n1) ...\n2) ...\n3) ...\nVersi otomatisnya saya taruh di sini: {link}" }], prior_evidence: "Eksplorasi: belum ada data untuk angle convenience di kategori ini." },
        { title: "Tawarkan kelas gratis ke Komunitas UMKM Naik Kelas", channel: "intermediary_outreach", angle: "Edukasi menagih untuk anggota, tanpa jualan keras", angle_type: "trust_safety", target_cluster: "Rekap manual yang melelahkan", hypothesis: "Satu perantara yang setuju bisa membawa 20+ pendaftar sekaligus.", success_metric: "signups", success_threshold: 10, drafts: [{ target_url: "https://www.facebook.com/groups/mock-umkm", text: "Halo admin, saya pembuat alat pengingat tagihan untuk UMKM. Boleh saya isi kelas gratis 30 menit untuk anggota soal cara menagih tanpa canggung? Anggota dapat akses Pro 3 bulan: {link}" }], prior_evidence: "Bank: intermediary_outreach punya win rate tertinggi untuk produk komunitas." },
      ],
    };
  } else if (name === "verdict") {
    const { results } = JSON.parse(input);
    const v =
      results.clicks < 20 ? "needs_more_data" : results.signups / Math.max(1, results.clicks) > 0.1 ? "ready_for_ads" : results.signups > 0 ? "keep" : "kill";
    json = {
      verdict: v,
      reasoning: `${results.clicks} klik, ${results.signups} daftar, ${results.payments} bayar dalam ${results.days} hari.`,
      next_step: v === "ready_for_ads" ? "Jalankan uji iklan Rp150rb dengan angle ini." : v === "kill" ? "Hentikan dan ganti angle." : "Lanjutkan 3 hari lagi.",
      ad_brief: v === "ready_for_ads" ? "Iklan Reels 15 detik: masalah 'sungkan menagih', tunjukkan pengingat terkirim otomatis, CTA coba gratis." : "",
    };
  } else {
    json = undefined;
  }
  return {
    id: `mock_${name}`,
    text: json ? JSON.stringify(json) : `Mock ${name}: scanned Threads and the web, recorded signals and intermediaries.`,
    json,
    citations: [],
    searchResults: [{ type: "text_result", title: "Forum UMKM", url: "https://forum.mock/umkm-piutang", snippet: "Banyak pemilik warung mengeluh catatan utang pelanggan hilang dan sungkan menagih, ada yang sampai tutup usaha." }],
  };
}

export function mockToolCalls(name) {
  if (name !== "radar") return [];
  return [
    { name: "search_threads", arguments: { query: "klien telat bayar", search_type: "RECENT" } },
    { name: "search_threads", arguments: { query: "lupa nagih", search_type: "RECENT" } },
    { name: "record_signals", arguments: { signals: MOCK_POSTS.map((p) => ({ source: p.url.includes("threads") ? "threads" : "web", ...p })) } },
    { name: "record_intermediaries", arguments: { items: [{ name: "Komunitas UMKM Naik Kelas", type: "community", url: "https://www.facebook.com/groups/mock-umkm", why: "Diskusi pembukuan mingguan" }] } },
  ];
}

export function mockThreadsSearch(q) {
  return { posts: MOCK_POSTS.filter((p) => p.url.includes("threads")).map((p) => ({ source: "threads", externalId: p.url, ...p, postedAt: new Date().toISOString() })) };
}

export function mockOpenWeights(name, user) {
  const { posts } = JSON.parse(user);
  const scores = posts.map((p) => {
    const ad = /promo|diskon|order via/i.test(p.text);
    return {
      index: p.index,
      intent: ad ? 3 : /ada aplikasi|rekomendasi|butuh|solusi|pakai apa|nyari/i.test(p.text) ? 85 : 55,
      stage: ad ? "irrelevant" : /ada aplikasi|rekomendasi|butuh|solusi|pakai apa|nyari/i.test(p.text) ? "seeking_solution" : "complaining_about_problem",
      pain_point: ad ? "-" : p.text.slice(0, 60),
      phrases: [p.text.split(/[.,!?]/)[0].slice(0, 60)],
    };
  });
  return { text: JSON.stringify({ scores }), json: { scores } };
}

// 64x64 teal square PNG
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAQ0lEQVR4nO3PQQ0AIBDAsMO/ZzSQ9tNXk3dmY86vA7gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPtsbgEBdb0VKwAAAABJRU5ErkJggg==";
export function mockImage() {
  return { b64: PNG, url: "" };
}
