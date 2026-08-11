# MNN Internal Quotation

Aplikasi web internal untuk menyusun, menghitung, meninjau, dan menerbitkan quotation FirePro, PAC, dan ME beserta lampiran RAB.

## Menjalankan aplikasi

Persyaratan: Node.js 22 atau lebih baru.

```powershell
npm ci
npm start
```

Aplikasi dapat dibuka melalui `http://localhost:3180`. Port dan alamat server dapat diubah melalui variabel `PORT` dan `HOST`.

## Akun pertama

Saat database baru dibuat, aplikasi membuat akun `admin`, `logistik`, `support`, `presales`, dan `manager`. Password sementara yang aman dibuat secara acak dan hanya ditampilkan pada terminal ketika akun tersebut pertama kali dibuat. Setiap pengguna wajib menggantinya setelah login.

Untuk menentukan password awal sendiri sebelum menjalankan database baru, gunakan variabel lingkungan berikut:

- `MNN_BOOTSTRAP_ADMIN_PASSWORD`
- `MNN_BOOTSTRAP_LOGISTICS_PASSWORD`
- `MNN_BOOTSTRAP_SUPPORT_PASSWORD`
- `MNN_BOOTSTRAP_PRESALES_PASSWORD`
- `MNN_BOOTSTRAP_MANAGER_PASSWORD`

Password minimal 10 karakter dan harus memiliki huruf besar, huruf kecil, angka, serta simbol.

## Data lokal

Database, master harga, lampiran ACES, hasil ekspor, log, backup, `.env`, dan artefak pengujian lokal tidak disimpan di Git. Secara default data aplikasi berada di folder `data`. Lokasinya dapat dipindahkan dengan variabel `QUOTATION_DATA_DIR`.

## Backup dan pemulihan

- Server membuat maksimal satu backup otomatis setiap hari dan memeriksanya kembali setiap 6 jam.
- Administrator atau Manager Operational dapat membuat backup manual.
- Administrator dapat mengatur lokasi salinan kedua melalui path absolut/UNC dan retensi 7-3650 hari.
- Minimal tiga backup terbaru selalu dipertahankan meskipun melewati retensi.
- Restore hanya dapat dijalankan Administrator, memerlukan pengetikan ulang ID backup, membuat safety backup terlebih dahulu, memverifikasi checksum/integritas, lalu mencabut seluruh sesi login.

Jika variabel `QUOTATION_BACKUP_MIRROR_DIR` diatur pada server, nilainya menjadi tujuan salinan kedua dan mengesampingkan lokasi yang disimpan melalui halaman Pengaturan.

Jalankan pengujian dengan:

```powershell
npm test
```
