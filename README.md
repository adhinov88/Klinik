# Klinik - Pendaftaran Pasien Online

Aplikasi sederhana untuk pendaftaran pasien secara online dengan nomor antrean dan notifikasi email.

## Fitur
- Form pendaftaran pasien
- Nomor antrean otomatis per tanggal kunjungan
- Notifikasi email ke pasien (SMTP)

## Persiapan Database
1. Buat database PostgreSQL, contoh:
   ```sql
   CREATE DATABASE klinik;
   ```
2. Jalankan skema:
   ```bash
   psql -d klinik -f sql/schema.sql
   ```

## Konfigurasi
1. Salin `.env.example` menjadi `.env` dan isi kredensialnya.
2. Pastikan SMTP sudah aktif agar email terkirim.

## Menjalankan Aplikasi
```bash
npm install
npm run dev
```

Buka `http://localhost:3000` untuk mengakses halaman pendaftaran.

## Endpoint
- `POST /api/registrations`
  - Body: `fullName`, `phone`, `email` wajib.
  - Optional: `nik`, `birthDate`, `gender`, `address`, `complaint`, `visitDate`.

- `GET /health`
  - Cek status server.
