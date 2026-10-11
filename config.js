// PENGATURAN KEUANGANKU (sudah terisi)
const firebaseConfig = {
  apiKey: "AIzaSyDwGjiOpWfYyoGGs1uTlM5dKIIruJjRV24",
  authDomain: "my-finance-program.firebaseapp.com",
  projectId: "my-finance-program",
  storageBucket: "my-finance-program.firebasestorage.app",
  messagingSenderId: "349433875439",
  appId: "1:349433875439:web:33ed50e7809288a3e0c41a"
};

// Hanya email ini yang boleh masuk
const allowedEmails = ["priyotomo026@gmail.com"];

window.KEUANGANKU_CONFIG = Object.assign({}, firebaseConfig, { allowedEmails });
