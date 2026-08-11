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

Jalankan pengujian dengan:

```powershell
npm test
```
