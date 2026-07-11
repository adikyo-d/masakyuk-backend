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

// 🚀 Fungsi khusus untuk menyedot deskripsi langsung dari HTML bawaan YouTube
async function getYoutubeDescription(videoId) {
  try {
    // Membuka halaman YouTube layaknya browser biasa
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
    const html = await response.text();
    
    // Mencari bongkahan data JSON tersembunyi yang menyimpan detail video
    const match = html.match(/ytInitialPlayerResponse\s*=\s*({.+?})\s*;/);
    if (match && match[1]) {
      const data = JSON.parse(match[1]);
      return data.videoDetails?.shortDescription || "";
    }
    return "";
  } catch (err) {
    console.error("Gagal membedah HTML YouTube:", err.message);
    return "";
  }
}

app.post('/api/generate-recipe', async (req, res) => {
  // Kita pastikan hanya menggunakan videoId agar formatnya selalu seragam
  const { videoId } = req.body; 

  if (!videoId) {
    return res.status(400).json({ error: 'Video ID tidak valid.' });
  }

  try {
    console.log(`Memproses video ID: ${videoId}`);

    // 1. Sedot Subtitle (Jika ada)
    let transcriptText = "";
    try {
      const transcript = await YoutubeTranscript.fetchTranscript(videoId);
      transcriptText = transcript.map(t => t.text).join(' ');
      console.log("✅ Subtitle berhasil didapatkan.");
    } catch (err) {
      console.log("⚠️ Subtitle tidak ditemukan, beralih ke deskripsi...");
    }

    // 2. Sedot Deskripsi Video
    const descriptionText = await getYoutubeDescription(videoId);
    if (descriptionText) {
      console.log("✅ Deskripsi video berhasil didapatkan.");
    } else {
      console.log("⚠️ Gagal menemukan deskripsi video.");
    }

    // Jika keduanya kosong, hentikan proses
    if (!transcriptText && !descriptionText) {
      return res.status(400).json({ error: 'Video ini tidak memiliki subtitle maupun deskripsi yang bisa dibaca.' });
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
        responseMimeType: "application/json",
      }
    });

    const jsonString = response.text;
    const recipeData = JSON.parse(jsonString);

    res.json(recipeData);

  } catch (error) {
    console.error('Error generating recipe:', error);
    res.status(500).json({ error: 'Gagal mengekstrak resep dari video.' });
  }
});

export default app;