import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { YoutubeTranscript } from 'youtube-transcript'; 

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Header browser asli — banyak request server-to-server ke YouTube
// diblokir/di-redirect ke halaman consent kalau ga ada ini.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  // Bypass halaman consent Uni Eropa yang bikin ytInitialPlayerResponse ga muncul di HTML
  Cookie: 'CONSENT=YES+1',
};

// 🚀 Ambil deskripsi video: coba YouTube Data API dulu (kalau ada API key,
// paling reliable & gak kena blokir bot), fallback ke scrape HTML manual.
async function getYoutubeDescription(videoId) {
  if (process.env.YOUTUBE_API_KEY) {
    try {
      const apiRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${process.env.YOUTUBE_API_KEY}`,
      );
      const apiData = await apiRes.json();

      if (apiData.error) {
        console.log('⚠️ YouTube Data API error:', apiData.error.message);
      } else {
        const description = apiData.items?.[0]?.snippet?.description;
        if (description) {
          console.log('✅ Deskripsi didapat via YouTube Data API.');
          return description;
        }
        console.log('⚠️ YouTube Data API sukses tapi video/deskripsi tidak ditemukan.');
      }
    } catch (err) {
      console.log('⚠️ YouTube Data API gagal dipanggil:', err.message);
    }
  } else {
    console.log('ℹ️ YOUTUBE_API_KEY belum diset, langsung pakai scrape HTML.');
  }

  // Fallback: scrape HTML halaman video langsung
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: BROWSER_HEADERS,
    });
    const html = await response.text();

    const match = html.match(/ytInitialPlayerResponse\s*=\s*({.+?})\s*;/);
    if (match && match[1]) {
      const data = JSON.parse(match[1]);
      return data.videoDetails?.shortDescription || '';
    }

    console.log(
      '⚠️ Scrape gagal: pola ytInitialPlayerResponse tidak ditemukan di HTML — kemungkinan server diblokir/di-redirect ke halaman consent oleh YouTube. Status response:',
      response.status,
    );
    return '';
  } catch (err) {
    console.log('❌ Gagal membedah HTML YouTube:', err.message);
    return '';
  }
}

app.post('/api/generate-recipe', async (req, res) => {
  const { videoId } = req.body;

  if (!videoId) {
    return res.status(400).json({ error: 'Video ID tidak valid.' });
  }

  try {
    console.log(`Memproses video ID: ${videoId}`);

    // 1. Sedot Subtitle (Jika ada)
    let transcriptText = '';
    try {
      const transcript = await YoutubeTranscript.fetchTranscript(videoId);
      transcriptText = transcript.map((t) => t.text).join(' ');
      console.log('✅ Subtitle berhasil didapatkan.');
    } catch (err) {
      // 👈 sekarang pesan error aslinya ditampilkan — ini kunci buat debug:
      // beda pesan antara "transcript disabled", "no transcript found",
      // dan gagal fetch (indikasi IP diblokir).
      console.log('⚠️ Subtitle tidak ditemukan. Alasan:', err.message);
    }

    // 2. Sedot Deskripsi Video
    const descriptionText = await getYoutubeDescription(videoId);
    if (descriptionText) {
      console.log('✅ Deskripsi video berhasil didapatkan.');
    } else {
      console.log('⚠️ Gagal menemukan deskripsi video.');
    }

    // Jika keduanya kosong, hentikan proses
    if (!transcriptText && !descriptionText) {
      return res.status(400).json({
        error:
          'Video ini tidak memiliki subtitle maupun deskripsi yang bisa dibaca.',
      });
    }

    // 3. Berikan teks aslinya ke Gemini (Prompt Diperketat)
    const prompt = `
      Kamu adalah asisten koki cerdas. Berikut adalah data dari sebuah video memasak:
      
      TRANSKRIP VIDEO:
      "${transcriptText}"

      DESKRIPSI VIDEO:
      "${descriptionText}"
      
      Tugasmu:
      1. Baca transkrip dan deskripsi di atas. Gabungkan informasinya untuk mengekstrak resep yang paling akurat. Takaran bahan biasanya tersembunyi di bagian DESKRIPSI VIDEO.
      2. PENTING: WAJIB terjemahkan dan tulis seluruh output (judul, bahan, dan langkah) dalam BAHASA INDONESIA yang baku, natural, dan mudah dipahami.
      3. Kembalikan HANYA dalam format JSON dengan struktur ini:
      {
        "title": "Nama Makanan (string)",
        "category": "Main Course / Side Dish / Dessert / Drink / Snack / Soup / Other",
        "ingredients": [
          { "name": "Nama bahan (string)", "amount": "Takaran (string, kosongkan jika tidak disebutkan)" }
        ],
        "steps": [
          { 
            "instruction": "Langkah memasak (string)", 
            "hasTimer": true/false (boolean), 
            "durationSeconds": angka (number, durasi dalam detik, isi 0 jika tidak ada) 
          }
        ]
      }
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const jsonString = response.text;
    const recipeData = JSON.parse(jsonString);

    res.json(recipeData);
  } catch (error) {
    console.error('Error generating recipe:', error);
    res.status(500).json({ error: 'Gagal mengekstrak resep dari video.' });
  }
});

app.post('/api/chef-ai', async (req, res) => {
  // Frontend akan mengirimkan resep, pesan user, dan riwayat chat (opsional)
  const { recipe, message, history = [] } = req.body;

  if (!recipe || !recipe.title) {
    return res.status(400).json({ error: 'Konteks resep tidak valid.' });
  }

  try {
    console.log(`Memproses pertanyaan Chef AI untuk resep: ${recipe.title}`);

    // 1. Ubah array bahan dan langkah menjadi teks yang bisa dibaca AI
    const ingredientsText = recipe.ingredients
      .map((i) => `- ${i.amount || ''} ${i.name}`)
      .join('\n');
    const stepsText = recipe.steps
      .map((s, idx) => `${idx + 1}. ${s.instruction}`)
      .join('\n');

    // 2. Buat instruksi sistem (System Prompt) agar AI berperan sebagai koki
    const systemInstruction = `
      Kamu adalah Chef AI dan Ahli Gizi profesional di aplikasi MasakYuk.
      Jawablah selalu dalam bahasa Indonesia yang ramah, informatif, dan ringkas (maksimal 150 kata).

      KONTEKS RESEP SAAT INI:
      Nama: ${recipe.title}
      Bahan:
      ${ingredientsText}
      Langkah:
      ${stepsText}

      ATURAN MENJAWAB:
      1. Jika pengguna meminta analisis nutrisi, berikan estimasi Kalori, Protein, Karbohidrat, Lemak, Serat, Gula, dan Sodium dalam bentuk poin singkat, lalu beri insight.
      2. Jika pengguna bertanya soal kesehatan/diet, beri edukasi dan ingatkan bahwa ini hanya estimasi.
      3. Jika pengguna meminta modifikasi (porsi diubah atau bahan diganti), hitung ulang bahan-bahannya.
      4. Selalu jawab berdasarkan konteks resep di atas. Jangan menyarankan hal yang bertolak belakang dengan resep aslinya.
    `;

    // 3. Susun riwayat percakapan agar AI ingat konteks sebelumnya
    const contents = history.map((msg) => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }],
    }));

    // 4. Tambahkan pertanyaan terbaru pengguna
    // Jika message kosong, anggap pengguna baru membuka bottom sheet dan minta analisis nutrisi awal
    contents.push({
      role: 'user',
      parts: [{ text: message || 'Tolong buatkan analisis nutrisi ringkas untuk resep ini.' }],
    });

    // 5. Kirim ke Gemini (Gunakan model standar untuk chat)
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash', // flash lebih pintar dari flash-lite untuk interaksi chat
      contents: contents,
      config: {
        systemInstruction: systemInstruction,
      },
    });

    res.json({ reply: response.text });
  } catch (error) {
    console.error('Error in Chef AI endpoint:', error);
    res.status(500).json({ error: 'Gagal mendapatkan respon dari Chef AI.' });
  }
});
export default app;