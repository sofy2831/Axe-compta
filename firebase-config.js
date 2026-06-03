import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";000
import { getAuth } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyB3-8Un0FgBDrvikywmoTJFd5wIuRIyKhk",
  authDomain: "axe-compta.firebaseapp.com",
  projectId: "axe-compta",
  storageBucket: "axe-compta.firebasestorage.app",
  messagingSenderId: "766523977177",
  appId: "1:766523977177:web:fa60f502db94ce028b3dc8",
  measurementId: "G-YTE62FL6V4"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

export default app;
